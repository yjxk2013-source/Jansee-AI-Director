import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import * as os from "node:os";
import { readFile, statfs } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { recordAdminAnalyticsIp } from "./site-analytics.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const bundledFfmpeg = require("ffmpeg-static") as string | null;
let previousCpuSample: { usageMicros: number; sampledAt: bigint } | undefined;
let previousHostCpuSample: { idle: number; total: number } | undefined;

async function readCpuUsage(): Promise<number | null> {
  try {
    const [cpuMax, cpuStat] = await Promise.all([
      readFile("/sys/fs/cgroup/cpu.max", "utf8"),
      readFile("/sys/fs/cgroup/cpu.stat", "utf8"),
    ]);
    const [quota = Number.NaN, period = Number.NaN] = cpuMax.trim().split(/\s+/).map(Number);
    const usageLine = cpuStat.split(/\r?\n/).find((line) => line.startsWith("usage_usec "));
    const usageMicros = Number(usageLine?.split(/\s+/)[1]);
    if (quota > 0 && period > 0 && Number.isFinite(usageMicros)) {
      const sampledAt = process.hrtime.bigint();
      const previous = previousCpuSample;
      previousCpuSample = { usageMicros, sampledAt };
      if (!previous || usageMicros < previous.usageMicros) return null;
      const elapsedMicros = Number(sampledAt - previous.sampledAt) / 1000;
      const allocatedCores = quota / period;
      if (elapsedMicros <= 0 || allocatedCores <= 0) return null;
      return Math.max(0, Math.min(100, Math.round((usageMicros - previous.usageMicros) / elapsedMicros / allocatedCores * 1000) / 10));
    }
  } catch {
    // Fall back to host CPU accounting when cgroup v2 metrics are unavailable.
  }
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  const previous = previousHostCpuSample;
  previousHostCpuSample = { idle, total };
  if (!previous || total <= previous.total) return null;
  return Math.max(0, Math.min(100, Math.round((1 - (idle - previous.idle) / (total - previous.total)) * 1000) / 10));
}

