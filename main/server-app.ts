import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import expressRateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { WebSocket, WebSocketServer } from 'ws';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'node:crypto';
import { closeServerResources, createShutdownCancellationError, getHttpRequestSignal, installHttpShutdownTracking, trackHttpRequestWork } from './shutdown';
import { databaseMaintenanceMiddleware, findUserByLoginIdentifier, getDatabase, getUserTableIds, isServerAppEnabled, isTableAllowedForUser, recordStaffWorkEvent } from './db';
import { getJWTSecret } from './routes/auth';
import { authRateLimit, staticRouteRateLimit, corsOptions, isTokenRevoked, isTokenStale, rateLimit, revokeToken } from './middleware/security';
import { getServerPort } from './server';
import { getDefaultServerAppPort, getServerAppPort as getActiveServerAppPort, setServerAppPort } from './server-app-state';
import { API_JSON_BODY_LIMIT } from './http-limits';
import { buildCspHeader } from './csp';
import { resolveContainedPath } from './lib/path-containment';
import { ROLE_ACCESS } from '../shared/role-permissions';
import { onGuestOrder, onOrderItemStatus, type GuestOrderEvent, type OrderItemStatusEvent } from './services/server-app-events';
import { RegionalNotConfiguredError, resolveRegionalSnapshot } from './countries';

let serverApp: http.Server | null = null;
let serverAppWss: WebSocketServer | null = null;
let unsubscribeGuestOrder: (() => void) | null = null;
let unsubscribeItemStatus: (() => void) | null = null;
let stopPromise: Promise<void> | null = null;
let startReject: ((error: Error) => void) | null = null;
let stopping = false;
const SERVER_APP_PORT = getDefaultServerAppPort();
const SERVER_APP_ALLOWED_ROLES = new Set(ROLE_ACCESS.serverApp);

type ServerAppUser = {
  userId: string;
  email?: string;
  role: string;
  iat?: number;
};

function normalizeEmail(email: unknown): string {
  return String(email || '').trim().toLowerCase();
}

export function isServerAppRunning(): boolean {
  return serverApp !== null;
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

function rewriteNextExportPath(reqPath: string): string {
  const nextIndex = reqPath.indexOf('__next.');
  if (nextIndex === -1) return reqPath;

  const prefix = reqPath.substring(0, nextIndex + '__next.'.length);
  const rest = reqPath.substring(nextIndex + '__next.'.length);
  const lastDotIndex = rest.lastIndexOf('.');
  if (lastDotIndex === -1) return reqPath;

  return prefix + rest.substring(0, lastDotIndex).replace(/\./g, '/') + rest.substring(lastDotIndex);
}

function requireServerAppAuth(req: Request, res: Response, next: NextFunction) {
  if (!isServerAppEnabled()) return res.status(404).json({ error: 'Not found' });

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  if (isTokenRevoked(token)) return res.status(401).json({ error: 'Invalid token' });

  try {
    const decoded = jwt.verify(token, getJWTSecret()) as any;
    const db = getDatabase();
    const user = db.prepare('SELECT id, email, role, tokens_valid_after FROM users WHERE id = ? AND is_active = 1').get(decoded.userId) as any;
    if (!user || isTokenStale(decoded.iat, user.tokens_valid_after)) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (!SERVER_APP_ALLOWED_ROLES.has(user.role)) {
      return res.status(403).json({ error: 'Access denied. Only server, manager, or owner accounts allowed.' });
    }

    (req as any).user = {
      userId: user.id,
      email: user.email,
      role: user.role,
      iat: decoded.iat,
    } satisfies ServerAppUser;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function forwardToMainApi(
  req: Request,
  res: Response,
  targetPath: string,
  transform?: (body: any) => any,
) {
  return trackHttpRequestWork(req, forwardToMainApiImpl(req, res, targetPath, transform));
}

async function forwardToMainApiImpl(
  req: Request,
  res: Response,
  targetPath: string,
  transform?: (body: any) => any,
) {
  const target = new URL(`/api${targetPath}`, `http://127.0.0.1:${getServerPort()}`);
  for (const [key, value] of Object.entries(req.query)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => target.searchParams.append(key, String(entry)));
    } else if (value !== undefined) {
      target.searchParams.set(key, String(value));
    }
  }

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
        ...(req.get('Idempotency-Key') ? { 'Idempotency-Key': req.get('Idempotency-Key')! } : {}),
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
      signal: getHttpRequestSignal(req),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type') || 'application/json';
    if (transform && upstream.ok && contentType.includes('application/json')) {
      try {
        res.json(transform(JSON.parse(text)));
        return;
      } catch {
        // Fall through and pass the upstream payload through untouched.
      }
    }
    res.type(contentType);
    res.send(text);
  } catch (error: any) {
    if (getHttpRequestSignal(req)?.aborted) {
      if (!res.headersSent) res.status(503).end();
      else if (!res.writableEnded) res.destroy();
      return;
    }
    console.error('[Server App] Main API forward failed:', error);
    res.status(502).json({ error: 'Could not reach the local POS API' });
  }
}

