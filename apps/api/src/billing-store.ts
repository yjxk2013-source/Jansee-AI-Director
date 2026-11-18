import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  ALL_PRICING_PLANS,
  type BillingStore,
  type WalletRecord,
  type BillingLedgerRecord,
  type PayOrderRecord,
  type PaymentIntentDetails,
  type ProviderWebhookRecord,
  type MembershipRecord,
} from "./billing.js";

interface WalletRow {
  user_id: string;
  available_credits: string | number;
  frozen_credits: string | number;
  total_spent_credits: string | number;
  paid_available_credits: string | number;
  free_available_credits: string | number;
  updated_at: Date;
}

interface OrderRow {
  id: string;
  user_id: string;
  package_id: string;
  package_name: string;
  amount_yuan: string | number;
  credits: string | number;
  status: "pending" | "paid" | "closed" | "refund_requested" | "refunding" | "refunded";
  payment_provider: "opcpay" | null;
  provider_sku_id: string | null;
  provider_quota_amount: string | number | null;
  provider_quota_unit: "COUNT" | "POINT" | null;
  provider_quota_baseline: string | number | null;
  provider_price_yuan: string | number | null;
  provider_price_version: number | null;
  provider_payment_status: "UNKNOWN" | "PENDING" | "PAID" | "REFUNDED";
  provider_trade_no: string | null;
  provider_payment_checked_at: Date | string | null;
  provider_paid_checked_at: Date | string | null;
  refunded_amount_yuan: string | number;
  refunded_at: Date | string | null;
  pay_url: string | null;
  qr_payload: string | null;
  payment_expires_at: Date | string | null;
  created_at: Date | string;
  paid_at: Date | string | null;
}

interface MembershipRow {
  user_id: string;
  tier_id: "lite" | "plus" | "pro" | "ultra";
  starts_at: Date;
  expires_at: Date;
  updated_at: Date;
}

