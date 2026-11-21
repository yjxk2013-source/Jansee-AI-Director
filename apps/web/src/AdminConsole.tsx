import { useState, useEffect } from "react";
import type {
  AdminInboxMessage,
  AdminOverviewStats,
  AdminPricingCatalog,
  AdminPricingPlan,
  CityPartner,
  DirectorJobInsight,
  PartnerPayoutProfile,
  PartnerWithdrawal,
  ServerHealthData,
  SiteAnalyticsData,
  SupportMessage,
  UserAnalyticsData,
  AdminConsoleProps,
} from "./types/admin";
import { AdminMetricStrip } from "./components/admin/tabs/AdminMetricStrip";
import { AdminPricingTab } from "./components/admin/tabs/AdminPricingTab";
import { AdminServerTab } from "./components/admin/tabs/AdminServerTab";
import { AdminUsersTab } from "./components/admin/tabs/AdminUsersTab";
import { AdminDirectorJobsTab } from "./components/admin/tabs/AdminDirectorJobsTab";
import { AdminPartnerFinanceTab } from "./components/admin/tabs/AdminPartnerFinanceTab";
import { AdminInboxTab } from "./components/admin/tabs/AdminInboxTab";
import { AdminOverviewTab } from "./components/admin/tabs/AdminOverviewTab";


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


        {/* 核心指标卡片条 */}
        <AdminMetricStrip
          stats={stats}
          statsUnavailableLabel={statsUnavailableLabel}
          statsUnavailableHint={statsUnavailableHint}
          recordManualRefund={recordManualRefund}
        />

        {/* 内容主体区域 */}
        <div className="admin-body">
          {activeTab === "pricing" && (
            <AdminPricingTab
              pricingCatalog={pricingCatalog}
              strikePriceDrafts={strikePriceDrafts}
              setStrikePriceDrafts={setStrikePriceDrafts}
              strikePriceSavingId={strikePriceSavingId}
              saveStrikePrice={saveStrikePrice}
            />
          )}

          {activeTab === "server" && (
            <AdminServerTab
              serverHealth={serverHealth}
              serverHealthBusy={serverHealthBusy}
              serverHealthError={serverHealthError}
              serverHealthHistory={serverHealthHistory}
              fetchServerHealth={fetchServerHealth}
            />
          )}

          {activeTab === "users" && (
            <AdminUsersTab
              userAnalytics={userAnalytics}
              siteAnalytics={siteAnalytics}
              loading={loading}
              trendMax={trendMax}
              userTrend={userTrend}
              trendPoints={trendPoints}
              completedTrendPoints={completedTrendPoints}
              revenueTrendPoints={revenueTrendPoints}
              userKeyword={userKeyword}
              setUserKeyword={setUserKeyword}
              userListBusy={userListBusy}
              searchUsers={searchUsers}
              loadMoreUsers={loadMoreUsers}
              visibleUsers={visibleUsers}
              maxProvinceUsers={maxProvinceUsers}
              openCreditAdjustment={openCreditAdjustment}
            />
          )}

          {activeTab === "director-jobs" && (
            <AdminDirectorJobsTab
              loadedStats={loadedStats}
              loading={loading}
              filterStatus={filterStatus}
              setFilterStatus={setFilterStatus}
              filterScene={filterScene}
              setFilterScene={setFilterScene}
              filteredJobs={filteredJobs}
              compensationAvailable={compensationAvailable}
              compensatingJobId={compensatingJobId}
              handleCompensate={handleCompensate}
            />
          )}

          {activeTab === "partner-finance" && (
            <AdminPartnerFinanceTab
              cityPartners={cityPartners}
              partnerProfiles={partnerProfiles}
              partnerWithdrawals={partnerWithdrawals}
              loading={loading}
              revealedPayouts={revealedPayouts}
              financeBusyId={financeBusyId}
              showPayoutDetails={showPayoutDetails}
              reviewPayoutProfile={reviewPayoutProfile}
              reviewWithdrawal={reviewWithdrawal}
              markWithdrawalPaid={markWithdrawalPaid}
              markWithdrawalFailed={markWithdrawalFailed}
            />
          )}

          {activeTab === "inbox" && (
            <AdminInboxTab
              supportMessages={supportMessages}
              inboxMessages={inboxMessages}
              supportReplyDrafts={supportReplyDrafts}
              setSupportReplyDrafts={setSupportReplyDrafts}
              supportReplyBusyId={supportReplyBusyId}
              financeBusyId={financeBusyId}
              inboxSubject={inboxSubject}
              setInboxSubject={setInboxSubject}
              inboxCategory={inboxCategory}
              setInboxCategory={setInboxCategory}
              inboxBody={inboxBody}
              setInboxBody={setInboxBody}
              inboxBusy={inboxBusy}
              inboxEditingId={inboxEditingId}
              fetchInboxMessages={fetchInboxMessages}
              replyToSupportMessage={replyToSupportMessage}
              resolveSupportMessage={resolveSupportMessage}
              saveInboxMessage={saveInboxMessage}
              editInboxMessage={editInboxMessage}
              deleteInboxMessage={deleteInboxMessage}
              resetInboxEditor={resetInboxEditor}
            />
          )}

          {activeTab === "overview" && (
            <AdminOverviewTab
              stats={stats}
              loadedStats={loadedStats}
              loading={loading}
              dashboardError={dashboardError}
              statsUnavailableLabel={statsUnavailableLabel}
              statsUnavailableHint={statsUnavailableHint}
              userAnalytics={userAnalytics}
              userTrend={userTrend}
              trendMax={trendMax}
              trendPoints={trendPoints}
              completedTrendPoints={completedTrendPoints}
              revenueTrendPoints={revenueTrendPoints}
              setActiveTab={setActiveTab}
            />
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