/**
 * Tables the request's user is restricted to, or null when unrestricted.
 * Only servers are scoped, and a server with no assignment rows keeps every table.
 */
function allowedTableIdsFor(user: ServerAppUser | undefined): Set<string> | null {
  if (!user || user.role !== 'server') return null;
  const assigned = getUserTableIds(getDatabase(), user.userId);
  if (assigned === null) return new Set();
  if (assigned.length === 0) return null;
  return new Set(assigned);
}

function orderTableId(orderId: unknown): string | null {
  const row = getDatabase()
    .prepare('SELECT table_id FROM orders WHERE id = ?')
    .get(orderId) as { table_id: string | null } | undefined;
  return row?.table_id ?? null;
}

function billTableId(billId: unknown): string | null {
  const row = getDatabase()
    .prepare('SELECT o.table_id AS table_id FROM bills b JOIN orders o ON o.id = b.order_id WHERE b.id = ?')
    .get(billId) as { table_id: string | null } | undefined;
  return row?.table_id ?? null;
}

function requireTablePermission(resolveTableId: (req: Request) => string | null) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user as ServerAppUser;
    if (user?.role !== 'server') return next();
    let tableId: string | null;
    try {
      tableId = resolveTableId(req);
    } catch {
      return res.status(500).json({ error: 'Could not check table permissions' });
    }
    if (!isTableAllowedForUser(getDatabase(), user.userId, user.role, tableId)) {
      return res.status(403).json({ error: 'You are not assigned to this table.' });
    }
    next();
  };
}

const MAX_SERVER_APP_SOCKETS = 50;
const SOCKET_HEARTBEAT_MS = 30_000;

/** Authenticates a socket the same way `requireServerAppAuth` gates HTTP requests. */
function authenticateSocketToken(token: string): ServerAppUser | null {
  if (!token || isTokenRevoked(token)) return null;
  try {
    const decoded = jwt.verify(token, getJWTSecret()) as any;
    const user = getDatabase()
      .prepare('SELECT id, email, role, tokens_valid_after FROM users WHERE id = ? AND is_active = 1')
      .get(decoded.userId) as any;
    if (!user || isTokenStale(decoded.iat, user.tokens_valid_after)) return null;
    if (!SERVER_APP_ALLOWED_ROLES.has(user.role)) return null;
    return { userId: user.id, email: user.email, role: user.role, iat: decoded.iat };
  } catch {
    return null;
  }
}

/**
 * Pushes kitchen status changes to the waiter covering that table, so a "ready"
 * item lands on their device immediately instead of on the next poll.
 */
