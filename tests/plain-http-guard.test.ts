/**
 * The plain-HTTP listeners must tell a TLS handshake apart from a bad request.
 *
 * Browsers upgrade a typed LAN address to https before trying http. Node
 * answers that handshake with a plain-text 400, which no browser can read as a
 * TLS record, so it reports ERR_EMPTY_RESPONSE and never falls back. Dropping
 * the socket instead reads as a failed https attempt and the browser retries
 * over http.
 *
 * The trap is that attaching a `clientError` listener suppresses the 400 Node
 * would otherwise send, so a guard that closes every client error turns each
 * malformed request into the same blank ERR_EMPTY_RESPONSE it was meant to
 * prevent. Both halves are pinned here.
 */
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import { dropTlsConnections } from '../main/lib/plain-http-guard';

const TLS_CLIENT_HELLO = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0x01, 0x00, 0x00, 0x01, 0x00]);

/** Writes `payload` to the server and resolves with everything sent back. */
function probe(port: number, payload: string | Buffer): Promise<string> {
  return new Promise((resolve) => {
    let received = '';
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload));
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
    });
    socket.on('close', () => resolve(received));
    socket.on('error', () => resolve(received));
    setTimeout(() => {
      socket.destroy();
      resolve(received);
    }, 3000);
  });
}

async function main() {
  console.log('Plain-HTTP guard');
  console.log('='.repeat(32));

  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  dropTlsConnections(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const port = address.port;

  try {
    const tls = await probe(port, TLS_CLIENT_HELLO);
    assert.equal(
      tls,
      '',
      'a TLS handshake is dropped without a reply, so the browser retries over http',
    );
    console.log('  ✓ TLS handshake gets no reply');

    const malformed = await probe(port, 'GET / HTTP/1.1\r\nHost: x\r\nBad Header\r\n\r\n');
    assert.match(
      malformed,
      /^HTTP\/1\.1 400 /,
      'a malformed request still gets its 400; silence here would be the bug this guard exists to prevent',
    );
    console.log('  ✓ malformed request still gets 400');

    const ok = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/' }, (res) => {
          let body = '';
          res.on('data', (d) => {
            body += d;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on('error', reject);
    });
    assert.equal(ok.status, 200, 'a valid request is untouched');
    assert.equal(ok.body, 'ok', 'and its body is delivered');
    console.log('  ✓ valid request unaffected');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log('\nAll plain-HTTP guard assertions passed.');
}

main().catch((error) => {
  console.error('\nTest failed:', error);
  process.exit(1);
});
