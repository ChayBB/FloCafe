/**
 * The shop owner's side of the hosted server.
 *
 * They sign in here with the same email and password they use on the POS, and
 * that act is what publishes the shop: the till pushes its menu up and hands
 * over the printable table codes.
 *
 * **This server never stores the password and never holds a hash.** What is
 * typed is forwarded to the POS over the relay socket, checked there against the
 * shop's own user table, and dropped. A compromise of this box therefore cannot
 * be turned into offline cracking of the shop's logins.
 *
 * What a compromise of this box *can* do is capture a password as it is typed.
 * That is inherent to signing in on a server rather than on the till, and it is
 * the reason the alternative — a short-lived code shown on the POS screen — is
 * worth considering if this box is not somewhere you fully control. See
 * ../../../docs/public-ordering-multitenant.md.
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
 * Signs an owner or manager in by asking the till.
 *
 * Returns the same failure for a wrong password and an unknown address, because
 * the POS does — telling the two apart would turn this page into a way of
 * discovering which addresses are real.
 */
export async function signIn(email: string, password: string): Promise<AdminSession | { error: string }> {
  const result = await request('admin_login', { email, password }, 'admin_login_result');
  if (!result || result.ok !== true) {
    return { error: result?.reason === 'not_permitted' ? 'not_permitted' : 'invalid_credentials' };
  }

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
    return { error: result?.reason === 'not_signed_in' ? 'session_expired' : 'unavailable' };
  }
  const base = publicUrl.replace(/\/+$/, '');
  return (result.tables ?? []).map((table: { id: string; number: string; code: string }) => ({
    id: table.id,
    number: table.number,
    url: `${base}/guest-order/?t=${encodeURIComponent(table.code)}`,
  }));
}
