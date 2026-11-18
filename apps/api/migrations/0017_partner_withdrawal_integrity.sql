BEGIN;

ALTER TABLE partner_withdrawals
  ADD CONSTRAINT partner_withdrawals_amount_fee_consistency_check
    CHECK (amount_yuan > 0 AND fee_yuan >= 0 AND fee_yuan <= amount_yuan AND net_amount_yuan = amount_yuan - fee_yuan),
  ADD CONSTRAINT partner_withdrawals_paid_reference_check
    CHECK (status <> 'paid' OR (external_reference IS NOT NULL AND length(btrim(external_reference)) >= 4));

CREATE OR REPLACE FUNCTION enforce_partner_withdrawal_integrity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.user_id, NEW.amount_yuan, NEW.fee_yuan, NEW.net_amount_yuan,
    NEW.idempotency_key, NEW.payout_channel, NEW.payout_name_ciphertext,
    NEW.payout_account_ciphertext, NEW.payout_account_last4
  ) IS DISTINCT FROM ROW(
    OLD.user_id, OLD.amount_yuan, OLD.fee_yuan, OLD.net_amount_yuan,
    OLD.idempotency_key, OLD.payout_channel, OLD.payout_name_ciphertext,
    OLD.payout_account_ciphertext, OLD.payout_account_last4
  ) THEN
    RAISE EXCEPTION 'partner withdrawal financial request fields are immutable';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'pending' AND NEW.status NOT IN ('approved', 'rejected') THEN
      RAISE EXCEPTION 'invalid partner withdrawal transition: % -> %', OLD.status, NEW.status;
    ELSIF OLD.status = 'approved' AND NEW.status NOT IN ('paid', 'failed') THEN
      RAISE EXCEPTION 'invalid partner withdrawal transition: % -> %', OLD.status, NEW.status;
    ELSIF OLD.status NOT IN ('pending', 'approved') THEN
      RAISE EXCEPTION 'terminal partner withdrawal status cannot change: %', OLD.status;
    END IF;
    IF NEW.status = 'paid' AND (NEW.external_reference IS NULL OR length(btrim(NEW.external_reference)) < 4) THEN
      RAISE EXCEPTION 'paid partner withdrawal requires a unique external payment reference';
    END IF;
  ELSIF OLD.status = 'paid' AND NEW.external_reference IS DISTINCT FROM OLD.external_reference THEN
    RAISE EXCEPTION 'paid partner withdrawal payment reference is immutable';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS partner_withdrawals_integrity_guard ON partner_withdrawals;
CREATE TRIGGER partner_withdrawals_integrity_guard
  BEFORE UPDATE ON partner_withdrawals
  FOR EACH ROW EXECUTE FUNCTION enforce_partner_withdrawal_integrity();

INSERT INTO schema_migrations(version)
VALUES ('0017_partner_withdrawal_integrity')
ON CONFLICT (version) DO NOTHING;

COMMIT;
