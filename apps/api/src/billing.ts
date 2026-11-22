import { randomUUID } from "node:crypto";

export const GENERATION_COST_CREDITS = 200;

/**
 * 免费入口：个人创作、一句话剪辑。
 * 这些入口进入的任务不冻结、不核销、不退还积分；worker 只负责完成状态流转。
 */
export function isFreeCreationEntry(scene: unknown): boolean {
  return scene === "personal-creation" || scene === "quick-cut";
}

export interface WalletRecord {
  userId: string;
  availableCredits: number;
  frozenCredits: number;
  totalSpentCredits: number;
  updatedAt: string;
}

export type LedgerType = "grant" | "hold" | "settle" | "refund" | "recharge" | "compensation" | "adjust";

export interface BillingLedgerRecord {
  id: string;
  userId: string;
  jobId?: string;
  orderId?: string;
  type: LedgerType;
  amount: number;
  description: string;
  createdAt: string;
}

export interface PricingPlan {
  id: string;
  name: string;
  kind: "membership" | "points";
  tierId?: "lite" | "plus" | "pro" | "ultra";
  priceYuan: number;
  strikeYuan: string;
  credits: number;
  clipsText: string;
  cycleText: string;
  description: string;
  badge?: string;
}

// 唯一线上真相源：4 档会员套餐（单月订阅 · 不自动续费）
export const MEMBER_PLANS: PricingPlan[] = [
  {
    id: "lite",
    name: "Lite 体验版",
    kind: "membership",
    tierId: "lite",
    priceYuan: 41,
    strikeYuan: "¥69",
    credits: 7600,
    clipsText: "约 38 条成片",
    cycleText: "单月",
    description: "1080P高清，轻量创作",
  },
  {
    id: "plus",
    name: "Plus 日常版",
    kind: "membership",
    tierId: "plus",
    priceYuan: 119,
    strikeYuan: "¥199",
    credits: 24800,
    clipsText: "约 124 条成片",
    cycleText: "单月",
    description: "高峰优先渲染，日常高频出片",
  },
  {
    id: "pro",
    name: "Pro 旗舰版",
    kind: "membership",
    tierId: "pro",
    priceYuan: 299,
    strikeYuan: "¥499",
    credits: 66600,
    clipsText: "约 333 条成片",
    cycleText: "单月",
    description: "商业级运镜，品牌批量创作",
    badge: "主推爆款",
  },
  {
    id: "ultra",
    name: "Ultra 团队版",
    kind: "membership",
    tierId: "ultra",
    priceYuan: 599,
    strikeYuan: "¥999",
    credits: 153800,
    clipsText: "约 769 条成片",
    cycleText: "单月",
    description: "旗舰算力，团队批量创作",
  },
];

// 唯一线上真相源：1 个小加油包
export const BOOST_PACKS: PricingPlan[] = [
  {
    id: "boost_small",
    name: "1,000 算力加油包",
    kind: "points",
    priceYuan: 9.9,
    strikeYuan: "¥19.9",
    credits: 1000,
    clipsText: "约 5 次成片",
    cycleText: "永久",
    description: "得 1,000 积分 · 约 5 次成片 · 算力即时到账 · 无需按月订阅",
    badge: "基础补给",
  },
];

export const ALL_PRICING_PLANS: PricingPlan[] = [...MEMBER_PLANS, ...BOOST_PACKS];

// 兼容别名导出
export const RECHARGE_PACKAGES = ALL_PRICING_PLANS;

export interface PayOrderRecord {
  id: string;
  userId: string;
  packageId: string;
  packageName: string;
  amountYuan: number;
  credits: number;
  status: "pending" | "paid" | "closed" | "refund_requested" | "refunding" | "refunded";
  paymentProvider?: "opcpay";
  providerSkuId?: string;
  providerQuotaAmount?: number;
  providerQuotaUnit?: "COUNT" | "POINT";
  providerQuotaBaseline?: number;
  providerPriceYuan?: number;
  providerPriceVersion?: number;
  providerPaymentStatus?: "UNKNOWN" | "PENDING" | "PAID" | "REFUNDED";
  providerTradeNo?: string;
  providerPaymentCheckedAt?: string;
  providerPaidCheckedAt?: string;
  refundedAmountYuan?: number;
  refundedAt?: string;
  payUrl?: string;
  qrPayload?: string;
  paymentExpiresAt?: string;
  createdAt: string;
  paidAt?: string;
}

