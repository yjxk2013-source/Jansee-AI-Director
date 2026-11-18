import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../apps/api/migrations/0001_initial.sql", import.meta.url), "utf8");
const billingMigration = readFileSync(new URL("../apps/api/migrations/0003_billing.sql", import.meta.url), "utf8");
const speechCutMigration = readFileSync(new URL("../apps/api/migrations/0004_speech_cut_sessions.sql", import.meta.url), "utf8");
const architecture = readFileSync(new URL("../docs/architecture/DATA-OWNERSHIP.md", import.meta.url), "utf8");

test("initial PostgreSQL migration creates the core account and media lifecycle tables", () => {
  for (const table of ["users", "auth_sessions", "conversations", "conversation_messages", "assets", "generation_jobs", "generation_job_assets", "generated_outputs"]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}\\s*\\(`));
  }
});

test("user-owned media and job relationships enforce same-owner composite foreign keys", () => {
  assert.ok(migration.includes("FOREIGN KEY (conversation_id, user_id) REFERENCES conversations(id, user_id)"));
  assert.ok(migration.includes("FOREIGN KEY (job_id, user_id) REFERENCES generation_jobs(id, user_id)"));
  assert.ok(migration.includes("FOREIGN KEY (asset_id, user_id) REFERENCES assets(id, user_id)"));
  assert.ok(migration.includes("UNIQUE (user_id, idempotency_key)"));
});

test("billing migration creates durable wallets, payment orders, and an idempotent credit ledger", () => {
  for (const table of ["wallets", "billing_orders", "billing_ledger"]) {
    assert.match(billingMigration, new RegExp(`CREATE TABLE ${table}\\s*\\(`));
  }
  assert.match(billingMigration, /UNIQUE INDEX billing_ledger_job_type_unique/);
  assert.match(billingMigration, /'compensation'/);
});

test("session schema stores token hashes and outputs support explicit expiry/deletion", () => {
  assert.match(migration, /token_hash text NOT NULL UNIQUE/);
  assert.match(migration, /expires_at timestamptz/);
  assert.match(migration, /deleted_at timestamptz/);
  assert.ok(architecture.toLowerCase().includes("raw bearer/session tokens must never be persisted"));
});

test("speech-cut migration persists owner-bound ASR, suggestions, confirmation and job linkage", () => {
  assert.match(speechCutMigration, /CREATE TABLE speech_cut_sessions/);
  assert.ok(speechCutMigration.includes("FOREIGN KEY (asset_id, user_id) REFERENCES assets(id, user_id)"));
  assert.match(speechCutMigration, /words jsonb NOT NULL/);
  assert.match(speechCutMigration, /suggestions jsonb NOT NULL/);
  assert.match(speechCutMigration, /selected_suggestion_ids jsonb/);
  assert.match(speechCutMigration, /'awaiting_confirmation'/);
  assert.match(speechCutMigration, /'consumed'/);
});


const workerLeaseMigration = readFileSync(new URL("../apps/api/migrations/0005_job_worker_leases.sql", import.meta.url), "utf8");

test("worker lease migration adds heartbeat, retry and stale-lease recovery fields", () => {
  assert.match(workerLeaseMigration, /ADD COLUMN IF NOT EXISTS worker_id/);
  assert.match(workerLeaseMigration, /ADD COLUMN IF NOT EXISTS lease_expires_at/);
  assert.match(workerLeaseMigration, /ADD COLUMN IF NOT EXISTS last_heartbeat_at/);
  assert.match(workerLeaseMigration, /attempt_count integer NOT NULL DEFAULT 0/);
  assert.match(workerLeaseMigration, /generation_jobs_expired_lease_idx/);
});

const growthMigration = readFileSync(new URL("../apps/api/migrations/0006_growth_referrals_partners.sql", import.meta.url), "utf8");
const payoutSafetyMigration = readFileSync(new URL("../apps/api/migrations/0007_partner_payout_safety.sql", import.meta.url), "utf8");

test("growth migration persists daily check-ins, referral rewards, exclusive city partners and commission ledgers", () => {
  for (const table of ["user_daily_checkins", "referral_rewards", "partner_city_assignments", "partner_commissions", "partner_payout_profiles", "partner_withdrawals"]) {
    assert.match(growthMigration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`));
  }
  assert.match(growthMigration, /UNIQUE \(user_id, checkin_date\)/);
  assert.ok(growthMigration.includes("invitee_user_id uuid NOT NULL UNIQUE"));
  assert.match(growthMigration, /partner_city_exclusive_unique/);
  assert.match(growthMigration, /UNIQUE \(beneficiary_user_id, order_id, level\)/);
});

