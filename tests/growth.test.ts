import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { buildApp } from "../apps/api/src/app.js";
import type { AuthStore, AuthUser } from "../apps/api/src/auth.js";
import { createPgGrowthStore, decryptPayoutValue, encryptPayoutValue, settleEligiblePartnerCommissions } from "../apps/api/src/growth-store.js";

const user: AuthUser = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "partner@jansee.cn",
  displayName: "城市合伙人",
  createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
};
const token = "g".repeat(43);
const origin = "http://localhost:5173";

function makeAuthStore(): AuthStore {
  return {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async findUserById(id) { return id === user.id ? user : null; },
    async verifyPassword() { return null; },
    async createSession() {},
    async findSession() { return { user, expiresAt: new Date(Date.now() + 60_000) }; },
    async deleteSession() {},
    async deleteUserSessions() {},
  };
}

test("payout profile encryption round-trips and rejects ciphertext tampering", () => {
  const key = "a".repeat(64);
  const ciphertext = encryptPayoutValue("partner@example.com", key);
  assert.notEqual(ciphertext, "partner@example.com");
  assert.equal(decryptPayoutValue(ciphertext, key), "partner@example.com");
  assert.throws(() => decryptPayoutValue(ciphertext.slice(0, -2) + "AA", key));
  assert.throws(() => encryptPayoutValue("sensitive", "short"), /64 位十六进制/);
});