export interface MembershipRecord {
  userId: string;
  tierId: "lite" | "plus" | "pro" | "ultra";
  startsAt: string;
  expiresAt: string;
  active: boolean;
}

export interface PaymentIntentDetails {
  provider: "opcpay";
  skuId: string;
  quotaAmount: number;
  quotaUnit: "COUNT" | "POINT";
  quotaBaseline: number;
  priceYuan: number;
  priceVersion: number;
  payUrl?: string;
  qrPayload?: string;
  expiresAt?: string;
}

export interface ProviderWebhookRecord {
  eventId: string;
  provider: "opcpay";
  eventType: string;
  userId: string;
  payload: Record<string, unknown>;
}

export interface BillingStore {
  getWallet(userId: string): Promise<WalletRecord>;
  holdCredits(userId: string, jobId: string, amount: number): Promise<WalletRecord>;
  settleCredits(userId: string, jobId: string): Promise<WalletRecord>;
  completeJobAndSettle?(userId: string, jobId: string, workerId: string): Promise<WalletRecord>;
  refundCredits(userId: string, jobId: string): Promise<WalletRecord>;
  grantCredits(userId: string, amount: number, description?: string, jobId?: string): Promise<WalletRecord>;
  adjustCredits?(userId: string, amount: number, description: string, adjustedBy?: string): Promise<WalletRecord>;
  getLedger(userId: string): Promise<BillingLedgerRecord[]>;

  // 充值、外部支付与会员权益
  createOrder(userId: string, packageId: string, priceYuan?: number): Promise<PayOrderRecord>;
  findOrderById(orderId: string): Promise<PayOrderRecord | null>;
  attachPaymentIntent?(userId: string, orderId: string, intent: PaymentIntentDetails): Promise<PayOrderRecord>;
  findPendingProviderOrders?(userId: string, provider: "opcpay"): Promise<PayOrderRecord[]>;
  findPaidProviderOrdersDue?(userId: string, provider: "opcpay"): Promise<PayOrderRecord[]>;
  recordProviderTransactionStatus?(orderId: string, status: "PENDING" | "PAID" | "REFUNDED" | "UNKNOWN", tradeNo: string | null, checkedAt: string, priceYuan?: number, priceVersion?: number): Promise<PayOrderRecord>;
  closeExpiredProviderOrders?(userId: string, cutoff: Date): Promise<number>;
  closeProviderOrder?(userId: string, orderId: string): Promise<void>;
  listPendingProviderUsers?(provider: "opcpay"): Promise<string[]>;
  recordProviderWebhookEvent?(event: ProviderWebhookRecord): Promise<boolean>;
  getMembership?(userId: string): Promise<MembershipRecord | null>;
  fulfillOrder(orderId: string): Promise<PayOrderRecord>;
  listUserOrders(userId: string): Promise<PayOrderRecord[]>;
}

export class InMemoryBillingStore implements BillingStore {
  private wallets = new Map<string, WalletRecord>();
  private holds = new Map<string, { userId: string; jobId: string; amount: number }>();
  private ledgers: BillingLedgerRecord[] = [];
  private orders = new Map<string, PayOrderRecord>();
  private memberships = new Map<string, MembershipRecord>();
  private providerWebhookEvents = new Set<string>();
  private initialGrant: number;

  constructor(options?: { initialGrant?: number }) {
    this.initialGrant = options?.initialGrant ?? 600;
  }

  async getWallet(userId: string): Promise<WalletRecord> {
    let wallet = this.wallets.get(userId);
    if (!wallet) {
      wallet = {
        userId,
        availableCredits: this.initialGrant,
        frozenCredits: 0,
        totalSpentCredits: 0,
        updatedAt: new Date().toISOString(),
      };
      this.wallets.set(userId, wallet);
      if (this.initialGrant > 0) {
        this.ledgers.push({
          id: randomUUID(),
          userId,
          type: "grant",
          amount: this.initialGrant,
          description: "新账号注册体验积分",
          createdAt: new Date().toISOString(),
        });
      }
    }
    return { ...wallet };
  }

