import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { CAPABILITIES } from "@jansee/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import QRCode from "qrcode";
import { DirectorPlanRequestSchema, type DirectorPlanner } from "./director.js";
import { parseBatchVersions } from "./batch-versions.js";
import { withCreationSceneMarker } from "./prompt-assembly.js";
import { detectSensitiveTerms } from "./content-safety.js";
import { registerAuthRoutes, type AuthStore } from "./auth.js";
import { registerAssetRoutes, authenticatedUser, type AssetStore } from "./assets.js";
import { registerJobRoutes, type JobStore } from "./jobs.js";
import { registerOutputRoutes, type OutputStore } from "./outputs.js";
import { registerAdminRoutes } from "./admin.js";
import { registerSpeechCutRoutes, type SpeechCutRoutesOptions } from "./speech-cut.js";
import type { SpeechCutStore } from "./speech-cut-store.js";
import type { LocalObjectStorage } from "./storage-local.js";
import type { BillingStore } from "./billing.js";
import type { OpcpayService } from "./opcpay.js";
import { registerGrowthRoutes } from "./growth.js";
import type { GrowthStore } from "./growth-store.js";
import { GENERATION_COST_CREDITS } from "./billing.js";
import { getPricingCatalog } from "./pricing.js";
import { registerSiteAnalyticsRoutes } from "./site-analytics.js";
import { registerConversationRoutes } from "./conversations.js";
import { registerVoiceTranscribeRoutes } from "./voice-transcribe.js";
// @ts-expect-error ffmpeg-kit probe module is ESM
import { probeDurationSec } from "@jansee/ffmpeg-kit/probe.mjs";

export interface AppConfig {
  allowedOrigins: string[];
  logLevel: string;
  production: boolean;
  trustProxy?: boolean | string | string[];
  directorPlanner?: DirectorPlanner;
  directorConfigured?: boolean;
  database?: { isHealthy(): Promise<boolean>; close(): Promise<void> };
  authStore?: AuthStore;
  assetStore?: AssetStore;
  jobStore?: JobStore;
  outputStore?: OutputStore;
  billingStore?: BillingStore;
  growthStore?: GrowthStore;
  mediaStorage?: LocalObjectStorage;
  speechCutStore?: SpeechCutStore;
  speechCutAnalyzer?: SpeechCutRoutesOptions["analyzeVideo"];
  speechCutSuggestionDetector?: SpeechCutRoutesOptions["detectSuggestions"];
  speechCutInspectVideo?: SpeechCutRoutesOptions["inspectVideo"];
  workerReady?: boolean | (() => boolean);
  adminEmails?: string[];
  adminPhones?: string[];
  adminPool?: Pool | undefined;
  allowPaymentSimulation?: boolean;
  paymentProviderReady?: boolean;
  paymentProvider?: OpcpayService;
  voiceTranscribeAudio?: (audioPath: string, workDir: string) => Promise<{ text?: string; duration?: number }>;
}

