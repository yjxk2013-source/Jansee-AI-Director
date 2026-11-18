BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone varchar(20);
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users (phone) WHERE deleted_at IS NULL;

INSERT INTO schema_migrations(version)
VALUES ('0002_add_phone_to_users')
ON CONFLICT (version) DO NOTHING;

COMMIT;
