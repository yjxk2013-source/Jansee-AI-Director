import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import { accessSync, constants, existsSync } from "node:fs";
import "./env.js";
import { buildApp } from "./app.js";
import { createOpenAICompatiblePlanner, createHeuristicDirectorPlanner } from "./director.js";
import { checkDatabase, createDatabasePool } from "./database.js";
import { runMigrations } from "./migrate.js";
import { createPgAuthStore } from "./auth-store.js";
import { createPgAssetStore } from "./asset-store.js";
import { createPgJobStore } from "./job-store.js";
import { createPgOutputStore } from "./output-store.js";
import { InMemoryBillingStore } from "./billing.js";
import { createPgBillingStore } from "./billing-store.js";
import { OpcpayService } from "./opcpay.js";
import { createPgGrowthStore } from "./growth-store.js";
import { createMediaRenderer } from "./renderer.js";
import { startJobWorkerLoop } from "./worker.js";
import { createDefaultProductionEngineRegistry } from "./engine-adapters.js";
// @ts-expect-error ffmpeg-kit Auto-QC is a JavaScript workspace module
import { performAutoQc } from "@jansee/ffmpeg-kit/autoQc.mjs";
import { createLocalObjectStorage } from "./storage-local.js";
import { createTencentCosObjectStorage } from "./storage-cos-object.js";
import { cleanupExpiredAssets } from "./assets.js";
import { cleanupExpiredOutputs } from "./outputs.js";
import { cleanupExpiredConversations } from "./conversations.js";
import { createPgSpeechCutStore } from "./speech-cut-store.js";
import { loadTencentVoiceHealth, runTencentVoiceHealthCheck } from "./tts-health.js";
// @ts-ignore sms-kit is a JavaScript workspace package
import { smsStatus } from "@jansee/sms-kit";
// @ts-expect-error video-creator workspace module exposes JavaScript runtime functions
import { runKeepOriginalAsr } from "@jansee/video-creator";
// @ts-expect-error speech-cut workspace module exposes JavaScript runtime functions
import { detectRedundancy } from "@jansee/speech-cut";

const port = Number(process.env.API_PORT ?? 4100);
const host = process.env.API_HOST ?? "127.0.0.1";
const trustProxyIp = process.env.TRUST_PROXY_IP;

