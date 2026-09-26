/**
 * A table's guest token is printed into the QR sticker that lives on that table,
 * so it is issued once, with the table, and then stays put. Rotating it is a
 * deliberate act (a leaked photo, a reprint), never part of normal use.
 *
 * Stored form is the bare secret. Printed form may carry this shop's public store
 * reference in front of it (`<store_ref>.<secret>`) so that a hosted server can
 * tell two shops' codes apart before it looks anything up — see
 * docs/public-ordering-multitenant.md. The prefix appears only once the cloud has
 * issued a reference; codes printed before that keep working untouched.
 */
import type { Database } from 'better-sqlite3';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getSettingValue, upsertSettings } from '../db';

const STORE_REF_SEPARATOR = '.';
const STORE_REF_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export type ParsedGuestToken = {
  /** Empty for a code printed before this shop had a store reference. */
  storeRef: string;
  secret: string;
};

export function newGuestToken(): string {
  return randomBytes(24).toString('base64url');
}

/** This shop's public store reference, issued by the cloud at registration. Empty until then. */
export function getStoreRef(): string {
  const raw = (getSettingValue('cloud_store_ref') || '').trim();
  return STORE_REF_PATTERN.test(raw) ? raw : '';
}

/** The token as it goes into a QR code: tenant-qualified when we have a reference to qualify it with. */
export function qualifyGuestToken(secret: string): string {
  const storeRef = getStoreRef();
  return storeRef ? `${storeRef}${STORE_REF_SEPARATOR}${secret}` : secret;
}

/** Splits a scanned token. Returns null for anything that is not shaped like one of ours. */
export function parseGuestToken(raw: unknown): ParsedGuestToken | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;

  const separator = value.indexOf(STORE_REF_SEPARATOR);
  if (separator === -1) {
    return SECRET_PATTERN.test(value) ? { storeRef: '', secret: value } : null;
  }

  const storeRef = value.slice(0, separator);
  const secret = value.slice(separator + 1);
  if (!STORE_REF_PATTERN.test(storeRef) || !SECRET_PATTERN.test(secret)) return null;
  return { storeRef, secret };
}

/**
 * Whether a scanned code belongs to this shop. An unprefixed code predates the
 * store reference and is ours by default; a prefixed one has to match exactly,
 * which is what stops one shop's QR opening another's menu on a shared server.
 */
export function isTokenForThisStore(storeRef: string): boolean {
  if (!storeRef) return true;
  const ours = getStoreRef();
  return ours !== '' && storeRef === ours;
}

/**
 * What a hosted server stores instead of the token itself. A customer's phone
 * sends the token, the server hashes it and looks up the hash, so a breach of
 * that server's database yields no working QR codes.
 */
export function hashGuestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ── Round tokens ─────────────────────────────────────────────────────────────
//
// The printed code identifies a table forever; a round token identifies one
// sitting at it. Scanning exchanges the code for a round token, and settling the
// bill bumps the table's round, which retires every token handed to that sitting
// without touching the sticker — the next party scans the same QR and gets a
// token of their own.
//
// The binding is cryptographic rather than stored, so a sitting needs no row of
// its own:
//
//     roundToken = <nonce>.<HMAC(secret, nonce | tableId | round)>
//
// Verification needs the table and its current round, both of which the guest
// server already has after resolving the scanned code.

const ROUND_SECRET_KEY = 'guest_round_secret';

function roundSecret(): string {
  const existing = (getSettingValue(ROUND_SECRET_KEY) || '').trim();
  if (existing) return existing;
  const secret = randomBytes(32).toString('base64url');
  upsertSettings({ [ROUND_SECRET_KEY]: secret });
  return secret;
}

function signRound(nonce: string, tableId: string, round: number): string {
  return createHmac('sha256', roundSecret())
    .update(`${nonce}.${tableId}.${round}`)
    .digest('hex');
}

export function newRoundToken(tableId: string, round: number): string {
  const nonce = randomBytes(12).toString('base64url');
  return `${nonce}.${signRound(nonce, tableId, round)}`;
}

/** Whether a round token was issued for this table's current sitting. */
export function isRoundTokenCurrent(token: unknown, tableId: string, round: number): boolean {
  if (typeof token !== 'string') return false;
  const separator = token.indexOf('.');
  if (separator === -1) return false;

  const presented = Buffer.from(token.slice(separator + 1));
  const expected = Buffer.from(signRound(token.slice(0, separator), tableId, round));
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/**
 * Ends the current sitting at a table so its round tokens stop working.
 * Idempotent in effect: bumping twice simply retires an already-dead round.
 */
export function endGuestRound(db: Database, tableId: string): void {
  db.prepare('UPDATE tables SET guest_round = guest_round + 1 WHERE id = ?').run(tableId);
}
