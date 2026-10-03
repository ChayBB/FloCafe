/** PostgreSQL access. Bun ships a `postgres`-compatible tagged-template client. */
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  // Failing at import is deliberate: a relay that starts without a database
  // accepts orders it cannot record, which is worse than refusing to boot.
  throw new Error('DATABASE_URL is required');
}

export const sql = postgres(url, { max: 10, idle_timeout: 30 });

export type MenuRow = {
  product_id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  price: string;
  has_image: boolean;
};

export async function loadMenu(shopId: string) {
  const [categories, products] = await Promise.all([
    sql`SELECT category_id AS id, name FROM menu_categories WHERE shop_id = ${shopId} ORDER BY name`,
    sql<MenuRow[]>`SELECT product_id, category_id, name, description, price, has_image
                   FROM menu_items WHERE shop_id = ${shopId} ORDER BY name`,
  ]);
  return {
    categories,
    products: products.map((row) => ({
      id: row.product_id,
      category_id: row.category_id,
      name: row.name,
      description: row.description,
      price: Number(row.price),
      has_image: row.has_image,
    })),
  };
}

/** Finds the table a scanned code belongs to, without ever storing the code. */
export async function tableByHash(shopId: string, tokenHash: string) {
  const rows = await sql<{ table_id: string; name: string }[]>`
    SELECT table_id, name FROM shop_tables WHERE shop_id = ${shopId} AND token_hash = ${tokenHash} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function shopProfile(shopId: string) {
  const rows = await sql<{ name: string; currency: string; language: string; country: string }[]>`
    SELECT name, currency, language, country FROM shops WHERE id = ${shopId} LIMIT 1
  `;
  return rows[0] ?? null;
}
