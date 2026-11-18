BEGIN;

ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS reauthenticated_until timestamptz;

ALTER TABLE partner_withdrawals
  ADD COLUMN IF NOT EXISTS arrival_type varchar(8) NOT NULL DEFAULT 'T1';

INSERT INTO schema_migrations(version)
VALUES ('0010_auth_session_reauth')
ON CONFLICT (version) DO NOTHING;

COMMIT;
