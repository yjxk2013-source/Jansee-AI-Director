import type { Dispatch, SetStateAction } from "react";
import type { AuthUser, WorkItem } from "../../types/client";

interface SidebarDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  startNewConversation: () => void;
  isGuestViewer: boolean;
  walletCredits: number | null;
  setActiveHeaderPanel: (panel: "works" | "login" | "recharge" | "orders" | "ledger" | "inbox" | "install" | "admin" | "admin-login" | null) => void;
  authUser: AuthUser | null;
  recentWorksLoading: boolean;
  recentWorks: WorkItem[];
  recentWorksExpanded: boolean;
  setRecentWorksExpanded: Dispatch<SetStateAction<boolean>>;
}

export function SidebarDrawer({
  isOpen,
  onClose,
  startNewConversation,
  isGuestViewer,
  walletCredits,
  setActiveHeaderPanel,
  authUser,
  recentWorksLoading,
  recentWorks,
  recentWorksExpanded,
  setRecentWorksExpanded,
}: SidebarDrawerProps) {
  if (!isOpen) return null;

  return (
    <div className="navigation-layer">
      <button
        className="navigation-backdrop"
        type="button"
        aria-label="关闭导航菜单"
        onClick={onClose}
      />
      <aside className="navigation-drawer" aria-label="主导航">
        <div className="drawer-header">
          <button className="drawer-close" type="button" aria-label="关闭菜单" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <button className="drawer-new-chat" type="button" onClick={startNewConversation}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span>新的创作</span>
        </button>
        <nav className="drawer-utility-links" aria-label="工具导航">
          <button
            className="drawer-credit-link"
            type="button"
            onClick={() => {
              onClose();
              setActiveHeaderPanel(isGuestViewer ? "login" : "recharge");
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
            <span>算力积分</span>
            {!isGuestViewer && walletCredits !== null && <span className="drawer-credit-value">{String(walletCredits)}分</span>}
          </button>
          <button
            className="drawer-credit-link"
            type="button"
            onClick={() => {
              onClose();
              setActiveHeaderPanel(isGuestViewer ? "login" : "orders");
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 3.5h8l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 2-1.5Z" />
              <path d="M14.5 3.5V8H19M8 12h8M8 16h8" />
            </svg>
            <span>订单记录</span>
          </button>
          <button
            className="drawer-credit-link"
            type="button"
            onClick={() => {
              onClose();
              setActiveHeaderPanel(isGuestViewer ? "login" : "ledger");
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 5.5h16M4 12h16M4 18.5h16" />
              <circle cx="7" cy="5.5" r="1" />
              <circle cx="7" cy="12" r="1" />
              <circle cx="7" cy="18.5" r="1" />
            </svg>
            <span>积分明细</span>
          </button>
          <button
            className="drawer-credit-link drawer-works-link"
            type="button"
            onClick={() => {
              onClose();
              setActiveHeaderPanel("works");
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3.5" y="5" width="17" height="14" rx="2" />
              <path d="M8 5v4m4-4v4m4-4v4M8 15h8" />
            </svg>
            <span>我的作品</span>
          </button>
          <button
            className="drawer-credit-link"
            type="button"
            onClick={() => {
              onClose();
              setActiveHeaderPanel("inbox");
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="m4 7 8 6 8-6" />
            </svg>
            <span>站内信</span>
          </button>
          <button
            className="drawer-credit-link"
            type="button"
            onClick={() => {
              onClose();
              setActiveHeaderPanel("install");
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
              <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
            <span>安装 App</span>
          </button>
        </nav>
        <section className="drawer-recent-works" aria-label="最近作品">
          <div className="drawer-recent-works-heading">
            <span>最近作品</span>
            {authUser && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  setActiveHeaderPanel("works");
                }}
              >
                查看全部
              </button>
            )}
          </div>
          {!authUser ? (
            <button
              className="drawer-recent-works-empty drawer-recent-works-login"
              type="button"
              onClick={() => {
                onClose();
                setActiveHeaderPanel("login");
              }}
            >
              登录后查看最近作品
            </button>
          ) : recentWorksLoading ? (
            <p className="drawer-recent-works-empty">正在加载…</p>
          ) : recentWorks.length > 0 ? (
            <>
              <div className="drawer-recent-works-list">
                {(recentWorksExpanded ? recentWorks : recentWorks.slice(0, 3)).map((work) => {
                  const ageMinutes = Math.max(0, Math.floor((Date.now() - Date.parse(work.createdAt)) / 60000));
                  const remainingHours = Math.max(0, 24 - Math.floor(ageMinutes / 60));
                  const isExpiringSoon = remainingHours <= 4;
                  const ageLabel = isExpiringSoon
                    ? remainingHours <= 1
                      ? "即将过期 (不足1小时)"
                      : `即将过期 (剩 ${remainingHours} 小时)`
                    : ageMinutes < 1
                    ? "刚刚完成"
                    : ageMinutes < 60
                    ? ageMinutes + " 分钟前"
                    : Math.floor(ageMinutes / 60) + " 小时前";
                  return (
                    <button
                      className="drawer-recent-work"
                      type="button"
                      key={work.id}
                      onClick={() => {
                        onClose();
                        setActiveHeaderPanel("works");
                      }}
                    >
                      <span className="drawer-recent-work-thumb">
                        {work.coverUrl ? (
                          <img
                            src={work.coverUrl}
                            alt="作品封面"
                            loading="lazy"
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                          />
                        ) : (
                          <video src={"/api/v1/works/" + work.id + "/stream"} muted playsInline preload="none" />
                        )}
                        <span className="drawer-recent-work-play" aria-hidden="true">
                          ▶
                        </span>
                      </span>
                      <span className="drawer-recent-work-copy">
                        <strong>
                          {recentWorks.filter((item) => item.jobId === work.jobId).length > 1
                            ? "视频切片"
                            : "短视频成片"}
                        </strong>
                        <small>{ageLabel}</small>
                      </span>
                      <span className="drawer-recent-work-chevron" aria-hidden="true">
                        ›
                      </span>
                    </button>
                  );
                })}
              </div>
              {recentWorks.length > 3 && (
                <button
                  type="button"
                  className="drawer-recent-works-toggle"
                  onClick={() => setRecentWorksExpanded((prev) => !prev)}
                  aria-expanded={recentWorksExpanded}
                >
                  <span>{recentWorksExpanded ? "收起" : `展开更多 (${recentWorks.length - 3})`}</span>
                  <svg
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    style={{
                      width: 12,
                      height: 12,
                      transform: recentWorksExpanded ? "rotate(180deg)" : "rotate(0deg)",
                      transition: "transform .2s ease",
                    }}
                  >
                    <path
                      d="M6 9l6 6 6-6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
            </>
          ) : (
            <p className="drawer-recent-works-empty">完成一次创作，你的作品就会出现在这里</p>
          )}
          <p className="drawer-recent-works-note">成片仅保留 24 小时</p>
        </section>
      </aside>
    </div>
  );
}
