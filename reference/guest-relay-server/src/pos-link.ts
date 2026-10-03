/**
 * The POS end of the wire.
 *
 * The till dials in and holds one socket open. Everything the shop owns —
 * the menu, the table list — arrives on it, and every order goes back out on
 * it. See ../../docs/guest-relay-protocol.md.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from './db';

const HELLO_WINDOW_MS = 5 * 60_000;
/** How long an order may wait for the till before the customer is told it failed. */
export const QUEUE_WINDOW_MS = 10 * 60_000;
const RESEND_INTERVAL_MS = 5_000;

type Link = { socket: WebSocket; shopId: string };

/** One shop per process in this reference; a multi-shop build keys this by shop. */
let link: Link | null = null;

const waiting = new Map<string, (result: AckResult) => void>();

export type AckResult =
  | { ok: true; orderNumber: string; tableName: string; appended: boolean }
  | { ok: false; reason: string; detail?: string };

export function isPosConnected(): boolean {
  return link?.socket.readyState === WebSocket.OPEN;
}

/**
 * Checks that a hello really came from the till.
 *
 * Both halves matter and neither is optional. An old timestamp or a reused
 * nonce means a captured hello is being replayed, and the POS cannot detect
 * that from its end — only this server sees both attempts.
 */
export async function verifyHello(
  message: { pos_hash?: string; timestamp?: string; nonce?: string; signature?: string },
  secret: string,
): Promise<{ ok: true; shopId: string } | { ok: false; reason: string }> {
  const { pos_hash: posHash, timestamp, nonce, signature } = message;
  if (!posHash || !timestamp || !nonce || !signature) return { ok: false, reason: 'incomplete hello' };

  const age = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > HELLO_WINDOW_MS) {
    return { ok: false, reason: 'timestamp outside the accepted window' };
  }

  const expected = createHmac('sha256', secret).update(`${posHash}.${timestamp}.${nonce}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad signature' };

  // Single-use. The insert is the check: a duplicate nonce violates the key.
  try {
    await sql`INSERT INTO hello_nonces (nonce) VALUES (${nonce})`;
  } catch {
    return { ok: false, reason: 'nonce replayed' };
  }
  await sql`DELETE FROM hello_nonces WHERE seen_at < now() - interval '1 hour'`;

  return { ok: true, shopId: posHash };
}

export function attach(socket: WebSocket, shopId: string): void {
  link = { socket, shopId };
}

export function detach(socket: WebSocket): void {
  if (link?.socket === socket) link = null;
}

/** Replaces the cached menu with the snapshot the till just sent. */
export async function applySnapshot(shopId: string, snapshot: any): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO shops (id, currency, language, snapshot_digest, last_seen_at)
             VALUES (${shopId}, ${snapshot.currency ?? 'THB'}, ${snapshot.language ?? 'en'}, ${snapshot.digest ?? null}, now())
             ON CONFLICT (id) DO UPDATE SET
               currency = excluded.currency,
               language = excluded.language,
               snapshot_digest = excluded.snapshot_digest,
               last_seen_at = now()`;

    // Replaced wholesale rather than merged: a product removed upstream must
    // disappear here, and a diff that misses a deletion keeps selling it.
    await tx`DELETE FROM menu_items WHERE shop_id = ${shopId}`;
    await tx`DELETE FROM menu_categories WHERE shop_id = ${shopId}`;
    await tx`DELETE FROM shop_tables WHERE shop_id = ${shopId}`;

    for (const category of snapshot.categories ?? []) {
      await tx`INSERT INTO menu_categories (shop_id, category_id, name)
               VALUES (${shopId}, ${category.id}, ${category.name})`;
    }
    for (const product of snapshot.products ?? []) {
      await tx`INSERT INTO menu_items (shop_id, product_id, category_id, name, description, price, has_image)
               VALUES (${shopId}, ${product.id}, ${product.category_id ?? null}, ${product.name},
                       ${product.description ?? null}, ${product.price}, ${Boolean(product.has_image)})`;
    }
    for (const table of snapshot.tables ?? []) {
      await tx`INSERT INTO shop_tables (shop_id, token_hash, table_id, name)
               VALUES (${shopId}, ${table.token_hash}, ${table.id}, ${table.number ?? ''})`;
    }
  });
}

/** Routes an ack or nack back to whoever is waiting on that order. */
export function settle(message: { type: string; id?: string; order_number?: string; table_name?: string; appended?: boolean; reason?: string; detail?: string }): void {
  const id = String(message.id ?? '');
  const resolve = waiting.get(id);

  const result: AckResult = message.type === 'ack'
    ? { ok: true, orderNumber: String(message.order_number ?? ''), tableName: String(message.table_name ?? ''), appended: Boolean(message.appended) }
    : { ok: false, reason: String(message.reason ?? 'refused'), detail: message.detail };

  void sql`UPDATE relay_orders
           SET status = ${message.type === 'ack' ? 'acked' : 'refused'},
               order_number = ${message.type === 'ack' ? String(message.order_number ?? '') : null},
               refusal = ${message.type === 'ack' ? null : String(message.reason ?? 'refused')},
               settled_at = now()
           WHERE id = ${id}`;

  if (resolve) {
    waiting.delete(id);
    resolve(result);
  }
}

/**
 * Sends an order to the till and waits for it to be acknowledged.
 *
 * Resolves only on a real answer or on the queue window expiring. The customer's
 * page shows "sending" for exactly this long and is never told the kitchen has
 * it until the till says so.
 */
export function dispatch(order: {
  id: string;
  tableCode: string;
  roundToken: string;
  items: unknown[];
  placedAt: string;
}): Promise<AckResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: AckResult) => {
      if (settled) return;
      settled = true;
      clearInterval(resend);
      clearTimeout(expiry);
      waiting.delete(order.id);
      resolve(result);
    };

    waiting.set(order.id, finish);

    const send = () => {
      if (!isPosConnected()) return;
      void sql`UPDATE relay_orders SET status = 'sent', attempts = attempts + 1 WHERE id = ${order.id}`;
      link!.socket.send(JSON.stringify({
        type: 'order',
        id: order.id,                 // never regenerated: this is what lets the
        table_code: order.tableCode,  // POS recognise a repeat instead of cooking twice
        round_token: order.roundToken,
        items: order.items,
        placed_at: order.placedAt,
      }));
    };

    send();
    // Keeps trying while the till is away; the same id throughout.
    const resend = setInterval(send, RESEND_INTERVAL_MS);

    const expiry = setTimeout(() => {
      void sql`UPDATE relay_orders SET status = 'expired', settled_at = now() WHERE id = ${order.id}`;
      finish({ ok: false, reason: 'timeout', detail: 'the till did not answer' });
    }, QUEUE_WINDOW_MS);
  });
}
