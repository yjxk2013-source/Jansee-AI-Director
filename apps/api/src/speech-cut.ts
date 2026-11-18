import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AuthStore } from "./auth.js";
import { authenticatedUser, type AssetStore } from "./assets.js";
import type { JobStore } from "./jobs.js";
import type { BillingStore } from "./billing.js";
import { GENERATION_COST_CREDITS } from "./billing.js";
import type { LocalObjectStorage } from "./storage-local.js";
import type { SpeechCutStore, SpeechCutSuggestion } from "./speech-cut-store.js";
// @ts-expect-error ffmpeg-kit exports runtime media probes
import { hasAudioStream, probeDurationSec } from "@jansee/ffmpeg-kit/probe.mjs";

const AnalyzeSchema = z.object({ assetId: z.string().uuid() }).strict();
const ConfirmSchema = z.object({
  suggestionIds: z.array(z.string().uuid()).max(1000).refine((ids) => new Set(ids).size === ids.length, "建议不能重复"),
}).strict();
const MAX_SPEECH_SECONDS = 180;

export interface SpeechCutAnalysis {
  text?: string;
  words: Array<{ word: string; start: number; end: number; is_filler?: boolean }>;
}

export interface SpeechCutRoutesOptions {
  authStore: AuthStore;
  assetStore: AssetStore;
  jobStore: JobStore;
  speechCutStore: SpeechCutStore;
  storage: LocalObjectStorage;
  billingStore?: BillingStore;
  allowedOrigins: string[];
  analyzeVideo(filePath: string, workDir: string): Promise<SpeechCutAnalysis>;
  detectSuggestions(words: SpeechCutAnalysis["words"]): Array<Omit<SpeechCutSuggestion, "id">>;
  inspectVideo?(filePath: string): Promise<{ durationSec: number; hasAudio: boolean }> | { durationSec: number; hasAudio: boolean };
}

function safeWords(words: SpeechCutAnalysis["words"]) {
  return (Array.isArray(words) ? words : [])
    .map((word) => ({
      word: String(word.word ?? "").trim().slice(0, 80),
      start: Number(word.start),
      end: Number(word.end),
      is_filler: Boolean(word.is_filler),
    }))
    .filter((word) => word.word && Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end > word.start)
    .sort((a, b) => a.start - b.start);
}

