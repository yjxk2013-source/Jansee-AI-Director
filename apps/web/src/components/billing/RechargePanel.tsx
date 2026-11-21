import { useEffect, useState } from "react";
import type { AuthUser } from "../../types/client";
import { useTimedNotice } from "../../utils/clientPlatform";

export function RechargePanel({
  user,
  credits,
  membership,
  onPaid,
}: {
  user: AuthUser | null;
  credits: number | null;
  membership: { tierId: string; expiresAt: string; active: boolean } | null;
  onPaid: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [checkout, setCheckout] = useState<{
    orderId: string;
    payUrl: string;
    qrImageUrl: string;
    expiresAt?: string;
  } | null>(null);
  const [checkoutVisible, setCheckoutVisible] = useState(false);
  const [notice, setNotice] = useTimedNotice();
  const [error, setError] = useTimedNotice();
  const [pricingCatalog, setPricingCatalog] = useState<{
    members: { id: string; priceYuan: number; strikeYuan: string }[];
    boostPacks: { id: string; priceYuan: number; strikeYuan: string }[];
  } | null>(null);

  useEffect(() => {
    let active = true;
    const refreshPricing = () => {
      fetch("/api/v1/pricing", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return null;
          return (await response.json()) as {
            members?: { id: string; priceYuan: number; strikeYuan: string }[];
            boostPacks?: { id: string; priceYuan: number; strikeYuan: string }[];
          };
        })
        .then((data) => {
          if (active && data?.members && data?.boostPacks)
            setPricingCatalog(data as NonNullable<typeof pricingCatalog>);
        })
        .catch(() => {});
    };
    refreshPricing();
    const timer = window.setInterval(refreshPricing, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const memberPlans = [
    {
      id: "lite",
      name: "Lite 体验版",
      price: pricingCatalog?.members.find((item) => item.id === "lite")?.priceYuan,
      strike: pricingCatalog?.members.find((item) => item.id === "lite")?.strikeYuan,
      credits: 7600,
      clipsText: "约 38 条成片",
      desc: "高清成片，轻松开启创作",
    },
    {
      id: "plus",
      name: "Plus 日常版",
      price: pricingCatalog?.members.find((item) => item.id === "plus")?.priceYuan,
      strike: pricingCatalog?.members.find((item) => item.id === "plus")?.strikeYuan,
      credits: 24800,
      clipsText: "约 124 条成片",
      desc: "高峰优先，创作更顺畅",
    },
    {
      id: "pro",
      name: "Pro 旗舰版",
      price: pricingCatalog?.members.find((item) => item.id === "pro")?.priceYuan,
      strike: pricingCatalog?.members.find((item) => item.id === "pro")?.strikeYuan,
      credits: 66600,
      clipsText: "约 333 条成片",
      desc: "最高优先级，专业创作之选",
      tag: "官方主推",
    },
    {
      id: "ultra",
      name: "Ultra 团队版",
      price: pricingCatalog?.members.find((item) => item.id === "ultra")?.priceYuan,
      strike: pricingCatalog?.members.find((item) => item.id === "ultra")?.strikeYuan,
      credits: 153800,
      clipsText: "约 769 条成片",
      desc: "大额积分，满足团队创作",
    },
  ];

  const boostPack = {
    id: "boost_small",
    name: "1,000 算力加油包",
    price: pricingCatalog?.boostPacks.find((item) => item.id === "boost_small")?.priceYuan,
    strike: pricingCatalog?.boostPacks.find((item) => item.id === "boost_small")?.strikeYuan,
    credits: 1000,
    clipsText: "约 5 次成片",
    desc: "即时到账，积分长期有效",
    tag: "基础补给",
  };

  async function handleBuy(packageId: string) {
    if (!user) {
      setError("请先登录账户后再进行充值");
      return;
    }
    if (user.id === "local-preview-user") {
      setError("当前为本地预览账号，不能创建真实订单。请连接 V4 数据库并使用真实账号登录后再购买。");
      return;
    }
    setLoading(true);
    setError("");
    setNotice("");
    setCheckout(null);
    try {
      const res = await fetch("/api/v1/billing/orders", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packageId }),
      });
      const data = (await res.json()) as { order?: { id: string }; error?: { message?: string } };
      if (!res.ok || !data.order) throw new Error(data.error?.message || "创建订单失败");

      const checkoutResponse = await fetch(`/api/v1/billing/orders/${encodeURIComponent(data.order.id)}/checkout`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const checkoutData = (await checkoutResponse.json()) as {
        payUrl?: string;
        qrImageUrl?: string;
        expiresAt?: string;
        error?: { message?: string };
      };
      if (!checkoutResponse.ok || !checkoutData.payUrl || !checkoutData.qrImageUrl) {
        throw new Error(checkoutData.error?.message || "支付入口暂不可用，请稍后重试");
      }
      setCheckout({
        orderId: data.order.id,
        payUrl: checkoutData.payUrl,
        qrImageUrl: checkoutData.qrImageUrl,
        ...(checkoutData.expiresAt ? { expiresAt: checkoutData.expiresAt } : {}),
      });
      setCheckoutVisible(true);
      setNotice("请使用支付宝完成付款。支付成功后，积分和会员权益会自动到账。");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "充值异常，请稍后重试";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!checkout) return;
    let active = true;
    const checkPayment = async () => {
      try {
        const response = await fetch(`/api/v1/billing/orders/${encodeURIComponent(checkout.orderId)}/reconcile`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { tradeState?: string; order?: { status?: string } };
        if (active && (payload.tradeState === "PAID" || payload.order?.status === "paid")) {
          setCheckout(null);
          setCheckoutVisible(false);
          setNotice("支付成功，积分与会员权益已到账。");
          setError("");
          onPaid();
        }
      } catch {
        // The server-side reconciliation sweep remains active if the browser temporarily disconnects.
      }
    };
    void checkPayment();
    const timer = window.setInterval(() => {
      void checkPayment();
    }, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [checkout, onPaid, setError, setNotice]);

  return (
    <>
      <>
        <div className="credit-center-heading">
          <h2 id="header-panel-title">算力积分</h2>
          <p className="header-panel-copy">用于简兮 AI 导演生成与制作</p>
        </div>
        <div className="credit-balance">
          <span>当前余额</span>
          <strong>{credits !== null ? credits.toLocaleString() : "—"}</strong>
          <span>积分</span>
          <small>带货视频、门店获客每生成 1 条成片消耗 200 积分；个人创作与一句话剪辑免费</small>
          {membership?.active && (
            <small className="credit-membership-status">
              当前会员：{membership.tierId.toUpperCase()} · 到期{" "}
              {new Date(membership.expiresAt).toLocaleDateString("zh-CN")}
            </small>
          )}
        </div>

        {notice && (
          <p className="credit-notice" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}

        <div className="credit-products">
          <section className="credit-product-section">
            <div className="credit-section-title">会员方案</div>
            <div className="credit-plan-list">
              {memberPlans.map((plan) => (
                <div key={plan.id} className={`credit-plan-card${plan.tag ? " is-featured" : ""}`}>
                  <div>
                    <div className="credit-plan-main">
                      <strong>{plan.name}</strong>
                      {plan.tag && <span className="credit-plan-tag">{plan.tag}</span>}
                    </div>
                    <div className="credit-plan-detail">
                      <strong>+{plan.credits.toLocaleString()}</strong> 积分
                      <span>{plan.clipsText}</span>
                    </div>
                    <div className="credit-plan-desc">{plan.desc}</div>
                  </div>
                  <button
                    type="button"
                    className="credit-buy-button"
                    disabled={loading || typeof plan.price !== "number"}
                    onClick={() => handleBuy(plan.id)}
                  >
                    {typeof plan.price === "number" ? `¥${plan.price}` : "..."}
                    {plan.strike && <span className="credit-old-price">{plan.strike}</span>}
                  </button>
                </div>
              ))}
            </div>
          </section>
          <section className="credit-product-section">
            <div className="credit-section-title">
              算力加油卡 <span>无需订阅</span>
            </div>
            <div className="credit-plan-card credit-topup-card">
              <div>
                <div className="credit-plan-main">
                  <strong>{boostPack.name}</strong>
                  <span className="credit-plan-tag">{boostPack.tag}</span>
                </div>
                <div className="credit-plan-detail">
                  <strong>+{boostPack.credits.toLocaleString()}</strong> 积分 <span>{boostPack.clipsText}</span>
                </div>
                <div className="credit-plan-desc">{boostPack.desc}</div>
              </div>
              <button
                type="button"
                className="credit-buy-button"
                disabled={loading || typeof boostPack.price !== "number"}
                onClick={() => handleBuy(boostPack.id)}
              >
                {typeof boostPack.price === "number" ? `¥${boostPack.price}` : "..."}
                {boostPack.strike && <span className="credit-old-price">{boostPack.strike}</span>}
              </button>
            </div>
          </section>
        </div>
      </>
      {checkout && checkoutVisible && (
        <div className="payment-dialog-overlay">
          <section
            className="payment-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="payment-dialog-title"
          >
            <button
              type="button"
              className="payment-dialog-close"
              aria-label="关闭付款窗口"
              onClick={() => setCheckoutVisible(false)}
            >
              ×
            </button>
            <h3 id="payment-dialog-title">扫码完成支付</h3>
            <p>请使用支付宝扫描二维码</p>
            <img className="payment-dialog-qr" src={checkout.qrImageUrl} alt="支付宝直接付款二维码" />
            <a className="payment-dialog-link" href={checkout.payUrl} target="_blank" rel="noreferrer">
              无法扫码？打开支付页面
            </a>
            <small>付款成功后自动核对，积分与会员权益将自动到账</small>
            {checkout.expiresAt && <small>付款入口有效至 {new Date(checkout.expiresAt).toLocaleString("zh-CN")}</small>}
            <button type="button" className="payment-dialog-done" onClick={() => setCheckoutVisible(false)}>
              稍后查看
            </button>
          </section>
        </div>
      )}
    </>
  );
}

