import { opcpay as OpcpayClient, verifyWebhook } from "opcpay";
import type {
  Access,
  Capabilities,
  ChargingOption,
  Consumption,
  PayRecord,
  Product,
  Purchase,
  WebhookEvent,
} from "opcpay";
import type { Pool } from "pg";
import { syncOpcpayProductPricing, type OpcpayPricingSyncStatus } from "./opcpay-pricing.js";
import type { PricingCatalog } from "./pricing.js";
import {
  ALL_PRICING_PLANS,
  type BillingStore,
  type PayOrderRecord,
  type ProviderWebhookRecord,
} from "./billing.js";

interface OpcpayClientLike {
  capabilities(): Promise<Capabilities>;
  product(): Promise<Product>;
  purchase(input: { userId: string; idempotencyKey: string; skuId: string }): Promise<Purchase>;
  purchaseQuery(userId: string, idempotencyKey: string): Promise<PayRecord>;
  access(userId: string, amount?: number): Promise<Access>;
  consumption(userId: string, idempotencyKey: string): Promise<Consumption>;
  consume(input: { userId: string; idempotencyKey: string; amount: number; reason: string }): Promise<Consumption>;
  transactionQuery(input: { user_id: string; idempotency_key: string }): Promise<{ user_id: string; idempotency_key: string; status: string; trade_no?: string | null; checked_at?: string | null; status_source?: string | null }>;
}

export interface OpcpayServiceOptions {
  apiKey?: string;
  webhookSecret?: string;
  baseURL?: string;
  pool?: Pool;
  billingStore: BillingStore;
  client?: OpcpayClientLike;
}

export interface OpcpayCheckoutResult {
  order: PayOrderRecord;
  payUrl: string;
  qrImageUrl: string;
  expiresAt?: string;
}

export interface OpcpayReconcileResult {
  paid: boolean;
  pending: boolean;
  order?: PayOrderRecord;
  message?: string;
}

const activeLocalLocks = new Map<string, Promise<void>>();

function isConfirmedOrderConsumption(
  consumption: Consumption | null | undefined,
  idempotencyKey: string,
  amount: number,
  quotaUnit: "COUNT" | "POINT",
): boolean {
  return Boolean(
    consumption
    && consumption.status === "SUCCEEDED"
    && consumption.confirmed === true
    && consumption.idempotency_key === idempotencyKey
    && Number(consumption.consumed) === amount
    && consumption.quota_unit === quotaUnit,
  );
}

function resolveChargingOption(product: Product, order: PayOrderRecord): { option: ChargingOption; quotaAmount: number; quotaUnit: "COUNT" | "POINT" } {
  const plan = ALL_PRICING_PLANS.find((item) => item.id === order.packageId);
  if (!plan) throw new Error("本地套餐不存在，已阻止支付");
  if (product.capability_status !== "ENABLED") throw new Error("一人付商品尚未启用");
  if (!Array.isArray(product.charging_options) || product.charging_options.length === 0) throw new Error("一人付尚未配置收费档位");

  const expectedQuota = plan.credits % 200 === 0 ? plan.credits / 200 : -1;
  const candidates = product.charging_options.filter((item) =>
    item.billing_mode === "QUANTITY"
    && item.currency === "CNY"
    && item.quota_unit === "COUNT"
    && Number(item.quota_amount) === expectedQuota,
  );
  if (candidates.length === 0) throw new Error(`一人付未配置匹配权益数量的套餐档位：${plan.id}`);
  if (candidates.length > 1) throw new Error("一人付存在多个相同权益数量 SKU，已阻止支付");
  const option = candidates[0]!;
  if (Math.abs(Number(option.price) - order.amountYuan) >= 0.005) throw new Error("本地订单价格与一人付 SKU 价格不一致，已拦截");
  const quotaAmount = Number(option.quota_amount);
  if (!Number.isSafeInteger(quotaAmount) || quotaAmount <= 0 || quotaAmount !== expectedQuota || option.quota_unit !== "COUNT") {
    throw new Error("一人付 SKU 权益数量与简兮套餐积分不匹配，已拦截");
  }
  return { option, quotaAmount, quotaUnit: "COUNT" };
}

function safePaymentLink(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 4096) throw new Error("一人付未返回有效付款入口");
  let protocol = "";
  try { protocol = new URL(raw).protocol; } catch { throw new Error("一人付付款入口格式无效"); }
  if (!["https:", "alipay:", "alipays:", "alipayqr:"].includes(protocol)) throw new Error("一人付付款入口协议不受支持");
  return raw;
}

function safePaymentQrImageUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 4096) throw new Error("一人付未返回支付宝直接付款二维码");
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("一人付支付宝付款二维码地址无效"); }
  if (parsed.protocol !== "https:") throw new Error("一人付支付宝付款二维码必须使用 HTTPS 地址");
  return raw;
}

async function withUserLock<T>(pool: Pool | undefined, userId: string, run: () => Promise<T>): Promise<T> {
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(0, hashtext($1))", [userId]);
      try {
        return await run();
      } finally {
        await client.query("SELECT pg_advisory_unlock(0, hashtext($1))", [userId]).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  }

  const previous = activeLocalLocks.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  activeLocalLocks.set(userId, queued);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (activeLocalLocks.get(userId) === queued) activeLocalLocks.delete(userId);
  }
}

export class OpcpayService {
  private readonly client?: OpcpayClientLike;
  private readonly webhookSecret: string;
  private readonly billingStore: BillingStore;
  private readonly pool: Pool | undefined;
  private ready = false;
  private initialized = false;
  private lastInitError = "";
  private pricingSyncStatus: OpcpayPricingSyncStatus = { status: "not_configured", source: "OPCPAY", lastSyncedAt: null };
  private pricingCache?: { catalog: PricingCatalog; expiresAt: number };

  constructor(options: OpcpayServiceOptions) {
    this.webhookSecret = String(options.webhookSecret ?? "").trim();
    this.billingStore = options.billingStore;
    this.pool = options.pool;
    if (options.client) {
      this.client = options.client;
    } else if (String(options.apiKey ?? "").trim()) {
      this.client = new OpcpayClient({
        apiKey: String(options.apiKey).trim(),
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      });
    }
  }

  get configured(): boolean {
    return Boolean(this.client);
  }

  get webhookConfigured(): boolean {
    return Boolean(this.webhookSecret);
  }

  get isReady(): boolean {
    return this.ready && this.configured;
  }

  get statusReason(): string {
    if (this.isReady) return "";
    return this.lastInitError || (!this.client ? "OPCPAY_API_KEY 未配置" : "一人付尚未通过能力检查");
  }

  get pricingStatus(): OpcpayPricingSyncStatus {
    return { ...this.pricingSyncStatus };
  }

  async refreshPricingCatalog(force = false): Promise<PricingCatalog> {
    if (!this.client) throw new Error("OPCPAY_API_KEY 未配置");
    if (!force && this.pricingCache && this.pricingCache.expiresAt > Date.now()) return this.pricingCache.catalog;
    try {
      const product = await this.client.product();
      const synced = await syncOpcpayProductPricing(this.pool, product);
      this.pricingSyncStatus = synced.status;
      this.pricingCache = { catalog: synced.catalog, expiresAt: Date.now() + 15_000 };
      return synced.catalog;
    } catch (error) {
      this.pricingSyncStatus = {
        status: "error",
        source: "OPCPAY",
        lastSyncedAt: this.pricingSyncStatus.lastSyncedAt,
        message: error instanceof Error ? error.message.slice(0, 200) : "OPCPAY 价格同步失败",
      };
      throw error;
    }
  }

  async initialize(): Promise<boolean> {
    if (this.initialized) return this.isReady;
    this.initialized = true;
    if (!this.configured || !this.client) {
      this.initialized = false;
      return false;
    }
    try {
      const [capabilities, product] = await Promise.all([this.client.capabilities(), this.client.product()]);
      try {
        const synced = await syncOpcpayProductPricing(this.pool, product);
        this.pricingSyncStatus = synced.status;
        this.pricingCache = { catalog: synced.catalog, expiresAt: Date.now() + 15_000 };
      } catch (error) {
        this.pricingSyncStatus = {
          status: "error",
          source: "OPCPAY",
          lastSyncedAt: this.pricingSyncStatus.lastSyncedAt,
          message: error instanceof Error ? error.message.slice(0, 200) : "OPCPAY 价格同步失败",
        };
      }
      const flags = capabilities.capabilities;
      const required = flags.purchase_entry && flags.entitlement_query && flags.consumption && flags.purchase_request_query && flags.transaction_query;
      this.ready = capabilities.provider_configured && required && product.capability_status === "ENABLED";
      if (!this.ready) {
        this.lastInitError = "一人付项目未启用购买、权益查询、核销、购买查单或交易状态查询能力";
        this.initialized = false;
      } else {
        this.lastInitError = "";
      }
    } catch (error) {
      this.ready = false;
      this.initialized = false;
      this.lastInitError = error instanceof Error ? error.message.slice(0, 200) : "一人付连接失败";
    }
    return this.isReady;
  }

