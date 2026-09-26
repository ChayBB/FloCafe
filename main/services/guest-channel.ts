/**
 * Loopback channel the guest ordering server uses to place a customer's order.
 *
 * A guest never logs in, so the order has to reach the POS API without a user
 * token. Rather than exempting a path outright, the POS API accepts exactly two
 * order-writing routes when the call:
 *   1. arrives on the loopback interface (never from the network), and
 *   2. carries this process's secret, which is generated at startup, kept in
 *      memory only, and therefore useless to anything outside this app.
 *
 * Nothing else is reachable this way — no reads, no payments, no staff routes.
 */
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';

export const GUEST_CHANNEL_HEADER = 'x-flo-guest-channel';

const secret = randomBytes(32).toString('hex');

export function getGuestChannelSecret(): string {
  return secret;
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** True only for a loopback request carrying this process's guest-channel secret. */
export function isGuestChannelRequest(req: Request): boolean {
  const provided = req.headers[GUEST_CHANNEL_HEADER];
  if (typeof provided !== 'string' || provided.length !== secret.length) return false;
  if (!isLoopback(req.socket.remoteAddress)) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
  } catch {
    return false;
  }
}

/** The order-writing routes a guest order is allowed to reach. */
export function isGuestWritablePath(method: string, path: string): boolean {
  if (method !== 'POST') return false;
  return path === '/api/orders' || /^\/api\/orders\/\d+\/items$/.test(path);
}
