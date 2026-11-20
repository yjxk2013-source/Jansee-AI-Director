import { useState, useEffect } from "react";

interface AdminPricingPlan { id: string; name: string; priceYuan: number; strikeYuan: string; }
interface AdminPricingCatalog {
  members: AdminPricingPlan[];
  boostPacks: AdminPricingPlan[];
  sync?: { status: string; source: string; lastSyncedAt: string | null; productName?: string; priceVersions?: Record<string, number>; message?: string };
}

interface AdminOverviewStats {
  totalUsers: number;
  todayRevenueYuan: number;
  todayNewUsers: number;
  todayCompletedJobs: number;
  todayFailedJobs: number;
  jobSuccessRate: number;
  avgE2eDurationSec: number;
  p50E2eDurationSec: number;
  p90E2eDurationSec: number;
  p99E2eDurationSec: number;
  avgLlmDurationSec: number;
  avgTtsDurationSec: number;
  avgFfmpegDurationSec: number;
  avgRendererDurationSec: number;
  avgSceneScore: number;
  sceneScoreDataAvailable: boolean;
  totalJobs: number;
  failedJobs: number;
  directorTelemetryAvailable: boolean;
  directorCalls: number;
  primaryModelSuccessRate: number;
  fallbackModelRate: number;
  heuristicFallbackRate: number;
  totalTokensUsed: number;
  tokenUsageRecords: number;
  totalTtsChars: number;
  qualityCheckedJobs: number;
  qualityPassedJobs: number;
  qualityPassRate: number;
  totalCostEstimateYuan: number;
  variantHitRate: number;
  revenueDataAvailable?: boolean;
  costDataAvailable?: boolean;
  databaseDataAvailable?: boolean;
}

interface DirectorJobInsight {
  jobId: string;
  userId: string;
  status: "queued" | "inspecting" | "planning" | "rendering" | "quality-check" | "completed" | "failed";
  aspectRatio: string;
  e2eDurationMs: number;
  llmDurationMs: number;
  ffmpegDurationMs: number;
  rendererDurationMs: number;
  ttsDurationMs: number;
  variantDirectorHit: boolean;
  variantType: string;
  variantTemplate: string;
  lockedVariant: string;
  variantMatched: boolean | null;
  voiceId: string;
  scene: string;
  sceneSource: string;
  sceneType: string;
  sceneScore: number;
  sceneAlignmentReason: string;
  tokensUsed: number;
  ttsChars: number;
  costEstimateYuan: number;
  tokenUsageAvailable: boolean;
  providerMode: string;
  requestedModel: string;
  selectedModel: string;
  modelsAttempted: string[];
  modelAttempts: Array<{ model: string; durationMs: number; ok: boolean; error?: string }>;
  costSource: string;
  qualityPassed: boolean;
  failureStage: string;
  creditsCharged: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  finishedAt?: string | null;
}

interface PartnerPayoutProfile {
  userId: string;
  channel: string;
  accountLast4: string;
  displayName: string;
  contact: string;
  province: string | null;
  city: string | null;
  updatedAt: string;
}
interface CityPartner {
  userId: string;
  displayName: string;
  contact: string;
  province: string | null;
  city: string | null;
  activatedAt: string;
  directInvites: number;
  secondLevelInvites: number;
  pendingCommissionYuan: number;
  settledCommissionYuan: number;
  reservedWithdrawalYuan: number;
  withdrawableYuan: number;
  payoutVerificationStatus: string;
  payoutAccountLast4: string | null;
}
interface PartnerWithdrawal {
  id: string;
  userId: string;
  displayName: string;
  contact: string;
  amountYuan: number;
  feeYuan: number;
  netAmountYuan: number;
  status: string;
  note: string | null;
  externalReference: string | null;
  payoutChannel: string;
  accountLast4: string | null;
  createdAt: string;
  processedAt: string | null;
}
interface SupportMessage {
  id: string;
  userId: string;
  orderId: string | null;
  displayName: string;
  contact: string;
  subject: string;
  message: string;
  status: "unread" | "read" | "resolved";
  createdAt: string;
}
interface AdminInboxMessage {
  id: string;
  subject: string;
  body: string;
  category: "welcome" | "features" | "notice";
  status: "draft" | "published";
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}
interface UserAnalyticsData {
  summary: { totalUsers: number; activeUsers: number; todayNewUsers: number; last7Days: number; last30Days: number; geoUsers: number; unknownRegionUsers: number };
  trend: { day: string; registrations: number; completedJobs: number; revenueYuan: number }[];
  regions: { province: string; users: number; cities: { city: string; users: number }[] }[];
  users: { id: string; displayName: string; contact: string; status: string; createdAt: string; province: string | null; city: string | null; region: string; credits: number; completedJobs: number; downloads: number }[];
  total: number;
  limit: number;
  offset: number;
  regionDataAvailable: boolean;
}
interface SiteAnalyticsData {
  summary: { pv: number; uv: number; days: number };
  series: { day: string; pv: number; uv: number }[];
  dimensions: { pages: Record<string, number>; sources: Record<string, number>; regions: Record<string, number>; devices: Record<string, number>; browsers: Record<string, number> };
  note: string;
}
interface ServerHealthData {
  sampledAt: string;
  host: { platform: string; architecture: string; hostname: string; cpuCores: number; uptimeSeconds: number };
  cpu: { usagePercent: number | null; loadAverage: number[] };
  memory: { totalBytes: number; freeBytes: number; usedBytes: number; usedPercent: number; processRssBytes: number; processHeapUsedBytes: number };
  disk: { totalBytes: number; freeBytes: number; usedBytes: number; usedPercent: number | null } | null;
  services: Record<string, { status: string; detail: string }>;
}
interface AdminConsoleProps {
  onClose: () => void;
}

