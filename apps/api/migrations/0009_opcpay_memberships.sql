BEGIN;

ALTER TABLE billing_orders
  ADD COLUMN payment_provider text,
  ADD COLUMN provider_sku_id text,
  ADD COLUMN provider_quota_amount bigint,
  ADD COLUMN provider_quota_unit text,
  ADD COLUMN provider_quota_baseline bigint,
  ADD COLUMN pay_url text,
  ADD COLUMN qr_payload text,
  ADD COLUMN payment_expires_at timestamptz;

ALTER TABLE billing_orders
  ADD CONSTRAINT billing_orders_payment_provider_check
    CHECK (payment_provider IS NULL OR payment_provider IN ('opcpay')),
  ADD CONSTRAINT billing_orders_provider_quota_amount_check
    CHECK (provider_quota_amount IS NULL OR provider_quota_amount > 0),
  ADD CONSTRAINT billing_orders_provider_quota_baseline_check
    CHECK (provider_quota_baseline IS NULL OR provider_quota_baseline >= 0),
  ADD CONSTRAINT billing_orders_provider_quota_unit_check
    CHECK (provider_quota_unit IS NULL OR provider_quota_unit IN ('COUNT', 'POINT'));

CREATE INDEX billing_orders_provider_pending_idx
  ON billing_orders(payment_provider, status, created_at)
  WHERE status = 'pending';

CREATE TABLE billing_provider_webhook_events (
  event_id text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('opcpay')),
  event_type text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text
);

CREATE INDEX billing_provider_webhook_user_idx
  ON billing_provider_webhook_events(user_id, received_at DESC);

CREATE TABLE user_memberships (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tier_id text NOT NULL CHECK (tier_id IN ('lite', 'plus', 'pro', 'ultra')),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > starts_at)
);

CREATE INDEX user_memberships_expires_idx ON user_memberships(expires_at);

CREATE UNIQUE INDEX billing_ledger_order_recharge_unique
  ON billing_ledger(order_id, type)
  WHERE order_id IS NOT NULL AND type = 'recharge';

INSERT INTO schema_migrations(version) VALUES ('0009_opcpay_memberships') ON CONFLICT (version) DO NOTHING;

COMMIT;
