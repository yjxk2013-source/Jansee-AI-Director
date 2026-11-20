import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { createPgBillingStore } from "../apps/api/src/billing-store.js";

const walletRow = {
  user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  available_credits: 400,
  frozen_credits: 200,
  total_spent_credits: 0,
  updated_at: new Date("2026-11-16T00:00:00.000Z"),
};

function makePool(options?: { workerId?: string; status?: string; hold?: boolean; terminal?: string | null }) {
  const events: string[] = [];
  const queries: string[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      queries.push(normalized);
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        events.push(normalized);
        return { rows: [], rowCount: null };
      }
      if (normalized.startsWith("INSERT INTO wallets")) return { rows: [], rowCount: 0 };
      if (normalized.startsWith("SELECT * FROM wallets")) return { rows: [walletRow], rowCount: 1 };
      if (normalized.startsWith("SELECT status, worker_id FROM generation_jobs")) {
        return { rows: [{ status: options?.status ?? "quality-check", worker_id: options?.workerId ?? "worker-a" }], rowCount: 1 };
      }
      if (normalized.startsWith("SELECT amount FROM billing_ledger")) {
        return { rows: options?.hold === false ? [] : [{ amount: 200 }], rowCount: options?.hold === false ? 0 : 1 };
      }
      if (normalized.startsWith("SELECT type FROM billing_ledger")) {
        return { rows: options?.terminal ? [{ type: options.terminal }] : [], rowCount: options?.terminal ? 1 : 0 };
      }
      if (normalized.startsWith("UPDATE wallets")) {
        events.push("SETTLE_WALLET");
        return { rows: [{ ...walletRow, frozen_credits: 0, total_spent_credits: 200 }], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO billing_ledger")) {
        events.push("INSERT_SETTLE");
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE generation_jobs")) {
        events.push("COMPLETE_JOB");
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() { events.push("RELEASE"); },
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  return { pool, events, queries };
}

test("production job completion and credit settlement share one PostgreSQL transaction", async () => {
  const { pool, events, queries } = makePool({ workerId: "worker-a" });
  const store = createPgBillingStore(pool);

  const wallet = await store.completeJobAndSettle!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "worker-a");

  assert.equal(wallet.frozenCredits, 0);
  assert.equal(wallet.totalSpentCredits, 200);
  assert.deepEqual(events, ["BEGIN", "SETTLE_WALLET", "INSERT_SETTLE", "COMPLETE_JOB", "COMMIT", "RELEASE"]);
  assert.ok(queries.some((sql) => sql.includes("worker_id = $3 AND status = 'quality-check'")));
  assert.ok(queries.some((sql) => sql.includes("frozen_credits >= $1")));
});

test("stale worker cannot settle credits or complete a reclaimed job", async () => {
  const { pool, events, queries } = makePool({ workerId: "worker-b" });
  const store = createPgBillingStore(pool);

  await assert.rejects(
    () => store.completeJobAndSettle!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "worker-a"),
    /WORKER_LEASE_LOST/,
  );
  assert.deepEqual(events, ["BEGIN", "ROLLBACK", "RELEASE"]);
  assert.equal(queries.some((sql) => sql.startsWith("UPDATE wallets")), false);
  assert.equal(queries.some((sql) => sql.startsWith("UPDATE generation_jobs")), false);
});

