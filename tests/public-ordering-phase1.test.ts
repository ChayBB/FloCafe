/**
 * Multi-tenant public ordering, phase 1: a QR token says which shop it belongs to,
 * and the snapshot pushed to the cloud carries a public menu — no cost, no stock,
 * and no working table token. See docs/public-ordering-multitenant.md.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-public-ordering-'));

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

async function main() {
  console.log('Integration Test: Public ordering phase 1');
  console.log('='.repeat(41));

  process.env.PORT = String(await getFreeTcpPort());
  process.env.GUEST_PORT = String(await getFreeTcpPort());

  const { initDatabase, getDatabase, closeDatabase, now, upsertSettings } = await import('../main/db');
  const { startServer, stopServer } = await import('../main/server');
  const { startGuestServer, stopGuestServer, getGuestPort } = await import('../main/guest-server');
  const tokens = await import('../main/services/guest-tokens');
  const { publicOrderingSnapshot, publicTables, snapshotDigest } = await import('../main/services/public-menu');

  initDatabase();
  const db = getDatabase();
  const secret = 'AAAAbbbbCCCCddddEEEEffffGGGGhhhh';

  db.prepare(`
    INSERT INTO tables (id, number, capacity, status, is_active, guest_token, created_at, updated_at)
    VALUES ('tbl-mt', 'M1', 4, 'available', 1, ?, ?, ?)
  `).run(secret, now(), now());
  db.prepare(`
    INSERT INTO products (id, name, price, cost, stock_quantity, sku, is_active, created_at, updated_at)
    VALUES ('prod-mt', 'Snapshot Coffee', 70, 31, 12, 'SKU-MT-1', 1, ?, ?)
  `).run(now(), now());
  upsertSettings({ guest_ordering_enabled: 'true' });

  await startServer();
  await startGuestServer();
  const guestUrl = `http://127.0.0.1:${getGuestPort()}`;
  const session = (token: string) => fetch(`${guestUrl}/api/guest/${encodeURIComponent(token)}/session`);

  try {
    // ---- Token parsing --------------------------------------------------
    assert.deepEqual(tokens.parseGuestToken(secret), { storeRef: '', secret }, 'a bare code parses as ours-by-default');
    assert.deepEqual(tokens.parseGuestToken(`shop7.${secret}`), { storeRef: 'shop7', secret }, 'a qualified code splits on the first dot');
    for (const rubbish of ['', 'short', '.', `.${secret}`, `shop7.`, `sh op.${secret}`, `shop7.${secret}!`, null, 42]) {
      assert.equal(tokens.parseGuestToken(rubbish as unknown), null, `rejected: ${String(rubbish)}`);
    }

    // ---- Before the cloud has issued a store reference -------------------
    assert.equal(tokens.getStoreRef(), '', 'an unregistered shop has no store reference');
    assert.equal(tokens.qualifyGuestToken(secret), secret, 'codes stay bare until there is a reference to add');
    assert.equal((await session(secret)).status, 200, 'a bare printed code opens the menu');
    assert.equal((await session(`shop7.${secret}`)).status, 404, 'a prefixed code is refused by a shop with no reference');

    // ---- Once registered -------------------------------------------------
    upsertSettings({ cloud_store_ref: 'shop7' });
    assert.equal(tokens.getStoreRef(), 'shop7');
    assert.equal(tokens.qualifyGuestToken(secret), `shop7.${secret}`, 'new printouts carry the store reference');

    assert.equal((await session(`shop7.${secret}`)).status, 200, 'our own qualified code works');
    assert.equal((await session(secret)).status, 200, 'codes printed before registration keep working');
    // The isolation rule this whole format exists for.
    assert.equal((await session(`shop8.${secret}`)).status, 404, "another shop's prefix opens nothing, even with a valid secret");

    // A store reference that is not a valid reference must not be honoured.
    upsertSettings({ cloud_store_ref: 'not a ref!' });
    assert.equal(tokens.getStoreRef(), '', 'a malformed store reference is treated as absent');
    upsertSettings({ cloud_store_ref: 'shop7' });

    // ---- What the cloud is allowed to hold -------------------------------
    const snapshot = publicOrderingSnapshot('THB', 'th');
    const product = snapshot.products.find((item) => item.id === 'prod-mt');
    assert.ok(product, 'the sellable product is in the snapshot');
    for (const forbidden of ['cost', 'cost_price', 'stock_quantity', 'sku', 'supplier_id']) {
      assert.equal(forbidden in (product as Record<string, unknown>), false, `${forbidden} never reaches the cloud`);
    }

    const [table] = publicTables();
    assert.equal(table.number, 'M1');
    assert.equal(
      table.token_hash,
      createHash('sha256').update(`shop7.${secret}`).digest('hex'),
      'the table is identified by the hash of its qualified code',
    );
    const asText = JSON.stringify(snapshot);
    assert.equal(asText.includes(secret), false, 'the token itself is never in the snapshot');
    assert.equal(asText.includes('SKU-MT-1'), false, 'no stray SKU anywhere in the payload');
    assert.equal(asText.includes('Snapshot Coffee'), true, 'sanity: the snapshot does carry the menu');

    assert.equal(snapshotDigest(snapshot), snapshotDigest(publicOrderingSnapshot('THB', 'th')), 'an unchanged menu digests identically');
    db.prepare("UPDATE products SET price = 75 WHERE id = 'prod-mt'").run();
    assert.notEqual(snapshotDigest(snapshot), snapshotDigest(publicOrderingSnapshot('THB', 'th')), 'a price change changes the digest');

    // ---- The portal stays read-only --------------------------------------
    // Phase 1 adds no way for the cloud to write into this POS. If a write
    // command ever appears, it has to be a deliberate, reviewed change.
    const cloudSyncSource = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'cloud-sync.ts'), 'utf8');
    const handledCommands = [...cloudSyncSource.matchAll(/case '([a-z_]+\.[a-z_]+)':/g)].map((match) => match[1]);
    assert.ok(handledCommands.length > 0, 'sanity: the command switch was found');
    for (const command of handledCommands) {
      assert.match(
        command,
        /^(health|orders|report)\./,
        `unexpected cloud command "${command}" — phase 1 keeps the cloud read-only`,
      );
    }
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
