/** Staff management API (alias for /api/users). */
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { getDatabase, now, withTxn } from '../db';
import { requireRole, validatePassword, authRateLimit, invalidateUserAuthCache } from '../middleware/security';
import { isValidEmail } from './auth';
import { ROLE_ACCESS, ROLE_KEYS, OPERATIONAL_ROLES, hasRole } from '../../shared/role-permissions';

const router = Router();

const VALID_ROLES: readonly string[] = ROLE_KEYS;
const STAFF_SELECT_FIELDS = 'id, name, email, username, role, (pin_hash IS NOT NULL) AS has_pin, is_active, created_at, updated_at';

function canModifyTargetStaff(requesterRole: string, targetRole: string): boolean {
  if (requesterRole === 'owner') return true;
  if (requesterRole === 'manager') return !hasRole(targetRole, ROLE_ACCESS.ownerManager);
  return false;
}

function isOperationalRole(role: string): boolean {
  return hasRole(role, OPERATIONAL_ROLES);
}

function hasNonEmptyPin(pin: unknown): boolean {
  return pin !== undefined && pin !== null && String(pin).length > 0;
}

function isValidPin(pin: unknown): boolean {
  return /^\d{4,6}$/.test(String(pin));
}

/** Records why a staff write was refused; 4xx bodies alone never reach the app log. */
function logStaffRejection(action: string, reason: string, email: string): void {
  console.warn(`[Staff] ${action} refused: ${reason} (email: ${email || 'empty'})`);
}

function normalizeStaffEmail(email: unknown): string {
  return String(email || '').trim().toLowerCase();
}

function normalizeUsername(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * Letters, digits, dot, dash and underscore — no spaces and no `@`.
 *
 * The `@` matters: sign-in accepts either identifier, so a username shaped like
 * an email address would make one typed string ambiguous between two people.
 */
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;

/**
 * An account needs at least one way to sign in.
 *
 * Email used to be mandatory, which suited shops whose staff all have one and
 * nobody else. Either identifier is now enough — but not neither, because an
 * account with no identifier can be created and then never used, which looks
 * like a bug long after the person who created it has forgotten.
 */
function identifierErrors(
  db: ReturnType<typeof getDatabase>,
  email: string,
  username: string,
  excludeUserId?: string,
): string | null {
  if (!email && !username) return 'An email address or a username is required';
  if (email && !isValidEmail(email)) return 'Enter a valid email address';
  if (username && !USERNAME_PATTERN.test(username)) {
    return 'Username must be 3-32 characters using letters, numbers, dot, dash or underscore';
  }

  const clash = (value: string) => {
    const rows = excludeUserId
      ? db.prepare('SELECT id FROM users WHERE (LOWER(email) = ? OR LOWER(username) = ?) AND id != ?').get(value.toLowerCase(), value.toLowerCase(), excludeUserId)
      : db.prepare('SELECT id FROM users WHERE LOWER(email) = ? OR LOWER(username) = ?').get(value.toLowerCase(), value.toLowerCase());
    return Boolean(rows);
  };

  // Checked across both columns: a username that matches someone's email (or
  // the reverse) would resolve one typed string to two accounts at sign-in.
  if (email && clash(email)) return 'Email already in use';
  if (username && clash(username)) return 'Username already in use';
  return null;
}

// ── Work log ──────────────────────────────────────────────────────────────────

type WorkEvent = { user_id: string; user_name: string; event_type: string; created_at: string };
type Shift = { user_id: string; user_name: string; date: string; start: string; end: string | null; minutes: number | null };

/**
 * Turns a stream of login/logout events into shifts.
 *
 * A login with no logout after it is an open shift — someone still on the floor,
 * or someone who closed the browser without signing out. It is returned with
 * `end: null` rather than being dropped or silently closed at midnight, because
 * a manager needs to see the difference between "still working" and "forgot to
 * sign out" instead of the day quietly under-counting.
 *
 * A second login with no logout in between closes nothing: the first shift stays
 * open. Two devices, one person, is the normal cause.
 */
function pairShifts(events: WorkEvent[]): Shift[] {
  const shifts: Shift[] = [];
  const openByUser = new Map<string, Shift>();

  for (const event of events) {
    if (event.event_type === 'login') {
      if (openByUser.has(event.user_id)) continue;
      const shift: Shift = {
        user_id: event.user_id,
        user_name: event.user_name,
        date: event.created_at.slice(0, 10),
        start: event.created_at,
        end: null,
        minutes: null,
      };
      openByUser.set(event.user_id, shift);
      shifts.push(shift);
      continue;
    }

    const open = openByUser.get(event.user_id);
    if (!open) continue; // a logout with no matching login (e.g. signed in before this window)
    open.end = event.created_at;
    // Both timestamps are SQLite's UTC `YYYY-MM-DD HH:MM:SS`, which Date.parse
    // reads as local time. That cancels out in a difference, but only because
    // both sides are parsed the same way — do not mix in an ISO value here.
    const minutes = Math.round((Date.parse(open.end) - Date.parse(open.start)) / 60000);
    open.minutes = Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
    openByUser.delete(event.user_id);
  }

  return shifts;
}

/** Staff attendance for one month, as shifts plus a per-day and per-person roll-up. */
router.get('/work-logs', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const nowDate = new Date();
    const year = String(req.query.year ?? nowDate.getFullYear());
    const month = String(req.query.month ?? nowDate.getMonth() + 1).padStart(2, '0');
    if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'year must be YYYY and month must be 01-12' });
    }

    const db = getDatabase();
    // A shift can start in one month and end in the next, so the window opens a
    // day early: without that, a night shift's login is missing and its logout
    // is discarded as unmatched.
    const from = `${year}-${month}-01`;
    const events = db.prepare(`
      SELECT w.user_id, u.name AS user_name, w.event_type, w.created_at
      FROM staff_work_logs w
      JOIN users u ON u.id = w.user_id
      WHERE w.created_at >= date(?, '-1 day')
        AND w.created_at < date(?, '+1 month')
      ORDER BY w.created_at, w.id
    `).all(from, from) as WorkEvent[];

    const shifts = pairShifts(events).filter((shift) => shift.date.startsWith(`${year}-${month}`));

    const byDay: Record<string, number> = {};
    const byStaff: Record<string, { user_id: string; user_name: string; minutes: number; shifts: number; open: number }> = {};
    for (const shift of shifts) {
      byDay[shift.date] = (byDay[shift.date] ?? 0) + (shift.minutes ?? 0);
      const entry = byStaff[shift.user_id] ??= { user_id: shift.user_id, user_name: shift.user_name, minutes: 0, shifts: 0, open: 0 };
      entry.minutes += shift.minutes ?? 0;
      entry.shifts += 1;
      if (shift.end === null) entry.open += 1;
    }

    res.json({
      year,
      month,
      shifts,
      by_day: byDay,
      by_staff: Object.values(byStaff).sort((a, b) => b.minutes - a.minutes),
    });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── List ──────────────────────────────────────────────────────────────────────

