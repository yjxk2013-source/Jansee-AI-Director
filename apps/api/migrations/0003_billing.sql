BEGIN;

CREATE TABLE wallets (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available_credits bigint NOT NULL DEFAULT 1000 CHECK (available_credits >= 0),
  frozen_credits bigint NOT NULL DEFAULT 0 CHECK (frozen_credits >= 0),
  total_spent_credits bigint NOT NULL DEFAULT 0 CHECK (total_spent_credits >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing_orders (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id text NOT NULL,
  package_name text NOT NULL,
  amount_yuan numeric(10, 2) NOT NULL CHECK (amount_yuan >= 0),
  credits bigint NOT NULL CHECK (credits > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
CREATE INDEX billing_orders_user_created_idx ON billing_orders(user_id, created_at DESC);
CREATE INDEX billing_orders_paid_at_idx ON billing_orders(paid_at) WHERE status = 'paid';

CREATE TABLE billing_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id uuid REFERENCES generation_jobs(id) ON DELETE SET NULL,
  order_id text REFERENCES billing_orders(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('grant', 'hold', 'settle', 'refund', 'recharge', 'compensation')),
  amount bigint NOT NULL CHECK (amount > 0),
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_ledger_user_created_idx ON billing_ledger(user_id, created_at DESC);
CREATE UNIQUE INDEX billing_ledger_job_type_unique
  ON billing_ledger(job_id, type)
  WHERE job_id IS NOT NULL AND type IN ('hold', 'settle', 'refund', 'compensation');

INSERT INTO schema_migrations(version) VALUES ('0003_billing') ON CONFLICT (version) DO NOTHING;

COMMIT;
