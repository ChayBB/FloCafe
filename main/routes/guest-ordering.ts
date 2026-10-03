/**
 * Owner-facing configuration for customer self-ordering: the on/off switch, the
 * public address customers reach, and each table's QR code.
 *
 * The guest surface itself lives on its own port (main/guest-server.ts); this
 * router only manages it.
 */
import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import { newGuestToken, qualifyGuestToken } from '../services/guest-tokens';
import { clearPairingCode, isGuestRelayConnected, issuePairingCode, newRelaySecret, reloadGuestRelay } from '../services/guest-relay';
import { getDatabase, getSettingValue, now, upsertSettings } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { asyncHandler } from '../middleware/async-handler';
import { getLocalIP } from '../server-state';
import { getGuestPort } from '../guest-server-state';

const router = Router();

router.use(requireRole(...ROLE_ACCESS.ownerManager));

/**
 * Customers reach the shop through the merchant's own public address when one is
 * configured; on the shop network the LAN address still works for testing.
 */
function guestBaseUrl(): string {
  const configured = (getSettingValue('guest_public_url') || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `http://${getLocalIP()}:${getGuestPort()}`;
}

/**
 * The stored secret is qualified with this shop's store reference before it is
 * printed, so the same code resolves on the local port and on a shared server.
 */
function guestUrl(secret: string): string {
  return `${guestBaseUrl()}/guest-order?t=${encodeURIComponent(qualifyGuestToken(secret))}`;
}

router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const db = getDatabase();
  const tables = db.prepare(`
    SELECT id, number, guest_token FROM tables WHERE is_active = 1 ORDER BY number
  `).all() as { id: string; number: string; guest_token: string | null }[];

  const withCodes = await Promise.all(tables.map(async (table) => {
    if (!table.guest_token) {
      return { id: table.id, number: table.number, url: null, qr_data: null };
    }
    const url = guestUrl(table.guest_token);
    try {
      return { id: table.id, number: table.number, url, qr_data: await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', width: 320 }) };
    } catch {
      return { id: table.id, number: table.number, url, qr_data: null };
    }
  }));

  const relaySecret = getSettingValue('guest_relay_secret') || '';

  res.json({
    enabled: getSettingValue('guest_ordering_enabled') === 'true',
    public_url: getSettingValue('guest_public_url') || '',
    base_url: guestBaseUrl(),
    guest_port: getGuestPort(),
    tables: withCodes,
    relay: {
      url: getSettingValue('guest_relay_url') || '',
      // Whether a secret exists, and its last four characters so the merchant
      // can tell at a glance whether the one in their server's .env is still
      // the current one. The whole secret is fetched separately and on purpose.
      secret_set: Boolean(relaySecret),
      secret_tail: relaySecret ? relaySecret.slice(-4) : '',
      connected: isGuestRelayConnected(),
    },
  });
}));

/**
 * Just the connection state, cheap enough to poll.
 *
 * `GET /` renders a QR image for every table, so the settings screen cannot ask
 * it repeatedly merely to find out whether the socket came up. Connecting takes
 * a moment after a settings change, which is exactly when a merchant is looking.
 */
router.get('/relay-status', (_req: Request, res: Response) => {
  res.json({ connected: isGuestRelayConnected() });
});

/**
 * The relay secret in full, for pasting into the hosted server's `.env`.
 *
 * A separate request rather than part of the configuration payload: the
 * settings screen is read on every visit, and a secret that rides along is a
 * secret in every response, every log of one, and every screenshot of the page.
 * This endpoint is called only when the merchant asks to see it.
 */
router.get('/relay-secret', (_req: Request, res: Response) => {
  const secret = getSettingValue('guest_relay_secret') || '';
  if (!secret) return res.status(404).json({ error: 'No relay secret has been generated yet' });
  res.set('Cache-Control', 'no-store');
  res.json({ secret });
});

/**
 * Generates a new relay secret, replacing any existing one.
 *
 * **This disconnects a hosted server immediately** and keeps it disconnected
 * until the new secret is in its `.env` — the till's `hello` will no longer
 * verify. That is the point of the operation when a secret has leaked, but it
 * is not a harmless button, so the UI says so before calling it.
 */
