import type { Pool } from "pg";
import type { Product, ChargingOption } from "opcpay";
import { MEMBER_PLANS, BOOST_PACKS, type PricingPlan } from "./billing.js";
import { savePricingCatalog, type PricingCatalog } from "./pricing.js";

export interface OpcpayPricingSyncStatus {
  status: "synced" | "error" | "not_configured";
  source: "OPCPAY";
  lastSyncedAt: string | null;
  productName?: string;
  priceVersions?: Record<string, number>;
  message?: string;
}

export interface OpcpayPricingSyncResult {
  catalog: PricingCatalog;
  status: OpcpayPricingSyncStatus;
}

function resolveOption(plan: PricingPlan, options: ChargingOption[]): ChargingOption {
  if (!Number.isSafeInteger(plan.credits) || plan.credits <= 0 || plan.credits % 200 !== 0) {
    throw new Error(`简兮套餐 ${plan.id} 的积分配置无法映射到一人付次数`);
  }
  const expectedQuota = plan.credits / 200;
  const matches = options.filter((option) =>
    option.billing_mode === "QUANTITY"
    && option.entitlement_rule === "QUOTA"
    && option.currency === "CNY"
    && option.quota_unit === "COUNT"
    && Number(option.quota_amount) === expectedQuota,
  );
  if (matches.length !== 1) {
    throw new Error(`OPCPAY 套餐映射异常：${plan.id} 权益数量与简兮套餐积分不匹配，应对应 ${expectedQuota} 次，实际匹配 ${matches.length} 个 SKU`);
  }
  const option = matches[0]!;
  const price = Number(option.price);
  if (!option.sku_id || !option.plan_id || !Number.isSafeInteger(option.price_version) || option.price_version < 1
    || !Number.isFinite(price) || price < 0.01 || Math.round(price * 100) !== price * 100) {
    throw new Error(`OPCPAY 套餐 ${plan.id} 的 SKU、价格或价格版本无效`);
  }
  return option;
}

export function mapOpcpayProductToPricing(product: Product): {
  catalog: PricingCatalog;
  priceVersions: Record<string, number>;
  skuIds: Record<string, string>;
} {
  if (product.capability_status !== "ENABLED") throw new Error("OPCPAY 商品未启用，无法同步价格");
  if (!Array.isArray(product.charging_options) || product.charging_options.length === 0) {
    throw new Error("OPCPAY 未返回有效收费档位");
  }
  const plans = [...MEMBER_PLANS, ...BOOST_PACKS];
  const options = plans.map((plan) => resolveOption(plan, product.charging_options));
  const skuIds = options.map((option) => option.sku_id);
  if (new Set(skuIds).size !== skuIds.length) throw new Error("OPCPAY 多个简兮套餐映射到了同一个 SKU，已阻止同步");

  const priceVersions: Record<string, number> = {};
  const priceById = new Map<string, number>();
  plans.forEach((plan, index) => {
    const option = options[index]!;
    priceById.set(plan.id, Number(option.price));
    priceVersions[plan.id] = option.price_version;
  });
  const apply = (group: PricingPlan[]) => group.map((plan) => ({
    ...plan,
    priceYuan: priceById.get(plan.id)!,
  }));
  return {
    catalog: { members: apply(MEMBER_PLANS), boostPacks: apply(BOOST_PACKS) },
    priceVersions,
    skuIds: Object.fromEntries(plans.map((plan, index) => [plan.id, options[index]!.sku_id])),
  };
}

export async function syncOpcpayProductPricing(
  pool: Pool | undefined,
  product: Product,
): Promise<OpcpayPricingSyncResult> {
  const mapped = mapOpcpayProductToPricing(product);
  const catalog = pool
    ? await savePricingCatalog(pool, mapped.catalog)
    : mapped.catalog;
  return {
    catalog,
    status: {
      status: "synced",
      source: "OPCPAY",
      lastSyncedAt: new Date().toISOString(),
      productName: product.product_name ?? "OPCPAY 商品",
      priceVersions: mapped.priceVersions,
    },
  };
}
