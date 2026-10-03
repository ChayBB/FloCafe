/**
 * FloCafe guest relay — Bun + Elysia.
 *
 * Three surfaces on one port:
 *   /relay          the socket the POS dials out to and holds open
 *   /api/guest/*    what a customer's phone talks to over 4G
 *   /admin/*        where the owner pairs the till and gets the printable QRs
 *
 * Caddy terminates TLS in front of both. See ../README.md.
 */
import { Elysia, t } from 'elysia';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { loadMenu, shopProfile, sql, tableByHash } from './db';
// Aliased: `request` is also the name Elysia gives the incoming Request in a
// handler's context, and shadowing it there would be a trap for the next reader.
import {
  applySnapshot, attach, deliverReply, detach, dispatch, isPosConnected,
  request as request_, settle, verifyHello,
} from './pos-link';
import { pair, sessionFor, signOut, tableCodes } from './admin';
import { adminPage, pairPage, printPage } from './admin-pages';

const RELAY_SECRET = process.env.RELAY_SECRET;
if (!RELAY_SECRET) throw new Error('RELAY_SECRET is required');
const PORT = Number(process.env.PORT || 3000);
/** The address the customer's phone will reach, baked into every QR. */
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
/** Where FloCafe's exported guest page was copied to. See ../README.md. */
const GUEST_PAGE_ROOT = process.env.GUEST_PAGE_DIR || './public';
const GUEST_PAGE_DIR = `${GUEST_PAGE_ROOT}/guest-order`;

/**
 * Maps a `/_next/...` request onto a file, refusing anything that tries to
 * leave the directory.
 *
 * The check is on the *resolved* path, not on the request text. A blocklist of
 * `..` is defeated by `%2e%2e` and by encodings nobody thought of; a resolved
 * path that does not sit under the root is wrong however it was spelled.
 */
function resolveStatic(requestPath: string): string | null {
  const root = resolve(GUEST_PAGE_ROOT) + sep;
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;   // a malformed escape is not a path worth guessing at
  }
  if (decoded.includes('\0')) return null;
  const target = resolve(root, '.' + decoded);
  return target.startsWith(root) ? target : null;
}

/** The POS sends `sha256(code)`; the phone sends the code itself. */
const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

/**
 * Per-IP limits. A starting point, not a measured value — raise or lower once
 * there is real traffic to look at.
 */
const RATE: Record<string, { windowMs: number; max: number }> = {
  read: { windowMs: 60_000, max: 120 },
  order: { windowMs: 60_000, max: 10 },
  // The till burns a code after five wrong guesses, so brute force is already
  // dealt with. This limit exists for the other attack: hammering the form to
  // destroy every code a merchant issues, which the till cannot distinguish from
  // a merchant who keeps mistyping.
  pair: { windowMs: 15 * 60_000, max: 10 },
};
const hits = new Map<string, { count: number; resetAt: number }>();

/**
 * Who is calling.
 *
 * Caddy proxies from localhost, so the socket address is the same for everybody
 * and rate limiting it would put the whole internet in one bucket — including
 * the sign-in form. The last hop in `X-Forwarded-For` is the one Caddy appended
 * and is the only entry a client cannot forge; earlier ones are the client's own
 * claim and are ignored.
 *
 * This assumes requests only ever arrive through the proxy. Bind Bun to
 * localhost, or an attacker reaching it directly sets any address they like.
 */
function clientIp(server: { requestIP?: (r: Request) => { address: string } | null } | null, request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded.split(',');
    const last = hops[hops.length - 1]!.trim();
    if (last) return last;
  }
  return server?.requestIP?.(request)?.address ?? 'unknown';
}

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

/** The till's refusal reasons, in words a merchant can act on. */
const PAIR_ERRORS: Record<string, string> = {
  invalid_code: 'That code is not right. Check the till and try again.',
  no_pairing_code: 'There is no code waiting. Ask the till for a new one.',
  expired: 'That code has expired. Ask the till for a new one.',
  too_many_attempts: 'Too many wrong tries, so the till cancelled that code. Ask it for a new one.',
  pos_unreachable: 'Your till did not answer. Check that it is on and connected.',
};

