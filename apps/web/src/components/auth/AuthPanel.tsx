import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import type { AuthUser, SavedConversation, WorkItem } from "../../types/client";
import { useTimedNotice, withdrawalStatusLabel } from "../../utils/clientPlatform";

export function AuthPanel({ user, onSuccess, onProfileUpdated, onLogout, onWalletRefresh }: { user: AuthUser | null; onSuccess: (user: AuthUser) => void; onProfileUpdated: (user: AuthUser) => void; onLogout: () => void; onWalletRefresh: () => Promise<void> }) {
  const [phone, setPhone] = useState("");
  const [authMode, setAuthMode] = useState<"password" | "sms" | "register" | "password-setup">("password");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [setupUser, setSetupUser] = useState<AuthUser | null>(null);
  const [forcePasswordReset, setForcePasswordReset] = useState(false);
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [displayNameSaving, setDisplayNameSaving] = useState(false);
  const [displayNameError, setDisplayNameError] = useTimedNotice();
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useTimedNotice();
  const [error, setError] = useTimedNotice();
  const [busy, setBusy] = useState(false);
  const [inviteQrDataUrl, setInviteQrDataUrl] = useState("");
  const [growth, setGrowth] = useState<{
    inviteCode: string;
    invitedCount: number;
    rewardedCount: number;
    checkedInToday: boolean;
    checkinRewardCredits: number;
    referralRewardCredits: number;
    partner: { active: boolean; province?: string | null; city?: string | null; target: number; progress: number; pendingYuan: number; settledYuan: number; inTransitYuan: number; withdrawnYuan: number; withdrawableYuan: number; totalYuan: number; levelOneRate: number; levelTwoRate: number };
  } | null>(null);
  const [expandedGrowthSection, setExpandedGrowthSection] = useState<"checkin" | "invite" | "partner" | null>(null);
  const [growthBusy, setGrowthBusy] = useState(false);
  const [payoutProfile, setPayoutProfile] = useState<{ channel: string; accountLast4: string; verificationStatus: string; verificationNote?: string | null } | null>(null);
  const [payoutName, setPayoutName] = useState("");
  const [payoutAccount, setPayoutAccount] = useState("");
  const [payoutEditing, setPayoutEditing] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawals, setWithdrawals] = useState<Array<{ id: string; amountYuan: number; feeYuan: number; netAmountYuan: number; status: string; note?: string | null; createdAt: string; processedAt?: string | null; arrivalType?: string }>>([]);
  const [growthInvitees, setGrowthInvitees] = useState<Array<{ level: number; displayName: string; contact: string; joinedAt: string; hasPaid: boolean }>>([]);
  const [growthCommissions, setGrowthCommissions] = useState<Array<{ id: string; level: number; orderAmountYuan: number; rate: number; commissionYuan: number; status: string; createdAt: string; settledAt: string | null; source: string }>>([]);
  const [growthNotice, setGrowthNotice] = useTimedNotice();
  const [partnerProvince, setPartnerProvince] = useState("");
  const [partnerCity, setPartnerCity] = useState("");
  const isMockPreview = import.meta.env.DEV && user?.id === "local-preview-user";

  useEffect(() => {
    if (!growth?.inviteCode) { setInviteQrDataUrl(""); return; }
    let active = true;
    const inviteUrl = `https://jansee.cn/?ref=${encodeURIComponent(growth.inviteCode)}`;
    QRCode.toDataURL(inviteUrl, { width: 480, margin: 2, errorCorrectionLevel: "H" })
      .then((dataUrl: string) => { if (active) setInviteQrDataUrl(dataUrl); })
      .catch(() => { if (active) setInviteQrDataUrl(""); });
    return () => { active = false; };
  }, [growth?.inviteCode]);

  function beginDisplayNameEdit() {
    setDisplayNameDraft(user?.displayName || "");
    setDisplayNameError("");
    setEditingDisplayName(true);
  }

  async function saveDisplayName() {
    const displayName = displayNameDraft.trim();
    if (!displayName || displayName.length > 24 || displayNameSaving || !user) {
      setDisplayNameError("\u6635\u79f0\u9700\u4e3a 1\u201324 \u4e2a\u5b57\u7b26");
      return;
    }
    setDisplayNameSaving(true);
    setDisplayNameError("");
    try {
      if (isMockPreview) {
        onProfileUpdated({ ...user, displayName });
      } else {
        const response = await fetch("/api/v1/auth/profile", {
          method: "PUT", credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName }),
        });
        const payload = await response.json() as { user?: AuthUser; error?: { message?: string } };
        if (!response.ok || !payload.user) throw new Error(payload.error?.message || "\u6635\u79f0\u4fdd\u5b58\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5");
        onProfileUpdated(payload.user);
      }
      setEditingDisplayName(false);
    } catch (cause) {
      setDisplayNameError(cause instanceof Error ? cause.message : "\u6635\u79f0\u4fdd\u5b58\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5");
    } finally {
      setDisplayNameSaving(false);
    }
  }

  async function loadGrowth() {
    try {
      const [overviewResponse, inviteesResponse, commissionsResponse, profileResponse, withdrawalsResponse] = await Promise.all([
        fetch("/api/v1/growth/overview?timeZone=Asia%2FShanghai", { credentials: "include", cache: "no-store" }),
        fetch("/api/v1/growth/invitees", { credentials: "include" }),
        fetch("/api/v1/growth/commissions", { credentials: "include" }),
        fetch("/api/v1/growth/payout-profile", { credentials: "include", cache: "no-store" }),
        fetch("/api/v1/growth/withdrawals", { credentials: "include" }),
      ]);
      const [overviewPayload, inviteesPayload, commissionsPayload, profilePayload, withdrawalsPayload] = await Promise.all([
        overviewResponse.json() as Promise<{ overview?: typeof growth }>,
        inviteesResponse.json() as Promise<{ invitees?: typeof growthInvitees }>,
        commissionsResponse.json() as Promise<{ commissions?: typeof growthCommissions }>,
        profileResponse.json() as Promise<{ profile?: typeof payoutProfile }>,
        withdrawalsResponse.json() as Promise<{ withdrawals?: typeof withdrawals }>,
      ]);
      if (overviewResponse.ok && overviewPayload.overview) {
        setGrowth(overviewPayload.overview);
        setPartnerProvince(overviewPayload.overview.partner.province ?? "");
        setPartnerCity(overviewPayload.overview.partner.city ?? "");
      }
      if (inviteesResponse.ok && inviteesPayload.invitees) setGrowthInvitees(inviteesPayload.invitees);
      if (commissionsResponse.ok && commissionsPayload.commissions) setGrowthCommissions(commissionsPayload.commissions);
      if (profileResponse.ok) {
        setPayoutProfile(profilePayload.profile ?? null);
      }
      if (withdrawalsResponse.ok && withdrawalsPayload.withdrawals) setWithdrawals(withdrawalsPayload.withdrawals);
    } catch {
      setGrowthNotice("暂时无法加载签到与推广信息，请检查网络后重试。");
    }
  }

  useEffect(() => {
    if (import.meta.env.DEV && user?.id === "local-preview-user") {
      const mockPartnerMode = new URLSearchParams(window.location.search).get("mockPartner");
      const showMockPartner = mockPartnerMode === "1";
      const showEligiblePartner = mockPartnerMode === "eligible";
      setGrowth({
        inviteCode: "JANSEEV4PRE",
        invitedCount: showMockPartner ? 8 : showEligiblePartner ? 5 : 3,
        rewardedCount: showMockPartner ? 6 : showEligiblePartner ? 5 : 3,
        checkedInToday: false,
        checkinRewardCredits: 100,
        referralRewardCredits: 200,
        partner: showMockPartner ? { active: true, province: "\u6d59\u6c5f\u7701", city: "\u676d\u5dde\u5e02", target: 5, progress: 8, pendingYuan: 386.50, settledYuan: 1260, inTransitYuan: 120, withdrawnYuan: 680, withdrawableYuan: 460, totalYuan: 2106.50, levelOneRate: 0.15, levelTwoRate: 0.05 } : { active: false, target: 5, progress: showEligiblePartner ? 5 : 3, pendingYuan: 0, settledYuan: 0, inTransitYuan: 0, withdrawnYuan: 0, withdrawableYuan: 0, totalYuan: 0, levelOneRate: 0.15, levelTwoRate: 0.05 },
      });
      setGrowthInvitees([
        { level: 1, displayName: "\u521b\u4f5c\u8005 A", contact: "138****1024", joinedAt: new Date().toISOString(), hasPaid: true },
        { level: 1, displayName: "\u521b\u4f5c\u8005 B", contact: "139****2088", joinedAt: new Date().toISOString(), hasPaid: true },
        { level: 1, displayName: "\u521b\u4f5c\u8005 C", contact: "137****3106", joinedAt: new Date().toISOString(), hasPaid: true },
        ...(showEligiblePartner || showMockPartner ? [
          { level: 1, displayName: "\u521b\u4f5c\u8005 D", contact: "136****4120", joinedAt: new Date().toISOString(), hasPaid: true },
          { level: 1, displayName: "\u521b\u4f5c\u8005 E", contact: "135****5132", joinedAt: new Date().toISOString(), hasPaid: true },
        ] : []),
      ]);
      setGrowthCommissions([]);
      setPayoutProfile(null);
      setWithdrawals([]);
      setGrowthNotice("本地预览数据 · 不会发放真实积分");
    } else if (user) {
      setPayoutProfile(null);
      setWithdrawals([]);
      setGrowthInvitees([]);
      setGrowthCommissions([]);
      void loadGrowth();
    } else {
      setGrowth(null);
      setPayoutProfile(null);
      setWithdrawals([]);
      setGrowthNotice("");
    }
  }, [user?.id]);

  async function claimCheckin() {
    if (growthBusy || growth?.checkedInToday) return;
    if (isMockPreview) {
      setGrowthBusy(true);
      setGrowth((current) => current ? { ...current, checkedInToday: true } : current);
      setGrowthNotice("签到成功，预览状态不会发放真实积分");
      setGrowthBusy(false);
      return;
    }
    setGrowthBusy(true); setGrowthNotice("");
    try {
      const response = await fetch("/api/v1/growth/checkin", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeZone: "Asia/Shanghai" }),
      });
      const payload = await response.json() as { already?: boolean; rewardCredits?: number; error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message || "签到失败，请稍后重试");
      // The POST response is authoritative: lock the button immediately instead of
      // relying on a follow-up overview request to refresh the UI state.
      setGrowth((current) => current ? { ...current, checkedInToday: true } : current);
      setGrowthNotice(payload.already ? "今天已经签到过了" : "签到成功，已获得 100 积分");
      await loadGrowth();
      await onWalletRefresh();
    } catch (cause) { setGrowthNotice(cause instanceof Error ? cause.message : "签到失败"); }
    finally { setGrowthBusy(false); }
  }

  async function activatePartner() {
    if (growthBusy) return;
    if (isMockPreview) {
      if (!partnerProvince.trim() || !partnerCity.trim()) return;
      setGrowthBusy(true);
      setGrowth((current) => current ? { ...current, partner: { ...current.partner, active: true, province: partnerProvince.trim(), city: partnerCity.trim() } } : current);
      setGrowthNotice("\u6a21\u62df\u5f00\u901a\u6210\u529f\uff0c\u672a\u5199\u5165\u771f\u5b9e\u6570\u636e");
      setGrowthBusy(false);
      return;
    }
    setGrowthBusy(true); setGrowthNotice("");
    try {
      const response = await fetch("/api/v1/growth/partner/activate", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ province: partnerProvince, city: partnerCity }),
      });
      const payload = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message || "申请失败");
      setGrowthNotice("城市合伙人资格已开通");
      await loadGrowth();
    } catch (cause) { setGrowthNotice(cause instanceof Error ? cause.message : "申请失败"); }
    finally { setGrowthBusy(false); }
  }

  async function performSavePayoutProfile() {
    setGrowthBusy(true); setGrowthNotice("");
    try {
      const response = await fetch("/api/v1/growth/payout-profile", {
        method: "PUT", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountName: payoutName, account: payoutAccount }),
      });
      const payload = await response.json() as { profile?: typeof payoutProfile; error?: { message?: string } };
      if (!response.ok || !payload.profile) throw new Error(payload.error?.message || "收款资料保存失败");
      setPayoutProfile(payload.profile);
      setPayoutName(""); setPayoutAccount("");
      setPayoutEditing(false);
      setGrowthNotice("收款资料已加密保存，等待管理员核验通过后即可申请提现。");
    } catch (cause) { setGrowthNotice(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setGrowthBusy(false); }
  }

  async function savePayoutProfile() {
    if (growthBusy) return;
    if (isMockPreview) {
      setPayoutProfile({ channel: "alipay", accountLast4: payoutAccount.trim().slice(-4), verificationStatus: "verified" });
      setPayoutName(""); setPayoutAccount(""); setPayoutEditing(false);
      setGrowthNotice("模拟保存成功，未写入真实数据。");
      return;
    }
    await performSavePayoutProfile();
  }

  async function performSubmitWithdrawal() {
    const amountYuan = Number(withdrawAmount);
    setGrowthBusy(true); setGrowthNotice("");
    try {
      const response = await fetch("/api/v1/growth/withdrawals", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountYuan, idempotencyKey: crypto.randomUUID() }),
      });
      const payload = await response.json() as { withdrawal?: { netAmountYuan: number }; error?: { message?: string } };
      if (!response.ok || !payload.withdrawal) throw new Error(payload.error?.message || "提现申请失败");
      setWithdrawAmount("");
      setGrowthNotice(`提现申请已提交，预计 T+1 工作日到账 ¥${payload.withdrawal.netAmountYuan.toFixed(2)}，请等待审核和人工转账。`);
      await loadGrowth();
    } catch (cause) { setGrowthNotice(cause instanceof Error ? cause.message : "提现申请失败"); }
    finally { setGrowthBusy(false); }
  }

  async function submitWithdrawal() {
    if (isMockPreview || growthBusy) return;
    const amountYuan = Number(withdrawAmount);
    if (!Number.isFinite(amountYuan) || amountYuan < 100 || amountYuan > 5000 || amountYuan % 10 !== 0) {
      setGrowthNotice("单笔提现须为 100 至 5000 元，且为 10 元的整数倍。"); return;
    }
    await performSubmitWithdrawal();
  }

  async function downloadInvitePoster() {
    if (!growth?.inviteCode) return;
    try {
      const inviteUrl = "https://jansee.cn/?ref=" + encodeURIComponent(growth.inviteCode);
      const qrDataUrl = await QRCode.toDataURL(inviteUrl, { width: 480, margin: 2, errorCorrectionLevel: "H" });
      const qr = new Image();
      const qrLoaded = new Promise<void>((resolve, reject) => {
        qr.onload = () => resolve();
        qr.onerror = () => reject(new Error("QR load failed"));
      });
      qr.src = qrDataUrl;
      await qrLoaded;
      const logoMark = new Image();
      const logoMarkLoaded = new Promise<void>((resolve, reject) => {
        logoMark.onload = () => resolve();
        logoMark.onerror = () => reject(new Error("JANSEE symbol logo load failed"));
      });
      logoMark.src = "/assets/jansee-mark.svg";
      const wordmark = new Image();
      const wordmarkLoaded = new Promise<void>((resolve, reject) => {
        wordmark.onload = () => resolve();
        wordmark.onerror = () => reject(new Error("JANSEE wordmark load failed"));
      });
      wordmark.src = "/assets/jansee-pirulen-wordmark.png";
      await Promise.all([logoMarkLoaded, wordmarkLoaded]);
      await document.fonts.ready;

      const canvas = document.createElement("canvas");
      canvas.width = 900;
      canvas.height = 1200;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Poster generation failed");
      const chineseFont = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", system-ui, sans-serif';
      context.textBaseline = "alphabetic";

      context.fillStyle = "#f6f4ef";
      context.fillRect(0, 0, 900, 1200);
      context.fillStyle = "#18191b";
      context.fillRect(0, 0, 900, 18);

      context.textAlign = "left";
      context.fillStyle = "#777b80";
      context.drawImage(logoMark, 86, 78, 64, 64);
      context.drawImage(wordmark, 164, 100, 140, 19);
      context.fillStyle = "#17191c";
      context.font = "600 72px " + chineseFont;
      context.fillText("\u597d\u89c6\u9891\uff0c", 86, 270);
      context.fillText("\u4e0d\u5fc5\u4ece\u96f6\u5b66\u526a\u8f91", 86, 355);
      context.fillStyle = "#777b80";
      context.font = "32px " + chineseFont;
      context.fillText("\u7b80\u516e AI \u667a\u80fd\u5bfc\u6f14\u7cfb\u7edf", 90, 425);
      context.font = "26px " + chineseFont;
      context.fillText("\u4e0a\u4f20\u7d20\u6750\uff0c\u667a\u80fd\u751f\u6210\u5b8c\u6574\u77ed\u89c6\u9891", 90, 470);

      context.fillStyle = "#ffffff";
      context.fillRect(270, 490, 360, 360);
      context.drawImage(qr, 286, 506, 328, 328);
      context.textAlign = "center";
      context.fillStyle = "#33363a";
      context.font = "600 28px " + chineseFont;
      context.fillText("\u626b\u7801\u6ce8\u518c\uff0c\u5f00\u542f\u667a\u80fd\u521b\u4f5c", 450, 895);
      context.fillStyle = "#85898e";
      context.font = "22px " + chineseFont;
      context.fillText("\u4e13\u5c5e\u9080\u8bf7\u7801\uff1a" + growth.inviteCode, 450, 935);

      context.fillStyle = "#18191b";
      context.fillRect(0, 970, 900, 230);
      context.fillStyle = "#ffffff";
      context.font = "600 30px " + chineseFont;
      context.fillText("\u6ce8\u518c\u5c31\u9001 600 \u79ef\u5206", 450, 1030);
      context.font = "28px " + chineseFont;
      context.fillText("\u9080\u8bf7\u597d\u53cb\u518d\u9001 200 \u79ef\u5206", 450, 1090);
      context.fillText("\u6bcf\u65e5\u7b7e\u5230\u518d\u9001 100 \u79ef\u5206", 450, 1150);

      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Poster export failed")), "image/png"));
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "JANSEE-\u63a8\u5e7f\u6d77\u62a5-" + growth.inviteCode + ".png";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      setGrowthNotice("\u4e13\u5c5e\u63a8\u5e7f\u6d77\u62a5\u5df2\u751f\u6210\uff0c\u4fdd\u5b58\u540e\u5373\u53ef\u5206\u4eab");
    } catch (cause) {
      setGrowthNotice(cause instanceof Error ? cause.message : "Poster generation failed");
    }
  }

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
    setError(""); setNotice(""); setSending(true);
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

  async function logout() {
    try {
      const response = await fetch("/api/v1/auth/logout", { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error("logout failed");
      onLogout();
    } catch { setError("退出登录失败，请检查网络后重试。"); }
  }

  if (user && !user.isGuest) return <>
    <div className="panel-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg></div>
    <h2 id="header-panel-title">{"\u8d26\u6237\u4fe1\u606f"}</h2>
    <p className="header-panel-copy">{"\u7ba1\u7406\u4f60\u7684\u7b80\u516e\u8d26\u6237\u4e0e\u521b\u4f5c\u6743\u76ca\u3002"}</p>
    <div className="login-notice">
      <div className="profile-name-row">
        {editingDisplayName ? (
          <div className="profile-name-editor">
            <input value={displayNameDraft} maxLength={24} onChange={(event) => setDisplayNameDraft(event.target.value)} aria-label="修改昵称" />
            <button type="button" className="profile-name-save" disabled={displayNameSaving} onClick={() => void saveDisplayName()}>{displayNameSaving ? "保存中…" : "保存"}</button>
          </div>
        ) : (
          <>
            <strong>{user.displayName || (user.phone ? "\u7528\u6237_" + user.phone.slice(-4) : "\u521b\u4f5c\u8005")}</strong>
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
    {growthNotice && <p className="growth-notice" role="status">{growthNotice}</p>}
    {growth ? (
      <>
        <details className="growth-section growth-accordion" open={expandedGrowthSection === "checkin"}>
          <summary className="growth-accordion-trigger" onClick={(event) => { event.preventDefault(); setExpandedGrowthSection((current) => current === "checkin" ? null : "checkin"); }}>
            <div className="growth-section-heading-content">
              <div className="growth-section-heading">
                <div><span className="growth-kicker">DAILY CHECK-IN</span><h3>每日签到</h3></div>
                <span className="growth-reward">+{growth.checkinRewardCredits} 积分</span>
              </div>
            </div>
            <svg className="growth-accordion-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </summary>
          <p>每日签到可领取奖励积分，奖励自动发放到账户。</p>
          <button className="growth-primary-button growth-login-style" type="button" disabled={growthBusy || growth.checkedInToday} onClick={() => void claimCheckin()}>
            {growth.checkedInToday ? "今日已签到" : growthBusy ? "处理中…" : "立即签到"}
          </button>
        </details>
        <details className="growth-section growth-accordion" open={expandedGrowthSection === "invite"}>
          <summary className="growth-accordion-trigger" onClick={(event) => { event.preventDefault(); setExpandedGrowthSection((current) => current === "invite" ? null : "invite"); }}>
            <div className="growth-section-heading-content">
              <div className="growth-section-heading">
                <div><span className="growth-kicker">INVITE & GROW</span><h3>邀请推广</h3></div>
                <span className="growth-reward">好友注册奖励 +{growth.referralRewardCredits} 积分</span>
              </div>
            </div>
            <svg className="growth-accordion-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </summary>
          <p>分享专属邀请链接，好友通过邀请注册即可获得相应奖励。</p>
          <div className="growth-invite-card">
            <div className="growth-poster-copy">
              <span>YOUR INVITATION CODE</span>
              <strong>{growth.inviteCode}</strong>
              <small>已邀请 {growth.invitedCount} 位 · 已奖励 {growth.rewardedCount} 位</small>
            </div>
            {inviteQrDataUrl && <img src={inviteQrDataUrl} alt="专属邀请二维码" />}
          </div>
          <div className="growth-stats">
            <div><strong>{growth.invitedCount}</strong><span>邀请注册人数</span></div>
            <div><strong>{growth.rewardedCount}</strong><span>已获得奖励人数</span></div>
          </div>
          <button className="growth-poster-download" type="button" onClick={() => void downloadInvitePoster()}>生成并下载推广海报</button>
          {growthInvitees.length > 0 && (
            <details className="growth-more-records">
              <summary>查看邀请记录（{growthInvitees.length}）</summary>
              <div className="growth-record-list">
                {growthInvitees.map((invitee, index) => (
                  <div className="growth-record-row" key={index}>
                    <span>{invitee.displayName}<small>{invitee.contact} · {new Date(invitee.joinedAt).toLocaleDateString("zh-CN")}</small></span>
                    <span>{invitee.hasPaid ? "已完成付费" : "已注册"}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </details>
        <details className="growth-section growth-accordion" open={expandedGrowthSection === "partner"}>
          <summary className="growth-accordion-trigger" onClick={(event) => { event.preventDefault(); setExpandedGrowthSection((current) => current === "partner" ? null : "partner"); }}>
            <div className="growth-section-heading-content">
              <div className="growth-section-heading">
                <div><span className="growth-kicker">CITY PARTNER PROGRAM</span><h3>城市合伙人</h3></div>
                <span className="growth-status">{growth.partner.active ? "已开通" : "邀请进度中"}</span>
              </div>
            </div>
            <svg className="growth-accordion-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </summary>
          <p>邀请有效用户达到要求，即可申请成为城市合伙人并享受会员推广佣金。</p>
          {growth.partner.active ? (
            <>
              <div className="growth-partner-summary">
                <strong>{growth.partner.province || ""}{growth.partner.city || ""} · 城市合伙人</strong>
                <span>一级佣金 {Math.round(growth.partner.levelOneRate * 100)}% · 二级佣金 {Math.round(growth.partner.levelTwoRate * 100)}%</span>
                <span>累计佣金 ¥{growth.partner.totalYuan.toFixed(2)} · 待结算佣金 ¥{growth.partner.pendingYuan.toFixed(2)}</span>
                <div className="growth-money-stats">
                  <div><strong>¥{growth.partner.withdrawableYuan.toFixed(2)}</strong><span>可提现余额</span></div>
                  <div><strong>¥{growth.partner.inTransitYuan.toFixed(2)}</strong><span>在途金额</span></div>
                  <div><strong>¥{growth.partner.withdrawnYuan.toFixed(2)}</strong><span>已提现金额</span></div>
                </div>
              </div>
              {growthCommissions.length > 0 && (
                <details className="growth-more-records">
                  <summary>查看佣金明细（{growthCommissions.length}）</summary>
                  <div className="growth-record-list">
                    {growthCommissions.map((item) => (
                      <div className="growth-record-row" key={item.id}>
                        <span>{item.level === 1 ? "一级推广佣金" : "二级推广佣金"}<small>{new Date(item.createdAt).toLocaleDateString("zh-CN")} · 订单金额 ¥{item.orderAmountYuan.toFixed(2)}</small></span>
                        <span>¥{item.commissionYuan.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              <div className="growth-partner-summary">
                <strong>收款信息</strong>
                {payoutProfile ? <span>支付宝账号已加密保存 · 尾号 ****{payoutProfile.accountLast4} · {payoutProfile.verificationStatus === "verified" ? "已核验" : payoutProfile.verificationStatus === "pending" ? "等待管理员核验" : "核验未通过"}</span> : <span>尚未设置收款账户</span>}
                <button className="growth-poster-download" type="button" onClick={() => setPayoutEditing((value) => !value)}>{payoutEditing ? "取消" : payoutProfile ? "修改收款信息" : "设置收款信息"}</button>
                {payoutEditing && (
                  <div className="growth-partner-form">
                    <input value={payoutName} onChange={(event) => setPayoutName(event.target.value)} placeholder="支付宝真实姓名" autoComplete="name" />
                    <input value={payoutAccount} onChange={(event) => setPayoutAccount(event.target.value)} placeholder="支付宝手机号或账号" autoComplete="off" />
                    <button type="button" disabled={growthBusy || !payoutName.trim() || !payoutAccount.trim()} onClick={() => void savePayoutProfile()}>保存并提交核验</button>
                  </div>
                )}
                <div className="growth-partner-form">
                  <input inputMode="decimal" value={withdrawAmount} onChange={(event) => setWithdrawAmount(event.target.value)} placeholder="提现金额（100–5000 元）" />
                  <button type="button" disabled={growthBusy || isMockPreview || !payoutProfile || payoutProfile.verificationStatus !== "verified" || !withdrawAmount.trim()} onClick={() => void submitWithdrawal()}>申请提现</button>
                </div>
                {withdrawals.length > 0 && (
                  <details className="growth-more-records">
                    <summary>查看提现记录（{withdrawals.length}）</summary>
                    <div className="growth-record-list">
                      {withdrawals.map((item) => (
                        <div className="growth-record-row" key={item.id}>
                          <span>{new Date(item.createdAt).toLocaleDateString("zh-CN")}<small>{withdrawalStatusLabel[item.status] ?? item.status}</small></span>
                          <span>¥{item.amountYuan.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="growth-progress-track"><span style={{ width: `${Math.min(100, growth.partner.progress / Math.max(1, growth.partner.target) * 100)}%` }} /></div>
              <div className="growth-progress-caption"><span>有效邀请进度</span><strong>{growth.partner.progress}/{growth.partner.target} 人</strong></div>
              {growth.partner.progress >= growth.partner.target ? (
                <div className="growth-partner-form">
                  <input value={partnerProvince} onChange={(event) => setPartnerProvince(event.target.value)} placeholder="所在省份（例如：浙江省）" />
                  <input value={partnerCity} onChange={(event) => setPartnerCity(event.target.value)} placeholder="所在城市（例如：杭州市）" />
                  <button type="button" disabled={growthBusy || !partnerProvince.trim() || !partnerCity.trim()} onClick={() => void activatePartner()}>申请开通城市合伙人</button>
                </div>
              ) : (
                <p className="growth-muted">还需邀请 {Math.max(0, growth.partner.target - growth.partner.progress)} 位有效用户，即可申请成为城市合伙人。</p>
              )}
            </>
          )}
        </details>
      </>
    ) : (
      <>
        <p className="header-panel-copy" role="status">{growthNotice || "正在加载签到与推广权益…"}</p>
        <button className="growth-poster-download" type="button" onClick={() => void loadGrowth()}>重新加载</button>
      </>
    )}
    <button className="panel-primary-action" type="button" onClick={logout}>{"\u9000\u51fa\u767b\u5f55"}</button>
  </>;

  return <>
    <div className="panel-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg></div>
    <h2 id="header-panel-title">{authMode === "register" ? "\u521b\u5efa\u7b80\u516e\u8d26\u6237" : authMode === "password-setup" ? (forcePasswordReset ? "\u91cd\u7f6e\u767b\u5f55\u5bc6\u7801" : "\u8bbe\u7f6e\u767b\u5f55\u5bc6\u7801") : authMode === "sms" ? "\u77ed\u4fe1\u9a8c\u8bc1\u7801\u767b\u5f55" : "\u6b22\u8fce\u767b\u5f55\u7b80\u516e"}</h2>
    <p className="header-panel-copy">{authMode === "register" ? "\u4f7f\u7528\u624b\u673a\u53f7\u9a8c\u8bc1\u6ce8\u518c\uff0c\u5b8c\u6210\u540e\u8bbe\u7f6e\u5bc6\u7801\u3002" : authMode === "password-setup" ? "\u8bbe\u7f6e\u5bc6\u7801\u540e\uff0c\u4e0b\u6b21\u5373\u53ef\u4f7f\u7528\u624b\u673a\u53f7\u548c\u5bc6\u7801\u767b\u5f55\u3002" : authMode === "sms" ? "\u4f7f\u7528\u6ce8\u518c\u624b\u673a\u53f7\u63a5\u6536\u9a8c\u8bc1\u7801\uff0c\u5b89\u5168\u5feb\u6377\u5730\u767b\u5f55\u3002" : "\u4f7f\u7528\u624b\u673a\u53f7\u548c\u5bc6\u7801\u767b\u5f55 JANSEE\u3002"}</p>
    {notice && <p className="auth-notice" role="status">{notice}</p>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    {authMode !== "password-setup" && (
      <div className="auth-tabs" role="tablist" aria-label={"\u6ce8\u518c\u4e0e\u767b\u5f55"}>
        <button type="button" role="tab" aria-selected={authMode === "register"} className={authMode === "register" ? "auth-tab active" : "auth-tab"} onClick={() => { setAuthMode("register"); setForcePasswordReset(false); setError(""); setNotice(""); setCode(""); setPassword(""); }}>{"\u6ce8\u518c"}</button>
        <button type="button" role="tab" aria-selected={authMode !== "register"} className={authMode !== "register" ? "auth-tab active" : "auth-tab"} onClick={() => { setAuthMode("password"); setForcePasswordReset(false); setError(""); setNotice(""); setCode(""); }}>{"\u767b\u5f55"}</button>
      </div>
    )}
    {authMode === "password-setup" ? (
      <form className="auth-form" onSubmit={submitPasswordSetup}>
        <label><span>{"\u65b0\u5bc6\u7801"}</span><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={8} maxLength={128} autoComplete="new-password" required placeholder={"\u81f3\u5c11 8 \u4f4d\u5bc6\u7801"} /></label>
        <label><span>{"\u786e\u8ba4\u5bc6\u7801"}</span><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} maxLength={128} autoComplete="new-password" required placeholder={"\u518d\u6b21\u8f93\u5165\u5bc6\u7801"} /></label>
        <button className="panel-primary-action" type="submit" disabled={busy}>{busy ? "\u4fdd\u5b58\u4e2d\u2026" : "\u5b8c\u6210\u5e76\u8fdb\u5165\u7b80\u516e"}</button>
      </form>
    ) : (
      <form className="auth-form auth-entry-form" onSubmit={authMode === "password" ? submitPasswordLogin : authMode === "register" ? submitSmsRegistration : submitSmsLogin}>
        <label><span>{"\u624b\u673a\u53f7"}</span><input type="tel" value={phone} onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 11))} required maxLength={11} autoComplete="tel" placeholder={"\u8bf7\u8f93\u5165 11 \u4f4d\u5927\u9646\u624b\u673a\u53f7"} /></label>
        {authMode === "password" ? (
          <label><span>{"\u767b\u5f55\u5bc6\u7801"}</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password" placeholder={"\u8bf7\u8f93\u5165\u5bc6\u7801"} /></label>
        ) : (
          <label><span>{"\u77ed\u4fe1\u9a8c\u8bc1\u7801"}</span><div className="auth-code-row">
            <input type="text" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))} required maxLength={8} inputMode="numeric" autoComplete="one-time-code" placeholder={"\u8bf7\u8f93\u5165\u9a8c\u8bc1\u7801"} />
            <button type="button" className="auth-code-send" disabled={sending || countdown > 0 || phone.length !== 11} onClick={handleSendSms}>{countdown > 0 ? countdown + "s \u540e\u91cd\u53d1" : sending ? "\u53d1\u9001\u4e2d\u2026" : "\u83b7\u53d6\u9a8c\u8bc1\u7801"}</button>
          </div></label>
        )}
        <button className="panel-primary-action" type="submit" disabled={busy}>{busy ? "\u5904\u7406\u4e2d\u2026" : authMode === "password" ? "\u767b\u5f55" : authMode === "register" ? "\u9a8c\u8bc1\u624b\u673a\u53f7\u5e76\u6ce8\u518c" : "\u9a8c\u8bc1\u7801\u767b\u5f55"}</button>
      </form>
    )}
    {authMode !== "password-setup" && (
      <div className="auth-footer-links">
        {authMode === "password" ? <>
          <button type="button" className="auth-mode-link" onClick={() => { setAuthMode("sms"); setForcePasswordReset(false); setError(""); setNotice(""); setCode(""); }}>{"\u9a8c\u8bc1\u7801\u767b\u5f55"}</button>
          <button type="button" className="auth-mode-link" onClick={() => { setAuthMode("sms"); setForcePasswordReset(true); setError(""); setNotice("\u8bf7\u5148\u4f7f\u7528\u77ed\u4fe1\u9a8c\u8bc1\u7801\uff0c\u9a8c\u8bc1\u901a\u8fc7\u540e\u5373\u53ef\u91cd\u7f6e\u5bc6\u7801\u3002"); setCode(""); }}>{"\u5fd8\u8bb0\u5bc6\u7801\uff1f"}</button>
        </> : authMode === "sms" ? (
          <button type="button" className="auth-mode-link" onClick={() => { setAuthMode("password"); setForcePasswordReset(false); setError(""); setNotice(""); setCode(""); setPassword(""); }}>{"\u8fd4\u56de\u5bc6\u7801\u767b\u5f55"}</button>
        ) : (
          <button type="button" className="auth-mode-link" onClick={() => { setAuthMode("password"); setForcePasswordReset(false); setError(""); setNotice(""); setCode(""); setPassword(""); }}>{"\u8fd4\u56de\u767b\u5f55"}</button>
        )}
      </div>
    )}
  </>;
}

function resolvePublishForWork(work: WorkItem, conversations: SavedConversation[]): {
  title?: string;
  caption?: string;
  cover_title?: string;
  pinned_comment?: string;
  post_time?: string;
} | null {
  // 画面主标题 title 属于导演方案顶层字段，不在 publish 四件套里，单独带出。
  let title = "";
  const workPlan = work.directorPlan as Record<string, unknown> | undefined;
  if (typeof workPlan?.title === "string" && workPlan.title.trim()) title = workPlan.title.trim();

  // publish 四件套：优先作品自带，缺的再从对应对话的导演方案回填。
  let base: NonNullable<WorkItem["publish"]> | null = null;
  if (work.publish && (work.publish.caption || work.publish.cover_title || work.publish.pinned_comment)) {
    base = work.publish;
  }
  for (const conv of conversations) {
    for (const msg of conv.messages) {
      if (msg.jobWorkId === work.id || (msg.jobId && msg.jobId === work.jobId)) {
        const plan = msg.jobDirectorPlan;
        if (!title && typeof plan?.title === "string" && plan.title.trim()) title = plan.title.trim();
        if (!base) {
          const p = plan?.publish as Record<string, unknown> | undefined;
          if (p && (p.caption || p.cover_title || p.pinned_comment || p.post_time)) {
            const res: NonNullable<WorkItem["publish"]> = {};
            if (typeof p.caption === "string") res.caption = p.caption;
            if (typeof p.cover_title === "string") res.cover_title = p.cover_title;
            if (typeof p.pinned_comment === "string") res.pinned_comment = p.pinned_comment;
            if (typeof p.post_time === "string") res.post_time = p.post_time;
            base = res;
          }
        }
      }
    }
  }
  if (!base && !title) return null;
  return { ...(base ?? {}), ...(title ? { title } : {}) };
}
