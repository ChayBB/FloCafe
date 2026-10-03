-- FloCafe guest relay — PostgreSQL schema.
--
-- Nothing here is a source of truth. The menu is a copy pushed down the socket
-- by the POS, and tables are held as hashes rather than codes, so losing this
-- database costs a redelivery of the snapshot and hands nobody a working QR.

CREATE TABLE IF NOT EXISTS shops (
  id              TEXT PRIMARY KEY,          -- pos_hash from the POS hello
  name            TEXT NOT NULL DEFAULT '',
  currency        TEXT NOT NULL DEFAULT 'THB',
  language        TEXT NOT NULL DEFAULT 'en',
  snapshot_digest TEXT,
  last_seen_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The menu as a customer's phone may see it. No cost, stock, SKU or supplier:
-- the POS does not send them, and this table has nowhere to put them.
CREATE TABLE IF NOT EXISTS menu_items (
  shop_id     TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL,
  category_id TEXT,
  name        TEXT NOT NULL,
  description TEXT,
  price       NUMERIC(12,2) NOT NULL,
  has_image   BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (shop_id, product_id)
);

CREATE TABLE IF NOT EXISTS menu_categories (
  shop_id     TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  PRIMARY KEY (shop_id, category_id)
);

-- Tables, identified by the hash of their printed code. The phone sends the
-- real code; this server hashes it to find the row and forwards the original to
-- the POS, which re-checks it. A dump of this table yields no usable QR.
CREATE TABLE IF NOT EXISTS shop_tables (
  shop_id    TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  table_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  PRIMARY KEY (shop_id, token_hash)
);

-- One row per order a phone submitted. `id` is what goes to the POS and what a
-- redelivery reuses, so the POS can recognise a repeat instead of cooking it
-- twice; it must never be regenerated on retry.
CREATE TABLE IF NOT EXISTS relay_orders (
  id            TEXT PRIMARY KEY,
  shop_id       TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  table_hash    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL
                CHECK (status IN ('queued', 'sent', 'acked', 'refused', 'expired')),
  attempts      INT NOT NULL DEFAULT 0,
  refusal       TEXT,
  order_number  TEXT,
  placed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_relay_orders_pending
  ON relay_orders (shop_id, status, placed_at)
  WHERE status IN ('queued', 'sent');

-- Replay protection for the POS hello. A nonce may be presented once; rows are
-- pruned on a window, so this stays small.
CREATE TABLE IF NOT EXISTS hello_nonces (
  nonce      TEXT PRIMARY KEY,
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hello_nonces_seen ON hello_nonces (seen_at);
