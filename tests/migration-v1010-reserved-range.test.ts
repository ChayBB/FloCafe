/**
 * Migration v1010 coverage: the last fork-numbering repair.
 *
 * This fork collided with upstream's migration numbers three times — v87-v94,
 * then v99-v107, then v114-v115. Each time a till that upgraded through the
 * fork recorded a user_version at or above upstream's next migration, and
 * `runMigrations()` skips anything at or below the stored version permanently,
 * so those upstream migrations could never run on that machine again.
 *
 * The fork's own migrations now live at v1000+, a range upstream will not
 * reach, so a fourth collision cannot happen. v1010 replays upstream's v114 and
 * v115 for the stores that skipped them, and leaves every other store alone.
 *
 * The affected state is reproduced here by dropping what upstream's v114-v115
 * create and winding `user_version` back to 123 — the number the fork's old
 * numbering left behind.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v1010-a-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initDatabase,
  getDatabase,
  getCurrentSchemaVersion,
  MIGRATIONS,
  closeDatabase,
} = require('../main/db');

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

/** What upstream's v114 and v115 create; `orders_search_fts` is the repair's sentinel. */
const UPSTREAM_OBJECTS = ['idx_order_audit_log_item', 'orders_search_fts'];
const UPSTREAM_TRIGGERS = ['trg_orders_search_ai', 'trg_orders_search_ad', 'trg_orders_search_au'];
const FORK_TABLES = ['table_users', 'staff_work_logs'];

function exists(db: any, name: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name));
}

function runPendingMigrations(): void {
  const db = getDatabase();
  for (const migration of MIGRATIONS) {
    if (migration.version <= getCurrentSchemaVersion()) continue;
    db.transaction(() => {
      migration.up();
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}

const TAIL = () => MIGRATIONS[MIGRATIONS.length - 1].version;

function main(): void {
  try {
    console.log("\n1. a store left at the fork's old v123 gets upstream v114-v115 back");
    initDatabase();
    let db = getDatabase();
    assert(
      getCurrentSchemaVersion() === TAIL(),
      'sanity: a fresh install reaches the registry tail',
    );

    db.pragma('foreign_keys = OFF');
    for (const trigger of UPSTREAM_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    db.exec('DROP TABLE IF EXISTS orders_search_fts');
    db.exec('DROP INDEX IF EXISTS idx_order_audit_log_item');
    db.pragma('foreign_keys = ON');
    db.pragma('user_version = 123');

    assert(getCurrentSchemaVersion() === 123, 'the store now looks like the fork left it, at v123');
    for (const name of UPSTREAM_OBJECTS) {
      assert(!exists(db, name), `${name} is absent, as on a store that skipped upstream v114-v115`);
    }
    for (const table of FORK_TABLES) {
      assert(exists(db, table), `${table} is present — the fork's own migration had run`);
    }

    runPendingMigrations();
    db = getDatabase();

    assert(getCurrentSchemaVersion() === TAIL(), 'the store ends at the registry tail again');
    for (const name of UPSTREAM_OBJECTS) {
      assert(exists(db, name), `${name} is restored by the v1010 repair`);
    }
    for (const trigger of UPSTREAM_TRIGGERS) {
      assert(exists(db, trigger), `${trigger} is restored with its table`);
    }
    for (const table of FORK_TABLES) {
      assert(exists(db, table), `${table} survived the repair`);
    }
    assert(
      (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
        .integrity_check === 'ok',
      'the repaired database passes integrity_check',
    );

    closeDatabase();

    console.log('\n2. a store that never skipped anything is left alone');
    activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v1010-b-'));
    initDatabase();
    db = getDatabase();

    const repair = MIGRATIONS.find((m: any) => m.version === 1010);
    assert(Boolean(repair), 'v1010 is in the registry');
    assert(
      repair?.name === 'repair_upstream_v114_v115_skipped_by_fork_numbering',
      'v1010 is the repair, not an unrelated migration that drifted into the slot',
    );
    let threw = false;
    try {
      repair.up();
    } catch (error) {
      threw = true;
      console.error('   ', (error as Error).message);
    }
    assert(!threw, 'running v1010 on an already-complete store throws nothing');
    for (const name of UPSTREAM_OBJECTS)
      assert(exists(db, name), `${name} is still present afterwards`);

    console.log('\n3. the reserved range keeps upstream and the fork apart');
    const versions = MIGRATIONS.map((m: any) => m.version);
    assert(new Set(versions).size === versions.length, 'no migration version is used twice');
    assert(
      versions.every((v: number, i: number) => i === 0 || v > versions[i - 1]),
      'the registry is strictly ascending',
    );
    const upstreamTail = Math.max(...versions.filter((v: number) => v < 1000));
    const forkHead = Math.min(...versions.filter((v: number) => v >= 1000));
    assert(forkHead === 1000, "the fork's own migrations start at the reserved 1000");
    assert(
      upstreamTail < 1000,
      `upstream's tail (v${upstreamTail}) stays below the reserved range, so it can keep numbering freely`,
    );
    assert(
      forkHead - upstreamTail > 500,
      "the gap is wide enough that upstream cannot grow into the fork's range by accident",
    );

    closeDatabase();
  } finally {
    try {
      closeDatabase();
    } catch {
      /* already closed */
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
