/** Marking a line ready must push to the waiter covering that table, from either status route. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';

function messageQueue(ws: WebSocket) {
  const received: any[] = [];
  const waiting: Array<{ type: string; resolve: (message: any) => void }> = [];
  ws.on('message', (raw: WebSocket.RawData) => {
    const message = JSON.parse(raw.toString());
    const index = waiting.findIndex((entry) => entry.type === message.type);
    if (index >= 0) return waiting.splice(index, 1)[0].resolve(message);
    received.push(message);
  });
  return (type: string): Promise<any> => {
    const index = received.findIndex((message) => message.type === type);
    if (index >= 0) return Promise.resolve(received.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const entry = { type, resolve: (_message: any) => {} };
      const timer = setTimeout(() => {
        const position = waiting.indexOf(entry);
        if (position >= 0) waiting.splice(position, 1);
        reject(new Error(`Timed out waiting for ${type}`));
      }, 5000);
      entry.resolve = (message: any) => {
        clearTimeout(timer);
        resolve(message);
      };
      waiting.push(entry);
    });
  };
}

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-ready-push-'));

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
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function main() {
  console.log('Integration Test: Server App ready push');
  console.log('='.repeat(40));

  process.env.PORT = String(await getFreeTcpPort());
  process.env.KDS_PORT = String(await getFreeTcpPort());

  const bcrypt = require('bcryptjs');
  const { initDatabase, getDatabase, closeDatabase, now } = await import('../main/db');
  const { startServer, stopServer, getServerPort } = await import('../main/server');
  const { startKdsServer, stopKdsServer, getKdsPort } = await import('../main/kds-server');
  const { onOrderItemStatus } = await import('../main/services/server-app-events');

  initDatabase();
  const db = getDatabase();

  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('country', 'TH', ?) ON CONFLICT(key) DO UPDATE SET value='TH', updated_at=excluded.updated_at",
  ).run(now());
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('currency', 'THB', ?) ON CONFLICT(key) DO UPDATE SET value='THB', updated_at=excluded.updated_at",
  ).run(now());

  const passwordHash = bcrypt.hashSync('ReadyPush123!', 10);
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'owner', 1, ?, ?)
  `).run('rp-owner', 'Ready Push Owner', 'owner@ready-push.test', passwordHash, now(), now());

  db.prepare(`
    INSERT INTO tables (id, number, capacity, status, is_active, created_at, updated_at)
    VALUES ('rp-table', 'R1', 4, 'available', 1, ?, ?)
  `).run(now(), now());

  db.prepare(`
    INSERT INTO products (id, name, price, is_active, created_at, updated_at)
    VALUES ('rp-product', 'Ready Push Latte', 80, 1, ?, ?)
  `).run(now(), now());

  await startServer();
  await startKdsServer();
  const baseUrl = `http://127.0.0.1:${getServerPort()}`;

  const events: { itemId: number; status: string; tableId: string | null; productName: string }[] =
    [];
  const unsubscribe = onOrderItemStatus((event) => {
    events.push({
      itemId: event.itemId,
      status: event.status,
      tableId: event.tableId,
      productName: event.productName,
    });
  });

  async function request(pathName: string, init: RequestInit = {}) {
    const response = await fetch(`${baseUrl}${pathName}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    const text = await response.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON error page */
    }
    return { status: response.status, body };
  }

  try {
    const loggedIn = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'owner@ready-push.test', password: 'ReadyPush123!' }),
    });
    assert.equal(loggedIn.status, 200, 'the owner can log in');
    const auth = { Authorization: `Bearer ${loggedIn.body.access_token}` };

    async function placeOrder() {
      const created = await request('/api/orders', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          table_id: 'rp-table',
          type: 'dine_in',
          items: [{ product_id: 'rp-product', quantity: 1 }],
        }),
      });
      assert.equal(created.status, 201, 'a dine-in order is placed');
      return created.body.order.items[0].id as number;
    }

    // The standalone KDS marks lines ready through /api/kds, which is the path a
    // kitchen actually uses; a missing push here leaves the waiter on the 30s poll.
    const kdsItemId = await placeOrder();
    events.length = 0;
    const viaKds = await request(`/api/kds/items/${kdsItemId}/status`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ status: 'ready' }),
    });
    assert.equal(viaKds.status, 200, 'the KDS route marks the line ready');
    assert.equal(events.length, 1, 'the KDS route pushes exactly one status event');
    assert.deepEqual(
      events[0],
      {
        itemId: kdsItemId,
        status: 'ready',
        tableId: 'rp-table',
        productName: 'Ready Push Latte',
      },
      'the KDS push carries the table and product the waiter needs',
    );

    // The in-app KDS uses the other route; both must stay wired.
    const itemsItemId = await placeOrder();
    events.length = 0;
    const viaItems = await request(`/api/order-items/${itemsItemId}/status`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ status: 'ready' }),
    });
    assert.equal(viaItems.status, 200, 'the order-items route marks the line ready');
    assert.equal(events.length, 1, 'the order-items route pushes exactly one status event');
    assert.equal(events[0].status, 'ready');
    assert.equal(events[0].tableId, 'rp-table');

    // A non-ready transition still pushes: the waiter's cached statuses have to
    // track "preparing" or the next flip to ready looks like a repeat.
    const stagedItemId = await placeOrder();
    events.length = 0;
    const staged = await request(`/api/kds/items/${stagedItemId}/status`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ status: 'preparing' }),
    });
    assert.equal(staged.status, 200, 'the KDS route moves the line to preparing');
    assert.deepEqual(
      events.map((event) => event.status),
      ['preparing'],
      'preparing is pushed too',
    );

    // The KDS tablet marks items ready over its WebSocket, not the REST route, so
    // this is the path that actually carries a real kitchen's traffic.
    const socketItemId = await placeOrder();
    events.length = 0;
    const ws = new WebSocket(`ws://127.0.0.1:${getKdsPort()}/kds`);
    const nextMessage = messageQueue(ws);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'auth', token: loggedIn.body.access_token }));
    await nextMessage('auth_success');
    await nextMessage('initial_data');
    ws.send(
      JSON.stringify({ type: 'status_update', order_item_id: socketItemId, status: 'ready' }),
    );
    await nextMessage('status_updated');
    ws.close();
    await once(ws, 'close');
    assert.equal(events.length, 1, 'the KDS WebSocket pushes exactly one status event');
    assert.deepEqual(
      events[0],
      {
        itemId: socketItemId,
        status: 'ready',
        tableId: 'rp-table',
        productName: 'Ready Push Latte',
      },
      'the WebSocket push carries the table and product the waiter needs',
    );

    console.log('\nAll ready-push assertions passed.');
  } finally {
    unsubscribe();
    await stopKdsServer();
    await stopServer();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('\nTest failed:', error);
  process.exit(1);
});
