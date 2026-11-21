import { lazy, Suspense } from "react";
import type { AuthUser, SavedConversation } from "../../types/client";
import { AdminLoginPanel } from "../admin/AdminLoginPanel";
import { AuthPanel } from "../auth/AuthPanel";
import { WorksPanel } from "../works/WorksPanel";
import { RechargePanel } from "../billing/RechargePanel";
import { BillingHistoryPanel } from "../billing/BillingHistoryPanel";
import { SiteInboxPanel } from "./SiteInboxPanel";
import { InstallAppPanel } from "./InstallAppPanel";

const AdminConsole = lazy(() => import("../../AdminConsole").then((m) => ({ default: m.AdminConsole })));

interface HeaderModalContainerProps {
  activeHeaderPanel: string | null;
  setActiveHeaderPanel: (panel: any) => void;
  authUser: AuthUser | null;
  setAuthUser: (user: AuthUser | null) => void;
  conversations: SavedConversation[];
  startNewConversation: () => void;
  highlightWorkId: string | null;
  setHighlightWorkId: (id: string | null) => void;
  handleWorkDownload: (workId: string, filename: string) => void;
  walletCredits: number | null;
  membership: { tierId: string; expiresAt: string; active: boolean } | null;
  refreshWallet: () => Promise<void>;
  pendingDownloadWork: { id: string; filename: string } | null;
  setPendingDownloadWork: (work: { id: string; filename: string } | null) => void;
  triggerDownloadFile: (workId: string, filename: string) => void;
}

export function HeaderModalContainer({
  activeHeaderPanel,
  setActiveHeaderPanel,
  authUser,
  setAuthUser,
  conversations,
  startNewConversation,
  highlightWorkId,
  setHighlightWorkId,
  handleWorkDownload,
  walletCredits,
  membership,
  refreshWallet,
  pendingDownloadWork,
  setPendingDownloadWork,
  triggerDownloadFile,
}: HeaderModalContainerProps) {
  if (!activeHeaderPanel) return null;

  if (activeHeaderPanel === "admin-login") {
    return (
      <AdminLoginPanel
        onSuccess={(user) => {
          setAuthUser(user);
          setActiveHeaderPanel("admin");
        }}
      />
    );
  }

  if (activeHeaderPanel === "admin") {
    return (
      <Suspense
        fallback={
          <div className="header-panel-layer">
            <div
              className="header-panel"
              style={{ padding: "40px", textAlign: "center", color: "var(--jansee-text-muted, #80868b)" }}
            >
              正在载入管理控制台...
            </div>
          </div>
        }
      >
        <AdminConsole onClose={() => setActiveHeaderPanel(null)} />
      </Suspense>
    );
  }

  return (
    <div className="header-panel-layer">
      <button
        className="header-panel-backdrop"
        type="button"
        aria-label="关闭窗口"
        onClick={() => setActiveHeaderPanel(null)}
      />
      <section className="header-panel" role="dialog" aria-modal="true" aria-labelledby="header-panel-title">
        <button className="header-panel-close" type="button" aria-label="关闭" onClick={() => setActiveHeaderPanel(null)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
        {activeHeaderPanel === "works" ? (
          <WorksPanel
            user={authUser}
            onNew={() => {
              setActiveHeaderPanel(null);
              startNewConversation();
            }}
            conversations={conversations}
            highlightWorkId={highlightWorkId}
            onClearHighlight={() => setHighlightWorkId(null)}
            onRequestDownload={handleWorkDownload}
          />
        ) : activeHeaderPanel === "recharge" ? (
          <RechargePanel
            user={authUser}
            credits={walletCredits}
            membership={membership}
            onPaid={refreshWallet}
          />
        ) : activeHeaderPanel === "orders" ? (
          <BillingHistoryPanel key={authUser?.id ?? "guest"} user={authUser} kind="orders" />
        ) : activeHeaderPanel === "ledger" ? (
          <BillingHistoryPanel key={authUser?.id ?? "guest"} user={authUser} kind="ledger" />
        ) : activeHeaderPanel === "inbox" ? (
          <SiteInboxPanel user={authUser} onLogin={() => setActiveHeaderPanel("login")} />
        ) : activeHeaderPanel === "install" ? (
          <InstallAppPanel />
        ) : (
          <AuthPanel
            user={authUser}
            onSuccess={(user) => {
              setAuthUser(user);
              void refreshWallet();
              setActiveHeaderPanel(null);
              if (pendingDownloadWork) {
                triggerDownloadFile(pendingDownloadWork.id, pendingDownloadWork.filename);
                setPendingDownloadWork(null);
              }
            }}
            onProfileUpdated={(user) => setAuthUser(user)}
            onLogout={() => {
              setAuthUser(null);
              setActiveHeaderPanel(null);
            }}
            onWalletRefresh={refreshWallet}
          />
        )}
      </section>
    </div>
  );
}

