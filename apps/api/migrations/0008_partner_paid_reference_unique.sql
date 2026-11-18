BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS partner_withdrawals_paid_reference_unique
  ON partner_withdrawals(external_reference)
  WHERE external_reference IS NOT NULL AND status = 'paid';

INSERT INTO schema_migrations(version)
VALUES ('0008_partner_paid_reference_unique')
ON CONFLICT (version) DO NOTHING;

COMMIT;
