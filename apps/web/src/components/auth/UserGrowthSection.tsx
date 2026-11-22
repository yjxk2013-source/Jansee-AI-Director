import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { AuthUser } from "../../types/client.js";
import { useTimedNotice, withdrawalStatusLabel } from "../../utils/clientPlatform.js";

interface UserGrowthSectionProps {
  user: AuthUser;
  onWalletRefresh: () => Promise<void>;
}

type GrowthOverview = {
  inviteCode: string;
  invitedCount: number;
  rewardedCount: number;
  checkedInToday: boolean;
  checkinRewardCredits: number;
  referralRewardCredits: number;
  partner: {
    active: boolean;
    province?: string | null;
    city?: string | null;
    target: number;
    progress: number;
    pendingYuan: number;
    settledYuan: number;
    inTransitYuan: number;
    withdrawnYuan: number;
    withdrawableYuan: number;
    totalYuan: number;
    levelOneRate: number;
    levelTwoRate: number;
  };
};

type InviteeRecord = { level: number; displayName: string; contact: string; joinedAt: string; hasPaid: boolean };
type CommissionRecord = { id: string; level: number; orderAmountYuan: number; rate: number; commissionYuan: number; status: string; createdAt: string; settledAt: string | null; source: string };
type PayoutProfileData = { channel: string; accountLast4: string; verificationStatus: string; verificationNote?: string | null };
type WithdrawalRecord = { id: string; amountYuan: number; feeYuan: number; netAmountYuan: number; status: string; note?: string | null; createdAt: string; processedAt?: string | null; arrivalType?: string };

// 客户端内存轻缓存：60 秒内重复打开个人主页直接秒开，0 请求 0 闪烁
const GROWTH_CACHE: {
  userId?: string | undefined;
  timestamp?: number | undefined;
  overview?: GrowthOverview | undefined;
  invitees?: InviteeRecord[] | undefined;
  commissions?: CommissionRecord[] | undefined;
  payoutProfile?: PayoutProfileData | null | undefined;
  withdrawals?: WithdrawalRecord[] | undefined;
} = {};

const CACHE_TTL_MS = 60_000;

function clearGrowthCache() {
  GROWTH_CACHE.userId = undefined;
  GROWTH_CACHE.timestamp = undefined;
  GROWTH_CACHE.overview = undefined;
  GROWTH_CACHE.invitees = undefined;
  GROWTH_CACHE.commissions = undefined;
  GROWTH_CACHE.payoutProfile = undefined;
  GROWTH_CACHE.withdrawals = undefined;
}

