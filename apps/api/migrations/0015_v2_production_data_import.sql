BEGIN;

CREATE TABLE IF NOT EXISTS v2_import_map (
  legacy_user_id text PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  source_file text NOT NULL DEFAULT 's8-users.json',
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS v2_import_runs (
  import_key text PRIMARY KEY,
  snapshot_sha256 char(64) NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS v2_legacy_archives (
  source_file text PRIMARY KEY,
  sha256 char(64) NOT NULL,
  payload jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS v2_legacy_orders (
  legacy_order_id text PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  original_status text NOT NULL,
  created_at timestamptz,
  paid_at timestamptz,
  payload jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS v2_legacy_orders_user_created_idx
  ON v2_legacy_orders(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS site_daily_analytics (
  day date PRIMARY KEY,
  pv integer NOT NULL DEFAULT 0 CHECK (pv >= 0),
  uv integer NOT NULL DEFAULT 0 CHECK (uv >= 0),
  breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'v2-real-visitor-aggregate',
  imported_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations(version)
VALUES ('0015_v2_production_data_import')
ON CONFLICT (version) DO NOTHING;

COMMIT;