test("payout safety migration adds idempotent withdrawals and immutable partner audit events", () => {
  assert.match(payoutSafetyMigration, /idempotency_key uuid/);
  assert.match(payoutSafetyMigration, /partner_withdrawals_idempotency_unique/);
  assert.match(payoutSafetyMigration, /payout_name_ciphertext/);
  assert.match(payoutSafetyMigration, /payout_account_ciphertext/);
  assert.match(payoutSafetyMigration, /CREATE TABLE IF NOT EXISTS partner_audit_events/);
  assert.match(payoutSafetyMigration, /actor_user_id uuid REFERENCES users\(id\)/);
});

const payoutMigration = readFileSync(new URL("../apps/api/migrations/0007_partner_payout_safety.sql", import.meta.url), "utf8");
const payoutHardeningMigration = readFileSync(new URL("../apps/api/migrations/0008_partner_paid_reference_unique.sql", import.meta.url), "utf8");
const sessionReauthMigration = readFileSync(new URL("../apps/api/migrations/0010_auth_session_reauth.sql", import.meta.url), "utf8");
const withdrawalIntegrityMigration = readFileSync(new URL("../apps/api/migrations/0017_partner_withdrawal_integrity.sql", import.meta.url), "utf8");

test("growth schema enforces one referral reward per invitee and exclusive city ownership", () => {
  assert.match(growthMigration, /invitee_user_id uuid NOT NULL UNIQUE REFERENCES users\(id\)/);
  assert.match(growthMigration, /partner_city_exclusive_unique/);
  assert.match(growthMigration, /UNIQUE \(beneficiary_user_id, order_id, level\)/);
  assert.match(growthMigration, /UNIQUE \(user_id, checkin_date\)/);
});

test("payout schema stores encrypted account fields, idempotency and operator audit trails", () => {
  assert.match(payoutMigration, /account_name_ciphertext text/);
  assert.match(payoutMigration, /payout_name_ciphertext text/);
  assert.match(payoutMigration, /partner_withdrawals_idempotency_unique/);
  assert.match(payoutMigration, /partner_audit_events/);
  assert.match(payoutHardeningMigration, /partner_withdrawals_paid_reference_unique/);
  assert.match(sessionReauthMigration, /reauthenticated_until timestamptz/);
  assert.match(sessionReauthMigration, /arrival_type varchar\(8\)/);
});

test("partner withdrawals enforce immutable financial fields and valid status transitions in PostgreSQL", () => {
  assert.match(withdrawalIntegrityMigration, /partner_withdrawals_amount_fee_consistency_check/);
  assert.match(withdrawalIntegrityMigration, /partner_withdrawals_paid_reference_check/);
  assert.match(withdrawalIntegrityMigration, /partner_withdrawals_integrity_guard/);
  assert.match(withdrawalIntegrityMigration, /financial request fields are immutable/);
  assert.match(withdrawalIntegrityMigration, /OLD.status = 'pending' AND NEW.status NOT IN \('approved', 'rejected'\)/);
  assert.match(withdrawalIntegrityMigration, /OLD.status = 'approved' AND NEW.status NOT IN \('paid', 'failed'\)/);
});

test("partner audit events are append-only at the database layer", () => {
  assert.match(payoutSafetyMigration, /partner_audit_events_append_only/);
  assert.match(payoutSafetyMigration, /BEFORE UPDATE OR DELETE ON partner_audit_events/);
  assert.match(payoutSafetyMigration, /reject_partner_audit_mutation/);
});