function mapWallet(row: WalletRow): WalletRecord {
  return {
    userId: row.user_id,
    availableCredits: Number(row.available_credits),
    frozenCredits: Number(row.frozen_credits),
    totalSpentCredits: Number(row.total_spent_credits),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toIsoTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("INVALID_DATABASE_TIMESTAMP");
  return date.toISOString();
}

function mapOrder(row: OrderRow): PayOrderRecord {
  return {
    id: row.id,
    userId: row.user_id,
    packageId: row.package_id,
    packageName: row.package_name,
    amountYuan: Number(row.amount_yuan),
    credits: Number(row.credits),
    status: row.status,
    ...(row.payment_provider ? { paymentProvider: row.payment_provider } : {}),
    ...(row.provider_sku_id ? { providerSkuId: row.provider_sku_id } : {}),
    ...(row.provider_quota_amount !== null && row.provider_quota_amount !== undefined ? { providerQuotaAmount: Number(row.provider_quota_amount) } : {}),
    ...(row.provider_quota_unit ? { providerQuotaUnit: row.provider_quota_unit } : {}),
    ...(row.payment_provider && row.provider_quota_baseline !== null && row.provider_quota_baseline !== undefined
      ? { providerQuotaBaseline: Number(row.provider_quota_baseline) }
      : {}),
    ...(row.provider_price_yuan !== null && row.provider_price_yuan !== undefined ? { providerPriceYuan: Number(row.provider_price_yuan) } : {}),
    ...(row.provider_price_version !== null && row.provider_price_version !== undefined ? { providerPriceVersion: Number(row.provider_price_version) } : {}),
    ...(row.payment_provider ? { providerPaymentStatus: row.provider_payment_status ?? "UNKNOWN" } : {}),
    ...(row.provider_trade_no ? { providerTradeNo: row.provider_trade_no } : {}),
    ...(row.provider_payment_checked_at ? { providerPaymentCheckedAt: toIsoTimestamp(row.provider_payment_checked_at) } : {}),
    ...(row.provider_paid_checked_at ? { providerPaidCheckedAt: toIsoTimestamp(row.provider_paid_checked_at) } : {}),
    ...(row.payment_provider ? { refundedAmountYuan: Number(row.refunded_amount_yuan ?? 0) } : {}),
    ...(row.refunded_at ? { refundedAt: toIsoTimestamp(row.refunded_at) } : {}),
    ...(row.pay_url ? { payUrl: row.pay_url } : {}),
    ...(row.qr_payload ? { qrPayload: row.qr_payload } : {}),
    ...(row.payment_expires_at ? { paymentExpiresAt: toIsoTimestamp(row.payment_expires_at) } : {}),
    createdAt: toIsoTimestamp(row.created_at),
    ...(row.paid_at ? { paidAt: toIsoTimestamp(row.paid_at) } : {}),
  };
}

async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function ensureWallet(client: PoolClient, userId: string): Promise<WalletRecord> {
  const inserted = await client.query<WalletRow>(
    "INSERT INTO wallets (user_id, available_credits, free_available_credits) VALUES ($1, 600, 600) ON CONFLICT (user_id) DO NOTHING RETURNING *",
    [userId],
  );
  if (inserted.rows[0]) {
    await client.query(
      "INSERT INTO billing_ledger (user_id, type, amount, free_amount, description) VALUES ($1, 'grant', 600, 600, $2)",
      [userId, "新账号注册体验积分"],
    );
    return mapWallet(inserted.rows[0]);
  }
  const existing = await client.query<WalletRow>("SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE", [userId]);
  if (!existing.rows[0]) throw new Error("钱包初始化失败");
  return mapWallet(existing.rows[0]);
}

export function createPgBillingStore(pool: Pool): BillingStore {
  return {
    async getWallet(userId) {
      return transaction(pool, (client) => ensureWallet(client, userId));
    },

    async holdCredits(userId, jobId, amount) {
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("积分冻结数量无效");
      return transaction(pool, async (client) => {
        const wallet = await ensureWallet(client, userId);
        const existing = await client.query("SELECT id FROM billing_ledger WHERE job_id = $1 AND user_id = $2 AND type = 'hold' LIMIT 1", [jobId, userId]);
        if (existing.rowCount) return wallet;
        if (wallet.availableCredits < amount) throw new Error(`积分不足：当前可用 ${wallet.availableCredits} 积分，本次制作需要 ${amount} 积分`);
        const assets = await client.query<{ paid_available_credits: string | number; free_available_credits: string | number }>(
          "SELECT paid_available_credits, free_available_credits FROM wallets WHERE user_id = $1 FOR UPDATE", [userId],
        );
        const paidBefore = Number(assets.rows[0]?.paid_available_credits ?? 0);
        const freeBefore = Number(assets.rows[0]?.free_available_credits ?? 0);
        const freeAmount = Math.min(freeBefore, amount);
        const paidAmount = amount - freeAmount;
        if (paidBefore < paidAmount) throw new Error("积分资产账本不一致，请联系支持人员处理");
        const updated = await client.query<WalletRow>(
          "UPDATE wallets SET available_credits = available_credits - $1, frozen_credits = frozen_credits + $1, free_available_credits = free_available_credits - $2, paid_available_credits = paid_available_credits - $3, updated_at = now() WHERE user_id = $4 RETURNING *",
          [amount, freeAmount, paidAmount, userId],
        );
        await client.query(
          "INSERT INTO billing_ledger (user_id, job_id, type, amount, paid_amount, free_amount, description) VALUES ($1, $2, 'hold', $3, $4, $5, $6)",
          [userId, jobId, amount, paidAmount, freeAmount, `任务 ${jobId} 制作预冻结`],
        );
        return mapWallet(updated.rows[0]!);
      });
    },

    async settleCredits(userId, jobId) {
      return transaction(pool, async (client) => {
        const wallet = await ensureWallet(client, userId);
        const hold = await client.query<{ amount: string | number }>(
          "SELECT amount FROM billing_ledger WHERE job_id = $1 AND user_id = $2 AND type = 'hold' LIMIT 1",
          [jobId, userId],
        );
        if (!hold.rows[0]) return wallet;
        const settled = await client.query("SELECT id FROM billing_ledger WHERE job_id = $1 AND type IN ('settle', 'refund') LIMIT 1", [jobId]);
        if (settled.rowCount) return wallet;
        const amount = Number(hold.rows[0].amount);
        const updated = await client.query<WalletRow>(
          "UPDATE wallets SET frozen_credits = greatest(0, frozen_credits - $1), total_spent_credits = total_spent_credits + $1, updated_at = now() WHERE user_id = $2 RETURNING *",
          [amount, userId],
        );
        await client.query(
          "INSERT INTO billing_ledger (user_id, job_id, type, amount, description) VALUES ($1, $2, 'settle', $3, $4)",
          [userId, jobId, amount, `任务 ${jobId} 成片合成成功，正式核销积分`],
        );
        return mapWallet(updated.rows[0]!);
      });
    },


    async completeJobAndSettle(userId, jobId, workerId) {
      return transaction(pool, async (client) => {
        const job = await client.query<{ status: string; worker_id: string | null }>(
          "SELECT status, worker_id FROM generation_jobs WHERE id = $1 AND user_id = $2 FOR UPDATE",
          [jobId, userId],
        );
        const owned = job.rows[0];
        if (!owned || owned.worker_id !== workerId || owned.status !== "quality-check") {
          throw new Error("WORKER_LEASE_LOST");
        }

        const wallet = await ensureWallet(client, userId);
        const hold = await client.query<{ amount: string | number }>(
          "SELECT amount FROM billing_ledger WHERE job_id = $1 AND user_id = $2 AND type = 'hold' LIMIT 1",
          [jobId, userId],
        );
        if (!hold.rows[0]) throw new Error("BILLING_HOLD_MISSING");
        const terminalLedger = await client.query<{ type: string }>(
          "SELECT type FROM billing_ledger WHERE job_id = $1 AND user_id = $2 AND type IN ('settle', 'refund') LIMIT 1",
          [jobId, userId],
        );
        if (terminalLedger.rows[0]?.type === "refund") throw new Error("BILLING_HOLD_ALREADY_REFUNDED");

        let finalWallet = wallet;
        if (!terminalLedger.rows[0]) {
          const amount = Number(hold.rows[0].amount);
          const updated = await client.query<WalletRow>(
            "UPDATE wallets SET frozen_credits = frozen_credits - $1, total_spent_credits = total_spent_credits + $1, updated_at = now() WHERE user_id = $2 AND frozen_credits >= $1 RETURNING *",
            [amount, userId],
          );
          if (!updated.rows[0]) throw new Error("BILLING_FROZEN_BALANCE_INVARIANT");
          await client.query(
            "INSERT INTO billing_ledger (user_id, job_id, type, amount, description) VALUES ($1, $2, 'settle', $3, $4)",
            [userId, jobId, amount, `任务 ${jobId} 成片合成成功，正式核销积分`],
          );
          finalWallet = mapWallet(updated.rows[0]);
        }

        const completed = await client.query(
          `UPDATE generation_jobs
           SET status = 'completed', progress = 100, error_code = NULL, error_message = NULL,
               finished_at = now(), worker_id = NULL, lease_expires_at = NULL,
               updated_at = now()
           WHERE id = $1 AND user_id = $2 AND worker_id = $3 AND status = 'quality-check'`,
          [jobId, userId, workerId],
        );
        if ((completed.rowCount ?? 0) !== 1) throw new Error("WORKER_LEASE_LOST");
        return finalWallet;
      });
    },

    async refundCredits(userId, jobId) {
      return transaction(pool, async (client) => {
        const wallet = await ensureWallet(client, userId);
        const hold = await client.query<{ amount: string | number; paid_amount: string | number; free_amount: string | number }>(
          "SELECT amount, paid_amount, free_amount FROM billing_ledger WHERE job_id = $1 AND user_id = $2 AND type = 'hold' LIMIT 1",
          [jobId, userId],
        );
        if (!hold.rows[0]) return wallet;
        const refunded = await client.query("SELECT id FROM billing_ledger WHERE job_id = $1 AND type IN ('refund', 'settle') LIMIT 1", [jobId]);
        if (refunded.rowCount) return wallet;
        const amount = Number(hold.rows[0].amount);
        const paidAmount = Number(hold.rows[0].paid_amount ?? 0);
        const freeAmount = Number(hold.rows[0].free_amount ?? amount);
        const updated = await client.query<WalletRow>(
          "UPDATE wallets SET frozen_credits = greatest(0, frozen_credits - $1), available_credits = available_credits + $1, paid_available_credits = paid_available_credits + $2, free_available_credits = free_available_credits + $3, updated_at = now() WHERE user_id = $4 RETURNING *",
          [amount, paidAmount, freeAmount, userId],
        );
        await client.query(
          "INSERT INTO billing_ledger (user_id, job_id, type, amount, paid_amount, free_amount, description) VALUES ($1, $2, 'refund', $3, $4, $5, $6)",
          [userId, jobId, amount, paidAmount, freeAmount, `任务 ${jobId} 合成未完成，自动解冻返还积分`],
        );
        return mapWallet(updated.rows[0]!);
      });
    },

    async grantCredits(userId, amount, description = "系统充值/补偿", jobId) {
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000) throw new Error("积分补偿数量超出允许范围");
      return transaction(pool, async (client) => {
        const wallet = await ensureWallet(client, userId);
        if (jobId) {
          const existing = await client.query("SELECT id FROM billing_ledger WHERE job_id = $1 AND type = 'compensation' LIMIT 1", [jobId]);
          if (existing.rowCount) return wallet;
        }
        const updated = await client.query<WalletRow>(
          "UPDATE wallets SET available_credits = available_credits + $1, free_available_credits = free_available_credits + $1, updated_at = now() WHERE user_id = $2 RETURNING *",
          [amount, userId],
        );
        await client.query(
          "INSERT INTO billing_ledger (user_id, job_id, type, amount, free_amount, description) VALUES ($1, $2, $3, $4, $4, $5)",
          [userId, jobId ?? null, jobId ? "compensation" : "grant", amount, description.slice(0, 300)],
        );
        return mapWallet(updated.rows[0]!);
      });
    },

    async getLedger(userId) {
      const result = await pool.query<{
        id: string; user_id: string; job_id: string | null; order_id: string | null;
        type: BillingLedgerRecord["type"]; amount: string | number; description: string; created_at: Date;
      }>("SELECT * FROM billing_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500", [userId]);
      return result.rows.map((row) => ({
        id: row.id, userId: row.user_id,
        ...(row.job_id ? { jobId: row.job_id } : {}),
        ...(row.order_id ? { orderId: row.order_id } : {}),
        type: row.type, amount: Number(row.amount), description: row.description, createdAt: row.created_at.toISOString(),
      }));
    },

    async createOrder(userId, packageId, priceYuan) {
      const plan = ALL_PRICING_PLANS.find((item) => item.id === packageId);
      if (!plan) throw new Error("指定的会员或加油包套餐不存在");
      const orderPrice = priceYuan ?? plan.priceYuan;
      if (!Number.isFinite(orderPrice) || orderPrice <= 0) throw new Error("Invalid package price");
      const id = `PAY-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`;
      const result = await pool.query<OrderRow>(
        "INSERT INTO billing_orders (id, user_id, package_id, package_name, amount_yuan, credits) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
        [id, userId, plan.id, plan.name, orderPrice, plan.credits],
      );
      return mapOrder(result.rows[0]!);
    },

    async findOrderById(orderId) {
      const result = await pool.query<OrderRow>("SELECT * FROM billing_orders WHERE id = $1 LIMIT 1", [orderId]);
      return result.rows[0] ? mapOrder(result.rows[0]) : null;
    },

    async attachPaymentIntent(userId, orderId, intent: PaymentIntentDetails) {
      return transaction(pool, async (client) => {
        const current = await client.query<OrderRow>(
          "SELECT * FROM billing_orders WHERE id = $1 AND user_id = $2 FOR UPDATE",
          [orderId, userId],
        );
        const order = current.rows[0];
        if (!order || order.status !== "pending") throw new Error("充值订单不存在或状态不可支付");
        if (order.payment_provider && order.payment_provider !== intent.provider) throw new Error("订单已绑定其他支付渠道");
        const updated = await client.query<OrderRow>(
          `UPDATE billing_orders
           SET payment_provider = $3, provider_sku_id = $4, provider_quota_amount = $5,
               provider_quota_unit = $6, provider_quota_baseline = $7,
               provider_price_yuan = $8, provider_price_version = $9,
               pay_url = COALESCE($10, pay_url), qr_payload = COALESCE($11, qr_payload),
               payment_expires_at = COALESCE($12, payment_expires_at)
           WHERE id = $1 AND user_id = $2 AND status = 'pending'
           RETURNING *`,
          [orderId, userId, intent.provider, intent.skuId, intent.quotaAmount, intent.quotaUnit, intent.quotaBaseline, intent.priceYuan, intent.priceVersion, intent.payUrl ?? null, intent.qrPayload ?? null, intent.expiresAt ? new Date(intent.expiresAt) : null],
        );
        if (!updated.rows[0]) throw new Error("充值订单状态已变化");
        return mapOrder(updated.rows[0]);
      });
    },

    async findPendingProviderOrders(userId, provider) {
      const result = await pool.query<OrderRow>(
        "SELECT * FROM billing_orders WHERE user_id = $1 AND payment_provider = $2 AND status = 'pending' ORDER BY created_at ASC LIMIT 50",
        [userId, provider],
      );
      return result.rows.map(mapOrder);
    },

    async findPaidProviderOrdersDue(userId, provider) {
      const result = await pool.query<OrderRow>(
        `SELECT * FROM billing_orders WHERE user_id = $1 AND payment_provider = $2 AND status IN ('paid', 'closed')
         AND provider_payment_status IN ('UNKNOWN', 'PENDING', 'PAID')
         AND (provider_payment_checked_at IS NULL OR provider_payment_checked_at <= now() - interval '6 hours')
         AND ((status = 'paid' AND created_at >= now() - interval '30 days')
           OR (status = 'closed' AND created_at >= now() - interval '48 hours'))
         ORDER BY created_at ASC LIMIT 50`,
        [userId, provider],
      );
      return result.rows.map(mapOrder);
    },

    async recordProviderTransactionStatus(orderId, status, tradeNo, checkedAt, priceYuan, priceVersion) {
      return transaction(pool, async (client) => {
        const current = await client.query<OrderRow>(
          "SELECT * FROM billing_orders WHERE id = $1 AND payment_provider = 'opcpay' FOR UPDATE", [orderId],
        );
        const order = current.rows[0];
        if (!order) throw new Error("OPCPAY_ORDER_NOT_FOUND");
        if (status === "REFUNDED") {
          const gross = Number(order.provider_price_yuan ?? priceYuan ?? order.amount_yuan);
          const remaining = Math.max(0, gross - Number(order.refunded_amount_yuan ?? 0));
          if (remaining > 0) {
            await client.query(
              `INSERT INTO billing_order_refund_records (order_id, amount_yuan, source, note)
               VALUES ($1, $2, 'opcpay', 'OPCPAY 单笔交易状态确认已退款')
               ON CONFLICT (order_id) WHERE source = 'opcpay' DO NOTHING`,
              [orderId, remaining],
            );
          }
          const updated = await client.query<OrderRow>(
            `UPDATE billing_orders SET provider_payment_status = 'REFUNDED',
               provider_trade_no = COALESCE($2, provider_trade_no), provider_payment_checked_at = $3,
               provider_price_yuan = COALESCE(provider_price_yuan, $4), provider_price_version = COALESCE(provider_price_version, $5),
               provider_paid_checked_at = COALESCE(provider_paid_checked_at, $3),
               refunded_amount_yuan = COALESCE(provider_price_yuan, $4, amount_yuan), refunded_at = COALESCE(refunded_at, $3), status = 'refunded'
             WHERE id = $1 RETURNING *`,
            [orderId, tradeNo, new Date(checkedAt), priceYuan ?? null, priceVersion ?? null],
          );
          return mapOrder(updated.rows[0]!);
        }
        const updated = await client.query<OrderRow>(
          `UPDATE billing_orders SET
             provider_payment_status = CASE
               WHEN provider_payment_status = 'REFUNDED' THEN 'REFUNDED'
               WHEN provider_payment_status = 'PAID' AND $2 IN ('PENDING', 'UNKNOWN') THEN 'PAID'
               ELSE $2 END,
             provider_trade_no = COALESCE($3, provider_trade_no),
             provider_payment_checked_at = $4,
             provider_price_yuan = COALESCE(provider_price_yuan, $5), provider_price_version = COALESCE(provider_price_version, $6),
             provider_paid_checked_at = CASE WHEN $2 = 'PAID' THEN COALESCE(provider_paid_checked_at, $4) ELSE provider_paid_checked_at END
           WHERE id = $1 RETURNING *`,
          [orderId, status, tradeNo, new Date(checkedAt), priceYuan ?? null, priceVersion ?? null],
        );
        return mapOrder(updated.rows[0]!);
      });
    },

    async closeExpiredProviderOrders(userId, cutoff) {
      const result = await pool.query(
        `UPDATE billing_orders
         SET status = 'closed'
         WHERE user_id = $1 AND payment_provider = 'opcpay' AND status = 'pending'
           AND COALESCE(payment_expires_at, created_at + interval '30 minutes') <= $2`,
        [userId, cutoff],
      );
      return result.rowCount ?? 0;
    },

    async closeProviderOrder(userId, orderId) {
      await pool.query(
        "UPDATE billing_orders SET status = 'closed' WHERE id = $1 AND user_id = $2 AND payment_provider = 'opcpay' AND status = 'pending'",
        [orderId, userId],
      );
    },

    async listPendingProviderUsers(provider) {
      const result = await pool.query<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM billing_orders WHERE payment_provider = $1 AND (status = 'pending' OR
          (status IN ('paid', 'closed') AND provider_payment_status IN ('UNKNOWN', 'PENDING', 'PAID')
            AND (provider_payment_checked_at IS NULL OR provider_payment_checked_at <= now() - interval '6 hours')
            AND ((status = 'paid' AND created_at >= now() - interval '30 days')
              OR (status = 'closed' AND created_at >= now() - interval '48 hours'))))`,
        [provider],
      );
      return result.rows.map((row) => row.user_id);
    },

    async recordProviderWebhookEvent(event: ProviderWebhookRecord) {
      const result = await pool.query(
        `INSERT INTO billing_provider_webhook_events (event_id, provider, event_type, user_id, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [event.eventId, event.provider, event.eventType.slice(0, 100), event.userId, JSON.stringify(event.payload)],
      );
      return (result.rowCount ?? 0) === 1;
    },

    async getMembership(userId): Promise<MembershipRecord | null> {
      const result = await pool.query<MembershipRow>(
        "SELECT * FROM user_memberships WHERE user_id = $1 LIMIT 1",
        [userId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        userId: row.user_id,
        tierId: row.tier_id,
        startsAt: row.starts_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        active: row.expires_at.getTime() > Date.now(),
      };
    },

    async fulfillOrder(orderId) {
      return transaction(pool, async (client) => {
        const orderResult = await client.query<OrderRow>("SELECT * FROM billing_orders WHERE id = $1 FOR UPDATE", [orderId]);
        const order = orderResult.rows[0];
        if (!order) throw new Error("充值订单不存在");
        if (order.status === "paid") return mapOrder(order);
        if (order.status !== "pending" && order.status !== "closed") throw new Error("充值订单当前状态不可履约");
        if (order.payment_provider === "opcpay" && order.provider_payment_status !== "PAID") throw new Error("OPCPAY 交易尚未确认 PAID，禁止入账");
        const wallet = await ensureWallet(client, order.user_id);
        const updatedOrder = await client.query<OrderRow>(
          "UPDATE billing_orders SET status = 'paid', paid_at = now() WHERE id = $1 RETURNING *",
          [orderId],
        );
        const updatedWallet = await client.query<WalletRow>(
          "UPDATE wallets SET available_credits = available_credits + $1, paid_available_credits = paid_available_credits + $1, updated_at = now() WHERE user_id = $2 RETURNING *",
          [Number(order.credits), order.user_id],
        );
        const purchasedPlan = ALL_PRICING_PLANS.find((item) => item.id === order.package_id);
        if (purchasedPlan?.kind === "membership" && purchasedPlan.tierId) {
          await client.query(
            `INSERT INTO user_memberships (user_id, tier_id, starts_at, expires_at)
             VALUES ($1, $2, now(), now() + interval '1 month')
             ON CONFLICT (user_id) DO UPDATE
             SET tier_id = EXCLUDED.tier_id,
                 starts_at = CASE WHEN user_memberships.expires_at > now() THEN user_memberships.starts_at ELSE now() END,
                 expires_at = GREATEST(user_memberships.expires_at, now()) + interval '1 month',
                 updated_at = now()`,
            [order.user_id, purchasedPlan.tierId],
          );
        }
        await client.query(
          "INSERT INTO billing_ledger (user_id, order_id, type, amount, paid_amount, description) VALUES ($1, $2, 'recharge', $3, $3, $4)",
          [order.user_id, orderId, Number(order.credits), `购买【${order.package_name}】充值到账 +${order.credits} 积分`],
        );

        // 城市合伙人返佣：只对真实会员订单计提；积分加油包不参与。
        if (purchasedPlan?.kind === "membership" && Number(order.amount_yuan) > 0) {
          const referral = await client.query<{
            inviter_id: string | null;
            inviter_partner_at: Date | null;
            parent_id: string | null;
            parent_partner_at: Date | null;
          }>(`
            SELECT inviter.id AS inviter_id, inviter.partner_activated_at AS inviter_partner_at,
                   parent.id AS parent_id, parent.partner_activated_at AS parent_partner_at
            FROM users payer
            LEFT JOIN users inviter ON inviter.id = payer.inviter_user_id AND inviter.deleted_at IS NULL
            LEFT JOIN users parent ON parent.id = inviter.inviter_user_id AND parent.deleted_at IS NULL
            WHERE payer.id = $1
            LIMIT 1
          `, [order.user_id]);
          const row = referral.rows[0];
          const paidAt = updatedOrder.rows[0]!.paid_at ?? new Date();
          const amount = Number(order.amount_yuan);
          if (row?.inviter_id && row.inviter_partner_at && row.inviter_partner_at <= paidAt) {
            await client.query(
              `INSERT INTO partner_commissions
                (beneficiary_user_id, source_user_id, order_id, level, order_amount_yuan, commission_rate, commission_amount_yuan)
               VALUES ($1, $2, $3, 1, $4, 0.15, round($4::numeric * 0.15, 2))
               ON CONFLICT (beneficiary_user_id, order_id, level) DO NOTHING`,
              [row.inviter_id, order.user_id, orderId, amount],
            );
          }
          if (row?.parent_id && row.parent_partner_at && row.parent_partner_at <= paidAt) {
            await client.query(
              `INSERT INTO partner_commissions
                (beneficiary_user_id, source_user_id, order_id, level, order_amount_yuan, commission_rate, commission_amount_yuan)
               VALUES ($1, $2, $3, 2, $4, 0.05, round($4::numeric * 0.05, 2))
               ON CONFLICT (beneficiary_user_id, order_id, level) DO NOTHING`,
              [row.parent_id, order.user_id, orderId, amount],
            );
          }
        }
        void wallet;
        void updatedWallet;
        return mapOrder(updatedOrder.rows[0]!);
      });
    },

    async listUserOrders(userId) {
      const result = await pool.query<OrderRow>("SELECT * FROM billing_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100", [userId]);
      return result.rows.map(mapOrder);
    },
  };
}
