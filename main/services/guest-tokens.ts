/**
 * A table's guest token is printed into the QR sticker that lives on that table,
 * so it is issued once, with the table, and then stays put. Rotating it is a
 * deliberate act (a leaked photo, a reprint), never part of normal use.
 */
import { randomBytes } from 'node:crypto';

export function newGuestToken(): string {
  return randomBytes(24).toString('base64url');
}
