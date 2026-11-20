BEGIN;

-- 管理员手工调整积分：流水类型放宽出 'adjust'，允许正负金额。
-- 其余类型仍要求正数金额，保持既有账本语义不变。
ALTER TABLE billing_ledger
  DROP CONSTRAINT IF EXISTS billing_ledger_type_check;
ALTER TABLE billing_ledger
  ADD CONSTRAINT billing_ledger_type_check
  CHECK (type IN ('grant', 'hold', 'settle', 'refund', 'recharge', 'compensation', 'adjust'));

ALTER TABLE billing_ledger
  DROP CONSTRAINT IF EXISTS billing_ledger_amount_check;
ALTER TABLE billing_ledger
  ADD CONSTRAINT billing_ledger_amount_check
  CHECK ((type = 'adjust' AND amount <> 0) OR (type <> 'adjust' AND amount > 0));

-- 记录是哪位管理员执行的调整，作为审计线索。
ALTER TABLE billing_ledger
  ADD COLUMN IF NOT EXISTS adjusted_by uuid REFERENCES users(id) ON DELETE SET NULL;

INSERT INTO schema_migrations(version)
VALUES ('0023_admin_credit_adjust')
ON CONFLICT (version) DO NOTHING;

COMMIT;