test("withdrawal retries are serialized before idempotency lookup and cannot reserve funds twice", async () => {
  const rows = new Map<string, any>();
  const queries: string[] = [];
  let insertCount = 0;
  let dailyCount = 0;
  let dailyAmount = 0;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      queries.push(normalized);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [], rowCount: null };
      if (normalized.startsWith("SELECT partner_activated_at FROM users")) {
        return { rows: [{ partner_activated_at: new Date("2026-01-01T00:00:00.000Z") }], rowCount: 1 };
      }
      if (normalized.startsWith("SELECT id, amount_yuan, fee_yuan")) {
        const row = rows.get(String(values[1]));
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (normalized.startsWith("SELECT payout_channel")) {
        return { rows: [{ payout_channel: "alipay", account_name_ciphertext: "cipher-name", account_ciphertext: "cipher-account", account_last4: "1234", verification_status: "verified" }], rowCount: 1 };
      }
      if (normalized.includes("AS daily_count")) {
        return { rows: [{ daily_count: String(dailyCount), daily_amount: String(dailyAmount) }], rowCount: 1 };
      }
      if (normalized.includes("AS settled") && normalized.includes("AS reserved")) {
        return { rows: [{ settled: "500.00", reserved: String([...rows.values()].filter((row) => ["pending", "approved", "paid"].includes(row.status)).reduce((sum, row) => sum + Number(row.amount_yuan), 0)) }], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO partner_withdrawals")) {
        insertCount += 1;
        const row = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", amount_yuan: String(values[1]), fee_yuan: String(values[2]), net_amount_yuan: String(values[3]), status: "pending", created_at: new Date("2026-11-16T00:00:00.000Z") };
        rows.set(String(values[4]), row);
        return { rows: [row], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO partner_audit_events")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = { async connect() { return client; }, async query() { return { rows: [], rowCount: 0 }; } } as unknown as Pool;
  const store = createPgGrowthStore(pool, "a".repeat(64));

  const first = await store.createWithdrawal(user.id, 100, "11111111-1111-4111-8111-111111111111");
  const second = await store.createWithdrawal(user.id, 300, "11111111-1111-4111-8111-111111111111");

  assert.equal(first.amountYuan, 100);
  assert.equal(first.feeYuan, 2);
  assert.equal(first.netAmountYuan, 98);
  assert.equal(second.amountYuan, 100, "same idempotency key must replay the original request");
  assert.equal(second.replayed, true);
  assert.equal(insertCount, 1);
  const lockIndex = queries.findIndex((sql) => sql.startsWith("SELECT partner_activated_at FROM users"));
  const idempotencyIndex = queries.findIndex((sql) => sql.startsWith("SELECT id, amount_yuan, fee_yuan"));
  assert.ok(lockIndex >= 0 && idempotencyIndex > lockIndex, "user row lock must be acquired before idempotency lookup");
  const balanceSql = queries.find((query) => query.includes("AS settled") && query.includes("AS reserved")) ?? "";
  assert.match(balanceSql, /provider_payment_status = 'PAID'/, "withdrawable balance must exclude unverified OPCPAY orders");
  await assert.rejects(() => store.createWithdrawal(user.id, 99, "22222222-2222-4222-8222-222222222222"), /100 至 5000/);
  dailyCount = 3;
  await assert.rejects(() => store.createWithdrawal(user.id, 100, "33333333-3333-4333-8333-333333333333"), /每日最多 3 次/);
  dailyCount = 2;
  dailyAmount = 9950;
  await assert.rejects(() => store.createWithdrawal(user.id, 100, "44444444-4444-4444-8444-444444444444"), /今日累计提现已达上限/);
  await assert.rejects(() => store.createWithdrawal(user.id, 100.5, "33333333-3333-4333-8333-333333333333"), /100 至 5000/);
});

test("saving a payout account persists it as pending until an administrator verifies it", async () => {
  const sqlSeen: string[] = [];
  const client = {
    async query(sql: string) {
      const normalized = sql.replace(/\\s+/g, " ").trim();
      sqlSeen.push(normalized);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [], rowCount: null };
      if (normalized.startsWith("SELECT partner_activated_at FROM users")) return { rows: [{ partner_activated_at: new Date("2026-01-01T00:00:00.000Z") }], rowCount: 1 };
      if (normalized.startsWith("INSERT INTO partner_payout_profiles")) return { rows: [{ account_last4: "0000", verification_status: "pending", updated_at: new Date("2026-11-17T00:00:00.000Z") }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const store = createPgGrowthStore(pool, "a".repeat(64));
  const saved = await store.savePayoutProfile(user.id, "测试姓名", "13800000000");
  assert.equal(saved.verificationStatus, "pending");
  const write = sqlSeen.find((sql) => sql.startsWith("INSERT INTO partner_payout_profiles")) ?? "";
  assert.match(write, /'pending'/);
  assert.match(write, /verified_at = NULL/);
  assert.doesNotMatch(write, /verification_status = 'verified'/);
});

test("partner commission settlement requires verified OPCPAY payment and starts the hold from provider verification", async () => {
  let updateSql = ""; let settlementDays = 0;
  const client = { async query(sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") return { rows: [], rowCount: 0 };
    updateSql = normalized; settlementDays = Number(values[0] ?? 0); return { rows: [], rowCount: 0 };
  }, release() {} };
  const pool = { async connect() { return client; } } as unknown as Pool;
  assert.equal(await settleEligiblePartnerCommissions(pool), 0);
  assert.match(updateSql, /o\.payment_provider = 'opcpay'/);
  assert.match(updateSql, /o\.provider_payment_status = 'PAID'/);
  assert.match(updateSql, /o\.provider_paid_checked_at <= now\(\)/);
  assert.doesNotMatch(updateSql, /o\.paid_at <= now\(\)/);
  assert.equal(settlementDays, 7);
});

test("pending payout profiles cannot create withdrawals", async () => {
  let withdrawalInsertCount = 0;
  const client = {
    async query(sql: string) {
      const normalized = sql.replace(/\\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [], rowCount: null };
      if (normalized.startsWith("SELECT partner_activated_at FROM users")) return { rows: [{ partner_activated_at: new Date("2026-01-01T00:00:00.000Z") }], rowCount: 1 };
      if (normalized.startsWith("SELECT id, amount_yuan, fee_yuan")) return { rows: [], rowCount: 0 };
      if (normalized.startsWith("SELECT payout_channel")) return { rows: [{ payout_channel: "alipay", account_name_ciphertext: "cipher-name", account_ciphertext: "cipher-account", account_last4: "1234", verification_status: "pending" }], rowCount: 1 };
      if (normalized.startsWith("INSERT INTO partner_withdrawals")) withdrawalInsertCount += 1;
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const store = createPgGrowthStore(pool, "a".repeat(64));
  await assert.rejects(
    () => store.createWithdrawal(user.id, 100, "66666666-6666-4666-8666-666666666666"),
    /尚未通过管理员核验/,
  );
  assert.equal(withdrawalInsertCount, 0, "unverified account must never create a durable withdrawal record");
});

test("payout changes and withdrawals run directly under an authenticated session", async () => {
  let withdrawalCalls = 0;
  const authStore = makeAuthStore();
  const growthStore = {
    async getOverview() { return {}; },
    async checkin() { return {}; },
    async activatePartner() { return {}; },
    async listInvitees() { return []; },
    async listCommissions() { return []; },
    async getPayoutProfile() { return null; },
    async savePayoutProfile(_userId: string, accountName: string, account: string) { return { accountName, accountLast4: account.slice(-4), verificationStatus: "pending" }; },
    async createWithdrawal() { withdrawalCalls += 1; return { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", amountYuan: 100, feeYuan: 2, netAmountYuan: 98, status: "pending", replayed: withdrawalCalls > 1 }; },
    async listWithdrawals() { return []; },
    async settleEligibleCommissions() { return 0; },
  };
  const app = buildApp({ allowedOrigins: [origin], logLevel: "silent", production: false, authStore, growthStore });
  const headers = { cookie: `jansee_session=${token}`, "content-type": "application/json", origin };
  const unauthorized = await app.inject({ method: "GET", url: "/api/v1/growth/withdrawals" });
  assert.equal(unauthorized.statusCode, 401);
  const profile = await app.inject({ method: "PUT", url: "/api/v1/growth/payout-profile", headers, payload: { accountName: "测试姓名", account: "13800000000" } });
  assert.equal(profile.statusCode, 200);
  const accepted = await app.inject({ method: "POST", url: "/api/v1/growth/withdrawals", headers, payload: { amountYuan: 100, idempotencyKey: "11111111-1111-4111-8111-111111111111" } });
  assert.equal(accepted.statusCode, 201);
  assert.equal(accepted.json().withdrawal.netAmountYuan, 98);
  const replay = await app.inject({ method: "POST", url: "/api/v1/growth/withdrawals", headers, payload: { amountYuan: 100, idempotencyKey: "11111111-1111-4111-8111-111111111111" } });
  assert.equal(replay.statusCode, 200, "the same idempotency key replays the original withdrawal");
  assert.equal(replay.json().withdrawal.replayed, true);
  await app.close();
});

test("production requires admin payout verification before withdrawals", async () => {
  const growthStore = {
    async getOverview() { return {}; },
    async checkin() { return {}; },
    async activatePartner() { return {}; },
    async listInvitees() { return []; },
    async listCommissions() { return []; },
    async getPayoutProfile() { return null; },
    async savePayoutProfile(_userId: string, accountName: string, account: string) { return { channel: "alipay", accountLast4: account.slice(-4), verificationStatus: "pending", accountName }; },
    async createWithdrawal() { throw new Error("收款账户尚未通过管理员核验，暂不能申请提现"); },
    async listWithdrawals() { return []; },
    async settleEligibleCommissions() { return 0; },
  };
  const authStore = makeAuthStore();
  const app = buildApp({ allowedOrigins: [origin], logLevel: "silent", production: true, authStore, growthStore });
  const headers = { origin, cookie: `jansee_session=${token}`, "content-type": "application/json" };
  const profile = await app.inject({ method: "PUT", url: "/api/v1/growth/payout-profile", headers, payload: { accountName: "测试姓名", account: "13800000000" } });
  assert.equal(profile.statusCode, 200);
  assert.equal(profile.json().profile.verificationStatus, "pending");
  const withdrawal = await app.inject({ method: "POST", url: "/api/v1/growth/withdrawals", headers, payload: { amountYuan: 100, idempotencyKey: "55555555-5555-4555-8555-555555555555" } });
  assert.equal(withdrawal.statusCode, 400);
  assert.equal(withdrawal.json().error.code, "WITHDRAWAL_NOT_ALLOWED");
  await app.close();
});

test("production payout profile response exposes the saved profile without a KYC gate", async () => {
  const growthStore = {
    async getOverview() { return {}; },
    async checkin() { return {}; },
    async activatePartner() { return {}; },
    async listInvitees() { return []; },
    async listCommissions() { return []; },
    async getPayoutProfile() { return { channel: "alipay", accountLast4: "1234", verificationStatus: "pending" }; },
    async savePayoutProfile() { throw new Error("must not be called"); },
    async createWithdrawal() { throw new Error("must not be called"); },
    async listWithdrawals() { return []; },
    async settleEligibleCommissions() { return 0; },
  };
  const app = buildApp({ allowedOrigins: [origin], logLevel: "silent", production: true, authStore: makeAuthStore(), growthStore });
  const headers = { origin, cookie: `jansee_session=${token}` };
  const response = await app.inject({ method: "GET", url: "/api/v1/growth/payout-profile", headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.json().profile.accountLast4, "1234");
  for (const url of ["/api/v1/growth/overview", "/api/v1/growth/invitees", "/api/v1/growth/commissions", "/api/v1/growth/withdrawals"]) {
    const privateResponse = await app.inject({ method: "GET", url, headers });
    assert.equal(privateResponse.statusCode, 200, url);
    assert.equal(privateResponse.headers["cache-control"], "no-store", url);
  }
  await app.close();
});

test("daily check-in credits the wallet and ledger exactly once; retries do not duplicate the reward", async () => {
  let walletBalance = 5000;
  let checkinExists = false;
  let walletUpdates = 0;
  let ledgerInserts = 0;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [], rowCount: null };
      if (normalized.startsWith("INSERT INTO wallets")) return { rows: [], rowCount: 0 };
      if (normalized.startsWith("SELECT available_credits FROM wallets")) return { rows: [{ available_credits: walletBalance }], rowCount: 1 };
      if (normalized.startsWith("INSERT INTO user_daily_checkins")) {
        if (checkinExists) return { rows: [], rowCount: 0 };
        checkinExists = true;
        assert.equal(values[2], 100);
        return { rows: [{ id: "checkin-1" }], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE wallets SET available_credits = available_credits +")) {
        walletUpdates += 1;
        walletBalance += Number(values[0]);
        return { rows: [{ available_credits: walletBalance }], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO billing_ledger")) {
        ledgerInserts += 1;
        assert.equal(values[1], 100);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected check-in SQL: ${normalized}`);
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const store = createPgGrowthStore(pool);

  const first = await store.checkin(user.id, "Asia/Shanghai", 100);
  assert.deepEqual(first, { already: false, rewardCredits: 100, balance: 5100 });
  assert.equal(walletBalance, 5100);
  assert.equal(walletUpdates, 1);
  assert.equal(ledgerInserts, 1);

  const retry = await store.checkin(user.id, "Asia/Shanghai", 100);
  assert.deepEqual(retry, { already: true, balance: 5100 });
  assert.equal(walletBalance, 5100);
  assert.equal(walletUpdates, 1, "duplicate check-in must not update wallet again");
  assert.equal(ledgerInserts, 1, "duplicate check-in must not add another ledger row");
});
