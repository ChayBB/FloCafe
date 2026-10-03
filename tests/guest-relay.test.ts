/**
 * The relay that carries customer orders from a hosted QR server to this POS.
 *
 * A customer on mobile data cannot reach a till behind NAT. Rather than opening
 * an inbound hole into the shop, the POS dials out and holds the connection, so
 * this test plays the hosted server: it accepts the POS's connection, pushes
 * orders down it, and checks what comes back.
 *
 * The cases that matter are the refusals. A hosted server that hears nothing
 * must assume an order may have landed, so every rejection has to be answered,
 * and a redelivery must not become a second round of food.
 *
 * Run: npm run test:guest-relay
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-guest-relay-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((e) => e ? reject(e) : resolve()));
  return port;
}

/**
 * Buffers everything the POS sends, so a test can ask for a frame that already
 * arrived. The POS sends its hello and its first snapshot in the same tick, and
 * a listener attached after awaiting the first would never see the second.
 */
function collect(socket: WebSocket) {
  const seen: any[] = [];
  socket.on('message', (data) => {
    try { seen.push(JSON.parse(String(data))); } catch { /* not ours */ }
  });

  return async function take(type: string, timeoutMs = 5_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = seen.findIndex((message) => message.type === type);
      if (index !== -1) return seen.splice(index, 1)[0];
      if (Date.now() > deadline) throw new Error(`timed out waiting for "${type}"`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
}

async function main() {
  console.log('Integration Test: Guest order relay');
  console.log('='.repeat(36));

  process.env.PORT = String(await freePort());
  const relayPort = await freePort();

  const { initDatabase, getDatabase, closeDatabase, now, upsertSettings } = await import('../main/db');
  const { startServer, stopServer } = await import('../main/server');
  const { startGuestRelay, stopGuestRelay, signHello } = await import('../main/services/guest-relay');
  const { newRoundToken } = await import('../main/services/guest-tokens');

  initDatabase();
  const db = getDatabase();
  const tableCode = 'relay-table-code-AAAABBBBCCCC';

  db.prepare(`INSERT INTO tables (id, number, capacity, status, is_active, guest_token, guest_round, created_at, updated_at)
              VALUES ('tbl-relay', 'R1', 4, 'available', 1, ?, 1, ?, ?)`).run(tableCode, now(), now());
  db.prepare(`INSERT INTO products (id, name, price, is_active, created_at, updated_at)
              VALUES ('prod-relay', 'Relay Coffee', 60, 1, ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, name, price, is_active, created_at, updated_at)
              VALUES ('prod-retired', 'Retired', 50, 0, ?, ?)`).run(now(), now());
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('RelayAdmin1', 10);
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
              VALUES ('relay-owner', 'Chay', 'owner@relay.test', ?, 'owner', 1, ?, ?)`).run(hash, now(), now());
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
              VALUES ('relay-server', 'Nok', 'nok@relay.test', ?, 'server', 1, ?, ?)`).run(hash, now(), now());
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('country', 'TH', ?) ON CONFLICT(key) DO UPDATE SET value='TH'").run(now());
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('currency', 'THB', ?) ON CONFLICT(key) DO UPDATE SET value='THB'").run(now());

  await startServer();

  // The hosted QR server's end of the wire.
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });
  let connection: WebSocket | null = null;
  const connected = new Promise<WebSocket>((resolve) => wss.once('connection', (ws) => { connection = ws; resolve(ws); }));
  await new Promise<void>((resolve) => httpServer.listen(relayPort, '127.0.0.1', resolve));

  const secret = 'relay-test-secret-0123456789';
  let passed = 0;
  const ok = (label: string) => { console.log(`  ✓ ${label}`); passed += 1; };

  try {
    console.log('\n1. nothing is dialled until it is configured');
    startGuestRelay();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(wss.clients.size, 0, 'an unconfigured install opens no socket');
    await stopGuestRelay();

    upsertSettings({
      guest_ordering_enabled: 'true',
      guest_relay_url: `ws://127.0.0.1:${relayPort}`,
      guest_relay_secret: secret,
    });
    ok('an unconfigured install never connects');

    console.log('\n2. the POS dials out and proves who it is');
    startGuestRelay();
    const socket = await connected;
    const nextMessage = collect(socket);
    const hello = await nextMessage('hello');
    assert.ok(hello.pos_hash, 'the hello identifies the till');
    assert.equal(
      hello.signature,
      signHello(secret, hello.pos_hash, hello.timestamp, hello.nonce),
      'the signature is one the hosted server can recompute',
    );
    assert.equal(String(hello.signature).includes(secret), false, 'the shared secret itself is never sent');
    ok('the POS connects outbound and signs its hello');

    console.log('\n3. the POS sends the menu the server will serve');
    const snapshot = await nextMessage('snapshot');
    assert.ok(snapshot.products.some((p: any) => p.id === 'prod-relay'), 'the sellable product is in the snapshot');
    assert.equal(snapshot.products.some((p: any) => p.id === 'prod-retired'), false, 'a retired product is not');
    const listed = snapshot.products.find((p: any) => p.id === 'prod-relay');
    for (const forbidden of ['cost', 'cost_price', 'stock_quantity', 'sku']) {
      assert.equal(forbidden in listed, false, `${forbidden} is never sent to a hosted server`);
    }
    const relayTable = snapshot.tables.find((t: any) => t.id === 'tbl-relay');
    assert.ok(relayTable?.token_hash, 'tables are identified by a hash');
    assert.equal(JSON.stringify(snapshot).includes(tableCode), false, 'the real code never leaves the POS');
    ok('the menu goes up with no cost, stock or usable table code');

    const round = newRoundToken('tbl-relay', 1);
    const send = (payload: Record<string, unknown>) => socket.send(JSON.stringify({ type: 'order', ...payload }));

    console.log('\n4. a relayed order reaches the kitchen');
    send({ id: 'o-1', table_code: tableCode, round_token: round, items: [{ product_id: 'prod-relay', quantity: 2 }] });
    const ack = await nextMessage('ack');
    assert.equal(ack.id, 'o-1');
    assert.equal(ack.table_name, 'R1', 'the acknowledgement names the table');
    assert.ok(ack.order_number, 'and carries the order number staff will see');
    const placed = db.prepare("SELECT COUNT(*) c FROM order_items WHERE product_id = 'prod-relay'").get() as any;
    assert.equal(placed.c, 1, 'the line really exists');
    ok('an order sent down the relay becomes a real order');

    console.log('\n5. a redelivery does not become a second round of food');
    send({ id: 'o-1', table_code: tableCode, round_token: round, items: [{ product_id: 'prod-relay', quantity: 2 }] });
    await nextMessage('ack');
    const afterReplay = db.prepare("SELECT COUNT(*) c FROM order_items WHERE product_id = 'prod-relay'").get() as any;
    assert.equal(afterReplay.c, 1, 'the same relay id is recognised, not re-cooked');
    ok('resending an order the server never heard acked is safe');

    console.log('\n6. every refusal is answered, never dropped');
    const refusals: [string, Record<string, unknown>, string][] = [
      ['an unknown table code', { id: 'o-2', table_code: 'not-a-real-code-AAAABBBB', round_token: round, items: [{ product_id: 'prod-relay', quantity: 1 }] }, 'unknown_table'],
      ['a token from a settled sitting', { id: 'o-3', table_code: tableCode, round_token: newRoundToken('tbl-relay', 99), items: [{ product_id: 'prod-relay', quantity: 1 }] }, 'round_closed'],
      ['an item that is not sellable', { id: 'o-4', table_code: tableCode, round_token: round, items: [{ product_id: 'prod-retired', quantity: 1 }] }, 'invalid_items'],
      ['an impossible quantity', { id: 'o-5', table_code: tableCode, round_token: round, items: [{ product_id: 'prod-relay', quantity: 999 }] }, 'invalid_items'],
      ['an empty basket', { id: 'o-6', table_code: tableCode, round_token: round, items: [] }, 'invalid_items'],
    ];
    for (const [label, payload, reason] of refusals) {
      send(payload);
      const nack = await nextMessage('nack');
      assert.equal(nack.id, payload.id, `a reply arrives for ${label}`);
      assert.equal(nack.reason, reason, `${label} is refused as ${reason}`);
    }
    ok('unknown table, closed round, dead item, bad quantity and empty basket are all answered');

    console.log('\n7. an order stranded by a long outage is not cooked');
    send({
      id: 'o-7', table_code: tableCode, round_token: round,
      placed_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      items: [{ product_id: 'prod-relay', quantity: 1 }],
    });
    const stale = await nextMessage('nack');
    assert.equal(stale.reason, 'stale', 'an hour-old order is refused rather than sent to the kitchen');
    ok('a stale order is refused so the customer can be told instead of fed late');

    console.log('\n8. the owner signs in through the hosted server');
    const login = async (email: string, password: string) => {
      const id = `login-${Math.random().toString(36).slice(2)}`;
      socket.send(JSON.stringify({ type: 'admin_login', id, email, password }));
      return nextMessage('admin_login_result');
    };

    const wrong = await login('owner@relay.test', 'not-the-password');
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, 'invalid_credentials');

    const unknown = await login('nobody@relay.test', 'RelayAdmin1');
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, 'invalid_credentials', 'a missing address is indistinguishable from a wrong password');

    // A waiter may take orders; reconfiguring what the public internet sees is
    // not the same job.
    const waiter = await login('nok@relay.test', 'RelayAdmin1');
    assert.equal(waiter.ok, false);
    assert.equal(waiter.reason, 'not_permitted');

    const owner = await login('  Owner@Relay.Test  ', 'RelayAdmin1');
    assert.equal(owner.ok, true, 'the owner signs in, address trimmed and case-folded');
    assert.equal(owner.name, 'Chay');
    assert.equal(owner.role, 'owner');
    ok('only an owner or manager with the right password gets in');

    console.log('\n9. signing in publishes the menu and releases the printable codes');
    await nextMessage('snapshot');
    const codesId = 'codes-1';
    socket.send(JSON.stringify({ type: 'admin_table_codes', id: codesId }));
    const codes = await nextMessage('admin_table_codes_result');
    assert.equal(codes.ok, true);
    const printable = codes.tables.find((t: any) => t.id === 'tbl-relay');
    assert.equal(printable.code, tableCode, 'the real code is handed over for printing');
    assert.equal(printable.number, 'R1');
    ok('signing in pushes the menu and hands over the codes a QR needs');

    console.log('\n10. the codes are not available without signing in');
    await stopGuestRelay();
    const reconnected = new Promise<WebSocket>((resolve) => wss.once('connection', (ws) => resolve(ws)));
    startGuestRelay();
    const fresh = await reconnected;
    const freshNext = collect(fresh);
    await freshNext('hello');
    fresh.send(JSON.stringify({ type: 'admin_table_codes', id: 'codes-2' }));
    const refused = await freshNext('admin_table_codes_result');
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'not_signed_in', 'a reconnect never inherits the previous session');
    ok('a new connection starts unprivileged');

    console.log('\n11. plaintext to a remote host is refused');
    await stopGuestRelay();
    upsertSettings({ guest_relay_url: 'ws://198.51.100.7:9000' });
    startGuestRelay();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(wss.clients.size, 0, 'orders are not carried over an unencrypted link to a remote host');
    ok('ws:// is allowed only to loopback; anything else needs wss://');
  } finally {
    await stopGuestRelay();
    connection?.close();
    wss.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* SQLite may still hold it */ }
  }

  console.log(`\nResults: ${passed}/11 passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