export function UserGrowthSection({ user, onWalletRefresh }: UserGrowthSectionProps) {
  const [inviteQrDataUrl, setInviteQrDataUrl] = useState("");
  const [growth, setGrowth] = useState<GrowthOverview | null>(() => {
    if (GROWTH_CACHE.userId === user.id && GROWTH_CACHE.overview && Date.now() - (GROWTH_CACHE.timestamp ?? 0) < CACHE_TTL_MS) {
      return GROWTH_CACHE.overview;
    }
    return null;
  });
  const [expandedGrowthSection, setExpandedGrowthSection] = useState<"checkin" | "invite" | "partner" | null>(null);
  const [growthBusy, setGrowthBusy] = useState(false);
  const [payoutProfile, setPayoutProfile] = useState<PayoutProfileData | null>(() => {
    if (GROWTH_CACHE.userId === user.id && Date.now() - (GROWTH_CACHE.timestamp ?? 0) < CACHE_TTL_MS) {
      return GROWTH_CACHE.payoutProfile ?? null;
    }
    return null;
  });
  const [payoutName, setPayoutName] = useState("");
  const [payoutAccount, setPayoutAccount] = useState("");
  const [payoutEditing, setPayoutEditing] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawals, setWithdrawals] = useState<WithdrawalRecord[]>(() => {
    if (GROWTH_CACHE.userId === user.id && GROWTH_CACHE.withdrawals && Date.now() - (GROWTH_CACHE.timestamp ?? 0) < CACHE_TTL_MS) {
      return GROWTH_CACHE.withdrawals;
    }
    return [];
  });
  const [growthInvitees, setGrowthInvitees] = useState<InviteeRecord[]>(() => {
    if (GROWTH_CACHE.userId === user.id && GROWTH_CACHE.invitees && Date.now() - (GROWTH_CACHE.timestamp ?? 0) < CACHE_TTL_MS) {
      return GROWTH_CACHE.invitees;
    }
    return [];
  });
  const [growthCommissions, setGrowthCommissions] = useState<CommissionRecord[]>(() => {
    if (GROWTH_CACHE.userId === user.id && GROWTH_CACHE.commissions && Date.now() - (GROWTH_CACHE.timestamp ?? 0) < CACHE_TTL_MS) {
      return GROWTH_CACHE.commissions;
    }
    return [];
  });
  const [growthNotice, setGrowthNotice] = useTimedNotice();
  const [partnerProvince, setPartnerProvince] = useState("");
  const [partnerCity, setPartnerCity] = useState("");

  const isMockPreview = import.meta.env.DEV && user?.id === "local-preview-user";

  // 专属邀请二维码仅在展开邀请面板或准备分享时生成，避免弹窗瞬间占用 CPU
  useEffect(() => {
    if (!growth?.inviteCode || (expandedGrowthSection !== "invite" && !inviteQrDataUrl)) {
      return;
    }
    if (inviteQrDataUrl) return;

    let active = true;
    const inviteUrl = `https://jansee.cn/?ref=${encodeURIComponent(growth.inviteCode)}`;
    
    QRCode.toDataURL(inviteUrl, { width: 320, margin: 2, errorCorrectionLevel: "M" })
      .then((dataUrl: string) => {
        if (active && dataUrl) setInviteQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (active) {
          setInviteQrDataUrl(`/api/v1/growth/qr/${encodeURIComponent(growth.inviteCode)}`);
        }
      });
    return () => { active = false; };
  }, [growth?.inviteCode, expandedGrowthSection, inviteQrDataUrl]);

  // 1. 核心概览按需极速加载（首次开窗仅发这 1 个请求）
  async function loadGrowthOverview(force = false) {
    if (!force && GROWTH_CACHE.userId === user.id && GROWTH_CACHE.overview && Date.now() - (GROWTH_CACHE.timestamp ?? 0) < CACHE_TTL_MS) {
      setGrowth(GROWTH_CACHE.overview);
      setPartnerProvince(GROWTH_CACHE.overview.partner.province ?? "");
      setPartnerCity(GROWTH_CACHE.overview.partner.city ?? "");
      return;
    }

    try {
      const overviewResponse = await fetch("/api/v1/growth/overview?timeZone=Asia%2FShanghai", { credentials: "include", cache: "no-store" });
      if (overviewResponse.ok) {
        const overviewPayload = await overviewResponse.json() as { overview?: GrowthOverview };
        if (overviewPayload.overview) {
          setGrowth(overviewPayload.overview);
          setPartnerProvince(overviewPayload.overview.partner.province ?? "");
          setPartnerCity(overviewPayload.overview.partner.city ?? "");
          GROWTH_CACHE.userId = user.id;
          GROWTH_CACHE.timestamp = Date.now();
          GROWTH_CACHE.overview = overviewPayload.overview;
        }
      }
    } catch {
      setGrowthNotice("暂时无法加载签到与推广信息，请检查网络后重试。");
    }
  }

  // 2. 展开“邀请推广”时按需懒加载邀请人名册
  async function loadInviteesIfNeeded() {
    if (isMockPreview || (GROWTH_CACHE.userId === user.id && GROWTH_CACHE.invitees)) return;
    try {
      const res = await fetch("/api/v1/growth/invitees", { credentials: "include" });
      if (res.ok) {
        const data = await res.json() as { invitees?: InviteeRecord[] };
        if (data.invitees) {
          setGrowthInvitees(data.invitees);
          GROWTH_CACHE.invitees = data.invitees;
        }
      }
    } catch {
      // 容错处理，不中断界面
    }
  }

  // 3. 展开“城市合伙人”时按需懒加载合伙人相关 3 个明细接口
  async function loadPartnerDetailsIfNeeded() {
    if (isMockPreview) return;
    const needCommissions = !(GROWTH_CACHE.userId === user.id && GROWTH_CACHE.commissions);
    const needProfile = !(GROWTH_CACHE.userId === user.id && GROWTH_CACHE.payoutProfile !== undefined);
    const needWithdrawals = !(GROWTH_CACHE.userId === user.id && GROWTH_CACHE.withdrawals);

    if (!needCommissions && !needProfile && !needWithdrawals) return;

    try {
      const tasks: Promise<any>[] = [];
      if (needCommissions) tasks.push(fetch("/api/v1/growth/commissions", { credentials: "include" }).then((r) => r.ok ? r.json() : null));
      else tasks.push(Promise.resolve(null));

      if (needProfile) tasks.push(fetch("/api/v1/growth/payout-profile", { credentials: "include", cache: "no-store" }).then((r) => r.ok ? r.json() : null));
      else tasks.push(Promise.resolve(null));

      if (needWithdrawals) tasks.push(fetch("/api/v1/growth/withdrawals", { credentials: "include" }).then((r) => r.ok ? r.json() : null));
      else tasks.push(Promise.resolve(null));

      const [commissionsRes, profileRes, withdrawalsRes] = await Promise.allSettled(tasks);
      if (commissionsRes && commissionsRes.status === "fulfilled" && commissionsRes.value && "commissions" in commissionsRes.value) {
        const list = (commissionsRes.value as { commissions?: CommissionRecord[] }).commissions ?? [];
        setGrowthCommissions(list);
        GROWTH_CACHE.commissions = list;
      }
      if (profileRes && profileRes.status === "fulfilled" && profileRes.value && "profile" in profileRes.value) {
        const prof = (profileRes.value as { profile?: PayoutProfileData }).profile ?? null;
        setPayoutProfile(prof);
        GROWTH_CACHE.payoutProfile = prof;
      }
      if (withdrawalsRes && withdrawalsRes.status === "fulfilled" && withdrawalsRes.value && "withdrawals" in withdrawalsRes.value) {
        const withs = (withdrawalsRes.value as { withdrawals?: WithdrawalRecord[] }).withdrawals ?? [];
        setWithdrawals(withs);
        GROWTH_CACHE.withdrawals = withs;
      }
    } catch {
      // 容错静默
    }
  }

  // 监听折叠展开事件，执行懒加载
  function toggleSection(section: "checkin" | "invite" | "partner") {
    setExpandedGrowthSection((current) => {
      const next = current === section ? null : section;
      if (next === "invite") {
        void loadInviteesIfNeeded();
      } else if (next === "partner") {
        void loadPartnerDetailsIfNeeded();
      }
      return next;
    });
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
        partner: showMockPartner
          ? { active: true, province: "浙江省", city: "杭州市", target: 5, progress: 8, pendingYuan: 386.50, settledYuan: 1260, inTransitYuan: 120, withdrawnYuan: 680, withdrawableYuan: 460, totalYuan: 2106.50, levelOneRate: 0.15, levelTwoRate: 0.05 }
          : { active: false, target: 5, progress: showEligiblePartner ? 5 : 3, pendingYuan: 0, settledYuan: 0, inTransitYuan: 0, withdrawnYuan: 0, withdrawableYuan: 0, totalYuan: 0, levelOneRate: 0.15, levelTwoRate: 0.05 },
      });
      setGrowthInvitees([
        { level: 1, displayName: "创作者 A", contact: "138****1024", joinedAt: new Date().toISOString(), hasPaid: true },
        { level: 1, displayName: "创作者 B", contact: "139****2088", joinedAt: new Date().toISOString(), hasPaid: true },
        { level: 1, displayName: "创作者 C", contact: "137****3106", joinedAt: new Date().toISOString(), hasPaid: true },
      ]);
      setGrowthCommissions([]);
      setPayoutProfile(null);
      setWithdrawals([]);
      setGrowthNotice("本地预览数据 · 不会发放真实积分");
    } else if (user) {
      if (GROWTH_CACHE.userId !== user.id) {
        clearGrowthCache();
        setPayoutProfile(null);
        setWithdrawals([]);
        setGrowthInvitees([]);
        setGrowthCommissions([]);
      }
      void loadGrowthOverview();
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
    setGrowthBusy(true);
    setGrowthNotice("");
    try {
      const response = await fetch("/api/v1/growth/checkin", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeZone: "Asia/Shanghai" }),
      });
      const payload = await response.json() as { already?: boolean; error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message || "签到失败，请稍后重试");
      setGrowth((current) => {
        const next = current ? { ...current, checkedInToday: true } : current;
        if (next && GROWTH_CACHE.userId === user.id) {
          GROWTH_CACHE.overview = next;
        }
        return next;
      });
      setGrowthNotice(payload.already ? "今天已经签到过了" : "签到成功，已获得 100 积分");
      await loadGrowthOverview(true);
      await onWalletRefresh();
    } catch (cause) {
      setGrowthNotice(cause instanceof Error ? cause.message : "签到失败");
    } finally {
      setGrowthBusy(false);
    }
  }

  async function activatePartner() {
    if (growthBusy) return;
    if (isMockPreview) {
      if (!partnerProvince.trim() || !partnerCity.trim()) return;
      setGrowthBusy(true);
      setGrowth((current) => current ? { ...current, partner: { ...current.partner, active: true, province: partnerProvince.trim(), city: partnerCity.trim() } } : current);
      setGrowthNotice("模拟开通成功，未写入真实数据");
      setGrowthBusy(false);
      return;
    }
    setGrowthBusy(true);
    setGrowthNotice("");
    try {
      const response = await fetch("/api/v1/growth/partner/activate", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ province: partnerProvince, city: partnerCity }),
      });
      const payload = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message || "申请失败");
      setGrowthNotice("城市合伙人资格已开通");
      await loadGrowthOverview(true);
      await loadPartnerDetailsIfNeeded();
    } catch (cause) {
      setGrowthNotice(cause instanceof Error ? cause.message : "申请失败");
    } finally {
      setGrowthBusy(false);
    }
  }

  async function savePayoutProfile() {
    if (growthBusy) return;
    if (isMockPreview) {
      setPayoutProfile({ channel: "alipay", accountLast4: payoutAccount.trim().slice(-4), verificationStatus: "verified" });
      setPayoutName(""); setPayoutAccount(""); setPayoutEditing(false);
      setGrowthNotice("模拟保存成功，未写入真实数据。");
      return;
    }
    setGrowthBusy(true); setGrowthNotice("");
    try {
      const response = await fetch("/api/v1/growth/payout-profile", {
        method: "PUT", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountName: payoutName, account: payoutAccount }),
      });
      const payload = await response.json() as { profile?: PayoutProfileData; error?: { message?: string } };
      if (!response.ok || !payload.profile) throw new Error(payload.error?.message || "收款资料保存失败");
      setPayoutProfile(payload.profile);
      if (GROWTH_CACHE.userId === user.id) {
        GROWTH_CACHE.payoutProfile = payload.profile;
      }
      setPayoutName(""); setPayoutAccount(""); setPayoutEditing(false);
      setGrowthNotice("收款资料已加密保存，等待管理员核验通过后即可申请提现。");
    } catch (cause) {
      setGrowthNotice(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setGrowthBusy(false);
    }
  }

  async function submitWithdrawal() {
    if (isMockPreview || growthBusy) return;
    const amountYuan = Number(withdrawAmount);
    if (!Number.isFinite(amountYuan) || amountYuan < 100 || amountYuan > 5000 || amountYuan % 10 !== 0) {
      setGrowthNotice("单笔提现须为 100 至 5000 元，且为 10 元的整数倍。");
      return;
    }
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
      if (GROWTH_CACHE.userId === user.id) {
        GROWTH_CACHE.withdrawals = undefined;
        GROWTH_CACHE.overview = undefined;
      }
      await loadGrowthOverview(true);
      await loadPartnerDetailsIfNeeded();
    } catch (cause) {
      setGrowthNotice(cause instanceof Error ? cause.message : "提现申请失败");
    } finally {
      setGrowthBusy(false);
    }
  }

  async function downloadInvitePoster() {
    if (!growth?.inviteCode) return;
    try {
      setGrowthNotice("正在生成专属推广海报…");
      const inviteUrl = "https://jansee.cn/?ref=" + encodeURIComponent(growth.inviteCode);
      
      let qrDataUrl = "";
      try {
        qrDataUrl = await QRCode.toDataURL(inviteUrl, { width: 320, margin: 2, errorCorrectionLevel: "M" });
      } catch {
        // 客户端生成失败才降级
      }

      const qr = new Image();
      if (qrDataUrl && qrDataUrl.startsWith("data:")) {
        qr.src = qrDataUrl;
      } else {
        qr.crossOrigin = "anonymous";
        qr.src = `/api/v1/growth/qr/${encodeURIComponent(growth.inviteCode)}`;
      }
      const qrLoaded = new Promise<void>((resolve, reject) => {
        qr.onload = () => resolve();
        qr.onerror = () => reject(new Error("专属二维码加载失败"));
      });
      await qrLoaded;

      // 弹性加载 Logo 标志与文字标（若缺失不阻断海报生成）
      const loadSafeImage = (src: string) =>
        new Promise<HTMLImageElement | null>((resolve) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = src;
        });

      const [logoMark, wordmark] = await Promise.all([
        loadSafeImage("/assets/jansee-mark.svg"),
        loadSafeImage("/assets/jansee-pirulen-wordmark.png"),
      ]);

      if (document.fonts?.ready) {
        try {
          await document.fonts.ready;
        } catch {
          // 字体就绪等待超时或失败时静默降级
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = 900;
      canvas.height = 1200;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法初始化海报绘制画布");
      const chineseFont = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", system-ui, sans-serif';
      context.textBaseline = "alphabetic";

      // 纯净典雅背景
      context.fillStyle = "#f6f4ef";
      context.fillRect(0, 0, 900, 1200);
      context.fillStyle = "#18191b";
      context.fillRect(0, 0, 900, 18);

      context.textAlign = "left";
      if (logoMark) {
        context.drawImage(logoMark, 86, 78, 64, 64);
      }
      if (wordmark) {
        context.drawImage(wordmark, 164, 100, 140, 19);
      } else {
        context.fillStyle = "#17191c";
        context.font = "700 24px " + chineseFont;
        context.fillText("JANSEE", 164, 118);
      }

      context.fillStyle = "#17191c";
      context.font = "600 72px " + chineseFont;
      context.fillText("好视频，", 86, 270);
      context.fillText("不必从零学剪辑", 86, 355);
      context.fillStyle = "#777b80";
      context.font = "32px " + chineseFont;
      context.fillText("简兮 AI 智能导演系统", 90, 425);
      context.font = "26px " + chineseFont;
      context.fillText("上传素材，智能生成完整短视频", 90, 470);

      // 二维码白底展示区域
      context.fillStyle = "#ffffff";
      context.fillRect(270, 490, 360, 360);
      context.drawImage(qr, 286, 506, 328, 328);
      context.textAlign = "center";
      context.fillStyle = "#33363a";
      context.font = "600 28px " + chineseFont;
      context.fillText("扫码注册，开启智能创作", 450, 895);
      context.fillStyle = "#85898e";
      context.font = "22px " + chineseFont;
      context.fillText("专属邀请码：" + growth.inviteCode, 450, 935);

      // 底部权益区域
      context.fillStyle = "#18191b";
      context.fillRect(0, 970, 900, 230);
      context.fillStyle = "#ffffff";
      context.font = "600 30px " + chineseFont;
      context.fillText("注册就送 600 积分", 450, 1030);
      context.font = "28px " + chineseFont;
      context.fillText("邀请好友再送 200 积分", 450, 1090);
      context.fillText("每日签到再送 100 积分", 450, 1150);

      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("推广海报导出失败"))), "image/png"),
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "JANSEE-推广海报-" + growth.inviteCode + ".png";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      setGrowthNotice("专属推广海报已生成，保存后即可分享");
    } catch (cause) {
      setGrowthNotice(cause instanceof Error ? cause.message : "推广海报生成失败，请稍后重试");
    }
  }

  return (
    <>
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
              {inviteQrDataUrl ? (
                <img
                  src={inviteQrDataUrl}
                  alt="专属邀请二维码"
                  onError={() => {
                    // 若前端生成的 DataURL 异常，自动降级为服务端接口
                    const fallback = `/api/v1/growth/qr/${encodeURIComponent(growth.inviteCode)}`;
                    if (inviteQrDataUrl !== fallback) setInviteQrDataUrl(fallback);
                  }}
                />
              ) : (
                <div className="growth-qr-placeholder" aria-label="正在生成专属二维码">
                  二维码生成中
                </div>
              )}
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
          <button className="growth-poster-download" type="button" onClick={() => void loadGrowthOverview(true)}>重新加载</button>
        </>
      )}
    </>
  );
}

