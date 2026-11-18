BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS invite_code varchar(16),
  ADD COLUMN IF NOT EXISTS inviter_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS partner_activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS partner_province varchar(80),
  ADD COLUMN IF NOT EXISTS partner_city varchar(80);

UPDATE users
SET invite_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
WHERE invite_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_invite_code_unique
  ON users (invite_code) WHERE invite_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_inviter_user_idx
  ON users (inviter_user_id) WHERE inviter_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_daily_checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checkin_date date NOT NULL,
  reward_credits bigint NOT NULL CHECK (reward_credits > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, checkin_date)
);
CREATE INDEX IF NOT EXISTS user_daily_checkins_user_date_idx
  ON user_daily_checkins(user_id, checkin_date DESC);

CREATE TABLE IF NOT EXISTS referral_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  reward_credits bigint NOT NULL CHECK (reward_credits > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referral_rewards_inviter_created_idx
  ON referral_rewards(inviter_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS partner_city_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  province varchar(80) NOT NULL,
  city varchar(80) NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS partner_city_exclusive_unique
  ON partner_city_assignments(province, city) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS partner_commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beneficiary_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id text NOT NULL REFERENCES billing_orders(id) ON DELETE RESTRICT,
  level smallint NOT NULL CHECK (level IN (1, 2)),
  order_amount_yuan numeric(12, 2) NOT NULL CHECK (order_amount_yuan > 0),
  commission_rate numeric(6, 5) NOT NULL CHECK (commission_rate > 0 AND commission_rate <= 0.20),
  commission_amount_yuan numeric(12, 2) NOT NULL CHECK (commission_amount_yuan > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'settled', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settle_at timestamptz,
  cancelled_at timestamptz,
  UNIQUE (beneficiary_user_id, order_id, level)
);
CREATE INDEX IF NOT EXISTS partner_commissions_beneficiary_created_idx
  ON partner_commissions(beneficiary_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS partner_commissions_settlement_idx
  ON partner_commissions(status, created_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS partner_payout_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_name_ciphertext text NOT NULL,
  account_ciphertext text NOT NULL,
  account_last4 varchar(4) NOT NULL,
  verification_status text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  verification_note varchar(300),
  updated_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);

CREATE TABLE IF NOT EXISTS partner_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_yuan numeric(12, 2) NOT NULL CHECK (amount_yuan >= 100),
  fee_yuan numeric(12, 2) NOT NULL CHECK (fee_yuan >= 0),
  net_amount_yuan numeric(12, 2) NOT NULL CHECK (net_amount_yuan >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'rejected', 'failed')),
  note varchar(300),
  proof_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS partner_withdrawals_user_created_idx
  ON partner_withdrawals(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS partner_withdrawals_pending_idx
  ON partner_withdrawals(status, created_at) WHERE status = 'pending';

INSERT INTO schema_migrations(version)
VALUES ('0006_growth_referrals_partners')
ON CONFLICT (version) DO NOTHING;

COMMIT;
