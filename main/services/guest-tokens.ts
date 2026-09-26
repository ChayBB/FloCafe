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
import { createHash, randomBytes } from 'node:crypto';
import { getSettingValue } from '../db';

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
