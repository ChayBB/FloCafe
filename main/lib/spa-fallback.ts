import type { Request, RequestHandler, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { resolveContainedPath } from './path-containment';

/**
 * Serves a statically exported Next.js app, falling back to its entry document
 * for client-side routes.
 *
 * `/api/*` is excluded from that fallback. Each server serves the same export,
 * so every app's page loads on every port, but its API calls only resolve on
 * the port that owns them. Falling through to `index.html` answered those with
 * `200 text/html` where the page expected JSON, which it cannot parse — the
 * screen stayed blank with nothing logged. A 404 says what happened.
 */
export function createSpaFallback(staticDir: string, entryDir: string): RequestHandler {
  const entry = path.join(staticDir, entryDir, 'index.html');
  return (req: Request, res: Response) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'Not found', code: 'not_found', path: req.path });
      return;
    }
    const routePath = resolveContainedPath(staticDir, `.${req.path}`, 'index.html');
    if (routePath && fs.existsSync(routePath)) {
      res.sendFile(routePath, { dotfiles: 'allow' });
      return;
    }
    res.sendFile(entry, { dotfiles: 'allow' });
  };
}