  async adjustCredits(userId: string, amount: number, description: string): Promise<WalletRecord> {
    if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000) throw new Error("积分调整数量必须是不为 0 的整数，单次上限 1,000,000");
    const wallet = await this.getWallet(userId);
    if (amount < 0 && wallet.availableCredits < -amount) {
      throw new Error(`积分不足：当前可用 ${wallet.availableCredits} 积分，无法扣减 ${-amount} 积分`);
    }
    wallet.availableCredits += amount;
    wallet.updatedAt = new Date().toISOString();
    this.wallets.set(userId, wallet);
    this.ledgers.push({
      id: randomUUID(),
      userId,
      type: "adjust",
      amount,
      description: description.slice(0, 300),
      createdAt: new Date().toISOString(),
    });
    return { ...wallet };
  }

  async holdCredits(userId: string, jobId: string, amount: number): Promise<WalletRecord> {
    const wallet = await this.getWallet(userId);
    if (wallet.availableCredits < amount) {
      throw new Error(`积分不足：当前可用 ${wallet.availableCredits} 积分，本次制作需要 ${amount} 积分`);
    }

    const existingHold = this.holds.get(jobId);
    if (existingHold) return wallet;

    wallet.availableCredits -= amount;
    wallet.frozenCredits += amount;
    wallet.updatedAt = new Date().toISOString();
    this.wallets.set(userId, wallet);

    this.holds.set(jobId, { userId, jobId, amount });
    this.ledgers.push({
      id: randomUUID(),
      userId,
      jobId,
      type: "hold",
      amount,
      description: `任务 ${jobId} 制作预冻结`,
      createdAt: new Date().toISOString(),
    });

    return { ...wallet };
  }

  async settleCredits(userId: string, jobId: string): Promise<WalletRecord> {
    const hold = this.holds.get(jobId);
    const wallet = await this.getWallet(userId);
    if (!hold) return wallet;

    const amount = hold.amount;
    wallet.frozenCredits = Math.max(0, wallet.frozenCredits - amount);
    wallet.totalSpentCredits += amount;
    wallet.updatedAt = new Date().toISOString();
    this.wallets.set(userId, wallet);
    this.holds.delete(jobId);

    this.ledgers.push({
      id: randomUUID(),
      userId,
      jobId,
      type: "settle",
      amount,
      description: `任务 ${jobId} 成片合成成功，正式核销积分`,
      createdAt: new Date().toISOString(),
    });

    return { ...wallet };
  }

  async refundCredits(userId: string, jobId: string): Promise<WalletRecord> {
    const hold = this.holds.get(jobId);
    const wallet = await this.getWallet(userId);
    if (!hold) return wallet;

    const amount = hold.amount;
    wallet.frozenCredits = Math.max(0, wallet.frozenCredits - amount);
    wallet.availableCredits += amount;
    wallet.updatedAt = new Date().toISOString();
    this.wallets.set(userId, wallet);
    this.holds.delete(jobId);

    this.ledgers.push({
      id: randomUUID(),
      userId,
      jobId,
      type: "refund",
      amount,
      description: `任务 ${jobId} 合成未完成，自动解冻返还积分`,
      createdAt: new Date().toISOString(),
    });

    return { ...wallet };
  }

  async grantCredits(userId: string, amount: number, description = "系统充值/补偿", jobId?: string): Promise<WalletRecord> {
    if (jobId && this.ledgers.some((entry) => entry.jobId === jobId && entry.type === "compensation")) return this.getWallet(userId);
    const wallet = await this.getWallet(userId);
    wallet.availableCredits += amount;
    wallet.updatedAt = new Date().toISOString();
    this.wallets.set(userId, wallet);

    this.ledgers.push({
      id: randomUUID(),
      userId,
      ...(jobId ? { jobId } : {}),
      type: jobId ? "compensation" : "grant",
      amount,
      description,
      createdAt: new Date().toISOString(),
    });

    return { ...wallet };
  }

  async getLedger(userId: string): Promise<BillingLedgerRecord[]> {
    return this.ledgers
      .filter((item) => item.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async createOrder(userId: string, packageId: string, priceYuan?: number): Promise<PayOrderRecord> {
    const pkg = ALL_PRICING_PLANS.find((p) => p.id === packageId);
    if (!pkg) throw new Error("指定的会员或加油包套餐不存在");
    const orderPrice = priceYuan ?? pkg.priceYuan;
    if (!Number.isFinite(orderPrice) || orderPrice <= 0) throw new Error("Invalid package price");

    const orderId = `PAY-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const order: PayOrderRecord = {
      id: orderId,
      userId,
      packageId: pkg.id,
      packageName: pkg.name,
      amountYuan: orderPrice,
      credits: pkg.credits,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.orders.set(orderId, order);
    return { ...order };
  }

  async findOrderById(orderId: string): Promise<PayOrderRecord | null> {
    const o = this.orders.get(orderId);
    return o ? { ...o } : null;
  }

  async attachPaymentIntent(userId: string, orderId: string, intent: PaymentIntentDetails): Promise<PayOrderRecord> {
    const order = this.orders.get(orderId);
    if (!order || order.userId !== userId || order.status !== "pending") throw new Error("充值订单不存在或状态不可支付");
    Object.assign(order, {
      paymentProvider: intent.provider,
      providerSkuId: intent.skuId,
      providerQuotaAmount: intent.quotaAmount,
      providerQuotaUnit: intent.quotaUnit,
      providerQuotaBaseline: intent.quotaBaseline,
      providerPriceYuan: intent.priceYuan,
      providerPriceVersion: intent.priceVersion,
      ...(intent.payUrl ? { payUrl: intent.payUrl } : {}),
      ...(intent.qrPayload ? { qrPayload: intent.qrPayload } : {}),
      ...(intent.expiresAt ? { paymentExpiresAt: intent.expiresAt } : {}),
    });
    return { ...order };
  }

  async findPendingProviderOrders(userId: string, provider: "opcpay"): Promise<PayOrderRecord[]> {
    return [...this.orders.values()]
      .filter((order) => order.userId === userId && order.status === "pending" && order.paymentProvider === provider)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((order) => ({ ...order }));
  }

  async findPaidProviderOrdersDue(userId: string, provider: "opcpay"): Promise<PayOrderRecord[]> {
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    return [...this.orders.values()]
      .filter((order) => order.userId === userId && order.paymentProvider === provider && ["paid", "closed"].includes(order.status)
        && ["UNKNOWN", "PENDING", "PAID"].includes(order.providerPaymentStatus ?? "UNKNOWN")
        && (!order.providerPaymentCheckedAt || new Date(order.providerPaymentCheckedAt).getTime() <= cutoff)
        && (order.status === "paid"
          ? new Date(order.createdAt).getTime() >= Date.now() - 30 * 24 * 60 * 60 * 1000
          : new Date(order.createdAt).getTime() >= Date.now() - 48 * 60 * 60 * 1000))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((order) => ({ ...order }));
  }

  async recordProviderTransactionStatus(orderId: string, status: "PENDING" | "PAID" | "REFUNDED" | "UNKNOWN", tradeNo: string | null, checkedAt: string, priceYuan?: number, priceVersion?: number): Promise<PayOrderRecord> {
    const order = this.orders.get(orderId);
    if (!order || order.paymentProvider !== "opcpay") throw new Error("OPCPAY_ORDER_NOT_FOUND");
    const current = order.providerPaymentStatus ?? "UNKNOWN";
    if (current !== "REFUNDED" && !(current === "PAID" && (status === "PENDING" || status === "UNKNOWN"))) {
      order.providerPaymentStatus = status;
    }
    if (tradeNo) order.providerTradeNo = tradeNo;
    if (priceYuan !== undefined && order.providerPriceYuan === undefined) order.providerPriceYuan = priceYuan;
    if (priceVersion !== undefined && order.providerPriceVersion === undefined) order.providerPriceVersion = priceVersion;
    order.providerPaymentCheckedAt = checkedAt;
    if (status === "PAID") order.providerPaidCheckedAt ??= checkedAt;
    if (status === "REFUNDED") {
      order.providerPaidCheckedAt ??= checkedAt;
      order.refundedAmountYuan = order.providerPriceYuan ?? priceYuan ?? order.amountYuan;
      order.refundedAt ??= checkedAt;
      order.status = "refunded";
    }
    this.orders.set(orderId, order);
    return { ...order };
  }

  async closeExpiredProviderOrders(userId: string, cutoff: Date): Promise<number> {
    let closed = 0;
    for (const order of this.orders.values()) {
      const expiresAt = order.paymentExpiresAt
        ? new Date(order.paymentExpiresAt).getTime()
        : new Date(order.createdAt).getTime() + 5 * 60 * 1000;
      if (order.userId === userId && order.status === "pending" && order.paymentProvider === "opcpay" && expiresAt <= cutoff.getTime()) {
        order.status = "closed";
        closed += 1;
      }
    }
    return closed;
  }

  async closeProviderOrder(userId: string, orderId: string): Promise<void> {
    const order = this.orders.get(orderId);
    if (order && order.userId === userId && order.status === "pending" && order.paymentProvider === "opcpay") order.status = "closed";
  }

  async listPendingProviderUsers(provider: "opcpay"): Promise<string[]> {
    return [...new Set([...this.orders.values()]
      .filter((order) => (order.status === "pending" && order.paymentProvider === provider)
        || (["paid", "closed"].includes(order.status) && order.paymentProvider === provider && ["UNKNOWN", "PENDING", "PAID"].includes(order.providerPaymentStatus ?? "UNKNOWN")
          && (!order.providerPaymentCheckedAt || new Date(order.providerPaymentCheckedAt).getTime() <= Date.now() - 6 * 60 * 60 * 1000)
          && (order.status === "paid"
            ? new Date(order.createdAt).getTime() >= Date.now() - 30 * 24 * 60 * 60 * 1000
            : new Date(order.createdAt).getTime() >= Date.now() - 48 * 60 * 60 * 1000)))
      .map((order) => order.userId))];
  }

  async recordProviderWebhookEvent(event: ProviderWebhookRecord): Promise<boolean> {
    if (this.providerWebhookEvents.has(event.eventId)) return false;
    this.providerWebhookEvents.add(event.eventId);
    return true;
  }

  async getMembership(userId: string): Promise<MembershipRecord | null> {
    const membership = this.memberships.get(userId);
    if (!membership) return null;
    return { ...membership, active: new Date(membership.expiresAt).getTime() > Date.now() };
  }

  async fulfillOrder(orderId: string): Promise<PayOrderRecord> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error("充值订单不存在");
    if (order.status === "paid") return { ...order };
    if (order.paymentProvider === "opcpay" && order.providerPaymentStatus !== "PAID") throw new Error("OPCPAY 交易尚未确认 PAID，禁止入账");
    if (order.status !== "pending" && order.status !== "closed") throw new Error("充值订单当前状态不可履约");

    order.status = "paid";
    order.paidAt = new Date().toISOString();
    this.orders.set(orderId, order);

    const wallet = await this.getWallet(order.userId);
    wallet.availableCredits += order.credits;
    wallet.updatedAt = new Date().toISOString();
    this.wallets.set(order.userId, wallet);

    this.ledgers.push({
      id: randomUUID(),
      userId: order.userId,
      orderId: order.id,
      type: "recharge",
      amount: order.credits,
      description: `购买【${order.packageName}】充值到账 +${order.credits} 积分`,
      createdAt: new Date().toISOString(),
    });
    const plan = ALL_PRICING_PLANS.find((item) => item.id === order.packageId);
    if (plan?.kind === "membership" && plan.tierId) {
      const current = this.memberships.get(order.userId);
      const now = Date.now();
      const currentExpiry = current ? Math.max(now, new Date(current.expiresAt).getTime()) : now;
      const startsAt = current && currentExpiry > now ? current.startsAt : new Date(now).toISOString();
      this.memberships.set(order.userId, {
        userId: order.userId,
        tierId: plan.tierId,
        startsAt,
        expiresAt: new Date(currentExpiry + 30 * 24 * 60 * 60 * 1000).toISOString(),
        active: true,
      });
    }

    return { ...order };
  }

  async listUserOrders(userId: string): Promise<PayOrderRecord[]> {
    return [...this.orders.values()]
      .filter((o) => o.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
