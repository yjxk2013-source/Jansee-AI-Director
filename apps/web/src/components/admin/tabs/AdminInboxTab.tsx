import type { Dispatch, SetStateAction } from "react";
import type { AdminInboxMessage, SupportMessage } from "../../../types/admin";

interface AdminInboxTabProps {
  supportMessages: SupportMessage[];
  inboxMessages: AdminInboxMessage[];
  supportReplyDrafts: Record<string, string>;
  setSupportReplyDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  supportReplyBusyId: string | null;
  financeBusyId: string | null;
  inboxSubject: string;
  setInboxSubject: (value: string) => void;
  inboxCategory: AdminInboxMessage["category"];
  setInboxCategory: (category: AdminInboxMessage["category"]) => void;
  inboxBody: string;
  setInboxBody: (value: string) => void;
  inboxBusy: boolean;
  inboxEditingId: string | null;
  fetchInboxMessages: () => Promise<void>;
  replyToSupportMessage: (message: SupportMessage) => Promise<void>;
  resolveSupportMessage: (message: SupportMessage) => Promise<void>;
  saveInboxMessage: (status: "draft" | "published") => Promise<void>;
  editInboxMessage: (message: AdminInboxMessage) => void;
  deleteInboxMessage: (message: AdminInboxMessage) => Promise<void>;
  resetInboxEditor: () => void;
}

export function AdminInboxTab({
  supportMessages,
  inboxMessages,
  supportReplyDrafts,
  setSupportReplyDrafts,
  supportReplyBusyId,
  financeBusyId,
  inboxSubject,
  setInboxSubject,
  inboxCategory,
  setInboxCategory,
  inboxBody,
  setInboxBody,
  inboxBusy,
  inboxEditingId,
  fetchInboxMessages,
  replyToSupportMessage,
  resolveSupportMessage,
  saveInboxMessage,
  editInboxMessage,
  deleteInboxMessage,
  resetInboxEditor,
}: AdminInboxTabProps) {
  return (
            <div className="overview-viewport partner-finance-viewport admin-inbox-viewport">
              <section className="overview-card admin-inbox-card">
                <div className="admin-inbox-section-heading">
                  <h3>用户来信 · {supportMessages.filter((message) => message.status !== "resolved").length} 封待处理</h3>
                  <button type="button" className="admin-inbox-refresh" onClick={() => void fetchInboxMessages()}>刷新来信</button>
                </div>
                <details className="admin-inbox-collapse">
                  <summary>展开用户来信（共 {supportMessages.length} 封）</summary>
                  <div className="admin-inbox-collapse-content">
                    {supportMessages.length === 0 ? (
                      <div className="admin-empty-state">暂时没有用户来信。用户通过前台「意见反馈」提交的内容会显示在这里。</div>
                    ) : supportMessages.map((message) => (
                      <article className="partner-finance-card admin-inbox-message" key={message.id}>
                        <div className="partner-finance-card-head">
                          <div><strong>{message.subject}</strong><span>{message.displayName} · {message.contact || "未提供联系方式"} · {new Date(message.createdAt).toLocaleString("zh-CN")}</span></div>
                          <span className={"status-pill " + (message.status === "resolved" ? "completed" : message.status === "unread" ? "pending" : "active")}>{message.status === "resolved" ? "已处理" : message.status === "unread" ? "未读" : "已读"}</span>
                        </div>
                        <div className="partner-finance-details admin-inbox-message-body">{message.message}</div>
                        <div className="admin-inbox-reply">
                          <label htmlFor={"support-reply-" + message.id}>回复用户</label>
                          <textarea id={"support-reply-" + message.id} rows={3} maxLength={4000} value={supportReplyDrafts[message.id] ?? ""} onChange={(event) => setSupportReplyDrafts((current) => ({ ...current, [message.id]: event.target.value }))} placeholder="输入回复内容，发送后用户可在站内信中收到…" />
                          <div className="partner-finance-actions">
                            <button disabled={supportReplyBusyId === message.id} onClick={() => void replyToSupportMessage(message)}>{supportReplyBusyId === message.id ? "发送中…" : "发送回复"}</button>
                            {message.status !== "resolved" && <button disabled={financeBusyId === message.id} onClick={() => void resolveSupportMessage(message)}>{financeBusyId === message.id ? "处理中…" : "标记为已处理"}</button>}
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                </details>
              </section>
              <section className="overview-card admin-inbox-card">
                <h3>站内信编辑与发布</h3>
                <p className="partner-finance-disclaimer">发布后，所有用户均可在前台站内信中查看；草稿仅管理员可见。欢迎信和功能指南已预置，可直接编辑。</p>
                <div className="inbox-admin-editor">
                  <label>信件标题<input value={inboxSubject} maxLength={120} onChange={(event) => setInboxSubject(event.target.value)} placeholder="请输入标题" /></label>
                  <label>信件类型<select value={inboxCategory} onChange={(event) => setInboxCategory(event.target.value as AdminInboxMessage["category"])}><option value="welcome">欢迎信</option><option value="features">功能信</option><option value="notice">普通通知</option></select></label>
                  <label>信件正文<textarea value={inboxBody} maxLength={4000} rows={5} onChange={(event) => setInboxBody(event.target.value)} placeholder="请输入要发送给用户的内容" /></label>
                  <div className="partner-finance-actions">
                    <button disabled={inboxBusy} onClick={() => void saveInboxMessage("draft")}>{inboxBusy ? "保存中…" : "保存草稿"}</button>
                    <button disabled={inboxBusy} onClick={() => void saveInboxMessage("published")}>{inboxBusy ? "发布中…" : "发布给所有用户"}</button>
                    {inboxEditingId && <button disabled={inboxBusy} onClick={resetInboxEditor}>取消编辑</button>}
                  </div>
                </div>
              </section>
              <section className="overview-card admin-inbox-card">
                <details className="admin-inbox-collapse">
                  <summary>已发布信件与草稿（共 {inboxMessages.length} 封）</summary>
                  <div className="admin-inbox-collapse-content">
                    {inboxMessages.length === 0 ? <div className="admin-empty-state">暂无站内信，填写上方内容即可创建。</div> : inboxMessages.map((message) => (
                      <article className="partner-finance-card admin-inbox-message" key={message.id}>
                        <div className="partner-finance-card-head">
                          <div><strong>{message.subject}</strong><span>{message.category === "welcome" ? "欢迎信" : message.category === "features" ? "功能信" : "普通通知"} · 更新于 {new Date(message.updatedAt).toLocaleString("zh-CN")}</span></div>
                          <span className={"status-pill " + (message.status === "published" ? "completed" : "pending")}>{message.status === "published" ? "已发布" : "草稿"}</span>
                        </div>
                        <div className="partner-finance-details admin-inbox-message-body">{message.body}</div>
                        <div className="partner-finance-actions">
                          {message.status === "published"
                            ? <button disabled={inboxBusy} onClick={() => editInboxMessage(message)}>编辑已发布信件</button>
                            : <button disabled={inboxBusy} onClick={() => editInboxMessage(message)}>编辑草稿</button>}
                          <button disabled={inboxBusy} onClick={() => void deleteInboxMessage(message)}>删除</button>
                        </div>
                      </article>
                    ))}
                  </div>
                </details>
              </section>
            </div>
  );
}