function setupServerAppWebSocket(listeningServer: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });
  serverAppWss = wss;
  const sockets = new Map<WebSocket, ServerAppUser>();
  const alive = new WeakSet<WebSocket>();

  listeningServer.on('upgrade', (request, socket, head) => {
    const [pathname, rawQuery] = (request.url || '').split('?');
    if (pathname !== '/server-app') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!isServerAppEnabled() || sockets.size >= MAX_SERVER_APP_SOCKETS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    // The browser WebSocket API cannot set headers, so the token rides in the query string.
    const user = authenticateSocketToken(new URLSearchParams(rawQuery || '').get('token') || '');
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.set(ws, user);
      alive.add(ws);
      ws.on('pong', () => alive.add(ws));
      ws.on('close', () => sockets.delete(ws));
      ws.on('error', () => sockets.delete(ws));
      ws.send(JSON.stringify({ type: 'connected' }));
    });
  });

  const heartbeat = setInterval(() => {
    sockets.forEach((_user, ws) => {
      if (!alive.has(ws)) {
        ws.terminate();
        sockets.delete(ws);
        return;
      }
      alive.delete(ws);
      try { ws.ping(); } catch { /* terminated on the next sweep */ }
    });
  }, SOCKET_HEARTBEAT_MS);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));

  unsubscribeGuestOrder = onGuestOrder((event: GuestOrderEvent) => {
    if (sockets.size === 0 || !event.tableId) return;
    for (const [ws, user] of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      // Scoped the same way ready alerts are: a waiter is told about their own
      // tables, not the whole floor. Re-read per event so a reassignment takes
      // effect without a reconnect.
      const allowed = allowedTableIdsFor(user);
      if (allowed && !allowed.has(String(event.tableId))) continue;
      try {
        ws.send(JSON.stringify({
          type: 'guest_order',
          order_id: event.orderId,
          order_number: event.orderNumber,
          table_id: event.tableId,
          table_name: event.tableName,
          item_count: event.itemCount,
          appended: event.appended,
        }));
      } catch (error) {
        console.error('[Server App] Guest order push failed:', error);
      }
    }
  });

  unsubscribeItemStatus = onOrderItemStatus((event: OrderItemStatusEvent) => {
    if (sockets.size === 0 || !event.tableId) return;
    for (const [ws, user] of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      // Re-read the assignment per event so a reassigned table takes effect without a reconnect.
      const allowed = allowedTableIdsFor(user);
      if (allowed && !allowed.has(String(event.tableId))) continue;
      try {
        ws.send(JSON.stringify({
          type: 'item_status',
          item_id: event.itemId,
          product_name: event.productName,
          order_id: event.orderId,
          table_id: event.tableId,
          status: event.status,
        }));
      } catch (error) {
        console.error('[Server App] Socket push failed:', error);
      }
    }
  });
}

// Binary-safe forward: the JSON forwarder above decodes bodies as text, which corrupts image bytes.
async function forwardBinaryToMainApi(req: Request, res: Response, targetPath: string) {
  return trackHttpRequestWork(req, forwardBinaryToMainApiImpl(req, res, targetPath));
}

async function forwardBinaryToMainApiImpl(req: Request, res: Response, targetPath: string) {
  const target = new URL(`/api${targetPath}`, `http://127.0.0.1:${getServerPort()}`);
  try {
    const upstream = await fetch(target, {
      method: 'GET',
      headers: {
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
        ...(req.headers['if-none-match'] ? { 'If-None-Match': String(req.headers['if-none-match']) } : {}),
      },
      signal: getHttpRequestSignal(req),
    });
    res.status(upstream.status);
    for (const header of ['content-type', 'cache-control', 'etag']) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    if (upstream.status === 304) {
      res.end();
      return;
    }
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error: any) {
    if (getHttpRequestSignal(req)?.aborted) {
      if (!res.headersSent) res.status(503).end();
      else if (!res.writableEnded) res.destroy();
      return;
    }
    console.error('[Server App] Main API binary forward failed:', error);
    res.status(502).json({ error: 'Could not reach the local POS API' });
  }
}