router.post('/relay-secret', (_req: Request, res: Response) => {
  try {
    const secret = newRelaySecret();
    upsertSettings({ guest_relay_secret: secret });
    reloadGuestRelay();
    res.set('Cache-Control', 'no-store');
    res.json({ secret });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * The same rule the relay service enforces before it will open a socket.
 *
 * Checked here too so a merchant who types the wrong thing is told now, rather
 * than saving a URL that silently never connects. The service still refuses on
 * its own — this is a better error message, not the security boundary.
 */
function relayUrlError(url: string): string | null {
  if (!/^wss?:\/\//i.test(url)) {
    return 'The relay address must start with wss:// (or ws:// for a local test)';
  }
  if (/^ws:\/\//i.test(url) && !/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(url)) {
    // Orders carry what a table is eating and what it will be charged.
    return 'Plaintext ws:// is only allowed to this machine. A hosted server must use wss://';
  }
  try {
    new URL(url);
  } catch {
    return 'The relay address is not a valid URL';
  }
  return null;
}

router.put('/', (req: Request, res: Response) => {
  try {
    const { enabled, public_url: publicUrl, relay_url: relayUrl } = req.body || {};

    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
      upsertSettings({ guest_ordering_enabled: enabled ? 'true' : 'false' });
    }

    if (publicUrl !== undefined) {
      if (typeof publicUrl !== 'string') return res.status(400).json({ error: 'public_url must be a string' });
      const trimmed = publicUrl.trim();
      if (trimmed) {
        let parsed: URL;
        try {
          parsed = new URL(trimmed);
        } catch {
          return res.status(400).json({ error: 'public_url must be a full URL, e.g. https://order.myshop.com' });
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return res.status(400).json({ error: 'public_url must start with http:// or https://' });
        }
      }
      upsertSettings({ guest_public_url: trimmed });
    }

    if (relayUrl !== undefined) {
      if (typeof relayUrl !== 'string') return res.status(400).json({ error: 'relay_url must be a string' });
      const trimmed = relayUrl.trim();
      if (trimmed) {
        const problem = relayUrlError(trimmed);
        if (problem) return res.status(400).json({ error: problem });
      }
      upsertSettings({ guest_relay_url: trimmed });
    }

    // Any of the three can change whether the relay should be connected or
    // where to, so the socket is re-read rather than left on stale settings.
    if (enabled !== undefined || relayUrl !== undefined) reloadGuestRelay();

    const relaySecret = getSettingValue('guest_relay_secret') || '';
    res.json({
      enabled: getSettingValue('guest_ordering_enabled') === 'true',
      public_url: getSettingValue('guest_public_url') || '',
      base_url: guestBaseUrl(),
      relay: {
        url: getSettingValue('guest_relay_url') || '',
        secret_set: Boolean(relaySecret),
        secret_tail: relaySecret ? relaySecret.slice(-4) : '',
        connected: isGuestRelayConnected(),
      },
    });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Issues a table's first code, or replaces one that has leaked. */
router.post('/tables/:tableId/token', asyncHandler(async (req: Request, res: Response) => {
  const db = getDatabase();
  const table = db.prepare('SELECT id, number FROM tables WHERE id = ? AND is_active = 1')
    .get(req.params.tableId) as { id: string; number: string } | undefined;
  if (!table) return res.status(404).json({ error: 'Table not found' });

  const token = newGuestToken();
  db.prepare('UPDATE tables SET guest_token = ?, updated_at = ? WHERE id = ?').run(token, now(), table.id);

  const url = guestUrl(token);
  let qrData: string | null = null;
  try {
    qrData = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', width: 320 });
  } catch {
    qrData = null;
  }
  res.json({ table: { id: table.id, number: table.number, url, qr_data: qrData } });
}));

/**
 * Shows a pairing code for a hosted QR server.
 *
 * The merchant reads it off this screen and types it into their hosted server.
 * **Their POS password is never involved**, so a compromised hosted server can
 * capture nothing that unlocks this till — at worst one code, which is spent the
 * moment it is used and dies in five minutes regardless.
 *
 * Returned in the response body and written nowhere: not to settings, not to the
 * log. A code in a database backup months from now is a liability.
 */
router.post('/pairing-code', (req: Request, res: Response) => {
  try {
    const user = (req as any).user as { userId?: string; role?: string } | undefined;
    if (!user?.role) return res.status(401).json({ error: 'Not signed in' });

    // Read the name from the database rather than the token: the hosted server
    // displays it, and a renamed staff member should not keep an old label for
    // as long as their token lives.
    const row = getDatabase().prepare('SELECT name FROM users WHERE id = ?').get(user.userId) as
      { name: string } | undefined;

    const issued = issuePairingCode({ name: row?.name || '', role: user.role });
    res.json(issued);
  } catch (error: any) {
    // The role check inside the service throws rather than returning, so that a
    // caller that skipped the middleware cannot quietly get a code anyway.
    if (/owner or a manager/.test(error?.message || '')) {
      return res.status(403).json({ error: error.message });
    }
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Forgets the outstanding code, for a merchant who closed the dialog. */
router.delete('/pairing-code', (_req: Request, res: Response) => {
  clearPairingCode();
  res.json({ ok: true });
});

/** Retires a table's code without deleting the table. */
router.delete('/tables/:tableId/token', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const result = db.prepare('UPDATE tables SET guest_token = NULL, updated_at = ? WHERE id = ?')
      .run(now(), req.params.tableId);
    if (result.changes === 0) return res.status(404).json({ error: 'Table not found' });
    res.json({ ok: true });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export const guestOrderingRoutes = router;
