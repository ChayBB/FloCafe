/**
 * Migrations v1011 and v1012: products carry a minimum and a maximum sale quantity.
 *
 * Two paths have to agree. A fresh install builds the table from the canonical
 * schema; an existing till gets the column by ALTER. A column present in one and
 * not the other is the bug this pins — the fork has shipped that before.
 *
 * Every existing product must come out with 0, meaning no floor. Giving stock a
 * minimum it never had would start refusing orders a till already takes.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-v1011-fresh-'));

Module._load = function (request: string) {
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

function column(db: any, name: string): { type: string; dflt_value: string } | undefined {
  return db
    .prepare('PRAGMA table_info(products)')
    .all()
    .find((entry: any) => entry.name === name);
}

function main(): void {
  try {
    console.log('\n1. a fresh install has the column');
    initDatabase();
    let db = getDatabase();
    const fresh = column(db, 'min_quantity');
    assert(Boolean(fresh), 'products.min_quantity exists on a fresh install');
    assert(fresh?.type === 'REAL', 'it holds a fractional quantity, not a whole one');
    assert(String(fresh?.dflt_value) === '0', 'and defaults to 0, meaning no floor');
    closeDatabase();

    console.log('\n2. an existing till gets it by ALTER, and its stock keeps no floor');
    activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-v1011-upgrade-'));
    initDatabase();
    db = getDatabase();
    db.prepare(
      "INSERT INTO products (id, name, price, is_active, created_at, updated_at) VALUES ('p-old', 'Existing fish', 100, 1, datetime('now'), datetime('now'))",
    ).run();

    // Wind back to before this migration, as a till that has not taken it yet.
    db.exec('ALTER TABLE products DROP COLUMN min_quantity');
    db.pragma('user_version = 1010');
    assert(!column(db, 'min_quantity'), 'the column is absent, as on a till at v1010');

    const migration = MIGRATIONS.find((entry: any) => entry.version === 1011);
    assert(Boolean(migration), 'v1011 is in the registry');
    assert(
      migration?.name === 'add_product_min_quantity',
      'v1011 is this migration, not another that drifted into the slot',
    );
    migration.up();
    db.pragma(`user_version = ${MIGRATIONS[MIGRATIONS.length - 1].version}`);

    const upgraded = column(db, 'min_quantity');
    assert(Boolean(upgraded), 'the column is added by the migration');
    assert(upgraded?.type === 'REAL', 'with the same type the fresh schema uses');
    assert(
      String(upgraded?.dflt_value) === '0',
      'and the same default, so both paths describe one schema',
    );
    assert(
      (db.prepare("SELECT min_quantity AS m FROM products WHERE id = 'p-old'").get() as any).m ===
        0,
      'a product that predates the column has no floor',
    );

    // Replaying a migration is normal during repair; it must not throw.
    let threw = false;
    try {
      migration.up();
    } catch (error) {
      threw = true;
      console.error('   ', (error as Error).message);
    }
    assert(!threw, 'running it again on a migrated database throws nothing');

    console.log('\n3. v1012 adds the ceiling the same way');
    const freshMax = column(db, 'max_quantity');
    assert(Boolean(freshMax), 'products.max_quantity exists');
    assert(freshMax?.type === 'REAL', 'it holds a fractional quantity too');
    assert(String(freshMax?.dflt_value) === '0', 'and defaults to 0, meaning no cap');

    db.exec('ALTER TABLE products DROP COLUMN max_quantity');
    const capMigration = MIGRATIONS.find((entry: any) => entry.version === 1012);
    assert(Boolean(capMigration), 'v1012 is in the registry');
    assert(
      capMigration?.name === 'add_product_max_quantity',
      'v1012 is this migration, not another that drifted into the slot',
    );
    capMigration.up();
    db.pragma(`user_version = ${MIGRATIONS[MIGRATIONS.length - 1].version}`);
    assert(Boolean(column(db, 'max_quantity')), 'the cap column is added by the migration');
    assert(
      (db.prepare("SELECT max_quantity AS m FROM products WHERE id = 'p-old'").get() as any).m ===
        0,
      'a product that predates the column has no cap',
    );

    console.log('\n4. v1013 marks a line as awaiting its weight');
    const pendingColumn = db
      .prepare('PRAGMA table_info(order_items)')
      .all()
      .find((entry: any) => entry.name === 'weight_pending');
    assert(Boolean(pendingColumn), 'order_items.weight_pending exists');
    assert(
      String(pendingColumn?.dflt_value) === '0',
      'and defaults to 0, so no existing line is owed a weight',
    );
    const pendingMigration = MIGRATIONS.find((entry: any) => entry.version === 1013);
    assert(Boolean(pendingMigration), 'v1013 is in the registry');
    assert(
      pendingMigration?.name === 'add_order_item_weight_pending',
      'v1013 is this migration, not another that drifted into the slot',
    );
    let pendingThrew = false;
    try {
      pendingMigration.up();
    } catch {
      pendingThrew = true;
    }
    assert(!pendingThrew, 'running it again on a migrated database throws nothing');

    console.log('\n5. the bounds the columns accept');
    db.prepare(
      "INSERT INTO products (id, name, price, min_quantity, is_active, created_at, updated_at) VALUES ('p-fish', 'ปลากะพง', 100, 0.5, 1, datetime('now'), datetime('now'))",
    ).run();
    assert(
      (db.prepare("SELECT min_quantity AS m FROM products WHERE id = 'p-fish'").get() as any).m ===
        0.5,
      'a fractional minimum is stored as given',
    );
    let rejected = false;
    try {
      db.prepare(
        "INSERT INTO products (id, name, price, min_quantity, is_active, created_at, updated_at) VALUES ('p-bad', 'Bad', 10, -1, 1, datetime('now'), datetime('now'))",
      ).run();
    } catch {
      rejected = true;
    }
    assert(rejected, 'a negative minimum is refused by the constraint');

    assert(
      getCurrentSchemaVersion() === MIGRATIONS[MIGRATIONS.length - 1].version,
      'the database ends at the registry tail',
    );
    assert(
      (db.prepare('PRAGMA integrity_check').get() as any).integrity_check === 'ok',
      'the migrated database passes integrity_check',
    );
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
