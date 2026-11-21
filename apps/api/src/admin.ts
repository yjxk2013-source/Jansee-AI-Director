import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import * as os from "node:os";
import { recordAdminAnalyticsIp } from "./site-analytics.js";
import type { AuthStore } from "./auth.js";
import type { BillingStore } from "./billing.js";
import { authenticatedUser } from "./assets.js";
import { getPricingCatalog, saveDisplayStrikePrice } from "./pricing.js";
import type { DirectorJobInsight, AdminOverviewStats } from "./types/admin.js";
import {
  readCpuUsage,
  readMemoryUsage,
  inspectDiskUsage,
  testFfmpegExecutable,
  queryMediaStorageStats,
} from "./services/admin-metrics.js";
import {
  fetchAdminOverviewStats,
  fetchAdminUsersData,
  fetchDirectorJobsData,
} from "./services/admin-stats-service.js";
import { registerManualRefund } from "./services/admin-support-service.js";
import { registerAdminPartnerRoutes } from "./routes/admin-partner-routes.js";
import { registerAdminSupportRoutes } from "./routes/admin-support-routes.js";

export type { DirectorJobInsight, AdminOverviewStats };

export interface AdminRoutesOptions {
  authStore: AuthStore;
  pool?: Pool | undefined;
  billingStore?: BillingStore | undefined;
  paymentProvider?: {
    configured: boolean;
    refreshPricingCatalog(force?: boolean): Promise<{ members: any[]; boostPacks: any[] }>;
    pricingStatus: { status: string; source: string; lastSyncedAt: string | null; productName?: string; priceVersions?: Record<string, number>; message?: string };
  } | undefined;
  allowedOrigins: string[];
  allowedAdminEmails: string[];
  allowedAdminPhones?: string[];
  health?: {
    workerReady?: () => boolean;
    paymentReady?: () => boolean;
    directorConfigured?: boolean;
    ttsConfigured?: boolean;
    mediaConfigured?: boolean;
  };
}

const EMPTY_STATS: AdminOverviewStats = {
  totalUsers: 0,
  todayRevenueYuan: 0,
  todayNewUsers: 0,
  todayCompletedJobs: 0,
  todayFailedJobs: 0,
  jobSuccessRate: 0,
  avgE2eDurationSec: 0,
  p50E2eDurationSec: 0,
  p90E2eDurationSec: 0,
  p99E2eDurationSec: 0,
  avgLlmDurationSec: 0,
  avgTtsDurationSec: 0,
  avgFfmpegDurationSec: 0,
  avgRendererDurationSec: 0,
  avgSceneScore: 0,
  sceneScoreDataAvailable: false,
  totalJobs: 0,
  failedJobs: 0,
  directorTelemetryAvailable: false,
  directorCalls: 0,
  primaryModelSuccessRate: 0,
  fallbackModelRate: 0,
  heuristicFallbackRate: 0,
  totalTokensUsed: 0,
  tokenUsageRecords: 0,
  totalTtsChars: 0,
  qualityCheckedJobs: 0,
  qualityPassedJobs: 0,
  qualityPassRate: 0,
  totalCostEstimateYuan: 0,
  variantHitRate: 0,
  revenueDataAvailable: false,
  costDataAvailable: false,
  databaseDataAvailable: false,
};