const page503 = (reason: string) =>
  `<!doctype html><meta charset="utf-8"><p>${
    reason === 'session_expired'
      ? 'Your session expired. <a href="/admin">Pair again</a>.'
      : 'Your till did not answer. <a href="/admin/print">Try again</a>.'
  }</p>`;

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

      if (message.type === 'ack' || message.type === 'nack') { settle(message); return; }

      // admin_pair_result, admin_table_codes_result: answers to something the
      // owner clicked. Unrecognised types are ignored, so a newer POS speaking
      // frames this build has never heard of does not break the connection.
      deliverReply(message);
    },

    close(ws) {
      detach(ws.raw as unknown as WebSocket);
      console.log('[relay] POS disconnected');
    },
  })

  // ── What the customer's phone talks to ────────────────────────────────────

  /**
   * Opens a session from a scanned code.
   *
   * The response shape is **not this server's to choose**. It is the contract
   * `frontend/src/app/guest-order/page.tsx` already expects, because the page a
   * customer loads over 4G is the same page the shop's own WiFi serves. The
   * local gateway (`main/guest-server.ts`) answers with exactly these fields;
   * diverging here would be a bug visible to customers on one entrance only.
   *
   * The menu comes from the cached snapshot. The round token does not and
   * cannot: it is signed with a secret that never leaves the till, so it is
   * fetched per scan and stored nowhere.
   */
  .get('/api/guest/:code/session', async ({ params, set, server, request }) => {
    const ip = clientIp(server, request);
    if (overLimit('read', ip)) { set.status = 429; return { error: 'Too many requests' }; }
    if (!shopId) { set.status = 503; return { error: 'The shop is not connected' }; }

    const table = await tableByHash(shopId, hashCode(params.code));
    if (!table) { set.status = 404; return { error: 'This QR code is no longer valid. Please ask our staff.' }; }

    // Asked of the till, because only it can sign a round token. A shop that is
    // offline cannot open a sitting at all, and saying so is better than serving
    // a menu nothing can be ordered from.
    const session = await request_('guest_session', { table_code: params.code }, 'guest_session_result');
    if (!session || session.ok !== true) {
      set.status = session?.reason === 'unknown_table' ? 404 : 503;
      return { error: 'We cannot take orders right now. Please ask our staff.' };
    }

    const [menu, shop] = await Promise.all([loadMenu(shopId), shopProfile(shopId)]);
    set.headers['cache-control'] = 'no-store';   // the round token is a credential
    return {
      table: session.table ?? { name: table.name },
      round_token: session.round_token,
      ticket: session.ticket ?? null,
      currency: shop?.currency ?? 'THB',
      country: shop?.country ?? 'TH',
      language: shop?.language ?? 'en',
      ...menu,
    };
  })

  /**
   * What the table has ordered so far, polled by the page while guests wait.
   *
   * Goes to the till every time rather than being cached here: the ticket is the
   * one thing on the page that changes without the customer doing anything, and
   * a stale copy tells them their food is still coming after it has arrived.
   */
  .get('/api/guest/:code/ticket', async ({ params, headers, set, server, request }) => {
    const ip = clientIp(server, request);
    if (overLimit('read', ip)) { set.status = 429; return { error: 'Too many requests' }; }
    if (!shopId) { set.status = 503; return { error: 'The shop is not connected' }; }

    const result = await request_('guest_ticket', {
      table_code: params.code,
      round_token: headers['x-guest-round'] ?? '',
    }, 'guest_ticket_result');

    if (!result || result.ok !== true) {
      // 409 for a settled sitting, matching the local gateway, so the page takes
      // the same branch and asks the guest to scan again.
      set.status = result?.reason === 'round_closed' ? 409 : result?.reason === 'unknown_table' ? 404 : 503;
      return { error: 'This QR code is no longer valid. Please ask our staff.' };
    }
    set.headers['cache-control'] = 'no-store';
    return { ticket: result.ticket ?? null };
  })

  /**
   * Product images are deliberately **not** served here.
   *
   * The snapshot carries `has_image` but no bytes, and pulling images over the
   * relay would put the shop's upstream bandwidth in front of every customer's
   * page load. The page handles a failed image by hiding it and showing its
   * coloured initials instead, so a 404 degrades rather than breaks. If images
   * matter for a shop, upload them to the hosted server separately.
   */
  .get('/api/guest/:code/products/:productId/image', ({ set }) => {
    set.status = 404;
    return { error: 'Images are not served by the hosted server' };
  })

  /**
   * Places an order.
   *
   * Does not answer until the till has acknowledged it or the queue window has
   * passed. The phone shows "sending" for exactly that long: a customer is
   * never told the kitchen has their order before the kitchen does.
   */
  .post('/api/guest/:code/order', async ({ params, body, set, server, request }) => {
    const ip = clientIp(server, request);
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

  // ── Where the shop owner signs in ─────────────────────────────────────────

  /** Reads our own session cookie. Not a parser for anybody else's cookies. */
  .derive(({ request }) => {
    const header = request.headers.get('cookie') ?? '';
    const match = /(?:^|;\s*)flo_admin=([^;]+)/.exec(header);
    return { adminToken: match ? decodeURIComponent(match[1]) : undefined };
  })

  .get('/admin', ({ adminToken, set }) => {
    set.headers['content-type'] = 'text/html; charset=utf-8';
    const session = sessionFor(adminToken);
    return session ? adminPage(session.name, isPosConnected()) : pairPage();
  })

  .post('/admin/pair', async ({ body, set, server, request }) => {
    const ip = clientIp(server, request);
    set.headers['content-type'] = 'text/html; charset=utf-8';

    if (overLimit('pair', ip)) {
      set.status = 429;
      return pairPage('Too many attempts. Please wait a few minutes.');
    }
    if (!isPosConnected()) {
      set.status = 503;
      return pairPage('Your till is offline, so the code cannot be checked right now.');
    }

    const result = await pair(String((body as any).code ?? ''));
    if ('error' in result) {
      set.status = result.error === 'pos_unreachable' ? 503 : 401;
      return pairPage(PAIR_ERRORS[result.error] ?? 'That code was not accepted.');
    }

    // HttpOnly so page scripts cannot read it, SameSite=Lax so a form on another
    // site cannot act as the owner. Secure unless this is a local dry run.
    const secure = PUBLIC_URL.startsWith('https://') ? ' Secure;' : '';
    set.headers['set-cookie'] =
      `flo_admin=${encodeURIComponent(result.token)}; Path=/admin; HttpOnly;${secure} SameSite=Lax; Max-Age=${Math.floor(result.expiresInMs / 1000)}`;
    set.status = 303;
    set.headers['location'] = '/admin';
    return '';
  }, {
    body: t.Object({ code: t.String() }),
  })

  .post('/admin/logout', ({ adminToken, set }) => {
    signOut(adminToken);
    set.headers['set-cookie'] = 'flo_admin=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0';
    set.status = 303;
    set.headers['location'] = '/admin';
    return '';
  })

  /**
   * The printable codes.
   *
   * Asked of the till on every call and never stored here. The snapshot holds
   * only hashes precisely so that a breach of this box yields no working QR;
   * caching this response would hand over what the hashing was protecting.
   */
  .get('/admin/tables', async ({ adminToken, set }) => {
    if (!sessionFor(adminToken)) { set.status = 401; return { error: 'not_paired' }; }
    if (!isPosConnected()) { set.status = 503; return { error: 'pos_offline' }; }

    const tables = await tableCodes(PUBLIC_URL);
    if ('error' in tables) { set.status = tables.error === 'session_expired' ? 401 : 503; return tables; }

    // Codes are live credentials for a table. Keep them out of every cache
    // between here and the owner's browser.
    set.headers['cache-control'] = 'no-store';
    return { tables };
  })

  /** The same codes as a printable sheet of QR images. */
  .get('/admin/print', async ({ adminToken, set }) => {
    set.headers['content-type'] = 'text/html; charset=utf-8';
    if (!sessionFor(adminToken)) { set.status = 303; set.headers['location'] = '/admin'; return ''; }

    const tables = await tableCodes(PUBLIC_URL);
    if ('error' in tables) {
      set.status = tables.error === 'session_expired' ? 401 : 503;
      return page503(tables.error);
    }

    set.headers['cache-control'] = 'no-store';
    return printPage(tables);
  })

  .get('/api/health', () => ({ status: 'ok', pos_connected: isPosConnected(), shop: shopId }))

  // ── The page the QR codes actually point at ───────────────────────────────
  //
  // The printed QR is `${PUBLIC_URL}/guest-order/?t=<code>`, so something has to
  // serve that path. It is FloCafe's own exported page, copied here at deploy
  // time: the same build the shop's WiFi serves, so the two entrances cannot
  // drift apart visually or behaviourally. See ../README.md for the copy step.
  //
  // Served as static files with no templating. The page reads `?t=` itself and
  // calls /api/guest/* — nothing about the shop is baked into the HTML, which is
  // why one copy can serve every shop this server hosts.
  .get('/guest-order', ({ redirect }) => redirect('/guest-order/', 301))
  .get('/guest-order/*', async ({ path, set }) => {
    // Only ever two files, named explicitly. A path from the URL must never
    // reach the filesystem — `..` in a request should not be able to read
    // /etc/passwd, and an allowlist cannot be talked out of that.
    const file = path.replace(/^\/guest-order\/?/, '') || 'index.html';
    const allowed = file === 'index.html' || file === '';
    if (!allowed) { set.status = 404; return 'Not found'; }

    const asset = Bun.file(`${GUEST_PAGE_DIR}/index.html`);
    if (!(await asset.exists())) {
      set.status = 503;
      set.headers['content-type'] = 'text/html; charset=utf-8';
      return '<!doctype html><meta charset="utf-8"><p>This server has no guest page installed yet.</p>';
    }
    set.headers['content-type'] = 'text/html; charset=utf-8';
    return asset;
  })

  // The exported page loads its JavaScript and CSS from /_next/*.
  .get('/_next/*', async ({ path, set }) => {
    const resolved = resolveStatic(path);
    if (!resolved) { set.status = 404; return 'Not found'; }
    const asset = Bun.file(resolved);
    if (!(await asset.exists())) { set.status = 404; return 'Not found'; }
    // Next names these files by content hash, so they can be cached hard.
    set.headers['cache-control'] = 'public, max-age=31536000, immutable';
    return asset;
  })

  .listen(PORT);

console.log(`[relay] listening on :${PORT}`);

export type App = typeof app;
