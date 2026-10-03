/**
 * The shop owner's side of the hosted server.
 *
 * They pair this server with their till by typing a code the POS shows on its
 * own screen, and that act is what publishes the shop: the till pushes its menu
 * up and hands over the printable table codes.
 *
 * **No POS password is ever involved.** The code is single-use, dies in five
 * minutes, and is destroyed by the till after five wrong guesses. The worst a
 * compromise of this box can steal is a code that is already spent — it cannot
 * capture anything that unlocks the till, which is exactly what the earlier
 * email-and-password version could not promise.
 */
import { randomUUID } from 'node:crypto';
import { request } from './pos-link';

/** Sessions live in memory: a restart signing everyone out is the safe default. */
const SESSION_TTL_MS = 30 * 60_000;
const sessions = new Map<string, { name: string; role: string; expiresAt: number }>();

export type AdminSession = { token: string; name: string; role: string; expiresInMs: number };

function sweep(): void {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

export function sessionFor(token: string | undefined): { name: string; role: string } | null {
  if (!token) return null;
  sweep();
  const session = sessions.get(token);
  return session ? { name: session.name, role: session.role } : null;
}

/**
 * Pairs with the till using the code the merchant read off its screen.
 *
 * The code is checked by the POS, not here: this server has nothing to check it
 * against, which is the point. The refusal reason comes back verbatim so the
 * page can tell a merchant whose code expired from one who mistyped it.
 */
export async function pair(code: string): Promise<AdminSession | { error: string }> {
  const result = await request('admin_pair', { code }, 'admin_pair_result');
  if (!result) return { error: 'pos_unreachable' };
  if (result.ok !== true) return { error: String(result.reason ?? 'invalid_code') };

  const token = randomUUID();
  const expiresInMs = Math.min(Number(result.expires_in_ms) || SESSION_TTL_MS, SESSION_TTL_MS);
  sessions.set(token, {
    name: String(result.name ?? ''),
    role: String(result.role ?? ''),
    expiresAt: Date.now() + expiresInMs,
  });
  return { token, name: String(result.name ?? ''), role: String(result.role ?? ''), expiresInMs };
}

export function signOut(token: string | undefined): void {
  if (token) sessions.delete(token);
}

export type PrintableTable = { id: string; number: string; url: string };

/**
 * The printable QR targets.
 *
 * Fetched from the till on each request and **never written to the database**.
 * Snapshots deliberately carry only hashes so that losing this server's data
 * hands nobody a working QR; persisting these would undo exactly that.
 */
export async function tableCodes(publicUrl: string): Promise<PrintableTable[] | { error: string }> {
  const result = await request('admin_table_codes', {}, 'admin_table_codes_result');
  if (!result || result.ok !== true) {
    return { error: result?.reason === 'not_paired' ? 'session_expired' : 'unavailable' };
  }
  const base = publicUrl.replace(/\/+$/, '');
  return (result.tables ?? []).map((table: { id: string; number: string; code: string }) => ({
    id: table.id,
    number: table.number,
    url: `${base}/guest-order/?t=${encodeURIComponent(table.code)}`,
  }));
}
