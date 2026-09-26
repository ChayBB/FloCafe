/**
 * Guest ordering server — the only surface a customer's phone ever touches.
 *
 * Runs on its own port so it can be published to the internet (via the merchant's
 * VPS) without exposing the staff Server App, the POS API or anything that can
 * take money. Nothing here authenticates a person: holding a table's guest token
 * authorises ordering, and only for that one table.
 */
import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import expressRateLimit from 'express-rate-limit';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { closeServerResources, createShutdownCancellationError, getHttpRequestSignal, installHttpShutdownTracking, trackHttpRequestWork } from './shutdown';
import { databaseMaintenanceMiddleware, getDatabase, getSettingValue, isGuestOrderingEnabled } from './db';
import { staticRouteRateLimit } from './middleware/security';
import { getServerPort } from './server';
import { getDefaultGuestPort, getGuestPort as getActiveGuestPort, setGuestPort } from './guest-server-state';
import { API_JSON_BODY_LIMIT } from './http-limits';
import { resolveContainedPath } from './lib/path-containment';
import { GUEST_CHANNEL_HEADER, getGuestChannelSecret } from './services/guest-channel';
import { isRoundTokenCurrent, isTokenForThisStore, newRoundToken, parseGuestToken } from './services/guest-tokens';
import { publicMenu } from './services/public-menu';

let guestServer: http.Server | null = null;
let stopPromise: Promise<void> | null = null;
let startReject: ((error: Error) => void) | null = null;
let stopping = false;
const GUEST_PORT = getDefaultGuestPort();

interface GuestTable {
  id: string;
  number: string;
  guest_round: number;
}

// Issued when the code is scanned and required on everything that reads a
// ticket or sends an order. It travels in a header, not the URL, so it does not
// end up in a screenshot or a referrer log.
const ROUND_HEADER = 'x-flo-round';

/**
 * Gate for anything tied to one sitting. The scanned code still identifies the
 * table, but it is no longer enough on its own: settling the bill moves the
 * table to a new round and the previous party's tokens stop verifying, while
 * the printed sticker keeps working for whoever sits down next.
 */
function requireCurrentRound(req: Request, res: Response, next: NextFunction) {
  const table = (req as any).guestTable as GuestTable;
  if (!isRoundTokenCurrent(req.get(ROUND_HEADER), table.id, table.guest_round)) {
    return res.status(409).json({ error: 'This table has been settled. Please scan the code again.' });
  }
  next();
}