router.get('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    // 'guest-ordering' is a system account for customer self-orders, not a person.
    let query = `SELECT ${STAFF_SELECT_FIELDS} FROM users WHERE id <> 'guest-ordering'`;
    const params: any[] = [];

    if (req.query.role) {
      if (typeof req.query.role !== 'string' || !VALID_ROLES.includes(req.query.role)) {
        return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
      }
      query += ' AND role = ?';
      params.push(req.query.role);
    }
    if (req.query.active === 'true') {
      query += ' AND is_active = 1';
    }
    if (req.query.active === 'false') {
      query += ' AND is_active = 0';
    }

    query += ' ORDER BY role, name';

    const staff = db.prepare(query).all(...params);
    res.json({ staff });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Get one ───────────────────────────────────────────────────────────────────

router.get('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const member = db.prepare(
      `SELECT ${STAFF_SELECT_FIELDS} FROM users WHERE id = ?`
    ).get(req.params.id) as any;

    if (!member) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const performance = db.prepare(`
      SELECT COUNT(*) as orders_served, COALESCE(SUM(total), 0) as total_sales
      FROM orders
      WHERE user_id = ? AND date(created_at) = date('now')
    `).get(req.params.id);

    res.json({ staff: { ...member, performance } });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Create ────────────────────────────────────────────────────────────────────

router.post('/', requireRole(...ROLE_ACCESS.ownerManager), authRateLimit(), (req: Request, res: Response) => {
  try {
    const { name, email, username, password, role, pin } = req.body;
    const normalizedEmail = normalizeStaffEmail(email);
    const normalizedUsername = normalizeUsername(username);

    if (!name || !password || !role) {
      logStaffRejection('create', 'missing required field', normalizedEmail);
      return res.status(400).json({ error: 'name, password, and role are required' });
    }
    if (!validatePassword(password)) {
      logStaffRejection('create', 'weak password', normalizedEmail);
      return res.status(400).json({ error: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, and one number.' });
    }

    if (!VALID_ROLES.includes(role)) {
      logStaffRejection('create', 'invalid role', normalizedEmail);
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }

    const requesterRole = (req as any).user.role;
    if (requesterRole === 'manager' && !isOperationalRole(role)) {
      logStaffRejection('create', 'manager cannot create this role', normalizedEmail);
      return res.status(403).json({ error: `Managers can only create operational staff accounts (${OPERATIONAL_ROLES.join(', ')})` });
    }

    if (isOperationalRole(role) && hasNonEmptyPin(pin)) {
      logStaffRejection('create', 'pin not allowed for this role', normalizedEmail);
      return res.status(400).json({ error: 'PINs are only permitted for owner and manager roles' });
    }
    if (hasNonEmptyPin(pin) && !isValidPin(pin)) {
      logStaffRejection('create', 'invalid pin', normalizedEmail);
      return res.status(400).json({ error: 'PIN must be between 4 and 6 numeric digits' });
    }

    const db = getDatabase();

    const identifierProblem = identifierErrors(db, normalizedEmail, normalizedUsername);
    if (identifierProblem) {
      logStaffRejection('create', identifierProblem, normalizedEmail || normalizedUsername);
      return res.status(400).json({ error: identifierProblem });
    }

    const id = randomUUID();
    const hashedPassword = bcrypt.hashSync(password, 10);

    const hashedPin = hasNonEmptyPin(pin) ? bcrypt.hashSync(String(pin), 10) : null;

    // NULL, never '': `email` is UNIQUE, and SQLite treats two empty strings as
    // a collision while allowing any number of NULLs.
    db.prepare(`
      INSERT INTO users (id, name, email, username, password, role, pin_hash, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, name, normalizedEmail || null, normalizedUsername || null, hashedPassword, role, hashedPin, now(), now());

    const member = db.prepare(
      `SELECT ${STAFF_SELECT_FIELDS} FROM users WHERE id = ?`
    ).get(id);

    res.status(201).json({ staff: member });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Update ────────────────────────────────────────────────────────────────────

router.put('/:id', requireRole(...ROLE_ACCESS.ownerManager), authRateLimit(), (req: Request, res: Response) => {
  try {
    const { name, email, username, password, role, pin, is_active } = req.body;
    const emailProvided = email !== undefined;
    const normalizedEmail = emailProvided ? normalizeStaffEmail(email) : undefined;
    const usernameProvided = username !== undefined;
    const normalizedUsername = usernameProvided ? normalizeUsername(username) : undefined;
    const db = getDatabase();

    if (is_active !== undefined) {
      return res.status(400).json({ error: 'Use /deactivate or /reactivate endpoints to change account status' });
    }

    const member = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
    if (!member) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const requesterRole = (req as any).user.role;
    if (!canModifyTargetStaff(requesterRole, member.role)) {
      return res.status(403).json({ error: 'Managers cannot modify owner or manager accounts' });
    }

    if (role !== undefined) {
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
      }
      if (role !== member.role && requesterRole !== 'owner') {
        return res.status(403).json({ error: 'Only owners can change roles' });
      }
    }

    const targetRole = role ?? member.role;
    if (isOperationalRole(targetRole) && hasNonEmptyPin(pin)) {
      return res.status(400).json({ error: 'PINs are only permitted for owner and manager roles' });
    }
    if (hasNonEmptyPin(pin) && !isValidPin(pin)) {
      return res.status(400).json({ error: 'PIN must be between 4 and 6 numeric digits' });
    }

    // Whatever is not being changed keeps its current value, so clearing the
    // last identifier is caught here rather than producing an account nobody
    // can sign in to.
    const nextEmail = emailProvided ? (normalizedEmail as string) : normalizeStaffEmail(member.email);
    const nextUsername = usernameProvided ? (normalizedUsername as string) : normalizeUsername(member.username);
    const identifierProblem = identifierErrors(db, nextEmail, nextUsername, String(req.params.id));
    if (identifierProblem) {
      return res.status(400).json({ error: identifierProblem });
    }

    if (password && !validatePassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, and one number.' });
    }

    const passwordChanged = Boolean(password && (!member.password || !bcrypt.compareSync(password, member.password)));
    const hashedPassword = passwordChanged
      ? bcrypt.hashSync(password, 10)
      : member.password;

    const pinChanged = isOperationalRole(targetRole)
      ? Boolean(member.pin_hash)
      : pin !== undefined && (
          hasNonEmptyPin(pin)
            ? (!member.pin_hash || !bcrypt.compareSync(String(pin), member.pin_hash))
            : Boolean(member.pin_hash)
        );

    const hashedPin = isOperationalRole(targetRole)
      ? null
      : pin !== undefined
        ? (hasNonEmptyPin(pin) ? (pinChanged ? bcrypt.hashSync(String(pin), 10) : member.pin_hash) : null)
        : member.pin_hash;

    // Revoke outstanding sessions only when credentials actually change.
    const credentialsChanged = passwordChanged || pinChanged;
    const tokensValidAfter = credentialsChanged ? now() : member.tokens_valid_after;

    const demotesActiveOwner = member.role === 'owner' && member.is_active === 1 && targetRole !== 'owner';
    const result = db.prepare(`
      UPDATE users SET
        name       = COALESCE(?, name),
        email      = ?,
        username   = ?,
        password   = ?,
        role       = COALESCE(?, role),
        pin_hash   = ?,
        tokens_valid_after = ?,
        updated_at = ?
      WHERE id = ?
        AND (
          ? = 0
          OR (SELECT COUNT(*) FROM users WHERE role = 'owner' AND is_active = 1) > 1
        )
    `).run(
      name || null, nextEmail || null, nextUsername || null, hashedPassword,
      role || null, hashedPin, tokensValidAfter,
      now(), req.params.id, demotesActiveOwner ? 1 : 0,
    );
    if (result.changes === 0) {
      return res.status(400).json({ error: 'Cannot change the role of the last active owner. Create or promote another active owner first.' });
    }
    invalidateUserAuthCache(req.params.id as string);

    const updated = db.prepare(
      `SELECT ${STAFF_SELECT_FIELDS} FROM users WHERE id = ?`
    ).get(req.params.id);

    res.json({ staff: updated });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Staff are deactivated rather than hard-deleted to preserve order and print log references.
router.post('/:id/deactivate', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const member = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
    if (!member) return res.status(404).json({ error: 'Staff member not found' });
    if (member.is_active === 0) return res.status(400).json({ error: 'Already deactivated' });

    if (!canModifyTargetStaff((req as any).user.role, member.role)) {
      return res.status(403).json({ error: 'Managers cannot deactivate or reactivate owner or manager accounts' });
    }

    const changedAt = now();
    const result = db.prepare(`
      UPDATE users SET is_active = 0, tokens_valid_after = ?, updated_at = ?
      WHERE id = ? AND is_active = 1
        AND (role != 'owner' OR (SELECT COUNT(*) FROM users WHERE role = 'owner' AND is_active = 1) > 1)
    `).run(changedAt, changedAt, req.params.id);
    if (result.changes === 0) {
      return res.status(400).json({ error: 'Cannot deactivate the last owner account' });
    }
    invalidateUserAuthCache(req.params.id as string);
    const updated = db.prepare(
      `SELECT ${STAFF_SELECT_FIELDS} FROM users WHERE id = ?`
    ).get(req.params.id);
    res.json({ staff: updated });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/:id/reactivate', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const member = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
    if (!member) return res.status(404).json({ error: 'Staff member not found' });
    if (member.is_active === 1) return res.status(400).json({ error: 'Already active' });

    if (!canModifyTargetStaff((req as any).user.role, member.role)) {
      return res.status(403).json({ error: 'Managers cannot deactivate or reactivate owner or manager accounts' });
    }

    db.prepare('UPDATE users SET is_active = 1, updated_at = ? WHERE id = ?').run(now(), req.params.id);
    invalidateUserAuthCache(req.params.id as string);
    const updated = db.prepare(
      `SELECT ${STAFF_SELECT_FIELDS} FROM users WHERE id = ?`
    ).get(req.params.id);
    res.json({ staff: updated });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Table assignments ─────────────────────────────────────────────────────────
// Scopes which tables a server may take orders on in the Server App. An empty
// list means "every table", matching how unassigned servers behave today.

router.get('/:id/tables', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const member = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!member) return res.status(404).json({ error: 'Staff member not found' });

    const rows = db.prepare('SELECT table_id FROM table_users WHERE user_id = ?').all(req.params.id) as { table_id: string }[];
    res.json({ table_ids: rows.map((row) => row.table_id) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put('/:id/tables', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const member = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id) as any;
    if (!member) return res.status(404).json({ error: 'Staff member not found' });
    if (!canModifyTargetStaff((req as any).user.role, member.role)) {
      return res.status(403).json({ error: 'Managers cannot change owner or manager accounts' });
    }

    const tableIds = req.body?.table_ids;
    if (!Array.isArray(tableIds) || tableIds.some((id) => typeof id !== 'string')) {
      return res.status(400).json({ error: 'table_ids must be an array of table ids' });
    }

    const unique = [...new Set(tableIds.map(String))];
    const exists = db.prepare('SELECT 1 FROM tables WHERE id = ?');
    const unknown = unique.filter((id) => !exists.get(id));
    if (unknown.length > 0) {
      return res.status(400).json({ error: `Unknown table(s): ${unknown.join(', ')}` });
    }

    withTxn(() => {
      db.prepare('DELETE FROM table_users WHERE user_id = ?').run(req.params.id);
      const insert = db.prepare('INSERT INTO table_users (user_id, table_id, created_at) VALUES (?, ?, ?)');
      for (const tableId of unique) insert.run(req.params.id, tableId, now());
    });

    res.json({ table_ids: unique });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export const staffRoutes = router;
