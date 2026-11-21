import { useState } from "react";
import type { AuthUser } from "../../types/client.js";
import { useTimedNotice } from "../../utils/clientPlatform.js";
import { UserGrowthSection } from "./UserGrowthSection.js";
import { AuthForms } from "./AuthForms.js";

interface AuthPanelProps {
  user: AuthUser | null;
  onSuccess: (user: AuthUser) => void;
  onProfileUpdated: (user: AuthUser) => void;
  onLogout: () => void;
  onWalletRefresh: () => Promise<void>;
}

export function AuthPanel({ user, onSuccess, onProfileUpdated, onLogout, onWalletRefresh }: AuthPanelProps) {
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [displayNameSaving, setDisplayNameSaving] = useState(false);
  const [displayNameError, setDisplayNameError] = useTimedNotice();
  const [notice, setNotice] = useTimedNotice();
  const [error, setError] = useTimedNotice();

  const isMockPreview = import.meta.env.DEV && user?.id === "local-preview-user";

  function beginDisplayNameEdit() {
    setDisplayNameDraft(user?.displayName || "");
    setDisplayNameError("");
    setEditingDisplayName(true);
  }

  async function saveDisplayName() {
    const displayName = displayNameDraft.trim();
    if (!displayName || displayName.length > 24 || displayNameSaving || !user) {
      setDisplayNameError("昵称需为 1–24 个字符");
      return;
    }
    setDisplayNameSaving(true);
    setDisplayNameError("");
    try {
      if (isMockPreview) {
        onProfileUpdated({ ...user, displayName });
      } else {
        const response = await fetch("/api/v1/auth/profile", {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName }),
        });
        const payload = await response.json() as { user?: AuthUser; error?: { message?: string } };
        if (!response.ok || !payload.user) throw new Error(payload.error?.message || "昵称保存失败，请稍后重试");
        onProfileUpdated(payload.user);
      }
      setEditingDisplayName(false);
    } catch (cause) {
      setDisplayNameError(cause instanceof Error ? cause.message : "昵称保存失败，请稍后重试");
    } finally {
      setDisplayNameSaving(false);
    }
  }

  async function logout() {
    try {
      const response = await fetch("/api/v1/auth/logout", { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error("logout failed");
      onLogout();
    } catch {
      setError("退出登录失败，请检查网络后重试。");
    }
  }

  if (user && !user.isGuest) {
    return (
      <>
        <div className="panel-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg></div>
        <h2 id="header-panel-title">账户信息</h2>
        <p className="header-panel-copy">管理你的简兮账户与创作权益。</p>
        <div className="login-notice">
          <div className="profile-name-row">
            {editingDisplayName ? (
              <div className="profile-name-editor">
                <input value={displayNameDraft} maxLength={24} onChange={(event) => setDisplayNameDraft(event.target.value)} aria-label="修改昵称" />
                <button type="button" className="profile-name-save" disabled={displayNameSaving} onClick={() => void saveDisplayName()}>{displayNameSaving ? "保存中…" : "保存"}</button>
              </div>
            ) : (
              <>
                <strong>{user.displayName || (user.phone ? "用户_" + user.phone.slice(-4) : "创作者")}</strong>
                <button type="button" className="profile-name-edit" aria-label="修改昵称" title="修改昵称" onClick={beginDisplayNameEdit}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>
                </button>
              </>
            )}
          </div>
          <span>{user.phone ? user.phone.slice(0, 3) + "****" + user.phone.slice(-4) : (user.email || "")}</span>
          {displayNameError && <small className="auth-error" role="alert">{displayNameError}</small>}
        </div>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <UserGrowthSection user={user} onWalletRefresh={onWalletRefresh} />
        <button className="panel-primary-action" type="button" onClick={() => void logout()}>退出登录</button>
      </>
    );
  }

  return (
    <AuthForms
      onSuccess={onSuccess}
      setError={setError}
      setNotice={setNotice}
      notice={notice}
      error={error}
    />
  );
}