/** 以北京时间（Asia/Shanghai）计算下一次凌晨 04:00，避免服务器 UTC 时区造成错时。 */
function millisecondsUntilNextBeijingFour(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  let target = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), 20, 0, 0);
  if (target < now.getTime()) target += 24 * 60 * 60 * 1000;
  return Math.max(1_000, target - now.getTime());
}
if (process.env.NODE_ENV === "production" && (!trustProxyIp || isIP(trustProxyIp) === 0)) {
  throw new Error("TRUST_PROXY_IP must be set to the exact private Nginx container IP in production");
}
const configuredOrigins = process.env.WEB_ORIGINS;
if (process.env.NODE_ENV === "production" && !configuredOrigins) {
  throw new Error("WEB_ORIGINS must be explicitly configured with the production frontend and admin HTTPS origins");
}
const origins = (configuredOrigins ?? "http://localhost:5173,http://127.0.0.1:5173").split(",").map(x => x.trim()).filter(Boolean);
if (process.env.NODE_ENV === "production" && origins.length === 0) throw new Error("WEB_ORIGINS must contain at least one production HTTPS origin");
if (process.env.NODE_ENV === "production") {
  for (const origin of origins) {
    let parsedOrigin: URL;
    try { parsedOrigin = new URL(origin); }
    catch { throw new Error("Every production WEB_ORIGINS entry must be a valid HTTPS origin"); }
    if (parsedOrigin.protocol !== "https:" || parsedOrigin.origin !== origin) {
      throw new Error("Every production WEB_ORIGINS entry must be a canonical HTTPS origin without a path");
    }
  }
}
const adminEmails = (process.env.ADMIN_EMAILS ?? "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
const adminPhones = (process.env.ADMIN_PHONES ?? "").split(",").map(x => x.replace(/\D/g, "")).filter(x => /^1\d{10}$/.test(x));
const directorBaseUrl = process.env.DIRECTOR_API_BASE_URL;
const directorApiKey = process.env.DIRECTOR_API_KEY;
const directorModel = process.env.DIRECTOR_MODEL;
const directorFallbackModels = (process.env.DIRECTOR_FALLBACK_MODELS ?? "").split(",").map((model) => model.trim()).filter(Boolean);
const directorPlanner = directorBaseUrl && directorApiKey && directorModel ? createOpenAICompatiblePlanner({
  baseUrl: directorBaseUrl,
  apiKey: directorApiKey,
  model: directorModel,
  fallbackModels: directorFallbackModels,
  timeoutMs: Number(process.env.DIRECTOR_TIMEOUT_MS ?? 12_000),
  fallbackTimeoutMs: Number(process.env.DIRECTOR_FALLBACK_TIMEOUT_MS ?? 18_000),
  maxTokens: Number(process.env.DIRECTOR_MAX_TOKENS ?? 1_200),
  thinkingBudget: Number(process.env.DIRECTOR_THINKING_BUDGET ?? 512),
}) : undefined;
const effectiveDirectorPlanner = directorPlanner ?? createHeuristicDirectorPlanner();
const databaseUrl = process.env.DATABASE_URL;
const production = process.env.NODE_ENV === "production";
const smsConfiguration = smsStatus();
if (production && (!smsConfiguration.ready || smsConfiguration.mock)) {
  throw new Error("A real Aliyun SMS provider must be configured in production; mock/test SMS mode is forbidden");
}
const databasePrivateNetwork = process.env.DATABASE_PRIVATE_NETWORK === "true";
const databaseHost = databaseUrl ? (() => { try { return new URL(databaseUrl).hostname; } catch { return ""; } })() : "";
if (production && databaseUrl && process.env.DATABASE_SSL !== "true" && !(databasePrivateNetwork && databaseHost === "postgres")) {
  throw new Error("Production PostgreSQL must use TLS unless DATABASE_PRIVATE_NETWORK=true and the host is the private compose postgres service");
}
const databasePoolMax = Math.max(1, Math.min(20, Number.parseInt(process.env.DATABASE_POOL_MAX ?? "10", 10) || 10));
const databasePool = databaseUrl ? createDatabasePool({ connectionString: databaseUrl, ssl: process.env.DATABASE_SSL === "true", maxConnections: databasePoolMax }) : undefined;
if (production && !databasePool) throw new Error("DATABASE_URL is required for production; in-memory persistence is not permitted");
if (production && adminEmails.length === 0 && adminPhones.length === 0) throw new Error("ADMIN_EMAILS or ADMIN_PHONES must contain at least one administrator identity in production");
const payoutEncryptionKey = process.env.PARTNER_PAYOUT_ENCRYPTION_KEY;
if (production && (!payoutEncryptionKey || !/^[a-f0-9]{64}$/i.test(payoutEncryptionKey))) {
  throw new Error("PARTNER_PAYOUT_ENCRYPTION_KEY must be a persistent 64-character hex key in production");
}
if (production && !directorPlanner) throw new Error("DIRECTOR_API_BASE_URL, DIRECTOR_API_KEY and DIRECTOR_MODEL are required for production AI direction");
if (production && directorBaseUrl && new URL(directorBaseUrl).protocol !== "https:") throw new Error("DIRECTOR_API_BASE_URL must use HTTPS in production");
if (production && (!process.env.JX_TTS_TENCENT_SECRET_ID || !process.env.JX_TTS_TENCENT_SECRET_KEY)) throw new Error("JX_TTS_TENCENT_SECRET_ID and JX_TTS_TENCENT_SECRET_KEY are required for production voiceover");
const whisperCli = process.env.JX_WHISPER_CLI;
const whisperModel = process.env.JX_WHISPER_MODEL;
const materialsRoot = process.env.JX_MATERIALS_ROOT;
if (production) {
  if (!whisperCli || !existsSync(whisperCli)) throw new Error("A Linux JX_WHISPER_CLI binary must be provisioned for production speech-cut");
  try { accessSync(whisperCli, constants.X_OK); }
  catch { throw new Error("JX_WHISPER_CLI must be executable in the production container"); }
  if (!whisperModel || !existsSync(whisperModel)) throw new Error("JX_WHISPER_MODEL must be provisioned for production speech-cut");
  if (!materialsRoot || !existsSync(materialsRoot)) throw new Error("JX_MATERIALS_ROOT must exist in production for commercial media assets");
}
const opcpayApiKey = process.env.OPCPAY_API_KEY ?? process.env.opcpay_api_key;
const opcpayWebhookSecret = process.env.OPCPAY_WEBHOOK_SECRET;
const opcpayBaseUrl = process.env.OPCPAY_BASE_URL;
if (production && !opcpayApiKey) throw new Error("OPCPAY_API_KEY is required in production");
// Webhook signing is optional: when no secret is provisioned, signed callbacks fail closed
// and the authenticated periodic OPCPAY order-query sweep remains the settlement path.
if (production && opcpayBaseUrl) {
  let providerUrl: URL;
  try { providerUrl = new URL(opcpayBaseUrl); }
  catch { throw new Error("OPCPAY_BASE_URL must be a valid HTTPS URL in production"); }
  if (providerUrl.protocol !== "https:") throw new Error("OPCPAY_BASE_URL must use HTTPS in production");
}
const mediaDriver = process.env.MEDIA_STORAGE_DRIVER ?? "local";
const mediaRoot = process.env.MEDIA_STORAGE_ROOT;
const mediaCacheRoot = process.env.MEDIA_CACHE_ROOT ?? mediaRoot;
const maxMediaObjectBytes = 200 * 1024 * 1024;
const minMediaFreeBytes = Number(process.env.MEDIA_MIN_FREE_BYTES ?? (1024 * 1024 * 1024));
if (mediaDriver !== "local" && mediaDriver !== "cos") throw new Error("MEDIA_STORAGE_DRIVER must be either local or cos");
if (mediaDriver === "local" && mediaRoot && !isAbsolute(mediaRoot)) throw new Error("MEDIA_STORAGE_ROOT must be an absolute dedicated V4 path");
if (mediaDriver === "cos" && (!mediaCacheRoot || !isAbsolute(mediaCacheRoot))) throw new Error("MEDIA_CACHE_ROOT (or MEDIA_STORAGE_ROOT) must be an absolute local cache path when COS storage is enabled");
if (production && mediaDriver === "local" && !mediaRoot) throw new Error("MEDIA_STORAGE_ROOT must be configured for production local media storage");
if (production && mediaDriver === "cos" && (!process.env.COS_SECRET_ID || !process.env.COS_SECRET_KEY || !process.env.COS_BUCKET || !process.env.COS_REGION)) {
  throw new Error("COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET and COS_REGION are required when MEDIA_STORAGE_DRIVER=cos");
}
if (databasePool) {
  const applied = await runMigrations(databasePool);
  if (applied.length) console.info(`Applied database migrations: ${applied.join(", ")}`);
}
const database = databasePool ? { isHealthy: () => checkDatabase(databasePool), close: () => databasePool.end() } : undefined;
const mediaStorage = mediaDriver === "cos"
  ? (process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY && process.env.COS_BUCKET && process.env.COS_REGION && mediaCacheRoot
      ? createTencentCosObjectStorage({
          secretId: process.env.COS_SECRET_ID,
          secretKey: process.env.COS_SECRET_KEY,
          bucket: process.env.COS_BUCKET,
          region: process.env.COS_REGION,
          cacheRoot: mediaCacheRoot,
          maxObjectBytes: maxMediaObjectBytes,
          minFreeBytes: minMediaFreeBytes,
        })
      : undefined)
  : mediaRoot
    ? createLocalObjectStorage({ rootDir: mediaRoot, maxObjectBytes: maxMediaObjectBytes, minFreeBytes: minMediaFreeBytes })
    : undefined;
if (production && !mediaStorage) throw new Error("A persistent MEDIA_STORAGE_DRIVER and its storage configuration are required in production");
const authStore = databasePool ? createPgAuthStore(databasePool) : undefined;
const assetStore = databasePool ? createPgAssetStore(databasePool) : undefined;
const jobStore = databasePool ? createPgJobStore(databasePool) : undefined;
const outputStore = databasePool ? createPgOutputStore(databasePool) : undefined;
const speechCutStore = databasePool ? createPgSpeechCutStore(databasePool) : undefined;
const billingStore = databasePool ? createPgBillingStore(databasePool) : new InMemoryBillingStore();
const paymentProvider = new OpcpayService({
  ...(opcpayApiKey ? { apiKey: opcpayApiKey } : {}),
  ...(opcpayWebhookSecret ? { webhookSecret: opcpayWebhookSecret } : {}),
  ...(opcpayBaseUrl ? { baseURL: opcpayBaseUrl } : {}),
  ...(databasePool ? { pool: databasePool } : {}),
  billingStore,
});
// Never hold API startup on the remote payment provider. Its read-only capability
// checks run in the background; payment endpoints remain gated by paymentProvider.isReady.
const paymentProviderReady = paymentProvider.isReady;
const growthStore = databasePool ? createPgGrowthStore(databasePool, payoutEncryptionKey) : undefined;
const mediaRenderer = mediaStorage ? createMediaRenderer({ storage: mediaStorage }) : undefined;
const productionEngineRegistry = createDefaultProductionEngineRegistry();

let workerLoop: { stop(): void } | undefined;

const app = buildApp({
  allowedOrigins: origins, logLevel: process.env.LOG_LEVEL ?? "info", production,
  // Trust only the fixed Nginx container IP; never trust arbitrary X-Forwarded-For clients.
  trustProxy: production ? trustProxyIp! : false,
  adminEmails, adminPhones, adminPool: databasePool,
  directorPlanner: effectiveDirectorPlanner,
  directorConfigured: Boolean(directorBaseUrl && directorApiKey && directorModel),
  ...(growthStore ? { growthStore } : {}),
  workerReady: () => Boolean(workerLoop),
  allowPaymentSimulation: !production && process.env.PAY_SIMULATE === "1",
  paymentProviderReady,
  paymentProvider,
  ...(database ? { database } : {}),
  ...(authStore ? { authStore } : {}), ...(assetStore ? { assetStore } : {}), ...(jobStore ? { jobStore } : {}),
  ...(outputStore ? { outputStore } : {}),
  ...(speechCutStore ? { speechCutStore } : {}),
  ...(speechCutStore ? {
    speechCutAnalyzer: async (filePath: string, workDir: string) => runKeepOriginalAsr(filePath, workDir),
    speechCutSuggestionDetector: detectRedundancy,
  } : {}),
  billingStore,
  ...(mediaStorage ? { mediaStorage } : {}),
});

let ttsVoiceHealthTimer: NodeJS.Timeout | undefined;
if (databasePool) {
  const storedVoiceCount = await loadTencentVoiceHealth(databasePool);
  const runVoiceHealthCheck = async (trigger: "startup" | "schedule") => {
    try {
      const result = await runTencentVoiceHealthCheck(databasePool!, trigger);
      if (result.skipped) return;
      const log = result.status === "healthy" ? app.log.info.bind(app.log) : app.log.warn.bind(app.log);
      log({
        totalCount: result.totalCount,
        healthyCount: result.healthyCount,
        unavailableCount: result.unavailableCount,
        unknownCount: result.unknownCount,
        replacementMap: result.replacementMap,
      }, "Tencent TTS voice health check completed");
    } catch (err) {
      app.log.error({ err, trigger }, "Tencent TTS voice health check failed");
    }
  };
  const lastVoiceProbe = await databasePool.query<{ last_completed_at: Date | null }>(
    "SELECT MAX(completed_at) AS last_completed_at FROM tts_voice_probe_runs",
  );
  const lastCompletedAt = lastVoiceProbe.rows[0]?.last_completed_at
    ? new Date(lastVoiceProbe.rows[0].last_completed_at).getTime()
    : 0;
  if (storedVoiceCount === 0 || !lastCompletedAt || Date.now() - lastCompletedAt >= 24 * 60 * 60 * 1000) {
    void runVoiceHealthCheck("startup");
  }
  const scheduleNextVoiceCheck = () => {
    ttsVoiceHealthTimer = setTimeout(async () => {
      await runVoiceHealthCheck("schedule");
      scheduleNextVoiceCheck();
    }, millisecondsUntilNextBeijingFour());
    ttsVoiceHealthTimer.unref?.();
  };
  scheduleNextVoiceCheck();
}

let paymentSweepTimer: NodeJS.Timeout | undefined;
if (paymentProvider.configured) {
  const sweep = async () => {
    try {
      if (!paymentProvider.isReady && !(await paymentProvider.initialize())) return;
      const count = await paymentProvider.sweepPending();
      if (count > 0) app.log.info({ count }, "OPCPAY pending orders reconciled");
    } catch (err) {
      app.log.error({ err }, "OPCPAY pending-order sweep failed");
    }
  };
  void sweep();
  paymentSweepTimer = setInterval(() => { void sweep(); }, 60 * 1000);
  paymentSweepTimer.unref?.();
}

let growthSettlementTimer: NodeJS.Timeout | undefined;
if (growthStore) {
  const settle = () => growthStore.settleEligibleCommissions().then((count) => {
    if (count > 0) app.log.info({ count }, "Partner commissions settled");
  }).catch((err) => app.log.error({ err }, "Partner commission settlement failed"));
  void settle();
  growthSettlementTimer = setInterval(() => { void settle(); }, 15 * 60 * 1000);
  growthSettlementTimer.unref?.();
}

let cleanupTimer: NodeJS.Timeout | undefined;
if ((assetStore || outputStore || databasePool) && mediaStorage) {
  cleanupTimer = setInterval(() => {
    if (assetStore) {
      cleanupExpiredAssets(assetStore, mediaStorage, new Date()).catch((err) => {
        app.log.error({ err }, "Periodic asset cleanup failed");
      });
    }
    if (outputStore) {
      cleanupExpiredOutputs(outputStore, mediaStorage, new Date()).catch((err) => {
        app.log.error({ err }, "Periodic output cleanup failed");
      });
    }
    if (databasePool) {
      cleanupExpiredConversations(databasePool, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)).then((count) => {
        if (count > 0) app.log.info({ count }, "Expired conversations removed");
      }).catch((err) => app.log.error({ err }, "Periodic conversation cleanup failed"));
    }
  }, 60 * 60 * 1000);
  cleanupTimer.unref?.();
}

if (databasePool && mediaStorage && jobStore && assetStore && outputStore && mediaRenderer) {
  workerLoop = startJobWorkerLoop({
    pool: databasePool,
    storage: mediaStorage,
    renderer: mediaRenderer,
    jobStore,
    assetStore,
    outputStore,
    billingStore,
    directorPlanner: effectiveDirectorPlanner,
    engineRegistry: productionEngineRegistry,
    qualityChecker: performAutoQc,
  });
}

try { await app.listen({ port, host }); }
catch (error) { app.log.error(error, "API startup failed"); process.exitCode = 1; }
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => {
  if (ttsVoiceHealthTimer) clearTimeout(ttsVoiceHealthTimer);
  if (paymentSweepTimer) clearInterval(paymentSweepTimer);
  if (growthSettlementTimer) clearInterval(growthSettlementTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (workerLoop) workerLoop.stop();
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
});
