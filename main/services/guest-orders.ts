/**
 * What a customer is allowed to order, and how that order reaches the POS.
 *
 * One definition, used by both guest entrances — the local gateway on port 3004
 * and the relay that carries orders from a hosted server (see
 * `main/services/guest-relay.ts`). Two copies of "what a guest may order" would
 * drift, and the copy that drifts is the one that stops checking something.
 */
import { getDatabase } from '../db';
import { getServerPort } from '../server';
import { GUEST_CHANNEL_HEADER, getGuestChannelSecret } from './guest-channel';

/** A real guest orders a handful of one thing, not a thousand. */
export const MAX_GUEST_LINES = 40;
export const MAX_GUEST_QUANTITY = 20;
const MAX_NOTE_LENGTH = 200;

export type GuestOrderLine = {
  product_id: string;
  quantity: number;
  special_instructions?: string;
};

export type ValidationResult =
  | { ok: true; items: GuestOrderLine[] }
  | { ok: false; error: string };

export type GuestTicketLine = {
  id: number;
  product_name: string;
  quantity: number;
  status: string;
  special_instructions: string | null;
};

export type GuestTicket = { order_number: string; items: GuestTicketLine[] } | null;

/**
 * What the table has ordered so far this sitting.
 *
 * Shared by both guest entrances for the same reason `validateGuestItems` is:
 * a customer on 4G and a customer on the shop WiFi are looking at the same
 * table, and showing them different tickets would be worse than showing neither.
 *
 * Cancelled, voided and refunded lines are excluded — a guest seeing a line they
 * were never charged for will ask about it, and a line that was voided for a
 * reason is not the guest's business.
 */
export function tableTicket(tableId: string): GuestTicket {
  const db = getDatabase();
  const order = db.prepare(`
    SELECT id, order_number, status FROM orders
    WHERE table_id = ? AND status NOT IN ('completed', 'cancelled')
    ORDER BY created_at DESC LIMIT 1
  `).get(tableId) as { id: number; order_number: string; status: string } | undefined;
  if (!order) return null;

  const items = db.prepare(`
    SELECT id, product_name, quantity, status, special_instructions
    FROM order_items
    WHERE order_id = ? AND status NOT IN ('cancelled', 'voided', 'void_adjustment', 'refunded')
    ORDER BY id
  `).all(order.id) as GuestTicketLine[];

  return { order_number: order.order_number, items };
}

/**
 * Checks a basket against the live menu.
 *
 * Every product id is re-checked here rather than trusted from the page: the
 * menu a phone is holding may be minutes old, and a guessed id must not become
 * an order line.
 */
export function validateGuestItems(rawItems: unknown): ValidationResult {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, error: 'No items to send' };
  }
  if (rawItems.length > MAX_GUEST_LINES) {
    return { ok: false, error: 'Too many items in one order' };
  }

  const db = getDatabase();
  const items: GuestOrderLine[] = [];
  for (const raw of rawItems as Record<string, unknown>[]) {
    const productId = String(raw?.product_id || '');
    const quantity = Number(raw?.quantity);
    if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_GUEST_QUANTITY) {
      return { ok: false, error: 'Invalid item' };
    }
    const sellable = db.prepare(`
      SELECT 1 FROM products p LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.id = ? AND p.deleted_at IS NULL AND p.is_active = 1 AND (c.id IS NULL OR c.is_active = 1)
    `).get(productId);
    if (!sellable) return { ok: false, error: 'Item is no longer available' };

    const note = typeof raw?.special_instructions === 'string'
      ? (raw.special_instructions as string).trim().slice(0, MAX_NOTE_LENGTH)
      : '';
    items.push({ product_id: productId, quantity, ...(note ? { special_instructions: note } : {}) });
  }
  return { ok: true, items };
}

/**
 * Calls the POS API as the merchant's own service.
 *
 * Guest requests never carry a user token, so the payload is built here and the
 * table comes from the resolved code, never from the request body. The loopback
 * secret is what the POS accepts in place of a login, and only for the two
 * order routes.
 */
async function callPosApi(
  method: 'POST',
  targetPath: string,
  body: unknown,
  options: { signal?: AbortSignal; idempotencyKey?: string } = {},
) {
  const target = new URL(`/api${targetPath}`, `http://127.0.0.1:${getServerPort()}`);
  const response = await fetch(target, {
    method,
    headers: {
      'Content-Type': 'application/json',
      [GUEST_CHANNEL_HEADER]: getGuestChannelSecret(),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
    },
    body: JSON.stringify(body ?? {}),
    signal: options.signal,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* upstream error page */ }
  return { status: response.status, body: parsed as Record<string, unknown> };
}

export type PlacementResult =
  | { ok: true; orderId: number | string; orderNumber: string; appended: boolean }
  | { ok: false; status: number; error: string };

/**
 * Adds a validated basket to the table's open ticket, or opens one.
 *
 * `idempotencyKey` matters for the relay: a hosted server that does not hear an
 * acknowledgement will send the order again, and without a key that second
 * delivery becomes a second round of food.
 */
export async function placeGuestOrder(
  tableId: string,
  items: GuestOrderLine[],
  options: { signal?: AbortSignal; idempotencyKey?: string } = {},
): Promise<PlacementResult> {
  const db = getDatabase();
  const open = db.prepare(`
    SELECT id FROM orders
    WHERE table_id = ? AND status NOT IN ('completed', 'cancelled')
    ORDER BY created_at DESC LIMIT 1
  `).get(tableId) as { id: number } | undefined;

  const result = open
    ? await callPosApi('POST', `/orders/${open.id}/items`, { items }, options)
    : await callPosApi('POST', '/orders', { table_id: tableId, type: 'dine_in', items }, options);

  if (result.status >= 400) {
    const error = typeof result.body?.error === 'string' ? result.body.error : 'Order rejected';
    console.warn('[Guest] Order rejected by POS API:', result.status, error);
    return { ok: false, status: result.status, error };
  }

  const order = (result.body?.order ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    orderId: (order.id as number | string) ?? '',
    orderNumber: String(order.order_number ?? ''),
    appended: Boolean(open),
  };
}
