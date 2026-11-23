import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { withDatabaseRetry } from "./database.js";
import type { LocalObjectStorage } from "./storage-local.js";
import type { MediaRenderer, RenderResult } from "./renderer.js";
import type { JobStore, GenerationJobRecord } from "./jobs.js";
import type { AssetStore, AssetRecord } from "./assets.js";
import type { OutputStore } from "./outputs.js";
import { isFreeCreationEntry, type BillingStore } from "./billing.js";
import { DirectorPlanSchema, isDirectorPlanCompatible, type DirectorPlan, type DirectorPlanner } from "./director.js";
import { resolveDirectorRoute } from "./prompt-assembly.js";
import type { ProductionEngineRegistry } from "./engine-registry.js";
import { packagingEnabled } from "./engine-adapters.js";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
// @ts-expect-error video-creator exports its mature JavaScript slicer
import { prepareSlicer, composeSlicer, videoDurationSec } from "@jansee/video-creator/video/slicer.js";
// @ts-expect-error ffmpeg-kit exposes media probing helpers
import { probeVideoSize, hasAudioStream, probeDurationSec } from "@jansee/ffmpeg-kit/probe.mjs";
// @ts-expect-error Auto-QC is a JavaScript workspace package
import { performAutoQc } from "@jansee/ffmpeg-kit/autoQc.mjs";
// @ts-expect-error publish-kit is a JavaScript workspace package
import { sanitizePublish } from "@jansee/publish-kit";
// @ts-expect-error intro-kit exposes composePureCover
import { composePureCover } from "@jansee/intro-kit";
import { prewarmCdnUrls } from "./cdn-prewarm.js";

const requireMod = createRequire(import.meta.url);
const bundledFfmpegPath: string | null = (() => {
  try {
    return requireMod("ffmpeg-static") as string;
  } catch {
    return null;
  }
})();

const WORKER_ID = (hostname() + ":" + process.pid + ":" + randomUUID()).slice(0, 120);
const WORKER_LEASE_SECONDS = 120;
const WORKER_HEARTBEAT_MS = 30_000;
const WORKER_MAX_ATTEMPTS = 3;

function estimateDirectorCostYuan(telemetry: Record<string, unknown>): number | null {
  const model = typeof telemetry.selectedModel === "string" ? telemetry.selectedModel : "";
  if (!model || telemetry.costUsageAvailable !== true) return null;
  const raw = process.env.DIRECTOR_MODEL_PRICING_JSON;
  if (!raw) return null;
  try {
    const pricing = JSON.parse(raw) as Record<string, { inputPerMillionYuan?: number; outputPerMillionYuan?: number }>;
    const price = pricing[model] ?? pricing[String(telemetry.requestedModel ?? "")];
    if (!price) return null;
    const input = Number(price.inputPerMillionYuan);
    const output = Number(price.outputPerMillionYuan);
    const promptTokens = Number(telemetry.promptTokens ?? 0);
    const completionTokens = Number(telemetry.completionTokens ?? 0);
    if (![input, output, promptTokens, completionTokens].every((value) => Number.isFinite(value) && value >= 0)) return null;
    return Number(((promptTokens * input + completionTokens * output) / 1_000_000).toFixed(6));
  } catch {
    return null;
  }
}

export interface WorkerContext {
  pool?: Pool;
  workerId?: string;
  storage: LocalObjectStorage;
  renderer: MediaRenderer;
  jobStore: JobStore;
  assetStore: AssetStore;
  outputStore: OutputStore;
  billingStore?: BillingStore | undefined;
  directorPlanner?: DirectorPlanner | undefined;
  engineRegistry?: ProductionEngineRegistry | undefined;
  /** Production Auto-QC is injected so unit tests can use deterministic media fixtures. */
  qualityChecker?: typeof performAutoQc | undefined;
}

