/**
 * Migration v123 coverage: the second fork-numbering repair.
 *
 * This fork numbered its own nine migrations v99-v107 while upstream was
 * numbering nine entirely different ones the same way. A till that upgraded
 * through the fork therefore reached `user_version = 107` with the fork's
 * schema applied and upstream's v99-v107 never run. `runMigrations()` skips
 * anything at or below the stored version, so without a repair those nine would
 * never run again on that machine: no product variants, no add-on inventory, no
 * charge breakdowns, no delivery notes, for the life of the install.
 *
 * The fork's nine have since moved to v114-v122. v123 replays upstream's
 * v99-v107 for exactly the stores that skipped them, and leaves every other
 * store alone.
 *
 * The affected state is reproduced here by removing what upstream's v99-v107
 * create and winding `user_version` back — that absence *is* the condition the
 * repair detects. Running the migrations partially is not possible from outside
 * the module, which owns the handle the migration bodies close over.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v123-a-'));

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

/** The only table upstream's v99-v107 create; it is also the repair's sentinel. */
const UPSTREAM_TABLE = 'product_variants';

/** Every column upstream's v99-v107 add, as `table.column`. */
const UPSTREAM_COLUMNS: Array<[string, string]> = [
  ['orders', 'charges_breakdown'],
  ['bills', 'charges_breakdown'],
  ['order_items', 'variant_id'],
  ['products', 'dietary_tags'],
  ['inventory_movements', 'variant_id'],
  ['order_items', 'inventory_variant_id'],
  ['orders', 'expected_payment_method'],
  ['orders', 'delivery_note'],
  ['order_item_addons', 'inventory_deducted_quantity'],
  ['inventory_movements', 'addon_id'],
  ['held_orders', 'waived_charge_ids'],
  ['held_orders', 'opted_in_charge_ids'],
  ['orders', 'expected_payment_method_id'],
];

/** Schema this branch's own migrations create, now at v114-v122. */
const FORK_TABLES = ['table_users', 'staff_work_logs'];
const FORK_COLUMNS: Array<[string, string]> = [
  ['tables', 'guest_token'],
  ['tables', 'guest_round'],
  ['users', 'username'],
  ['order_items', 'unit_cost'],
];

function hasTable(db: any, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function hasColumn(db: any, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
    (row) => row.name === column,
  );
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
    console.log('\n1. a store that upgraded through the fork gets the skipped migrations back');
    initDatabase();
    let db = getDatabase();
    assert(
      getCurrentSchemaVersion() === TAIL(),
      'sanity: a fresh install reaches the registry tail',
    );

    // Reproduce the state the fork's own v99-v107 left behind.
    db.pragma('foreign_keys = OFF');
    db.exec(`DROP TABLE IF EXISTS ${UPSTREAM_TABLE}`);
    for (const [table, column] of UPSTREAM_COLUMNS) {
      if (hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    db.pragma('foreign_keys = ON');
    db.pragma('user_version = 107');

    assert(getCurrentSchemaVersion() === 107, 'the store now looks like the fork left it, at v107');
    assert(
      !hasTable(db, UPSTREAM_TABLE),
      `${UPSTREAM_TABLE} is absent, as on a store that skipped upstream v99-v107`,
    );
    for (const [table, column] of UPSTREAM_COLUMNS) {
      assert(!hasColumn(db, table, column), `${table}.${column} is absent before the repair`);
    }
    for (const table of FORK_TABLES) {
      assert(hasTable(db, table), `${table} is present — the fork's own migration had run`);
    }

    runPendingMigrations();
    db = getDatabase();

    assert(getCurrentSchemaVersion() === TAIL(), 'the store ends at the registry tail again');
    assert(hasTable(db, UPSTREAM_TABLE), `${UPSTREAM_TABLE} exists after the v123 repair`);
    for (const [table, column] of UPSTREAM_COLUMNS) {
      assert(hasColumn(db, table, column), `${table}.${column} is restored by the v123 repair`);
    }
    for (const table of FORK_TABLES) {
      assert(hasTable(db, table), `${table} survived the repair`);
    }
    for (const [table, column] of FORK_COLUMNS) {
      assert(hasColumn(db, table, column), `the fork's own ${table}.${column} is untouched`);
    }
    assert(
      (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
        .integrity_check === 'ok',
      'the repaired database passes integrity_check',
    );
    assert(
      (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length === 0,
      'and has no foreign key violations',
    );

    closeDatabase();

    console.log('\n2. a store that never skipped anything is left alone');
    activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v123-b-'));
    initDatabase();
    db = getDatabase();

    assert(hasTable(db, UPSTREAM_TABLE), `${UPSTREAM_TABLE} exists on a fresh install`);
    for (const table of FORK_TABLES) {
      assert(hasTable(db, table), `${table} exists on a fresh install`);
    }

    // The sentinel the repair reads is `product_variants`. It is present here,
    // so the repair must decline to do anything — including on a second call,
    // since a store that already has upstream's schema must never have their
    // bodies replayed over live data.
    const repair = MIGRATIONS.find((m: any) => m.version === 123);
    assert(Boolean(repair), 'v123 is in the registry');
    assert(
      repair?.name === 'repair_upstream_v99_to_v107_skipped_by_fork_numbering',
      'v123 is the repair, not an unrelated migration that drifted into the slot',
    );
    const variantsBefore = db.prepare(`SELECT COUNT(*) AS c FROM ${UPSTREAM_TABLE}`).get() as {
      c: number;
    };
    let threw = false;
    try {
      repair.up();
    } catch (error) {
      threw = true;
      console.error('   ', (error as Error).message);
    }
    assert(!threw, 'running v123 on an already-complete store throws nothing');
    const variantsAfter = db.prepare(`SELECT COUNT(*) AS c FROM ${UPSTREAM_TABLE}`).get() as {
      c: number;
    };
    assert(variantsBefore.c === variantsAfter.c, 'and changes nothing');

    console.log('\n3. the renumbering itself holds');
    const versions = MIGRATIONS.map((m: any) => m.version);
    assert(new Set(versions).size === versions.length, 'no migration version is used twice');
    assert(
      versions.every((v: number, i: number) => i === 0 || v > versions[i - 1]),
      'the registry is strictly ascending',
    );
    for (let version = 114; version <= 122; version++) {
      assert(versions.includes(version), `the fork's renumbered v${version} is registered`);
    }

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