function numeric(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

const validUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function registerAdminRoutes(app: FastifyInstance, options: AdminRoutesOptions): void {
  async function verifyAdminAuth(request: any, reply: any) {
    if (typeof request.headers.origin === "string" && !options.allowedOrigins.includes(request.headers.origin)) {
      reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
      return null;
    }
    const user = await authenticatedUser(request, options.authStore);
    if (!user) {
      reply.code(401).send({ error: { code: "ADMIN_AUTH_REQUIRED", message: "请先登录" } });
      return null;
    }
    const allowedByEmail = options.allowedAdminEmails.some((email) => email.toLowerCase() === user.email?.toLowerCase());
    const phone = String(user.phone ?? "").replace(/\D/g, "");
    const allowedByPhone = Boolean(phone) && (options.allowedAdminPhones ?? []).some((item) => item === phone);
    if (!allowedByEmail && !allowedByPhone) {
      reply.code(403).send({ error: { code: "ADMIN_FORBIDDEN", message: "当前账号没有管理员权限" } });
      return null;
    }
    recordAdminAnalyticsIp(request.ip);
    return user;
  }

  const requireAdminOrigin = (request: any, reply: any) => {
    if (typeof request.headers.origin !== "string" || !options.allowedOrigins.includes(request.headers.origin)) {
      reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
      return false;
    }
    return true;
  };

  // 1. 注册专属子领域路由：合伙人与工单支持
  registerAdminPartnerRoutes(app, { pool: options.pool, verifyAdminAuth, requireAdminOrigin });
  registerAdminSupportRoutes(app, { pool: options.pool, verifyAdminAuth, requireAdminOrigin });

  // 2. 定价与大盘展示
  app.get("/api/v1/admin/pricing", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "PRICING_STORAGE_UNAVAILABLE", message: "Pricing database unavailable" } });
    try {
      let pricing = await getPricingCatalog(options.pool);
      if (options.paymentProvider?.configured) {
        try { pricing = await options.paymentProvider.refreshPricingCatalog(true); } catch { /* show last persisted catalog */ }
      }
      return reply.send({ ...pricing, sync: options.paymentProvider?.pricingStatus ?? { status: "not_configured", source: "OPCPAY", lastSyncedAt: null } });
    } catch { return reply.code(503).send({ error: { code: "PRICING_READ_FAILED", message: "Could not read pricing" } }); }
  });

  app.post("/api/v1/admin/pricing", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "PRICING_STORAGE_UNAVAILABLE", message: "Pricing database unavailable" } });
    const body = (request.body as { group?: unknown; id?: unknown; strikeYuan?: unknown } | undefined) ?? {};
    if ((body.group !== "members" && body.group !== "boostPacks") || typeof body.id !== "string" || typeof body.strikeYuan !== "string") {
      return reply.code(400).send({ error: { code: "INVALID_DISPLAY_PRICE", message: "Invalid display price request" } });
    }
    try { return reply.send(await saveDisplayStrikePrice(options.pool, body.group, body.id, body.strikeYuan)); }
    catch (error) { return reply.code(400).send({ error: { code: "DISPLAY_PRICE_UPDATE_FAILED", message: error instanceof Error ? error.message : "Display price save failed" } }); }
  });

  app.get("/api/v1/admin/server-health", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;

    const [databaseHealthy, disk, ffmpeg, cpuUsage, memory, mediaStats] = await Promise.all([
      options.pool ? options.pool.query("SELECT 1").then(() => true).catch(() => false) : Promise.resolve(false),
      inspectDiskUsage(),
      testFfmpegExecutable(),
      readCpuUsage(),
      readMemoryUsage(),
      queryMediaStorageStats(options.pool),
    ]);
    const totalMemory = memory.totalBytes;
    const freeMemory = memory.freeBytes;
    const processMemory = process.memoryUsage();
    const workerHealthy = options.health?.workerReady?.() ?? false;
    const directorConfigured = options.health?.directorConfigured ?? false;
    const ttsConfigured = options.health?.ttsConfigured ?? false;
    const mediaConfigured = options.health?.mediaConfigured ?? false;
    const paymentHealthy = options.health?.paymentReady ?? false;

    return reply.send({
      sampledAt: new Date().toISOString(),
      host: { platform: os.platform(), architecture: os.arch(), hostname: os.hostname(), cpuCores: os.availableParallelism(), uptimeSeconds: Math.floor(os.uptime()) },
      cpu: { usagePercent: cpuUsage, loadAverage: os.loadavg() },
      memory: {
        totalBytes: totalMemory, freeBytes: freeMemory, usedBytes: totalMemory - freeMemory,
        usedPercent: Math.round((totalMemory - freeMemory) / totalMemory * 1000) / 10,
        processRssBytes: processMemory.rss, processHeapUsedBytes: processMemory.heapUsed,
      },
      disk,
      mediaStorage: mediaStats,
      services: {
        api: { status: "healthy", detail: "管理 API 正在响应" },
        database: { status: !options.pool ? "not_configured" : databaseHealthy ? "healthy" : "unavailable", detail: !options.pool ? "尚未配置 V4 数据库连接" : databaseHealthy ? "数据库连接正常" : "数据库连接失败" },
        worker: { status: workerHealthy ? "healthy" : "unavailable", detail: workerHealthy ? "成片任务 Worker 已启动" : "Worker 未启动；检查数据库、素材存储和渲染器配置" },
        director: { status: directorConfigured ? "configured" : "not_configured", detail: directorConfigured ? "导演模型 API 已配置（未执行外部推理探测）" : "导演模型 API 尚未配置" },
        tts: { status: ttsConfigured ? "configured" : "not_configured", detail: ttsConfigured ? "TTS 凭据已配置（未发起计费语音请求）" : "TTS 凭据尚未配置" },
        ffmpeg: { status: ffmpeg ? "healthy" : "unavailable", detail: ffmpeg ? "FFmpeg 可执行文件可用" : "当前运行环境未检测到 FFmpeg" },
        media: { status: mediaConfigured ? "configured" : "not_configured", detail: mediaConfigured ? "媒体存储已初始化" : "媒体存储尚未初始化" },
        payment: { status: paymentHealthy ? "healthy" : "unavailable", detail: paymentHealthy ? "支付服务已通过启动配置检查" : "支付服务尚未就绪" },
      },
    });
  });

  app.get("/api/v1/admin/site-analytics", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "SITE_ANALYTICS_UNAVAILABLE", message: "网站访问统计数据库暂不可用" } });
    const query = (request.query as { days?: string }) ?? {};
    const days = Math.min(Math.max(Number(query.days) || 30, 1), 90);
    const result = await options.pool.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, pv, uv, breakdown, source
       FROM site_daily_analytics
       WHERE day >= CURRENT_DATE - ($1::int - 1)
       ORDER BY day ASC`,
      [days],
    );
    const totals = result.rows.reduce((sum: any, row: any) => ({
      pv: sum.pv + numeric(row.pv),
      uv: sum.uv + numeric(row.uv),
    }), { pv: 0, uv: 0 });
    const dimensions = { pages: {} as Record<string, number>, sources: {} as Record<string, number>, regions: {} as Record<string, number>, devices: {} as Record<string, number>, browsers: {} as Record<string, number> };
    for (const row of result.rows) {
      const breakdown = row.breakdown ?? {};
      for (const key of Object.keys(dimensions) as (keyof typeof dimensions)[]) {
        for (const [label, count] of Object.entries((breakdown[key] ?? {}) as Record<string, unknown>)) {
          dimensions[key][label] = (dimensions[key][label] ?? 0) + numeric(count);
        }
      }
    }
    return reply.send({
      summary: { ...totals, days: result.rows.length },
      series: result.rows.map((row: any) => ({ day: row.day, pv: numeric(row.pv), uv: numeric(row.uv) })),
      dimensions,
      source: "v2-and-v4-human-verified-aggregate",
      note: "展示 V2 历史真人聚合与 V4 实时真人聚合；V4 采用 UA 爬虫识别、真人交互门禁、管理员动态 IP 与自测网络排除，不保存原始 IP/UA，不将 Nginx 原始请求计入访客。",
    });
  });

  app.get("/api/v1/admin/users", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "USER_ANALYTICS_UNAVAILABLE", message: "用户数据库未连接" } });
    const query = (request.query as { limit?: string; offset?: string; keyword?: string }) ?? {};
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const keyword = String(query.keyword ?? "").trim().slice(0, 80);

    const data = await fetchAdminUsersData(options.pool, limit, offset, keyword);
    return reply.send(data);
  });

  app.post("/api/v1/admin/users/:userId/credits", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "USER_ANALYTICS_UNAVAILABLE", message: "用户数据库未连接" } });
    if (!options.billingStore?.adjustCredits) return reply.code(503).send({ error: { code: "CREDIT_ADJUSTMENT_UNAVAILABLE", message: "积分账本暂不可用" } });
    const { userId } = request.params as { userId: string };
    if (!validUuid(userId)) return reply.code(400).send({ error: { code: "INVALID_USER_ID", message: "用户编号无效" } });
    const body = (request.body as { credits?: unknown; reason?: unknown } | undefined) ?? {};
    const credits = Number(body.credits);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!Number.isSafeInteger(credits) || credits === 0 || Math.abs(credits) > 1_000_000) {
      return reply.code(400).send({ error: { code: "INVALID_CREDIT_ADJUSTMENT", message: "调整数量必须是不为 0 的整数，单次上限 1,000,000" } });
    }
    if (!reason || reason.length > 300) return reply.code(400).send({ error: { code: "INVALID_ADJUSTMENT_REASON", message: "请填写 1–300 字的调整备注" } });
    const user = await options.pool.query("SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL", [userId]);
    if (!user.rows[0]) return reply.code(404).send({ error: { code: "USER_NOT_FOUND", message: "用户不存在" } });
    try {
      const wallet = await options.billingStore.adjustCredits(userId, credits, `管理员调整：${reason}`, operator.id);
      return reply.send({
        success: true, userId, credits,
        availableCredits: wallet.availableCredits, frozenCredits: wallet.frozenCredits,
      });
    } catch (error) {
      return reply.code(400).send({ error: { code: "CREDIT_ADJUSTMENT_FAILED", message: error instanceof Error ? error.message : "积分调整失败" } });
    }
  });

  app.get("/api/v1/admin/overview", async (request, reply) => {
    const user = await verifyAdminAuth(request, reply);
    if (!user) return;
    if (!options.pool) return reply.send({ stats: EMPTY_STATS });

    const stats = await fetchAdminOverviewStats(options.pool, EMPTY_STATS);
    return reply.send({ stats });
  });

  app.get("/api/v1/admin/director-jobs", async (request, reply) => {
    const user = await verifyAdminAuth(request, reply);
    if (!user) return;
    if (!options.pool) return reply.send({ jobs: [], total: 0, compensationAvailable: false });

    const query = (request.query as { status?: string; limit?: string; page?: string }) || {};
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
    const page = Math.max(Number(query.page) || 1, 1);
    const validStatuses = new Set(["queued", "inspecting", "planning", "rendering", "quality-check", "completed", "failed"]);
    const status = query.status && validStatuses.has(query.status) ? query.status : null;

    const data = await fetchDirectorJobsData(options.pool, status, limit, page);
    return reply.send({ jobs: data.jobs, total: data.total, compensationAvailable: Boolean(options.billingStore) });
  });

  app.post("/api/v1/admin/jobs/:jobId/compensate", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!options.pool || !options.billingStore) {
      return reply.code(503).send({ error: { code: "COMPENSATION_NOT_CONFIGURED", message: "积分账本尚未接入持久化存储，当前不能安全执行人工补偿" } });
    }
    const { jobId } = request.params as { jobId: string };
    if (!validUuid(jobId)) {
      return reply.code(400).send({ error: { code: "INVALID_JOB_ID", message: "任务 ID 格式无效" } });
    }
    const body = (request.body as { credits?: number; reason?: string } | undefined) ?? {};
    const credits = body.credits ?? 200;
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "管理员人工补偿";
    if (!Number.isSafeInteger(credits) || credits < 1 || credits > 10_000 || !reason) {
      return reply.code(400).send({ error: { code: "INVALID_COMPENSATION", message: "补偿积分或原因无效" } });
    }
    const job = await options.pool.query<{ user_id: string; status: string }>(
      "SELECT user_id, status FROM generation_jobs WHERE id = $1 LIMIT 1", [jobId],
    );
    if (!job.rows[0]) return reply.code(404).send({ error: { code: "JOB_NOT_FOUND", message: "任务不存在" } });
    if (job.rows[0].status !== "failed") return reply.code(409).send({ error: { code: "JOB_NOT_FAILED", message: "仅允许对失败任务执行人工补偿" } });
    const wallet = await options.billingStore.grantCredits(job.rows[0].user_id, credits, reason, jobId);
    return reply.send({
      success: true, jobId, compensatedCredits: credits, reason,
      operator: operator.id, wallet, timestamp: new Date().toISOString(),
    });
  });

  app.post("/api/v1/admin/billing/orders/:orderId/refunds", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "BILLING_UNAVAILABLE", message: "账务数据库未连接" } });
    const { orderId } = request.params as { orderId: string };
    if (!/^PAY-[A-Za-z0-9-]{8,90}$/.test(orderId)) return reply.code(400).send({ error: { code: "INVALID_ORDER_ID", message: "订单编号格式无效" } });
    const body = (request.body as { amountYuan?: number; note?: string; externalReference?: string } | undefined) ?? {};
    const amountYuan = Number(body.amountYuan);
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
    const externalReference = typeof body.externalReference === "string" ? body.externalReference.trim().slice(0, 160) : "";
    if (!Number.isFinite(amountYuan) || amountYuan <= 0 || Math.abs(Math.round(amountYuan * 100) - amountYuan * 100) > 0.000001 || !note || externalReference.length < 4) {
      return reply.code(400).send({ error: { code: "INVALID_REFUND_RECORD", message: "退款金额必须大于 0 且最多两位小数，并填写退款凭证号和人工退款说明" } });
    }
    const res = await registerManualRefund(options.pool, orderId, amountYuan, externalReference, note, operator.id);
    if (res.code === "ORDER_NOT_FOUND") return reply.code(404).send({ error: { code: "ORDER_NOT_FOUND", message: "充值订单不存在" } });
    if (res.code === "ORDER_NOT_CONFIRMED_PAID") return reply.code(409).send({ error: { code: "ORDER_NOT_CONFIRMED_PAID", message: "仅允许登记 OPCPAY 已核验支付的订单退款" } });
    if (res.code === "EXCEEDS_REMAINING") return reply.code(400).send({ error: { code: "REFUND_EXCEEDS_REMAINING", message: "本订单最多还可登记退款 ¥" + res.remaining.toFixed(2) } });
    if (res.code === "REFERENCE_DUPLICATE") return reply.code(409).send({ error: { code: "REFUND_REFERENCE_DUPLICATE", message: "该退款凭证已登记，禁止重复扣减收入" } });
    if (res.code === "FAILED") return reply.code(503).send({ error: { code: "REFUND_RECORD_FAILED", message: "退款登记失败，未确认写入，请刷新账务后重试" } });
    return reply.send({ success: true, orderId, refundRecordId: res.refundRecordId, refundedAmountYuan: res.refundedAmountYuan, remainingRevenueYuan: res.remainingRevenueYuan, orderStatus: res.orderStatus });
  });
}
