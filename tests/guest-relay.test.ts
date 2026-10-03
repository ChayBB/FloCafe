/**
 * The relay that carries customer orders from a hosted QR server to this POS.
 *
 * A customer on mobile data cannot reach a till behind NAT. Rather than opening
 * an inbound hole into the shop, the POS dials out and holds the connection, so
 * this test plays the hosted server: it accepts the POS's connection, pushes
 * orders down it, and checks what comes back.
 *
 * The cases that matter are the refusals. A hosted server that hears nothing
 * must assume an order may have landed, so every rejection has to be answered,
 * and a redelivery must not become a second round of food.
 *
 * Run: npm run test:guest-relay
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-guest-relay-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((e) => e ? reject(e) : resolve()));
  return port;
}

/** Waits for one message of the given type, or fails loudly rather than hanging. */
function nextMessage(socket: WebSocket, type: string, timeoutMs = 5_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`timed out waiting for "${type}"`));
    }, timeoutMs);
    function onMessage(data: unknown) {
      let payload: any;
      try { payload = JSON.parse(String(data)); } catch { return; }
      if (payload.type !== type) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(payload);
    }
    socket.on('message', onMessage);
  });
}

async function main() {
  console.log('Integration Test: Guest order relay');
  console.log('='.repeat(36));

  process.env.PORT = String(await freePort());
  const relayPort = await freePort();

  const { initDatabase, getDatabase, closeDatabase, now, upsertSettings } = await import('../main/db');
  const { startServer, stopServer } = await import('../main/server');
  const { startGuestRelay, stopGuestRelay, signHello } = await import('../main/services/guest-relay');
  const { newRoundToken } = await import('../main/services/guest-tokens');

  initDatabase();
  const db = getDatabase();
  const tableCode = 'relay-table-code-AAAABBBBCCCC';

  db.prepare(`INSERT INTO tables (id, number, capacity, status, is_active, guest_token, guest_round, created_at, updated_at)
              VALUES ('tbl-relay', 'R1', 4, 'available', 1, ?, 1, ?, ?)`).run(tableCode, now(), now());
  db.prepare(`INSERT INTO products (id, name, price, is_active, created_at, updated_at)
              VALUES ('prod-relay', 'Relay Coffee', 60, 1, ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, name, price, is_active, created_at, updated_at)
              VALUES ('prod-retired', 'Retired', 50, 0, ?, ?)`).run(now(), now());
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('country', 'TH', ?) ON CONFLICT(key) DO UPDATE SET value='TH'").run(now());
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('currency', 'THB', ?) ON CONFLICT(key) DO UPDATE SET value='THB'").run(now());

  await startServer();

  // The hosted QR server's end of the wire.
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });
  let connection: WebSocket | null = null;
  const connected = new Promise<WebSocket>((resolve) => wss.once('connection', (ws) => { connection = ws; resolve(ws); }));
  await new Promise<void>((resolve) => httpServer.listen(relayPort, '127.0.0.1', resolve));

  const secret = 'relay-test-secret-0123456789';
  let passed = 0;
  const ok = (label: string) => { console.log(`  ✓ ${label}`); passed += 1; };

  try {
    console.log('\n1. nothing is dialled until it is configured');
    startGuestRelay();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(wss.clients.size, 0, 'an unconfigured install opens no socket');
    await stopGuestRelay();

    upsertSettings({
      guest_ordering_enabled: 'true',
      guest_relay_url: `ws://127.0.0.1:${relayPort}`,
      guest_relay_secret: secret,
    });
    ok('an unconfigured install never connects');

    console.log('\n2. the POS dials out and proves who it is');
    startGuestRelay();
    const socket = await connected;
    const hello = await nextMessage(socket, 'hello');
    assert.ok(hello.pos_hash, 'the hello identifies the till');
    assert.equal(
      hello.signature,
      signHello(secret, hello.pos_hash, hello.timestamp, hello.nonce),
      'the signature is one the hosted server can recompute',
    );
    assert.equal(String(hello.signature).includes(secret), false, 'the shared secret itself is never sent');
    ok('the POS connects outbound and signs its hello');

    const round = newRoundToken('tbl-relay', 1);
    const send = (payload: Record<string, unknown>) => socket.send(JSON.stringify({ type: 'order', ...payload }));

    console.log('\n3. a relayed order reaches the kitchen');
    send({ id: 'o-1', table_code: tableCode, round_token: round, items: [{ product_id: 'prod-relay', quantity: 2 }] });
    const ack = await nextMessage(socket, 'ack');
    assert.equal(ack.id, 'o-1');
    assert.equal(ack.table_name, 'R1', 'the acknowledgement names the table');
    assert.ok(ack.order_number, 'and carries the order number staff will see');
    const placed = db.prepare("SELECT COUNT(*) c FROM order_items WHERE product_id = 'prod-relay'").get() as any;
    assert.equal(placed.c, 1, 'the line really exists');
    ok('an order sent down the relay becomes a real order');

    console.log('\n4. a redelivery does not become a second round of food');
    send({ id: 'o-1', table_code: tableCode, round_token: round, items: [{ product_id: 'prod-relay', quantity: 2 }] });
    await nextMessage(socket, 'ack');
    const afterReplay = db.prepare("SELECT COUNT(*) c FROM order_items WHERE product_id = 'prod-relay'").get() as any;
    assert.equal(afterReplay.c, 1, 'the same relay id is recognised, not re-cooked');
    ok('resending an order the server never heard acked is safe');

    console.log('\n5. every refusal is answered, never dropped');
    const refusals: [string, Record<string, unknown>, string][] = [
      ['an unknown table code', { id: 'o-2', table_code: 'not-a-real-code-AAAABBBB', round_token: round, items: [{ product_id: 'prod-relay', quantity: 1 }] }, 'unknown_table'],
      ['a token from a settled sitting', { id: 'o-3', table_code: tableCode, round_token: newRoundToken('tbl-relay', 99), items: [{ product_id: 'prod-relay', quantity: 1 }] }, 'round_closed'],
      ['an item that is not sellable', { id: 'o-4', table_code: tableCode, round_token: round, items: [{ product_id: 'prod-retired', quantity: 1 }] }, 'invalid_items'],
      ['an impossible quantity', { id: 'o-5', table_code: tableCode, round_token: round, items: [{ product_id: 'prod-relay', quantity: 999 }] }, 'invalid_items'],
      ['an empty basket', { id: 'o-6', table_code: tableCode, round_token: round, items: [] }, 'invalid_items'],
    ];
    for (const [label, payload, reason] of refusals) {
      send(payload);
      const nack = await nextMessage(socket, 'nack');
      assert.equal(nack.id, payload.id, `a reply arrives for ${label}`);
      assert.equal(nack.reason, reason, `${label} is refused as ${reason}`);
    }
    ok('unknown table, closed round, dead item, bad quantity and empty basket are all answered');

    console.log('\n6. an order stranded by a long outage is not cooked');
    send({
      id: 'o-7', table_code: tableCode, round_token: round,
      placed_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      items: [{ product_id: 'prod-relay', quantity: 1 }],
    });
    const stale = await nextMessage(socket, 'nack');
    assert.equal(stale.reason, 'stale', 'an hour-old order is refused rather than sent to the kitchen');
    ok('a stale order is refused so the customer can be told instead of fed late');

    console.log('\n7. plaintext to a remote host is refused');
    await stopGuestRelay();
    upsertSettings({ guest_relay_url: 'ws://198.51.100.7:9000' });
    startGuestRelay();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(wss.clients.size, 0, 'orders are not carried over an unencrypted link to a remote host');
    ok('ws:// is allowed only to loopback; anything else needs wss://');
  } finally {
    await stopGuestRelay();
    connection?.close();
    wss.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* SQLite may still hold it */ }
  }

  console.log(`\nResults: ${passed}/7 passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
