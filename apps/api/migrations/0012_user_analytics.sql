BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS register_province varchar(80),
  ADD COLUMN IF NOT EXISTS register_city varchar(80),
  ADD COLUMN IF NOT EXISTS register_region varchar(180),
  ADD COLUMN IF NOT EXISTS registration_channel varchar(80);

CREATE INDEX IF NOT EXISTS users_created_at_idx ON users (created_at DESC);
CREATE INDEX IF NOT EXISTS users_register_province_city_idx ON users (register_province, register_city);

INSERT INTO schema_migrations(version)
VALUES ('0012_user_analytics')
ON CONFLICT (version) DO NOTHING;

COMMIT;