  async createCheckout(userId: string, order: PayOrderRecord): Promise<OpcpayCheckoutResult> {
    const client = this.client;
    if (!this.isReady || !client) throw new Error(this.statusReason);
    return withUserLock(this.pool, userId, async () => {
      let current = await this.billingStore.findOrderById(order.id);
      if (!current || current.userId !== userId || current.status !== "pending") {
        throw new Error("订单不存在、无权访问或状态不可支付");
      }
      if (!this.billingStore.attachPaymentIntent) {
        throw new Error("充值账本不支持持久化支付意图，已阻止发起付款");
      }
      const expiryCutoff = new Date(Date.now() - 5 * 60 * 1000);
      const existingPending = await this.billingStore.findPendingProviderOrders?.(userId, "opcpay") ?? [];
      for (const pending of existingPending) {
        const expiry = pending.paymentExpiresAt
          ? new Date(pending.paymentExpiresAt).getTime()
          : new Date(pending.createdAt).getTime() + 5 * 60 * 1000;
        if (expiry <= expiryCutoff.getTime()) await this.reconcileOrderLocked(userId, pending);
      }
      await this.billingStore.closeExpiredProviderOrders?.(userId, expiryCutoff);
      current = await this.billingStore.findOrderById(order.id);
      if (!current || current.userId !== userId || current.status !== "pending") {
        throw new Error("该订单已付款或已过期，请在订单记录中查看状态");
      }
      if (current.paymentProvider === "opcpay" && (current.providerQuotaBaseline === undefined || current.providerQuotaBaseline === null)) {
        throw new Error("该历史订单缺少下单前权益快照，已暂停支付和自动入账，请联系支持人员核对");
      }
      const product = await client.product();
      const synced = await syncOpcpayProductPricing(this.pool, product);
      this.pricingSyncStatus = synced.status;
      this.pricingCache = { catalog: synced.catalog, expiresAt: Date.now() + 15_000 };
      const { option, quotaAmount, quotaUnit } = resolveChargingOption(product, current);
      if (current.providerSkuId && current.providerSkuId !== option.sku_id) {
        throw new Error("原订单绑定的一人付 SKU 已变化，已阻止更换支付商品");
      }
      if (current.providerQuotaAmount && current.providerQuotaAmount !== quotaAmount) {
        throw new Error("原订单绑定的一人付权益数量已变化，已阻止重复下单");
      }
      if (current.paymentProvider === "opcpay" && current.payUrl) {
        if (current.paymentExpiresAt && new Date(current.paymentExpiresAt).getTime() <= Date.now()) {
          throw new Error("该付款入口已过期，请联系客服处理原订单后再重新购买");
        }
        // Prefer OPCPAY's original Alipay QR image URL. The purchase URL is a hosted
        // landing page and encoding it would force buyers through a second QR scan.
        let qrImageUrl = current.qrPayload && current.qrPayload !== current.payUrl
          ? safePaymentQrImageUrl(current.qrPayload)
          : "";
        if (!qrImageUrl) {
          const record = await client.purchaseQuery(userId, current.id);
          const response = record.response ?? record;
          qrImageUrl = safePaymentQrImageUrl(response.purchase_qr_code);
        }
        return { order: current, payUrl: current.payUrl, qrImageUrl, ...(current.paymentExpiresAt ? { expiresAt: current.paymentExpiresAt } : {}) };
      }

      let quotaBaseline = current.providerQuotaBaseline;
      if (quotaBaseline === undefined || quotaBaseline === null) {
        const baselineAccess = await client.access(userId, 1);
        if (baselineAccess.quota_unit && baselineAccess.quota_unit !== quotaUnit) {
          throw new Error("一人付当前权益单位与套餐配置不一致，已阻止创建订单");
        }
        quotaBaseline = Number(baselineAccess.remaining);
        if (!Number.isSafeInteger(quotaBaseline) || quotaBaseline < 0) {
          throw new Error("无法确认一人付下单前的权益余额，已阻止创建订单");
        }
      }

      // Persist the provider/user/order binding before the network purchase call.
      // If the request times out after OPCPAY accepted it, a retry must reuse this order's idempotency key.
      await this.billingStore.attachPaymentIntent(userId, current.id, {
        provider: "opcpay",
        skuId: option.sku_id,
        quotaAmount,
        quotaUnit,
        quotaBaseline,
        priceYuan: Number(option.price),
        priceVersion: Number(option.price_version),
        payUrl: "",
        expiresAt: current.paymentExpiresAt ?? new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });

      let purchase = await client.purchase({
        userId,
        idempotencyKey: current.id,
        skuId: option.sku_id,
      });
      if (purchase.status === "UNKNOWN") {
        try {
          const record = await client.purchaseQuery(userId, current.id);
          purchase = (record.response ?? record) as Purchase;
        } catch {
          throw new Error("一人付购买入口状态未知，请稍后用同一订单重试");
        }
      }
      if (purchase.status === "FAILED") {
        await this.billingStore.closeProviderOrder?.(userId, current.id);
        throw new Error(purchase.message || "一人付创建购买入口失败");
      }
      const payUrl = safePaymentLink(purchase.purchase_url);
      let qrImageUrl = "";
      try { qrImageUrl = safePaymentQrImageUrl(purchase.purchase_qr_code); } catch {
        // Keep the provider payment intent durable so a retry can recover the QR
        // from purchaseQuery without creating another purchase request.
      }
      const updatedOrder = await this.billingStore.attachPaymentIntent(userId, current.id, {
        provider: "opcpay",
        skuId: option.sku_id,
        quotaAmount,
        quotaUnit,
        quotaBaseline,
        priceYuan: Number(option.price),
        priceVersion: Number(option.price_version),
        payUrl,
        ...(qrImageUrl ? { qrPayload: qrImageUrl } : {}),
        ...(purchase.expire_time ? { expiresAt: purchase.expire_time } : {}),
      });
      if (!qrImageUrl) throw new Error("一人付未返回可直接扫码的支付宝付款二维码，请稍后重试；订单已保留，不会重复创建购买请求");
      return { order: updatedOrder, payUrl, qrImageUrl, ...(purchase.expire_time ? { expiresAt: purchase.expire_time } : {}) };
    });
  }