function getStaticDir(): string | null {
  const candidates = [
    path.join(__dirname, '../../frontend/out'),
    path.join(process.resourcesPath || '', 'frontend-out'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

/**
 * Resolves a guest token to its table, or null when the token is unknown/disabled.
 *
 * A code may carry this shop's store reference in front of the secret. That prefix
 * is checked before the lookup, so another shop's code is refused here rather than
 * being allowed to miss quietly against our own table rows.
 */
function tableForToken(token: unknown): GuestTable | null {
  const parsed = parseGuestToken(token);
  if (!parsed || !isTokenForThisStore(parsed.storeRef)) return null;
  try {
    const row = getDatabase()
      .prepare('SELECT id, number, guest_round FROM tables WHERE guest_token = ? AND is_active = 1')
      .get(parsed.secret) as GuestTable | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function requireGuestTable(req: Request, res: Response, next: NextFunction) {
  if (!isGuestOrderingEnabled()) return res.status(404).json({ error: 'Not found' });
  const table = tableForToken(req.params.token);
  if (!table) return res.status(404).json({ error: 'This QR code is no longer valid. Ask our staff for help.' });
  (req as any).guestTable = table;
  next();
}

/**
 * Calls the POS API as the merchant's own service. Guest requests never carry a
 * user token, so the payload is built here and the table is taken from the token,
 * never from the request body.
 */
async function callPosApi(req: Request, method: 'GET' | 'POST', targetPath: string, body?: unknown) {
  const target = new URL(`/api${targetPath}`, `http://127.0.0.1:${getServerPort()}`);
  const response = await fetch(target, {
    method,
    headers: {
      'Content-Type': 'application/json',
      [GUEST_CHANNEL_HEADER]: getGuestChannelSecret(),
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    signal: getHttpRequestSignal(req),
  });
  const text = await response.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* upstream error page */ }
  return { status: response.status, body: parsed };
}

/** The table's open ticket, reduced to what the guest ordered and how it is going. */
function tableTicket(tableId: string) {
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
  `).all(order.id) as any[];
  return { order_number: order.order_number, items };
}

export function startGuestServer(): Promise<void> {
  stopPromise = null;
  stopping = false;
  return new Promise((resolve, reject) => {
    startReject = reject;
    const app: Express = express();

    // The public origin is the merchant's own VPS; anything else is refused.
    app.use(cors({
      origin: (origin, callback) => {
        const allowed = (getSettingValue('guest_public_url') || '').trim();
        if (!origin || !allowed) return callback(null, true);
        try {
          callback(null, new URL(allowed).origin === new URL(origin).origin);
        } catch {
          callback(null, false);
        }
      },
    }));
    app.use((_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      // No staff surface is reachable from here, so the policy can stay tight.
      res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
      ].join('; '));
      next();
    });
    app.use(express.json({ limit: API_JSON_BODY_LIMIT }));
    app.use(databaseMaintenanceMiddleware);

    const guestReadLimit = expressRateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
    const guestOrderLimit = expressRateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

    app.get('/api/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', service: 'Flo Guest Ordering', enabled: isGuestOrderingEnabled() });
    });

    app.get('/api/guest/:token/session', guestReadLimit, requireGuestTable, (req: Request, res: Response) => {
      const table = (req as any).guestTable as GuestTable;
      const menu = publicMenu();
      res.json({
        table: { name: table.number },
        round_token: newRoundToken(table.id, table.guest_round),
        currency: getSettingValue('currency') || 'THB',
        country: getSettingValue('country') || 'TH',
        language: getSettingValue('language') || 'en',
        ticket: tableTicket(table.id),
        ...menu,
      });
    });

    app.get('/api/guest/:token/ticket', guestReadLimit, requireGuestTable, requireCurrentRound, (req: Request, res: Response) => {
      const table = (req as any).guestTable as GuestTable;
      res.json({ ticket: tableTicket(table.id) });
    });

    // Product images are already served unauthenticated by the POS API; this
    // proxy keeps the guest phone talking only to the guest port.
    app.get('/api/guest/:token/products/:productId/image', guestReadLimit, requireGuestTable, (req: Request, res: Response) => {
      void trackHttpRequestWork(req, (async () => {
        try {
          const target = new URL(
            `/api/products/${encodeURIComponent(String(req.params.productId))}/image`,
            `http://127.0.0.1:${getServerPort()}`,
          );
          const upstream = await fetch(target, { signal: getHttpRequestSignal(req) });
          res.status(upstream.status);
          for (const header of ['content-type', 'cache-control', 'etag']) {
            const value = upstream.headers.get(header);
            if (value) res.setHeader(header, value);
          }
          res.send(Buffer.from(await upstream.arrayBuffer()));
        } catch {
          if (!res.headersSent) res.status(502).end();
        }
      })());
    });

    app.post('/api/guest/:token/order', guestOrderLimit, requireGuestTable, requireCurrentRound, (req: Request, res: Response) => {
      void trackHttpRequestWork(req, (async () => {
        const table = (req as any).guestTable as GuestTable;
        const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
        if (rawItems.length === 0) return res.status(400).json({ error: 'No items to send' });
        if (rawItems.length > 40) return res.status(400).json({ error: 'Too many items in one order' });

        const db = getDatabase();
        const items: { product_id: string; quantity: number; special_instructions?: string }[] = [];
        for (const raw of rawItems) {
          const productId = String(raw?.product_id || '');
          const quantity = Number(raw?.quantity);
          if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
            return res.status(400).json({ error: 'Invalid item' });
          }
          // Only an active, sellable product: a guessed id must not become an order line.
          const sellable = db.prepare(`
            SELECT 1 FROM products p LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.id = ? AND p.deleted_at IS NULL AND p.is_active = 1 AND (c.id IS NULL OR c.is_active = 1)
          `).get(productId);
          if (!sellable) return res.status(400).json({ error: 'Item is no longer available' });
          const note = typeof raw?.special_instructions === 'string'
            ? raw.special_instructions.trim().slice(0, 200)
            : '';
          items.push({ product_id: productId, quantity, ...(note ? { special_instructions: note } : {}) });
        }

        try {
          const open = db.prepare(`
            SELECT id FROM orders
            WHERE table_id = ? AND status NOT IN ('completed', 'cancelled')
            ORDER BY created_at DESC LIMIT 1
          `).get(table.id) as { id: number } | undefined;

          const result = open
            ? await callPosApi(req, 'POST', `/orders/${open.id}/items`, { items })
            : await callPosApi(req, 'POST', '/orders', { table_id: table.id, type: 'dine_in', items });

          if (result.status >= 400) {
            console.warn('[Guest] Order rejected by POS API:', result.status, result.body?.error);
            return res.status(502).json({ error: 'Could not send the order. Please ask our staff.' });
          }
          res.status(201).json({ ticket: tableTicket(table.id) });
        } catch (error) {
          if (getHttpRequestSignal(req)?.aborted) {
            if (!res.headersSent) res.status(503).end();
            return;
          }
          console.error('[Guest] Order failed:', error);
          res.status(502).json({ error: 'Could not send the order. Please ask our staff.' });
        }
      })());
    });

    // Any other API path is simply absent here; answer plainly instead of letting
    // the page fallback below return HTML for it.
    app.use('/api', (_req: Request, res: Response) => {
      res.status(404).json({ error: 'Not found' });
    });

    const staticDir = getStaticDir();
    if (staticDir) {
      console.log(`[Guest] Serving static files from: ${staticDir}`);
      app.use(express.static(staticDir, { dotfiles: 'allow', index: false }));
      app.get('/', (_req: Request, res: Response) => res.redirect('/guest-order'));
      app.get('/*splat', staticRouteRateLimit(), (req: Request, res: Response) => {
        const routePath = resolveContainedPath(staticDir, `.${req.path}`, 'index.html');
        if (routePath && fs.existsSync(routePath)) {
          res.sendFile(routePath, { dotfiles: 'allow' });
        } else {
          res.sendFile(path.join(staticDir, 'guest-order', 'index.html'), { dotfiles: 'allow' });
        }
      });
    } else {
      console.warn('[Guest] Static build not found. Run `npm run build:frontend` first.');
    }

    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      console.error('[Guest] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });

    const basePort = parseInt(process.env.GUEST_PORT || String(GUEST_PORT), 10);
    let currentPort = basePort;
    let attempts = 0;
    const listeningServer = http.createServer(app);
    guestServer = listeningServer;
    installHttpShutdownTracking(listeningServer);

    const tryListen = () => {
      const attemptedPort = currentPort;
      const onListening = () => {
        if (stopping) {
          try { listeningServer.close(); } catch { return; }
          return;
        }
        startReject = null;
        listeningServer.off('error', onError);
        setGuestPort(attemptedPort);
        console.log(`[Guest] Guest ordering server running on http://localhost:${attemptedPort}`);
        resolve();
      };
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' && attempts < 5) {
          attempts += 1;
          currentPort += 1;
          console.warn(`[Guest] Port ${attemptedPort} in use (EADDRINUSE), trying ${currentPort}`);
          listeningServer.off('listening', onListening);
          setTimeout(tryListen, 50);
          return;
        }
        startReject = null;
        reject(error);
      };
      listeningServer.once('listening', onListening);
      listeningServer.once('error', onError);
      listeningServer.listen(attemptedPort, '0.0.0.0');
    };
    tryListen();
  });
}

export function stopGuestServer(): Promise<void> {
  if (stopPromise) return stopPromise;
  stopping = true;
  const rejectStart = startReject;
  startReject = null;
  rejectStart?.(createShutdownCancellationError('Guest server'));
  const serverToClose = guestServer;
  guestServer = null;
  stopPromise = closeServerResources(serverToClose, null, 'Guest server')
    .then(() => { console.log('[Guest] Guest ordering server stopped'); });
  return stopPromise;
}

export function getGuestPort(): number {
  return getActiveGuestPort();
}

export function isGuestServerRunning(): boolean {
  return guestServer !== null;
}
