/**
 * Carries customer orders from a hosted QR server down to this POS.
 *
 * A customer ordering over mobile data cannot reach the shop: the till sits
 * behind NAT on a restaurant's broadband line. The published answer to that is
 * usually a tunnel, which means an inbound hole into the shop network. This is
 * the other way round — **the POS dials out and holds the connection open**, so
 * nothing listens for the internet and the shop's firewall stays shut.
 *
 *     customer phone ──4G──> hosted QR server <──WS (dialled by the POS)── POS
 *
 * The hosted server is not in this repository. What is here is the POS end and
 * the contract it speaks; see docs/guest-relay-protocol.md.
 *
 * Off unless the merchant configures it. An unconfigured install never opens a
 * socket, which is the right default for the overwhelming majority of shops
 * that only ever serve guests on their own WiFi.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { WebSocket } from 'ws';
import log from 'electron-log';
import { ensureCloudIdentity, getSettingValue, isGuestOrderingEnabled } from '../db';
import { getDatabase } from '../db';
import { isRoundTokenCurrent, isTokenForThisStore, newRoundToken, parseGuestToken, qualifyGuestToken } from './guest-tokens';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { placeGuestOrder, tableTicket, validateGuestItems } from './guest-orders';
import { publicOrderingSnapshot, snapshotDigest } from './public-menu';
import { getTenantCurrency } from './refund';

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const PING_INTERVAL_MS = 25_000;
/** A relayed order older than this is stale: the kitchen should not cook it. */
const MAX_ORDER_AGE_MS = 10 * 60_000;
/** How often to check whether the menu changed while connected. */
const SNAPSHOT_INTERVAL_MS = 60_000;
/**
 * How long a successful pairing keeps this socket privileged.
 *
 * Short, because the privilege it grants — reading the real table codes — is
 * the one thing the hosted server is otherwise never trusted with.
 */
const ADMIN_SESSION_MS = 30 * 60_000;

/** Who may pair a hosted server with this shop. */
const ADMIN_ROLES = new Set<string>(ROLE_ACCESS.ownerManager);

/** When the current socket's pairing expires. Reset on every reconnect. */
let adminSessionUntil = 0;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let snapshotTimer: ReturnType<typeof setInterval> | null = null;
let lastSnapshotDigest = '';
let attempts = 0;
let stopped = true;

type RelayConfig = { url: string; secret: string };

function readConfig(): RelayConfig | null {
  if (!isGuestOrderingEnabled()) return null;
  const url = (getSettingValue('guest_relay_url') || '').trim();
  const secret = (getSettingValue('guest_relay_secret') || '').trim();
  if (!url || !secret) return null;
  if (!/^wss?:\/\//i.test(url)) {
    log.warn('[GuestRelay] guest_relay_url must start with ws:// or wss://');
    return null;
  }
  // Plaintext ws:// is allowed only for a loopback address, which is how the
  // tests drive this. Anything else carries orders across a network.
  if (/^ws:\/\//i.test(url) && !/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(url)) {
    log.warn('[GuestRelay] refusing a plaintext ws:// relay to a non-loopback host');
    return null;
  }
  return { url, secret };
}

/**
 * Proves this POS to the hosted server without sending the shared secret.
 *
 * The secret signs a timestamp and a nonce; the server recomputes it. A replayed
 * hello is useless once the server rejects an old timestamp, which it must.
 */
function buildHello(config: RelayConfig) {
  const { posHash } = ensureCloudIdentity();
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const signature = createHmac('sha256', config.secret)
    .update(`${posHash}.${timestamp}.${nonce}`)
    .digest('hex');
  return { type: 'hello', pos_hash: posHash, timestamp, nonce, signature, protocol: 1 };
}

/** Resolves a scanned code to a table, applying the same rules the local gateway does. */
function tableForCode(code: unknown): { id: string; number: string; guest_round: number } | null {
  const parsed = parseGuestToken(code);
  if (!parsed || !isTokenForThisStore(parsed.storeRef)) return null;
  const row = getDatabase()
    .prepare('SELECT id, number, guest_round FROM tables WHERE guest_token = ? AND is_active = 1')
    .get(parsed.secret) as { id: string; number: string; guest_round: number } | undefined;
  return row ?? null;
}

