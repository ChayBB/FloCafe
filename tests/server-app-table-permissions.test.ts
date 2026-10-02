/** Servers may only take Server App orders on tables assigned to them (no assignment = every table). */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-server-app-table-perms-'));

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

async function request(baseUrl: string, pathName: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await response.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* non-JSON error page */ }
  return { status: response.status, body };
}

async function login(baseUrl: string, email: string): Promise<string> {
  const result = await request(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'ServerPass123!' }),
  });
  assert.equal(result.status, 200, `${email} can log in to the Server App`);
  return result.body.access_token;
}

async function main() {
  console.log('Integration Test: Server App table permissions');
  console.log('='.repeat(46));

  process.env.PORT = String(await getFreeTcpPort());
  process.env.SERVER_APP_PORT = String(await getFreeTcpPort());

  const bcrypt = require('bcryptjs');
  const { initDatabase, getDatabase, closeDatabase, now } = await import('../main/db');
  const { startServer, stopServer } = await import('../main/server');
  const { startServerApp, stopServerApp, getServerAppPort } = await import('../main/server-app');

  initDatabase();
  const db = getDatabase();

  // Order creation resolves a regional snapshot and refuses when the shop's
  // country is unset, so a bare test database cannot place one.
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('country', 'TH', ?) ON CONFLICT(key) DO UPDATE SET value='TH', updated_at=excluded.updated_at").run(now());
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('currency', 'THB', ?) ON CONFLICT(key) DO UPDATE SET value='THB', updated_at=excluded.updated_at").run(now());
  const passwordHash = bcrypt.hashSync('ServerPass123!', 10);

  const insertUser = db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `);
  insertUser.run('tp-owner', 'Table Perms Owner', 'owner@table-perms.test', passwordHash, 'owner', now(), now());
  insertUser.run('tp-scoped', 'Scoped Server', 'scoped@table-perms.test', passwordHash, 'server', now(), now());
  insertUser.run('tp-open', 'Unassigned Server', 'open@table-perms.test', passwordHash, 'server', now(), now());

  const insertTable = db.prepare(`
    INSERT INTO tables (id, number, capacity, status, is_active, created_at, updated_at)
    VALUES (?, ?, 4, 'available', 1, ?, ?)
  `);
  insertTable.run('tbl-a', 'A1', now(), now());
  insertTable.run('tbl-b', 'B1', now(), now());

  db.prepare('INSERT INTO table_users (user_id, table_id, created_at) VALUES (?, ?, ?)')
    .run('tp-scoped', 'tbl-a', now());

  db.prepare(`
    INSERT INTO products (id, name, price, is_active, created_at, updated_at)
    VALUES ('tp-product', 'Table Perms Coffee', 60, 1, ?, ?)
  `).run(now(), now());

  await startServer();
  await startServerApp();
  const baseUrl = `http://127.0.0.1:${getServerAppPort()}`;

  try {
    const scopedToken = await login(baseUrl, 'scoped@table-perms.test');
    const openToken = await login(baseUrl, 'open@table-perms.test');
    const ownerToken = await login(baseUrl, 'owner@table-perms.test');

    const scopedTables = await request(baseUrl, '/api/tables?active=true', {
      headers: { Authorization: `Bearer ${scopedToken}` },
    });
    assert.equal(scopedTables.status, 200);
    assert.deepEqual(
      scopedTables.body.tables.map((table: any) => table.id),
      ['tbl-a'],
      'an assigned server only sees the tables assigned to them',
    );

    const openTables = await request(baseUrl, '/api/tables?active=true', {
      headers: { Authorization: `Bearer ${openToken}` },
    });
    assert.equal(
      openTables.body.tables.length,
      2,
      'a server with no assignments keeps every table',
    );

    const ownerTables = await request(baseUrl, '/api/tables?active=true', {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(ownerTables.body.tables.length, 2, 'owners are never table-scoped');

    const orderBody = (tableId: string) => JSON.stringify({
      table_id: tableId,
      type: 'dine_in',
      items: [{ product_id: 'tp-product', quantity: 1 }],
    });

    const denied = await request(baseUrl, '/api/orders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${scopedToken}` },
      body: orderBody('tbl-b'),
    });
    assert.equal(denied.status, 403, 'a scoped server cannot open an order on an unassigned table');
    assert.match(String(denied.body.error), /not assigned to this table/i);

    const allowed = await request(baseUrl, '/api/orders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${scopedToken}` },
      body: orderBody('tbl-a'),
    });
    assert.equal(allowed.status, 201, 'a scoped server can open an order on an assigned table');
    const allowedOrderId = allowed.body.order.id;

    const ownerOnOtherTable = await request(baseUrl, '/api/orders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: orderBody('tbl-b'),
    });
    assert.equal(ownerOnOtherTable.status, 201, 'owners can open an order on any table');
    const otherTableOrderId = ownerOnOtherTable.body.order.id;

    const appendDenied = await request(baseUrl, `/api/orders/${otherTableOrderId}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${scopedToken}` },
      body: JSON.stringify({ items: [{ product_id: 'tp-product', quantity: 1 }] }),
    });
    assert.equal(appendDenied.status, 403, 'a scoped server cannot append to an order on an unassigned table');

    const appendAllowed = await request(baseUrl, `/api/orders/${allowedOrderId}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${scopedToken}` },
      body: JSON.stringify({ items: [{ product_id: 'tp-product', quantity: 1 }] }),
    });
    assert.equal(appendAllowed.status, 200, 'a scoped server can append to an order on an assigned table');

    // A server may pull a line the kitchen has not started, but only on their own table.
    const scopedOrder = await request(baseUrl, `/api/orders?table_id=tbl-a&type=dine_in&status=pending,preparing,ready&per_page=1`, {
      headers: { Authorization: `Bearer ${scopedToken}` },
    });
    const pendingItem = scopedOrder.body.orders[0].items.find((item: any) => item.status === 'pending');
    assert.ok(pendingItem, 'the assigned table has a pending line to cancel');

    const noteOnOtherTable = await request(baseUrl, `/api/orders/${otherTableOrderId}/items/${pendingItem.id}/notes`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${scopedToken}` },
      body: JSON.stringify({ special_instructions: 'Takeaway' }),
    });
    assert.equal(noteOnOtherTable.status, 403, 'editing a line is table-scoped too');

    const taggedItem = await request(baseUrl, `/api/orders/${allowedOrderId}/items/${pendingItem.id}/notes`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${scopedToken}` },
      body: JSON.stringify({ special_instructions: 'Takeaway' }),
    });
    assert.equal(taggedItem.status, 200, 'a server can tag a pending line on their own table');
    assert.equal(
      taggedItem.body.order.items.find((item: any) => item.id === pendingItem.id).special_instructions,
      'Takeaway',
      'the note is stored on the line',
    );

    const itemOnOtherTable = await request(baseUrl, `/api/orders/${otherTableOrderId}/items/${pendingItem.id}/cancel`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${scopedToken}` },
      body: JSON.stringify({}),
    });
    assert.equal(itemOnOtherTable.status, 403, 'item cancel is table-scoped like every other write');

    const cancelledItem = await request(baseUrl, `/api/orders/${allowedOrderId}/items/${pendingItem.id}/cancel`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${scopedToken}` },
      body: JSON.stringify({}),
    });
    assert.equal(cancelledItem.status, 200, 'a server can cancel a pending line on their own table');
    assert.equal(
      cancelledItem.body.order.items.find((item: any) => item.id === pendingItem.id).status,
      'cancelled',
      'the line is marked cancelled',
    );

    // Billing is table-scoped the same way, and servers may settle their own tables.
    const billDenied = await request(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${scopedToken}` },
      body: JSON.stringify({ order_id: otherTableOrderId }),
    });
    assert.equal(billDenied.status, 403, 'a scoped server cannot open a bill for an unassigned table');

    const billGenerated = await request(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${scopedToken}` },
      body: JSON.stringify({ order_id: allowedOrderId }),
    });
    assert.ok([200, 201].includes(billGenerated.status), 'a server can open a bill for an assigned table');
    const bill = billGenerated.body.bill;
    assert.ok(bill?.id, 'bill generation returns a bill');

    const paidByOtherServer = await request(baseUrl, `/api/bills/${bill.id}/payments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openToken}`, 'Idempotency-Key': 'table-perms-open-server' },
      body: JSON.stringify({ payments: [{ method: 'cash', amount: Number(bill.balance) }] }),
    });
    assert.equal(paidByOtherServer.status, 200, 'an unassigned server may still settle any table');
    assert.equal(paidByOtherServer.body.bill.payment_status, 'paid', 'the payment closes the bill');

    // Orders stay open to every server: the scoped server still reads orders from other tables.
    const orders = await request(baseUrl, '/api/orders', {
      headers: { Authorization: `Bearer ${scopedToken}` },
    });
    assert.equal(orders.status, 200);
    assert.ok(
      orders.body.orders.some((order: any) => order.id === otherTableOrderId),
      'table scoping restricts taking orders, never viewing them',
    );
  } finally {
    await stopServerApp();
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
