import { useEffect, useState, type FormEvent } from "react";
import type { AuthUser, SiteInboxMessage } from "../../types/client";
import { useTimedNotice } from "../../utils/clientPlatform";

export function SiteInboxPanel({ user, onLogin }: { user: AuthUser | null; onLogin: () => void }) {
  const [messages, setMessages] = useState<SiteInboxMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useTimedNotice();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [subject, setSubject] = useState("产品建议");
  const [feedback, setFeedback] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useTimedNotice();

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    let active = true;
    fetch("/api/v1/inbox", { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error?.message || "站内信读取失败");
        if (active) {
          const rows = (payload.messages ?? []) as SiteInboxMessage[];
          setMessages(rows);
          setSelectedId((current) => current ?? rows[0]?.id ?? null);
        }
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "站内信读取失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user?.id, setError]);

  const openMessage = async (message: SiteInboxMessage) => {
    setSelectedId(message.id);
    if (message.readAt) return;
    try {
      const response = await fetch(`/api/v1/inbox/${encodeURIComponent(message.id)}/read`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) return;
      setMessages((current) =>
        current.map((item) => (item.id === message.id ? { ...item, readAt: new Date().toISOString() } : item))
      );
    } catch {
      /* Reading the message remains available even if the read receipt cannot be saved. */
    }
  };

  const sendFeedback = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user) {
      onLogin();
      return;
    }
    if (!feedback.trim()) {
      setNotice("请填写反馈内容");
      return;
    }
    setSending(true);
    setNotice("");
    try {
      const response = await fetch("/api/v1/support/messages", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject, message: feedback.trim() }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "反馈提交失败");
      setFeedback("");
      setNotice("反馈已提交，我们会认真查看。");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "反馈提交失败，请稍后重试");
    } finally {
      setSending(false);
    }
  };

  const selected = messages.find((message) => message.id === selectedId) ?? null;
  const unreadCount = messages.filter((message) => !message.readAt).length;

  return (
    <section className="site-inbox-panel">
      <div className="panel-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m4 7 8 6 8-6" />
        </svg>
      </div>
      <h2 id="header-panel-title">站内信</h2>
      <p className="header-panel-copy">查看简兮通知，向我们反馈问题，或联系商务合作。</p>
      {!user ? (
        <div className="panel-empty-state">
          <strong>登录后查看站内信</strong>
          <span>欢迎信、功能通知和反馈记录将与账号关联保存。</span>
          <button className="panel-primary-action" type="button" onClick={onLogin}>
            登录账号
          </button>
        </div>
      ) : (
        <>
          <div className="site-inbox-section">
            <div className="site-inbox-section-heading">
              <strong>收件箱</strong>
              <span>{unreadCount > 0 ? `${unreadCount} 封未读` : `${messages.length} 封信件`}</span>
            </div>
            {loading ? (
              <p className="site-inbox-muted">正在读取站内信…</p>
            ) : error ? (
              <p className="site-inbox-error" role="alert">
                {error}
              </p>
            ) : messages.length === 0 ? (
              <p className="site-inbox-muted">暂时没有新信件。</p>
            ) : (
              <div className="site-inbox-layout">
                <div className="site-inbox-list">
                  {messages.map((message) => (
                    <button
                      type="button"
                      key={message.id}
                      className={`site-inbox-item ${selectedId === message.id ? "is-selected" : ""}`}
                      onClick={() => void openMessage(message)}
                    >
                      <span className="site-inbox-item-title">{message.subject}</span>
                      <span className="site-inbox-item-meta">
                        {message.category === "welcome"
                          ? "欢迎信"
                          : message.category === "features"
                          ? "功能介绍"
                          : "通知"}{" "}
                        · {message.readAt ? "已读" : "未读"}
                      </span>
                    </button>
                  ))}
                </div>
                {selected && (
                  <article className="site-inbox-reading">
                    <h3>{selected.subject}</h3>
                    <p>{selected.body}</p>
                    <time>{selected.publishedAt ? new Date(selected.publishedAt).toLocaleString("zh-CN") : ""}</time>
                  </article>
                )}
              </div>
            )}
          </div>
          <div className="site-inbox-section">
            <div className="site-inbox-section-heading">
              <strong>意见反馈</strong>
              <span>问题与建议直达后台</span>
            </div>
            <form className="site-inbox-feedback" onSubmit={sendFeedback}>
              <select aria-label="反馈类型" value={subject} onChange={(event) => setSubject(event.target.value)}>
                <option value="产品建议">产品建议</option>
                <option value="功能问题">功能问题</option>
                <option value="账号与积分">账号与积分</option>
                <option value="其他反馈">其他反馈</option>
              </select>
              <textarea
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                maxLength={2000}
                rows={3}
                placeholder="请描述你遇到的问题或建议…"
              />
              {notice && (
                <p className="site-inbox-notice" role="status">
                  {notice}
                </p>
              )}
              <button className="panel-primary-action" type="submit" disabled={sending}>
                {sending ? "提交中…" : "提交反馈"}
              </button>
            </form>
          </div>
        </>
      )}
      <div className="site-inbox-section site-inbox-business">
        <div className="site-inbox-section-heading">
          <strong>商务合作</strong>
          <span>品牌合作与业务联系</span>
        </div>
        <a href="mailto:jansee@jansee.cn">jansee@jansee.cn</a>
      </div>
    </section>
  );
}

