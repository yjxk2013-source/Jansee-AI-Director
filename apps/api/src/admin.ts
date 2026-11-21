import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import * as os from "node:os";
import { recordAdminAnalyticsIp } from "./site-analytics.js";
import type { AuthStore } from "./auth.js";
import type { BillingStore } from "./billing.js";
import { authenticatedUser } from "./assets.js";
import { getPricingCatalog, saveDisplayStrikePrice } from "./pricing.js";
import {
  readCpuUsage,
  readMemoryUsage,
  inspectDiskUsage,
  testFfmpegExecutable,
  queryMediaStorageStats,
} from "./services/admin-metrics.js";
import {
  fetchPartnerDirectory,
  fetchWithdrawals,
  fetchWithdrawalPayoutDetail,
  fetchPartnerProfileDetail,
  reviewPartnerProfile,
  reviewWithdrawal,
  markWithdrawalPaid,
  markWithdrawalFailed,
} from "./services/admin-partner-service.js";
import {
  fetchAdminOverviewStats,
  fetchAdminUsersData,
  fetchDirectorJobsData,
} from "./services/admin-stats-service.js";

export interface DirectorJobInsight {
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

export interface AdminOverviewStats {
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
  revenueDataAvailable: boolean;
  costDataAvailable: boolean;
  databaseDataAvailable: boolean;
}

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

function maskAdminContact(phone: unknown, email: unknown): string {
  const cleanPhone = String(phone ?? "").trim();
  if (cleanPhone) return cleanPhone.length >= 7 ? `${cleanPhone.slice(0, 3)}****${cleanPhone.slice(-4)}` : cleanPhone;
  const cleanEmail = String(email ?? "").trim();
  if (!cleanEmail.includes("@")) return "";
  const [local, domain] = cleanEmail.split("@");
  return `${(local ?? "").slice(0, 2)}***@${domain ?? ""}`;
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

  app.get("/api/v1/admin/pricing", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "PRICING_STORAGE_UNAVAILABLE", message: "Pricing database unavailable" } });
    try {
      let pricing = await getPricingCatalog(options.pool);
      if (options.paymentProvider?.configured) {
        try { pricing = await options.paymentProvider.refreshPricingCatalog(true); } catch { /* show last persisted catalog and sync error below */ }
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
    if ((body.group !== "members" && body.group !== "boostPacks") || typeof body.id !== "string" || typeof body.strikeYuan !== "string") return reply.code(400).send({ error: { code: "INVALID_DISPLAY_PRICE", message: "Invalid display price request" } });
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

  app.get("/api/v1/admin/support/messages", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "SUPPORT_STORAGE_UNAVAILABLE", message: "站内信数据库暂不可用" } });
    const query = (request.query as { limit?: string; status?: string }) ?? {};
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 300);
    const status = ["unread", "read", "resolved"].includes(query.status ?? "") ? query.status : null;
    const result = await options.pool.query(
      "SELECT m.id, m.user_id, m.order_id, m.subject, m.message, m.status, m.created_at, u.display_name, u.phone, u.email FROM support_messages m JOIN users u ON u.id = m.user_id WHERE ($2::text IS NULL OR m.status = $2) ORDER BY CASE m.status WHEN 'unread' THEN 0 WHEN 'read' THEN 1 ELSE 2 END, m.created_at DESC LIMIT $1",
      [limit, status],
    );
    return reply.send({ messages: result.rows.map((row: any) => ({
      id: row.id, userId: row.user_id, orderId: row.order_id,
      displayName: row.display_name ?? "简兮用户",
      contact: maskAdminContact(row.phone, row.email),
      subject: row.subject, message: row.message, status: row.status,
      createdAt: row.created_at.toISOString(),
    })) });
  });

  app.post("/api/v1/admin/support/messages/:messageId/reply", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "SUPPORT_STORAGE_UNAVAILABLE", message: "站内信数据库暂不可用" } });
    const { messageId } = request.params as { messageId: string };
    if (!validUuid(messageId)) return reply.code(400).send({ error: { code: "INVALID_MESSAGE_ID", message: "来信编号无效" } });
    const body = (request.body ?? {}) as { message?: unknown };
    const content = typeof body.message === "string" ? body.message.trim() : "";
    if (!content || content.length > 4000) return reply.code(400).send({ error: { code: "INVALID_REPLY", message: "回复内容限 1–4000 字" } });
    const result = await options.pool.query(
      `WITH original AS (
         UPDATE support_messages
         SET status = CASE WHEN status = 'unread' THEN 'read' ELSE status END,
             read_at = COALESCE(read_at, now())
         WHERE id = $1
         RETURNING user_id, subject
       ),
       inserted AS (
         INSERT INTO site_inbox_messages
           (recipient_user_id, subject, body, category, status, created_by, published_at)
         SELECT user_id, left('回复：' || subject, 120), $2, 'notice', 'published', $3, now()
         FROM original
         RETURNING id
       )
       SELECT inserted.id FROM inserted`,
      [messageId, content, operator.id],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: { code: "SUPPORT_MESSAGE_NOT_FOUND", message: "用户来信不存在" } });
    return reply.code(201).send({ success: true, replyId: result.rows[0].id, messageId });
  });

  app.post("/api/v1/admin/support/messages/:messageId/resolve", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "SUPPORT_STORAGE_UNAVAILABLE", message: "站内信数据库暂不可用" } });
    const { messageId } = request.params as { messageId: string };
    const result = await options.pool.query(
      "UPDATE support_messages SET status = 'resolved', read_at = COALESCE(read_at, now()), resolved_at = now() WHERE id = $1 AND status <> 'resolved' RETURNING id",
      [messageId],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: { code: "SUPPORT_MESSAGE_NOT_FOUND", message: "站内信不存在或已处理" } });
    return reply.send({ success: true, messageId, operatorId: operator.id });
  });

  app.get("/api/v1/admin/inbox/messages", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "INBOX_STORAGE_UNAVAILABLE" } });
    const result = await options.pool.query(
      "SELECT id, subject, body, category, status, created_at, updated_at, published_at FROM site_inbox_messages WHERE recipient_user_id IS NULL ORDER BY updated_at DESC LIMIT 300",
    );
    return reply.send({ messages: result.rows.map((row) => ({
      id: row.id, subject: row.subject, body: row.body, category: row.category,
      status: row.status, createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(), publishedAt: row.published_at?.toISOString?.() ?? null,
    })) });
  });

  app.post("/api/v1/admin/inbox/messages", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "INBOX_STORAGE_UNAVAILABLE" } });
    const body = (request.body ?? {}) as { subject?: unknown; body?: unknown; category?: unknown; status?: unknown };
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const content = typeof body.body === "string" ? body.body.trim() : "";
    const category = ["welcome", "features", "notice"].includes(String(body.category)) ? String(body.category) : "notice";
    const status = ["draft", "published"].includes(String(body.status)) ? String(body.status) : "draft";
    if (!subject || subject.length > 120 || !content || content.length > 4000) {
      return reply.code(400).send({ error: { code: "INVALID_INBOX_MESSAGE", message: "标题限 1–120 字，正文限 1–4000 字" } });
    }
    const result = await options.pool.query(
      `INSERT INTO site_inbox_messages (subject, body, category, status, created_by, published_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = 'published' THEN now() ELSE NULL END)
       RETURNING id, subject, body, category, status, created_at, updated_at, published_at`,
      [subject, content, category, status, operator.id],
    );
    return reply.code(201).send({ message: result.rows[0] });
  });

  app.put("/api/v1/admin/inbox/messages/:messageId", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "INBOX_STORAGE_UNAVAILABLE" } });
    const { messageId } = request.params as { messageId: string };
    const body = (request.body ?? {}) as { subject?: unknown; body?: unknown; category?: unknown; status?: unknown };
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const content = typeof body.body === "string" ? body.body.trim() : "";
    const category = ["welcome", "features", "notice"].includes(String(body.category)) ? String(body.category) : "notice";
    const status = ["draft", "published"].includes(String(body.status)) ? String(body.status) : "draft";
    if (!validUuid(messageId) || !subject || subject.length > 120 || !content || content.length > 4000) {
      return reply.code(400).send({ error: { code: "INVALID_INBOX_MESSAGE", message: "站内信内容或编号无效" } });
    }
    const result = await options.pool.query(
      `UPDATE site_inbox_messages SET subject = $2, body = $3, category = $4, status = $5,
         updated_at = now(), published_at = CASE WHEN $5 = 'published' THEN COALESCE(published_at, now()) ELSE NULL END
       WHERE id = $1 RETURNING id, subject, body, category, status, created_at, updated_at, published_at`,
      [messageId, subject, content, category, status],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: { code: "MESSAGE_NOT_FOUND" } });
    return reply.send({ message: result.rows[0], operatorId: operator.id });
  });

  app.delete("/api/v1/admin/inbox/messages/:messageId", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "INBOX_STORAGE_UNAVAILABLE" } });
    const { messageId } = request.params as { messageId: string };
    if (!validUuid(messageId)) return reply.code(400).send({ error: { code: "INVALID_MESSAGE_ID" } });
    const result = await options.pool.query("DELETE FROM site_inbox_messages WHERE id = $1 RETURNING id", [messageId]);
    if (!result.rows[0]) return reply.code(404).send({ error: { code: "MESSAGE_NOT_FOUND" } });
    return reply.send({ success: true, messageId, operatorId: operator.id });
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
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
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
    const client = await options.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string; status: string; payment_provider: string | null; provider_payment_status: string; provider_price_yuan: string | number | null; amount_yuan: string | number; refunded_amount_yuan: string | number }>(
        "SELECT id, status, payment_provider, provider_payment_status, provider_price_yuan, amount_yuan, refunded_amount_yuan FROM billing_orders WHERE id = $1 FOR UPDATE", [orderId],
      );
      const order = result.rows[0];
      if (!order) { await client.query("ROLLBACK"); return reply.code(404).send({ error: { code: "ORDER_NOT_FOUND", message: "充值订单不存在" } }); }
      if (order.payment_provider !== "opcpay" || !["PAID", "REFUNDED"].includes(order.provider_payment_status) || !["paid", "refunded"].includes(order.status)) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "ORDER_NOT_CONFIRMED_PAID", message: "仅允许登记 OPCPAY 已核验支付的订单退款" } });
      }
      const gross = Number(order.provider_price_yuan ?? order.amount_yuan);
      const alreadyRefunded = Number(order.refunded_amount_yuan ?? 0);
      const remaining = Math.max(0, Number((gross - alreadyRefunded).toFixed(2)));
      if (amountYuan > remaining) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: { code: "REFUND_EXCEEDS_REMAINING", message: "本订单最多还可登记退款 ¥" + remaining.toFixed(2) } });
      }
      const duplicate = await client.query(
        "SELECT id FROM billing_order_refund_records WHERE source = 'manual' AND external_reference = $1 LIMIT 1",
        [externalReference],
      );
      if (duplicate.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "REFUND_REFERENCE_DUPLICATE", message: "该退款凭证已登记，禁止重复扣减收入" } });
      }
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO billing_order_refund_records (order_id, amount_yuan, source, external_reference, note, recorded_by) VALUES ($1, $2, 'manual', $3, $4, $5) RETURNING id",
        [orderId, amountYuan, externalReference, note, operator.id],
      );
      const updated = await client.query<{ refunded_amount_yuan: string | number; status: string }>(
        "UPDATE billing_orders SET refunded_amount_yuan = refunded_amount_yuan + $2, refunded_at = now(), status = CASE WHEN refunded_amount_yuan + $2 >= COALESCE(provider_price_yuan, amount_yuan) THEN 'refunded' ELSE status END WHERE id = $1 RETURNING refunded_amount_yuan, status", [orderId, amountYuan],
      );
      await client.query("COMMIT");
      return reply.send({ success: true, orderId, refundRecordId: inserted.rows[0]?.id, refundedAmountYuan: numeric(updated.rows[0]?.refunded_amount_yuan), remainingRevenueYuan: Math.max(0, Number((gross - numeric(updated.rows[0]?.refunded_amount_yuan)).toFixed(2))), orderStatus: updated.rows[0]?.status });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: { code: "REFUND_REFERENCE_DUPLICATE", message: "该退款凭证已登记，禁止重复扣减收入" } });
      }
      return reply.code(503).send({ error: { code: "REFUND_RECORD_FAILED", message: "退款登记失败，未确认写入，请刷新账务后重试" } });
    } finally { client.release(); }
  });

  app.get("/api/v1/admin/partners", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const query = (request.query as { limit?: string }) ?? {};
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 300);
    const partners = await fetchPartnerDirectory(options.pool, limit);
    return reply.send({ partners });
  });

  app.get("/api/v1/admin/partner/withdrawals", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const query = (request.query as { status?: string; limit?: string }) ?? {};
    const statuses = new Set(["pending", "approved", "paid", "rejected", "failed"]);
    const status = query.status && statuses.has(query.status) ? query.status : null;
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
    const withdrawals = await fetchWithdrawals(options.pool, status, limit);
    return reply.send({ withdrawals });
  });

  app.get("/api/v1/admin/partner/withdrawals/:withdrawalId/payout", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const { withdrawalId } = request.params as { withdrawalId: string };
    if (!validUuid(withdrawalId)) return reply.code(400).send({ error: { code: "INVALID_WITHDRAWAL_ID" } });
    try {
      const payout = await fetchWithdrawalPayoutDetail(options.pool, withdrawalId, operator.id);
      if (!payout) return reply.code(404).send({ error: { code: "WITHDRAWAL_NOT_FOUND" } });
      return reply.send({ payout });
    } catch {
      return reply.code(503).send({ error: { code: "PAYOUT_DECRYPTION_FAILED", message: "无法安全解密收款资料，请检查服务端密钥" } });
    }
  });

  app.get("/api/v1/admin/partner/profiles", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const result = await options.pool.query(`
      SELECT p.user_id, p.payout_channel, p.account_last4, p.verification_status, p.updated_at,
        u.display_name, u.phone, u.email, u.partner_province, u.partner_city
      FROM partner_payout_profiles p JOIN users u ON u.id = p.user_id
      WHERE p.verification_status = 'pending'
      ORDER BY p.updated_at ASC LIMIT 200
    `);
    return reply.send({ profiles: result.rows.map((row) => ({
      userId: row.user_id, channel: row.payout_channel, accountLast4: row.account_last4,
      displayName: row.display_name ?? "简兮用户",
      contact: row.phone ? `${row.phone.slice(0, 3)}****${row.phone.slice(-4)}` : row.email ?? "",
      province: row.partner_province, city: row.partner_city, updatedAt: row.updated_at.toISOString(),
    })) });
  });

  app.get("/api/v1/admin/partner/profiles/:userId", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const { userId } = request.params as { userId: string };
    if (!validUuid(userId)) return reply.code(400).send({ error: { code: "INVALID_USER_ID" } });
    try {
      const profile = await fetchPartnerProfileDetail(options.pool, userId, operator.id);
      if (!profile) return reply.code(404).send({ error: { code: "PAYOUT_PROFILE_NOT_FOUND" } });
      return reply.send({ profile });
    } catch {
      return reply.code(503).send({ error: { code: "PAYOUT_DECRYPTION_FAILED", message: "无法安全解密收款资料，请检查服务端密钥" } });
    }
  });

  app.post("/api/v1/admin/partner/profiles/:userId/verify", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const { userId } = request.params as { userId: string };
    const body = (request.body as { status?: string; note?: string } | undefined) ?? {};
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
    if (!validUuid(userId) || !["verified", "rejected"].includes(body.status ?? "") || (body.status === "rejected" && !note)) {
      return reply.code(400).send({ error: { code: "INVALID_PROFILE_REVIEW", message: "审核状态或驳回原因无效" } });
    }
    try {
      const res = await reviewPartnerProfile(options.pool, userId, body.status as "verified" | "rejected", note, operator.id);
      if (res.code === "NOT_FOUND") return reply.code(404).send({ error: { code: "PAYOUT_PROFILE_NOT_FOUND" } });
      if (res.code === "ALREADY_REVIEWED") return reply.code(409).send({ error: { code: "PROFILE_ALREADY_REVIEWED" } });
      return reply.send({ success: true, userId, status: body.status });
    } catch {
      return reply.code(503).send({ error: { code: "PROFILE_REVIEW_FAILED" } });
    }
  });

  app.post("/api/v1/admin/partner/withdrawals/:withdrawalId/review", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const { withdrawalId } = request.params as { withdrawalId: string };
    const body = (request.body as { status?: string; note?: string } | undefined) ?? {};
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
    if (!validUuid(withdrawalId) || !["approved", "rejected"].includes(body.status ?? "") || (body.status === "rejected" && !note)) {
      return reply.code(400).send({ error: { code: "INVALID_WITHDRAWAL_REVIEW", message: "审核状态或驳回原因无效" } });
    }
    try {
      const res = await reviewWithdrawal(options.pool, withdrawalId, body.status as "approved" | "rejected", note, operator.id);
      if (res.code === "NOT_FOUND") return reply.code(404).send({ error: { code: "WITHDRAWAL_NOT_FOUND" } });
      if (res.code === "NOT_PENDING") return reply.code(409).send({ error: { code: "WITHDRAWAL_NOT_PENDING" } });
      return reply.send({ success: true, withdrawalId, status: body.status });
    } catch {
      return reply.code(503).send({ error: { code: "WITHDRAWAL_REVIEW_FAILED" } });
    }
  });

  app.post("/api/v1/admin/partner/withdrawals/:withdrawalId/paid", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const { withdrawalId } = request.params as { withdrawalId: string };
    const body = (request.body as { externalReference?: string; note?: string } | undefined) ?? {};
    const reference = typeof body.externalReference === "string" ? body.externalReference.trim().slice(0, 160) : "";
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
    if (!validUuid(withdrawalId) || reference.length < 4) return reply.code(400).send({ error: { code: "INVALID_PAYMENT_REFERENCE", message: "请填写有效的企业支付宝转账流水号或凭证编号" } });
    try {
      const res = await markWithdrawalPaid(options.pool, withdrawalId, reference, note, operator.id);
      if (res.code === "NOT_FOUND") return reply.code(404).send({ error: { code: "WITHDRAWAL_NOT_FOUND" } });
      if (res.code === "NOT_APPROVED") return reply.code(409).send({ error: { code: "WITHDRAWAL_NOT_APPROVED" } });
      if (res.code === "REFERENCE_DUPLICATE") return reply.code(409).send({ error: { code: "PAYMENT_REFERENCE_ALREADY_USED", message: "该转账凭证已登记在其他提现记录中" } });
      return reply.send({ success: true, withdrawalId, status: "paid" });
    } catch {
      return reply.code(503).send({ error: { code: "WITHDRAWAL_PAYMENT_RECORD_FAILED" } });
    }
  });

  app.post("/api/v1/admin/partner/withdrawals/:withdrawalId/failed", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const { withdrawalId } = request.params as { withdrawalId: string };
    const body = (request.body as { note?: string } | undefined) ?? {};
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
    if (!validUuid(withdrawalId) || !note) return reply.code(400).send({ error: { code: "INVALID_FAILURE_NOTE", message: "请填写打款失败原因" } });
    try {
      const res = await markWithdrawalFailed(options.pool, withdrawalId, note, operator.id);
      if (res.code === "NOT_FOUND") return reply.code(404).send({ error: { code: "WITHDRAWAL_NOT_FOUND" } });
      if (res.code === "NOT_APPROVED") return reply.code(409).send({ error: { code: "WITHDRAWAL_NOT_APPROVED" } });
      return reply.send({ success: true, withdrawalId, status: "failed" });
    } catch {
      return reply.code(503).send({ error: { code: "WITHDRAWAL_FAILURE_RECORD_FAILED" } });
    }
  });
}
