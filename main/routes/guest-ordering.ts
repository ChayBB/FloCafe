/**
 * Owner-facing configuration for customer self-ordering: the on/off switch, the
 * public address customers reach, and each table's QR code.
 *
 * The guest surface itself lives on its own port (main/guest-server.ts); this
 * router only manages it.
 */
import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import { newGuestToken } from '../services/guest-tokens';
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

function guestUrl(token: string): string {
  return `${guestBaseUrl()}/guest-order?t=${encodeURIComponent(token)}`;
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

  res.json({
    enabled: getSettingValue('guest_ordering_enabled') === 'true',
    public_url: getSettingValue('guest_public_url') || '',
    base_url: guestBaseUrl(),
    guest_port: getGuestPort(),
    tables: withCodes,
  });
}));

router.put('/', (req: Request, res: Response) => {
  try {
    const { enabled, public_url: publicUrl } = req.body || {};

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

    res.json({
      enabled: getSettingValue('guest_ordering_enabled') === 'true',
      public_url: getSettingValue('guest_public_url') || '',
      base_url: guestBaseUrl(),
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
