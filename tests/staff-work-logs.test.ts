/**
 * Staff attendance: the Server App records arrivals and departures, and the
 * month view turns them into shifts and hours.
 *
 * The parts worth pinning are the awkward ones — a shift still running, a
 * missed logout, and a logout whose login sits in the previous month.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-work-logs-'));

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

async function call(baseUrl: string, pathName: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await response.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, body };
}

async function main() {
  console.log('Integration Test: Staff work logs');
  console.log('='.repeat(34));

  process.env.PORT = String(await getFreeTcpPort());
  process.env.SERVER_APP_PORT = String(await getFreeTcpPort());

  const bcrypt = require('bcryptjs');
  const { initDatabase, getDatabase, closeDatabase, now } = await import('../main/db');
  const { startServer, stopServer, getServerPort } = await import('../main/server');
  const { startServerApp, stopServerApp, getServerAppPort } = await import('../main/server-app');

  initDatabase();
  const db = getDatabase();

  const hash = bcrypt.hashSync('WorkLog123!', 10);
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('wl-owner', 'Owner', 'owner@worklog.test', ?, 'owner', 1, ?, ?)
  `).run(hash, now(), now());
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('wl-server', 'Nok', 'nok@worklog.test', ?, 'server', 1, ?, ?)
  `).run(hash, now(), now());
  // No email at all — this person signs in with a username.
  db.prepare(`
    INSERT INTO users (id, name, email, username, password, role, is_active, created_at, updated_at)
    VALUES ('wl-noemail', 'Fon', NULL, 'fon.server', ?, 'server', 1, ?, ?)
  `).run(hash, now(), now());
  // Signs in with a Thai nickname, the way the shop's staff actually would.
  db.prepare(`
    INSERT INTO users (id, name, email, username, password, role, is_active, created_at, updated_at)
    VALUES ('wl-thai', 'นกสมใจ', NULL, 'นกสมใจ', ?, 'server', 1, ?, ?)
  `).run(hash, now(), now());

  await startServer();
  await startServerApp();
  const posUrl = `http://127.0.0.1:${getServerPort()}`;
  const appUrl = `http://127.0.0.1:${getServerAppPort()}`;

  try {
    console.log('\n1. signing in on the Server App records an arrival');
    const login = await call(appUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'nok@worklog.test', password: 'WorkLog123!' }),
    });
    assert.equal(login.status, 200, 'the server signs in');
    const events = db.prepare("SELECT event_type, source FROM staff_work_logs WHERE user_id = 'wl-server'").all() as any[];
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'login');
    assert.equal(events[0].source, 'server_app', 'the surface is recorded so the POS can share this table later');

    console.log('\n2. a failed sign-in records nothing');
    await call(appUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'nok@worklog.test', password: 'wrong-password' }),
    });
    assert.equal(
      (db.prepare("SELECT COUNT(*) c FROM staff_work_logs WHERE user_id = 'wl-server'").get() as any).c,
      1,
      'a rejected password is not an arrival',
    );

    console.log('\n3. signing out closes the shift');
    const out = await call(appUrl, '/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.body.access_token}` },
    });
    assert.equal(out.status, 200);
    assert.equal(
      (db.prepare("SELECT COUNT(*) c FROM staff_work_logs WHERE user_id = 'wl-server' AND event_type = 'logout'").get() as any).c,
      1,
    );

    console.log('\n4. the month view pairs events into shifts');
    const owner = await call(posUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'owner@worklog.test', password: 'WorkLog123!' }),
    });
    assert.equal(owner.status, 200, 'the owner signs in on the POS');
    const auth = { Authorization: `Bearer ${owner.body.access_token}` };

    // A tidy full shift, a shift still running, and a logout whose login sits
    // in the previous month.
    const insert = db.prepare("INSERT INTO staff_work_logs (user_id, event_type, source, created_at) VALUES (?, ?, 'server_app', ?)");
    insert.run('wl-server', 'login', '2026-03-04 09:00:00');
    insert.run('wl-server', 'logout', '2026-03-04 17:30:00');
    insert.run('wl-server', 'login', '2026-03-05 10:00:00');
    insert.run('wl-owner', 'logout', '2026-03-01 02:00:00');

    const report = await call(posUrl, '/api/staff/work-logs?year=2026&month=03', { headers: auth });
    assert.equal(report.status, 200);

    const march = report.body.shifts.filter((s: any) => s.user_id === 'wl-server');
    assert.equal(march.length, 2, 'two shifts in March');

    const full = march.find((s: any) => s.date === '2026-03-04');
    assert.equal(full.minutes, 510, 'a 09:00-17:30 shift is 8h30m');

    const open = march.find((s: any) => s.date === '2026-03-05');
    assert.equal(open.end, null, 'a shift with no logout stays open');
    assert.equal(open.minutes, null, 'and contributes no hours rather than a made-up number');

    const nok = report.body.by_staff.find((s: any) => s.user_id === 'wl-server');
    assert.equal(nok.minutes, 510, 'the roll-up counts only closed shifts');
    assert.equal(nok.open, 1, 'and says how many are still open');
    assert.equal(report.body.by_day['2026-03-04'], 510);

    assert.equal(
      report.body.shifts.some((s: any) => s.user_id === 'wl-owner'),
      false,
      'a logout with no matching login is not invented into a shift',
    );

    console.log('\n5. a staff member with no email signs in with a username');
    const byUsername = await call(appUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'fon.server', password: 'WorkLog123!' }),
    });
    assert.equal(byUsername.status, 200, 'a username works where an email would');
    assert.equal(byUsername.body.user.name, 'Fon');
    assert.equal(
      (db.prepare("SELECT COUNT(*) c FROM staff_work_logs WHERE user_id = 'wl-noemail'").get() as any).c,
      1,
      'and their hours are recorded the same way',
    );

    const wrongCase = await call(appUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'FON.SERVER', password: 'WorkLog123!' }),
    });
    assert.equal(wrongCase.status, 200, 'a username is matched case-insensitively');

    console.log('\n6. a Thai username signs in');
    const thai = await call(appUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'นกสมใจ', password: 'WorkLog123!' }),
    });
    assert.equal(thai.status, 200, 'a Thai username works at the Server App login');
    assert.equal(thai.body.user.name, 'นกสมใจ');
    assert.equal(
      (db.prepare("SELECT COUNT(*) c FROM staff_work_logs WHERE user_id = 'wl-thai'").get() as any).c,
      1,
      'and their hours are recorded like anyone else',
    );

    const padded = await call(appUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: '  นกสมใจ  ', password: 'WorkLog123!' }),
    });
    assert.equal(padded.status, 200, 'stray whitespace around a typed username is forgiven');

    console.log('\n7. attendance is owner/manager only');
    const asServer = await call(posUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'nok@worklog.test', password: 'WorkLog123!' }),
    });
    const denied = await call(posUrl, '/api/staff/work-logs', {
      headers: { Authorization: `Bearer ${asServer.body.access_token}` },
    });
    assert.equal(denied.status, 403, 'a server cannot read the whole shop hours sheet');

    console.log('\n8. a malformed month is refused');
    for (const query of ['?year=26&month=03', '?year=2026&month=13', '?year=2026&month=0']) {
      assert.equal((await call(posUrl, `/api/staff/work-logs${query}`, { headers: auth })).status, 400, query);
    }
  } finally {
    await stopServerApp();
    await stopServer();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  console.log('\nALL PASSED');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
