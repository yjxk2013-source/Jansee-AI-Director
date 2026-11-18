import { readFile, writeFile } from "node:fs/promises";
const p = "F:/Jansee-v4/apps/web/src/App.tsx";
let s = await readFile(p, "utf8");
const stateAnchor = '  const [phone, setPhone] = useState("");';
if (!s.includes(stateAnchor)) throw new Error("Auth state anchor missing");
s = s.replace(stateAnchor, stateAnchor + `
  const [authMode, setAuthMode] = useState<"password" | "sms" | "register" | "password-setup">("password");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [setupUser, setSetupUser] = useState<AuthUser | null>(null);
  const [forcePasswordReset, setForcePasswordReset] = useState(false);`);
const submitStart = s.indexOf('  async function submit(event: FormEvent<HTMLFormElement>) {');
const logoutStart = s.indexOf('  async function logout() {', submitStart);
if (submitStart < 0 || logoutStart < 0) throw new Error("Auth submit function anchors missing");
const handlers = `  async function submitPasswordLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const cleanPhone = phone.replace(/\\D/g, "");
    if (!/^1\\d{10}$/.test(cleanPhone)) { setError("请输入 11 位有效手机号"); return; }
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
    const cleanPhone = phone.replace(/\\D/g, "");
    const cleanCode = code.replace(/\\D/g, "");
    if (!/^1\\d{10}$/.test(cleanPhone)) { setError("请输入 11 位有效手机号"); return; }
    if (!/^\\d{4,8}$/.test(cleanCode)) { setError("请输入有效短信验证码"); return; }
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
    const cleanPhone = phone.replace(/\\D/g, "");
    const cleanCode = code.replace(/\\D/g, "");
    if (!/^1\\d{10}$/.test(cleanPhone)) { setError("请输入 11 位有效手机号"); return; }
    if (!/^\\d{4,8}$/.test(cleanCode)) { setError("请输入有效短信验证码"); return; }
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

`;
s = s.slice(0, submitStart) + handlers + s.slice(logoutStart);
const uiStart = s.indexOf('  return <>\n    <div className="panel-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg></div>\n    <h2 id="header-panel-title">手机快捷登录</h2>');
const uiEnd = s.indexOf('\n}\n\ntype WorkItem', uiStart);
if (uiStart < 0 || uiEnd < 0) throw new Error("Auth panel UI anchors missing");
const ui = `  return <>
    <div className="panel-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg></div>
    <h2 id="header-panel-title">{authMode === "register" ? "创建简兮账户" : authMode === "password-setup" ? (forcePasswordReset ? "重置登录密码" : "设置登录密码") : authMode === "sms" ? "短信验证码登录" : "欢迎登录简兮"}</h2>
    <p className="header-panel-copy">{authMode === "register" ? "使用手机号验证注册，完成后设置密码。" : authMode === "password-setup" ? "设置密码后，下次即可使用手机号和密码登录。" : authMode === "sms" ? "使用注册手机号接收验证码，安全快捷地登录。" : "使用手机号和密码登录 JANSEE。"}</p>

    {notice && <p style={{ color: "#4ade80", fontSize: "14px", margin: "6px 0" }} role="status">{notice}</p>}
    {error && <p className="auth-error" role="alert">{error}</p>}

    {authMode === "password-setup" ? (
      <form className="auth-form" onSubmit={submitPasswordSetup} style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "12px" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <span>新密码</span>
          <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={8} maxLength={128} autoComplete="new-password" required placeholder="至少 8 位密码" />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <span>确认密码</span>
          <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} maxLength={128} autoComplete="new-password" required placeholder="再次输入密码" />
        </label>
        <button className="panel-primary-action" type="submit" disabled={busy}>{busy ? "保存中…" : "完成并进入简兮"}</button>
      </form>
    ) : (
      <>
        {(authMode === "password" || authMode === "sms" || authMode === "register") && (
          <label style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "12px" }}>
            <span>手机号</span>
            <input type="tel" value={phone} onChange={(event) => setPhone(event.target.value.replace(/\\D/g, "").slice(0, 11))} required maxLength={11} autoComplete="tel" placeholder="请输入 11 位大陆手机号" style={{ width: "100%", padding: "10px 12px", borderRadius: "6px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff" }} />
          </label>
        )}
        {authMode === "password" && (
          <form className="auth-form" onSubmit={submitPasswordLogin} style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "12px" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span>登录密码</span>
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password" placeholder="请输入密码" />
            </label>
            <button className="panel-primary-action" type="submit" disabled={busy}>{busy ? "登录中…" : "登录"}</button>
          </form>
        )}
        {(authMode === "sms" || authMode === "register") && (
          <form className="auth-form" onSubmit={authMode === "register" ? submitSmsRegistration : submitSmsLogin} style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "12px" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span>短信验证码</span>
              <div style={{ display: "flex", gap: "8px" }}>
                <input type="text" value={code} onChange={(event) => setCode(event.target.value.replace(/\\D/g, "").slice(0, 8))} required maxLength={8} inputMode="numeric" autoComplete="one-time-code" placeholder="请输入验证码" style={{ flex: 1, minWidth: 0, padding: "10px 12px", borderRadius: "6px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff" }} />
                <button type="button" className="panel-primary-action" style={{ width: "auto", padding: "10px 16px", margin: 0, fontSize: "13px", whiteSpace: "nowrap" }} disabled={sending || countdown > 0 || !phone.trim()} onClick={handleSendSms}>
                  {countdown > 0 ? countdown + "s 后重发" : sending ? "发送中…" : "获取验证码"}
                </button>
              </div>
            </label>
            <button className="panel-primary-action" type="submit" disabled={busy}>{busy ? "处理中…" : authMode === "register" ? "验证手机号并注册" : "验证码登录"}</button>
          </form>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: "10px", marginTop: "14px", fontSize: "13px" }}>
          {authMode === "password" ? (
            <>
              <button type="button" className="auth-mode-link" onClick={() => { setAuthMode("sms"); setForcePasswordReset(false); setError(""); setNotice(""); }}>验证码登录</button>
              <button type="button" className="auth-mode-link" onClick={() => { setAuthMode("register"); setForcePasswordReset(false); setError(""); setNotice(""); setCode(""); }}>手机号注册</button>
              <button type="button" className="auth-mode-link" onClick={() => { setAuthMode("sms"); setForcePasswordReset(true); setError(""); setNotice("请先使用短信验证码登录，验证通过后即可重置密码。"); setCode(""); }}>忘记密码？</button>
            </>
          ) : (
            <button type="button" className="auth-mode-link" onClick={() => { setAuthMode("password"); setForcePasswordReset(false); setError(""); setNotice(""); setCode(""); setPassword(""); }}>
              返回密码登录
            </button>
          )}
        </div>
      </>
    )}
  </>`;
s = s.slice(0, uiStart) + ui + s.slice(uiEnd);
await writeFile(p, s, "utf8");
console.log("Patched V4 authentication UI");
