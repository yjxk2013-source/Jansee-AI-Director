import type { Pool } from "pg";
import { MEMBER_PLANS, BOOST_PACKS, type PricingPlan } from "./billing.js";

export interface PricingCatalog {
  members: PricingPlan[];
  boostPacks: PricingPlan[];
}

const CONFIG_ID = "default";

export async function getPricingCatalog(pool?: Pool): Promise<PricingCatalog> {
  const base: PricingCatalog = {
    members: MEMBER_PLANS.map((plan) => ({ ...plan })),
    boostPacks: BOOST_PACKS.map((plan) => ({ ...plan })),
  };
  if (!pool) return base;
  const result = await pool.query<{ config: { members?: Record<string, unknown>[]; boostPacks?: Record<string, unknown>[] } }>(
    "SELECT config FROM pricing_config WHERE id = $1 LIMIT 1", [CONFIG_ID],
  );
  const saved = result.rows[0]?.config;
  if (!saved) return base;
  const apply = (plans: PricingPlan[], overrides: Record<string, unknown>[] | undefined) => {
    const byId = new Map((overrides ?? []).map((item) => [String(item.id), item]));
    return plans.map((plan) => {
      const override = byId.get(plan.id);
      if (!override) return plan;
      return {
        ...plan,
        priceYuan: Number.isFinite(Number(override.priceYuan)) ? Number(override.priceYuan) : plan.priceYuan,
        strikeYuan: typeof override.strikeYuan === "string" ? override.strikeYuan : plan.strikeYuan,
      };
    });
  };
  return {
    members: apply(base.members, saved.members),
    boostPacks: apply(base.boostPacks, saved.boostPacks),
  };
}

export async function savePricingCatalog(pool: Pool, payload: unknown): Promise<PricingCatalog> {
  if (!payload || typeof payload !== "object") throw new Error("定价数据格式不正确");
  const input = payload as { members?: unknown; boostPacks?: unknown };
  const base: PricingCatalog = {
    members: MEMBER_PLANS.map((plan) => ({ ...plan })),
    boostPacks: BOOST_PACKS.map((plan) => ({ ...plan })),
  };
  const existingConfig = await pool.query<{ config: { members?: Record<string, unknown>[]; boostPacks?: Record<string, unknown>[] } }>("SELECT config FROM pricing_config WHERE id = $1 LIMIT 1", [CONFIG_ID]);
  const previous = existingConfig.rows[0]?.config ?? {};
  const normalize = (groupKey: "members" | "boostPacks", basePlans: PricingPlan[], rows: unknown, label: string) => {
    if (!Array.isArray(rows) || rows.length !== basePlans.length) throw new Error(`${label}套餐数量不匹配`);
    return basePlans.map((plan) => {
      const row = rows.find((item: any) => item && item.id === plan.id) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`缺少套餐：${plan.id}`);
      const priceYuan = Number(row.priceYuan);
      if (!Number.isFinite(priceYuan) || priceYuan < 0.01 || priceYuan > 100000 || Math.round(priceYuan * 100) !== priceYuan * 100) {
        throw new Error(`${plan.name}价格必须为 0.01 至 100000 元，最多两位小数`);
      }
      const savedStrike = (previous[groupKey] ?? []).find((item) => String(item.id) === plan.id)?.strikeYuan;
      const strikeYuan = typeof savedStrike === "string" ? savedStrike : (typeof row.strikeYuan === "string" ? row.strikeYuan.trim().slice(0, 24) : plan.strikeYuan);
      return { id: plan.id, priceYuan, strikeYuan };
    });
  };
  const config = {
    members: normalize("members", base.members, input.members, "会员"),
    boostPacks: normalize("boostPacks", base.boostPacks, input.boostPacks, "加油包"),
  };
  await pool.query(
    `INSERT INTO pricing_config (id, config, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [CONFIG_ID, JSON.stringify(config)],
  );
  return getPricingCatalog(pool);
}

export async function saveDisplayStrikePrice(pool: Pool, group: "members" | "boostPacks", id: string, strikeYuan: string): Promise<PricingCatalog> {
  const plans = group === "members" ? MEMBER_PLANS : BOOST_PACKS;
  if (!plans.some((plan) => plan.id === id)) throw new Error("Unknown pricing item");
  const raw = String(strikeYuan ?? "").trim();
  const match = raw.match(/^\u00a5?\s*(\d{1,6}(?:\.\d{1,2})?)\s*$/);
  if (!match) throw new Error("Enter a valid display price with up to two decimals");
  const normalized = "\u00a5" + match[1];
  const current = await pool.query<{ config: { members?: Record<string, unknown>[]; boostPacks?: Record<string, unknown>[] } }>("SELECT config FROM pricing_config WHERE id = $1 LIMIT 1", [CONFIG_ID]);
  const config = current.rows[0]?.config ?? {};
  const rows = [...(config[group] ?? [])];
  const index = rows.findIndex((item) => String(item.id) === id);
  if (index >= 0) rows[index] = { ...rows[index], id, strikeYuan: normalized }; else rows.push({ id, strikeYuan: normalized });
  const next = { ...config, [group]: rows };
  await pool.query("INSERT INTO pricing_config (id, config, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()", [CONFIG_ID, JSON.stringify(next)]);
  return getPricingCatalog(pool);
}