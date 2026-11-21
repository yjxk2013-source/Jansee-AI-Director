import type { AuthUser } from "../../types/client";

interface ChatHeaderProps {
  isSidebarOpen: boolean;
  setIsSidebarOpen: (open: boolean) => void;
  authUser: AuthUser | null;
  setActiveHeaderPanel: (panel: "works" | "login" | "recharge" | "orders" | "ledger" | "inbox" | "install" | "admin" | "admin-login" | null) => void;
}

export function ChatHeader({
  isSidebarOpen,
  setIsSidebarOpen,
  authUser,
  setActiveHeaderPanel,
}: ChatHeaderProps) {
  return (
    <header className="app-header">
      <div className="header-brand-group">
        <button
          className="menu-button"
          type="button"
          aria-label="打开导航菜单"
          aria-expanded={isSidebarOpen}
          onClick={() => setIsSidebarOpen(true)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <a className="brand" href="/" aria-label="JANSEE 首页">
          <img className="brand-symbol" src="/assets/jansee-mark.svg" alt="" />
          <img className="brand-wordmark brand-wordmark-pirulen" src="/assets/jansee-pirulen-wordmark.png" alt="JANSEE" />
        </a>
      </div>
      <div className="header-actions">
        <button
          className="login-button account-icon-button"
          type="button"
          onClick={() => setActiveHeaderPanel("login")}
          aria-label={authUser ? "我的账号" : "登录"}
          title={authUser ? "我的账号" : "登录"}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="8" r="3.5" />
            <path d="M5 20c.8-3.5 3.1-5.3 7-5.3s6.2 1.8 7 5.3" />
          </svg>
        </button>
      </div>
    </header>
  );
}
