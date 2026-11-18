BEGIN;

CREATE TABLE IF NOT EXISTS pricing_config (
  id text PRIMARY KEY,
  config jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations(version)
VALUES ('0013_pricing_config')
ON CONFLICT (version) DO NOTHING;

COMMIT;