export function AdminConsole({ onClose }: AdminConsoleProps) {
  const [loadedStats, setLoadedStats] = useState<AdminOverviewStats | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<DirectorJobInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"director-jobs" | "overview" | "users" | "partner-finance" | "server" | "pricing" | "inbox">("overview");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterScene, setFilterScene] = useState<string>("all");
  const [compensatingJobId, setCompensatingJobId] = useState<string | null>(null);
  const [compensationAvailable, setCompensationAvailable] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!toastMessage) return;
    const timer = window.setTimeout(() => setToastMessage(null), 2500);
    return () => window.clearTimeout(timer);
  }, [toastMessage]);
  const [pricingCatalog, setPricingCatalog] = useState<AdminPricingCatalog | null>(null);
  const [strikePriceDrafts, setStrikePriceDrafts] = useState<Record<string, string>>({});
  const [strikePriceSavingId, setStrikePriceSavingId] = useState<string | null>(null);
  const [partnerProfiles, setPartnerProfiles] = useState<PartnerPayoutProfile[]>([]);
  const [cityPartners, setCityPartners] = useState<CityPartner[]>([]);
  const [partnerWithdrawals, setPartnerWithdrawals] = useState<PartnerWithdrawal[]>([]);
  const [supportMessages, setSupportMessages] = useState<SupportMessage[]>([]);
  const [supportReplyDrafts, setSupportReplyDrafts] = useState<Record<string, string>>({});
  const [supportReplyBusyId, setSupportReplyBusyId] = useState<string | null>(null);
  const [inboxMessages, setInboxMessages] = useState<AdminInboxMessage[]>([]);
  const [inboxEditingId, setInboxEditingId] = useState<string | null>(null);
  const [inboxSubject, setInboxSubject] = useState("");
  const [inboxBody, setInboxBody] = useState("");
  const [inboxCategory, setInboxCategory] = useState<AdminInboxMessage["category"]>("notice");
  const [inboxBusy, setInboxBusy] = useState(false);
  const [revealedPayouts, setRevealedPayouts] = useState<Record<string, { accountName: string; account: string }>>({});
  const [financeBusyId, setFinanceBusyId] = useState<string | null>(null);
  const [userAnalytics, setUserAnalytics] = useState<UserAnalyticsData | null>(null);
  const [siteAnalytics, setSiteAnalytics] = useState<SiteAnalyticsData | null>(null);
  const [userKeyword, setUserKeyword] = useState("");
  const [userListBusy, setUserListBusy] = useState(false);
  const [creditAdjustTarget, setCreditAdjustTarget] = useState<UserAnalyticsData["users"][number] | null>(null);
  const [creditAdjustAmount, setCreditAdjustAmount] = useState("");
  const [creditAdjustReason, setCreditAdjustReason] = useState("");
  const [creditAdjustBusy, setCreditAdjustBusy] = useState(false);
  const [serverHealth, setServerHealth] = useState<ServerHealthData | null>(null);
  const [serverHealthError, setServerHealthError] = useState<string | null>(null);
  const [serverHealthBusy, setServerHealthBusy] = useState(false);
  const [serverHealthHistory, setServerHealthHistory] = useState<{ time: string; cpu: number; memory: number; disk: number }[]>([]);

  const fetchServerHealth = async () => {
    setServerHealthBusy(true);
    try {
      const response = await fetch("/api/v1/admin/server-health", { credentials: "include", cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || `服务器状态读取失败（HTTP ${response.status}）`);
      const data = payload as ServerHealthData;
      setServerHealth(data);
      setServerHealthError(null);
      if (data.cpu.usagePercent !== null) {
        setServerHealthHistory((current) => [...current.slice(-23), {
          time: data.sampledAt,
          cpu: data.cpu.usagePercent ?? 0,
          memory: data.memory.usedPercent,
          disk: data.disk?.usedPercent ?? 0,
        }]);
      }
    } catch (error) {
      setServerHealthError(error instanceof Error ? error.message : "服务器状态暂不可用");
    } finally {
      setServerHealthBusy(false);
    }
  };

  const fetchPricingCatalog = async () => {
    try {
      const response = await fetch("/api/v1/admin/pricing", { credentials: "include", cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "Pricing read failed");
      setPricingCatalog(payload as AdminPricingCatalog);
    } catch (error) {
      setToastMessage(error instanceof Error ? error.message : "Pricing read failed");
    }
  };

  const saveStrikePrice = async (group: "members" | "boostPacks", plan: AdminPricingPlan) => {
    const strikeYuan = strikePriceDrafts[plan.id] ?? plan.strikeYuan;
    setStrikePriceSavingId(plan.id);
    try {
      const response = await fetch("/api/v1/admin/pricing", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group, id: plan.id, strikeYuan }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "Display price save failed");
      setPricingCatalog((current) => current ? { ...current, members: payload.members, boostPacks: payload.boostPacks } : current);
      setStrikePriceDrafts((current) => { const next = { ...current }; delete next[plan.id]; return next; });
      setToastMessage("Display price saved");
    } catch (error) { setToastMessage(error instanceof Error ? error.message : "Display price save failed"); }
    finally { setStrikePriceSavingId(null); }
  };

  const fetchInboxMessages = async () => {
    try {
      const [outboundResponse, inboundResponse] = await Promise.all([
        fetch("/api/v1/admin/inbox/messages", { credentials: "include", cache: "no-store" }),
        fetch("/api/v1/admin/support/messages?limit=100", { credentials: "include", cache: "no-store" }),
      ]);
      const outboundPayload = await outboundResponse.json().catch(() => ({}));
      if (!outboundResponse.ok) {
        setToastMessage(outboundPayload.error?.message || "已发布站内信读取失败");
        return;
      }
      setInboxMessages(outboundPayload.messages ?? []);
      const inboundPayload = await inboundResponse.json().catch(() => ({}));
      if (inboundResponse.ok) {
        setSupportMessages(inboundPayload.messages ?? []);
      } else {
        setToastMessage(inboundPayload.error?.message || "用户来信读取失败");
      }
    } catch (error) {
      setToastMessage(error instanceof Error ? error.message : "站内信读取失败，请检查网络后重试");
    }
  };

  const resetInboxEditor = () => {
    setInboxEditingId(null);
    setInboxSubject("");
    setInboxBody("");
    setInboxCategory("notice");
  };

  const editInboxMessage = (message: AdminInboxMessage) => {
    setInboxEditingId(message.id);
    setInboxSubject(message.subject);
    setInboxBody(message.body);
    setInboxCategory(message.category);
  };

  const saveInboxMessage = async (status: AdminInboxMessage["status"]) => {
    const subject = inboxSubject.trim();
    const body = inboxBody.trim();
    if (!subject || !body) { setToastMessage("请填写站内信标题和正文"); return; }
    setInboxBusy(true);
    try {
      const response = await fetch(inboxEditingId ? `/api/v1/admin/inbox/messages/${encodeURIComponent(inboxEditingId)}` : "/api/v1/admin/inbox/messages", {
        method: inboxEditingId ? "PUT" : "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject, body, category: inboxCategory, status }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "站内信保存失败");
      setToastMessage(status === "published" ? "站内信已发布" : "草稿已保存");
      resetInboxEditor();
      await fetchInboxMessages();
    } catch (error) {
      setToastMessage(error instanceof Error ? error.message : "站内信保存失败");
    } finally { setInboxBusy(false); }
  };

  const deleteInboxMessage = async (message: AdminInboxMessage) => {
    if (!window.confirm(`确定删除“${message.subject}”吗？删除后用户将无法查看。`)) return;
    setInboxBusy(true);
    try {
      const response = await fetch(`/api/v1/admin/inbox/messages/${encodeURIComponent(message.id)}`, { method: "DELETE", credentials: "include" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || "站内信删除失败");
      if (inboxEditingId === message.id) resetInboxEditor();
      setToastMessage("站内信已删除");
      await fetchInboxMessages();
    } catch (error) {
      setToastMessage(error instanceof Error ? error.message : "站内信删除失败");
    } finally { setInboxBusy(false); }
  };

  const fetchDashboardData = async () => {
    setLoading(true);
    try {
      const request = (url: string) =>
        fetch(url, { credentials: "include", cache: "no-store" }).catch(() => null);
      const [overviewRes, jobsRes, partnersRes, profilesRes, withdrawalsRes, supportMessagesRes, usersRes, siteAnalyticsRes] = await Promise.all([
        request("/api/v1/admin/overview"),
        request("/api/v1/admin/director-jobs"),
        request("/api/v1/admin/partners?limit=300"),
        request("/api/v1/admin/partner/profiles"),
        request("/api/v1/admin/partner/withdrawals?limit=100"),
        request("/api/v1/admin/support/messages?limit=100"),
        request("/api/v1/admin/users?limit=50"),
        request("/api/v1/admin/site-analytics?days=30"),
      ]);

      if (overviewRes?.ok) {
        const data = await overviewRes.json();
        setLoadedStats(data.stats);
        setDashboardError(null);
      } else {
        setLoadedStats(null);
        setDashboardError(!overviewRes
          ? "经营概览请求失败，请检查 API 服务和数据库连接。"
          : overviewRes.status === 401
            ? "管理员登录状态已失效，请重新登录后刷新管理数据。"
            : `经营概览接口暂不可用（HTTP ${overviewRes.status}），请检查数据库连接。`);
      }

      if (jobsRes?.ok) {
        const data = await jobsRes.json();
        setJobs(data.jobs);
        setCompensationAvailable(Boolean(data.compensationAvailable));
      } else {
        setJobs([]);
        setCompensationAvailable(false);
      }
      if (partnersRes?.ok) setCityPartners((await partnersRes.json()).partners ?? []);
      else setCityPartners([]);
      if (profilesRes?.ok) setPartnerProfiles((await profilesRes.json()).profiles ?? []);
      else setPartnerProfiles([]);
      if (withdrawalsRes?.ok) setPartnerWithdrawals((await withdrawalsRes.json()).withdrawals ?? []);
      else setPartnerWithdrawals([]);
      if (supportMessagesRes?.ok) setSupportMessages((await supportMessagesRes.json()).messages ?? []);
      else setSupportMessages([]);
      if (usersRes?.ok) setUserAnalytics(await usersRes.json());
      else setUserAnalytics(null);
      if (siteAnalyticsRes?.ok) setSiteAnalytics(await siteAnalyticsRes.json());
      else setSiteAnalytics(null);
    } catch (error) {
      setLoadedStats(null);
      setUserAnalytics(null);
      setSiteAnalytics(null);
      setDashboardError(error instanceof Error ? `数据连接失败：${error.message}` : "数据连接失败，当前展示完整空数据布局。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
    void fetchPricingCatalog();
    void fetchServerHealth();
    const healthTimer = window.setInterval(() => { void fetchServerHealth(); }, 15_000);
    return () => window.clearInterval(healthTimer);
  }, []);

  const searchUsers = async () => {
    setUserListBusy(true);
    try {
      const params = new URLSearchParams({ limit: "50", keyword: userKeyword.trim() });
      const response = await fetch(`/api/v1/admin/users?${params.toString()}`, { credentials: "include" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "用户列表读取失败");
      setUserAnalytics(payload);
    } catch (error) {
      setToastMessage(error instanceof Error ? error.message : "用户列表读取失败");
    } finally {
      setUserListBusy(false);
    }
  };

  const loadMoreUsers = async () => {
    if (!userAnalytics || userListBusy || userAnalytics.users.length >= userAnalytics.total) return;
    setUserListBusy(true);
    try {
      const params = new URLSearchParams({ limit: "50", offset: String(userAnalytics.users.length), keyword: userKeyword.trim() });
      const response = await fetch(`/api/v1/admin/users?${params.toString()}`, { credentials: "include" });
      const payload: UserAnalyticsData = await response.json();
      if (!response.ok) throw new Error("更多用户读取失败");
      setUserAnalytics((current) => current ? { ...payload, users: [...current.users, ...payload.users] } : payload);
    } catch (error) {
      setToastMessage(error instanceof Error ? error.message : "更多用户读取失败");
    } finally {
      setUserListBusy(false);
    }
  };

  const openCreditAdjustment = (user: UserAnalyticsData["users"][number]) => {
    setCreditAdjustAmount("");
    setCreditAdjustReason("");
    setCreditAdjustTarget(user);
  };

  const closeCreditAdjustment = () => {
    if (creditAdjustBusy) return;
    setCreditAdjustTarget(null);
  };

  const submitCreditAdjustment = async () => {
    const target = creditAdjustTarget;
    if (!target || creditAdjustBusy) return;
    const credits = Number(creditAdjustAmount.trim().replace(/^\+/, ""));
    if (!Number.isSafeInteger(credits) || credits === 0) {
      setToastMessage("调整数量必须是不为 0 的整数，例如 200 或 -200");
      return;
    }
    const reason = creditAdjustReason.trim();
    if (!reason) {
      setToastMessage("请填写调整备注，方便日后对账");
      return;
    }
    setCreditAdjustBusy(true);
    try {
      const response = await fetch(`/api/v1/admin/users/${target.id}/credits`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credits, reason }),
      });
      const payload = await response.json().catch(() => null) as { availableCredits?: number; error?: { message?: string } } | null;
      if (!response.ok) throw new Error(payload?.error?.message || "积分调整失败");
      setToastMessage(`已${credits > 0 ? "增加" : "扣减"} ${Math.abs(credits)} 积分，${target.displayName} 当前可用 ${payload?.availableCredits ?? "—"} 积分`);
      setCreditAdjustTarget(null);
      await searchUsers();
    } catch (error) {
      setToastMessage(error instanceof Error ? error.message : "积分调整失败");
    } finally {
      setCreditAdjustBusy(false);
    }
  };

  const handleCompensate = async (jobId: string) => {
    setCompensatingJobId(jobId);
    try {
      const res = await fetch(`/api/v1/admin/jobs/${jobId}/compensate`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credits: 200, reason: "管理员手动救火补单" }),
      });
      if (res.ok) {
        setToastMessage(`任务 ${jobId} 补偿 200 积分已成功下发至用户账号`);
      } else {
        const payload = await res.json().catch(() => ({}));
        setToastMessage(`补偿未执行：${payload.error?.message || "服务暂不可用"}`);
      }
    } catch {
      setToastMessage(`补偿操作网络异常`);
    } finally {
      setCompensatingJobId(null);
    }
  };

  const showPayoutDetails = async (userId: string, endpoint: string, key: string) => {
    try {
      const res = await fetch(endpoint, { credentials: "include" });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error?.message || "收款资料读取失败");
      const data = payload.profile ?? payload.payout;
      setRevealedPayouts((current) => ({ ...current, [key]: { accountName: data.accountName, account: data.account } }));
    } catch (error) {
      setToastMessage(error instanceof Error ? error.message : "收款资料读取失败");
    }
  };

  const reviewPayoutProfile = async (profile: PartnerPayoutProfile, status: "verified" | "rejected") => {
    const note = status === "rejected" ? window.prompt("请输入驳回原因")?.trim() ?? "" : "资料核验通过";
    if (status === "rejected" && !note) return;
    setFinanceBusyId(profile.userId);
    try {
      const res = await fetch(`/api/v1/admin/partner/profiles/${profile.userId}/verify`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, note }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error?.message || "资料审核失败");
      setToastMessage(status === "verified" ? "收款资料已审核通过" : "已驳回收款资料");
      await fetchDashboardData();
    } catch (error) { setToastMessage(error instanceof Error ? error.message : "审核失败"); }
    finally { setFinanceBusyId(null); }
  };

  const reviewWithdrawal = async (withdrawal: PartnerWithdrawal, status: "approved" | "rejected") => {
    const note = status === "rejected" ? window.prompt("请输入驳回原因")?.trim() ?? "" : "提现审核通过";
    if (status === "rejected" && !note) return;
    setFinanceBusyId(withdrawal.id);
    try {
      const res = await fetch(`/api/v1/admin/partner/withdrawals/${withdrawal.id}/review`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, note }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error?.message || "提现审核失败");
      setToastMessage(status === "approved" ? "提现已审核通过，请完成人工转账" : "提现申请已驳回");
      await fetchDashboardData();
    } catch (error) { setToastMessage(error instanceof Error ? error.message : "提现审核失败"); }
    finally { setFinanceBusyId(null); }
  };

  const recordManualRefund = async () => {
    const orderId = window.prompt("请输入已支付的简兮订单编号（PAY-...）")?.trim() ?? "";
    if (!orderId) return;
    const amountText = window.prompt("请输入已经实际退还给用户的金额（元，最多两位小数）")?.trim() ?? "";
    if (!amountText) return;
    const amountYuan = Number(amountText);
    if (!Number.isFinite(amountYuan) || amountYuan <= 0 || Math.abs(Math.round(amountYuan * 100) - amountYuan * 100) > 0.000001) { setToastMessage("退款金额格式无效"); return; }
    const externalReference = window.prompt("请输入人工退款凭证号（必填，用于防止重复登记）")?.trim() ?? "";
    const note = window.prompt("请填写人工退款说明（必填）")?.trim() ?? "";
    if (externalReference.length < 4 || !note) return;
    if (!window.confirm("请确认这笔退款已经在支付宝等外部渠道实际完成。系统只登记退款金额，不会发起退款。")) return;
    setFinanceBusyId(orderId);
    try {
      const response = await fetch("/api/v1/admin/billing/orders/" + encodeURIComponent(orderId) + "/refunds", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountYuan, externalReference, note }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || "退款登记失败");
      setToastMessage("退款已登记 ¥" + amountYuan.toFixed(2) + "，该订单剩余计入收入 ¥" + Number(payload.remainingRevenueYuan || 0).toFixed(2));
      await fetchDashboardData();
    } catch (error) { setToastMessage(error instanceof Error ? error.message : "退款登记失败"); }
    finally { setFinanceBusyId(null); }
  };

  const markWithdrawalPaid = async (withdrawal: PartnerWithdrawal) => {
    if (!window.confirm(`请先确认已通过企业支付宝向收款人转账 ¥${withdrawal.netAmountYuan.toFixed(2)}。只有实际到账后才能登记已打款。`)) return;
    const externalReference = window.prompt("请输入支付宝转账流水号或凭证编号")?.trim() ?? "";
    if (externalReference.length < 4) return;
    setFinanceBusyId(withdrawal.id);
    try {
      const res = await fetch(`/api/v1/admin/partner/withdrawals/${withdrawal.id}/paid`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalReference, note: "人工转账完成并核对到账" }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error?.message || "打款登记失败");
      setToastMessage("已登记打款完成");
      await fetchDashboardData();
    } catch (error) { setToastMessage(error instanceof Error ? error.message : "打款登记失败"); }
    finally { setFinanceBusyId(null); }
  };

  const markWithdrawalFailed = async (withdrawal: PartnerWithdrawal) => {
    const note = window.prompt("请输入打款失败原因")?.trim() ?? "";
    if (!note) return;
    setFinanceBusyId(withdrawal.id);
    try {
      const res = await fetch(`/api/v1/admin/partner/withdrawals/${withdrawal.id}/failed`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error?.message || "失败状态登记失败");
      setToastMessage("已登记打款失败，金额已释放回可提现余额");
      await fetchDashboardData();
    } catch (error) { setToastMessage(error instanceof Error ? error.message : "操作失败"); }
    finally { setFinanceBusyId(null); }
  };

  const replyToSupportMessage = async (message: SupportMessage) => {
    const content = (supportReplyDrafts[message.id] ?? "").trim();
    if (!content) { setToastMessage("请先填写回复内容"); return; }
    setSupportReplyBusyId(message.id);
    try {
      const response = await fetch("/api/v1/admin/support/messages/" + encodeURIComponent(message.id) + "/reply", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: content }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || "回复发送失败");
      setSupportReplyDrafts((current) => ({ ...current, [message.id]: "" }));
      setToastMessage("回复已发送，用户可在前台站内信中查看");
      await fetchInboxMessages();
    } catch (error) {
      setToastMessage(error instanceof Error ? error.message : "回复发送失败");
    } finally {
      setSupportReplyBusyId(null);
    }
  };

  const resolveSupportMessage = async (message: SupportMessage) => {
    setFinanceBusyId(message.id);
    try {
      const response = await fetch("/api/v1/admin/support/messages/" + encodeURIComponent(message.id) + "/resolve", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || "站内信处理状态更新失败");
      setToastMessage("已将站内信标记为处理完成");
      await fetchInboxMessages();
    } catch (error) {
      setToastMessage(error instanceof Error ? error.message : "站内信处理失败");
    } finally {
      setFinanceBusyId(null);
    }
  };
  // 接口无数据或暂不可用时仍渲染完整仪表盘；缺失数据统一明确标记，不以 0 冒充真实统计。
  const stats: AdminOverviewStats = loadedStats ?? {
    totalUsers: 0, todayRevenueYuan: 0, todayNewUsers: 0, todayCompletedJobs: 0, todayFailedJobs: 0, jobSuccessRate: 0,
    avgE2eDurationSec: 0, p50E2eDurationSec: 0, p90E2eDurationSec: 0, p99E2eDurationSec: 0,
    avgLlmDurationSec: 0, avgTtsDurationSec: 0, avgFfmpegDurationSec: 0, avgRendererDurationSec: 0,
    avgSceneScore: 0, sceneScoreDataAvailable: false, totalJobs: 0, failedJobs: 0,
    directorTelemetryAvailable: false, directorCalls: 0, primaryModelSuccessRate: 0,
    fallbackModelRate: 0, heuristicFallbackRate: 0, totalTokensUsed: 0, tokenUsageRecords: 0,
    totalTtsChars: 0, qualityCheckedJobs: 0, qualityPassedJobs: 0, qualityPassRate: 0,
    totalCostEstimateYuan: 0, variantHitRate: 0,
    revenueDataAvailable: false, costDataAvailable: false, databaseDataAvailable: false,
  };

  const statsUnavailableLabel = dashboardError?.includes("登录状态已失效") ? "请重新登录" : dashboardError ? "读取失败" : loading ? "读取中" : "未接入";
  const statsUnavailableHint = dashboardError?.includes("登录状态已失效") ? "管理员会话已失效" : dashboardError ? "接口读取失败" : "数据库未连接";

  const userTrend = userAnalytics?.trend ?? [];
  const getTrendPoints = (key: "registrations" | "completedJobs" | "revenueYuan") => {
    const values = userTrend.map((point) => Number(point[key]) || 0);
    const max = Math.max(1, ...values);
    return values.map((value, index) => {
      const x = userTrend.length <= 1 ? 450 : 18 + index * (864 / (userTrend.length - 1));
      const y = 176 - (value / max) * 142;
      return `${x},${y}`;
    }).join(" ");
  };
  const trendMax = Math.max(1, ...userTrend.map((point) => point.registrations));
  const trendPoints = getTrendPoints("registrations");
  const completedTrendPoints = getTrendPoints("completedJobs");
  const revenueTrendPoints = getTrendPoints("revenueYuan");
  const visibleUsers = (userAnalytics?.users ?? []).filter((user) => {
    const key = userKeyword.trim().toLowerCase();
    return !key || [user.id, user.displayName, user.contact, user.region].some((value) => value.toLowerCase().includes(key));
  });
  const maxProvinceUsers = Math.max(1, ...(userAnalytics?.regions ?? []).map((region) => region.users));

  const filteredJobs = jobs.filter((job) => {
    if (filterStatus !== "all") {
      const processingStatuses = ["rendering", "planning", "inspecting", "quality-check"];
      if (filterStatus === "rendering" ? !processingStatuses.includes(job.status) : job.status !== filterStatus) return false;
    }
    if (filterScene !== "all" && job.sceneType !== filterScene) return false;
    return true;
  });

  return (
    <div className="admin-overlay-wrapper">
      <div className="admin-console-container">
        {/* 顶部导航条 */}
        <header className="admin-header">
          <div className="admin-brand-group">
            <span className="admin-brand-badge">OPC</span>
            <div>
              <div className="admin-brand-title">JANSEE // 指挥中心</div>
              <div className="admin-brand-sub">AI 导演履约与一人公司运营控制台</div>
            </div>
          </div>
          <div className="admin-tabs">
            <button
              className={`admin-tab-btn ${activeTab === "overview" ? "active" : ""}`}
              onClick={() => setActiveTab("overview")}
            >
              CEO 经营总览
            </button>
            <button
              className={`admin-tab-btn ${activeTab === "users" ? "active" : ""}`}
              onClick={() => setActiveTab("users")}
            >
              用户运营
            </button>
            <button
              className={`admin-tab-btn ${activeTab === "server" ? "active" : ""}`}
              onClick={() => { setActiveTab("server"); void fetchServerHealth(); }}
            >
              服务器状态
            </button>
            <button
              className={`admin-tab-btn ${activeTab === "director-jobs" ? "active" : ""}`}
              onClick={() => setActiveTab("director-jobs")}
            >
              导演效能明细
            </button>
            <button
              className={`admin-tab-btn ${activeTab === "partner-finance" ? "active" : ""}`}
              onClick={() => setActiveTab("partner-finance")}
            >
              账务管理
            </button>
            <button className={"admin-tab-btn " + (activeTab === "pricing" ? "active" : "")} onClick={() => { setActiveTab("pricing"); void fetchPricingCatalog(); }}>{"\u4ef7\u683c\u7ba1\u7406"}</button>
            <button className={"admin-tab-btn " + (activeTab === "inbox" ? "active" : "")} onClick={() => { setActiveTab("inbox"); void fetchInboxMessages(); }}>站内信管理</button>
          </div>
          <div className="admin-header-actions">
            <button className="admin-icon-btn" onClick={fetchDashboardData} title="刷新数据" aria-label="刷新数据">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
            </button>
            <button className="admin-icon-btn close-btn" onClick={onClose} title="关闭控制台" aria-label="关闭控制台">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </header>

        {/* 核心指标卡片条 */}
        {(
          <section className="admin-metric-strip">
            <div className="admin-metric-card">
              <span className="metric-label">今日已支付净额</span>
              <span className="metric-value">{stats.revenueDataAvailable === false ? statsUnavailableLabel : `¥${stats.todayRevenueYuan.toFixed(2)}`}</span>
              <span className="metric-sub">{stats.databaseDataAvailable === false ? statsUnavailableHint : "OPCPAY 支付状态核验 · SKU下单价 − 已登记退款"}</span>
              <button className="admin-inline-link" onClick={() => void recordManualRefund()}>登记人工退款</button>
            </div>
            <div className="admin-metric-card highlight">
              <span className="metric-label">今日交付成片</span>
              <span className="metric-value">{stats.databaseDataAvailable === false ? statsUnavailableLabel : stats.todayCompletedJobs}</span>
              <span className="metric-sub">{stats.databaseDataAvailable === false ? statsUnavailableHint : `累计任务 ${stats.totalJobs} 单`}</span>
            </div>
            <div className="admin-metric-card">
              <span className="metric-label">出片成功率</span>
              <span className="metric-value">{stats.databaseDataAvailable === false ? statsUnavailableLabel : `${stats.jobSuccessRate}%`}</span>
              <span className="metric-sub">{stats.databaseDataAvailable === false ? statsUnavailableHint : `失败任务 ${stats.failedJobs} 单`}</span>
            </div>
            <div className="admin-metric-card">
              <span className="metric-label">平均交付耗时</span>
              <span className="metric-value">{stats.databaseDataAvailable === false ? statsUnavailableLabel : stats.avgE2eDurationSec > 0 ? `${stats.avgE2eDurationSec}s` : "暂无数据"}</span>
              <span className="metric-sub">{stats.databaseDataAvailable === false ? statsUnavailableHint : `P90 ${stats.p90E2eDurationSec > 0 ? `${stats.p90E2eDurationSec}s` : "—"}`}</span>
            </div>
            <div className="admin-metric-card">
              <span className="metric-label">累计用户</span>
              <span className="metric-value">{stats.databaseDataAvailable === false ? statsUnavailableLabel : stats.totalUsers.toLocaleString("zh-CN")}</span>
              <span className="metric-sub">{stats.databaseDataAvailable === false ? statsUnavailableHint : `今日新增 ${stats.todayNewUsers} 人`}</span>
            </div>
          </section>
        )}

        {/* 内容主体区域 */}
        <div className="admin-body">
          {activeTab === "pricing" && (
            <div className="overview-viewport admin-pricing-viewport">
              <section className="overview-card admin-pricing-hero">
                <div>
                  <span className="admin-eyebrow">JANSEE / COMMERCE CONTROL</span>
                  <h2>{"\u4ef7\u683c\u540c\u6b65"}</h2>
                  <p>OPCPAY 是唯一价格来源。你只需在 OPCPAY 修改售价，简兮会自动读取并更新前端与新订单报价。</p>
                  <div className="admin-pricing-sync-status">
                    <strong>{pricingCatalog?.sync?.status === "synced" ? "OPCPAY 已连接 · 价格同步正常" : pricingCatalog?.sync?.status === "error" ? "价格同步异常" : "等待首次同步"}</strong>
                    <span>{pricingCatalog?.sync?.lastSyncedAt ? `最近同步：${new Date(pricingCatalog.sync.lastSyncedAt).toLocaleString("zh-CN")}` : "尚无成功同步记录"}</span>
                    {pricingCatalog?.sync?.message && <small>{pricingCatalog.sync.message}</small>}
                  </div>
                </div>
              </section>
              {!pricingCatalog ? (
                <section className="overview-card"><p>{"\u6b63\u5728\u8bfb\u53d6\u4ef7\u683c\u914d\u7f6e..."}</p></section>
              ) : ([
                { key: "members" as const, title: "\u4f1a\u5458\u5957\u9910", items: pricingCatalog.members },
                { key: "boostPacks" as const, title: "\u7b97\u529b\u52a0\u6cb9\u5305", items: pricingCatalog.boostPacks },
              ]).map((group) => (
                <section className={`overview-card admin-pricing-section admin-pricing-section-${group.key}`} key={group.key}>
                  <div className="admin-pricing-section-head"><h3>{group.title}</h3><span>{group.items.length} {"\u4e2a\u5546\u54c1"}</span></div>
                  <div className="admin-pricing-table">
                    {group.items.map((plan) => (
                      <div className="admin-pricing-row" key={plan.id}>
                        <div className="admin-pricing-product"><strong>{plan.name}</strong><small>{plan.id}</small></div>
                        <div className="admin-pricing-current"><small>OPCPAY 当前售价</small><strong>¥{plan.priceYuan.toFixed(2)}</strong></div>
                        <div className="admin-pricing-current admin-pricing-display-price"><small>Display original price (editable)</small><input aria-label={`${plan.name} display original price`} inputMode="decimal" value={strikePriceDrafts[plan.id] ?? plan.strikeYuan.replace(/^\u00a5/, "")} onChange={(event) => setStrikePriceDrafts((current) => ({ ...current, [plan.id]: event.target.value }))} /><button type="button" disabled={strikePriceSavingId === plan.id || (strikePriceDrafts[plan.id] ?? plan.strikeYuan) === plan.strikeYuan} onClick={() => void saveStrikePrice(group.key, plan)}>{strikePriceSavingId === plan.id ? "Saving?" : "Save"}</button></div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
              <p className="admin-pricing-footnote">OPCPAY 改价后，前端会在下一次自动刷新时更新；新订单按最新价格创建。已创建订单保留原金额，若 OPCPAY 已调整对应 SKU 价格，旧订单支付会被安全拦截，需重新下单。</p>
            </div>
          )}
          {activeTab === "server" && (
            <div className="admin-server-viewport">
              <section className="admin-server-hero">
                <div>
                  <span className="admin-eyebrow">JANSEE / INFRASTRUCTURE MONITOR</span>
                  <h2>让每一项服务，都保持稳定运转。</h2>
                  <p>服务器资源、核心依赖与导演生产链路的实时健康状态。</p>
                </div>
                <div className="admin-server-live">
                  <i className={serverHealth ? "is-live" : "is-waiting"} />
                  <span>{serverHealth ? "监控已连接" : "等待连接"}</span>
                  <small>{serverHealth?.sampledAt ? new Date(serverHealth.sampledAt).toLocaleTimeString("zh-CN") + " 更新" : "尚无采样"}</small>
                  <button onClick={() => void fetchServerHealth()} disabled={serverHealthBusy}>{serverHealthBusy ? "刷新中…" : "立即刷新"}</button>
                </div>
              </section>

              {serverHealthError && <div className="admin-data-note" role="status">{serverHealthError}。请确认 API 服务已启动并且当前账号拥有管理员权限。</div>}

              <section className="admin-server-metrics">
                <article className="admin-server-metric">
                  <span>CPU 使用率</span>
                  <strong>{serverHealth?.cpu.usagePercent === null || serverHealth?.cpu.usagePercent === undefined ? "采样中" : serverHealth.cpu.usagePercent + "%"}</strong>
                  <div className="admin-server-meter"><i style={{ width: `${serverHealth?.cpu.usagePercent ?? 0}%` }} /></div>
                  <small>{serverHealth ? `${serverHealth.host.cpuCores} 核处理器 · 主机负载 ${serverHealth.cpu.loadAverage.map((v) => v.toFixed(2)).join(" / ")}` : "等待服务器数据"}</small>
                </article>
                <article className="admin-server-metric">
                  <span>内存占用</span>
                  <strong>{serverHealth ? serverHealth.memory.usedPercent + "%" : "—"}</strong>
                  <div className="admin-server-meter"><i style={{ width: `${serverHealth?.memory.usedPercent ?? 0}%` }} /></div>
                  <small>{serverHealth ? `${(serverHealth.memory.usedBytes / 1024 ** 3).toFixed(2)} GB / ${(serverHealth.memory.totalBytes / 1024 ** 3).toFixed(2)} GB · API 进程 ${(serverHealth.memory.processRssBytes / 1024 ** 2).toFixed(0)} MB` : "等待服务器数据"}</small>
                </article>
                <article className="admin-server-metric">
                  <span>磁盘使用率</span>
                  <strong>{serverHealth?.disk?.usedPercent == null ? "不可读取" : serverHealth.disk.usedPercent + "%"}</strong>
                  <div className="admin-server-meter"><i style={{ width: `${serverHealth?.disk?.usedPercent ?? 0}%` }} /></div>
                  <small>{serverHealth?.disk ? `${(serverHealth.disk.usedBytes / 1024 ** 3).toFixed(1)} GB 已用 · ${(serverHealth.disk.freeBytes / 1024 ** 3).toFixed(1)} GB 可用` : "磁盘统计暂不可用"}</small>
                </article>
                <article className="admin-server-metric">
                  <span>服务器运行时间</span>
                  <strong>{serverHealth ? `${Math.floor(serverHealth.host.uptimeSeconds / 86400)} 天` : "—"}</strong>
                  <div className="admin-server-uptime">{serverHealth ? `${Math.floor(serverHealth.host.uptimeSeconds % 86400 / 3600)} 小时 ${Math.floor(serverHealth.host.uptimeSeconds % 3600 / 60)} 分钟` : "等待服务器数据"}</div>
                  <small>{serverHealth ? `${serverHealth.host.platform} · ${serverHealth.host.architecture} · ${serverHealth.host.hostname}` : "主机信息"}</small>
                </article>
              </section>

              <section className="admin-server-panel">
                <div className="admin-server-panel-head"><div><span className="admin-eyebrow">RESOURCE TREND / LIVE SESSION</span><h3>资源使用趋势</h3><p>每 15 秒采集一次；页面打开期间保留最近 24 个采样点。</p></div><span className="admin-server-auto">自动刷新 · 15 秒</span></div>
                {serverHealthHistory.length >= 2 ? (
                  <div className="admin-server-chart">
                    <div className="admin-server-chart-legend"><span><i className="cpu" />CPU</span><span><i className="memory" />内存</span><span><i className="disk" />磁盘</span></div>
                    <svg viewBox="0 0 900 180" preserveAspectRatio="none" role="img" aria-label="服务器资源使用趋势">
                      <path d="M12 12 H888 M12 90 H888 M12 168 H888" stroke="#eceaf5" strokeDasharray="4 6" fill="none" />
                      <polyline points={serverHealthHistory.map((point, index) => `${12 + index * (876 / Math.max(1, serverHealthHistory.length - 1))},${168 - point.cpu * 1.56}`).join(" ")} fill="none" stroke="#766de0" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                      <polyline points={serverHealthHistory.map((point, index) => `${12 + index * (876 / Math.max(1, serverHealthHistory.length - 1))},${168 - point.memory * 1.56}`).join(" ")} fill="none" stroke="#39a68b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                      <polyline points={serverHealthHistory.map((point, index) => `${12 + index * (876 / Math.max(1, serverHealthHistory.length - 1))},${168 - point.disk * 1.56}`).join(" ")} fill="none" stroke="#d5a04c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <div className="admin-server-chart-axis"><span>最早采样</span><span>最近采样</span></div>
                  </div>
                ) : <div className="admin-server-chart-empty">正在积累采样数据。保持此页面打开约 30 秒，即可看到 CPU、内存和磁盘变化曲线。</div>}
              </section>

              <section className="admin-server-panel">
                <div className="admin-server-panel-head"><div><span className="admin-eyebrow">SERVICE HEALTH / DEPENDENCIES</span><h3>服务健康检查</h3><p>区分主机资源与具体依赖故障，不把单项服务异常误判成整台服务器宕机。</p></div></div>
                <div className="admin-server-services">
                  {([
                    ["api", "API 服务", "管理接口响应检查"],
                    ["database", "V4 数据库", "数据库连接与查询"],
                    ["worker", "成片任务 Worker", "后台任务执行进程"],
                    ["director", "AI 导演模型", "模型 API 配置状态"],
                    ["tts", "TTS 语音服务", "语音服务凭据配置"],
                    ["ffmpeg", "FFmpeg 引擎", "本机执行文件检测"],
                    ["media", "素材存储", "本地 / 云端存储初始化"],
                    ["payment", "OPCPAY 支付", "支付服务启动状态"],
                  ] as const).map(([key, title, subtitle]) => {
                    const service = serverHealth?.services[key];
                    const status = service?.status ?? "unknown";
                    const label = status === "healthy" ? "运行正常" : status === "configured" ? "已配置" : status === "not_configured" ? "未配置" : status === "unavailable" ? "不可用" : "待检测";
                    return <article className={`admin-server-service ${status}`} key={key}>
                      <div className="admin-server-service-top"><span className="admin-server-service-icon">{key === "database" ? "DB" : key === "worker" ? "WK" : key === "director" ? "AI" : key === "payment" ? "¥" : key === "ffmpeg" ? "FX" : key === "tts" ? "VO" : key === "media" ? "ST" : "API"}</span><span className={`admin-server-status ${status}`}>{label}</span></div>
                      <strong>{title}</strong><small>{subtitle}</small><p>{service?.detail ?? "等待后端健康检查数据"}</p>
                    </article>;
                  })}
                </div>
                <div className="admin-server-footnote">安全说明：此监控接口仅管理员登录后可访问；不会返回环境变量、密钥、数据库连接串或原始用户 IP。导演与 TTS 显示配置状态，不会为了监控而发起计费调用。</div>
              </section>
            </div>
          )}
          {activeTab === "users" && (
            <div className="admin-users-viewport">
              <section className="admin-users-hero">
                <div>
                  <span className="admin-eyebrow">JANSEE / AUDIENCE INTELLIGENCE</span>
                  <h2>每一次注册，都是简兮向前的一步。</h2>
                  <p>看见用户从哪里来、何时加入，以及增长正在发生的方向。</p>
                </div>
                <div className="admin-users-total">
                  <span>COMMUNITY SIZE</span>
                  <strong>{userAnalytics ? userAnalytics.summary.totalUsers.toLocaleString("zh-CN") : "—"}</strong>
                  <small>累计注册用户</small>
                </div>
              </section>

              <section className="admin-user-kpis">
                <article><span>今日新朋友</span><strong>{userAnalytics?.summary.todayNewUsers ?? "—"}</strong><small>今天加入简兮的人</small></article>
                <article><span>近 7 天</span><strong>{userAnalytics?.summary.last7Days ?? "—"}</strong><small>最近一周新增用户</small></article>
                <article><span>近 30 天</span><strong>{userAnalytics?.summary.last30Days ?? "—"}</strong><small>最近一个月新增用户</small></article>
                <article><span>正常账号</span><strong>{userAnalytics?.summary.activeUsers ?? "—"}</strong><small>当前状态正常的账号</small></article>
              </section>

              <section className="admin-user-chart-card admin-site-analytics-card">
                <div className="admin-user-card-heading">
                  <div><span className="admin-eyebrow">SITE TRAFFIC / VERIFIED HUMAN VISITS</span><h3>网站真实访问</h3><p>来自 V2 真人访问聚合；不把爬虫、机房原始请求或 Nginx 请求量当作访客。</p></div>
                  <span className="admin-chart-legend">{siteAnalytics?.summary.days ?? 0} 天历史数据</span>
                </div>
                <div className="admin-user-kpis">
                  <article><span>真实浏览 PV</span><strong>{siteAnalytics ? siteAnalytics.summary.pv.toLocaleString("zh-CN") : "—"}</strong><small>通过 V2 访客过滤后的页面浏览</small></article>
                  <article><span>真实访客 UV</span><strong>{siteAnalytics ? siteAnalytics.summary.uv.toLocaleString("zh-CN") : "—"}</strong><small>按匿名访客标识去重</small></article>
                  <article><span>日均 PV</span><strong>{siteAnalytics?.summary.days ? Math.round(siteAnalytics.summary.pv / siteAnalytics.summary.days).toLocaleString("zh-CN") : "—"}</strong><small>按已导入的统计日期计算</small></article>
                  <article><span>访问来源</span><strong>{siteAnalytics ? Object.keys(siteAnalytics.dimensions.sources).length : "—"}</strong><small>搜索引擎、外部网站及直接访问</small></article>
                </div>
                <div className="admin-region-list">
                  <div className="admin-user-card-heading"><div><span className="admin-eyebrow">TRAFFIC SOURCES</span><h3>访客从哪里来</h3></div></div>
                  {siteAnalytics ? Object.entries(siteAnalytics.dimensions.sources).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([source, count]) => (
                    <div className="admin-region-row" key={source}>
                      <div className="admin-region-label"><strong>{source}</strong><span>{count} 次</span></div>
                      <div className="admin-region-track"><i style={{ width: `${Math.max(3, count / Math.max(1, ...Object.values(siteAnalytics.dimensions.sources)) * 100)}%` }} /></div>
                    </div>
                  )) : <div className="admin-users-empty">网站访问统计暂不可用。</div>}
                </div>
                <p className="admin-region-foot">{siteAnalytics?.note ?? "网站访问统计尚未载入。"}</p>
              </section>

              <section className="admin-user-chart-card">
                <div className="admin-user-card-heading">
                  <div><span className="admin-eyebrow">GROWTH / LAST 30 DAYS</span><h3>用户增长的轨迹</h3><p>每天新加入的用户，让增长被看见。</p></div>
                  <span className="admin-chart-legend"><i />每日新增</span>
                </div>
                {userAnalytics && userTrend.length > 0 ? (
                  <div className="admin-user-line-chart">
                    <div className="admin-chart-y-labels"><span>{trendMax}</span><span>{Math.round(trendMax / 2)}</span><span>0</span></div>
                    <svg viewBox="0 0 900 205" preserveAspectRatio="none" role="img" aria-label="最近30天用户注册趋势">
                      <defs><linearGradient id="userGrowthFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#8179e8" stopOpacity=".22" /><stop offset="100%" stopColor="#8179e8" stopOpacity="0" /></linearGradient></defs>
                      <path d="M18 176 H882 M18 105 H882 M18 34 H882" stroke="#e9e7f3" strokeDasharray="4 6" fill="none" />
                      <polygon points={`18,176 ${trendPoints} 882,176`} fill="url(#userGrowthFill)" />
                      <polyline points={trendPoints} fill="none" stroke="#7169d7" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                      {userTrend.map((point, index) => {
                        const x = userTrend.length <= 1 ? 450 : 18 + index * (864 / (userTrend.length - 1));
                        const y = 176 - (point.registrations / trendMax) * 142;
                        return <circle key={point.day} cx={x} cy={y} r="3" fill="#7169d7" stroke="#fff" strokeWidth="2"><title>{point.day} · 新增 {point.registrations} 人</title></circle>;
                      })}
                    </svg>
                    <div className="admin-chart-x-labels"><span>{userTrend[0]?.day ?? ""}</span><span>{userTrend[Math.floor(userTrend.length / 2)]?.day ?? ""}</span><span>{userTrend[userTrend.length - 1]?.day ?? ""}</span></div>
                  </div>
                ) : <div className="admin-users-empty">注册趋势数据暂不可用，连接用户数据库后会在这里呈现。</div>}
              </section>

              <div className="admin-user-insights-grid">
                <section className="admin-user-chart-card">
                  <div className="admin-user-card-heading"><div><span className="admin-eyebrow">WHERE USERS ARE</span><h3>用户所在的城市</h3><p>按注册时 IP 归属地统计，属于近似地域。</p></div><strong>{userAnalytics?.summary.geoUsers ?? "—"} <small>已识别</small></strong></div>
                  {userAnalytics?.regions.length ? <div className="admin-region-list">
                    {userAnalytics.regions.map((region) => <div className="admin-region-row" key={region.province}>
                      <div className="admin-region-label"><strong>{region.province}</strong><span>{region.users} 位用户</span></div>
                      <div className="admin-region-track"><i style={{width:`${Math.max(3, region.users / maxProvinceUsers * 100)}%`}} /></div>
                      <div className="admin-region-cities">{region.cities.slice(0, 5).map((city) => `${city.city} ${city.users}`).join("　·　")}</div>
                    </div>)}
                  </div> : <div className="admin-users-empty">暂时还没有可识别的省市记录。新用户注册后会自动按 IP 归属地记录；历史用户不会被猜测填充。</div>}
                  <div className="admin-region-foot">地区待识别：{userAnalytics?.summary.unknownRegionUsers ?? "—"} 人 · 识别依赖离线 IP 地理数据库</div>
                </section>

                <section className="admin-user-chart-card admin-user-region-summary">
                  <span className="admin-eyebrow">REGION COVERAGE</span>
                  <h3>地域覆盖</h3>
                  <strong>{userAnalytics ? (userAnalytics.summary.totalUsers ? Math.round(userAnalytics.summary.geoUsers / userAnalytics.summary.totalUsers * 100) : 0) : "—"}{userAnalytics ? "%" : ""}</strong>
                  <p>已识别注册地区的用户占比</p>
                  <div className="admin-region-coverage"><i style={{width:`${userAnalytics?.summary.totalUsers ? userAnalytics.summary.geoUsers / userAnalytics.summary.totalUsers * 100 : 0}%`}} /></div>
                  <small>地域定位为 IP 近似归属，不代表用户常住地。</small>
                </section>
              </div>

              <section className="admin-user-chart-card admin-user-table-card">
                <div className="admin-user-card-heading"><div><span className="admin-eyebrow">MEMBERS / DIRECTORY</span><h3>认识每一位用户</h3><p>最近注册的账号 · 共 {userAnalytics?.total ?? "—"} 位</p></div>
                  <div className="admin-user-search-actions"><input className="admin-user-search" value={userKeyword} onChange={(event) => setUserKeyword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void searchUsers(); }} placeholder="搜索昵称、账号、地区或 ID" /><button className="admin-user-search-button" disabled={userListBusy} onClick={searchUsers}>{userListBusy ? "读取中…" : "搜索用户"}</button></div>
                </div>
                <div className="admin-user-table-scroll">
                  <table className="admin-user-table"><thead><tr><th>用户</th><th>注册地区</th><th>加入时间</th><th>剩余积分</th><th>出片条数</th><th>下载条数</th><th>账号状态</th><th>操作</th></tr></thead>
                    <tbody>{visibleUsers.map((user) => <tr key={user.id}>
                      <td><strong>{user.displayName}</strong><small>{user.contact || user.id}</small></td>
                      <td>{user.region || "地区待识别"}</td>
                      <td>{new Date(user.createdAt).toLocaleString("zh-CN")}</td>
                      <td>{user.credits.toLocaleString("zh-CN")}</td>
                      <td>{user.completedJobs.toLocaleString("zh-CN")}</td>
                      <td>{user.downloads.toLocaleString("zh-CN")}</td>
                      <td><span className={`admin-user-status ${user.status === "active" ? "is-active" : "is-paused"}`}>{user.status === "active" ? "正常" : user.status === "suspended" ? "已停用" : user.status}</span></td>
                      <td><button className="admin-user-credit-btn" onClick={() => openCreditAdjustment(user)}>调整积分</button></td>
                    </tr>)}
                    {!visibleUsers.length && <tr><td colSpan={8} className="admin-users-empty">没有找到匹配的用户记录</td></tr>}</tbody>
                  </table>
                </div>
                <div className="admin-user-table-foot">当前展示 {userAnalytics?.users.length ?? 0} / {userAnalytics?.total ?? 0} 位匹配用户。联系方式已脱敏。</div>
                {userAnalytics && userAnalytics.users.length < userAnalytics.total && <button className="admin-load-more-users" disabled={userListBusy} onClick={loadMoreUsers}>{userListBusy ? "正在读取…" : "继续查看更早注册的用户"}</button>}
              </section>
            </div>
          )}

          {activeTab === "director-jobs" && (
            <div className="director-jobs-viewport">
              <section className="director-exec-summary" aria-label="导演交付经营指标">
                <div className="director-exec-summary-heading"><div><h2>导演交付效能</h2><p>只呈现交付结果与业务表现，不展示用户原始描述或系统内部指令</p></div></div>
                <div className="director-exec-metrics">
                  <div><span>累计任务</span><strong>{loadedStats ? loadedStats.totalJobs.toLocaleString("zh-CN") : "\u2014"}</strong></div>
                  <div><span>交付成功率</span><strong>{loadedStats ? loadedStats.jobSuccessRate.toFixed(1) + "%" : "\u2014"}</strong></div>
                  <div><span>平均交付耗时</span><strong>{loadedStats && loadedStats.avgE2eDurationSec > 0 ? loadedStats.avgE2eDurationSec.toFixed(1) + "s" : "\u2014"}</strong></div>
                  <div><span>今日成功交付</span><strong>{loadedStats ? loadedStats.todayCompletedJobs.toLocaleString("zh-CN") : "\u2014"}</strong></div>
                </div>
              </section>
              <div className="admin-filter-bar">
                <div className="filter-group"><span className="filter-title">交付状态</span>
                  {["all", "completed", "failed", "rendering"].map((status) => <button key={status} className={"filter-chip " + (filterStatus === status ? "active" : "")} onClick={() => setFilterStatus(status)}>{status === "all" ? "全部" : status === "completed" ? "已交付" : status === "failed" ? "交付失败" : "处理中"}</button>)}
                </div>
                <div className="filter-group"><span className="filter-title">业务场景</span>
                  {[
                    { value: "all", label: "全部场景" },
                    { value: "online-ecommerce", label: "线上电商" },
                    { value: "physical-store", label: "线下商家" },
                    { value: "personal-creation", label: "个人创作" },
                    { value: "未分类", label: "未分类" },
                  ].map((scene) => <button key={scene.value} className={"filter-chip " + (filterScene === scene.value ? "active" : "")} onClick={() => setFilterScene(scene.value)}>{scene.label}</button>)}
                </div>
              </div>
              <div className="job-insight-list director-delivery-list">
                {loading ? <div className="admin-empty-state">正在读取交付记录…</div> : filteredJobs.length === 0 ? <div className="admin-empty-state">暂无符合条件的交付记录</div> : filteredJobs.map((job) => {
                  const sceneLabel = job.sceneType === "online-ecommerce" ? "线上电商" : job.sceneType === "physical-store" ? "线下商家" : job.sceneType === "personal-creation" ? "个人创作" : "未分类";
                  const statusLabel = job.status === "completed" ? "已交付" : job.status === "failed" ? "交付失败" : ["rendering", "planning", "inspecting", "quality-check"].includes(job.status) ? "处理中" : "等待处理";
                  return <article className={"job-insight-card director-delivery-card " + job.status} key={job.jobId}>
                    <div className="director-delivery-main">
                      <div className="director-delivery-heading"><span className={"status-pill " + (job.status === "completed" ? "completed" : job.status === "failed" ? "failed" : "pending")}>{statusLabel}</span><strong>{sceneLabel}</strong></div>
                      <div className="director-delivery-meta"><span>任务编号 {job.jobId}</span><time>{new Date(job.createdAt).toLocaleString("zh-CN")}</time></div>
                    </div>
                    <div className="director-delivery-result"><span>交付耗时</span><strong>{job.e2eDurationMs > 0 ? (job.e2eDurationMs / 1000).toFixed(1) + "s" : "\u2014"}</strong></div>
                  {job.status === "failed" && <button className="compensate-btn" disabled={!compensationAvailable || compensatingJobId === job.jobId} onClick={() => handleCompensate(job.jobId)}>{compensatingJobId === job.jobId ? "处理中?" : compensationAvailable ? "一键补发 200 积分" : "补偿功能待账本接入"}</button>}
                  </article>;
                })}
              </div>
            </div>
          )}

          {activeTab === "partner-finance" && (
            <div className="overview-viewport partner-finance-viewport">
              <section className="overview-card">
                <h3>城市合伙人 · {cityPartners.length} 位已开通</h3>
                {loading ? <div className="admin-empty-state">正在加载合伙人名册…</div> : cityPartners.length === 0 ? <div className="admin-empty-state">暂无已开通城市合伙人</div> : cityPartners.map((partner) => (
                  <details className="partner-finance-collapse" key={partner.userId}>
                    <summary><strong>{partner.displayName} · {partner.province ?? ""}{partner.city ?? ""}</strong></summary>
                    <div className="partner-finance-collapse-content">
                      <article className="partner-finance-card">
                        <div className="partner-finance-card-head">
                          <div><strong>{partner.displayName} · {partner.province ?? ""}{partner.city ?? ""}</strong><span>{partner.contact} · 开通于 {new Date(partner.activatedAt).toLocaleDateString("zh-CN")}</span></div>
                          <span className="status-pill completed">城市合伙人</span>
                        </div>
                        <div className="partner-finance-amounts">
                          <span>一级邀请 {partner.directInvites} 人 · 二级邀请 {partner.secondLevelInvites} 人</span>
                          <span>待结算 ¥{partner.pendingCommissionYuan.toFixed(2)}</span>
                          <span>已结算 ¥{partner.settledCommissionYuan.toFixed(2)}</span>
                          <strong>可提现 ¥{partner.withdrawableYuan.toFixed(2)}</strong>
                        </div>
                        <div className="partner-finance-details">
                          收款资料：{partner.payoutVerificationStatus === "verified" ? "已核验" : partner.payoutVerificationStatus === "pending" ? "待审核" : partner.payoutVerificationStatus === "rejected" ? "已驳回" : "未绑定"}
                          {partner.payoutAccountLast4 ? ` · 支付宝尾号 ${partner.payoutAccountLast4}` : ""}
                        </div>
                      </article>
                    </div>
                  </details>
                ))}
              </section>
              <section className="overview-card">
                <h3>收款资料审核 · {partnerProfiles.length} 笔待审核</h3>
                {loading ? <div className="admin-empty-state">正在加载收款资料…</div> : partnerProfiles.length === 0 ? <div className="admin-empty-state">暂无待审核收款资料</div> : partnerProfiles.map((profile) => (
                  <article className="partner-finance-card" key={profile.userId}>
                    <div className="partner-finance-card-head">
                      <div><strong>{profile.displayName}</strong><span>{profile.contact} · {profile.province ?? ""}{profile.city ?? ""}</span></div>
                      <span className="status-pill pending">待审核 · 尾号 {profile.accountLast4}</span>
                    </div>
                    {revealedPayouts[profile.userId] && <div className="partner-finance-details">实名：{revealedPayouts[profile.userId]?.accountName}　账号：{revealedPayouts[profile.userId]?.account}</div>}
                    <div className="partner-finance-actions">
                      <button disabled={financeBusyId === profile.userId} onClick={() => showPayoutDetails(profile.userId, `/api/v1/admin/partner/profiles/${profile.userId}`, profile.userId)}>核验收款资料</button>
                      <button disabled={financeBusyId === profile.userId || !revealedPayouts[profile.userId]} onClick={() => reviewPayoutProfile(profile, "verified")}>审核通过</button>
                      <button disabled={financeBusyId === profile.userId} onClick={() => reviewPayoutProfile(profile, "rejected")}>驳回</button>
                    </div>
                  </article>
                ))}
              </section>
              <section className="overview-card">
                <h3>提现审核与打款 · {partnerWithdrawals.filter((item) => ["pending", "approved"].includes(item.status)).length} 笔待处理</h3>
                {loading ? <div className="admin-empty-state">正在加载提现记录…</div> : partnerWithdrawals.length === 0 ? <div className="admin-empty-state">暂无提现申请</div> : partnerWithdrawals.map((withdrawal) => (
                  <details className="partner-finance-collapse" key={withdrawal.id}>
                    <summary><strong>{withdrawal.displayName} · ¥{withdrawal.amountYuan.toFixed(2)}</strong></summary>
                    <div className="partner-finance-collapse-content">
                      <article className="partner-finance-card">
                        <div className="partner-finance-card-head">
                          <div><strong>{withdrawal.displayName} · ¥{withdrawal.amountYuan.toFixed(2)}</strong><span>{withdrawal.contact} · {withdrawal.createdAt ? new Date(withdrawal.createdAt).toLocaleString("zh-CN") : ""}</span></div>
                          <span className={`status-pill ${withdrawal.status === "paid" ? "completed" : withdrawal.status === "rejected" || withdrawal.status === "failed" ? "failed" : "pending"}`}>{withdrawal.status === "pending" ? "待审核" : withdrawal.status === "approved" ? "待打款" : withdrawal.status === "paid" ? "已打款" : withdrawal.status === "rejected" ? "已驳回" : "打款失败"}</span>
                        </div>
                        <div className="partner-finance-amounts">
                          <span>手续费 ¥{withdrawal.feeYuan.toFixed(2)}</span>
                          <strong>实际到账 ¥{withdrawal.netAmountYuan.toFixed(2)}</strong>
                          <span>支付宝尾号 {withdrawal.accountLast4 ?? "—"}</span>
                        </div>
                        {revealedPayouts[withdrawal.id] && <div className="partner-finance-details">收款人：{revealedPayouts[withdrawal.id]?.accountName}　账号：{revealedPayouts[withdrawal.id]?.account}</div>}
                        {withdrawal.note && <div className="partner-finance-details">处理备注：{withdrawal.note}</div>}
                        {withdrawal.externalReference && <div className="partner-finance-details">转账凭证：{withdrawal.externalReference}</div>}
                        <div className="partner-finance-actions">
                          {["pending", "approved"].includes(withdrawal.status) && <button disabled={financeBusyId === withdrawal.id} onClick={() => showPayoutDetails(withdrawal.userId, `/api/v1/admin/partner/withdrawals/${withdrawal.id}/payout`, withdrawal.id)}>查看收款账户</button>}
                          {withdrawal.status === "pending" && <>
                            <button disabled={financeBusyId === withdrawal.id} onClick={() => reviewWithdrawal(withdrawal, "approved")}>审核通过</button>
                            <button disabled={financeBusyId === withdrawal.id} onClick={() => reviewWithdrawal(withdrawal, "rejected")}>驳回申请</button>
                          </>}
                          {withdrawal.status === "approved" && <>
                            <button disabled={financeBusyId === withdrawal.id} onClick={() => markWithdrawalPaid(withdrawal)}>登记已打款</button>
                            <button disabled={financeBusyId === withdrawal.id} onClick={() => markWithdrawalFailed(withdrawal)}>登记打款失败</button>
                          </>}
                        </div>
                      </article>
                    </div>
                  </details>
                ))}
                <p className="partner-finance-disclaimer">打款由管理员在企业支付宝人工完成。只有核实实际到账后，才可登记“已打款”；本控制台不伪装自动出款。</p>
              </section>
            </div>
          )}

          {activeTab === "inbox" && (
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
          )}

          {activeTab === "overview" && (
            <div className="overview-viewport">
              {dashboardError && <div className="admin-data-note" role="status">{dashboardError}</div>}
              {loading && <div className="admin-data-note" role="status">正在读取经营数据，仪表盘布局已完整呈现…</div>}
              {!loadedStats && !loading && !dashboardError && <div className="admin-data-note" role="status">当前暂无经营数据，以下指标将在真实数据接入后自动显示。</div>}
              <section className="admin-dashboard-section">
                <div className="admin-section-heading">
                  <div>
                    <h2>经营概览</h2>
                    <p>今日经营结果与全量任务表现</p>
                  </div>
                  <span>数据来自当前 V4 数据库</span>
                </div>
                <div className="admin-dashboard-kpis">
                  <div className="admin-dashboard-kpi"><span>累计任务</span><strong>{stats.databaseDataAvailable === false ? statsUnavailableLabel : stats.totalJobs}</strong><small>已进入任务系统</small></div>
                  <div className="admin-dashboard-kpi"><span>今日完成</span><strong>{stats.databaseDataAvailable === false ? statsUnavailableLabel : stats.todayCompletedJobs}</strong><small>今日成功交付</small></div>
                  <div className="admin-dashboard-kpi"><span>出片成功率</span><strong>{stats.databaseDataAvailable === false ? statsUnavailableLabel : `${stats.jobSuccessRate}%`}</strong><small>完成 / 已结束任务</small></div>
                  <div className="admin-dashboard-kpi"><span>失败任务</span><strong>{stats.databaseDataAvailable === false ? statsUnavailableLabel : stats.failedJobs}</strong><small>可进入任务明细排查</small></div>
                </div>
              </section>


              <section className="admin-dashboard-section admin-user-growth-inline">
                <div className="admin-section-heading">
                  <div><h2>经营增长曲线</h2><p>注册、成片与实收收入 · 用真实趋势看见简兮的成长</p></div>
                  <button className="admin-inline-link" onClick={() => setActiveTab("users")}>查看用户与地域分析</button>
                </div>
                <div className="admin-user-chart-card">
                  <div className="admin-user-card-heading">
                    <div><span className="admin-eyebrow">COMMUNITY / 30 DAYS</span><h3>累计注册 {userAnalytics?.summary.totalUsers.toLocaleString("zh-CN") ?? "—"} 位</h3><p>今日新增 {userAnalytics?.summary.todayNewUsers ?? "—"} 位 · 近 7 天新增 {userAnalytics?.summary.last7Days ?? "—"} 位</p></div>
                    <span className="admin-chart-legend"><i />每日注册</span>
                  </div>
                  {userAnalytics && userTrend.length ? <div className="admin-user-line-chart">
                    <div className="admin-chart-y-labels"><span>{trendMax}</span><span>{Math.round(trendMax / 2)}</span><span>0</span></div>
                    <svg viewBox="0 0 900 205" preserveAspectRatio="none" role="img" aria-label="近30天注册趋势">
                      <defs><linearGradient id="overviewGrowthFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#8179e8" stopOpacity=".2" /><stop offset="100%" stopColor="#8179e8" stopOpacity="0" /></linearGradient></defs>
                      <path d="M18 176 H882 M18 105 H882 M18 34 H882" stroke="#e9e7f3" strokeDasharray="4 6" fill="none" />
                      <polygon points={`18,176 ${trendPoints} 882,176`} fill="url(#overviewGrowthFill)" />
                      <polyline points={trendPoints} fill="none" stroke="#7169d7" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <div className="admin-chart-x-labels"><span>{userTrend[0]?.day}</span><span>{userTrend[Math.floor(userTrend.length / 2)]?.day}</span><span>{userTrend[userTrend.length - 1]?.day}</span></div>
                  </div> : <div className="admin-users-empty">用户增长曲线将在数据库连接后显示。</div>}
                </div>

                {userAnalytics && userTrend.length > 0 && <div className="admin-trend-multiples">
                  <article className="admin-trend-mini">
                    <div><span className="admin-eyebrow">DELIVERED / 30 DAYS</span><strong>{userTrend.reduce((sum, point) => sum + point.completedJobs, 0).toLocaleString("zh-CN")}</strong><small>近 30 天完成成片</small></div>
                    <svg viewBox="0 0 900 205" preserveAspectRatio="none" role="img" aria-label="近30天完成成片趋势">
                      <path d="M18 176 H882 M18 105 H882 M18 34 H882" stroke="#e9e7f3" strokeDasharray="4 6" fill="none" />
                      <polyline points={completedTrendPoints} fill="none" stroke="#5e9cbb" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <div className="admin-chart-x-labels"><span>{userTrend[0]?.day}</span><span>{userTrend[Math.floor(userTrend.length / 2)]?.day}</span><span>{userTrend[userTrend.length - 1]?.day}</span></div>
                  </article>
                  <article className="admin-trend-mini">
                    <div><span className="admin-eyebrow">REVENUE / 30 DAYS</span><strong>¥{userTrend.reduce((sum, point) => sum + point.revenueYuan, 0).toFixed(2)}</strong><small>近 30 天已支付净额（按 SKU 价扣除退款）</small></div>
                    <svg viewBox="0 0 900 205" preserveAspectRatio="none" role="img" aria-label="近30天实收收入趋势">
                      <path d="M18 176 H882 M18 105 H882 M18 34 H882" stroke="#e9e7f3" strokeDasharray="4 6" fill="none" />
                      <polyline points={revenueTrendPoints} fill="none" stroke="#c49b62" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <div className="admin-chart-x-labels"><span>{userTrend[0]?.day}</span><span>{userTrend[Math.floor(userTrend.length / 2)]?.day}</span><span>{userTrend[userTrend.length - 1]?.day}</span></div>
                  </article>
                </div>}
              </section>

              <section className="admin-dashboard-section admin-visual-section">
                <div className="admin-section-heading">
                  <div><h2>经营数据图表</h2><p>以真实任务数据呈现交付质量与导演调用结构</p></div>
                  <span>仅展示已采集指标</span>
                </div>
                <div className="admin-visual-grid">
                  <article className="admin-visual-card admin-success-chart">
                    <div className="admin-visual-title">出片成功率</div>
                    <div className="admin-donut-wrap">
                      <svg viewBox="0 0 120 120" role="img" aria-label="出片成功率环形图">
                        <circle cx="60" cy="60" r="42" fill="none" stroke="#3b4147" strokeWidth="12" />
                        {stats.databaseDataAvailable !== false && stats.totalJobs > 0 && <circle cx="60" cy="60" r="42" fill="none" stroke="#d8dde2" strokeWidth="12" strokeLinecap="round" strokeDasharray={`${Math.max(0,Math.min(100,stats.jobSuccessRate))*2.6389} 263.89`} transform="rotate(-90 60 60)" />}
                        <text x="60" y="56" textAnchor="middle" className="admin-donut-value">{stats.databaseDataAvailable === false || stats.totalJobs === 0 ? "—" : `${stats.jobSuccessRate}%`}</text>
                        <text x="60" y="73" textAnchor="middle" className="admin-donut-caption">成功交付</text>
                      </svg>
                    </div>
                    <div className="admin-visual-foot">{stats.databaseDataAvailable === false ? statsUnavailableHint : stats.totalJobs > 0 ? `累计 ${stats.totalJobs} 项任务` : "等待首批任务数据"}</div>
                  </article>
                  <article className="admin-visual-card">
                    <div className="admin-visual-title">今日任务交付</div>
                    {stats.databaseDataAvailable === false || stats.totalJobs === 0 ? <div className="admin-chart-empty">暂无可绘制的任务数据</div> : <div className="admin-bar-chart">
                      <div className="admin-bar-row"><span>今日完成</span><div className="admin-bar-track"><i style={{width:(stats.todayCompletedJobs / Math.max(1,stats.todayCompletedJobs,stats.todayFailedJobs) * 100) + "%"}} /></div><b>{stats.todayCompletedJobs}</b></div>
                      <div className="admin-bar-row"><span>今日失败</span><div className="admin-bar-track"><i className="failed" style={{width:(stats.todayFailedJobs / Math.max(1,stats.todayCompletedJobs,stats.todayFailedJobs) * 100) + "%"}} /></div><b>{stats.todayFailedJobs}</b></div>
                    </div>}
                    <div className="admin-visual-foot">同一自然日内完成与失败的任务数量</div>
                  </article>
                  <article className="admin-visual-card">
                    <div className="admin-visual-title">导演模型调用路径</div>
                    {!stats.directorTelemetryAvailable ? <div className="admin-chart-empty">导演遥测数据尚未采集</div> : <div className="admin-route-chart">
                      <div className="admin-route-row"><div><span>主模型直连</span><b>{stats.primaryModelSuccessRate}%</b></div><div className="admin-route-track"><i style={{width:Math.max(0,Math.min(100,stats.primaryModelSuccessRate)) + "%"}} /></div></div>
                      <div className="admin-route-row"><div><span>备用模型接管</span><b>{stats.fallbackModelRate}%</b></div><div className="admin-route-track"><i style={{width:Math.max(0,Math.min(100,stats.fallbackModelRate)) + "%"}} /></div></div>
                      <div className="admin-route-row"><div><span>规则兜底</span><b>{stats.heuristicFallbackRate}%</b></div><div className="admin-route-track"><i style={{width:Math.max(0,Math.min(100,stats.heuristicFallbackRate)) + "%"}} /></div></div>
                    </div>}
                    <div className="admin-visual-foot">主模型 / 备用模型 / 规则兜底</div>
                  </article>
                </div>
              </section>

              <section className="admin-dashboard-section">
                <div className="admin-section-heading">
                  <div>
                    <h2>AI 导演效能</h2>
                    <p>耗时、尾部延迟与各制作阶段表现；耗时统计基于已完成任务</p>
                  </div>
                  <button className="admin-inline-link" onClick={() => setActiveTab("director-jobs")}>查看任务明细</button>
                </div>
                <div className="admin-performance-layout">
                  <div className="admin-performance-primary">
                    <span className="admin-data-label">端到端交付耗时 · 平均值</span>
                    <strong>{stats.avgE2eDurationSec > 0 ? `${stats.avgE2eDurationSec}s` : "暂无数据"}</strong>
                    <div className="admin-percentile-row">
                      <span>P50 <b>{stats.p50E2eDurationSec > 0 ? `${stats.p50E2eDurationSec}s` : "—"}</b></span>
                      <span>P90 <b>{stats.p90E2eDurationSec > 0 ? `${stats.p90E2eDurationSec}s` : "—"}</b></span>
                      <span>P99 <b>{stats.p99E2eDurationSec > 0 ? `${stats.p99E2eDurationSec}s` : "—"}</b></span>
                    </div>
                    <small>P50 表示一半任务不超过该耗时；P90/P99 用于观察慢任务尾部</small>
                  </div>
                  <div className="admin-stage-list">
                    <div className="admin-stage-row"><span>LLM 导演规划</span><strong>{stats.avgLlmDurationSec > 0 ? `${stats.avgLlmDurationSec}s` : "未采集"}</strong></div>
                    <div className="admin-stage-row"><span>TTS 人声合成</span><strong>{stats.avgTtsDurationSec > 0 ? `${stats.avgTtsDurationSec}s` : "未采集"}</strong></div>
                    <div className="admin-stage-row"><span>FFmpeg 独立耗时</span><strong>{stats.avgFfmpegDurationSec > 0 ? `${stats.avgFfmpegDurationSec}s` : "未单独采集"}</strong></div>
                  <div className="admin-stage-row"><span>渲染引擎总耗时（含内部步骤）</span><strong>{stats.avgRendererDurationSec > 0 ? `${stats.avgRendererDurationSec}s` : "未采集"}</strong></div>
                  </div>
                </div>
              </section>

              <section className="admin-dashboard-section">
                <div className="admin-section-heading">
                  <div>
                    <h2>模型命中与自动质检</h2>
                    <p>主模型直连、备用模型接管、规则兜底与成片质检；策略字段记录率不代表模型准确率</p>
                  </div>
                </div>
                <div className="admin-dashboard-kpis">
                  <div className="admin-dashboard-kpi"><span>主模型直连成功率</span><strong>{stats.directorTelemetryAvailable ? `${stats.primaryModelSuccessRate}%` : "未采集"}</strong><small>由主模型直接完成的调用</small></div>
                  <div className="admin-dashboard-kpi"><span>备用模型接管率</span><strong>{stats.directorTelemetryAvailable ? `${stats.fallbackModelRate}%` : "未采集"}</strong><small>主模型失败后备用模型完成</small></div>
                  <div className="admin-dashboard-kpi"><span>规则兜底率</span><strong>{stats.directorTelemetryAvailable ? `${stats.heuristicFallbackRate}%` : "未采集"}</strong><small>模型链路不可用时规则接管</small></div>
                  <div className="admin-dashboard-kpi"><span>自动质检通过率</span><strong>{stats.qualityCheckedJobs > 0 ? `${stats.qualityPassRate}%` : "未采集"}</strong><small>{stats.qualityPassedJobs} / {stats.qualityCheckedJobs} 个已质检任务</small></div>
                </div>
                <div className="admin-usage-strip">
                  <span>导演调用 {stats.directorCalls} 次</span>
                  <span>累计 Token {stats.tokenUsageRecords > 0 ? stats.totalTokensUsed.toLocaleString("zh-CN") : "供应商未返回"}</span>
                  <span>旁白字符 {stats.totalTtsChars.toLocaleString("zh-CN")}</span>
                </div>
              </section>

              <div className="overview-grid">
                <div className="overview-card">
                  <h3>导演决策记录</h3>
                  <div className="stat-row"><span>变体策略字段记录率</span><strong>{stats.variantHitRate}%</strong></div>
                  <div className="stat-row"><span>场景契合度均分</span><strong>{stats.sceneScoreDataAvailable ? `${stats.avgSceneScore} / 100` : "尚未接入真实评分"}</strong></div>
                  <p className="admin-data-note">变体策略指标反映方案字段是否写入，不等同于用户效果或模型准确率。场景评分只在真实评分埋点存在时展示。</p>
                </div>
                <div className="overview-card">
                  <h3>经营与成本</h3>
                  <div className="stat-row"><span>今日已支付净额</span><strong>{stats.revenueDataAvailable === false ? statsUnavailableLabel : `¥${stats.todayRevenueYuan.toFixed(2)}`}</strong></div>
                  <div className="stat-row"><span>今日导演模型成本估算</span><strong>{stats.costDataAvailable === false ? "未配置模型单价" : "¥" + stats.totalCostEstimateYuan.toFixed(4)}</strong></div>
                  <p className="admin-data-note">成本仅统计已配置单价的导演模型 Token，不包含 TTS、存储与带宽；不以不完整成本计算毛利。</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 吐司通知 */}
        {toastMessage && (
          <div className="admin-toast">
            <span>{toastMessage}</span>
          </div>
        )}

        {/* 管理员调整用户积分 */}
        {creditAdjustTarget && (
          <div className="admin-credit-dialog-backdrop" role="dialog" aria-modal="true" aria-label="调整用户积分" onClick={closeCreditAdjustment}>
            <div className="admin-credit-dialog" onClick={(event) => event.stopPropagation()}>
              <div className="admin-credit-dialog-head">
                <div>
                  <span className="admin-eyebrow">CREDITS / ADJUST</span>
                  <h3>调整用户积分</h3>
                </div>
                <strong>{creditAdjustTarget.displayName}</strong>
              </div>
              <p className="admin-credit-dialog-balance">当前可用积分 <strong>{creditAdjustTarget.credits.toLocaleString("zh-CN")}</strong>，调整后会立即生效并写入账本。</p>
              <label className="admin-credit-dialog-field">
                <span>调整数量（正数增加 · 负数扣减）</span>
                <input
                  type="number"
                  step="1"
                  value={creditAdjustAmount}
                  placeholder="例如 200 或 -200"
                  onChange={(event) => setCreditAdjustAmount(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void submitCreditAdjustment(); }}
                />
              </label>
              <label className="admin-credit-dialog-field">
                <span>调整备注（必填，写入账本）</span>
                <input
                  type="text"
                  maxLength={300}
                  value={creditAdjustReason}
                  placeholder="例如：客户投诉补偿 / 手工充值 / 误扣更正"
                  onChange={(event) => setCreditAdjustReason(event.target.value)}
                />
              </label>
              <div className="admin-credit-dialog-actions">
                <button type="button" className="admin-credit-cancel" disabled={creditAdjustBusy} onClick={closeCreditAdjustment}>取消</button>
                <button type="button" className="admin-credit-confirm" disabled={creditAdjustBusy} onClick={() => void submitCreditAdjustment()}>{creditAdjustBusy ? "提交中…" : "确认调整"}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