/**
 * Opens a sitting for a phone that has just scanned, and mints its round token.
 *
 * **The hosted server cannot do this itself**, and that is deliberate: a round
 * token is an HMAC over the table and the sitting number, signed with a secret
 * that never leaves this machine. So the hosted server asks, per scan, and holds
 * nothing — the same reason snapshots carry only hashes. A stolen hosted
 * database yields no working QR *and* no usable round token.
 *
 * Answers with exactly the fields the local gateway answers with, because the
 * page served over 4G is the same page served on the shop WiFi. Any difference
 * here shows up as a customer-visible bug on one entrance and not the other.
 */
function guestSessionPayload(code: unknown): Record<string, unknown> | null {
  const table = tableForCode(code);
  if (!table) return null;
  return {
    table: { name: table.number },
    round_token: newRoundToken(table.id, table.guest_round),
    ticket: tableTicket(table.id),
  };
}

/**
 * Sends the hosted server the menu it serves to phones.
 *
 * The server has no database of its own worth trusting for this: prices and
 * availability are the shop's, and a stale copy sells something that is off or
 * at last week's price. Table codes go up as hashes only — the phone presents
 * the real code and the POS re-checks it, so a breach of the hosted server
 * yields no working QR.
 *
 * `force` ignores the digest, for a server that has just reconnected and has
 * nothing cached.
 */
function pushSnapshot(force = false): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  try {
    const snapshot = publicOrderingSnapshot(
      getTenantCurrency(getDatabase()),
      getSettingValue('language') || 'en',
      getSettingValue('country') || 'TH',
    );
    const digest = snapshotDigest(snapshot);
    if (!force && digest === lastSnapshotDigest) return;
    lastSnapshotDigest = digest;
    reply({ type: 'snapshot', digest, ...snapshot, captured_at: new Date().toISOString() });
  } catch (error) {
    log.warn('[GuestRelay] snapshot push failed', (error as Error).message);
  }
}

/**
 * Pairs the hosted server with this shop using a code shown on the till.
 *
 * **No password ever leaves this machine.** The earlier design had the merchant
 * type their POS password into the hosted server, which worked but meant a
 * compromised VPS could capture a password that also unlocks the till. Here the
 * till generates a short-lived code, the merchant reads it off this screen and
 * types it there, and the worst a compromised VPS can steal is one code that is
 * already spent.
 *
 * The code is held in memory only. A restart losing it is correct: an unused
 * pairing code is not something worth persisting, and one found in a database
 * backup months later would be a liability rather than a convenience.
 *
 * Not the same thing as `getCachedPairingCode()` in main/db.ts, which caches a
 * code the *cloud* issued for RevFlo device pairing. Here the direction is
 * reversed and has to be: the hosted server is the party being authorised, so it
 * cannot be the party that mints the code.
 */
const PAIRING_TTL_MS = 5 * 60_000;
/**
 * Wrong guesses allowed before the code is destroyed rather than merely refused.
 *
 * The code is short enough to type, so it is short enough to guess at if the
 * attempts are unlimited. Burning the code on the fifth wrong try means an
 * attacker has to wait for a merchant to issue a new one, and gets five tries in
 * 2^40 each time.
 */
const PAIRING_MAX_ATTEMPTS = 5;
/**
 * Crockford base32: no I, L, O or U. A merchant reading a code off one screen
 * and typing it into another should not have to tell 0 from O, and the letter
 * that would be misread as a vowel in an unfortunate word is gone too.
 */
const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAIRING_LENGTH = 8;

let pairing: { code: string; expiresAt: number; attempts: number; name: string; role: string } | null = null;

/**
 * Issues a pairing code for the merchant to read off this screen.
 *
 * Reached from the POS's own owner/manager-gated route, and the role is checked
 * again here. Pairing grants whoever holds the code the real table codes, which
 * is the one thing the hosted server is otherwise never trusted with; that is
 * worth two locks rather than one.
 *
 * Issuing replaces any outstanding code. One live code at a time.
 */
