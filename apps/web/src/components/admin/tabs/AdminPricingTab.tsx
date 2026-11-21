import type { Dispatch, SetStateAction } from "react";
import type { AdminPricingCatalog, AdminPricingPlan } from "../../../types/admin";

interface AdminPricingTabProps {
  pricingCatalog: AdminPricingCatalog | null;
  strikePriceDrafts: Record<string, string>;
  setStrikePriceDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  strikePriceSavingId: string | null;
  saveStrikePrice: (groupKey: "members" | "boostPacks", plan: AdminPricingPlan) => Promise<void>;
}

export function AdminPricingTab({
  pricingCatalog,
  strikePriceDrafts,
  setStrikePriceDrafts,
  strikePriceSavingId,
  saveStrikePrice,
}: AdminPricingTabProps) {
  return (
            <div className="overview-viewport admin-pricing-viewport">
              <section className="overview-card admin-pricing-hero">
                <div>
                  <span className="admin-eyebrow">JANSEE / COMMERCE CONTROL</span>
                  <h2>{"\u4ef7\u683c\u540c\u6b65"}</h2>
                  <p>OPCPAY 是唯一价格来源。你只需在 OPCPAY 修改售价，简兮会自动读取并更新前端与新订单报价。</p>
                  <div className="admin-pricing-sync-status">
                    <strong>{pricingCatalog?.sync?.status === "synced" ? "OPCPAY 已连接 · 价格同步正常" : pricingCatalog?.sync?.status === "error" ? "价格同步异常" : "等待首次同步"}</strong>
                    <span>{pricingCatalog?.sync?.lastSyncedAt ? `最近同步：${new Date(pricingCatalog.sync.lastSyncedAt).toLocaleString("zh-CN")}` : "尚无成功同步记录"}</span>
                    {pricingCatalog?.sync?.message && <small>{pricingCatalog.sync.message}</small>}
                  </div>
                </div>
              </section>
              {!pricingCatalog ? (
                <section className="overview-card"><p>{"\u6b63\u5728\u8bfb\u53d6\u4ef7\u683c\u914d\u7f6e..."}</p></section>
              ) : ([
                { key: "members" as const, title: "\u4f1a\u5458\u5957\u9910", items: pricingCatalog.members },
                { key: "boostPacks" as const, title: "\u7b97\u529b\u52a0\u6cb9\u5305", items: pricingCatalog.boostPacks },
              ]).map((group) => (
                <section className={`overview-card admin-pricing-section admin-pricing-section-${group.key}`} key={group.key}>
                  <div className="admin-pricing-section-head"><h3>{group.title}</h3><span>{group.items.length} {"\u4e2a\u5546\u54c1"}</span></div>
                  <div className="admin-pricing-table">
                    {group.items.map((plan) => (
                      <div className="admin-pricing-row" key={plan.id}>
                        <div className="admin-pricing-product"><strong>{plan.name}</strong><small>{plan.id}</small></div>
                        <div className="admin-pricing-current"><small>OPCPAY 当前售价</small><strong>¥{plan.priceYuan.toFixed(2)}</strong></div>
                        <div className="admin-pricing-current admin-pricing-display-price"><small>Display original price (editable)</small><input aria-label={`${plan.name} display original price`} inputMode="decimal" value={strikePriceDrafts[plan.id] ?? plan.strikeYuan.replace(/^\u00a5/, "")} onChange={(event) => setStrikePriceDrafts((current) => ({ ...current, [plan.id]: event.target.value }))} /><button type="button" disabled={strikePriceSavingId === plan.id || (strikePriceDrafts[plan.id] ?? plan.strikeYuan) === plan.strikeYuan} onClick={() => void saveStrikePrice(group.key, plan)}>{strikePriceSavingId === plan.id ? "Saving?" : "Save"}</button></div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
              <p className="admin-pricing-footnote">OPCPAY 改价后，前端会在下一次自动刷新时更新；新订单按最新价格创建。已创建订单保留原金额，若 OPCPAY 已调整对应 SKU 价格，旧订单支付会被安全拦截，需重新下单。</p>
            </div>
  );
}
