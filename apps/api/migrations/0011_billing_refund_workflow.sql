BEGIN;

-- Keep paid credits separate from free grants so a refund can never consume
-- check-in, registration, referral, or promotional credits.
ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS paid_available_credits bigint NOT NULL DEFAULT 0 CHECK (paid_available_credits >= 0),
  ADD COLUMN IF NOT EXISTS free_available_credits bigint NOT NULL DEFAULT 0 CHECK (free_available_credits >= 0);

-- Existing balances have unknown provenance. Conservatively classify them as
-- free so historical orders cannot be refunded by consuming unverified credits.
UPDATE wallets
SET free_available_credits = available_credits,
    paid_available_credits = 0
WHERE paid_available_credits = 0 AND free_available_credits = 0;

ALTER TABLE billing_ledger
  ADD COLUMN IF NOT EXISTS paid_amount bigint NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  ADD COLUMN IF NOT EXISTS free_amount bigint NOT NULL DEFAULT 0 CHECK (free_amount >= 0);

-- Legacy frozen jobs had no asset-source split; restore their credits to the
-- conservative free pool if they fail after this migration.
UPDATE billing_ledger
SET free_amount = amount
WHERE type = 'hold' AND paid_amount = 0 AND free_amount = 0;

ALTER TABLE billing_orders
  DROP CONSTRAINT IF EXISTS billing_orders_status_check;
ALTER TABLE billing_orders
  ADD CONSTRAINT billing_orders_status_check
  CHECK (status IN ('pending', 'paid', 'closed', 'refund_requested', 'refunding', 'refunded'));

ALTER TABLE billing_orders
  ADD COLUMN IF NOT EXISTS refund_reason varchar(500),
  ADD COLUMN IF NOT EXISTS refund_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS refund_external_reference varchar(160),
  ADD COLUMN IF NOT EXISTS refund_resolved_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS billing_refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL REFERENCES billing_orders(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  credits_reserved bigint NOT NULL CHECK (credits_reserved > 0),
  reason varchar(500) NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'refunded', 'rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  external_reference varchar(160),
  resolution_note varchar(500)
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_refund_active_order_unique
  ON billing_refund_requests(order_id) WHERE status = 'requested';
CREATE INDEX IF NOT EXISTS billing_refund_requests_status_created_idx
  ON billing_refund_requests(status, requested_at DESC);

INSERT INTO schema_migrations(version)
VALUES ('0011_billing_refund_workflow')
ON CONFLICT (version) DO NOTHING;

COMMIT;
