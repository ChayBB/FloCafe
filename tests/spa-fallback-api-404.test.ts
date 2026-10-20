/**
 * An unmatched `/api/*` path must answer 404 JSON, not the SPA entry document.
 *
 * All four servers serve the same static export, so every app's page loads on
 * every port while its API calls only resolve on the port that owns them.
 * Falling through to `index.html` answered those calls with `200 text/html`
 * where the page expected JSON: it could not parse the body, so the screen
 * stayed blank with nothing logged and no failed request to find. Opening the
 * KDS on the Server App port is the case that surfaced it.
 *
 * Client-side routes must keep falling back, which is what the fallback exists
 * for, so both halves are pinned here.
 */
import assert from 'node:assert/strict';
import express from 'express';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSpaFallback } from '../main/lib/spa-fallback';

const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-spa-fallback-'));

function seedExport(): void {
  fs.mkdirSync(path.join(staticDir, 'kds-standalone'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'kds-standalone', 'index.html'), '<html>kds</html>');
  fs.mkdirSync(path.join(staticDir, 'orders'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'orders', 'index.html'), '<html>orders</html>');
}

async function main() {
  console.log('SPA fallback: unmatched /api is a 404');
  console.log('='.repeat(40));

  seedExport();
  const app = express();
  app.get('/api/kds/orders', (_req, res) => {
    res.json({ orders: [] });
  });
  app.get('/*splat', createSpaFallback(staticDir, 'kds-standalone'));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  async function get(pathName: string) {
    const response = await fetch(`${base}${pathName}`);
    return {
      status: response.status,
      type: (response.headers.get('content-type') || '').split(';')[0],
      body: await response.text(),
    };
  }

  try {
    const handled = await get('/api/kds/orders');
    assert.equal(handled.status, 200, 'a route the server owns is untouched');
    assert.equal(handled.type, 'application/json', 'and still answers JSON');

    // The case from the field: the KDS page loaded on a port without KDS routes.
    const unmatched = await get('/api/kds/items/1/status');
    assert.equal(unmatched.status, 404, 'an unmatched /api path is a 404');
    assert.equal(unmatched.type, 'application/json', 'and says so in JSON, not HTML');
    assert.equal(
      JSON.parse(unmatched.body).code,
      'not_found',
      'with a code the caller can branch on',
    );

    const bare = await get('/api');
    assert.equal(bare.status, 404, 'the bare /api path is a 404 too');

    const deep = await get('/api/anything/at/all?x=1');
    assert.equal(deep.status, 404, 'so is any depth below it');

    // Everything else must keep reaching the export, or the apps stop routing.
    const route = await get('/orders');
    assert.equal(route.status, 200, 'an exported route is served');
    assert.match(route.body, /orders/, 'from its own index.html');

    const clientRoute = await get('/orders/12345');
    assert.equal(clientRoute.status, 200, 'an unexported client-side route still falls back');
    assert.match(clientRoute.body, /kds/, 'to the entry document this server owns');

    const apiLike = await get('/apiary');
    assert.equal(apiLike.status, 200, 'a path merely starting with "api" is not an API path');

    console.log('  ✓ owned /api route untouched');
    console.log('  ✓ unmatched /api answers 404 JSON');
    console.log('  ✓ client-side routes still fall back');
    console.log('\nAll SPA fallback assertions passed.');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(staticDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('\nTest failed:', error);
  process.exit(1);
});
