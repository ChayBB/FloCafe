/**
 * Migration v107 coverage: the fork-numbering repair.
 *
 * This fork once numbered its own eight migrations v87-v94 — the same numbers
 * upstream had used for entirely different schema changes. A till that upgraded
 * through the fork therefore reached `user_version = 94` with the fork's tables
 * applied and upstream's v87-v94 never run. `runMigrations()` skips anything at
 * or below the current version, so without a repair those eight would never run
 * again on that machine: no supplies, no recipes, no cash sessions, no
 * configurable permissions, no delivery address, for the life of the install.
 *
 * The eight have since moved to v99-v106. v107 replays upstream's v87-v94 for
 * exactly the stores that skipped them, and leaves every other store alone.
 *
 * The affected state is reproduced here by dropping what upstream's v87-v94
 * create and winding `user_version` back — that absence *is* the condition, and
 * it is what the repair has to detect and undo. Running the migrations
 * partially is not possible from outside the module, which owns the handle the
 * migration bodies close over.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v107-a-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, getCurrentSchemaVersion, MIGRATIONS, closeDatabase } = require('../main/db');

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

/**
 * Every table upstream's v87-v94 create, in an order that can be dropped with
 * foreign keys still on: children before the rows they point at.
 */
const UPSTREAM_TABLES = [
  'recipe_items',
  'recipes',
  'supply_movements',
  'supplies',
  'user_permission_overrides',
  'role_permission_overrides',
  'authorization_audit_log',
  'cash_sessions',
];

/** Tables this branch's own migrations create, now at v99-v106. */
const FORK_TABLES = ['table_users', 'staff_work_logs'];

function hasTable(db: any, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function hasColumn(db: any, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .some((row) => row.name === column);
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
    assert(getCurrentSchemaVersion() === TAIL(), 'sanity: a fresh install reaches the registry tail');

    db.pragma('foreign_keys = OFF');
    for (const table of UPSTREAM_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.pragma('foreign_keys = ON');
    db.pragma('user_version = 94');

    assert(getCurrentSchemaVersion() === 94, 'the store now looks like the fork left it, at v94');
    for (const table of UPSTREAM_TABLES) {
      assert(!hasTable(db, table), `${table} is absent, as on a store that skipped upstream v87-v94`);
    }
    for (const table of FORK_TABLES) {
      assert(hasTable(db, table), `${table} is present — the fork's own migration had run`);
    }

    runPendingMigrations();
    db = getDatabase();

    assert(getCurrentSchemaVersion() === TAIL(), 'the store ends at the registry tail again');
    for (const table of UPSTREAM_TABLES) {
      assert(hasTable(db, table), `${table} exists after the v107 repair`);
    }
    for (const table of FORK_TABLES) {
      assert(hasTable(db, table), `${table} survived the repair`);
    }
    assert(hasColumn(db, 'users', 'username'),
      "the fork's own username column is untouched");

    closeDatabase();

    console.log('\n2. a store that never skipped anything is left alone');
    activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v107-b-'));
    initDatabase();
    db = getDatabase();

    for (const table of [...UPSTREAM_TABLES, ...FORK_TABLES]) {
      assert(hasTable(db, table), `${table} exists on a fresh install`);
    }

    // The sentinel the repair reads is `supplies`. It is present here, so the
    // repair must decline to do anything — including on a second call, since a
    // store that already has upstream's tables must never have their bodies
    // replayed over live data.
    const repair = MIGRATIONS.find((m: any) => m.version === 107);
    assert(Boolean(repair), 'v107 is in the registry');
    const suppliesBefore = db.prepare('SELECT COUNT(*) AS c FROM supplies').get() as { c: number };
    let threw = false;
    try {
      repair.up();
    } catch (error) {
      threw = true;
      console.error('   ', (error as Error).message);
    }
    assert(!threw, 'running v107 on an already-complete store throws nothing');
    const suppliesAfter = db.prepare('SELECT COUNT(*) AS c FROM supplies').get() as { c: number };
    assert(suppliesBefore.c === suppliesAfter.c, 'and changes nothing');

    closeDatabase();
  } finally {
    try { closeDatabase(); } catch { /* already closed */ }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