async function readMemoryUsage(): Promise<{ totalBytes: number; freeBytes: number; usedBytes: number; usedPercent: number }> {
  try {
    const [limitText, currentText] = await Promise.all([
      readFile("/sys/fs/cgroup/memory.max", "utf8"),
      readFile("/sys/fs/cgroup/memory.current", "utf8"),
    ]);
    const totalBytes = Number(limitText.trim());
    const usedBytes = Number(currentText.trim());
    if (Number.isFinite(totalBytes) && totalBytes > 0 && Number.isFinite(usedBytes)) {
      const boundedUsed = Math.min(usedBytes, totalBytes);
      return { totalBytes, usedBytes: boundedUsed, freeBytes: totalBytes - boundedUsed, usedPercent: Math.round(boundedUsed / totalBytes * 1000) / 10 };
    }
  } catch {
    // Fall back to host memory accounting when cgroup v2 metrics are unavailable.
  }
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  return { totalBytes, freeBytes, usedBytes, usedPercent: Math.round(usedBytes / totalBytes * 1000) / 10 };
}
import type { AuthStore } from "./auth.js";
import type { BillingStore } from "./billing.js";
import { authenticatedUser } from "./assets.js";
import { decryptPayoutValue } from "./growth-store.js";
import { getPricingCatalog, saveDisplayStrikePrice } from "./pricing.js";

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
  anchorHit: boolean;
  anchorName: string;
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
  anchorHitRate: number;
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
  anchorHitRate: 0,
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

    const [databaseHealthy, disk, ffmpeg, cpuUsage, memory] = await Promise.all([
      options.pool ? options.pool.query("SELECT 1").then(() => true).catch(() => false) : Promise.resolve(false),
      statfs(process.env.MEDIA_STORAGE_ROOT || process.cwd()).then((value) => {
        const totalBytes = Number(value.blocks) * Number(value.bsize);
        const freeBytes = Number(value.bavail) * Number(value.bsize);
        return { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes), usedPercent: totalBytes > 0 ? Math.round((totalBytes - freeBytes) / totalBytes * 1000) / 10 : null };
      }).catch(() => null),
      execFileAsync(bundledFfmpeg ?? "ffmpeg", ["-version"], { timeout: 2500, windowsHide: true }).then(() => true).catch(() => false),
      readCpuUsage(),
      readMemoryUsage(),
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
    const [summary, trend, regions, users] = await Promise.all([
      options.pool.query(`
        SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS total_users,
          count(*) FILTER (WHERE deleted_at IS NULL AND status = 'active')::int AS active_users,
          count(*) FILTER (WHERE deleted_at IS NULL AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'))::int AS today_new_users,
          count(*) FILTER (WHERE deleted_at IS NULL AND created_at >= now() - interval '7 days')::int AS last_7_days,
          count(*) FILTER (WHERE deleted_at IS NULL AND created_at >= now() - interval '30 days')::int AS last_30_days,
          count(*) FILTER (WHERE deleted_at IS NULL AND (register_province IS NOT NULL OR register_city IS NOT NULL))::int AS geo_users
        FROM users
      `),
      options.pool.query(`
        SELECT to_char(day, 'MM-DD') AS day,
          (SELECT count(*)::int FROM users u WHERE u.deleted_at IS NULL
            AND u.created_at >= (day AT TIME ZONE 'Asia/Shanghai')
            AND u.created_at < ((day + interval '1 day') AT TIME ZONE 'Asia/Shanghai')) AS registrations,
          (SELECT count(*)::int FROM generation_jobs j WHERE j.status = 'completed'
            AND j.finished_at >= (day AT TIME ZONE 'Asia/Shanghai')
            AND j.finished_at < ((day + interval '1 day') AT TIME ZONE 'Asia/Shanghai')) AS completed_jobs,
          (SELECT coalesce(sum(o.provider_price_yuan), 0) FROM billing_orders o
            WHERE o.payment_provider = 'opcpay' AND o.provider_payment_status IN ('PAID', 'REFUNDED')
              AND o.provider_paid_checked_at >= (day AT TIME ZONE 'Asia/Shanghai')
              AND o.provider_paid_checked_at < ((day + interval '1 day') AT TIME ZONE 'Asia/Shanghai'))
          - (SELECT coalesce(sum(r.amount_yuan), 0) FROM billing_order_refund_records r
            WHERE r.created_at >= (day AT TIME ZONE 'Asia/Shanghai')
              AND r.created_at < ((day + interval '1 day') AT TIME ZONE 'Asia/Shanghai')) AS revenue_yuan
        FROM generate_series(
          date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') - interval '29 days',
          date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai'), interval '1 day'
        ) day
        ORDER BY day
      `),
      options.pool.query(`
        SELECT coalesce(register_province, '地区待识别') AS province,
          sum(city_count)::int AS users,
          json_agg(json_build_object('city', coalesce(register_city, '未知城市'), 'users', city_count) ORDER BY city_count DESC) AS cities
        FROM (
          SELECT register_province, register_city, count(*)::int AS city_count
          FROM users WHERE deleted_at IS NULL AND (register_province IS NOT NULL OR register_city IS NOT NULL)
          GROUP BY register_province, register_city
        ) grouped
        GROUP BY register_province ORDER BY sum(city_count) DESC LIMIT 20
      `),
      options.pool.query(`
        SELECT u.id, u.display_name, u.email, u.phone, u.status, u.created_at, u.register_province, u.register_city, u.register_region,
          coalesce(w.available_credits, 0) AS credits,
          coalesce(j.completed_jobs, 0) AS completed_jobs,
          coalesce(o.download_total, 0) AS download_total
        FROM users u
          LEFT JOIN wallets w ON w.user_id = u.id
          LEFT JOIN (
            SELECT user_id, count(*)::int AS completed_jobs
            FROM generation_jobs WHERE status = 'completed' GROUP BY user_id
          ) j ON j.user_id = u.id
          LEFT JOIN (
            SELECT user_id, sum(download_count)::int AS download_total
            FROM generated_outputs WHERE deleted_at IS NULL GROUP BY user_id
          ) o ON o.user_id = u.id
        WHERE u.deleted_at IS NULL
          AND ($3 = '' OR u.id::text ILIKE '%' || $3 || '%' OR coalesce(u.display_name,'') ILIKE '%' || $3 || '%' OR coalesce(u.email,'') ILIKE '%' || $3 || '%' OR coalesce(u.phone,'') ILIKE '%' || $3 || '%' OR coalesce(u.register_region,'') ILIKE '%' || $3 || '%' OR coalesce(u.register_province,'') ILIKE '%' || $3 || '%' OR coalesce(u.register_city,'') ILIKE '%' || $3 || '%')
        ORDER BY u.created_at DESC LIMIT $1 OFFSET $2
      `, [limit, offset, keyword]),
    ]);
    const totals = summary.rows[0] ?? {};
    const countResult = await options.pool.query<{ total: string }>(
      "SELECT count(*)::text AS total FROM users WHERE deleted_at IS NULL AND ($1 = '' OR id::text ILIKE '%' || $1 || '%' OR coalesce(display_name,'') ILIKE '%' || $1 || '%' OR coalesce(email,'') ILIKE '%' || $1 || '%' OR coalesce(phone,'') ILIKE '%' || $1 || '%' OR coalesce(register_region,'') ILIKE '%' || $1 || '%' OR coalesce(register_province,'') ILIKE '%' || $1 || '%' OR coalesce(register_city,'') ILIKE '%' || $1 || '%')",
      [keyword],
    );
    return reply.send({
      summary: {
        totalUsers: numeric(totals.total_users), activeUsers: numeric(totals.active_users),
        todayNewUsers: numeric(totals.today_new_users), last7Days: numeric(totals.last_7_days),
        last30Days: numeric(totals.last_30_days), geoUsers: numeric(totals.geo_users),
        unknownRegionUsers: numeric(totals.total_users) - numeric(totals.geo_users),
      },
      trend: trend.rows.map((row) => ({ day: row.day, registrations: numeric(row.registrations), completedJobs: numeric(row.completed_jobs), revenueYuan: numeric(row.revenue_yuan) })),
      regions: regions.rows.map((row) => ({ province: row.province, users: numeric(row.users), cities: row.cities ?? [] })),
      users: users.rows.map((row) => ({
        id: row.id, displayName: row.display_name ?? "简兮用户",
        contact: maskAdminContact(row.phone, row.email),
        status: row.status, createdAt: row.created_at.toISOString(),
        province: row.register_province, city: row.register_city, region: row.register_region ?? "地区待识别",
        credits: numeric(row.credits), completedJobs: numeric(row.completed_jobs), downloads: numeric(row.download_total),
      })),
      total: numeric(countResult.rows[0]?.total), limit, offset,
      regionDataAvailable: numeric(totals.geo_users) > 0,
    });
  });

  app.get("/api/v1/admin/overview", async (request, reply) => {
    const user = await verifyAdminAuth(request, reply);
    if (!user) return;
    if (!options.pool) return reply.send({ stats: EMPTY_STATS });

    const result = await options.pool.query<{
      total_users: string | number;
      today_new_users: string | number;
      today_revenue_yuan: string | number;
      today_completed_jobs: string | number;
      today_failed_jobs: string | number;
      terminal_jobs: string | number;
      completed_jobs: string | number;
      total_jobs: string | number;
      failed_jobs: string | number;
      avg_e2e_ms: string | number | null;
      p50_e2e_ms: string | number | null;
      p90_e2e_ms: string | number | null;
      p99_e2e_ms: string | number | null;
      avg_llm_ms: string | number | null;
      avg_tts_ms: string | number | null;
      avg_ffmpeg_ms: string | number | null;
      avg_renderer_ms: string | number | null;
      avg_scene_score: string | number | null;
      scene_score_records: string | number;
      today_cost_estimate_yuan: string | number;
      today_cost_records: string | number;
      variant_hit_rate: string | number | null;
      anchor_hit_rate: string | number | null;
      director_calls: string | number;
      primary_model_successes: string | number;
      fallback_model_successes: string | number;
      heuristic_fallbacks: string | number;
      total_tokens_used: string | number;
      token_usage_records: string | number;
      total_tts_chars: string | number;
      quality_checked_jobs: string | number;
      quality_passed_jobs: string | number;
    }>(`
      SELECT
        (SELECT count(*) FROM users WHERE deleted_at IS NULL)::int AS total_users,
        (SELECT count(*) FROM users WHERE deleted_at IS NULL AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'))::int AS today_new_users,
        coalesce((SELECT sum(provider_price_yuan) FROM billing_orders
          WHERE payment_provider = 'opcpay' AND provider_payment_status IN ('PAID', 'REFUNDED')
            AND provider_paid_checked_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')), 0)
        - coalesce((SELECT sum(amount_yuan) FROM billing_order_refund_records
          WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')), 0) AS today_revenue_yuan,
        count(*) FILTER (WHERE status = 'completed' AND finished_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'))::int AS today_completed_jobs,
        count(*) FILTER (WHERE status = 'failed' AND finished_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'))::int AS today_failed_jobs,
        count(*) FILTER (WHERE status IN ('completed', 'failed'))::int AS terminal_jobs,
        count(*)::int AS total_jobs,
        count(*) FILTER (WHERE status = 'failed')::int AS failed_jobs,
        count(*) FILTER (WHERE status = 'completed')::int AS completed_jobs,
        avg(extract(epoch FROM (finished_at - queued_at)) * 1000) FILTER (WHERE status = 'completed' AND finished_at IS NOT NULL) AS avg_e2e_ms,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM (finished_at - queued_at)) * 1000)
          FILTER (WHERE status = 'completed' AND finished_at IS NOT NULL) AS p50_e2e_ms,
        percentile_cont(0.90) WITHIN GROUP (ORDER BY extract(epoch FROM (finished_at - queued_at)) * 1000)
          FILTER (WHERE status = 'completed' AND finished_at IS NOT NULL) AS p90_e2e_ms,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (finished_at - queued_at)) * 1000)
          FILTER (WHERE status = 'completed' AND finished_at IS NOT NULL) AS p99_e2e_ms,
        avg(CASE WHEN director_plan->'_telemetry'->>'llmDurationMs' ~ '^[0-9]+([.][0-9]+)?$'
          THEN NULLIF((director_plan->'_telemetry'->>'llmDurationMs')::numeric, 0) END)
          FILTER (WHERE status = 'completed') AS avg_llm_ms,
        avg(CASE WHEN director_plan->'_telemetry'->>'ttsDurationMs' ~ '^[0-9]+([.][0-9]+)?$'
          THEN NULLIF((director_plan->'_telemetry'->>'ttsDurationMs')::numeric, 0) END)
          FILTER (WHERE status = 'completed') AS avg_tts_ms,
        avg(CASE WHEN director_plan->'_telemetry'->>'ffmpegDurationMs' ~ '^[0-9]+([.][0-9]+)?$'
          THEN NULLIF((director_plan->'_telemetry'->>'ffmpegDurationMs')::numeric, 0) END)
          FILTER (WHERE status = 'completed') AS avg_ffmpeg_ms,
        avg(CASE WHEN director_plan->'_telemetry'->>'rendererDurationMs' ~ '^[0-9]+([.][0-9]+)?$'
          THEN NULLIF((director_plan->'_telemetry'->>'rendererDurationMs')::numeric, 0) END)
          FILTER (WHERE status = 'completed') AS avg_renderer_ms,
        avg(CASE WHEN director_plan->>'scene_score' ~ '^[0-9]+([.][0-9]+)?$'
          THEN (director_plan->>'scene_score')::numeric END) FILTER (WHERE status = 'completed') AS avg_scene_score,
        count(*) FILTER (WHERE status = 'completed' AND director_plan->>'scene_score' ~ '^[0-9]+([.][0-9]+)?$')::int AS scene_score_records,
        coalesce(sum(CASE WHEN director_plan->'_telemetry'->>'costEstimateYuan' ~ '^[0-9]+([.][0-9]+)?$'
          THEN (director_plan->'_telemetry'->>'costEstimateYuan')::numeric ELSE 0 END)
          FILTER (WHERE status = 'completed' AND finished_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')), 0) AS today_cost_estimate_yuan,
        count(*) FILTER (WHERE status = 'completed' AND finished_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')
          AND director_plan->'_telemetry'->>'costSource' = 'director_model_pricing')::int AS today_cost_records,
        (count(*) FILTER (WHERE director_plan ? 'variant_type')::numeric / NULLIF(count(*), 0) * 100) AS variant_hit_rate,
        (count(*) FILTER (WHERE director_plan->'_telemetry'->>'anchorHit' = 'true'
          OR (director_plan->'_telemetry'->>'anchorHit' IS NULL AND director_plan ? 'anchor'))::numeric / NULLIF(count(*), 0) * 100) AS anchor_hit_rate,
        count(*) FILTER (WHERE director_plan->'_telemetry'->>'providerMode' IN ('primary','fallback','heuristic'))::int AS director_calls,
        count(*) FILTER (WHERE director_plan->'_telemetry'->>'providerMode' = 'primary')::int AS primary_model_successes,
        count(*) FILTER (WHERE director_plan->'_telemetry'->>'providerMode' = 'fallback')::int AS fallback_model_successes,
        count(*) FILTER (WHERE director_plan->'_telemetry'->>'providerMode' = 'heuristic')::int AS heuristic_fallbacks,
        coalesce(sum(CASE WHEN director_plan->'_telemetry'->>'tokensUsed' ~ '^[0-9]+([.][0-9]+)?$'
          THEN (director_plan->'_telemetry'->>'tokensUsed')::numeric ELSE 0 END), 0) AS total_tokens_used,
        count(*) FILTER (WHERE director_plan->'_telemetry'->>'tokenUsageAvailable' = 'true')::int AS token_usage_records,
        coalesce(sum(CASE WHEN director_plan->'_telemetry'->>'ttsChars' ~ '^[0-9]+([.][0-9]+)?$'
          THEN (director_plan->'_telemetry'->>'ttsChars')::numeric ELSE 0 END), 0) AS total_tts_chars,
        count(*) FILTER (WHERE director_plan->'_telemetry'->>'qualityCheckCount' ~ '^[1-9][0-9]*$')::int AS quality_checked_jobs,
        count(*) FILTER (WHERE director_plan->'_telemetry'->>'qualityPassed' = 'true')::int AS quality_passed_jobs
      FROM generation_jobs
    `);

    const row = result.rows[0];
    if (!row) return reply.send({ stats: EMPTY_STATS });
    const terminal = numeric(row.terminal_jobs);
    return reply.send({
      stats: {
        ...EMPTY_STATS,
        databaseDataAvailable: true,
        totalUsers: numeric(row.total_users),
        todayNewUsers: numeric(row.today_new_users),
        todayRevenueYuan: numeric(row.today_revenue_yuan),
        revenueDataAvailable: true,
        todayCompletedJobs: numeric(row.today_completed_jobs),
        todayFailedJobs: numeric(row.today_failed_jobs),
        totalJobs: numeric(row.total_jobs),
        failedJobs: numeric(row.failed_jobs),
        directorCalls: numeric(row.director_calls),
        directorTelemetryAvailable: numeric(row.director_calls) > 0,
        primaryModelSuccessRate: numeric(row.director_calls) > 0 ? Number((numeric(row.primary_model_successes) / numeric(row.director_calls) * 100).toFixed(1)) : 0,
        fallbackModelRate: numeric(row.director_calls) > 0 ? Number((numeric(row.fallback_model_successes) / numeric(row.director_calls) * 100).toFixed(1)) : 0,
        heuristicFallbackRate: numeric(row.director_calls) > 0 ? Number((numeric(row.heuristic_fallbacks) / numeric(row.director_calls) * 100).toFixed(1)) : 0,
        totalTokensUsed: numeric(row.total_tokens_used),
        tokenUsageRecords: numeric(row.token_usage_records),
        totalTtsChars: numeric(row.total_tts_chars),
        qualityCheckedJobs: numeric(row.quality_checked_jobs),
        qualityPassedJobs: numeric(row.quality_passed_jobs),
        qualityPassRate: numeric(row.quality_checked_jobs) > 0 ? Number((numeric(row.quality_passed_jobs) / numeric(row.quality_checked_jobs) * 100).toFixed(1)) : 0,
        jobSuccessRate: terminal > 0 ? Number((numeric(row.completed_jobs) / terminal * 100).toFixed(1)) : 0,
        avgE2eDurationSec: Number((numeric(row.avg_e2e_ms) / 1000).toFixed(2)),
        p50E2eDurationSec: Number((numeric(row.p50_e2e_ms) / 1000).toFixed(2)),
        p90E2eDurationSec: Number((numeric(row.p90_e2e_ms) / 1000).toFixed(2)),
        p99E2eDurationSec: Number((numeric(row.p99_e2e_ms) / 1000).toFixed(2)),
        avgLlmDurationSec: Number((numeric(row.avg_llm_ms) / 1000).toFixed(2)),
        avgTtsDurationSec: Number((numeric(row.avg_tts_ms) / 1000).toFixed(2)),
        avgFfmpegDurationSec: Number((numeric(row.avg_ffmpeg_ms) / 1000).toFixed(2)),
        avgRendererDurationSec: Number((numeric(row.avg_renderer_ms) / 1000).toFixed(2)),
        avgSceneScore: Number(numeric(row.avg_scene_score).toFixed(1)),
        sceneScoreDataAvailable: numeric(row.scene_score_records) > 0,
        totalCostEstimateYuan: numeric(row.today_cost_estimate_yuan),
        costDataAvailable: numeric(row.today_cost_records) > 0,
        variantHitRate: Number(numeric(row.variant_hit_rate).toFixed(1)),
        anchorHitRate: Number(numeric(row.anchor_hit_rate).toFixed(1)),
      },
    });
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
    const result = await options.pool.query<{
      id: string; user_id: string; status: DirectorJobInsight["status"];
      aspect_ratio: string; created_at: Date; updated_at: Date; finished_at: Date | null;
      queued_at: Date; director_plan: Record<string, unknown> | null;
      credits_charged: string | number;
      error_code: string | null; error_message: string | null; total: string | number;
    }>(`
      SELECT j.id, j.user_id, j.status, j.aspect_ratio,
             j.created_at, j.updated_at, j.finished_at, j.queued_at, j.director_plan,
             coalesce((SELECT amount FROM billing_ledger l WHERE l.job_id = j.id AND l.type = 'settle' LIMIT 1), 0) AS credits_charged,
             j.error_code, j.error_message, count(*) OVER() AS total
      FROM generation_jobs j
      WHERE j.status <> 'cancelled' AND ($1::text IS NULL OR j.status = $1)
      ORDER BY j.created_at DESC
      LIMIT $2 OFFSET $3
    `, [status, limit, (page - 1) * limit]);

    const jobs: DirectorJobInsight[] = result.rows.map((row) => {
      const plan = row.director_plan ?? {};
      const telemetry = (plan._telemetry as Record<string, unknown> | undefined) ?? {};
      const variantType = typeof plan.variant_type === "string" ? plan.variant_type : "";
      const anchor = typeof plan.anchor === "string" ? plan.anchor : "";
      return {
        jobId: row.id,
        userId: row.user_id,
        status: row.status,
        aspectRatio: row.aspect_ratio,
        e2eDurationMs: numeric(telemetry.e2eDurationMs) || Math.max(0, ((row.finished_at ?? (["queued", "inspecting", "planning", "rendering", "quality-check"].includes(row.status) ? new Date() : row.updated_at)).getTime()) - row.queued_at.getTime()),
        llmDurationMs: numeric(telemetry.llmDurationMs),
        ffmpegDurationMs: numeric(telemetry.ffmpegDurationMs),
        rendererDurationMs: numeric(telemetry.rendererDurationMs),
        ttsDurationMs: numeric(telemetry.ttsDurationMs),
        variantDirectorHit: Boolean(variantType),
        variantType: variantType || "未记录",
        variantTemplate: typeof plan.variant_template === "string" ? plan.variant_template : "未记录",
        lockedVariant: typeof telemetry.lockedVariant === "string" ? telemetry.lockedVariant : "",
        variantMatched: typeof telemetry.variantMatched === "boolean" ? telemetry.variantMatched : null,
        anchorHit: typeof telemetry.anchorHit === "boolean" ? telemetry.anchorHit : Boolean(anchor),
        anchorName: anchor || "未记录",
        voiceId: typeof plan.voice_id === "string" ? plan.voice_id : "未记录",
        scene: typeof telemetry.scene === "string" ? telemetry.scene : "",
        sceneSource: typeof telemetry.sceneSource === "string" ? telemetry.sceneSource : "",
        sceneType: typeof telemetry.scene === "string" ? telemetry.scene : "未分类",
        sceneScore: numeric(plan.scene_score),
        sceneAlignmentReason: typeof plan.scene_alignment_reason === "string" ? plan.scene_alignment_reason : "尚未采集场景契合度数据",
        tokensUsed: numeric(telemetry.tokensUsed),
        ttsChars: numeric(telemetry.ttsChars),
        costEstimateYuan: numeric(telemetry.costEstimateYuan),
        tokenUsageAvailable: telemetry.tokenUsageAvailable === true,
        providerMode: typeof telemetry.providerMode === "string" ? telemetry.providerMode : "unreported",
        requestedModel: typeof telemetry.requestedModel === "string" ? telemetry.requestedModel : "",
        selectedModel: typeof telemetry.selectedModel === "string" ? telemetry.selectedModel : "",
        modelsAttempted: Array.isArray(telemetry.modelsAttempted) ? telemetry.modelsAttempted.filter((item): item is string => typeof item === "string") : [],
        modelAttempts: Array.isArray(telemetry.modelAttempts)
          ? telemetry.modelAttempts
            .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
            .map((item) => {
              const attempt: { model: string; durationMs: number; ok: boolean; error?: string } = {
                model: typeof item.model === "string" ? item.model : "",
                durationMs: numeric(item.durationMs),
                ok: item.ok === true,
              };
              if (typeof item.error === "string") attempt.error = item.error;
              return attempt;
            })
          : [],
        costSource: typeof telemetry.costSource === "string" ? telemetry.costSource : "unconfigured",
        qualityPassed: telemetry.qualityPassed === true,
        failureStage: typeof telemetry.failureStage === "string" ? telemetry.failureStage : "",
        creditsCharged: numeric(row.credits_charged),
        errorCode: row.error_code,
        errorMessage: row.error_message,
        createdAt: row.created_at.toISOString(),
        finishedAt: row.finished_at?.toISOString() ?? null,
      };
    });
    return reply.send({ jobs, total: numeric(result.rows[0]?.total), compensationAvailable: Boolean(options.billingStore) });
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

  const validUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const requireAdminOrigin = (request: any, reply: any) => {
    if (typeof request.headers.origin !== "string" || !options.allowedOrigins.includes(request.headers.origin)) {
      reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
      return false;
    }
    return true;
  };

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
    const result = await options.pool.query(`
      SELECT u.id AS user_id, u.display_name, u.phone, u.email, u.partner_province, u.partner_city,
        u.partner_activated_at,
        (SELECT count(*) FROM users d WHERE d.inviter_user_id = u.id AND d.deleted_at IS NULL)::int AS direct_invites,
        (SELECT count(*) FROM users d2 JOIN users d1 ON d2.inviter_user_id = d1.id
          WHERE d1.inviter_user_id = u.id AND d1.deleted_at IS NULL AND d2.deleted_at IS NULL)::int AS second_level_invites,
        coalesce((SELECT sum(c.commission_amount_yuan) FROM partner_commissions c JOIN billing_orders o ON o.id = c.order_id
          WHERE c.beneficiary_user_id = u.id AND c.status = 'pending' AND o.payment_provider = 'opcpay'
            AND o.provider_payment_status = 'PAID' AND o.status = 'paid'), 0) AS pending_commission,
        coalesce((SELECT sum(c.commission_amount_yuan) FROM partner_commissions c JOIN billing_orders o ON o.id = c.order_id
          WHERE c.beneficiary_user_id = u.id AND c.status = 'settled' AND o.payment_provider = 'opcpay'
            AND o.provider_payment_status = 'PAID' AND o.status = 'paid'), 0) AS settled_commission,
        coalesce((SELECT sum(w.amount_yuan) FROM partner_withdrawals w
          WHERE w.user_id = u.id AND w.status IN ('pending','approved','paid')), 0) AS reserved_withdrawal,
        p.verification_status AS payout_verification_status, p.account_last4
      FROM users u
      LEFT JOIN partner_payout_profiles p ON p.user_id = u.id
      WHERE u.partner_activated_at IS NOT NULL AND u.deleted_at IS NULL
      ORDER BY u.partner_activated_at DESC
      LIMIT $1
    `, [limit]);
    return reply.send({ partners: result.rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name ?? "简兮用户",
      contact: row.phone ? `${row.phone.slice(0, 3)}****${row.phone.slice(-4)}` : row.email ?? "",
      province: row.partner_province,
      city: row.partner_city,
      activatedAt: row.partner_activated_at.toISOString(),
      directInvites: numeric(row.direct_invites),
      secondLevelInvites: numeric(row.second_level_invites),
      pendingCommissionYuan: numeric(row.pending_commission),
      settledCommissionYuan: numeric(row.settled_commission),
      reservedWithdrawalYuan: numeric(row.reserved_withdrawal),
      withdrawableYuan: Math.max(0, Number((numeric(row.settled_commission) - numeric(row.reserved_withdrawal)).toFixed(2))),
      payoutVerificationStatus: row.payout_verification_status ?? "not_bound",
      payoutAccountLast4: row.account_last4 ?? null,
    })) });
  });

  app.get("/api/v1/admin/partner/withdrawals", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const query = (request.query as { status?: string; limit?: string }) ?? {};
    const statuses = new Set(["pending", "approved", "paid", "rejected", "failed"]);
    const status = query.status && statuses.has(query.status) ? query.status : null;
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
    const result = await options.pool.query(`
      SELECT w.id, w.user_id, u.display_name, u.phone, u.email, w.amount_yuan, w.fee_yuan, w.net_amount_yuan,
        w.status, w.note, w.external_reference, w.payout_channel, w.payout_account_last4, w.created_at, w.processed_at,
        w.admin_user_id
      FROM partner_withdrawals w JOIN users u ON u.id = w.user_id
      WHERE ($1::text IS NULL OR w.status = $1)
      ORDER BY CASE WHEN w.status = 'pending' THEN 0 WHEN w.status = 'approved' THEN 1 ELSE 2 END, w.created_at ASC
      LIMIT $2
    `, [status, limit]);
    return reply.send({ withdrawals: result.rows.map((row) => ({
      id: row.id, userId: row.user_id, displayName: row.display_name ?? "简兮用户",
      contact: row.phone ? `${row.phone.slice(0, 3)}****${row.phone.slice(-4)}` : row.email ?? "",
      amountYuan: numeric(row.amount_yuan), feeYuan: numeric(row.fee_yuan), netAmountYuan: numeric(row.net_amount_yuan),
      status: row.status, note: row.note, externalReference: row.external_reference,
      payoutChannel: row.payout_channel, accountLast4: row.payout_account_last4,
      createdAt: row.created_at.toISOString(), processedAt: row.processed_at?.toISOString() ?? null,
    })) });
  });

  app.get("/api/v1/admin/partner/withdrawals/:withdrawalId/payout", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!options.pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const { withdrawalId } = request.params as { withdrawalId: string };
    if (!validUuid(withdrawalId)) return reply.code(400).send({ error: { code: "INVALID_WITHDRAWAL_ID" } });
    const result = await options.pool.query<{ user_id: string; payout_channel: string; payout_name_ciphertext: string; payout_account_ciphertext: string; payout_account_last4: string; status: string }>(
      "SELECT user_id, payout_channel, payout_name_ciphertext, payout_account_ciphertext, payout_account_last4, status FROM partner_withdrawals WHERE id = $1",
      [withdrawalId],
    );
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ error: { code: "WITHDRAWAL_NOT_FOUND" } });
    try {
      const key = process.env.PARTNER_PAYOUT_ENCRYPTION_KEY;
      const accountName = decryptPayoutValue(row.payout_name_ciphertext, key);
      const account = decryptPayoutValue(row.payout_account_ciphertext, key);
      await options.pool.query(
        "INSERT INTO partner_audit_events (user_id, actor_user_id, entity_type, entity_id, action, details) VALUES ($1, $2, 'withdrawal', $3, 'withdrawal.payout_details_viewed', $4::jsonb)",
        [row.user_id, operator.id, withdrawalId, JSON.stringify({ accountLast4: row.payout_account_last4 })],
      );
      return reply.send({ payout: { channel: row.payout_channel, accountName, account, accountLast4: row.payout_account_last4, withdrawalStatus: row.status } });
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
    const result = await options.pool.query<{ payout_channel: string; account_name_ciphertext: string; account_ciphertext: string; account_last4: string; verification_status: string }>(
      "SELECT payout_channel, account_name_ciphertext, account_ciphertext, account_last4, verification_status FROM partner_payout_profiles WHERE user_id = $1",
      [userId],
    );
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ error: { code: "PAYOUT_PROFILE_NOT_FOUND" } });
    try {
      const key = process.env.PARTNER_PAYOUT_ENCRYPTION_KEY;
      const accountName = decryptPayoutValue(row.account_name_ciphertext, key);
      const account = decryptPayoutValue(row.account_ciphertext, key);
      await options.pool.query(
        "INSERT INTO partner_audit_events (user_id, actor_user_id, entity_type, action, details) VALUES ($1, $2, 'payout_profile', 'payout_profile.details_viewed', $3::jsonb)",
        [userId, operator.id, JSON.stringify({ accountLast4: row.account_last4 })],
      );
      return reply.send({ profile: { channel: row.payout_channel, accountName, account, accountLast4: row.account_last4, verificationStatus: row.verification_status } });
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
    const client = await options.pool.connect();
    try {
      await client.query("BEGIN");
      const profile = await client.query<{ verification_status: string }>("SELECT verification_status FROM partner_payout_profiles WHERE user_id = $1 FOR UPDATE", [userId]);
      if (!profile.rows[0]) { await client.query("ROLLBACK"); return reply.code(404).send({ error: { code: "PAYOUT_PROFILE_NOT_FOUND" } }); }
      if (profile.rows[0].verification_status !== "pending") { await client.query("ROLLBACK"); return reply.code(409).send({ error: { code: "PROFILE_ALREADY_REVIEWED" } }); }
      await client.query("UPDATE partner_payout_profiles SET verification_status = $2, verification_note = $3, verified_at = CASE WHEN $2 = 'verified' THEN now() ELSE NULL END, updated_at = now() WHERE user_id = $1", [userId, body.status, note || null]);
      await client.query("INSERT INTO partner_audit_events (user_id, actor_user_id, entity_type, action, details) VALUES ($1, $2, 'payout_profile', 'payout_profile.reviewed', $3::jsonb)", [userId, operator.id, JSON.stringify({ status: body.status, note })]);
      await client.query("COMMIT");
      return reply.send({ success: true, userId, status: body.status });
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      return reply.code(503).send({ error: { code: "PROFILE_REVIEW_FAILED" } });
    } finally { client.release(); }
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
    const client = await options.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ user_id: string; status: string; amount_yuan: string }>("SELECT user_id, status, amount_yuan FROM partner_withdrawals WHERE id = $1 FOR UPDATE", [withdrawalId]);
      const row = current.rows[0];
      if (!row) { await client.query("ROLLBACK"); return reply.code(404).send({ error: { code: "WITHDRAWAL_NOT_FOUND" } }); }
      if (row.status !== "pending") { await client.query("ROLLBACK"); return reply.code(409).send({ error: { code: "WITHDRAWAL_NOT_PENDING" } }); }
      await client.query("UPDATE partner_withdrawals SET status = $2, note = $3, admin_user_id = $4, processed_at = now(), updated_at = now() WHERE id = $1", [withdrawalId, body.status, note || null, operator.id]);
      await client.query("INSERT INTO partner_audit_events (user_id, actor_user_id, entity_type, entity_id, action, details) VALUES ($1, $2, 'withdrawal', $3, 'withdrawal.reviewed', $4::jsonb)", [row.user_id, operator.id, withdrawalId, JSON.stringify({ status: body.status, amountYuan: numeric(row.amount_yuan), note })]);
      await client.query("COMMIT");
      return reply.send({ success: true, withdrawalId, status: body.status });
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      return reply.code(503).send({ error: { code: "WITHDRAWAL_REVIEW_FAILED" } });
    } finally { client.release(); }
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
    const client = await options.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ user_id: string; status: string; net_amount_yuan: string }>("SELECT user_id, status, net_amount_yuan FROM partner_withdrawals WHERE id = $1 FOR UPDATE", [withdrawalId]);
      const row = current.rows[0];
      if (!row) { await client.query("ROLLBACK"); return reply.code(404).send({ error: { code: "WITHDRAWAL_NOT_FOUND" } }); }
      if (row.status !== "approved") { await client.query("ROLLBACK"); return reply.code(409).send({ error: { code: "WITHDRAWAL_NOT_APPROVED" } }); }
      await client.query("UPDATE partner_withdrawals SET status = 'paid', external_reference = $2, note = $3, admin_user_id = $4, processed_at = now(), updated_at = now() WHERE id = $1", [withdrawalId, reference, note || null, operator.id]);
      await client.query("INSERT INTO partner_audit_events (user_id, actor_user_id, entity_type, entity_id, action, details) VALUES ($1, $2, 'withdrawal', $3, 'withdrawal.paid', $4::jsonb)", [row.user_id, operator.id, withdrawalId, JSON.stringify({ netAmountYuan: numeric(row.net_amount_yuan), externalReference: reference, note })]);
      await client.query("COMMIT");
      return reply.send({ success: true, withdrawalId, status: "paid" });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string })?.code === "23505") {
        return reply.code(409).send({ error: { code: "PAYMENT_REFERENCE_ALREADY_USED", message: "该转账凭证已登记在其他提现记录中" } });
      }
      return reply.code(503).send({ error: { code: "WITHDRAWAL_PAYMENT_RECORD_FAILED" } });
    } finally { client.release(); }
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
    const client = await options.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ user_id: string; status: string }>("SELECT user_id, status FROM partner_withdrawals WHERE id = $1 FOR UPDATE", [withdrawalId]);
      const row = current.rows[0];
      if (!row) { await client.query("ROLLBACK"); return reply.code(404).send({ error: { code: "WITHDRAWAL_NOT_FOUND" } }); }
      if (row.status !== "approved") { await client.query("ROLLBACK"); return reply.code(409).send({ error: { code: "WITHDRAWAL_NOT_APPROVED" } }); }
      await client.query("UPDATE partner_withdrawals SET status = 'failed', note = $2, admin_user_id = $3, processed_at = now(), updated_at = now() WHERE id = $1", [withdrawalId, note, operator.id]);
      await client.query("INSERT INTO partner_audit_events (user_id, actor_user_id, entity_type, entity_id, action, details) VALUES ($1, $2, 'withdrawal', $3, 'withdrawal.failed', $4::jsonb)", [row.user_id, operator.id, withdrawalId, JSON.stringify({ note })]);
      await client.query("COMMIT");
      return reply.send({ success: true, withdrawalId, status: "failed" });
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      return reply.code(503).send({ error: { code: "WITHDRAWAL_FAILURE_RECORD_FAILED" } });
    } finally { client.release(); }
  });
}