const refundWorkflowMigration = readFileSync(new URL("../apps/api/migrations/0011_billing_refund_workflow.sql", import.meta.url), "utf8");
const supportMessagesMigration = readFileSync(new URL("../apps/api/migrations/0014_support_messages_remove_order_refunds.sql", import.meta.url), "utf8");

test("billing retains paid/free credit provenance while order refunds are replaced by support messages", () => {
  assert.match(refundWorkflowMigration, /paid_available_credits bigint NOT NULL DEFAULT 0/);
  assert.match(refundWorkflowMigration, /free_available_credits bigint NOT NULL DEFAULT 0/);
  assert.match(refundWorkflowMigration, /SET free_available_credits = available_credits/);
  assert.match(supportMessagesMigration, /ALTER TABLE billing_refund_requests RENAME TO billing_refund_requests_legacy/);
  assert.doesNotMatch(supportMessagesMigration, /DROP TABLE IF EXISTS billing_refund_requests/);
  assert.match(supportMessagesMigration, /CREATE TABLE IF NOT EXISTS support_messages/);
  assert.match(supportMessagesMigration, /support_messages_status_created_idx/);
});
const opcpayMembershipMigration = readFileSync(new URL("../apps/api/migrations/0009_opcpay_memberships.sql", import.meta.url), "utf8");
const opcpayTransactionMigration = readFileSync(new URL("../apps/api/migrations/0021_opcpay_transaction_reconciliation.sql", import.meta.url), "utf8");

test("OPCPAY revenue is based on verified transaction status and auditable manual refund records", () => {
  assert.match(opcpayTransactionMigration, /provider_payment_status IN \('UNKNOWN', 'PENDING', 'PAID', 'REFUNDED'\)/);
  assert.match(opcpayTransactionMigration, /provider_paid_checked_at timestamptz/);
  assert.match(opcpayTransactionMigration, /provider_price_yuan numeric/);
  assert.match(opcpayTransactionMigration, /billing_orders_opcpay_trade_no_unique/);
  assert.match(opcpayTransactionMigration, /CREATE TABLE IF NOT EXISTS billing_order_refund_records/);
  assert.match(opcpayTransactionMigration, /source IN \('opcpay', 'manual'\)/);
  assert.match(opcpayTransactionMigration, /billing_order_manual_refund_reference_once/);
  assert.match(opcpayTransactionMigration, /billing_order_refund_records_append_only/);
  assert.match(opcpayTransactionMigration, /BEFORE UPDATE OR DELETE ON billing_order_refund_records/);
  assert.match(opcpayTransactionMigration, /AS \$\$[\s\S]*END;\s*\$\$;/);
});

test("OPCPAY migration persists provider intents, signed webhook dedupe, membership and recharge idempotency", () => {
  assert.match(opcpayMembershipMigration, /ADD COLUMN payment_provider text/);
  assert.match(opcpayMembershipMigration, /provider_sku_id text/);
  assert.match(opcpayMembershipMigration, /provider_quota_amount bigint/);
  assert.match(opcpayMembershipMigration, /ADD COLUMN provider_quota_baseline bigint,/);
  assert.match(opcpayMembershipMigration, /provider_quota_baseline IS NULL OR provider_quota_baseline >= 0/);
  assert.doesNotMatch(opcpayMembershipMigration, /provider_quota_baseline bigint NOT NULL DEFAULT/);
  assert.match(opcpayMembershipMigration, /pay_url text/);
  assert.match(opcpayMembershipMigration, /CREATE TABLE billing_provider_webhook_events/);
  assert.match(opcpayMembershipMigration, /event_id text PRIMARY KEY/);
  assert.match(opcpayMembershipMigration, /CREATE TABLE user_memberships/);
  assert.match(opcpayMembershipMigration, /tier_id text NOT NULL/);
  assert.match(opcpayMembershipMigration, /billing_ledger_order_recharge_unique/);
});
