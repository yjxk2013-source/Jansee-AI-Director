import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { access, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
// @ts-expect-error video-dub is a frozen JavaScript workspace module
import { produceVideoDub } from "@jansee/video-dub";
// @ts-expect-error image-film is a frozen JavaScript workspace module
import { produceImageFilm } from "@jansee/image-film";
// @ts-expect-error ffmpeg-kit is a JavaScript workspace module
import { probeDurationSec, probeVideoSize } from "@jansee/ffmpeg-kit/probe.mjs";
import { BGM, XFADE } from "@jansee/domain";
// @ts-expect-error audio-kit has no bundled type declarations
import { selectBgmByEmotion, buildDuckFilter } from "@jansee/audio-kit";
import { buildTtsAudio } from "@jansee/tts-kit";
// @ts-expect-error subtitle-kit has no bundled type declarations
import { buildDrawtextFilters, resolveObsidianFont } from "@jansee/subtitle-kit";
import type { LocalObjectStorage } from "./storage-local.js";
import type { GenerationJobRecord } from "./jobs.js";
import { detectCreationScene, type CreationScene } from "./prompt-assembly.js";
import type { AssetRecord } from "./assets.js";

const require = createRequire(import.meta.url);
const bundledFfmpeg = require("ffmpeg-static") as string | null;

/**
 * 台词是唯一时间源：把 TTS 实测出的整轨时长，按每句配音的时间窗切成 N 个镜头。
 * 每句说完的那一刻，就是对应镜头叠化切换的时刻；成片总时长 = 真实配音时长。
 * xfade 会吃掉 fadeDuration，所以后续镜头各补回一段，保证输出总长仍与音轨相等。
 */
export function resolveShotDurations(input: {
  shotCount: number;
  cues: Array<{ audioStart: number; audioEnd: number }>;
  speechDurationSec: number;
  fadeDuration: number;
  fallbackClipDuration: number;
}): number[] {
  const count = Math.max(1, Math.floor(input.shotCount));
  const total = Number(input.speechDurationSec);
  if (!input.cues.length || !Number.isFinite(total) || total <= 0) {
    return Array.from({ length: count }, () => input.fallbackClipDuration);
  }
  // 一句台词对应一个镜头；句数不一致时按整轨均分，总时长依然由 TTS 决定。
  const raw = Array.from({ length: count }, (_, index) => {
    if (input.cues.length !== count) return total / count;
    const previousEnd = index === 0 ? 0 : input.cues[index - 1]!.audioEnd;
    return Math.max(0.1, input.cues[index]!.audioEnd - previousEnd);
  });
  const rawSum = raw.reduce((sum, value) => sum + value, 0);
  let net = raw.map((value) => (value / rawSum) * total);
  // 首镜太短会被 xfade 吞掉；从其余镜头按比例匀出 1 秒给它，总时长不变。
  if (net.length > 1 && net[0]! < 1) {
    const restSum = net.slice(1).reduce((sum, value) => sum + value, 0);
    if (restSum > 0) {
      const extra = 1 - net[0]!;
      net = net.map((value, index) => index === 0 ? 1 : value - extra * (value / restSum));
    }
  }
  return net.map((value, index) => value + (index > 0 ? input.fadeDuration : 0));
}

export interface RenderResult {
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number;
  width: number;
  height: number;
  subtitleTimeline?: Array<{ start: number; end: number }>;
  ttsDurationMs?: number;
  ffmpegDurationMs?: number;
  // 引擎生成的纯净宣发封面（无烧录台词、无 AI 角标）存储键，供作品库展示/下载。
  coverStorageKey?: string;
}

/**
 * 把引擎在 taskDir 里生成的纯净封面 cover.jpg 存入对象存储。
 * 引擎（image-film / video-dub）已保证该图不含台词字幕与 AI 角标；
 * 这里只做存在性检查与上传，失败不阻断出片——封面缺失时前端回退到视频截帧。
 */
async function stageCover(
  storage: LocalObjectStorage,
  job: GenerationJobRecord,
  taskDir: string,
): Promise<string | undefined> {
  const coverPath = join(taskDir, "cover.jpg");
  try {
    await access(coverPath);
  } catch {
    return undefined;
  }
  const coverKey = `users/${job.userId}/covers/${job.id}`;
  try {
    await storage.putFile(coverKey, coverPath);
    return coverKey;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[jansee-director] cover upload failed for job=${job.id}: ${message.slice(0, 180)}`);
    return undefined;
  }
}

export interface MediaRenderer {
  render(job: GenerationJobRecord, assets: AssetRecord[], onProgress?: (progress: number) => void): Promise<RenderResult>;
}

export interface VideoDubEngineInput {
  taskId: string;
  taskDir: string;
  videoFile: string;
  cut: Record<string, unknown>;
  voiceId: string;
  scene: string;
}

export interface VideoDubEngineResult {
  outputPath: string;
  videoSec: number;
  timings?: Record<string, number>;
}

export type VideoDubEngine = (input: VideoDubEngineInput) => Promise<VideoDubEngineResult>;

export interface MediaRendererOptions {
  storage: LocalObjectStorage;
  ffmpegPath?: string;
  renderTimeoutMs?: number;
  /** Injectable for deterministic tests; production defaults to the migrated V2 video-dub engine. */
  videoDubEngine?: VideoDubEngine;
}

function resolveDimensions(aspectRatio: string): { width: number; height: number } {
  switch (aspectRatio) {
    case "16:9": return { width: 1920, height: 1080 };
    case "1:1": return { width: 1080, height: 1080 };
    case "4:3": return { width: 1440, height: 1080 };
    case "9:16":
    default:
      return { width: 1080, height: 1920 };
  }
}

export function resolveRendererScene(job: GenerationJobRecord): "personal" | "sell" | "local" {
  const stored = job.requestPayload?.creationScene;
  const scene: CreationScene = stored === "online-ecommerce" || stored === "physical-store" || stored === "personal-creation"
    ? stored
    : stored === "quick-cut"
      ? "personal-creation"
      : /个人|博主|口播|vlog/i.test(job.prompt)
        ? "personal-creation"
        : detectCreationScene(job.prompt, job.mode);
  return scene === "personal-creation" ? "personal" : scene === "online-ecommerce" ? "sell" : "local";
}

export function createMediaRenderer(options: MediaRendererOptions): MediaRenderer {
  const timeoutMs = options.renderTimeoutMs ?? 60_000;

  return {
    async render(job, assets, onProgress) {
      if (assets.length === 0) throw new Error("Cannot render a job with zero assets");
      const renderScene = resolveRendererScene(job);

      // 图片成片优先走 V2 冻结的完整引擎：真实逐镜 TTS、杂志版式、开场、BGM、CTA 片尾及 AI 标识。
      // 开发环境未配置 TTS 时保留通用 FFmpeg 预览；生产启动会强制要求 TTS 凭据。
      if (job.mode === "image-film" && Boolean(process.env.JX_TTS_TENCENT_SECRET_ID && process.env.JX_TTS_TENCENT_SECRET_KEY)) {
        const plan = (job.directorPlan || job.requestPayload?.directorPlan) as Record<string, unknown> | undefined;
        const narration = typeof plan?.narration === "string" ? plan.narration.trim() : "";
        if (assets.some((asset) => asset.mediaType !== "image")) throw new Error("IMAGE_FILM_REQUIRES_IMAGES: 图片成片只接受图片素材");
        if (!narration) throw new Error("DIRECTOR_NARRATION_MISSING: 图片成片缺少导演旁白");
        const voiceId = typeof plan?.voice_id === "string" && /^\d{4,9}$/.test(plan.voice_id) ? plan.voice_id : "";
        const speechSpeed = typeof plan?.speech_speed === "number" ? plan.speech_speed : NaN;
        if (!voiceId || !Number.isFinite(speechSpeed) || speechSpeed < 0.85 || speechSpeed > 1.25) {
          throw new Error("DIRECTOR_VOICE_SPEED_REQUIRED: 图片成片导演方案必须明确提供有效腾讯音色和语速");
        }
        const taskDir = await mkdtemp(join(tmpdir(), `jansee-image-film-${job.id}-`));
        const outputKey = `users/${job.userId}/outputs/${job.id}`;
        try {
          const sentences = narration.split(/(?<=[。！？；，、])/).map((part) => part.trim()).filter(Boolean);
          while (sentences.length < assets.length) {
            const longestIndex = sentences.reduce((best, part, index) => part.length > sentences[best]!.length ? index : best, 0);
            const longest = sentences[longestIndex] || narration;
            const splitAt = Math.max(1, Math.floor(longest.length / 2));
            sentences.splice(longestIndex, 1, longest.slice(0, splitAt), longest.slice(splitAt));
          }
          const shotLines = Array.from({ length: assets.length }, (_, index) => {
            const start = Math.floor(index * sentences.length / assets.length);
            const end = Math.floor((index + 1) * sentences.length / assets.length);
            return sentences.slice(start, Math.max(start + 1, end)).join("");
          });
          const planScenes = Array.isArray(plan?.scenes) ? plan!.scenes as Array<Record<string, unknown>> : [];
          const cut = {
            title: typeof plan?.title === "string" ? plan.title : job.prompt.slice(0, 24),
            // 版式底部说明行（cut.subtitle → T1–T5 版式 note 槽）：由导演方案 note 字段提供（LLM 生成或启发式兜底），
            // 绝不使用 concept——那是给用户看的制作思路，不是画面文案。
            subtitle: typeof plan?.note === "string" ? plan.note.trim().slice(0, 24) : "",
            site: "JANSEE",
            bgm_emotion: typeof plan?.bgm_emotion === "string" ? plan.bgm_emotion : "warm",
            bgm_on: (plan?.packaging as Record<string, unknown> | undefined)?.bgm !== false,
            speech_speed: speechSpeed,
            intro_on: (plan?.packaging as Record<string, unknown> | undefined)?.intro !== false,
            ending_on: true,
            subtitles_on: (plan?.packaging as Record<string, unknown> | undefined)?.subtitles !== false,
            shots: assets.map((_, index) => ({
              asset: index + 1,
              line: shotLines[index] || "",
              side_typo: "",
              climax: index === assets.length - 1,
              // 运镜放权：把导演为每镜编排的 motion ID 透传给引擎。
              // 引擎 imageFilm.js 的 MOTION_MAP 只认 sweep_lr/sweep_rl/rise_up/diagonal，
              // schema 已用 strict enum 约束，这里只做透传；缺失时引擎会按 seed 抽选兜底。
              ...(typeof planScenes[index]?.motion === "string"
                ? { motion: planScenes[index]!.motion } : {}),
            })),
          };
          const result = await (produceImageFilm as (input: Record<string, unknown>) => Promise<{ outputPath: string; videoSec: number; timings?: Record<string, number> }>)({
            taskId: job.id,
            taskDir,
            materials: await Promise.all(assets.map(async (asset) => ({ filePath: await options.storage.getFilePath(asset.storageKey) }))),
            cut,
            voiceId,
            scene: renderScene,
            onStage: (e: { progress?: number }) => {
              if (typeof e?.progress === "number" && onProgress) {
                const scaled = Math.min(89, Math.max(50, 50 + Math.round(e.progress * 0.39)));
                onProgress(scaled);
              }
            },
          });
          const stored = await options.storage.putFile(outputKey, result.outputPath);
          const coverStorageKey = await stageCover(options.storage, job, taskDir);
          const measuredSize = probeVideoSize(result.outputPath);
          const fallbackSize = resolveDimensions(job.aspectRatio);
          return {
            storageKey: outputKey,
            mimeType: "video/mp4",
            sizeBytes: stored.sizeBytes,
            durationMs: Math.round((probeDurationSec(result.outputPath) || result.videoSec) * 1000),
            width: measuredSize?.width || fallbackSize.width,
            height: measuredSize?.height || fallbackSize.height,
            ttsDurationMs: Math.round((result.timings?.tts || 0) * 1000),
            ffmpegDurationMs: Math.round((result.timings?.render || result.timings?.grandTotalSec || 0) * 1000),
            ...(coverStorageKey ? { coverStorageKey } : {}),
          };
        } finally {
          await rm(taskDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }

      // 视频配音必须走 V2 成熟专用引擎：它负责真实 TTS、字幕时间轴、BGM 人声避让、开场与结尾。
      // 不允许把该模式降级到通用 renderer（通用 renderer 不具备等价的音画制作链）。
      if (job.mode === "video-dub") {
        if (assets.length !== 1 || assets[0]!.mediaType !== "video") {
          throw new Error("VIDEO_DUB_REQUIRES_ONE_VIDEO: 视频配音引擎只接受一个视频素材");
        }
        const plan = (job.directorPlan || job.requestPayload?.directorPlan) as Record<string, unknown> | undefined;
        const narration = typeof plan?.narration === "string" ? plan.narration.trim() : "";
        if (!narration) throw new Error("DIRECTOR_NARRATION_MISSING: 视频配音任务缺少可验证的旁白文本");
        const voiceId = typeof plan?.voice_id === "string" && /^\d{4,9}$/.test(plan.voice_id) ? plan.voice_id : "";
        const speechSpeed = typeof plan?.speech_speed === "number" ? plan.speech_speed : NaN;
        if (!voiceId || !Number.isFinite(speechSpeed) || speechSpeed < 0.85 || speechSpeed > 1.25) {
          throw new Error("DIRECTOR_VOICE_SPEED_REQUIRED: 视频配音导演方案必须明确提供有效腾讯音色和语速");
        }

        const taskDir = await mkdtemp(join(tmpdir(), `jansee-video-dub-${job.id}-`));
        const outputKey = `users/${job.userId}/outputs/${job.id}`;
        try {
          const scene = renderScene;
          // 按完整标点切分句子（句号、感叹号、问号或换行），避免把逗号切碎导致停顿堆叠拖长总耗时
          const sentences = narration.split(/(?<=[。！？\n])/).map((part) => part.trim()).filter(Boolean);
          const shots = sentences.length > 0
            ? sentences.map((line) => ({ line, pause_after: 0.15 }))
            : [{ line: narration, pause_after: 0.15 }];
          const cut: Record<string, unknown> = {
            title: typeof plan?.title === "string" ? plan.title : job.prompt.slice(0, 30),
            intro_title: typeof plan?.title === "string" ? plan.title : job.prompt.slice(0, 30),
            intro_en: "JANSEE",
            intro_note: "AI DIRECTOR",
            shots,
            bgm_emotion: typeof plan?.bgm_emotion === "string" ? plan.bgm_emotion : "warm",
            bgm_on: (plan?.packaging as Record<string, unknown> | undefined)?.bgm !== false && plan?.bgm_on !== false,
            speech_speed: speechSpeed,
            intro_on: (plan?.packaging as Record<string, unknown> | undefined)?.intro !== false,
            ending_on: true,
            subtitles_on: (plan?.packaging as Record<string, unknown> | undefined)?.subtitles !== false,
            ...(typeof plan?.end_line === "string" ? { end_line: plan.end_line } : {}),
          };
          const engine = options.videoDubEngine ?? (produceVideoDub as VideoDubEngine);
          const result = await engine({
            taskId: job.id,
            taskDir,
            videoFile: await options.storage.getFilePath(assets[0]!.storageKey),
            cut,
            voiceId,
            scene,
          });
          const stored = await options.storage.putFile(outputKey, result.outputPath);
          const coverStorageKey = await stageCover(options.storage, job, taskDir);
          const measuredSize = probeVideoSize(result.outputPath);
          const fallbackSize = resolveDimensions(job.aspectRatio);
          return {
            storageKey: outputKey,
            mimeType: "video/mp4",
            sizeBytes: stored.sizeBytes,
            durationMs: Math.round((probeDurationSec(result.outputPath) || result.videoSec) * 1000),
            width: measuredSize?.width || fallbackSize.width,
            height: measuredSize?.height || fallbackSize.height,
            ttsDurationMs: Math.round((result.timings?.tts ?? 0) * 1000),
            ffmpegDurationMs: Math.round(((result.timings?.ffmpeg ?? 0) + (result.timings?.concat ?? 0) + (result.timings?.bgm ?? 0)) * 1000),
            ...(coverStorageKey ? { coverStorageKey } : {}),
          };
        } finally {
          await rm(taskDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }

      const { width, height } = resolveDimensions(job.aspectRatio);
      const outputKey = `users/${job.userId}/outputs/${job.id}`;
      const tempOutput = join(tmpdir(), `jansee-render-${job.id}-${randomUUID()}.mp4`);

      // 优先使用 V4 自己安装的 ffmpeg-static，避免依赖开发机的全局 PATH。
      const ffmpegCmd = options.ffmpegPath ?? bundledFfmpeg ?? "ffmpeg";
      let hasFfmpeg = false;
      try {
        await new Promise<void>((resolve, reject) => {
          const check = spawn(ffmpegCmd, ["-version"]);
          check.on("error", reject);
          check.on("close", (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
        });
        hasFfmpeg = true;
      } catch {
        hasFfmpeg = false;
      }

      // 提取导演方案中的分镜节奏与视觉设定
      const planObj = (job.directorPlan || job.requestPayload?.directorPlan) as Record<string, unknown> | undefined;
      const bgmEmotion = typeof planObj?.bgm_emotion === "string" ? planObj.bgm_emotion : "warm";
      const packaging = planObj?.packaging && typeof planObj.packaging === "object"
        ? planObj.packaging as Record<string, unknown>
        : {};
      const narration = typeof planObj?.narration === "string" ? planObj.narration.trim() : "";
      const ttsConfigured = Boolean(process.env.JX_TTS_TENCENT_SECRET_ID && process.env.JX_TTS_TENCENT_SECRET_KEY);

      // 提取导演音色；TTS 实际时长将成为字幕时间轴的唯一依据。
      const voiceId = typeof planObj?.voice_id === "string" && /^\d{4,9}$/.test(planObj.voice_id) ? planObj.voice_id : "";
      const speechSpeed = typeof planObj?.speech_speed === "number" ? planObj.speech_speed : NaN;
      if (ttsConfigured && narration && (!voiceId || !Number.isFinite(speechSpeed) || speechSpeed < 0.85 || speechSpeed > 1.25)) {
        throw new Error("DIRECTOR_VOICE_SPEED_REQUIRED: 导演方案缺少有效腾讯 VoiceType 或导演语速，禁止使用固定默认值");
      }
      const cues: Array<{ content: string; audioStart: number; audioEnd: number }> = [];
      // speechCues 与 cues 同源；speechDurationSec 是 TTS 合成整轨的真实时长（秒）。
      let speechCues: Array<{ content: string; audioStart: number; audioEnd: number }> = [];
      let speechDurationSec = 0;
      // 未配置正式 TTS 时，开发环境允许无旁白预览；生产环境必须拒绝静音成片。
      if (process.env.NODE_ENV === "production" && (!ttsConfigured || !narration)) {
        throw new Error(!ttsConfigured ? "TTS_NOT_CONFIGURED: production requires Tencent TTS credentials" : "DIRECTOR_NARRATION_MISSING: director did not provide narration");
      }

      let ttsWorkDir: string | null = null;
      let voiceTrackPath: string | null = null;
      let ttsDurationMs = 0;
      let ffmpegDurationMs = 0;
      if (hasFfmpeg && ttsConfigured && narration) {
        ttsWorkDir = join(tmpdir(), `jansee-tts-${job.id}-${randomUUID()}`);
        try {
          // 台词是唯一时间源：不传 targetSpanSec，TTS 按自然语速与停顿合成，
          // 下面再用每句实测时间窗反推每个镜头的画面时长，实现真正的音画对齐。
          const ttsStartedAt = Date.now();
          const tts = await buildTtsAudio(ttsWorkDir, narration, voiceId, { speed: speechSpeed });
          ttsDurationMs = Date.now() - ttsStartedAt;
          voiceTrackPath = tts.audioFile;
          speechCues = tts.cues.filter((cue) => cue.audioEnd > cue.audioStart);
          cues.push(...speechCues);
          speechDurationSec = Number(tts.durationSec) > 0
            ? Number(tts.durationSec)
            : (speechCues.at(-1)?.audioEnd ?? 0);
        } catch (error) {
          await rm(ttsWorkDir, { recursive: true, force: true }).catch(() => undefined);
          throw new Error(`TTS_SYNTHESIS_FAILED: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // 没有真实 TTS 时间戳或用户提供的字幕文本时，不把导演分镜描述/用户指令伪装成字幕。
      // 按真实旁白时间窗压低 BGM，句间停顿恢复底乐音量。
      const voiceIntervals = cues.filter((cue) => voiceTrackPath && cue.audioEnd > cue.audioStart).map((cue) => ({ start: cue.audioStart, end: cue.audioEnd }));
      let selectedBgm: { bgmPath: string; filterChain: string; folder: string; track: string } | null = null;
      if (packaging.bgm !== false) {
        try {
          selectedBgm = await selectBgmByEmotion(bgmEmotion, voiceIntervals);
        } catch {
          selectedBgm = null;
        }
      }

      // 生成黑曜石发丝字幕滤镜（70mm 电影工业美学，冷高光钛白字，发丝微光边缘）
      let subtitleFilterText = "";
      try {
        const subFilters = buildDrawtextFilters(packaging.subtitles === false ? [] : cues, undefined, {
          theme: "obsidian_capsule",
          style: "obsidian_hairline",
          shortEdge: Math.min(width, height),
        });
        if (Array.isArray(subFilters) && subFilters.length > 0) {
          subtitleFilterText = subFilters.join(",").replace(/^,+/, "");
        }
      } catch {
        subtitleFilterText = "";
      }

      if (hasFfmpeg) {
        // 调用真实 FFmpeg 执行确定性媒体合成
        try {
          const assetPaths: string[] = [];
          for (const asset of assets) {
            assetPaths.push(await options.storage.getFilePath(asset.storageKey));
          }

          // 构造 FFmpeg 参数，生成安全标准 H.264/AAC MP4 视频，并混合避让 BGM 与发丝字幕
          // 每份素材独立成为一个镜头；台词是唯一时间源，画面时长由该句 TTS 实测时间窗决定。
          const fadeDuration = assets.length > 1 ? XFADE.duration : 0;
          const fallbackClipDuration = assets.length === 1 ? 10 : Math.min(5, 30 / assets.length);
          const clipDurations = resolveShotDurations({
            shotCount: assets.length,
            cues: speechCues,
            speechDurationSec,
            fadeDuration,
            fallbackClipDuration,
          });
          const totalDuration = clipDurations.reduce((sum, duration) => sum + duration, 0) - fadeDuration * Math.max(0, assets.length - 1);
          const args = ["-y", "-threads", "2"];

          for (let index = 0; index < assets.length; index += 1) {
            const duration = clipDurations[index]!;
            if (assets[index]!.mediaType === "image") args.push("-loop", "1");
            else args.push("-stream_loop", "-1");
            args.push("-t", duration.toFixed(3), "-i", assetPaths[index]!);
          }

          const baseVideoFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS`;
          const filterParts: string[] = [];
          for (let index = 0; index < assets.length; index += 1) {
            filterParts.push(`[${index}:v]${baseVideoFilter}[v${index}]`);
          }

          let currentLabel = "v0";
          let currentDuration = clipDurations[0]!;
          for (let index = 1; index < assets.length; index += 1) {
            const nextLabel = `vx${index}`;
            const offset = Math.max(0, currentDuration - fadeDuration);
            filterParts.push(`[${currentLabel}][v${index}]xfade=transition=fade:duration=${fadeDuration.toFixed(3)}:offset=${offset.toFixed(3)}[${nextLabel}]`);
            currentLabel = nextLabel;
            currentDuration += clipDurations[index]! - fadeDuration;
          }

          filterParts.push(`[${currentLabel}]${subtitleFilterText || "null"}[vout]`);

          let nextInputIndex = assets.length;
          const audioLabels: string[] = [];
          if (voiceTrackPath) {
            const voiceIndex = nextInputIndex++;
            args.push("-i", voiceTrackPath);
            filterParts.push(`[${voiceIndex}:a]atrim=duration=${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS,apad=pad_dur=${totalDuration.toFixed(3)}[voice]`);
            audioLabels.push("[voice]");
          }
          if (selectedBgm?.bgmPath) {
            const bgmIndex = nextInputIndex++;
            args.push("-stream_loop", "-1", "-i", selectedBgm.bgmPath);
            const duckFilter = buildDuckFilter(voiceIntervals, BGM.baseVol, BGM.duckVol)
              .replace("[bgm]", `[${bgmIndex}:a]`)
              .replace("[bgmout]", "[bgmduck]");
            const fadeOutStart = Math.max(0, totalDuration - 0.7);
            filterParts.push(`${duckFilter};[bgmduck]atrim=duration=${totalDuration.toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.7[bgmout]`);
            audioLabels.push("[bgmout]");
          }
          if (audioLabels.length === 2) {
            filterParts.push(`${audioLabels.join("")}amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`);
          } else if (audioLabels.length === 1) {
            filterParts.push(`${audioLabels[0]}anull[aout]`);
          }

          args.push(
            "-filter_complex", filterParts.join(";"),
            "-map", "[vout]",
            ...(audioLabels.length ? ["-map", "[aout]", "-c:a", "aac", "-b:a", "160k"] : ["-an"]),
            "-t", totalDuration.toFixed(3),
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "20",
            "-maxrate", "3200k",
            "-bufsize", "6000k",
            "-r", "24",
            "-g", "48",
            "-keyint_min", "48",
            "-sc_threshold", "0",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart+use_metadata_tags",
            "-metadata", "Label=AIGC",
            "-metadata", "ContentProducer=Jansee",
            "-metadata", `ProduceID=${job.id}`,
            "-metadata", "ReservedCode1=JANSEE",
            "-metadata", "title=AI 生成视频 - Jansee",
            "-metadata", `comment=AI-Generated:true; Provider:Jansee; ContentID:${job.id}`,
            "-metadata", "ai_generated=1",
            "-metadata", "provider=Jansee",
            "-metadata", `content_id=${job.id}`,
            tempOutput
          );

          const ffmpegStartedAt = Date.now();
          await new Promise<void>((resolve, reject) => {
            const proc = spawn(ffmpegCmd, args, { windowsHide: true });
            let stderr = "";
            proc.stderr?.setEncoding("utf8");
            proc.stderr?.on("data", (chunk: string) => {
              stderr = (stderr + chunk).slice(-6000);
            });
            const timer = setTimeout(() => {
              proc.kill("SIGKILL");
              reject(new Error("FFmpeg render process timed out"));
            }, timeoutMs);

            proc.on("error", (err) => {
              clearTimeout(timer);
              reject(err);
            });
            proc.on("close", (code) => {
              clearTimeout(timer);
              if (code === 0) resolve();
              else reject(new Error(`FFmpeg exited with error code ${code}: ${stderr}`));
            });
          });

          ffmpegDurationMs = Date.now() - ffmpegStartedAt;
          const stored = await options.storage.putFile(outputKey, tempOutput);
          return {
            storageKey: outputKey,
            mimeType: "video/mp4",
            sizeBytes: stored.sizeBytes,
            durationMs: Math.round(totalDuration * 1000),
            width,
            height,
            ttsDurationMs,
            ffmpegDurationMs,
          };
        } finally {
          await rm(tempOutput, { force: true }).catch(() => undefined);
          if (ttsWorkDir) await rm(ttsWorkDir, { recursive: true, force: true }).catch(() => undefined);
        }
      } else {
        throw new Error("FFMPEG_UNAVAILABLE: refusing to publish a placeholder file as a finished video");
      }
    },
  };
}

