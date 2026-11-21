import { useState, useEffect, type FormEvent } from "react";
import type { AuthUser } from "../../types/client.js";

interface AuthFormsProps {
  onSuccess: (user: AuthUser) => void;
  setError: (msg: string) => void;
  setNotice: (msg: string) => void;
  notice: string;
  error: string;
}

export function AuthForms({ onSuccess, setError, setNotice, notice, error }: AuthFormsProps) {
  const [phone, setPhone] = useState("");
  const [authMode, setAuthMode] = useState<"password" | "sms" | "register" | "password-setup">("password");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [setupUser, setSetupUser] = useState<AuthUser | null>(null);
  const [forcePasswordReset, setForcePasswordReset] = useState(false);
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  async function handleSendSms() {
    const cleanPhone = phone.replace(/\D/g, "");
    if (!/^1\d{10}$/.test(cleanPhone)) {
      setError("请输入 11 位有效的大陆手机号");
      return;
    }
    setError("");
    setNotice("");
    setSending(true);
    try {
      const res = await fetch("/api/v1/auth/sms/send", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: cleanPhone }),
      });
      const data = await res.json() as { ok?: boolean; error?: { message?: string } };
      if (!res.ok || !data.ok) throw new Error(data.error?.message || "短信发送失败");
      setCountdown(60);
      setNotice("验证码已发送至您的手机，请查收");
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送失败，请稍后重试");
    } finally {
      setSending(false);
    }
  }

  async function submitPasswordLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const cleanPhone = phone.replace(/\D/g, "");
    if (!/^1\d{10}$/.test(cleanPhone)) { setError("请输入 11 位有效手机号"); return; }
    if (password.length < 1) { setError("请输入登录密码"); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: cleanPhone, password }),
      });
      const payload = await response.json() as { user?: AuthUser; error?: { message?: string } };
      if (!response.ok || !payload.user) throw new Error(payload.error?.message || "手机号或密码不正确");
      onSuccess(payload.user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "网络不可用，请稍后重试");
    } finally { setBusy(false); }
  }

  async function submitSmsLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const cleanPhone = phone.replace(/\D/g, "");
    const cleanCode = code.replace(/\D/g, "");
    if (!/^1\d{10}$/.test(cleanPhone)) { setError("请输入 11 位有效手机号"); return; }
    if (!/^\d{4,8}$/.test(cleanCode)) { setError("请输入有效短信验证码"); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/v1/auth/sms/login", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: cleanPhone, code: cleanCode }),
      });
      const payload = await response.json() as { user?: AuthUser; hasPassword?: boolean; error?: { message?: string } };
      if (!response.ok || !payload.user) throw new Error(payload.error?.message || "验证码错误或已失效");
      if (forcePasswordReset || !payload.hasPassword) {
        setSetupUser(payload.user);
        setAuthMode("password-setup");
        setNewPassword(""); setConfirmPassword("");
        setNotice(payload.hasPassword ? "短信验证成功，请设置新密码。" : "短信验证成功，请设置登录密码。");
      } else {
        onSuccess(payload.user);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "网络不可用，请稍后重试");
    } finally { setBusy(false); }
  }

  async function submitSmsRegistration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const cleanPhone = phone.replace(/\D/g, "");
    const cleanCode = code.replace(/\D/g, "");
    if (!/^1\d{10}$/.test(cleanPhone)) { setError("请输入 11 位有效手机号"); return; }
    if (!/^\d{4,8}$/.test(cleanCode)) { setError("请输入有效短信验证码"); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/v1/auth/sms/register", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: cleanPhone, code: cleanCode, inviteCode: new URLSearchParams(window.location.search).get("ref") || undefined }),
      });
      const payload = await response.json() as { user?: AuthUser; error?: { message?: string } };
      if (!response.ok || !payload.user) throw new Error(payload.error?.message || "注册失败，请稍后重试");
      setSetupUser(payload.user);
      setAuthMode("password-setup");
      setForcePasswordReset(false);
      setNewPassword(""); setConfirmPassword("");
      setNotice("手机号验证成功，最后设置一个登录密码即可完成注册。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "网络不可用，请稍后重试");
    } finally { setBusy(false); }
  }

  async function submitPasswordSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !setupUser) return;
    if (newPassword.length < 8) { setError("密码至少需要 8 位"); return; }
    if (newPassword !== confirmPassword) { setError("两次输入的密码不一致"); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/v1/auth/password", {
        method: "PUT", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      });
      const payload = await response.json() as { user?: AuthUser; error?: { message?: string } };
      if (!response.ok || !payload.user) throw new Error(payload.error?.message || "密码设置失败，请重试");
      setPassword(""); setNewPassword(""); setConfirmPassword("");
      setSetupUser(null); setForcePasswordReset(false);
      onSuccess(payload.user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "密码设置失败，请稍后重试");
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="panel-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg></div>
      <h2 id="header-panel-title">
        {authMode === "register" ? "创建简兮账户" : authMode === "password-setup" ? (forcePasswordReset ? "重置登录密码" : "设置登录密码") : authMode === "sms" ? "短信验证码登录" : "欢迎登录简兮"}
      </h2>
      <p className="header-panel-copy">
        {authMode === "register" ? "使用手机号验证注册，完成后设置密码。" : authMode === "password-setup" ? "设置密码后，下次即可使用手机号和密码登录。" : authMode === "sms" ? "使用注册手机号接收验证码，安全快捷地登录。" : "使用手机号和密码登录 JANSEE。"}
      </p>
      {notice && <p className="auth-notice" role="status">{notice}</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      {authMode !== "password-setup" && (
        <div className="auth-tabs" role="tablist" aria-label="注册与登录">
          <button type="button" role="tab" aria-selected={authMode === "register"} className={authMode === "register" ? "auth-tab active" : "auth-tab"} onClick={() => { setAuthMode("register"); setForcePasswordReset(false); setError(""); setNotice(""); setCode(""); setPassword(""); }}>注册</button>
          <button type="button" role="tab" aria-selected={authMode !== "register"} className={authMode !== "register" ? "auth-tab active" : "auth-tab"} onClick={() => { setAuthMode("password"); setForcePasswordReset(false); setError(""); setNotice(""); setCode(""); }}>登录</button>
        </div>
      )}
      {authMode === "password-setup" ? (
        <form className="auth-form" onSubmit={submitPasswordSetup}>
          <label><span>新密码</span><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={8} maxLength={128} autoComplete="new-password" required placeholder="至少 8 位密码" /></label>
          <label><span>确认密码</span><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} maxLength={128} autoComplete="new-password" required placeholder="再次输入密码" /></label>
          <button className="panel-primary-action" type="submit" disabled={busy}>{busy ? "保存中…" : "完成并进入简兮"}</button>
        </form>
      ) : (
        <form className="auth-form auth-entry-form" onSubmit={authMode === "password" ? submitPasswordLogin : authMode === "register" ? submitSmsRegistration : submitSmsLogin}>
          <label><span>手机号</span><input type="tel" value={phone} onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 11))} required maxLength={11} autoComplete="tel" placeholder="请输入 11 位大陆手机号" /></label>
          {authMode === "password" ? (
            <label><span>登录密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password" placeholder="请输入密码" /></label>
          ) : (
            <label><span>短信验证码</span><div className="auth-code-row">
              <input type="text" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))} required maxLength={8} inputMode="numeric" autoComplete="one-time-code" placeholder="请输入验证码" />
              <button type="button" className="auth-code-send" disabled={sending || countdown > 0 || phone.length !== 11} onClick={handleSendSms}>{countdown > 0 ? countdown + "s 后重发" : sending ? "发送中…" : "获取验证码"}</button>
            </div></label>
          )}
          <button className="panel-primary-action" type="submit" disabled={busy}>{busy ? "处理中…" : authMode === "password" ? "登录" : authMode === "register" ? "验证手机号并注册" : "验证码登录"}</button>
        </form>
      )}
      {authMode !== "password-setup" && (
        <div className="auth-footer-links">
          {authMode === "password" ? (
            <>
              <button type="button" className="auth-mode-link" onClick={() => { setAuthMode("sms"); setForcePasswordReset(false); setError(""); setNotice(""); setCode(""); }}>验证码登录</button>
              <button type="button" className="auth-mode-link" onClick={() => { setAuthMode("sms"); setForcePasswordReset(true); setError(""); setNotice("请先使用短信验证码，验证通过后即可重置密码。"); setCode(""); }}>忘记密码？</button>
            </>
          ) : authMode === "sms" ? (
            <button type="button" className="auth-mode-link" onClick={() => { setAuthMode("password"); setForcePasswordReset(false); setError(""); setNotice(""); setCode(""); setPassword(""); }}>返回密码登录</button>
          ) : (
            <button type="button" className="auth-mode-link" onClick={() => { setAuthMode("password"); setForcePasswordReset(false); setError(""); setNotice(""); setCode(""); setPassword(""); }}>返回登录</button>
          )}
        </div>
      )}
    </>
  );
}