  async reconcileUser(userId: string): Promise<OpcpayReconcileResult[]> {
    if (!this.isReady || !this.client || !this.billingStore.findPendingProviderOrders) return [];
    return withUserLock(this.pool, userId, async () => {
      const results = await this.reconcilePendingOrdersLocked(userId);
      await this.billingStore.closeExpiredProviderOrders?.(userId, new Date(Date.now() - 20 * 60 * 1000));
      return results;
    });
  }

  async reconcileOrder(userId: string, orderId: string): Promise<OpcpayReconcileResult> {
    if (!this.isReady || !this.client) return { paid: false, pending: true, message: this.statusReason };
    return withUserLock(this.pool, userId, async () => {
      const requested = await this.billingStore.findOrderById(orderId);
      if (!requested || requested.userId !== userId) throw new Error("充值订单不存在");
      if (requested.status === "refunded" || requested.providerPaymentStatus === "REFUNDED") return { paid: false, pending: false, order: requested, message: "OPCPAY 已确认该交易退款" };
      if (requested.paymentProvider !== "opcpay") return { paid: requested.status === "paid", pending: requested.status === "pending", order: requested };
      return this.reconcileOrderLocked(userId, requested);
    });
  }

  private async reconcilePendingOrdersLocked(userId: string): Promise<OpcpayReconcileResult[]> {
    if (!this.billingStore.findPendingProviderOrders) return [];
    const pendingOrders = await this.billingStore.findPendingProviderOrders(userId, "opcpay");
    const paidOrders = await this.billingStore.findPaidProviderOrdersDue?.(userId, "opcpay") ?? [];
    const orders = [...pendingOrders, ...paidOrders.filter((paid) => !pendingOrders.some((pending) => pending.id === paid.id))];
    const results: OpcpayReconcileResult[] = [];
    for (const order of orders) {
      try {
        results.push(await this.reconcileOrderLocked(userId, order));
      } catch (error) {
        results.push({ paid: false, pending: true, order, message: error instanceof Error ? error.message : "支付状态暂不可用" });
      }
    }
    return results;
  }

