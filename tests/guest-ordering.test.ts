/** Customer self-ordering: a table's QR token is the only key, and it opens nothing else. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-guest-ordering-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

async function getFreeTcpPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function call(baseUrl: string, pathName: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await response.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* HTML or empty */ }
  return { status: response.status, body };
}

async function main() {
  console.log('Integration Test: Customer QR ordering');
  console.log('='.repeat(38));

  process.env.PORT = String(await getFreeTcpPort());
  process.env.GUEST_PORT = String(await getFreeTcpPort());

  const bcrypt = require('bcryptjs');
  const { initDatabase, getDatabase, closeDatabase, now } = await import('../main/db');
  const { startServer, stopServer } = await import('../main/server');
  const { startGuestServer, stopGuestServer, getGuestPort } = await import('../main/guest-server');

  initDatabase();
  const db = getDatabase();

  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('guest-test-owner', 'Owner', 'owner@guest.test', ?, 'owner', 1, ?, ?)
  `).run(bcrypt.hashSync('GuestPass123!', 10), now(), now());

  db.prepare(`
    INSERT INTO tables (id, number, capacity, status, is_active, guest_token, created_at, updated_at)
    VALUES ('tbl-guest', 'G1', 4, 'available', 1, 'token-for-table-g1-0000', ?, ?)
  `).run(now(), now());
  db.prepare(`
    INSERT INTO tables (id, number, capacity, status, is_active, created_at, updated_at)
    VALUES ('tbl-no-code', 'G2', 4, 'available', 1, ?, ?)
  `).run(now(), now());

  db.prepare(`
    INSERT INTO products (id, name, price, cost, is_active, created_at, updated_at)
    VALUES ('guest-product', 'Guest Coffee', 60, 25, 1, ?, ?)
  `).run(now(), now());
  db.prepare(`
    INSERT INTO products (id, name, price, is_active, created_at, updated_at)
    VALUES ('hidden-product', 'Retired Item', 50, 0, ?, ?)
  `).run(now(), now());

  await startServer();
  await startGuestServer();
  const guestUrl = `http://127.0.0.1:${getGuestPort()}`;
  const token = 'token-for-table-g1-0000';

  try {
    // Off by default: a fresh install must never be publicly writable.
    const whileDisabled = await call(guestUrl, `/api/guest/${token}/session`);
    assert.equal(whileDisabled.status, 404, 'guest routes stay closed until the merchant turns them on');

    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('guest_ordering_enabled', 'true', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(now());

    const session = await call(guestUrl, `/api/guest/${token}/session`);
    assert.equal(session.status, 200, 'a valid table token opens the menu');
    assert.equal(session.body.table.name, 'G1', 'the session names the scanned table');
    assert.equal(session.body.ticket, null, 'a fresh table has no ticket yet');

    const menuEntry = session.body.products.find((item: any) => item.id === 'guest-product');
    assert.ok(menuEntry, 'the sellable product is listed');
    assert.equal(menuEntry.cost, undefined, 'cost price is never exposed to a customer');
    assert.equal(menuEntry.stock_quantity, undefined, 'stock levels are never exposed to a customer');
    assert.equal(
      session.body.products.some((item: any) => item.id === 'hidden-product'),
      false,
      'an inactive product cannot be ordered',
    );

    for (const badToken of ['not-a-real-token-abcdef', 'short']) {
      const rejected = await call(guestUrl, `/api/guest/${badToken}/session`);
      assert.equal(rejected.status, 404, `an unknown token (${badToken}) opens nothing`);
    }

    const placed = await call(guestUrl, `/api/guest/${token}/order`, {
      method: 'POST',
      body: JSON.stringify({ items: [{ product_id: 'guest-product', quantity: 2 }] }),
    });
    assert.equal(placed.status, 201, 'a guest can place an order');
    assert.equal(placed.body.ticket.items.length, 1, 'the ticket comes back with the line');
    assert.equal(placed.body.ticket.items[0].quantity, 2);

    const appended = await call(guestUrl, `/api/guest/${token}/order`, {
      method: 'POST',
      body: JSON.stringify({ items: [{ product_id: 'guest-product', quantity: 1 }] }),
    });
    assert.equal(appended.status, 201, 'a second order joins the open ticket');
    assert.equal(appended.body.ticket.items.length, 2, 'both lines sit on one ticket');

    const order = db.prepare("SELECT id, user_id, table_id, type FROM orders WHERE table_id = 'tbl-guest'").get() as any;
    assert.equal(order.user_id, 'guest-ordering', 'the order is attributed to the locked system account');
    assert.equal(order.type, 'dine_in', 'a scanned table orders as dine-in');

    // Rubbish a customer could type into the request never reaches the kitchen.
    for (const payload of [
      { items: [] },
      { items: [{ product_id: 'hidden-product', quantity: 1 }] },
      { items: [{ product_id: 'guest-product', quantity: 0 }] },
      { items: [{ product_id: 'guest-product', quantity: 999 }] },
      { items: [{ product_id: 'guest-product', quantity: 1.5 }] },
    ]) {
      const rejected = await call(guestUrl, `/api/guest/${token}/order`, { method: 'POST', body: JSON.stringify(payload) });
      assert.equal(rejected.status, 400, `rejected: ${JSON.stringify(payload)}`);
    }

    // A table with no code issued is not orderable at all.
    const noCode = await call(guestUrl, '/api/guest/tbl-no-code/session');
    assert.equal(noCode.status, 404, 'a table id is not a token');

    // The guest port exposes nothing else — no staff API, no login.
    for (const closed of ['/api/orders', '/api/products', '/api/bills', '/api/staff', '/api/settings']) {
      const response = await call(guestUrl, closed);
      assert.equal(response.status, 404, `${closed} is not reachable from the guest port`);
    }
    const login = await call(guestUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'owner@guest.test', password: 'GuestPass123!' }),
    });
    assert.equal(login.status, 404, 'there is no staff login on the guest port');

    // Rotating the code retires the printed one immediately.
    db.prepare("UPDATE tables SET guest_token = 'rotated-token-g1-11111' WHERE id = 'tbl-guest'").run();
    const afterRotation = await call(guestUrl, `/api/guest/${token}/session`);
    assert.equal(afterRotation.status, 404, 'the old QR stops working the moment a new code is issued');
    const withNewToken = await call(guestUrl, '/api/guest/rotated-token-g1-11111/session');
    assert.equal(withNewToken.status, 200, 'the new code works');
    assert.equal(withNewToken.body.ticket.items.length, 2, 'the table keeps its open ticket across a rotation');
  } finally {
    await stopGuestServer();
    await stopServer();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  console.log('ALL PASSED');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
