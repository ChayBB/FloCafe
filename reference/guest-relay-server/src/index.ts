/**
 * FloCafe guest relay — Bun + Elysia.
 *
 * Two surfaces on one port:
 *   /relay          the socket the POS dials out to and holds open
 *   /api/guest/*    what a customer's phone talks to over 4G
 *
 * Caddy terminates TLS in front of both. See ../README.md.
 */
import { Elysia, t } from 'elysia';
import { createHash, randomUUID } from 'node:crypto';
import { loadMenu, shopProfile, sql, tableByHash } from './db';
import { applySnapshot, attach, detach, dispatch, isPosConnected, settle, verifyHello } from './pos-link';

const RELAY_SECRET = process.env.RELAY_SECRET;
if (!RELAY_SECRET) throw new Error('RELAY_SECRET is required');
const PORT = Number(process.env.PORT || 3000);

/** The POS sends `sha256(code)`; the phone sends the code itself. */
const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

/**
 * Per-IP limits. A starting point, not a measured value — raise or lower once
 * there is real traffic to look at.
 */
const RATE: Record<string, { windowMs: number; max: number }> = {
  read: { windowMs: 60_000, max: 120 },
  order: { windowMs: 60_000, max: 10 },
};
const hits = new Map<string, { count: number; resetAt: number }>();

function overLimit(kind: keyof typeof RATE, ip: string): boolean {
  const limit = RATE[kind];
  const key = `${kind}:${ip}`;
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + limit.windowMs });
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    return false;
  }
  entry.count += 1;
  return entry.count > limit.max;
}

/** The single shop this reference serves; set by the first accepted hello. */
let shopId: string | null = null;

const app = new Elysia()

  // ── The POS socket ────────────────────────────────────────────────────────
  .ws('/relay', {
    async message(ws, raw) {
      let message: any;
      try {
        message = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        return;
      }

      if (message.type === 'hello') {
        const verified = await verifyHello(message, RELAY_SECRET);
        if (!verified.ok) {
          // Closed rather than ignored: a till that believes it is connected
          // while the server has rejected it will queue orders into nothing.
          console.warn('[relay] hello rejected:', verified.reason);
          ws.close(4401, verified.reason);
          return;
        }
        shopId = verified.shopId;
        attach(ws.raw as unknown as WebSocket, shopId);
        console.log('[relay] POS connected:', shopId);
        // Ask for the menu: this process may have restarted since the till last
        // sent one, and serving a stale menu sells the wrong thing.
        ws.send(JSON.stringify({ type: 'need_snapshot' }));
        return;
      }

      if (!shopId) return;   // nothing is accepted before a verified hello

      if (message.type === 'snapshot') {
        await applySnapshot(shopId, message);
        console.log('[relay] menu updated:', message.products?.length ?? 0, 'products');
        return;
      }

      if (message.type === 'ack' || message.type === 'nack') settle(message);
    },

    close(ws) {
      detach(ws.raw as unknown as WebSocket);
      console.log('[relay] POS disconnected');
    },
  })

  // ── What the customer's phone talks to ────────────────────────────────────

  /** Opens a session from a scanned code: the menu, and who they are ordering as. */
  .get('/api/guest/:code/session', async ({ params, set, server, request }) => {
    const ip = server?.requestIP(request)?.address ?? 'unknown';
    if (overLimit('read', ip)) { set.status = 429; return { error: 'Too many requests' }; }
    if (!shopId) { set.status = 503; return { error: 'The shop is not connected' }; }

    const table = await tableByHash(shopId, hashCode(params.code));
    if (!table) { set.status = 404; return { error: 'This QR code is no longer valid. Please ask our staff.' }; }

    const [menu, shop] = await Promise.all([loadMenu(shopId), shopProfile(shopId)]);
    return {
      table: { name: table.name },
      shop: { name: shop?.name ?? '', currency: shop?.currency ?? 'THB', language: shop?.language ?? 'en' },
      online: isPosConnected(),
      ...menu,
    };
  })

  /**
   * Places an order.
   *
   * Does not answer until the till has acknowledged it or the queue window has
   * passed. The phone shows "sending" for exactly that long: a customer is
   * never told the kitchen has their order before the kitchen does.
   */
  .post('/api/guest/:code/order', async ({ params, body, set, server, request }) => {
    const ip = server?.requestIP(request)?.address ?? 'unknown';
    if (overLimit('order', ip)) { set.status = 429; return { error: 'Too many orders in a short time' }; }
    if (!shopId) { set.status = 503; return { error: 'The shop is not connected' }; }

    const tokenHash = hashCode(params.code);
    const table = await tableByHash(shopId, tokenHash);
    if (!table) { set.status = 404; return { error: 'This QR code is no longer valid. Please ask our staff.' }; }

    const id = randomUUID();
    const placedAt = new Date().toISOString();
    await sql`INSERT INTO relay_orders (id, shop_id, table_hash, payload, status, placed_at)
              VALUES (${id}, ${shopId}, ${tokenHash}, ${JSON.stringify(body)}::jsonb, 'queued', ${placedAt})`;

    const result = await dispatch({
      id,
      tableCode: params.code,
      roundToken: String((body as any).round_token ?? ''),
      items: (body as any).items ?? [],
      placedAt,
    });

    if (!result.ok) {
      // The till refused it or never answered. Say so plainly — a customer who
      // is told nothing assumes it worked and waits for food that is not coming.
      set.status = result.reason === 'timeout' ? 504 : 409;
      return { error: 'Your order did not reach the kitchen. Please ask our staff.', reason: result.reason };
    }

    return { ok: true, order_number: result.orderNumber, table: result.tableName, appended: result.appended };
  }, {
    body: t.Object({
      round_token: t.String(),
      items: t.Array(t.Object({
        product_id: t.String(),
        quantity: t.Number(),
        special_instructions: t.Optional(t.String()),
      })),
    }),
  })

  .get('/api/health', () => ({ status: 'ok', pos_connected: isPosConnected(), shop: shopId }))

  .listen(PORT);

console.log(`[relay] listening on :${PORT}`);

export type App = typeof app;