export function issuePairingCode(user: { name: string; role: string }): { code: string; expires_at: string } {
  if (!ADMIN_ROLES.has(user.role)) {
    throw new Error('Only an owner or a manager can pair a hosted server');
  }
  // 32 divides 256 exactly, so a byte modulo the alphabet length is unbiased.
  const bytes = randomBytes(PAIRING_LENGTH);
  let code = '';
  for (const byte of bytes) code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];

  const expiresAt = Date.now() + PAIRING_TTL_MS;
  pairing = { code, expiresAt, attempts: 0, name: user.name, role: user.role };
  log.info('[GuestRelay] pairing code issued, valid', PAIRING_TTL_MS / 60_000, 'minutes');
  return { code, expires_at: new Date(expiresAt).toISOString() };
}

/** Forgets the outstanding code. Used when the merchant closes the dialog. */
export function clearPairingCode(): void {
  pairing = null;
}

/**
 * Normalises what the merchant typed.
 *
 * Case and separators are theirs to get wrong. `O` folds to `0` and `I`/`L` to
 * `1`, which is Crockford's own mapping and is safe precisely because the
 * alphabet contains none of those three — a fold can never collide with a
 * character a real code could hold. `U` is excluded too but is deliberately not
 * folded: there is no digit it is mistaken for, and inventing one would turn a
 * typo into a different valid code.
 */
function normalizePairingCode(input: unknown): string {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

function verifyPairing(input: unknown): { ok: true; name: string; role: string } | { ok: false; reason: string } {
  if (!pairing) return { ok: false, reason: 'no_pairing_code' };
  if (Date.now() > pairing.expiresAt) {
    pairing = null;
    return { ok: false, reason: 'expired' };
  }

  const presented = normalizePairingCode(input);
  const expected = Buffer.from(pairing.code);
  const got = Buffer.from(presented);
  const matches = expected.length === got.length && timingSafeEqual(expected, got);

  if (!matches) {
    pairing.attempts += 1;
    if (pairing.attempts >= PAIRING_MAX_ATTEMPTS) {
      pairing = null;
      log.warn('[GuestRelay] pairing code destroyed after', PAIRING_MAX_ATTEMPTS, 'wrong attempts');
      return { ok: false, reason: 'too_many_attempts' };
    }
    return { ok: false, reason: 'invalid_code' };
  }

  // Single use. A code that still works after it has paired is a code sitting in
  // the merchant's browser history waiting to pair somebody else's server.
  const { name, role } = pairing;
  pairing = null;
  return { ok: true, name, role };
}

/**
 * The printable codes, handed over only across a paired socket.
 *
 * Snapshots carry hashes precisely so a breach of the hosted database yields no
 * working QR. This is the deliberate exception: an admin asking to print the
 * codes needs the real ones. The hosted server is told to render and discard
 * them rather than store them — it cannot be forced to, which is why the
 * privilege is short-lived and role-gated here.
 */
function tableCodesPayload(): { tables: { id: string; number: string; code: string }[] } {
  const rows = getDatabase().prepare(`
    SELECT id, number, guest_token FROM tables
    WHERE is_active = 1 AND guest_token IS NOT NULL AND guest_token <> ''
    ORDER BY number
  `).all() as { id: string; number: string; guest_token: string }[];
  return {
    tables: rows.map((row) => ({
      id: row.id,
      number: row.number,
      code: qualifyGuestToken(row.guest_token),
    })),
  };
}

type RelayOrder = {
  id?: string;
  table_code?: string;
  round_token?: string;
  items?: unknown;
  placed_at?: string;
};

function reply(payload: Record<string, unknown>): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch (error) {
    log.warn('[GuestRelay] reply failed', (error as Error).message);
  }
}

/**
 * Applies one relayed order.
 *
 * Every rejection is answered rather than dropped: a hosted server that hears
 * nothing has to assume the order may have landed, and its only safe move is to
 * send it again. Saying "no, and why" is what stops that loop.
 */
