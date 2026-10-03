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
import { isRoundTokenCurrent, isTokenForThisStore, parseGuestToken } from './guest-tokens';
import { placeGuestOrder, validateGuestItems } from './guest-orders';

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const PING_INTERVAL_MS = 25_000;
/** A relayed order older than this is stale: the kitchen should not cook it. */
const MAX_ORDER_AGE_MS = 10 * 60_000;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
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
    pingTimer = setInterval(() => {
      if (opening.readyState === WebSocket.OPEN) opening.ping();
    }, PING_INTERVAL_MS);
    pingTimer.unref?.();
  });

  opening.on('message', (data) => {
    let message: RelayOrder & { type?: string };
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.type === 'order') void handleOrder(message);
  });

  opening.on('close', () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
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
