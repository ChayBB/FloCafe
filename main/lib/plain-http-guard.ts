import type { Server } from 'http';
import type { Socket } from 'net';

/**
 * Closes malformed connections to a plain-HTTP listener without answering them.
 *
 * Browsers upgrade a typed address like `192.168.1.130:3002` to https before
 * trying http. Node answers that TLS handshake with a plain-text
 * `400 Bad Request`, which the browser cannot read as TLS, so it reports
 * ERR_EMPTY_RESPONSE and gives up — the page never loads and staff have to type
 * the scheme by hand. Destroying the socket instead reads as a failed https
 * attempt, which is the signal that makes the browser retry over http.
 *
 * `clientError` is the only place this can be done: the HTTP parser owns the
 * socket, so a userland `data` listener never sees the handshake bytes.
 */
export function dropTlsConnections(server: Server): void {
  server.on('clientError', (_error: Error, socket: Socket) => {
    if (!socket.destroyed) socket.destroy();
  });
}