async function handleOrder(message: RelayOrder): Promise<void> {
  const id = String(message.id || '');
  if (!id) return;

  const nack = (reason: string, detail?: string) => {
    log.warn('[GuestRelay] rejected order', id, reason, detail ?? '');
    reply({ type: 'nack', id, reason, detail });
  };

  // An order that sat in a queue through a long outage is not food anyone still
  // wants; the server is told so it can tell the customer rather than retry.
  if (message.placed_at) {
    const placedAt = Date.parse(message.placed_at);
    if (Number.isFinite(placedAt) && Date.now() - placedAt > MAX_ORDER_AGE_MS) {
      return nack('stale', 'order is older than the acceptance window');
    }
  }

  const table = tableForCode(message.table_code);
  if (!table) return nack('unknown_table');

  // The sitting is what authorises ordering, exactly as on the local gateway:
  // a party that has already paid must not be able to order again.
  if (!isRoundTokenCurrent(message.round_token, table.id, table.guest_round)) {
    return nack('round_closed');
  }

  const validation = validateGuestItems(message.items);
  if (!validation.ok) return nack('invalid_items', validation.error);

  // Checked before placing rather than left to the POS's own idempotency.
  // A redelivery takes a *different* path — the first delivery opened a ticket,
  // so the second one appends to it — and the POS rejects the same key arriving
  // with a different request shape. The relay has to recognise the repeat
  // itself and answer from what it stored the first time.
  const idempotencyKey = `relay:${id}`;
  const prior = getDatabase()
    .prepare('SELECT response_json FROM order_idempotency WHERE idempotency_key = ? LIMIT 1')
    .get(idempotencyKey) as { response_json?: string } | undefined;
  if (prior?.response_json) {
    try {
      const stored = JSON.parse(prior.response_json) as { order?: Record<string, unknown> };
      reply({
        type: 'ack',
        id,
        order_id: stored.order?.id ?? '',
        order_number: String(stored.order?.order_number ?? ''),
        table_name: table.number,
        appended: false,
        replay: true,
      });
      log.info('[GuestRelay] re-acked already-applied order', id);
      return;
    } catch {
      // A stored response we cannot read is worse than none; fall through and
      // let the POS decide, which at worst refuses on the key.
    }
  }

  try {
    const result = await placeGuestOrder(table.id, validation.items, { idempotencyKey });
    if (!result.ok) return nack('rejected', result.error);
    reply({
      type: 'ack',
      id,
      order_id: result.orderId,
      order_number: result.orderNumber,
      table_name: table.number,
      appended: result.appended,
    });
    log.info('[GuestRelay] accepted order', id, '->', result.orderNumber);
  } catch (error) {
    nack('error', (error as Error).message);
  }
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
  attempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
  reconnectTimer.unref?.();
}

