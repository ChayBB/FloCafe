import type { Server } from 'http';
import type { Socket } from 'net';

/** First byte of a TLS record; a ClientHello always starts a handshake record. */
const TLS_HANDSHAKE_BYTE = 0x16;

/** What Node would have sent itself. Attaching a `clientError` listener suppresses it. */
const BAD_REQUEST = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n';

/**
 * Closes TLS connections to a plain-HTTP listener without answering them.
 *
 * Browsers upgrade a typed address like `192.168.1.130:3002` to https before
 * trying http. Node answers that handshake with a plain-text `400 Bad Request`,
 * which the browser cannot read as a TLS record, so it reports
 * ERR_EMPTY_RESPONSE and gives up — the page never loads and staff have to type
 * the scheme by hand. Destroying the socket instead reads as a failed https
 * attempt, which is the signal that makes the browser retry over http.
 *
 * Only a TLS handshake is dropped. A genuinely malformed HTTP request still
 * gets its 400: silently closing those sockets would turn every one of them
 * into the same blank ERR_EMPTY_RESPONSE this exists to prevent, and the reply
 * has to be written by hand because attaching this listener suppresses the
 * default Node would otherwise send.
 *
 * `clientError` is the only place this can be done, because the HTTP parser
 * owns the socket and a userland `data` listener never sees the first bytes.
 */
export function dropTlsConnections(server: Server): void {
  server.on(
    'clientError',
    (error: NodeJS.ErrnoException & { rawPacket?: Buffer }, socket: Socket) => {
      if (socket.destroyed) return;
      if (error?.rawPacket?.[0] === TLS_HANDSHAKE_BYTE) {
        socket.destroy();
        return;
      }
      if (socket.writable) socket.end(BAD_REQUEST);
      else socket.destroy();
    },
  );
}