export function buildApp(config: AppConfig): FastifyInstance {
  if (config.production && config.allowedOrigins.length === 0) throw new Error("WEB_ORIGINS must be configured in production");
  const app = Fastify({
    logger: { level: config.logLevel, redact: { paths: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie", "*.password", "*.accessToken", "*.refreshToken", "*.apiKey"], censor: "[REDACTED]" } },
    bodyLimit: 2 * 1024 * 1024, requestTimeout: 300_000, connectionTimeout: 300_000,
    keepAliveTimeout: 5_000, trustProxy: config.trustProxy ?? false, genReqId: () => randomUUID(),
  });
  const rawWebhookBodies = new WeakMap<object, Promise<Buffer>>();
  if (config.paymentProvider) {
    app.addHook("preParsing", async (request, _reply, payload) => {
      if (request.method !== "POST" || request.url.split("?")[0] !== "/api/v1/billing/opcpay/webhook") return payload;
      const chunks: Buffer[] = [];
      let resolveBody!: (body: Buffer) => void;
      let rejectBody!: (error: Error) => void;
      const rawBody = new Promise<Buffer>((resolve, reject) => { resolveBody = resolve; rejectBody = reject; });
      void rawBody.catch(() => undefined);
      payload.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      payload.on("end", () => resolveBody(Buffer.concat(chunks)));
      payload.on("error", (error) => rejectBody(error instanceof Error ? error : new Error(String(error))));
      const tee = new PassThrough() as PassThrough & { receivedEncodedLength?: number };
      Object.defineProperty(tee, "receivedEncodedLength", { get: () => (payload as typeof payload & { receivedEncodedLength?: number }).receivedEncodedLength });
      payload.pipe(tee);
      rawWebhookBodies.set(request, rawBody);
      return tee;
    });
  }
  app.register(helmet, { global: true, crossOriginEmbedderPolicy: false, referrerPolicy: { policy: "strict-origin-when-cross-origin" }, ...(!config.production ? { contentSecurityPolicy: false } : {}) });
  app.register(cors, { credentials: true, origin(origin, callback) { callback(null, !origin || config.allowedOrigins.includes(origin)); } });
  app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute", ban: 0 });
  app.register(multipart, { limits: { files: 9, fileSize: 200 * 1024 * 1024, fields: 10, parts: 20 } });
  app.get("/health/live", async () => ({ status: "alive", service: "jansee-api", version: process.env.APP_VERSION ?? "4.0.0-alpha.1" }));
  // Package catalogs are public read-only data and must not depend on authentication or a database.
  const currentPricingCatalog = async (force = false) => {
    if (config.paymentProvider?.configured) {
      try { return await config.paymentProvider.refreshPricingCatalog(force); }
      catch { return getPricingCatalog(config.adminPool); }
    }
    return getPricingCatalog(config.adminPool);
  };
  app.get("/api/v1/billing/packages", async () => {
    const catalog = await currentPricingCatalog();
    return { ...catalog, packages: [...catalog.members, ...catalog.boostPacks] };
  });
  app.get("/api/v1/pricing", async () => currentPricingCatalog());
  app.get("/health/ready", async (_request, reply) => {
    const databaseReady = config.database ? await config.database.isHealthy() : false;
    const workerReady = typeof config.workerReady === "function" ? config.workerReady() : config.workerReady === true;
    const paymentReady = !config.production || (config.paymentProvider ? config.paymentProvider.isReady : config.paymentProviderReady === true);
    const ready = databaseReady && workerReady && paymentReady;
    if (!ready) reply.code(503);
    return {
      status: ready ? "ready" : "not-ready",
      checks: { database: databaseReady, worker: workerReady, ...(config.production ? { payment: paymentReady } : {}) },
    };
  });
  app.addHook("onClose", async () => { await config.database?.close(); });
  if (config.authStore) registerAuthRoutes(app, { store: config.authStore, allowedOrigins: config.allowedOrigins, production: config.production });
  if (config.authStore && config.assetStore && config.mediaStorage) {
    registerAssetRoutes(app, { authStore: config.authStore, assetStore: config.assetStore, storage: config.mediaStorage, allowedOrigins: config.allowedOrigins });
  }
  if (config.authStore && config.assetStore && config.jobStore && config.mediaStorage && config.speechCutStore && config.speechCutAnalyzer && config.speechCutSuggestionDetector) {
    registerSpeechCutRoutes(app, {
      authStore: config.authStore,
      assetStore: config.assetStore,
      jobStore: config.jobStore,
      speechCutStore: config.speechCutStore,
      storage: config.mediaStorage,
      allowedOrigins: config.allowedOrigins,
      analyzeVideo: config.speechCutAnalyzer,
      detectSuggestions: config.speechCutSuggestionDetector,
      ...(config.speechCutInspectVideo ? { inspectVideo: config.speechCutInspectVideo } : {}),
    });
  }
  if (config.authStore && config.assetStore && config.jobStore) {
    registerJobRoutes(app, {
      authStore: config.authStore,
      assetStore: config.assetStore,
      jobStore: config.jobStore,
      billingStore: config.billingStore,
      allowedOrigins: config.allowedOrigins,
    });
  }
  if (config.authStore) {
    registerAdminRoutes(app, {
      authStore: config.authStore,
      pool: config.adminPool,
      billingStore: config.billingStore,
      paymentProvider: config.paymentProvider,
      allowedOrigins: config.allowedOrigins,
      allowedAdminEmails: config.adminEmails ?? [],
      allowedAdminPhones: config.adminPhones ?? [],
      health: {
        workerReady: typeof config.workerReady === "function" ? config.workerReady : () => Boolean(config.workerReady),
        paymentReady: () => Boolean(config.paymentProvider?.isReady ?? config.paymentProviderReady),
        directorConfigured: Boolean(config.directorConfigured),
        ttsConfigured: Boolean(process.env.JX_TTS_TENCENT_SECRET_ID && process.env.JX_TTS_TENCENT_SECRET_KEY),
        mediaConfigured: Boolean(config.mediaStorage),
      },
    });
  }
  if (config.adminPool) registerSiteAnalyticsRoutes(app, config.adminPool);
  if (config.authStore && config.growthStore) {
    registerGrowthRoutes(app, {
      authStore: config.authStore,
      growthStore: config.growthStore,
      allowedOrigins: config.allowedOrigins,
    });
  }
  if (config.authStore && config.adminPool) {
    registerConversationRoutes(app, {
      authStore: config.authStore,
      pool: config.adminPool,
      allowedOrigins: config.allowedOrigins,
    });
  }
  if (config.authStore) {
    registerVoiceTranscribeRoutes(app, {
      authStore: config.authStore,
      allowedOrigins: config.allowedOrigins,
      ...(config.voiceTranscribeAudio ? { transcribeAudio: config.voiceTranscribeAudio } : {}),
    });
  }
  if (config.authStore && config.billingStore) {
    app.get("/api/v1/billing/wallet", async (request, reply) => {
      const user = await authenticatedUser(request, config.authStore!);
      if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
      const wallet = await config.billingStore!.getWallet(user.id);
      const membership = await config.billingStore!.getMembership?.(user.id) ?? null;
      return reply.send({
        wallet,
        membership,
        costPerGeneration: GENERATION_COST_CREDITS,
      });
    });

    app.get("/api/v1/billing/membership", async (request, reply) => {
      const user = await authenticatedUser(request, config.authStore!);
      if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
      const membership = await config.billingStore!.getMembership?.(user.id) ?? null;
      return reply.send({ membership });
    });

    app.get("/api/v1/billing/orders", async (request, reply) => {
      try {
        const user = await authenticatedUser(request, config.authStore!);
        if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
        const orders = await config.billingStore!.listUserOrders(user.id);
        return reply.send({ orders });
      } catch {
        return reply.code(503).send({ error: { code: "BILLING_HISTORY_UNAVAILABLE", message: "订单记录暂时不可用，请稍后重试", requestId: request.id } });
      }
    });

    app.post("/api/v1/support/messages", { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } }, async (request, reply) => {
      if (typeof request.headers.origin !== "string" || !config.allowedOrigins.includes(request.headers.origin)) {
        return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
      }
      const user = await authenticatedUser(request, config.authStore!);
      if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
      if (!config.adminPool) return reply.code(503).send({ error: { code: "SUPPORT_UNAVAILABLE", message: "站内信服务暂不可用，请稍后重试" } });
      const body = (request.body ?? {}) as { orderId?: unknown; subject?: unknown; message?: unknown };
      const orderId = typeof body.orderId === "string" ? body.orderId.trim().slice(0, 128) : "";
      const subject = typeof body.subject === "string" ? body.subject.trim().slice(0, 120) : "";
      const message = typeof body.message === "string" ? body.message.trim().slice(0, 2000) : "";
      if (!subject || !message) return reply.code(400).send({ error: { code: "SUPPORT_MESSAGE_REQUIRED", message: "请填写站内信内容" } });
      if (orderId) {
        const ownedOrder = await config.adminPool.query("SELECT id FROM billing_orders WHERE id = $1 AND user_id = $2 LIMIT 1", [orderId, user.id]);
        if (!ownedOrder.rows[0]) return reply.code(404).send({ error: { code: "ORDER_NOT_FOUND", message: "订单不存在或不属于当前账号" } });
      }
      const inserted = await config.adminPool.query<{ id: string; created_at: Date }>(
        "INSERT INTO support_messages (user_id, order_id, subject, message) VALUES ($1, $2, $3, $4) RETURNING id, created_at",
        [user.id, orderId || null, subject, message],
      );
      return reply.code(201).send({ success: true, messageId: inserted.rows[0]?.id, createdAt: inserted.rows[0]?.created_at });
    });
    app.get("/api/v1/inbox", async (request, reply) => {
      const user = await authenticatedUser(request, config.authStore!);
      if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
      if (!config.adminPool) return reply.code(503).send({ error: { code: "INBOX_UNAVAILABLE", message: "站内信暂不可用" } });
      const result = await config.adminPool.query(
        `SELECT m.id, m.subject, m.body, m.category, m.published_at, r.read_at
         FROM site_inbox_messages m
         LEFT JOIN site_inbox_reads r ON r.message_id = m.id AND r.user_id = $1
         WHERE m.status = 'published'
           AND (m.recipient_user_id IS NULL OR m.recipient_user_id = $1)
         ORDER BY m.published_at DESC NULLS LAST, m.created_at DESC`,
        [user.id],
      );
      return reply.send({ messages: result.rows.map((row) => ({
        id: row.id, subject: row.subject, body: row.body, category: row.category,
        publishedAt: row.published_at?.toISOString?.() ?? null,
        readAt: row.read_at?.toISOString?.() ?? null,
      })) });
    });

    app.post("/api/v1/inbox/:messageId/read", async (request, reply) => {
      if (typeof request.headers.origin !== "string" || !config.allowedOrigins.includes(request.headers.origin)) {
        return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
      }
      const user = await authenticatedUser(request, config.authStore!);
      if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
      if (!config.adminPool) return reply.code(503).send({ error: { code: "INBOX_UNAVAILABLE", message: "站内信暂不可用" } });
      const { messageId } = request.params as { messageId: string };
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId)) {
        return reply.code(400).send({ error: { code: "INVALID_MESSAGE_ID" } });
      }
      const result = await config.adminPool.query(
        `INSERT INTO site_inbox_reads (user_id, message_id)
         SELECT $1, id FROM site_inbox_messages
         WHERE id = $2 AND status = 'published'
           AND (recipient_user_id IS NULL OR recipient_user_id = $1)
         ON CONFLICT (user_id, message_id) DO NOTHING RETURNING message_id`,
        [user.id, messageId],
      );
      if (result.rowCount === 0) {
        const exists = await config.adminPool.query(
          "SELECT 1 FROM site_inbox_messages WHERE id = $1 AND status = 'published' AND (recipient_user_id IS NULL OR recipient_user_id = $2) LIMIT 1",
          [messageId, user.id],
        );
        if (!exists.rows[0]) return reply.code(404).send({ error: { code: "MESSAGE_NOT_FOUND" } });
      }
      return reply.send({ success: true, messageId });
    });

    app.get("/api/v1/billing/ledger", async (request, reply) => {
      try {
        const user = await authenticatedUser(request, config.authStore!);
        if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
        const entries = await config.billingStore!.getLedger(user.id);
        return reply.send({ entries });
      } catch {
        return reply.code(503).send({ error: { code: "BILLING_HISTORY_UNAVAILABLE", message: "积分流水暂时不可用，请稍后重试", requestId: request.id } });
      }
    });
    app.post("/api/v1/billing/orders", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
      if (typeof request.headers.origin !== "string" || !config.allowedOrigins.includes(request.headers.origin)) {
        return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
      }
      const user = await authenticatedUser(request, config.authStore!);
      if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
      if (config.production && !(config.paymentProvider?.isReady ?? config.paymentProviderReady)) return reply.code(503).send({ error: { code: "PAYMENT_PROVIDER_NOT_CONFIGURED", message: "正式支付渠道尚未接入，暂不能创建充值订单" } });
      const { packageId } = (request.body as { packageId?: string }) || {};
      if (!packageId) return reply.code(400).send({ error: { code: "INVALID_PARAM", message: "缺少 packageId" } });
      try {
        let catalog;
        try {
          catalog = config.paymentProvider?.configured
            ? await config.paymentProvider.refreshPricingCatalog(true)
            : await getPricingCatalog(config.adminPool);
        } catch {
          return reply.code(503).send({ error: { code: "PRICING_SYNC_FAILED", message: "暂时无法从 OPCPAY 获取最新价格，请稍后重试" } });
        }
        const selectedPlan = [...catalog.members, ...catalog.boostPacks].find((plan) => plan.id === packageId);
        if (!selectedPlan || !Number.isFinite(selectedPlan.priceYuan) || selectedPlan.priceYuan <= 0) {
          return reply.code(400).send({ error: { code: "INVALID_PACKAGE", message: "????????????" } });
        }
        const order = await config.billingStore!.createOrder(user.id, packageId, selectedPlan.priceYuan);
        return reply.code(201).send({ order, reused: false });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: { code: "ORDER_FAILED", message } });
      }
    });

    app.post("/api/v1/billing/orders/:id/checkout", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
      if (typeof request.headers.origin !== "string" || !config.allowedOrigins.includes(request.headers.origin)) {
        return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
      }
      const user = await authenticatedUser(request, config.authStore!);
      if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
      if (!config.paymentProvider || !config.paymentProvider.isReady) {
        return reply.code(503).send({ error: { code: "PAYMENT_PROVIDER_NOT_READY", message: "一人付支付通道暂不可用，请稍后重试" } });
      }
      const { id } = request.params as { id: string };
      const order = await config.billingStore!.findOrderById(id);
      if (!order || order.userId !== user.id) return reply.code(404).send({ error: { code: "ORDER_NOT_FOUND", message: "充值订单不存在" } });
      try {
        const checkout = await config.paymentProvider.createCheckout(user.id, order);
        return reply.send(checkout);
      } catch (error) {
        request.log.warn({ err: error, orderId: id }, "OPCPAY checkout creation failed");
        const message = error instanceof Error ? error.message : "支付入口创建失败";
        return reply.code(502).send({ error: { code: "PAYMENT_CHECKOUT_FAILED", message } });
      }
    });

    // GET is deliberately read-only: browser navigation and cross-site links must never
    // trigger provider quota consumption or local credit fulfillment.
    app.get("/api/v1/billing/orders/:id/status", async (request, reply) => {
      const user = await authenticatedUser(request, config.authStore!);
      if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
      const { id } = request.params as { id: string };
      const order = await config.billingStore!.findOrderById(id);
      if (!order || order.userId !== user.id) return reply.code(404).send({ error: { code: "ORDER_NOT_FOUND", message: "充值订单不存在" } });
      return reply.send({
        order,
        wallet: await config.billingStore!.getWallet(user.id),
        tradeState: order.status === "paid" ? "PAID" : "WAIT_BUYER_PAY",
      });
    });

    // Reconciliation can consume provider entitlements and credit the wallet, so it is
    // an explicit same-origin POST with a dedicated rate limit rather than a GET side effect.
    app.post("/api/v1/billing/orders/:id/reconcile", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
      if (typeof request.headers.origin !== "string" || !config.allowedOrigins.includes(request.headers.origin)) {
        return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
      }
      const user = await authenticatedUser(request, config.authStore!);
      if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
      const { id } = request.params as { id: string };
      const order = await config.billingStore!.findOrderById(id);
      if (!order || order.userId !== user.id) return reply.code(404).send({ error: { code: "ORDER_NOT_FOUND", message: "充值订单不存在" } });
      if (order.status === "paid") {
        return reply.send({ order, wallet: await config.billingStore!.getWallet(user.id), tradeState: "PAID" });
      }
      if (!config.paymentProvider || !config.paymentProvider.isReady) {
        return reply.code(503).send({ error: { code: "PAYMENT_PROVIDER_NOT_READY", message: "支付状态暂不可查询" } });
      }
      try {
        await config.paymentProvider.reconcileOrder(user.id, id);
        const updated = await config.billingStore!.findOrderById(id);
        return reply.send({
          order: updated,
          wallet: await config.billingStore!.getWallet(user.id),
          tradeState: updated?.status === "paid" ? "PAID" : "WAIT_BUYER_PAY",
        });
      } catch (error) {
        request.log.warn({ err: error, orderId: id }, "OPCPAY status reconciliation failed");
        return reply.code(503).send({ error: { code: "PAYMENT_STATUS_UNAVAILABLE", message: "支付状态暂不可用，请稍后重试" } });
      }
    });

    app.post("/api/v1/billing/orders/:id/simulate", async (request, reply) => {
      if (!config.allowPaymentSimulation || config.production) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "模拟支付仅在明确启用的非生产环境可用" } });
      if (typeof request.headers.origin !== "string" || !config.allowedOrigins.includes(request.headers.origin)) {
        return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
      }
      const user = await authenticatedUser(request, config.authStore!);
      if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
      const { id } = request.params as { id: string };
      try {
        const pendingOrder = await config.billingStore!.findOrderById(id);
        if (!pendingOrder || pendingOrder.userId !== user.id) {
          return reply.code(404).send({ error: { code: "ORDER_NOT_FOUND", message: "充值订单不存在" } });
        }
        const order = await config.billingStore!.fulfillOrder(id);
        const wallet = await config.billingStore!.getWallet(user.id);
        return reply.send({ ok: true, order, wallet });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: { code: "FULFILL_FAILED", message } });
      }
    });
  }
  if (config.paymentProvider) {
    app.post("/api/v1/billing/opcpay/webhook", async (request, reply) => {
      try {
        const rawBody = await rawWebhookBodies.get(request);
        if (!rawBody) return reply.code(400).type("text/plain").send("missing raw body");
        const accepted = await config.paymentProvider!.acceptWebhook(rawBody, request.headers);
        if (!accepted.duplicate) {
          void config.paymentProvider!.reconcileUser(accepted.userId).catch((error) => {
            request.log.warn({ err: error, userId: accepted.userId }, "OPCPAY webhook reconciliation deferred to periodic sweep");
          });
        }
        return reply.code(200).type("text/plain").send("ok");
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        request.log.warn({ err: error }, "OPCPAY webhook rejected or not persisted");
        if (message === "OPCPAY_WEBHOOK_INVALID_SIGNATURE" || message.includes("Webhook 缺少")) {
          return reply.code(400).type("text/plain").send("bad signature");
        }
        return reply.code(503).type("text/plain").send("temporarily unavailable");
      }
    });
  }

  if (config.authStore && config.outputStore && config.mediaStorage) {
    registerOutputRoutes(app, {
      authStore: config.authStore,
      outputStore: config.outputStore,
      storage: config.mediaStorage,
      allowedOrigins: config.allowedOrigins,
    });
  }
  app.get("/api/v1/capabilities", async () => ({ capabilities: CAPABILITIES }));
  app.post("/api/v1/director/plan", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!config.directorPlanner) return reply.code(503).send({ error: { code: "DIRECTOR_NOT_CONFIGURED", message: "AI 导演服务尚未配置，请稍后再试", requestId: request.id } });
    let user = null;
    if (config.authStore) {
      user = await authenticatedUser(request, config.authStore);
      if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录后再进行创作规划", requestId: request.id } });
    }
    const parsed = DirectorPlanRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_DIRECTOR_REQUEST", message: "创作需求或素材信息不符合要求", requestId: request.id } });
    // 前端明确选择的入口场景优先写入提示词前缀，保证导演路由与用户所见场景一致。
    const planningPrompt = withCreationSceneMarker(parsed.data.prompt, parsed.data.creationScene);

    const promptHits = detectSensitiveTerms(planningPrompt);
    if (promptHits.length > 0) {
      request.log.warn({ userId: user?.id ?? null, scene: "director.plan", hitCount: promptHits.length }, "blocked content by local preflight");
      return reply.code(422).send({ error: { code: "CONTENT_POLICY_BLOCKED", message: "内容可能涉及平台禁止内容或高风险宣传用语，请调整描述后重试", requestId: request.id } });
    }
    let resolvedAssets = parsed.data.assets ?? [];
    if (parsed.data.assetIds && parsed.data.assetIds.length > 0) {
      if (!config.assetStore?.findUserAssets || !user) {
        return reply.code(400).send({ error: { code: "ASSET_STORE_UNAVAILABLE", message: "资产服务不可用", requestId: request.id } });
      }
      const ownedAssets = await config.assetStore.findUserAssets(user.id, parsed.data.assetIds);
      if (ownedAssets.length !== parsed.data.assetIds.length) {
        return reply.code(404).send({ error: { code: "ASSET_NOT_FOUND", message: "部分素材不存在或不属于当前账号", requestId: request.id } });
      }
      const kinds = new Set(ownedAssets.map((a) => a.mediaType));
      if (kinds.size !== 1) {
        return reply.code(400).send({ error: { code: "INVALID_DIRECTOR_REQUEST", message: "一次创作只能使用同一类素材", requestId: request.id } });
      }
      if (parsed.data.mode === "image-film" && ownedAssets.some((a) => a.mediaType !== "image")) {
        return reply.code(400).send({ error: { code: "INVALID_DIRECTOR_REQUEST", message: "图片成片只接受图片素材", requestId: request.id } });
      }
      if (parsed.data.mode !== "image-film" && ownedAssets.some((a) => a.mediaType !== "video")) {
        return reply.code(400).send({ error: { code: "INVALID_DIRECTOR_REQUEST", message: "视频创作只接受视频素材", requestId: request.id } });
      }
      const assetMap = new Map(ownedAssets.map((a) => [a.id, a]));
      resolvedAssets = await Promise.all(parsed.data.assetIds.map(async (id) => {
        const item = assetMap.get(id)!;
        let durationSec: number | undefined;
        if (item.mediaType === "video" && config.mediaStorage) {
          try {
            const filePath = await config.mediaStorage.getFilePath(item.storageKey);
            const probed = probeDurationSec(filePath);
            if (Number.isFinite(probed) && probed > 0) durationSec = probed;
          } catch {
            // 时长探测失败不阻断规划，回退到无时长规划
          }
        }
        return { name: item.originalName, kind: item.mediaType, size: item.sizeBytes, ...(durationSec !== undefined ? { durationSec } : {}) };
      }));
    }

    if (resolvedAssets.length === 0) {
      return reply.code(400).send({ error: { code: "INVALID_DIRECTOR_REQUEST", message: "未提供有效的素材信息", requestId: request.id } });
    }

    const assetNameHits = detectSensitiveTerms(resolvedAssets.map((asset) => asset.name));
    if (assetNameHits.length > 0) {
      request.log.warn({ userId: user?.id ?? null, scene: "director.assets", hitCount: assetNameHits.length }, "blocked asset name by local preflight");
      return reply.code(422).send({ error: { code: "CONTENT_POLICY_BLOCKED", message: "素材文件名包含平台禁止内容或高风险宣传用语，请调整文件名后重试", requestId: request.id } });
    }    try {
      // 多版成片（批量赛马）：版数先由用户文字/语音转写文本解析；规划接口只生成首版。
      // 后续版本由各自 Worker 使用单版提示词独立补跑，避免一次 LLM 输出 N 份 JSON 造成整批失败。
      const batch = parseBatchVersions(planningPrompt, parsed.data.mode);
      const generatedPlan = await config.directorPlanner.createPlan({
        mode: parsed.data.mode,
        prompt: planningPrompt,
        aspectRatio: parsed.data.aspectRatio,
        assets: resolvedAssets,
      });
      const generatedPlans = [generatedPlan];
      // 内容安检逐版执行：任何一版命中即整体拦截，不放行带风险内容的部分版本。
      for (const generatedPlan of generatedPlans) {
        const generatedHits = detectSensitiveTerms(generatedPlan);
        if (generatedHits.length > 0) {
          request.log.warn({ userId: user?.id ?? null, scene: "director.output", hitCount: generatedHits.length }, "blocked generated content by local preflight");
          return reply.code(422).send({ error: { code: "CONTENT_POLICY_BLOCKED", message: "生成内容包含平台禁止内容或高风险宣传用语，已阻止继续制作，请调整要求后重试", requestId: request.id } });
        }
      }
      // 保留服务端导演遥测（_providerTelemetry 随每版方案下传，任务创建后由 Worker 剥离并校验）。
      // plan 字段返回首版，兼容旧客户端；plans 为批量赛马的全量版本。
      const plans = generatedPlans as unknown as Array<Record<string, unknown>>;
      return reply.send({ plans, plan: plans[0], batch: { total: batch.total } });
    } catch (error) {
      request.log.error({ err: error }, "director planning failed");
      return reply.code(502).send({ error: { code: "DIRECTOR_PROVIDER_ERROR", message: "导演方案暂时生成失败，请稍后重试", requestId: request.id } });
    }
  });
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    const normalized = error instanceof Error ? error : new Error("Unknown request error");
    const candidate = (normalized as Error & { statusCode?: number }).statusCode;
    const status = typeof candidate === "number" && candidate >= 400 && candidate < 500 ? candidate : 500;
    reply.code(status).send({ error: { code: status === 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR", message: status === 500 ? "服务暂时不可用，请稍后重试" : "请求无法处理，请检查输入后重试", requestId: request.id } });
  });
  return app;
}
