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
  const { startGuestRelay, stopGuestRelay, signHello, issuePairingCode } = await import('../main/services/guest-relay');
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

    console.log('\n8. a phone that scanned gets a sitting the hosted server could not mint');
    socket.send(JSON.stringify({ type: 'guest_session', id: 's-1', table_code: tableCode }));
    const session = await nextMessage('guest_session_result');
    assert.equal(session.ok, true);
    assert.equal(session.table.name, 'R1');
    assert.ok(session.round_token, 'the round token comes from the till, which alone can sign one');
    assert.ok(session.ticket?.order_number, 'and the sitting already shows what the table ordered');

    // The token the till just minted is a real one. Fetching it per scan is only
    // worth anything if what comes back actually opens a sitting.
    socket.send(JSON.stringify({
      type: 'order', id: 'o-session', table_code: tableCode, round_token: session.round_token,
      items: [{ product_id: 'prod-relay', quantity: 1 }],
    }));
    const sessionAck = await nextMessage('ack');
    assert.equal(sessionAck.id, 'o-session', 'the minted token really opens a sitting');

    socket.send(JSON.stringify({ type: 'guest_session', id: 's-2', table_code: 'not-a-real-code-AAAABBBB' }));
    const noSuchTable = await nextMessage('guest_session_result');
    assert.equal(noSuchTable.ok, false);
    assert.equal(noSuchTable.reason, 'unknown_table');
    ok('a scan opens a sitting, and a dead code opens nothing');

    console.log('\n9. the ticket is re-checked against the sitting every time');
    socket.send(JSON.stringify({ type: 'guest_ticket', id: 't-1', table_code: tableCode, round_token: round }));
    const ticket = await nextMessage('guest_ticket_result');
    assert.equal(ticket.ok, true);
    assert.ok(ticket.ticket?.order_number, 'the guest sees what their table has ordered');

    // A token from a settled sitting must stop working, or a customer who has
    // paid and left can still watch the next party's ticket.
    socket.send(JSON.stringify({
      type: 'guest_ticket', id: 't-2', table_code: tableCode, round_token: newRoundToken('tbl-relay', 99),
    }));
    const settled = await nextMessage('guest_ticket_result');
    assert.equal(settled.ok, false);
    assert.equal(settled.reason, 'round_closed');
    ok('a ticket needs a live round token, not just a valid table code');

    console.log('\n10. the hosted server pairs with a code read off the till');
    const pair = async (code: string) => {
      const id = `pair-${Math.random().toString(36).slice(2)}`;
      socket.send(JSON.stringify({ type: 'admin_pair', id, code }));
      return nextMessage('admin_pair_result');
    };

    // Nothing is outstanding until the merchant asks for one.
    const unissued = await pair('ABCD2345');
    assert.equal(unissued.ok, false);
    assert.equal(unissued.reason, 'no_pairing_code', 'a code cannot be guessed before one exists');

    // Taking orders is one job; publishing the shop to the internet is another.
    assert.throws(
      () => issuePairingCode({ name: 'Nok', role: 'server' }),
      /owner or a manager/,
      'a server-role staff member cannot issue a pairing code even past the route',
    );

    const issued = issuePairingCode({ name: 'Chay', role: 'owner' });
    assert.match(issued.code, /^[0-9A-HJKMNP-TV-Z]{8}$/, 'eight characters, no I L O or U to misread');

    const wrong = await pair('23456789');
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, 'invalid_code');

    // Typed with the separator and the case a merchant actually uses, and with
    // O for 0 — the alphabet has no O, so folding it is safe.
    const typed = issued.code.toLowerCase().replace(/0/g, 'o').replace(/(.{4})/, '$1-');
    const paired = await pair(typed);
    assert.equal(paired.ok, true, 'case, separators and an O-for-0 slip all still pair');
    assert.equal(paired.name, 'Chay');
    assert.equal(paired.role, 'owner');

    // Single use: the code is spent, so a copy left in a browser cannot pair
    // somebody else's server afterwards.
    const reused = await pair(issued.code);
    assert.equal(reused.ok, false);
    assert.equal(reused.reason, 'no_pairing_code', 'a used code is gone, not merely refused');
    ok('a code off the till pairs once, and no password is ever sent');

    console.log('\n11. a code dies after five wrong guesses rather than being guessed at');
    const guessable = issuePairingCode({ name: 'Chay', role: 'owner' });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const miss = await pair('22222222');
      assert.equal(miss.reason, 'invalid_code', `attempt ${attempt} is refused but the code lives`);
    }
    const burned = await pair('22222222');
    assert.equal(burned.reason, 'too_many_attempts', 'the fifth wrong guess destroys the code');
    const afterBurn = await pair(guessable.code);
    assert.equal(afterBurn.reason, 'no_pairing_code', 'and the real code no longer works either');
    ok('brute force burns the code instead of eventually finding it');

    console.log('\n12. pairing publishes the menu and releases the printable codes');
    const republish = issuePairingCode({ name: 'Chay', role: 'owner' });
    const republished = await pair(republish.code);
    assert.equal(republished.ok, true);
    await nextMessage('snapshot');
    const codesId = 'codes-1';
    socket.send(JSON.stringify({ type: 'admin_table_codes', id: codesId }));
    const codes = await nextMessage('admin_table_codes_result');
    assert.equal(codes.ok, true);
    const printable = codes.tables.find((t: any) => t.id === 'tbl-relay');
    assert.equal(printable.code, tableCode, 'the real code is handed over for printing');
    assert.equal(printable.number, 'R1');
    ok('pairing pushes the menu and hands over the codes a QR needs');

    console.log('\n13. the codes are not available without pairing');
    await stopGuestRelay();
    const reconnected = new Promise<WebSocket>((resolve) => wss.once('connection', (ws) => resolve(ws)));
    startGuestRelay();
    const fresh = await reconnected;
    const freshNext = collect(fresh);
    await freshNext('hello');
    fresh.send(JSON.stringify({ type: 'admin_table_codes', id: 'codes-2' }));
    const refused = await freshNext('admin_table_codes_result');
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'not_paired', 'a reconnect never inherits the previous pairing');
    ok('a new connection starts unprivileged');

    console.log('\n14. plaintext to a remote host is refused');
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

  console.log(`\nResults: ${passed}/14 passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