test("admin credit adjustment deducts the free pool first and refuses overdraft", async () => {
  const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const baseWallet = {
    user_id: userId,
    available_credits: 400,
    frozen_credits: 0,
    total_spent_credits: 0,
    paid_available_credits: 100,
    free_available_credits: 300,
    updated_at: new Date("2026-11-20T00:00:00.000Z"),
  };
  const executed: string[] = [];
  const ledgerInserts: { sql: string; values: unknown[] }[] = [];
  let updatedWallet = baseWallet;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      executed.push(normalized);
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") return { rows: [], rowCount: null };
      if (normalized.startsWith("INSERT INTO wallets")) return { rows: [], rowCount: 0 };
      if (normalized.startsWith("SELECT * FROM wallets")) return { rows: [baseWallet], rowCount: 1 };
      if (normalized.startsWith("SELECT paid_available_credits, free_available_credits")) {
        return { rows: [{ paid_available_credits: 100, free_available_credits: 300 }], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE wallets")) {
        // 扣 200：先扣 200 免费，付费池不动。
        const [deduction, freeAmount, paidAmount] = values as number[];
        updatedWallet = { ...baseWallet, available_credits: 400 - deduction, free_available_credits: 300 - freeAmount, paid_available_credits: 100 - paidAmount };
        return { rows: [updatedWallet], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO billing_ledger")) {
        ledgerInserts.push({ sql: normalized, values });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const store = createPgBillingStore(pool);

  const wallet = await store.adjustCredits!(userId, -200, "管理员误扣更正", "99999999-9999-4999-8999-999999999999");
  assert.equal(wallet.availableCredits, 200);
  assert.equal(ledgerInserts.length, 1);
  assert.ok(ledgerInserts[0]!.sql.includes("'adjust'"));
  assert.equal(ledgerInserts[0]!.values[1], -200);
  assert.equal(ledgerInserts[0]!.values[2], 0);
  assert.equal(ledgerInserts[0]!.values[3], 200);
  assert.ok(executed.some((sql) => sql.includes("FOR UPDATE")));
  assert.ok(executed.some((sql) => sql.includes("adjusted_by")));

  await assert.rejects(
    () => store.adjustCredits!(userId, -500, "超额扣减"),
    /积分不足/,
  );
});

test("admin credit adjustment grant path books free credits and the operator reference", async () => {
  const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ledgerInserts: { sql: string; values: unknown[] }[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") return { rows: [], rowCount: null };
      if (normalized.startsWith("INSERT INTO wallets")) return { rows: [], rowCount: 0 };
      if (normalized.startsWith("SELECT * FROM wallets")) {
        return { rows: [{
          user_id: userId, available_credits: 400, frozen_credits: 0, total_spent_credits: 0,
          paid_available_credits: 100, free_available_credits: 300, updated_at: new Date("2026-11-20T00:00:00.000Z"),
        }], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE wallets")) {
        return { rows: [{
          user_id: userId, available_credits: 900, frozen_credits: 0, total_spent_credits: 0,
          paid_available_credits: 100, free_available_credits: 800, updated_at: new Date("2026-11-20T00:00:00.000Z"),
        }], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO billing_ledger")) {
        ledgerInserts.push({ sql: normalized, values });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const store = createPgBillingStore(pool);

  const wallet = await store.adjustCredits!(userId, 500, "管理员手工充值", "99999999-9999-4999-8999-999999999999");
  assert.equal(wallet.availableCredits, 900);
  assert.equal(ledgerInserts.length, 1);
  assert.ok(ledgerInserts[0]!.sql.includes("'adjust'"));
  assert.equal(ledgerInserts[0]!.values[1], 500);
  assert.equal(ledgerInserts[0]!.values[ledgerInserts[0]!.values.length - 1], "99999999-9999-4999-8999-999999999999");

  await assert.rejects(() => store.adjustCredits!(userId, 0, "无效"), /不为 0 的整数/);
});

test("completed production job cannot settle without a matching credit hold", async () => {
  const { pool, events } = makePool({ workerId: "worker-a", hold: false });
  const store = createPgBillingStore(pool);

  await assert.rejects(
    () => store.completeJobAndSettle!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "worker-a"),
    /BILLING_HOLD_MISSING/,
  );
  assert.deepEqual(events, ["BEGIN", "ROLLBACK", "RELEASE"]);
});

test("job completion refuses to charge a hold that was already refunded", async () => {
  const { pool, events, queries } = makePool({ workerId: "worker-a", terminal: "refund" });
  const store = createPgBillingStore(pool);

  await assert.rejects(
    () => store.completeJobAndSettle!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "worker-a"),
    /BILLING_HOLD_ALREADY_REFUNDED/,
  );
  assert.deepEqual(events, ["BEGIN", "ROLLBACK", "RELEASE"]);
  assert.equal(queries.some((sql) => sql.startsWith("UPDATE wallets")), false);
});

test("PostgreSQL payment intent attachment is owner-bound and persists provider quota mapping", async () => {
  const baseOrder = {
    id: "PAY-TEST-001",
    user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    package_id: "boost_small",
    package_name: "1,000 算力加油包",
    amount_yuan: 9.9,
    credits: 1000,
    status: "pending",
    payment_provider: null,
    provider_sku_id: null,
    provider_quota_amount: null,
    provider_quota_unit: null,
    provider_quota_baseline: null,
    provider_price_yuan: null,
    provider_price_version: null,
    provider_payment_status: "UNKNOWN",
    provider_trade_no: null,
    provider_payment_checked_at: null,
    provider_paid_checked_at: null,
    refunded_amount_yuan: 0,
    refunded_at: null,
    pay_url: null,
    qr_payload: null,
    payment_expires_at: null,
    created_at: new Date("2026-11-16T00:00:00.000Z"),
    paid_at: null,
  };
  const events: string[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        events.push(normalized);
        return { rows: [], rowCount: null };
      }
      if (normalized.startsWith("SELECT * FROM billing_orders")) return { rows: [baseOrder], rowCount: 1 };
      if (normalized.startsWith("UPDATE billing_orders")) {
        events.push("ATTACH_INTENT");
        return {
          rows: [{
            ...baseOrder,
            payment_provider: values[2],
            provider_sku_id: values[3],
            provider_quota_amount: values[4],
            provider_quota_unit: values[5],
            provider_quota_baseline: values[6],
            provider_price_yuan: values[7],
            provider_price_version: values[8],
            pay_url: values[9],
            qr_payload: values[10],
            payment_expires_at: values[11],
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() { events.push("RELEASE"); },
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const store = createPgBillingStore(pool);

  const order = await store.attachPaymentIntent!(
    baseOrder.user_id,
    baseOrder.id,
    {
      provider: "opcpay",
      skuId: "sku-boost",
      quotaAmount: 5,
      quotaUnit: "COUNT",
      quotaBaseline: 0,
      priceYuan: 9.9,
      priceVersion: 1,
      payUrl: "https://ai6666.com/pay/order",
      qrPayload: "https://ai6666.com/qr/order",
    },
  );

  assert.equal(order.paymentProvider, "opcpay");
  assert.equal(order.providerQuotaAmount, 5);
  assert.equal(order.providerQuotaUnit, "COUNT");
  assert.equal(order.providerQuotaBaseline, 0);
  assert.equal(order.providerPriceYuan, 9.9);
  assert.equal(order.providerPriceVersion, 1);
  assert.equal(order.providerPaymentStatus, "UNKNOWN");
  assert.equal(order.payUrl, "https://ai6666.com/pay/order");
  assert.equal(order.paymentExpiresAt, undefined);
  assert.deepEqual(events, ["BEGIN", "ATTACH_INTENT", "COMMIT", "RELEASE"]);
});

test("PostgreSQL webhook event persistence uses provider event ID as an idempotency key", async () => {
  let query = "";
  let values: unknown[] = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      query = sql;
      values = params;
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const store = createPgBillingStore(pool);

  const inserted = await store.recordProviderWebhookEvent!({
    eventId: "evt-duplicate",
    provider: "opcpay",
    eventType: "entitlement.updated",
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    payload: { id: "evt-duplicate" },
  });

  assert.equal(inserted, false);
  assert.match(query, /ON CONFLICT \(event_id\) DO NOTHING/);
  assert.equal(values[0], "evt-duplicate");
});

test("PostgreSQL membership lookup returns an active owner-bound tier and expiry", async () => {
  const expiry = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const pool = {
    async query() {
      return {
        rows: [{
          user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          tier_id: "pro",
          starts_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
          expires_at: expiry,
          updated_at: new Date(),
        }],
        rowCount: 1,
      };
    },
  } as unknown as Pool;
  const store = createPgBillingStore(pool);
  const membership = await store.getMembership!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

  assert.equal(membership?.tierId, "pro");
  assert.equal(membership?.active, true);
  assert.equal(membership?.expiresAt, expiry.toISOString());
});

test("PostgreSQL order mapping preserves a missing OPCPAY quota baseline as absent", async () => {
  const row = {
    id: "PAY-LEGACY-001",
    user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    package_id: "boost_small",
    package_name: "1,000 算力加油包",
    amount_yuan: 9.9,
    credits: 1000,
    status: "pending",
    payment_provider: "opcpay",
    provider_sku_id: "sku-boost",
    provider_quota_amount: 5,
    provider_quota_unit: "COUNT",
    provider_quota_baseline: null,
    pay_url: "https://ai6666.com/pay/legacy",
    qr_payload: null,
    payment_expires_at: null,
    created_at: new Date("2026-11-16T00:00:00.000Z"),
    paid_at: null,
  };
  const pool = {
    async query() { return { rows: [row], rowCount: 1 }; },
  } as unknown as Pool;
  const store = createPgBillingStore(pool);

  const order = await store.findOrderById("PAY-LEGACY-001");

  assert.equal(order?.paymentProvider, "opcpay");
  assert.equal(order?.providerQuotaBaseline, undefined);
});

test("PostgreSQL OPCPAY transaction reconciliation persists PAID/REFUNDED evidence and creates one full-refund ledger record", async () => {
  const checkedAt = new Date("2026-11-18T03:00:00.000Z");
  const order = {
    id: "PAY-TEST-REFUND", user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", package_id: "boost_small",
    package_name: "1,000 算力加油包", amount_yuan: 9.9, credits: 1000, status: "paid", payment_provider: "opcpay",
    provider_sku_id: "sku-boost", provider_quota_amount: 5, provider_quota_unit: "COUNT", provider_quota_baseline: 0,
    provider_price_yuan: 9.9, provider_price_version: 3, provider_payment_status: "PAID", provider_trade_no: "TRADE-1",
    provider_payment_checked_at: checkedAt, provider_paid_checked_at: checkedAt, refunded_amount_yuan: 0, refunded_at: null,
    pay_url: null, qr_payload: null, payment_expires_at: null, created_at: checkedAt, paid_at: checkedAt,
  };
  const queries: string[] = []; const events: string[] = []; let refundInsertCount = 0;
  const client = { async query(sql: string, values: unknown[] = []) {
    const q = sql.replace(/\s+/g, " ").trim(); queries.push(q);
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q)) { events.push(q); return { rows: [], rowCount: 0 }; }
    if (q.startsWith("SELECT * FROM billing_orders") && q.includes("FOR UPDATE")) return { rows: [{ ...order }], rowCount: 1 };
    if (q.startsWith("INSERT INTO billing_order_refund_records")) { refundInsertCount += 1; events.push("INSERT_PROVIDER_REFUND"); assert.equal(values[1], 9.9); return { rows: [], rowCount: 1 }; }
    if (q.startsWith("UPDATE billing_orders SET provider_payment_status = 'REFUNDED'")) {
      events.push("MARK_REFUNDED");
      return { rows: [{ ...order, status: "refunded", provider_payment_status: "REFUNDED", provider_payment_checked_at: values[2], refunded_amount_yuan: 9.9, refunded_at: values[2] }], rowCount: 1 };
    }
    throw new Error("Unexpected transaction reconciliation SQL: " + q);
  }, release() { events.push("RELEASE"); } };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const store = createPgBillingStore(pool);
  const result = await store.recordProviderTransactionStatus!(order.id, "REFUNDED", "TRADE-1", checkedAt.toISOString(), 9.9, 3);
  assert.equal(result.providerPaymentStatus, "REFUNDED");
  assert.equal(result.status, "refunded");
  assert.equal(result.refundedAmountYuan, 9.9);
  assert.equal(result.providerPaidCheckedAt, checkedAt.toISOString());
  assert.equal(refundInsertCount, 1);
  assert.deepEqual(events, ["BEGIN", "INSERT_PROVIDER_REFUND", "MARK_REFUNDED", "COMMIT", "RELEASE"]);
  assert.ok(queries.some((q) => q.includes("provider_paid_checked_at = COALESCE(provider_paid_checked_at, $3)")));
});