  private async reconcileOrderLocked(userId: string, order: PayOrderRecord): Promise<OpcpayReconcileResult> {
    if (!this.client) return { paid: false, pending: true, order };
    if (order.status === "refunded" || order.providerPaymentStatus === "REFUNDED") return { paid: false, pending: false, order, message: "OPCPAY 已确认该交易退款" };
    if (!order.providerSkuId || (order.status !== "paid" && (!order.providerQuotaAmount || !order.providerQuotaUnit || order.providerQuotaBaseline === undefined || order.providerQuotaBaseline === null))) {
      return { paid: false, pending: true, order, message: "订单缺少已持久化的 SKU 或待履约权益快照，已阻止自动入账" };
    }
    if (!this.billingStore.recordProviderTransactionStatus) return { paid: false, pending: true, order, message: "充值账本尚未接入 OPCPAY 交易状态持久化，已阻止入账" };

    let transactionStatus: Awaited<ReturnType<OpcpayClientLike["transactionQuery"]>>;
    try {
      transactionStatus = await this.client.transactionQuery({ user_id: userId, idempotency_key: order.id });
    } catch {
      return { paid: false, pending: true, order, message: "暂时无法核验 OPCPAY 真实交易状态，未计入收入" };
    }
    if (transactionStatus.user_id !== userId || transactionStatus.idempotency_key !== order.id) {
      return { paid: false, pending: true, order, message: "OPCPAY 交易回执与本站用户或订单编号不匹配，已阻止入账" };
    }
    const reportedStatus = ["PAID", "PENDING", "REFUNDED", "UNKNOWN"].includes(transactionStatus.status)
      ? transactionStatus.status as "PAID" | "PENDING" | "REFUNDED" | "UNKNOWN"
      : "UNKNOWN";
    const validCheckedAt = Boolean(transactionStatus.checked_at && Number.isFinite(new Date(transactionStatus.checked_at).getTime()));
    const validTradeNo = typeof transactionStatus.trade_no === "string" && transactionStatus.trade_no.trim().length > 0;
    const validSource = transactionStatus.status_source === "ALIPAY_PURCHASE_QUERY_V3";
    const status = (reportedStatus === "PAID" || reportedStatus === "REFUNDED") && (!validCheckedAt || !validTradeNo || !validSource)
      ? "UNKNOWN"
      : reportedStatus;
    const checkedAt = validCheckedAt ? new Date(transactionStatus.checked_at!).toISOString() : new Date().toISOString();

    let recordedOrder: PayOrderRecord;
    if (status === "PENDING" || status === "UNKNOWN") {
      recordedOrder = await this.billingStore.recordProviderTransactionStatus(order.id, status, null, checkedAt);
      if (recordedOrder.providerPaymentStatus !== "PAID") {
        return { paid: false, pending: true, order: recordedOrder, message: status === "PENDING" ? "OPCPAY 尚未确认付款" : "OPCPAY 交易状态待确认，暂不入账" };
      }
    } else {
      let purchaseRecord: PayRecord;
      try {
        purchaseRecord = await this.client.purchaseQuery(userId, order.id);
      } catch {
        return { paid: false, pending: true, order, message: "OPCPAY 交易已返回最终状态，但购买记录暂不可核对，未入账" };
      }
      if (purchaseRecord.user_id !== userId || purchaseRecord.idempotency_key !== order.id || purchaseRecord.sku_id !== order.providerSkuId) {
        return { paid: false, pending: true, order, message: "OPCPAY 购买记录的用户、订单编号或 SKU 与本站记录不匹配，已阻止入账" };
      }
      let priceYuan = order.providerPriceYuan;
      let priceVersion = order.providerPriceVersion;
      if (priceYuan === undefined) {
        // Legacy V4 orders were created only after resolveChargingOption matched
        // amount_yuan to the OPCPAY SKU price; preserve that immutable order snapshot.
        priceYuan = order.amountYuan;
      }
      recordedOrder = await this.billingStore.recordProviderTransactionStatus(
        order.id, status, transactionStatus.trade_no!.trim(), checkedAt, priceYuan, priceVersion,
      );
      if (status === "REFUNDED") {
        return { paid: false, pending: false, order: recordedOrder, message: "OPCPAY 已确认退款，已从收入中冲减" };
      }
    }

    const verifiedPaid = recordedOrder.providerPaymentStatus === "PAID"
      && Boolean(recordedOrder.providerTradeNo) && Boolean(recordedOrder.providerPaidCheckedAt);
    if (!verifiedPaid) {
      return { paid: false, pending: true, order: recordedOrder, message: "OPCPAY 交易状态尚无完整支付凭证，暂不入账" };
    }
    if (order.status === "paid") return { paid: true, pending: false, order: recordedOrder };
    if (order.status !== "pending" && order.status !== "closed") return { paid: false, pending: false, order: recordedOrder, message: "订单状态不允许履约" };
    const quotaAmount = order.providerQuotaAmount;
    const quotaUnit = order.providerQuotaUnit;
    const quotaBaseline = order.providerQuotaBaseline;
    if (quotaAmount === undefined || quotaAmount <= 0 || !quotaUnit || quotaBaseline === undefined || quotaBaseline === null) {
      return { paid: false, pending: true, order: recordedOrder, message: "已确认付款，但订单缺少权益核销快照，暂不发放本站积分" };
    }

    const consumeKey = `${order.id}:c`;
    let previous: Consumption | null = null;
    try { previous = await this.client.consumption(userId, consumeKey); } catch { previous = null; }
    if (previous?.status === "SUCCEEDED" && previous.confirmed) {
      if (!isConfirmedOrderConsumption(previous, consumeKey, quotaAmount, quotaUnit)) {
        return { paid: false, pending: true, order, message: "一人付历史核销回执的请求号、数量或权益单位不匹配，已阻止入账" };
      }
      const paidOrder = await this.billingStore.fulfillOrder(order.id);
      return { paid: true, pending: false, order: paidOrder };
    }
    if (previous?.status === "PROCESSING" || previous?.status === "UNKNOWN") return { paid: false, pending: true, order };

    let access: Access;
    try { access = await this.client.access(userId, 1); } catch { return { paid: false, pending: true, order }; }
    if (access.quota_unit && access.quota_unit !== quotaUnit) {
      return { paid: false, pending: true, order, message: "一人付权益单位与订单配置不一致" };
    }
    const remaining = Number(access.remaining);
    const expectedRemaining = quotaBaseline + quotaAmount;
    if (!Number.isSafeInteger(remaining) || remaining < expectedRemaining) {
      return { paid: false, pending: true, order: recordedOrder, message: "OPCPAY 已确认付款，但本订单对应权益购买增量尚未到账，暂不发放本站积分" };
    }

    let consumption: Consumption;
    try {
      consumption = await this.client.consume({
        userId,
        idempotencyKey: consumeKey,
        amount: quotaAmount,
        reason: `简兮 ${order.packageName} 订单 ${order.id} 权益核销`,
      });
    } catch {
      return { paid: false, pending: true, order };
    }
    if (isConfirmedOrderConsumption(consumption, consumeKey, quotaAmount, quotaUnit)) {
      const paidOrder = await this.billingStore.fulfillOrder(order.id);
      return { paid: true, pending: false, order: paidOrder };
    }
    if (consumption.status === "SUCCEEDED" && consumption.confirmed) {
      return { paid: false, pending: true, order, message: "一人付核销回执的请求号、数量或权益单位不匹配，已阻止入账" };
    }
    return { paid: false, pending: true, order, ...(consumption.status === "FAILED" ? { message: consumption.message || "一人付权益核销失败，请联系客服" } : {}) };
  }