function connect(): void {
  if (stopped || socket) return;
  const config = readConfig();
  if (!config) return;

  let opening: WebSocket;
  try {
    opening = new WebSocket(config.url, { handshakeTimeout: 10_000 });
  } catch (error) {
    log.warn('[GuestRelay] connect failed', (error as Error).message);
    scheduleReconnect();
    return;
  }
  socket = opening;

  opening.on('open', () => {
    attempts = 0;
    reply(buildHello(config));
    log.info('[GuestRelay] connected to', config.url);
    // The server may have been restarted or deployed fresh; never assume it
    // still holds what was sent last time.
    lastSnapshotDigest = '';
    // A reconnect is a new server as far as this POS knows; privilege never
    // carries across one.
    adminSessionUntil = 0;
    pushSnapshot(true);
    pingTimer = setInterval(() => {
      if (opening.readyState === WebSocket.OPEN) opening.ping();
    }, PING_INTERVAL_MS);
    pingTimer.unref?.();
    snapshotTimer = setInterval(() => pushSnapshot(false), SNAPSHOT_INTERVAL_MS);
    snapshotTimer.unref?.();
  });

  opening.on('message', (data) => {
    let message: RelayOrder & { type?: string };
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.type === 'order') { void handleOrder(message); return; }
    // A server that lost its cache asks rather than waiting for a change.
    if (message.type === 'need_snapshot') { pushSnapshot(true); return; }

    // A phone has scanned. Needs no pairing: a customer at a table is not an
    // administrator, and the code they present is the only credential required.
    if (message.type === 'guest_session') {
      const id = String((message as any).id || '');
      const payload = guestSessionPayload((message as any).table_code);
      if (!payload) {
        reply({ type: 'guest_session_result', id, ok: false, reason: 'unknown_table' });
        return;
      }
      reply({ type: 'guest_session_result', id, ok: true, ...payload });
      return;
    }

    // Polled by the page while the guest waits for food, so it has to re-check
    // the round token every time rather than trusting the first scan: the
    // sitting may have been settled since.
    if (message.type === 'guest_ticket') {
      const id = String((message as any).id || '');
      const table = tableForCode((message as any).table_code);
      if (!table) {
        reply({ type: 'guest_ticket_result', id, ok: false, reason: 'unknown_table' });
        return;
      }
      if (!isRoundTokenCurrent((message as any).round_token, table.id, table.guest_round)) {
        reply({ type: 'guest_ticket_result', id, ok: false, reason: 'round_closed' });
        return;
      }
      reply({ type: 'guest_ticket_result', id, ok: true, ticket: tableTicket(table.id) });
      return;
    }

    if (message.type === 'admin_pair') {
      const id = String((message as any).id || '');
      const result = verifyPairing((message as any).code);
      if (!result.ok) {
        adminSessionUntil = 0;
        log.warn('[GuestRelay] pairing refused:', result.reason);
        reply({ type: 'admin_pair_result', id, ok: false, reason: result.reason });
        return;
      }
      adminSessionUntil = Date.now() + ADMIN_SESSION_MS;
      reply({ type: 'admin_pair_result', id, ok: true, name: result.name, role: result.role,
              expires_in_ms: ADMIN_SESSION_MS });
      log.info('[GuestRelay] hosted server paired by', result.role);
      // Pairing is what the merchant does to publish; send everything at once
      // rather than waiting for the next digest check.
      pushSnapshot(true);
      return;
    }

    if (message.type === 'admin_table_codes') {
      const id = String((message as any).id || '');
      if (Date.now() > adminSessionUntil) {
        reply({ type: 'admin_table_codes_result', id, ok: false, reason: 'not_paired' });
        return;
      }
      reply({ type: 'admin_table_codes_result', id, ok: true, ...tableCodesPayload() });
      return;
    }
  });

  opening.on('close', () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null; }
    socket = null;
    if (!stopped) scheduleReconnect();
  });

  opening.on('error', (error) => {
    log.warn('[GuestRelay] socket error', (error as Error).message);
  });
}

/** Starts the relay if it is configured. Safe to call repeatedly. */
export function startGuestRelay(): void {
  stopped = false;
  if (socket) return;
  connect();
}

export function stopGuestRelay(): Promise<void> {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null; }
  const open = socket;
  socket = null;
  attempts = 0;
  if (!open) return Promise.resolve();
  return new Promise((resolve) => {
    const done = setTimeout(resolve, 2_000);
    done.unref?.();
    open.once('close', () => { clearTimeout(done); resolve(); });
    try { open.close(); } catch { resolve(); }
  });
}

/** Re-reads settings and reconnects — called when the merchant changes them. */
export function reloadGuestRelay(): void {
  void stopGuestRelay().then(() => { if (readConfig()) startGuestRelay(); });
}

export function isGuestRelayConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}

/** Exported for the protocol test: the signature a server has to verify. */
export function signHello(secret: string, posHash: string, timestamp: string, nonce: string): string {
  return createHmac('sha256', secret).update(`${posHash}.${timestamp}.${nonce}`).digest('hex');
}

/** Constant-time comparison, for a server implemented in this codebase. */
export function helloSignatureMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** A fresh relay secret for the merchant to paste into their hosted server. */
export function newRelaySecret(): string {
  return randomBytes(32).toString('base64url');
}
