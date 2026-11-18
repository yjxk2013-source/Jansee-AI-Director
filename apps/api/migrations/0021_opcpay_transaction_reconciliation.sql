BEGIN;

ALTER TABLE billing_orders
  ADD COLUMN IF NOT EXISTS provider_price_yuan numeric(10, 2),
  ADD COLUMN IF NOT EXISTS provider_price_version integer,
  ADD COLUMN IF NOT EXISTS provider_payment_status text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (provider_payment_status IN ('UNKNOWN', 'PENDING', 'PAID', 'REFUNDED')),
  ADD COLUMN IF NOT EXISTS provider_trade_no varchar(128),
  ADD COLUMN IF NOT EXISTS provider_payment_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_paid_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS refunded_amount_yuan numeric(10, 2) NOT NULL DEFAULT 0
    CHECK (refunded_amount_yuan >= 0 AND refunded_amount_yuan <= amount_yuan),
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

CREATE INDEX IF NOT EXISTS billing_orders_opcpay_payment_status_idx
  ON billing_orders(provider_payment_status, provider_paid_checked_at DESC)
  WHERE payment_provider = 'opcpay';

CREATE UNIQUE INDEX IF NOT EXISTS billing_orders_opcpay_trade_no_unique
  ON billing_orders(provider_trade_no)
  WHERE payment_provider = 'opcpay' AND provider_trade_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_order_refund_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL REFERENCES billing_orders(id) ON DELETE RESTRICT,
  amount_yuan numeric(10, 2) NOT NULL CHECK (amount_yuan > 0),
  source text NOT NULL CHECK (source IN ('opcpay', 'manual')),
  external_reference varchar(160),
  note varchar(500),
  recorded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_order_provider_refund_once
  ON billing_order_refund_records(order_id) WHERE source = 'opcpay';

CREATE INDEX IF NOT EXISTS billing_order_refund_records_created_idx
  ON billing_order_refund_records(created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS billing_order_manual_refund_reference_once
  ON billing_order_refund_records(external_reference)
  WHERE source = 'manual' AND external_reference IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_billing_order_refund_record_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'billing order refund records are append-only';
END;
$$;

DROP TRIGGER IF EXISTS billing_order_refund_records_append_only ON billing_order_refund_records;
CREATE TRIGGER billing_order_refund_records_append_only
  BEFORE UPDATE OR DELETE ON billing_order_refund_records
  FOR EACH ROW EXECUTE FUNCTION reject_billing_order_refund_record_mutation();

INSERT INTO schema_migrations(version)
VALUES ('0021_opcpay_transaction_reconciliation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
