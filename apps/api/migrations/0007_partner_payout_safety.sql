BEGIN;

ALTER TABLE partner_payout_profiles
  ADD COLUMN IF NOT EXISTS payout_channel varchar(24) NOT NULL DEFAULT 'alipay',
  ADD COLUMN IF NOT EXISTS account_name_ciphertext text,
  ADD COLUMN IF NOT EXISTS account_ciphertext text;

ALTER TABLE partner_withdrawals
  ADD COLUMN IF NOT EXISTS idempotency_key uuid,
  ADD COLUMN IF NOT EXISTS payout_channel varchar(24) NOT NULL DEFAULT 'alipay',
  ADD COLUMN IF NOT EXISTS payout_name_ciphertext text,
  ADD COLUMN IF NOT EXISTS payout_account_ciphertext text,
  ADD COLUMN IF NOT EXISTS payout_account_last4 varchar(4),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS admin_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS external_reference varchar(160);

CREATE UNIQUE INDEX IF NOT EXISTS partner_withdrawals_idempotency_unique
  ON partner_withdrawals(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS partner_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  entity_type varchar(40) NOT NULL,
  entity_id uuid,
  action varchar(60) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_audit_events_user_created_idx
  ON partner_audit_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS partner_audit_events_entity_created_idx
  ON partner_audit_events(entity_type, entity_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_partner_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'partner_audit_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS partner_audit_events_append_only ON partner_audit_events;
CREATE TRIGGER partner_audit_events_append_only
  BEFORE UPDATE OR DELETE ON partner_audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_partner_audit_mutation();

INSERT INTO schema_migrations(version)
VALUES ('0007_partner_payout_safety')
ON CONFLICT (version) DO NOTHING;

COMMIT;
