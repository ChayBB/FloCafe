/**
 * The shop's menu as a customer's phone is allowed to see it, and the snapshot of
 * it that a hosted ordering server is allowed to hold.
 *
 * One definition, used by both the local guest port (main/guest-server.ts) and the
 * cloud push (main/services/cloud-sync.ts), so a field can never become visible in
 * one place and hidden in the other. Cost, stock, SKU and supplier data are not
 * selected here at all — not selected-then-stripped, so a careless spread cannot
 * leak them.
 */
import { createHash } from 'node:crypto';
import { getDatabase } from '../db';
import { hashGuestToken, qualifyGuestToken } from './guest-tokens';

export type PublicCategory = { id: string; name: string };

export type PublicProduct = {
  id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  price: number;
  has_image: boolean;
  updated_at: string;
};

export type PublicMenu = {
  categories: PublicCategory[];
  products: PublicProduct[];
};

/** Menu rows trimmed to what a customer may see — no cost, stock or supplier data. */
export function publicMenu(): PublicMenu {
  const db = getDatabase();
  const categories = db.prepare(`
    SELECT id, name FROM categories WHERE is_active = 1 ORDER BY sort_order, name
  `).all() as PublicCategory[];
  const products = db.prepare(`
    SELECT p.id, p.category_id, p.name, p.description, p.price, p.updated_at,
      CASE WHEN p.image_url IS NULL OR p.image_url = '' THEN 0 ELSE 1 END AS has_image
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.deleted_at IS NULL AND p.is_active = 1 AND (c.id IS NULL OR c.is_active = 1)
    ORDER BY p.sort_order, p.name
  `).all() as Record<string, unknown>[];
  return {
    categories,
    products: products.map((product) => ({
      id: String(product.id),
      category_id: (product.category_id as string | null) ?? null,
      name: String(product.name),
      description: (product.description as string | null) ?? null,
      price: Number(product.price),
      has_image: Boolean(product.has_image),
      updated_at: String(product.updated_at),
    })),
  };
}

export type PublicTable = {
  id: string;
  number: string;
  /** sha256 of the qualified token. The token itself never leaves this machine. */
  token_hash: string;
};

/**
 * Tables that currently have a code, keyed by the hash of that code. A hosted
 * server resolves a scan by hashing what the phone sent, so it can route an order
 * to the right table without ever holding a working QR token.
 */
export function publicTables(): PublicTable[] {
  const rows = getDatabase().prepare(`
    SELECT id, number, guest_token FROM tables
    WHERE is_active = 1 AND guest_token IS NOT NULL AND guest_token <> ''
    ORDER BY number
  `).all() as { id: string; number: string; guest_token: string }[];
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    token_hash: hashGuestToken(qualifyGuestToken(row.guest_token)),
  }));
}

export type PublicOrderingSnapshot = PublicMenu & {
  tables: PublicTable[];
  currency: string;
  language: string;
  /**
   * Needed because the guest page formats money and dates by country, not by
   * currency alone. The local gateway reads it from settings directly; a hosted
   * server has no settings to read, so it travels in the snapshot.
   */
  country: string;
};

export function publicOrderingSnapshot(
  currency: string,
  language: string,
  country: string,
): PublicOrderingSnapshot {
  return { ...publicMenu(), tables: publicTables(), currency, language, country };
}

/** Stable fingerprint of a snapshot, so an unchanged menu is never re-sent. */
export function snapshotDigest(snapshot: PublicOrderingSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
