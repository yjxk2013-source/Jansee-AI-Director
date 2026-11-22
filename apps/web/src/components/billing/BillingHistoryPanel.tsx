import { useCallback, useEffect, useState } from "react";
import type { AuthUser, BillingHistoryKind, BillingLedgerEntry, BillingOrder } from "../../types/client";

export function BillingHistoryPanel({ user, kind }: { user: AuthUser | null; kind: BillingHistoryKind }) {
  const [orders, setOrders] = useState<BillingOrder[]>([]);
  const [entries, setEntries] = useState<BillingLedgerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [statusClock, setStatusClock] = useState(Date.now());
  const [resumingOrderId, setResumingOrderId] = useState<string | null>(null);
  const [payment, setPayment] = useState<{ orderId: string; payUrl: string; qrImageUrl: string; expiresAt?: string } | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setStatusClock(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError("");
    try {
      const endpoint = kind === "orders" ? "/api/v1/billing/orders" : "/api/v1/billing/ledger";
      const response = await fetch(endpoint, { credentials: "include", headers: { accept: "application/json" } });
      const responseText = await response.text();
      let payload: { orders?: BillingOrder[]; entries?: BillingLedgerEntry[]; error?: { message?: string } } = {};
      if (responseText.trim()) {
        try {
          payload = JSON.parse(responseText) as typeof payload;
        } catch {
          if (response.ok) throw new Error("服务器返回的数据无法识别，请稍后刷新重试。");
        }
      }
      if (!response.ok) {
        throw new Error(
          payload.error?.message ||
          (response.status === 401
            ? "登录状态已失效，请重新登录。"
            : response.status >= 500
              ? "服务器暂时无法读取交易记录，请稍后重试。"
              : "暂时无法读取交易记录，请稍后重试。")
        );
      }
      if (!responseText.trim()) throw new Error("服务器暂时没有返回记录数据，请稍后刷新重试。");
      if (kind === "orders") {
        if (!Array.isArray(payload.orders)) throw new Error("订单数据格式异常，请稍后重试。");
        setOrders([...payload.orders].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
      } else {
        if (!Array.isArray(payload.entries)) throw new Error("积分流水数据格式异常，请稍后重试。");
        setEntries([...payload.entries].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
      }
      setShowAll(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "网络异常，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [kind, user]);

  useEffect(() => {
    void load();
  }, [load]);

  // 继续付款：通过 checkout 接口幂等恢复支付入口后弹出扫码窗口。
  // 不能直接打开存储的 payUrl——它可能是 alipays:// 深链，PC 浏览器无法唤起。
  async function resumePayment(orderId: string) {
    if (resumingOrderId) return;
    setResumingOrderId(orderId);
    setError("");
    try {
      const response = await fetch(`/api/v1/billing/orders/${encodeURIComponent(orderId)}/checkout`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const payload = (await response.json()) as {
        payUrl?: string;
        qrImageUrl?: string;
        expiresAt?: string;
        error?: { message?: string };
      };
      if (!response.ok || !payload.payUrl || !payload.qrImageUrl) {
        throw new Error(payload.error?.message || "支付入口创建失败，请稍后重试");
      }
      setPayment({
        orderId,
        payUrl: payload.payUrl,
        qrImageUrl: payload.qrImageUrl,
        ...(payload.expiresAt ? { expiresAt: payload.expiresAt } : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发起付款失败，请稍后重试");
    } finally {
      setResumingOrderId(null);
    }
  }

  // 付款弹窗打开期间轮询对账接口，支付成功后自动关闭弹窗并刷新订单状态。
  useEffect(() => {
    if (!payment) return;
    let active = true;
    const checkPayment = async () => {
      try {
        const response = await fetch(`/api/v1/billing/orders/${encodeURIComponent(payment.orderId)}/reconcile`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { tradeState?: string; order?: { status?: string } };
        if (active && (payload.tradeState === "PAID" || payload.order?.status === "paid")) {
          setPayment(null);
          void load();
        }
      } catch {
        // 临时网络抖动不中断轮询；服务端对账兜底仍然有效。
      }
    };
    void checkPayment();
    const timer = window.setInterval(() => {
      void checkPayment();
    }, 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [payment, load]);

  if (!user) {
    return (
      <div className="billing-history-state">
        <strong>请先登录</strong>
        <span>登录后可查看与当前账户关联的订单和积分流水。</span>
      </div>
    );
  }

  const rows = kind === "orders" ? orders : entries;
  const visibleRows = showAll ? rows : rows.slice(0, 3);
  const orderStatus: Record<BillingOrder["status"], string> = {
    pending: "待支付",
    paid: "已入账",
    closed: "已失效",
    refund_requested: "退款申请中",
    refunding: "退款处理中",
    refunded: "已退款",
  };
  const isOrderExpired = (order: BillingOrder) => {
    if (order.status !== "pending") return false;
    const expiryTime = order.paymentExpiresAt
      ? Date.parse(order.paymentExpiresAt)
      : Date.parse(order.createdAt) + 5 * 60 * 1000;
    return !Number.isNaN(expiryTime) && expiryTime <= statusClock;
  };
  const ledgerType: Record<BillingLedgerEntry["type"], string> = {
    grant: "积分赠送",
    hold: "制作冻结",
    settle: "制作扣除",
    refund: "失败返还",
    recharge: "购买积分",
    compensation: "积分补偿",
  };
  const ledgerSourceLabel = (entry: BillingLedgerEntry) => {
    const description = entry.description.toLowerCase();
    if (entry.type === "refund" && entry.orderId) return "购买积分退款回收";
    if (entry.type === "recharge" || entry.orderId) return "购买积分";
    if (description.includes("签到")) return "签到积分";
    if (description.includes("邀请") || description.includes("推广") || description.includes("注册奖励"))
      return "推广积分";
    if (description.includes("注册") || description.includes("新账号")) return "注册积分";
    return ledgerType[entry.type] || "积分变动";
  };

  return (
    <>
      <section className="billing-history">
        <div className="billing-history-heading">
          <strong id="header-panel-title">{kind === "orders" ? "订单记录" : "积分明细"}</strong>
          <span>{kind === "orders" ? "仅展示当前账户创建的订单" : "按发生时间倒序展示账本记录"}</span>
          <button type="button" className="billing-history-refresh" onClick={() => void load()}>
            刷新
          </button>
        </div>
        {error && (
          <div className="billing-history-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => void load()}>
              重试
            </button>
          </div>
        )}
        {loading ? (
          <div className="billing-history-state" role="status">
            正在读取记录…
          </div>
        ) : rows.length === 0 && !error ? (
          <div className="billing-history-state">
            <strong>{kind === "orders" ? "暂无订单" : "暂无积分记录"}</strong>
            <span>{kind === "orders" ? "创建的订单会显示在这里。" : "积分赠送、冻结、扣除和返还记录会显示在这里。"}</span>
          </div>
        ) : (
          <>
            <div className="billing-history-list">
              {kind === "orders"
                ? (visibleRows as BillingOrder[]).map((order) => (
                  <article className="billing-history-row" key={order.id}>
                    <div className="billing-history-main">
                      <strong>{order.packageName}</strong>
                      <span>{order.id}</span>
                      <small>{new Date(order.createdAt).toLocaleString("zh-CN")}</small>
                    </div>
                    <div className="billing-history-value">
                      <strong>¥{Number(order.amountYuan).toFixed(2)}</strong>
                      <span
                        className={
                          "billing-status billing-status-" + (isOrderExpired(order) ? "closed" : order.status)
                        }
                      >
                        {isOrderExpired(order) ? "已失效" : orderStatus[order.status] || "状态未知"}
                      </span>
                      <small>{Number(order.credits).toLocaleString()} 积分</small>
                      {order.status === "pending" && !isOrderExpired(order) && (
                        <button
                          type="button"
                          className="billing-order-resume"
                          disabled={resumingOrderId === order.id}
                          onClick={() => void resumePayment(order.id)}
                        >
                          {resumingOrderId === order.id ? "正在发起付款…" : "继续付款"}
                        </button>
                      )}
                      {isOrderExpired(order) && (
                        <small className="billing-order-expired">付款时间已结束，请重新创建订单</small>
                      )}
                      {order.status === "paid" && (
                        <>
                          <small>如需退款或处理订单问题，请发送站内信联系简兮管理员，由人工核实处理。</small>
                          <button
                            type="button"
                            className="billing-order-resume"
                            onClick={async () => {
                              const message = window.prompt("请填写退款原因或订单问题");
                              if (!message?.trim()) return;
                              try {
                                const response = await fetch("/api/v1/support/messages", {
                                  method: "POST",
                                  credentials: "include",
                                  headers: {
                                    "content-type": "application/json",
                                    accept: "application/json",
                                  },
                                  body: JSON.stringify({
                                    orderId: order.id,
                                    subject: "退款/订单处理申请",
                                    message: message.trim(),
                                  }),
                                });
                                const payload = (await response.json().catch(() => ({}))) as {
                                  error?: { message?: string };
                                };
                                if (!response.ok) throw new Error(payload.error?.message || "站内信发送失败");
                                window.alert("站内信已发送，管理员核实后会处理。");
                              } catch (cause) {
                                window.alert(cause instanceof Error ? cause.message : "站内信发送失败");
                              }
                            }}
                          >
                            发送站内信
                          </button>
                        </>
                      )}
                      {order.status === "refund_requested" && (
                        <small className="billing-refund-window">购买积分已暂时预留，等待商户后台完成真实退款</small>
                      )}
                    </div>
                  </article>
                ))
                : (visibleRows as BillingLedgerEntry[]).map((entry) => (
                  <article className="billing-history-row" key={entry.id}>
                    <div className="billing-history-main">
                      <strong>{ledgerSourceLabel(entry)}</strong>
                      <span>{entry.description}</span>
                      <small>
                        {new Date(entry.createdAt).toLocaleString("zh-CN")}
                        {entry.orderId ? ` · 订单 ${entry.orderId}` : ""}
                      </small>
                    </div>
                    <div className="billing-history-value">
                      <strong
                        className={
                          ["hold", "settle"].includes(entry.type) ||
                            (entry.type === "refund" && Boolean(entry.orderId))
                            ? "billing-amount-negative"
                            : "billing-amount-positive"
                        }
                      >
                        {["hold", "settle"].includes(entry.type) ||
                          (entry.type === "refund" && Boolean(entry.orderId))
                          ? "−"
                          : "+"}
                        {Math.abs(Number(entry.amount)).toLocaleString()} 积分
                      </strong>
                    </div>
                  </article>
                ))}
            </div>
            {rows.length > 3 && (
              <div className="billing-history-pagination">
                <span>{showAll ? `全部 ${rows.length} 条记录` : `显示最近 3 条，共 ${rows.length} 条`}</span>
                <button type="button" onClick={() => setShowAll((value) => !value)}>
                  {showAll ? "收起" : `更多（${rows.length - 3}）`}
                </button>
              </div>
            )}
          </>
        )}
      </section>
      {payment && (
        <div className="payment-dialog-overlay">
          <section
            className="payment-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="payment-resume-title"
          >
            <button
              type="button"
              className="payment-dialog-close"
              aria-label="关闭付款窗口"
              onClick={() => setPayment(null)}
            >
              ×
            </button>
            <h3 id="payment-resume-title">扫码完成支付</h3>
            <p>请使用支付宝扫描二维码</p>
            <img className="payment-dialog-qr" src={payment.qrImageUrl} alt="支付宝直接付款二维码" />
            <a className="payment-dialog-link" href={payment.payUrl} target="_blank" rel="noreferrer">
              手机支付宝打开付款页
            </a>
            <small>付款成功后自动核对，积分与会员权益将自动到账</small>
            {payment.expiresAt && <small>付款入口有效至 {new Date(payment.expiresAt).toLocaleString("zh-CN")}</small>}
            <button type="button" className="payment-dialog-done" onClick={() => setPayment(null)}>
              稍后查看
            </button>
          </section>
        </div>
      )}
    </>
  );
}