export function startServerApp(): Promise<void> {
  stopPromise = null;
  stopping = false;
  return new Promise((resolve, reject) => {
    startReject = reject;
    const app: Express = express();

    app.use(cors(corsOptions));
    app.use((req: Request, res: Response, next: NextFunction) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', buildCspHeader(req));
      next();
    });
    app.use(express.json({ limit: API_JSON_BODY_LIMIT }));
    app.use((error: any, _req: Request, res: Response, next: NextFunction) => {
      if (error?.type === 'entity.too.large') {
        res.status(413).json({
          error: `Request body is too large. JSON imports are limited to ${API_JSON_BODY_LIMIT}; use Backup/Restore for full database migration.`,
        });
        return;
      }
      next(error);
    });
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (req.body === undefined) req.body = {};
      next();
    });
    app.use(databaseMaintenanceMiddleware);
    app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 150 }));

    app.get('/api/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        service: 'Flo Server App',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
      });
    });

    app.get('/api/server-app/info', (_req: Request, res: Response) => {
      if (!isServerAppEnabled()) return res.status(404).json({ error: 'Not found' });
      const rows = getDatabase().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
      const settings: Record<string, string> = {};
      for (const row of rows) settings[row.key] = row.value;
      let snapshot;
      try {
        snapshot = resolveRegionalSnapshot(settings);
      } catch (error) {
        if (error instanceof RegionalNotConfiguredError) return res.status(409).json({ error: 'regional_not_configured' });
        throw error;
      }
      res.json({
        language: settings.language || null,
        country: snapshot.country,
        currency: snapshot.currency,
        currency_symbol: snapshot.currencySymbol,
        currency_position: snapshot.currencyPosition,
        currency_fraction_digits: snapshot.currencyFractionDigits,
        kds_enabled: settings.kds_enabled !== 'false',
      });
    });

    app.post('/api/auth/login', authRateLimit(), (req: Request, res: Response) => {
      if (!isServerAppEnabled()) return res.status(404).json({ error: 'Not found' });
      try {
        const email = normalizeEmail(req.body?.email);
        const { password, remember_me } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const db = getDatabase();
        const bcrypt = require('bcryptjs');
        const user = findUserByLoginIdentifier(email) as any;
        let passwordMatches = false;
        if (user) {
          try {
            passwordMatches = bcrypt.compareSync(password, user.password);
          } catch {
            passwordMatches = false;
          }
        }
        if (!user || !passwordMatches) {
          return res.status(401).json({ error: 'Invalid credentials' });
        }
        if (!SERVER_APP_ALLOWED_ROLES.has(user.role)) {
          return res.status(403).json({ error: 'Access denied. Only server, manager, or owner accounts allowed.' });
        }

        const token = jwt.sign(
          { userId: user.id, email: user.email, role: user.role, jti: randomUUID() },
          getJWTSecret(),
          { expiresIn: remember_me ? '10d' : '24h' },
        );

        recordStaffWorkEvent(user.id, 'login');

        res.json({
          access_token: token,
          user: { id: user.id, name: user.name, email: user.email, role: user.role },
        });
      } catch (error: any) {
        console.error('[Server App] Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    app.get('/api/auth/me', requireServerAppAuth, (req: Request, res: Response) => {
      const user = (req as any).user as ServerAppUser;
      const row = getDatabase().prepare('SELECT id, name, email, role FROM users WHERE id = ? AND is_active = 1').get(user.userId) as any;
      if (!row) return res.status(401).json({ error: 'Invalid token' });
      res.json({ user: row });
    });

    app.post('/api/auth/logout', requireServerAppAuth, (req: Request, res: Response) => {
      const token = req.headers.authorization?.split(' ')[1];
      if (token) revokeToken(token);
      recordStaffWorkEvent(((req as any).user as ServerAppUser).userId, 'logout');
      res.json({ success: true });
    });

    app.get('/api/categories', requireServerAppAuth, (req, res) => forwardToMainApi(req, res, '/categories'));
    app.get('/api/products', requireServerAppAuth, (req, res) => forwardToMainApi(req, res, '/products'));
    // Unauthenticated so <img> tags work, mirroring the main API's own product-image exemption.
    app.get('/api/products/:id/image', (req, res) =>
      forwardBinaryToMainApi(req, res, `/products/${encodeURIComponent(String(req.params.id))}/image`));
    app.get('/api/tables', requireServerAppAuth, (req, res) => forwardToMainApi(req, res, '/tables', (body) => {
      const user = (req as any).user as ServerAppUser;
      const allowed = allowedTableIdsFor(user);
      if (!allowed || !Array.isArray(body?.tables)) return body;
      return { ...body, tables: body.tables.filter((table: any) => allowed.has(String(table?.id))) };
    }));
    app.get('/api/orders', requireServerAppAuth, (req, res) => forwardToMainApi(req, res, '/orders'));
    app.post('/api/orders', requireServerAppAuth, requireTablePermission((req) => req.body?.table_id ?? null),
      (req, res) => forwardToMainApi(req, res, '/orders'));
    app.post('/api/orders/:id/items', requireServerAppAuth, requireTablePermission((req) => orderTableId(req.params.id)),
      (req, res) => forwardToMainApi(req, res, `/orders/${encodeURIComponent(String(req.params.id))}/items`));
    // Editing an open ticket happens line by line: tag one as takeaway, or pull it.
    // The main API keeps its own rules (only a line the kitchen has not started).
    app.patch('/api/orders/:id/items/:itemId/notes', requireServerAppAuth, requireTablePermission((req) => orderTableId(req.params.id)),
      (req, res) => forwardToMainApi(
        req,
        res,
        `/orders/${encodeURIComponent(String(req.params.id))}/items/${encodeURIComponent(String(req.params.itemId))}/notes`,
      ));
    app.patch('/api/orders/:id/items/:itemId/cancel', requireServerAppAuth, requireTablePermission((req) => orderTableId(req.params.id)),
      (req, res) => forwardToMainApi(
        req,
        res,
        `/orders/${encodeURIComponent(String(req.params.id))}/items/${encodeURIComponent(String(req.params.itemId))}/cancel`,
      ));
    app.get('/api/customers-search', requireServerAppAuth, (req, res) => forwardToMainApi(req, res, '/customers-search'));
    app.get('/api/crm/lookup', requireServerAppAuth, (req, res) => forwardToMainApi(req, res, '/crm/lookup'));
    const customerWriteRateLimit = expressRateLimit({
      windowMs: 60 * 1000,
      limit: 150,
      standardHeaders: true,
      legacyHeaders: false,
    });
    app.post('/api/customers', customerWriteRateLimit, requireServerAppAuth, (req, res) => forwardToMainApi(req, res, '/customers'));
    const printForwardRateLimit = expressRateLimit({
      windowMs: 60 * 1000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false,
    });
    // Billing at the table. Table scoping applies here too: a scoped server can only
    // bill orders sitting on a table they are assigned to.
    app.get('/api/payment-methods', requireServerAppAuth, (req, res) => forwardToMainApi(req, res, '/payment-methods'));
    app.post('/api/bills/generate', requireServerAppAuth, requireTablePermission((req) => orderTableId(req.body?.order_id)),
      (req, res) => forwardToMainApi(req, res, '/bills/generate'));
    app.get('/api/bills/order/:orderId', requireServerAppAuth, requireTablePermission((req) => orderTableId(req.params.orderId)),
      (req, res) => forwardToMainApi(req, res, `/bills/order/${encodeURIComponent(String(req.params.orderId))}`));
    const billPaymentRateLimit = expressRateLimit({
      windowMs: 60 * 1000,
      limit: 60,
      standardHeaders: true,
      legacyHeaders: false,
    });
    app.post('/api/bills/:id/payments', billPaymentRateLimit, requireServerAppAuth, requireTablePermission((req) => billTableId(req.params.id)),
      (req, res) => forwardToMainApi(req, res, `/bills/${encodeURIComponent(String(req.params.id))}/payments`));

    app.post('/api/printers/print-kot', printForwardRateLimit, requireServerAppAuth, (req, res) => forwardToMainApi(req, res, '/printers/print-kot'));
    app.post('/api/printers/print-bill', printForwardRateLimit, requireServerAppAuth, (req, res) => forwardToMainApi(req, res, '/printers/print-bill'));

    const staticDir = getStaticDir();
    if (staticDir) {
      console.log(`[Server App] Serving static files from: ${staticDir}`);
      if (process.platform === 'win32') {
        app.use(staticRouteRateLimit(), (req: Request, _res: Response, next: NextFunction) => {
          if (req.path.includes('__next.')) {
            const rewritten = rewriteNextExportPath(req.path);
            if (rewritten !== req.path) {
              const fullPath = resolveContainedPath(staticDir, rewritten);
              if (fullPath && fs.existsSync(fullPath)) {
                req.url = rewritten;
              }
            }
          }
          next();
        });
      }
      app.use(express.static(staticDir, { dotfiles: 'allow', index: false }));
      app.get('/', (_req: Request, res: Response) => res.redirect('/server-standalone'));
      app.get('/*splat', staticRouteRateLimit(), (req: Request, res: Response) => {
        const routePath = resolveContainedPath(staticDir, `.${req.path}`, 'index.html');
        if (routePath && fs.existsSync(routePath)) {
          res.sendFile(routePath, { dotfiles: 'allow' });
        } else {
          res.sendFile(path.join(staticDir, 'server-standalone', 'index.html'), { dotfiles: 'allow' });
        }
      });
    } else {
      console.warn('[Server App] Static build not found. Run `npm run build:frontend` first.');
      app.get('/', (_req: Request, res: Response) => {
        res.send(`
          <html><body style="font-family:sans-serif;padding:2rem">
            <h2>Flo Server App - Build not found</h2>
            <p>Run <code>npm run build:frontend</code> then restart the app.</p>
          </body></html>
        `);
      });
    }

    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      console.error('[Server App] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });

    const baseServerAppPort = parseInt(process.env.SERVER_APP_PORT || String(SERVER_APP_PORT), 10);
    let currentPort = baseServerAppPort;
    let attempts = 0;
    const listeningServer = http.createServer(app);
    serverApp = listeningServer;
    installHttpShutdownTracking(listeningServer);
    setupServerAppWebSocket(listeningServer);

    const tryListen = () => {
      const attemptedPort = currentPort;
      const onListening = () => {
        if (stopping) {
          try { listeningServer.close(); } catch { return; }
          return;
        }
        startReject = null;
        listeningServer.off('error', onError);
        setServerAppPort(attemptedPort);
        console.log(`[Server App] HTTP server running on http://localhost:${getActiveServerAppPort()}`);
        resolve();
      };
      const onError = (err: NodeJS.ErrnoException) => {
        if (stopping) return;
        listeningServer.off('listening', onListening);
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          attempts++;
          if (attempts >= 10) {
            const errorMsg = `[Server App] Failed to bind to any port after 10 attempts starting from ${baseServerAppPort}`;
            console.error(errorMsg);
            reject(new Error(errorMsg));
            return;
          }
          currentPort++;
          console.log(`[Server App] Port ${attemptedPort} in use (${err.code}), trying ${currentPort}`);
          tryListen();
          return;
        }
        reject(err);
      };

      listeningServer.once('listening', onListening);
      listeningServer.once('error', onError);
      listeningServer.listen(attemptedPort, '0.0.0.0');
    };

    tryListen();
  });
}

export function stopServerApp(): Promise<void> {
  if (stopPromise) return stopPromise;

  stopping = true;
  const rejectStart = startReject;
  startReject = null;
  rejectStart?.(createShutdownCancellationError('Server App'));
  const serverToClose = serverApp;
  const wssToClose = serverAppWss;
  // Mark the server unavailable immediately while active requests drain.
  serverApp = null;
  serverAppWss = null;
  unsubscribeItemStatus?.();
  unsubscribeItemStatus = null;
  unsubscribeGuestOrder?.();
  unsubscribeGuestOrder = null;

  stopPromise = closeServerResources(serverToClose, wssToClose, 'Server App')
    .then(() => {
      console.log('[Server App] HTTP server stopped');
    });
  return stopPromise;
}

export function getServerAppPort(): number {
  return getActiveServerAppPort();
}
