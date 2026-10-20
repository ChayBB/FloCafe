/**
 * An order event is only queued for the cloud when the cloud accepts order events.
 *
 * The outbox has no expiry: a row that cannot be delivered is retried for the
 * life of the install. A store whose cloud account has order sync switched off
 * answers `POST /api/pos/events` with 404, so every order written on that till
 * used to land in the queue and stay there, retried forever and logged forever.
 *
 * Only order events are gated. Public-ordering snapshots carry the menu, not
 * orders, and have their own switch (`isGuestOrderingEnabled`), so they must
 * keep queueing when order sync is off.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cloud-outbox-gate-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'keychain',
        encryptString: (value: string) => Buffer.from(value, 'utf8'),
        decryptString: (value: Buffer) => value.toString('utf8'),
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  getDatabase,
  closeDatabase,
  now,
  assertEqualOrThrow: assertEqual,
  assertOrThrow: customAssert,
} = require('./helpers/test-setup');
const { CloudSyncService } = require('../main/services/cloud-sync');

function setSetting(key: string, value: string): void {
  getDatabase()
    .prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    .run(key, value, now());
}

function outboxRows(): { event_type: string; entity_type: string }[] {
  return getDatabase()
    .prepare('SELECT event_type, entity_type FROM cloud_sync_outbox ORDER BY created_at ASC')
    .all() as { event_type: string; entity_type: string }[];
}

/** `enqueueEvent` dispatches onto the service's background set; wait it out. */
async function settle(service: any): Promise<void> {
  for (let attempt = 0; attempt < 50 && service.backgroundPromises.size > 0; attempt += 1) {
    await Promise.allSettled([...service.backgroundPromises]);
  }
  await new Promise((resolve) => setImmediate(resolve));
}

async function run() {
  console.log('Cloud outbox order-event gate');
  console.log('='.repeat(40));

  try {
    initTestDb();
    const service = new CloudSyncService();

    setSetting('cloud_sync_enabled', '1');
    setSetting('cloud_api_key', 'fac_test_key');
    setSetting('cloud_store_id', '1');
    setSetting('cloud_pos_hash', 'pos_test');

    // --- order sync off: order events are dropped, store events are not ---
    setSetting('cloud_orders_enabled', '0');
    getDatabase().prepare('DELETE FROM cloud_sync_outbox').run();

    service.enqueueEvent('order.created', 'order', '1', { id: 1 });
    service.enqueueEvent('order.updated', 'order', '1', { id: 1 });
    await settle(service);

    assertEqual(
      outboxRows().length,
      0,
      'an order event is not queued while the cloud rejects order events',
    );

    service.enqueueEvent('public_ordering.snapshot', 'store', '1', { items: [] });
    await settle(service);

    const storeOnly = outboxRows();
    assertEqual(storeOnly.length, 1, 'a store event still queues when order sync is off');
    assertEqual(
      storeOnly[0].event_type,
      'public_ordering.snapshot',
      'and it is the public-ordering snapshot, which has its own switch',
    );

    // --- order sync on: order events queue as before ---
    setSetting('cloud_orders_enabled', '1');
    getDatabase().prepare('DELETE FROM cloud_sync_outbox').run();

    service.enqueueEvent('order.created', 'order', '2', { id: 2 });
    await settle(service);

    const enabled = outboxRows();
    assertEqual(enabled.length, 1, 'an order event queues once the cloud accepts them');
    assertEqual(enabled[0].entity_type, 'order', 'and it is recorded as an order event');

    // --- sync off entirely: nothing queues at all ---
    setSetting('cloud_sync_enabled', '0');
    getDatabase().prepare('DELETE FROM cloud_sync_outbox').run();

    service.enqueueEvent('order.created', 'order', '3', { id: 3 });
    service.enqueueEvent('public_ordering.snapshot', 'store', '1', { items: [] });
    await settle(service);

    assertEqual(outboxRows().length, 0, 'nothing queues while cloud sync is off');

    customAssert(true, 'all outbox gate assertions passed');
    console.log('\nAll cloud outbox gate assertions passed.');
  } finally {
    try {
      closeDatabase();
    } catch {
      /* already closed */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('\nTest failed:', error);
  process.exit(1);
});