function publicSession(session: Awaited<ReturnType<SpeechCutStore["findSession"]>>) {
  if (!session) return null;
  return {
    id: session.id,
    assetId: session.assetId,
    status: session.status,
    durationSec: session.durationSec,
    transcript: session.transcript,
    words: session.words,
    suggestions: session.suggestions,
    selectedSuggestionIds: session.selectedSuggestionIds,
    jobId: session.jobId,
    errorMessage: session.errorMessage,
    expiresAt: session.expiresAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

export function registerSpeechCutRoutes(app: FastifyInstance, options: SpeechCutRoutesOptions): void {
  app.post("/api/v1/speech-cut/analyze", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (typeof request.headers.origin === "string" && !options.allowedOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    }
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    const parsed = AnalyzeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_SPEECH_CUT_REQUEST" } });
    if (!options.assetStore.findUserAssets) return reply.code(503).send({ error: { code: "ASSET_STORE_UNAVAILABLE" } });

    const assets = await options.assetStore.findUserAssets(user.id, [parsed.data.assetId]);
    const asset = assets[0];
    if (!asset) return reply.code(404).send({ error: { code: "ASSET_NOT_FOUND" } });
    if (asset.mediaType !== "video") return reply.code(400).send({ error: { code: "VIDEO_REQUIRED", message: "语音精剪只支持视频素材" } });

    const session = await options.speechCutStore.createSession(user.id, asset.id);
    void (async () => {
      let workDir: string | null = null;
      try {
        const filePath = await options.storage.getFilePath(asset.storageKey);
        const media = options.inspectVideo
          ? await options.inspectVideo(filePath)
          : { durationSec: probeDurationSec(filePath), hasAudio: hasAudioStream(filePath) };
        if (!media.hasAudio) throw new Error("该视频没有音轨，语音精剪需要原始人声");
        const durationSec = Number(media.durationSec);
        if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("视频时长探测失败，文件可能已损坏");
        if (durationSec > MAX_SPEECH_SECONDS) throw new Error("口播素材暂支持 3 分钟以内，请先缩短素材后重新分析");
        workDir = await mkdtemp(join(tmpdir(), `jansee-speech-cut-${session.id}-`));
        const asr = await options.analyzeVideo(filePath, workDir);
        const words = safeWords(asr.words);
        if (!words.length) throw new Error("未能识别出有效语音内容，请确认视频包含清晰人声");
        const suggestions = options.detectSuggestions(words).map((item) => ({
          id: randomUUID(),
          start: Number(item.start),
          end: Number(item.end),
          word: String(item.word),
          reason: item.reason,
        }));
        await options.speechCutStore.completeAnalysis(user.id, session.id, {
          durationSec,
          transcript: String(asr.text ?? "").slice(0, 20_000),
          words,
          suggestions,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await options.speechCutStore.failAnalysis(user.id, session.id, message).catch(() => undefined);
        app.log.warn({ sessionId: session.id, error: message }, "Speech-cut analysis failed");
      } finally {
        if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    })();

    return reply.code(202).send({ session: { id: session.id, status: "analyzing", expiresAt: session.expiresAt.toISOString() } });
  });

  app.get("/api/v1/speech-cut/:id", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.code(400).send({ error: { code: "INVALID_SESSION_ID" } });
    const session = await options.speechCutStore.findSession(user.id, id);
    if (!session) return reply.code(404).send({ error: { code: "SPEECH_CUT_SESSION_NOT_FOUND" } });
    return reply.send({ session: publicSession(session) });
  });

  app.post("/api/v1/speech-cut/:id/confirm", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (typeof request.headers.origin === "string" && !options.allowedOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    }
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.code(400).send({ error: { code: "INVALID_SESSION_ID" } });
    const parsed = ConfirmSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_CONFIRMATION" } });

    const session = await options.speechCutStore.findSession(user.id, id);
    if (!session) return reply.code(404).send({ error: { code: "SPEECH_CUT_SESSION_NOT_FOUND" } });
    if (session.status === "consumed" && session.jobId) return reply.send({ jobId: session.jobId, status: "queued" });
    if (session.status !== "awaiting_confirmation") {
      return reply.code(409).send({ error: { code: "SPEECH_CUT_NOT_READY", message: "语音分析尚未完成或该任务已提交" } });
    }

    const selectedIds = new Set(parsed.data.suggestionIds);
    const suggestionsById = new Map(session.suggestions.map((suggestion) => [suggestion.id, suggestion]));
    if ([...selectedIds].some((suggestionId) => !suggestionsById.has(suggestionId))) {
      return reply.code(400).send({ error: { code: "UNKNOWN_SPEECH_CUT_SUGGESTION", message: "确认列表包含非服务端生成的建议标识" } });
    }
    const selectedSuggestions = [...selectedIds].map((suggestionId) => suggestionsById.get(suggestionId)!);
    const removedWordCount = session.words.filter((word) => selectedSuggestions.some((item) => item.reason !== "pause" && word.start < item.end && word.end > item.start)).length;
    if (removedWordCount >= session.words.length) {
      return reply.code(400).send({ error: { code: "SPEECH_CUT_ALL_WORDS_REMOVED", message: "不能删除全部口播内容" } });
    }

    if (options.billingStore) {
      const wallet = await options.billingStore.getWallet(user.id);
      if (wallet.availableCredits < GENERATION_COST_CREDITS) {
        return reply.code(402).send({ error: { code: "INSUFFICIENT_CREDITS", availableCredits: wallet.availableCredits, requiredCredits: GENERATION_COST_CREDITS } });
      }
    }

    const claimed = await options.speechCutStore.claimForProduction(user.id, id, [...selectedIds]);
    if (!claimed) return reply.code(409).send({ error: { code: "SPEECH_CUT_ALREADY_SUBMITTED" } });

    let createdJobId: string | null = null;
    try {
      const job = await options.jobStore.createJob(user.id, {
        mode: "video-dub",
        prompt: "根据用户确认的语音精剪建议处理视频，保留原始人声与原始台词。",
        aspectRatio: "9:16",
        assetIds: [session.assetId],
        idempotencyKey: randomUUID(),
        directorPlan: {
          operation: "speech-cut",
          _serverValidatedSpeechCut: true,
          speechCut: {
            durationSec: session.durationSec,
            words: session.words,
            selectedSuggestions,
          },
        },
      });
      createdJobId = job.id;
      await options.billingStore?.holdCredits(user.id, job.id, GENERATION_COST_CREDITS);
      await options.speechCutStore.attachJob(user.id, id, job.id);
      return reply.code(202).send({ jobId: job.id, status: job.status });
    } catch (error) {
      if (createdJobId) {
        await options.jobStore.updateJobStatus?.(user.id, createdJobId, "failed", undefined, {
          code: "SPEECH_CUT_SUBMISSION_FAILED",
          message: error instanceof Error ? error.message.slice(0, 300) : "语音精剪任务提交失败",
        }).catch(() => undefined);
        await options.billingStore?.refundCredits(user.id, createdJobId).catch(() => undefined);
      }
      await options.speechCutStore.releaseClaim(user.id, id).catch(() => undefined);
      const message = error instanceof Error ? error.message : "语音精剪任务提交失败";
      return reply.code(/积分不足/.test(message) ? 402 : 503).send({ error: { code: "SPEECH_CUT_SUBMISSION_FAILED", message } });
    }
  });
}