  async sweepPending(): Promise<number> {
    if (!this.isReady || !this.billingStore.listPendingProviderUsers) return 0;
    const users = await this.billingStore.listPendingProviderUsers("opcpay");
    let paid = 0;
    for (const userId of users) {
      const results = await this.reconcileUser(userId);
      paid += results.filter((result) => result.paid).length;
    }
    return paid;
  }

  async acceptWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ duplicate: boolean; userId: string }> {
    if (!this.webhookSecret) throw new Error("OPCPAY_WEBHOOK_SECRET 未配置");
    let event: WebhookEvent;
    try {
      event = verifyWebhook(rawBody, headers, this.webhookSecret) as WebhookEvent;
    } catch {
      throw new Error("OPCPAY_WEBHOOK_INVALID_SIGNATURE");
    }
    const userId = String(event.user_id || event.data?.user_id || "").trim();
    if (!event.id || !userId) throw new Error("一人付 Webhook 缺少事件 ID 或用户 ID");
    const record: ProviderWebhookRecord = {
      eventId: event.id,
      provider: "opcpay",
      eventType: event.type,
      userId,
      payload: event as unknown as Record<string, unknown>,
    };
    const inserted = this.billingStore.recordProviderWebhookEvent
      ? await this.billingStore.recordProviderWebhookEvent(record)
      : true;
    return { duplicate: !inserted, userId };
  }
}