export async function processJob(
  job: GenerationJobRecord,
  context: WorkerContext,
): Promise<boolean> {
  const { jobStore, assetStore, storage, renderer, outputStore } = context;
  console.info(`[Worker-受理 | 任务:${job.id.slice(0, 8)}] 开始处理 模式=${job.mode} 用户=${job.userId.slice(0, 8)}`);
  // E2E 计时起点 = 系统受理任务的时间（worker 领取任务、status→inspecting 时写入 started_at），
  // 而不是用户点“开始创作”的 queued_at。并发受限时排在后面的任务会在队列里等待，
  // 若用 queued_at 会把排队时间算进自己的耗时（第 3/4/5/6 条越来越大）。
  // 历史数据可能没有 started_at，兜底回退 queued_at。
  const e2eStartTime = (job.startedAt ?? job.queuedAt).getTime();
  // 素材按 24 小时时效统一清理（与成片一致），不在任务完成时删除：
  // 赛马多版共享同一批素材，提前删除会让后完成的任务拿不到素材或封面底图。
  const stagedStorageKeys: string[] = [];
  let outputsPublished = false;
  let leaseLost = false;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let activeJob = job;
  // 免费入口任务从未冻结积分，不能走 completeJobAndSettle（生产库会因缺少 hold 抛 BILLING_HOLD_MISSING）。
  const isFreeJob = isFreeCreationEntry(job.requestPayload?.creationScene);
  let llmDurationMs = 0;
  let rendererDurationMs = 0;
  let ffmpegDurationMs = 0;
  let ttsDurationMs = 0;
  let ttsChars = 0;
  let providerTelemetry: Record<string, unknown> = {};
  let qcSummaries: Array<{ grade: string; metrics: Record<string, unknown>; warnings: string[] }> = [];
  let consecutiveHeartbeatFailures = 0;
  if (context.workerId && jobStore.heartbeatJob) {
    const heartbeat = async () => {
      try {
        const owned = await withDatabaseRetry(
          () => jobStore.heartbeatJob!(job.userId, job.id, context.workerId!, WORKER_LEASE_SECONDS),
          { attempts: 3, delayMs: 200 },
        );
        if (owned === false) {
          leaseLost = true;
        } else {
          consecutiveHeartbeatFailures = 0;
        }
      } catch {
        consecutiveHeartbeatFailures += 1;
        // 允许偶发数据库瞬态抖动，仅当连续 4 次心跳失败（超过 2 分钟无法通信）时才认为租约已失
        if (consecutiveHeartbeatFailures >= 4) {
          leaseLost = true;
        }
      }
    };
    void heartbeat().catch(() => { });
    heartbeatTimer = setInterval(() => { void heartbeat().catch(() => { }); }, WORKER_HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  }
  const ensureLease = () => {
    if (leaseLost) throw new Error("WORKER_LEASE_LOST");
  };

  try {
    // 1. inspecting (20%): queued workers may already have atomically claimed this job.
    if (job.status !== "inspecting") {
      await jobStore.updateJobStatus?.(job.userId, job.id, "inspecting", 20, undefined, context.workerId);
    }

    let assets: AssetRecord[] = [];
    if (assetStore.findUserAssets) {
      assets = await assetStore.findUserAssets(job.userId, job.assetIds);
    }
    if (assets.length === 0) {
      throw new Error("No valid assets found for this job");
    }
    console.info(`[Worker-素材 | 任务:${job.id.slice(0, 8)}] 1/4 素材校验通过 (共 ${assets.length} 个素材)`);

    // 2. planning (40%): run the same director used by the planning API and persist its decision.
    await jobStore.updateJobStatus?.(job.userId, job.id, "planning", 40, undefined, context.workerId);
    if (typeof activeJob.directorPlan?.narration === "string") {
      ttsChars = Array.from(activeJob.directorPlan.narration).length;
    }
    const isServerValidatedSpeechCut =
      activeJob.directorPlan?.operation === "speech-cut" &&
      activeJob.directorPlan?._serverValidatedSpeechCut === true &&
      Boolean(activeJob.directorPlan?.speechCut);
    // 执行层铁律（2026-11-22）：只要任务携带了 LLM 正常返回的方案，执行层必须无条件执行！
    // 严禁因格式严苛校验差异而判定无效并二次调用大模型，一条成片严格只调用一次 LLM。
    const clientPlanRaw = activeJob.directorPlan && typeof activeJob.directorPlan === "object"
      ? { ...activeJob.directorPlan }
      : null;
    const clientProviderTelemetry = clientPlanRaw?._providerTelemetry;
    if (clientPlanRaw) {
      delete clientPlanRaw["_providerTelemetry"];
      delete clientPlanRaw["_telemetry"];
    }
    // 方案存在即为真：优先使用标准 Schema 校验结果；若有未知键等轻微格式偏差，执行层直接容错采纳原始方案，严禁重新调用 LLM
    const clientPlanParse = clientPlanRaw ? DirectorPlanSchema.safeParse(clientPlanRaw) : null;
    const hasValidClientPlan = Boolean(
      clientPlanRaw &&
      (clientPlanParse?.success || Array.isArray(clientPlanRaw.scenes) || typeof clientPlanRaw.title === "string" || typeof clientPlanRaw.concept === "string" || typeof clientPlanRaw.narration === "string")
    );
    if (hasValidClientPlan) {
      const plan: DirectorPlan = clientPlanParse?.success
        ? clientPlanParse.data
        : {
          operation: (["standard", "video-slice", "keep-original"].includes(String(clientPlanRaw!.operation))
            ? clientPlanRaw!.operation as "standard" | "video-slice" | "keep-original"
            : "standard"),
          sliceSeconds: Number(clientPlanRaw!.sliceSeconds) > 0 ? Number(clientPlanRaw!.sliceSeconds) : 20,
          title: String(clientPlanRaw!.title || "简兮视频").trim().slice(0, 60) || "简兮视频",
          concept: String(clientPlanRaw!.concept || clientPlanRaw!.title || "简兮商业短视频方案").trim().padEnd(10, "。").slice(0, 500),
          narration: typeof clientPlanRaw!.narration === "string" ? clientPlanRaw!.narration : undefined,
          note: typeof clientPlanRaw!.note === "string" ? clientPlanRaw!.note : undefined,
          scenes: Array.isArray(clientPlanRaw!.scenes) && clientPlanRaw!.scenes.length > 0
            ? clientPlanRaw!.scenes.map((s: any, idx: number) => ({
              order: Number(s?.order) || idx + 1,
              description: String(s?.description || `第${idx + 1}分镜`).trim().slice(0, 180) || `第${idx + 1}分镜`,
              durationSeconds: Number(s?.durationSeconds) > 0 ? Number(s.durationSeconds) : undefined,
              motion: (["sweep_lr", "sweep_rl", "rise_up", "diagonal"].includes(String(s?.motion))
                ? s.motion
                : "sweep_lr"),
            }))
            : [{ order: 1, description: "镜头画面展示", motion: "sweep_lr" as const }],
          style: String(clientPlanRaw!.style || "商业短视频").trim().slice(0, 100),
          soundtrack: String(clientPlanRaw!.soundtrack || "精选配乐").trim().slice(0, 100),
          voice_id: (/^\d{4,9}$/.test(String(clientPlanRaw!.voice_id).trim())
            ? String(clientPlanRaw!.voice_id).trim()
            : "101001"),
          speech_speed: (Number(clientPlanRaw!.speech_speed) >= 0.85 && Number(clientPlanRaw!.speech_speed) <= 1.25)
            ? Number(clientPlanRaw!.speech_speed)
            : 1,
          bgm_emotion: String(clientPlanRaw!.bgm_emotion || "warm").trim().slice(0, 50) || "warm",
          packaging: (clientPlanRaw!.packaging && typeof clientPlanRaw!.packaging === "object")
            ? {
              intro: (clientPlanRaw!.packaging as Record<string, unknown>).intro !== false,
              subtitles: (clientPlanRaw!.packaging as Record<string, unknown>).subtitles !== false,
              bgm: (clientPlanRaw!.packaging as Record<string, unknown>).bgm !== false,
            }
            : { intro: true, subtitles: true, bgm: true },
          publish: (clientPlanRaw!.publish && typeof clientPlanRaw!.publish === "object")
            ? clientPlanRaw!.publish as Record<string, string | undefined>
            : undefined,
          variant_type: typeof clientPlanRaw!.variant_type === "string" ? clientPlanRaw!.variant_type : undefined,
        };
      const planningInput = {
        mode: job.mode, prompt: job.prompt, aspectRatio: job.aspectRatio,
        assets: assets.map((asset) => ({ name: asset.originalName, kind: asset.mediaType, size: asset.sizeBytes })),
      };
      const route = resolveDirectorRoute(planningInput);
      const sourceTelemetry = clientProviderTelemetry && typeof clientProviderTelemetry === "object"
        ? clientProviderTelemetry as Record<string, unknown> : {};
      const planningDurationMs = Array.isArray(sourceTelemetry.modelAttempts)
        ? sourceTelemetry.modelAttempts.reduce<number>((total, attempt) => {
          if (!attempt || typeof attempt !== "object") return total;
          const duration = Number((attempt as Record<string, unknown>).durationMs ?? 0);
          return total + (Number.isFinite(duration) && duration > 0 ? duration : 0);
        }, 0)
        : 0;
      providerTelemetry = {
        ...sourceTelemetry, scene: route.creationScene, sceneSource: route.sceneSource,
        variantMatched: route.decidedVariant ? plan.variant_type === route.decidedVariant : null,
        voiceId: plan.voice_id, voiceType: plan.voice_id,
        providerMode: sourceTelemetry.providerMode ?? "unreported",
        selectedModel: sourceTelemetry.selectedModel ?? null,
        fallbackUsed: sourceTelemetry.fallbackUsed === true,
      };
      const directorPlan = {
        ...plan,
        _telemetry: {
          llmDurationMs: planningDurationMs, ffmpegDurationMs: 0, rendererDurationMs: 0, e2eDurationMs: 0, ttsDurationMs: 0,
          ttsChars: typeof plan.narration === "string" ? Array.from(plan.narration).length : 0,
          providerMode: providerTelemetry.providerMode, requestedModel: providerTelemetry.requestedModel ?? null,
          selectedModel: providerTelemetry.selectedModel ?? null, modelsAttempted: providerTelemetry.modelsAttempted ?? [],
          fallbackUsed: providerTelemetry.fallbackUsed, promptTokens: providerTelemetry.promptTokens ?? 0,
          completionTokens: providerTelemetry.completionTokens ?? 0, tokensUsed: providerTelemetry.totalTokens ?? 0,
          tokenUsageAvailable: providerTelemetry.usageAvailable === true,
          costEstimateYuan: estimateDirectorCostYuan(providerTelemetry),
          costSource: providerTelemetry.usageAvailable !== true ? "usage_unavailable" : providerTelemetry.costUsageAvailable !== true ? "token_breakdown_unavailable" : estimateDirectorCostYuan(providerTelemetry) === null ? "unconfigured" : "director_model_pricing",
          providerFailureReason: providerTelemetry.failureReason ?? null,
          scene: route.creationScene, sceneSource: route.sceneSource, lockedVariant: providerTelemetry.lockedVariant ?? null,
          variantMatched: route.decidedVariant ? plan.variant_type === route.decidedVariant : null,
          modelAttempts: providerTelemetry.modelAttempts ?? [], variantType: plan.variant_type ?? null,
          voiceId: plan.voice_id, voiceType: plan.voice_id, voiceCandidateIds: providerTelemetry.voiceCandidateIds ?? [],
          speechSpeed: plan.speech_speed ?? 1,
        },
      };
      await jobStore.updateDirectorPlan?.(job.userId, job.id, directorPlan, context.workerId);
      activeJob = { ...job, directorPlan };
      ttsChars = typeof plan.narration === "string" ? Array.from(plan.narration).length : 0;
      console.info(`[jansee-director] plan reused job=${job.id} scene=${route.creationScene}/${route.sceneSource} providerMode=${String(providerTelemetry.providerMode)} selectedModel=${String(providerTelemetry.selectedModel ?? "heuristic/unreported")} fallbackUsed=${providerTelemetry.fallbackUsed === true} variant=${String(plan.variant_type ?? "none")} voiceType=${plan.voice_id} candidates=${JSON.stringify(providerTelemetry.voiceCandidateIds ?? [])} attempts=${JSON.stringify(providerTelemetry.modelAttempts ?? [])}`);
    } else {
      // 宪法铁律（2026-11-23）：一条成片严格只调用一次 LLM，杜绝 Worker 后台私自补跑刷爆 Token
      throw new Error("MISSING_DIRECTOR_PLAN: 任务未携带有效导演方案，执行层拒绝后台重复规划");
    }

    console.info(`[Worker-规划 | 任务:${job.id.slice(0, 8)}] 2/4 导演方案就绪 (operation=${String(activeJob.directorPlan?.operation ?? "standard")}, voiceId=${String(activeJob.directorPlan?.voice_id ?? "未定")})`);

    // 3. rendering (70%)
    await jobStore.updateJobStatus?.(job.userId, job.id, "rendering", 70, undefined, context.workerId);
    console.info(`[Worker-渲染 | 任务:${job.id.slice(0, 8)}] 3/4 引擎开始渲染...`);
    const renderStartedAt = Date.now();
    let renderResult: RenderResult | undefined;
    let renderResults: RenderResult[] = [];
    const directorOperation = String(activeJob.directorPlan?.operation ?? "standard");
    if (directorOperation === "video-slice" && job.mode === "video-dub") {
      if (assets.length !== 1 || assets[0]!.mediaType !== "video") throw new Error("VIDEO_SLICE_REQUIRES_ONE_VIDEO");
      const taskDir = await mkdtemp(join(tmpdir(), `jansee-slicer-${job.id}-`));
      try {
        const sourcePath = await storage.getFilePath(assets[0]!.storageKey);
        const sourceDuration = videoDurationSec(sourcePath);
        if (!Number.isFinite(sourceDuration) || sourceDuration <= 0 || sourceDuration > 20 * 60) throw new Error("VIDEO_SLICE_DURATION_UNSUPPORTED: source video must be between 0 and 20 minutes");
        const segmentSeconds = Number(activeJob.directorPlan?.sliceSeconds ?? 20);
        if (!Number.isInteger(segmentSeconds) || segmentSeconds < 5 || segmentSeconds > 120) throw new Error("VIDEO_SLICE_INTERVAL_INVALID: segment interval must be 5 to 120 seconds");
        if (Math.ceil(sourceDuration / segmentSeconds) > 20) throw new Error("VIDEO_SLICE_TOO_MANY: maximum 20 segments per job; increase the segment interval");
        const plan = (activeJob.directorPlan ?? {}) as Record<string, unknown>;
        const packaging = plan.packaging && typeof plan.packaging === "object" ? plan.packaging as Record<string, unknown> : {};
        const subtitlesEnabled = packagingEnabled(packaging.subtitles, job.prompt, "字幕");
        const bgmEnabled = packagingEnabled(packaging.bgm, job.prompt, "背景音乐|BGM|配乐|音乐");
        const prepared = await prepareSlicer({ taskDir, videoFile: sourcePath, segSec: segmentSeconds, transcribe: subtitlesEnabled });
        const composed = await composeSlicer({
          taskDir,
          bgmEnabled,
          subtitlesEnabled,
          segments: prepared.segments.map((segment: Record<string, unknown>) => ({ ...segment, final_text: segment.text ?? "", deleted: [] })),
        });
        const uploadedSliceKeys: string[] = [];
        try {
          for (const slice of composed.slices) {
            const outputPath = path.join(taskDir, "slices", slice.name);
            const fileStat = await stat(outputPath);
            if (!fileStat.size) throw new Error(`VIDEO_SLICE_EMPTY: ${slice.name}`);
            const storageKey = `users/${job.userId}/outputs/${job.id}_slice_${String(slice.index).padStart(3, "0")}`;
            const stored = await storage.putFile(storageKey, outputPath);
            uploadedSliceKeys.push(storageKey);
            stagedStorageKeys.push(storageKey);
            const dimensions = probeVideoSize(outputPath);
            renderResults.push({ storageKey, mimeType: "video/mp4", sizeBytes: stored.sizeBytes, durationMs: Math.round(slice.durationSec * 1000), width: dimensions?.width ?? 1080, height: dimensions?.height ?? 1920 });
          }
        } catch (error) {
          await Promise.all(uploadedSliceKeys.map((key) => storage.deleteObject(key).catch(() => undefined)));
          throw error;
        }
        if (!renderResults.length) throw new Error("VIDEO_SLICE_NO_OUTPUT");
        renderResult = renderResults[0];
      } finally {
        await rm(taskDir, { recursive: true, force: true });
      }
    } else if (context.engineRegistry) {
      const taskDir = await mkdtemp(join(tmpdir(), `jansee-engine-${job.id}-`));
      try {
        const plan = (activeJob.directorPlan ?? {}) as Record<string, unknown>;
        const engineMode = (directorOperation === "keep-original" || directorOperation === "speech-cut") && job.mode === "video-dub" ? "storyboard" : job.mode;
        const engine = context.engineRegistry.resolve(engineMode);
        const engineResult = await engine.execute({
          jobId: job.id,
          userId: job.userId,
          mode: job.mode,
          prompt: job.prompt,
          aspectRatio: job.aspectRatio,
          assetIds: job.assetIds,
          assets,
          storage,
          taskDir,
          directorPlan: plan,
          job: activeJob,
          renderer,
          onProgress: (p) => {
            jobStore.updateJobStatus?.(job.userId, job.id, "rendering", p, undefined, context.workerId).catch(() => { });
          },
        });
        const storageKey = engineResult.storageKey ?? `users/${job.userId}/outputs/${job.id}`;
        const stored = engineResult.storageKey
          ? { sizeBytes: engineResult.sizeBytes ?? 0 }
          : await storage.putFile(storageKey, engineResult.outputPath!);
        if (!stored.sizeBytes) throw new Error("ENGINE_OUTPUT_EMPTY");
        stagedStorageKeys.push(storageKey);
        renderResult = {
          storageKey,
          mimeType: engineResult.mimeType ?? "video/mp4",
          sizeBytes: stored.sizeBytes,
          durationMs: engineResult.durationMs,
          width: engineResult.width ?? 1080,
          height: engineResult.height ?? 1920,
          ...(engineResult.ttsDurationMs !== undefined ? { ttsDurationMs: engineResult.ttsDurationMs } : {}),
          ...(engineResult.ffmpegDurationMs !== undefined ? { ffmpegDurationMs: engineResult.ffmpegDurationMs } : {}),
          ...(engineResult.subtitleTimeline ? { subtitleTimeline: engineResult.subtitleTimeline } : {}),
          ...(engineResult.coverStorageKey ? { coverStorageKey: engineResult.coverStorageKey } : {}),
        };
        renderResults = [renderResult!];
      } finally {
        await rm(taskDir, { recursive: true, force: true });
      }
    } else {
      renderResult = await renderer.render(activeJob, assets, (p) => {
        jobStore.updateJobStatus?.(job.userId, job.id, "rendering", p, undefined, context.workerId).catch(() => { });
      });
      stagedStorageKeys.push(renderResult.storageKey);
      renderResults = [renderResult];
    }
    ensureLease();
    if (!renderResult) throw new Error("RENDER_NO_OUTPUT");
    rendererDurationMs = Date.now() - renderStartedAt;
    ffmpegDurationMs = renderResult.ffmpegDurationMs ?? 0;
    ttsDurationMs = renderResult.ttsDurationMs ?? 0;

    // 4. quality-check (90%)
    await jobStore.updateJobStatus?.(job.userId, job.id, "quality-check", 90, undefined, context.workerId);
    console.info(`[Worker-质检 | 任务:${job.id.slice(0, 8)}] 4/4 渲染完成 (耗时=${rendererDurationMs}ms)，进入成片质检...`);
    if (!renderResult.sizeBytes || renderResult.sizeBytes <= 0) {
      throw new Error("Rendered video file is empty");
    }

    // Validate every deliverable before it becomes visible in the user's works library.
    // Images/video-dub always require audio (TTS); storyboard/slices require it when BGM
    // is enabled or any source video contains an original audio stream.
    if (context.qualityChecker) {
      const plan = (activeJob.directorPlan ?? {}) as Record<string, unknown>;
      const packaging = plan.packaging && typeof plan.packaging === "object"
        ? plan.packaging as Record<string, unknown>
        : {};
      const bgmEnabled = packagingEnabled(packaging.bgm, job.prompt, "背景音乐|BGM|配乐|音乐");
      let sourceHasAudio = false;
      if (job.mode !== "image-film") {
        for (const asset of assets.filter((item) => item.mediaType === "video")) {
          try {
            if (hasAudioStream(await storage.getFilePath(asset.storageKey))) {
              sourceHasAudio = true;
              break;
            }
          } catch {
            // The output QC remains authoritative; a missing source audio stream is not itself fatal.
          }
        }
      }
      const isSpeechOrImageMode = job.mode === "image-film" || (job.mode === "video-dub" && directorOperation !== "video-slice");
      const requireAudio = isSpeechOrImageMode || bgmEnabled || sourceHasAudio;
      for (const output of renderResults.length ? renderResults : [renderResult]) {
        const outputPath = await storage.getFilePath(output.storageKey);
        const qc = await context.qualityChecker(outputPath, { requireAudio, requireUdtaAigc: true, requireContinuousSpeech: directorOperation === 'speech-cut', ...(output.subtitleTimeline ? { subtitleTimeline: output.subtitleTimeline } : {}) });
        qcSummaries.push({
          grade: qc.grade,
          metrics: qc.metrics as Record<string, unknown>,
          warnings: qc.warnings,
        });
        if (!qc.passed) {
          throw new Error("AUTO_QC_REJECTED: generated media failed integrity checks");
        }
      }
    }

    ensureLease();
    // Output records are about to become user-visible; after this point preserve their backing objects on later failures.
    outputsPublished = true;
    // 5. completed (100%)
    const outputsToPersist = renderResults.length ? renderResults : [renderResult];
    for (const output of outputsToPersist) {
      let coverStorageKey = output.coverStorageKey;
      // 统一成片保底：若引擎未生成封面，调用 composePureCover 生成带开场设计的纯净海报（无字幕、无AI标）
      if (!coverStorageKey && output.mimeType === "video/mp4") {
        try {
          const firstAsset = assets[0];
          let bgSource: string | undefined;
          if (firstAsset) {
            try {
              bgSource = await storage.getFilePath(firstAsset.storageKey);
            } catch (_) { }
          }
          if (!bgSource) {
            bgSource = await storage.getFilePath(output.storageKey);
          }
          const tmpCoverDir = await mkdtemp(join(tmpdir(), "jansee-auto-cover-"));
          const tmpCoverPath = join(tmpCoverDir, "cover.jpg");
          const plan = (activeJob.directorPlan ?? {}) as Record<string, unknown>;
          const introTitle = String(
            (plan.publish as Record<string, unknown> | undefined)?.cover_title ||
            plan.intro_title ||
            plan.title ||
            "JANSEE FILM"
          ).trim();
          const introEn = String(plan.intro_en || plan.site || "JANSEE FILM").trim();
          const introNote = String(plan.intro_note || plan.concept || "一席留白 · 静待亲临").trim();
          await composePureCover({
            bgSource,
            title: introTitle,
            brandEn: introEn,
            site: introEn,
            note: introNote,
            idx: "NO. 01 / CINEMATIC COVER",
            width: output.width || 1080,
            height: output.height || 1920,
            outPath: tmpCoverPath,
            captureSec: 1.0,
          });
          if (existsSync(tmpCoverPath)) {
            const key = `users/${job.userId}/covers/${job.id}`;
            await storage.putFile(key, tmpCoverPath);
            coverStorageKey = key;
          }
          await rm(tmpCoverDir, { recursive: true, force: true }).catch(() => undefined);
        } catch (coverErr) {
          console.warn(`[Worker | 任务:${job.id.slice(0, 8)}] 纯净宣发封面保底制作异常:`, coverErr instanceof Error ? coverErr.message : String(coverErr));
        }
      }

      await outputStore.createOutput({
        jobId: job.id,
        userId: job.userId,
        storageKey: output.storageKey,
        mimeType: output.mimeType,
        sizeBytes: output.sizeBytes,
        durationMs: output.durationMs,
        width: output.width,
        height: output.height,
        ...(coverStorageKey ? { coverStorageKey } : {}),
        ...(context.workerId ? { workerId: context.workerId } : {}),
      });
    }

    // 针对端到端视频创作特性：成片完成后立即向腾讯云 CDN 触发边缘预热，用户点击播放即刻命中高速缓存
    const cdnDomain = process.env.COS_CDN_DOMAIN?.trim();
    if (cdnDomain) {
      const urlsToPrewarm = outputsToPersist.map((out) => `https://${cdnDomain}/${out.storageKey}`);
      prewarmCdnUrls(urlsToPrewarm).catch(() => undefined);
    }

    if (activeJob.directorPlan) {
      const plan = activeJob.directorPlan;
      const promptText = job.prompt;
      const scene = /\u95e8\u5e97|\u9910\u996e|\u5b9e\u4f53|\u5230\u5e97|\u7ebf\u4e0b|\u5e97\u94fa|\u672c\u5730\u751f\u6d3b/.test(promptText) ? "local" : /\u4e2a\u4eba|\u53e3\u64ad|\u81ea\u5a92\u4f53|\u535a\u4e3b|\u521b\u4f5c\u8005|\u4e2a\u4eba\u54c1\u724c/.test(promptText) ? "personal" : "sell";
      const publish = sanitizePublish((plan.publish as Record<string, unknown> | undefined) ?? null, {
        scene,
        title: String(plan.title ?? "").trim().slice(0, 24),
        subtitle: String(plan.subtitle ?? "").trim().slice(0, 16),
        coverTitleRequired: true,
      });
      const publishDeliverables = {
        title: publish.title,
        caption: publish.caption,
        cover_title: publish.cover_title,
        pinned_comment: publish.pinned_comment,
        post_time: publish.post_time,
      };
      const previousTelemetry = (plan._telemetry as Record<string, unknown> | undefined) ?? {};
      await jobStore.updateDirectorPlan?.(job.userId, job.id, {
        ...plan,
        publish: publishDeliverables,
        _telemetry: {
          ...previousTelemetry,
          qualityChecks: qcSummaries,
          llmDurationMs,
          ffmpegDurationMs,
          ttsDurationMs,
          rendererDurationMs,
          e2eDurationMs: Date.now() - e2eStartTime,
          ttsChars,
          providerMode: providerTelemetry.providerMode ?? previousTelemetry.providerMode ?? "unreported",
          requestedModel: providerTelemetry.requestedModel ?? previousTelemetry.requestedModel ?? null,
          selectedModel: providerTelemetry.selectedModel ?? previousTelemetry.selectedModel ?? null,
          modelsAttempted: providerTelemetry.modelsAttempted ?? previousTelemetry.modelsAttempted ?? [],
          fallbackUsed: providerTelemetry.fallbackUsed ?? previousTelemetry.fallbackUsed ?? false,
          promptTokens: providerTelemetry.promptTokens ?? previousTelemetry.promptTokens ?? 0,
          completionTokens: providerTelemetry.completionTokens ?? previousTelemetry.completionTokens ?? 0,
          tokensUsed: providerTelemetry.totalTokens ?? previousTelemetry.tokensUsed ?? 0,
          tokenUsageAvailable: providerTelemetry.usageAvailable ?? previousTelemetry.tokenUsageAvailable ?? false,
          costEstimateYuan: estimateDirectorCostYuan(providerTelemetry) ?? previousTelemetry.costEstimateYuan ?? null,
          costSource: providerTelemetry.usageAvailable !== true ? previousTelemetry.costSource ?? "usage_unavailable" : providerTelemetry.costUsageAvailable !== true ? previousTelemetry.costSource ?? "token_breakdown_unavailable" : estimateDirectorCostYuan(providerTelemetry) === null ? previousTelemetry.costSource ?? "unconfigured" : "director_model_pricing",
          qualityPassed: qcSummaries.length > 0,
          qualityCheckCount: qcSummaries.length,
          finishedAt: new Date().toISOString(),
        },
      }, context.workerId);
    }
    // Production PostgreSQL settles the hold and completes the job in one transaction.
    // This prevents a completed job with frozen credits, or a failed job whose credits were already charged.
    if (isFreeJob) {
      await jobStore.updateJobStatus?.(job.userId, job.id, "completed", 100, undefined, context.workerId);
    } else if (context.billingStore?.completeJobAndSettle && context.workerId) {
      await context.billingStore.completeJobAndSettle(job.userId, job.id, context.workerId);
    } else {
      await context.billingStore?.settleCredits(job.userId, job.id);
      await jobStore.updateJobStatus?.(job.userId, job.id, "completed", 100, undefined, context.workerId);
    }
    console.info(`[Worker-完成 | 任务:${job.id.slice(0, 8)}] [SUCCESS] 任务全部完成并交付！总耗时=${Date.now() - e2eStartTime}ms`);
    return true;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const failureStage = error.message.includes("AUTO_QC_REJECTED")
      ? "quality-check(质检)"
      : error.message.includes("ENGINE") || error.message.includes("RENDER") || error.message.includes("FFmpeg")
        ? "rendering(渲染引擎)"
        : activeJob.status === "planning"
          ? "planning(导演策划)"
          : "inspecting(素材检查)";
    console.error(`[Worker-异常 | 任务:${job.id.slice(0, 8)}] [FAIL] 阶段: [${failureStage}] 执行失败:\n  原因: ${error.message}\n  堆栈: ${error.stack ?? "无堆栈"}`);
    if (leaseLost || error.message === "WORKER_LEASE_LOST") return false;
    if (activeJob.directorPlan && jobStore.updateDirectorPlan) {
      const previousTelemetry = (activeJob.directorPlan._telemetry as Record<string, unknown> | undefined) ?? {};
      try {
        await jobStore.updateDirectorPlan(job.userId, job.id, {
          ...activeJob.directorPlan,
          _telemetry: {
            ...previousTelemetry,
            llmDurationMs,
            rendererDurationMs,
            ffmpegDurationMs,
            ttsDurationMs,
            ttsChars,
            e2eDurationMs: Date.now() - e2eStartTime,
            providerMode: providerTelemetry.providerMode ?? previousTelemetry.providerMode ?? "unreported",
            requestedModel: providerTelemetry.requestedModel ?? previousTelemetry.requestedModel ?? null,
            selectedModel: providerTelemetry.selectedModel ?? previousTelemetry.selectedModel ?? null,
            modelsAttempted: providerTelemetry.modelsAttempted ?? previousTelemetry.modelsAttempted ?? [],
            fallbackUsed: providerTelemetry.fallbackUsed ?? previousTelemetry.fallbackUsed ?? false,
            promptTokens: providerTelemetry.promptTokens ?? previousTelemetry.promptTokens ?? 0,
            completionTokens: providerTelemetry.completionTokens ?? previousTelemetry.completionTokens ?? 0,
            tokensUsed: providerTelemetry.totalTokens ?? previousTelemetry.tokensUsed ?? 0,
            tokenUsageAvailable: providerTelemetry.usageAvailable ?? previousTelemetry.tokenUsageAvailable ?? false,
            costEstimateYuan: estimateDirectorCostYuan(providerTelemetry) ?? previousTelemetry.costEstimateYuan ?? null,
            costSource: providerTelemetry.usageAvailable !== true ? previousTelemetry.costSource ?? "usage_unavailable" : providerTelemetry.costUsageAvailable !== true ? previousTelemetry.costSource ?? "token_breakdown_unavailable" : estimateDirectorCostYuan(providerTelemetry) === null ? previousTelemetry.costSource ?? "unconfigured" : "director_model_pricing",
            qualityPassed: qcSummaries.length > 0 ? false : previousTelemetry.qualityPassed ?? false,
            qualityCheckCount: qcSummaries.length,
            providerFailureReason: providerTelemetry.failureReason ?? previousTelemetry.providerFailureReason ?? null,
            qualityChecks: qcSummaries,
            failureStage: error.message.includes("AUTO_QC_REJECTED") ? "quality-check" : error.message.includes("ENGINE") || error.message.includes("RENDER") ? "rendering" : "processing",
            failedAt: new Date().toISOString(),
          },
        }, context.workerId);
      } catch {
        // Telemetry persistence must never prevent failure settlement and credit refunds.
      }
    }
    try {
      await jobStore.updateJobStatus?.(job.userId, job.id, "failed", undefined, {
        code: "RENDER_FAILED",
        message: error.message.slice(0, 500),
      }, context.workerId);
    } catch (statusError) {
      if (statusError instanceof Error && statusError.message === "WORKER_LEASE_LOST") return false;
      throw statusError;
    }
    if (!outputsPublished && stagedStorageKeys.length) {
      await Promise.allSettled(stagedStorageKeys.map((key) => storage.deleteObject(key)));
    }
    // 渲染失败，自动秒级解冻返还预留的 200 积分；免费入口没有冻结，无需返还。
    if (!isFreeJob) await context.billingStore?.refundCredits(job.userId, job.id);
    return false;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

export function buildJobClaimSql(maxAttempts = WORKER_MAX_ATTEMPTS): string {
  return `WITH candidate AS (
    SELECT id
    FROM generation_jobs
    WHERE (
      (status = 'queued' AND attempt_count < ${maxAttempts})
      OR (status IN ('inspecting', 'planning', 'rendering', 'quality-check')
          AND lease_expires_at IS NOT NULL AND lease_expires_at < now() AND attempt_count < ${maxAttempts})
    )
      AND (
        EXISTS (SELECT 1 FROM billing_ledger ledger WHERE ledger.job_id = generation_jobs.id AND ledger.type = 'hold')
        OR generation_jobs.request_payload->>'creationScene' IN ('personal-creation', 'quick-cut')
      )
    ORDER BY
      (COALESCE((
        SELECT CASE membership.tier_id
          WHEN 'ultra' THEN 0
          WHEN 'pro' THEN 1
          WHEN 'plus' THEN 2
          WHEN 'lite' THEN 3
          ELSE 4
        END
        FROM user_memberships membership
        WHERE membership.user_id = generation_jobs.user_id
          AND membership.expires_at > now()
      ), 4) - FLOOR(EXTRACT(EPOCH FROM (now() - queued_at)) / 21600)),
      queued_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE generation_jobs AS job
  SET status = 'inspecting',
      progress = 20,
      worker_id = $1,
      lease_expires_at = now() + interval '${WORKER_LEASE_SECONDS} seconds',
      last_heartbeat_at = now(),
      attempt_count = job.attempt_count + 1,
      error_code = NULL,
      error_message = NULL,
      started_at = COALESCE(job.started_at, NOW()),
      updated_at = NOW()
  FROM candidate
  WHERE job.id = candidate.id
  RETURNING job.id, job.user_id`;
}

export async function processNextQueuedJob(context: WorkerContext): Promise<boolean> {
  if (!context.pool) return false;
  const workerId = context.workerId ?? WORKER_ID;
  const workerContext = context.workerId ? context : { ...context, workerId };

  const client = await context.pool.connect();
  let candidateJobId: string | null = null;
  let candidateUserId: string | null = null;
  let exhaustedJobs: Array<{ id: string; user_id: string }> = [];
  try {
    await client.query("BEGIN");
    const exhausted = await client.query<{ id: string; user_id: string }>(
      `UPDATE generation_jobs
       SET status = 'failed',
           error_code = 'WORKER_ATTEMPTS_EXHAUSTED',
           error_message = '任务执行租约多次过期，已达到最大重试次数',
           finished_at = COALESCE(finished_at, now()),
           worker_id = NULL,
           lease_expires_at = NULL,
           updated_at = now()
       WHERE status IN ('inspecting', 'planning', 'rendering', 'quality-check')
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at < now()
         AND attempt_count >= ${WORKER_MAX_ATTEMPTS}
       RETURNING id, user_id`,
    );
    const refundRetries = await client.query<{ id: string; user_id: string }>(
      `SELECT job.id, job.user_id
       FROM generation_jobs job
       WHERE job.status = 'failed'
         AND job.error_code = 'WORKER_ATTEMPTS_EXHAUSTED'
         AND EXISTS (
           SELECT 1 FROM billing_ledger hold
           WHERE hold.job_id = job.id AND hold.user_id = job.user_id AND hold.type = 'hold'
         )
         AND NOT EXISTS (
           SELECT 1 FROM billing_ledger refunded
           WHERE refunded.job_id = job.id AND refunded.user_id = job.user_id AND refunded.type = 'refund'
         )
       ORDER BY job.updated_at ASC
       LIMIT 100
       FOR UPDATE SKIP LOCKED`,
    );
    exhaustedJobs = [...new Map([...exhausted.rows, ...refundRetries.rows].map((job) => [job.id, job])).values()];
    const res = await client.query<{ id: string; user_id: string }>(buildJobClaimSql(), [workerId]);
    if (res.rows[0]) {
      candidateJobId = res.rows[0].id;
      candidateUserId = res.rows[0].user_id;
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve the original claim error */ }
    throw error;
  } finally {
    client.release();
  }

  for (const expired of exhaustedJobs) {
    if (!workerContext.billingStore) continue;
    try {
      // The recovery transaction has already moved this job to failed; only the
      // idempotent credit refund remains here.
      await workerContext.billingStore.refundCredits(expired.user_id, expired.id);
    } catch (error) {
      console.error("Failed to refund an exhausted worker lease; it will be retried", expired.id, error);
    }
  }
  if (!candidateJobId || !candidateUserId) return exhaustedJobs.length > 0;

  const job = await workerContext.jobStore.findJobById(candidateUserId, candidateJobId);
  if (!job || job.status !== "inspecting") return false;
  return await processJob(job, workerContext);
}

export function startJobWorkerLoop(
  context: WorkerContext,
  pollIntervalMs = 2_000,
  requestedConcurrency = Number(process.env.WORKER_CONCURRENCY ?? 2),
): { stop(): void } {
  // ffmpeg 6.1.3 修复后内存稳定，4C4G 实测可并行两条；默认并发 2，上限 2。
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.min(2, Math.floor(requestedConcurrency)))
    : 2;
  const baseWorkerId = context.workerId ?? WORKER_ID;
  let running = true;
  const timers = new Set<NodeJS.Timeout>();

  function schedule(workerContext: WorkerContext, delayMs: number) {
    if (!running) return;
    const timer = setTimeout(async () => {
      timers.delete(timer);
      if (!running) return;
      try {
        await processNextQueuedJob(workerContext);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("[jansee-worker] worker cycle failed", {
          workerId: workerContext.workerId,
          errorName: error instanceof Error ? error.name : "UnknownError",
          message: detail.slice(0, 500),
        });
      } finally {
        if (running) schedule(workerContext, pollIntervalMs);
      }
    }, delayMs);
    timers.add(timer);
    timer.unref?.();
  }

  // 每个槽位使用独立 workerId，数据库 lease/heartbeat 所有权互不覆盖。
  for (let slot = 0; slot < concurrency; slot += 1) {
    const workerContext = {
      ...context,
      workerId: `${baseWorkerId}:slot-${slot + 1}`.slice(0, 120),
    };
    schedule(workerContext, 100 + slot * 25);
  }

  return {
    stop() {
      running = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

