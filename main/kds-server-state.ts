/**
 * The KDS server's port, held apart from the server itself.
 *
 * Mirrors `server-app-state.ts` and `guest-server-state.ts`. It exists so that
 * modules which only need to *report* the port — `/api/health`, mDNS — can read
 * it without importing `kds-server.ts` and pulling its whole dependency graph
 * (and a cycle) along with it.
 */
const DEFAULT_KDS_PORT = parseInt(process.env.KDS_PORT || '3002', 10);
let activeKdsPort = DEFAULT_KDS_PORT;

export function getDefaultKdsPort(): number {
  return DEFAULT_KDS_PORT;
}

export function getKdsPort(): number {
  return activeKdsPort;
}

export function setKdsPort(port: number): void {
  activeKdsPort = port;
}
