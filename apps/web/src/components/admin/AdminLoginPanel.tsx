import { useEffect, useState, type FormEvent } from "react";
import type { AuthUser } from "../../types/client";
import { useTimedNotice } from "../../utils/clientPlatform";

export function AdminLoginPanel({ onSuccess }: { onSuccess: (user: AuthUser) => void }) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mode, setMode] = useState<"password" | "sms">("password");
  const [resetting, setResetting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useTimedNotice();
  const [notice, setNotice] = useTimedNotice();

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  function cleanPhone() {
    return phone.replace(/\D/g, "");
  }

  async function sendCode() {
    const mobile = cleanPhone();
    if (!/^1\d{10}$/.test(mobile)) {
      setError("请输入有效的管理员手机号");
      return;
    }
    setSending(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/v1/auth/sms/send", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: mobile }),
      });
      const payload = (await response.json()) as { message?: string; error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message || "验证码发送失败");
      setCountdown(60);
      setNotice(payload.message || "验证码发送请求已受理，请查看手机短信");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "验证码发送失败，请检查短信服务配置");
    } finally {
      setSending(false);
    }
  }

  async function verifyAdmin(user: AuthUser) {
    const response = await fetch("/api/v1/admin/overview", { credentials: "include", cache: "no-store" });
    if (response.status === 401 || response.status === 403) throw new Error("该手机号对应的账号没有管理员权限");
    if (!response.ok) throw new Error("管理员权限验证失败（HTTP " + response.status + "）");
    return user;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const mobile = cleanPhone();
    if (!/^1\d{10}$/.test(mobile)) {
      setError("请输入有效的管理员手机号");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (mode === "password") {
        if (!password) throw new Error("请输入管理员密码");
        const response = await fetch("/api/v1/auth/login", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ phone: mobile, password }),
        });
        const payload = (await response.json()) as { user?: AuthUser; error?: { message?: string } };
        if (!response.ok || !payload.user) throw new Error(payload.error?.message || "手机号或密码不正确");
        onSuccess(await verifyAdmin(payload.user));
        return;
      }

      if (!/^\d{4,8}$/.test(code.trim())) throw new Error("请输入短信验证码");
      const response = await fetch("/api/v1/auth/sms/login", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: mobile, code: code.trim() }),
      });
      const payload = (await response.json()) as { user?: AuthUser; error?: { message?: string } };
      if (!response.ok || !payload.user) throw new Error(payload.error?.message || "验证码不正确或已失效");
      const adminUser = await verifyAdmin(payload.user);
      if (resetting) {
        if (newPassword.length < 8) throw new Error("新密码至少需要 8 位");
        if (newPassword !== confirmPassword) throw new Error("两次输入的新密码不一致");
        const resetResponse = await fetch("/api/v1/auth/password", {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: newPassword }),
        });
        const resetPayload = (await resetResponse.json()) as { error?: { message?: string } };
        if (!resetResponse.ok) throw new Error(resetPayload.error?.message || "密码重置失败");
        setNotice("密码重置成功，正在进入管理后台…");
      }
      onSuccess(adminUser);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败，请检查本地 API 和短信服务");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="admin-login-screen">
      <section className="admin-login-card" aria-labelledby="admin-login-title">
        <div className="admin-login-mark">
          JANSEE <span>ADMIN</span>
        </div>
        <h1 id="admin-login-title">管理后台</h1>
        <p>管理员专用登录</p>
        <div className="admin-login-modes">
          <button
            type="button"
            className={mode === "password" ? "active" : ""}
            onClick={() => {
              setMode("password");
              setResetting(false);
              setError("");
              setNotice("");
            }}
          >
            密码登录
          </button>
          <button
            type="button"
            className={mode === "sms" ? "active" : ""}
            onClick={() => {
              setMode("sms");
              setError("");
              setNotice("");
            }}
          >
            短信验证码
          </button>
        </div>
        <form onSubmit={submit} className="admin-login-form">
          <label>
            <span>管理员手机号</span>
            <input
              type="tel"
              inputMode="numeric"
              autoComplete="username"
              maxLength={11}
              value={phone}
              onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 11))}
              placeholder="请输入管理员手机号"
              required
            />
          </label>
          {mode === "password" ? (
            <label>
              <span>登录密码</span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="请输入管理员密码"
                required
              />
            </label>
          ) : (
            <>
              <label>
                <span>短信验证码</span>
                <div className="admin-login-code-row">
                  <input
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="请输入验证码"
                    required
                  />
                  <button type="button" disabled={sending || countdown > 0} onClick={sendCode}>
                    {countdown > 0 ? countdown + " 秒后重发" : sending ? "发送中…" : "获取验证码"}
                  </button>
                </div>
              </label>
              {resetting && (
                <>
                  <label>
                    <span>设置新密码</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      minLength={8}
                      maxLength={128}
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      placeholder="至少 8 位新密码"
                      required
                    />
                  </label>
                  <label>
                    <span>确认新密码</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      minLength={8}
                      maxLength={128}
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      placeholder="再次输入新密码"
                      required
                    />
                  </label>
                </>
              )}
            </>
          )}
          {error && <div className="admin-login-error" role="alert">{error}</div>}
          {notice && <div className="admin-login-notice" role="status">{notice}</div>}
          <button type="submit" disabled={busy}>
            {busy ? "正在验证…" : resetting ? "验证并重置密码" : mode === "sms" ? "验证码登录管理后台" : "登录管理后台"}
          </button>
        </form>
        {mode === "password" ? (
          <button
            type="button"
            className="admin-login-link"
            onClick={() => {
              setMode("sms");
              setResetting(true);
              setCode("");
              setError("");
              setNotice("请使用管理员手机号接收短信验证码，验证通过后设置新密码。");
            }}
          >
            忘记密码？使用短信验证码重置
          </button>
        ) : (
          <button
            type="button"
            className="admin-login-link"
            onClick={() => {
              setMode("password");
              setResetting(false);
              setError("");
              setNotice("");
              setCode("");
            }}
          >
            返回密码登录
          </button>
        )}
        <a href="/">返回简兮首页</a>
      </section>
    </main>
  );
}

