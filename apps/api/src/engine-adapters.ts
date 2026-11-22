import path from "node:path";
import { access } from "node:fs/promises";
import { createProductionEngineRegistry, type ProductionEngine } from "./engine-registry.js";
// @ts-expect-error workspace package is JavaScript with runtime exports
import { composeStoryboard, runKeepOriginalAsr } from "@jansee/video-creator";
// @ts-expect-error workspace package is JavaScript with runtime exports
import { appendEndingTail } from "@jansee/ending-kit";
// @ts-expect-error workspace package is JavaScript with runtime exports
import { renderIntroPng, composePureCover } from "@jansee/intro-kit";
// @ts-expect-error workspace package is JavaScript with runtime exports
import { selectBgmByEmotion } from "@jansee/audio-kit/bgm.js";
// @ts-expect-error workspace package is JavaScript with runtime exports
import { probeVideoSize } from "@jansee/ffmpeg-kit/probe.mjs";
// @ts-expect-error speech-cut workspace package exposes JavaScript runtime functions
import { composeSpeechcut } from "@jansee/speech-cut";

function sceneForPrompt(prompt: string): "sell" | "local" | "personal" {
  if (/门店|餐饮|实体|到店|线下|店铺|本地生活/.test(prompt)) return "local";
  if (/个人|口播|自媒体|博主|创作者|个人品牌/.test(prompt)) return "personal";
  return "sell";
}

export function explicitlyDisabled(prompt: string, terms: string): boolean {
  const stop = "(?:不要|不需要|不加|取消|去掉|关闭|省略|无需)";
  // Respect sentence boundaries: “保留结尾，不需要字幕” must not disable the ending.
  const bridge = "[^，。；！？,;.!?]{0,6}";
  return new RegExp(`(?:${stop})${bridge}(?:${terms})|(?:${terms})${bridge}(?:${stop})`, "i").test(prompt);
}

/** A user's explicit opt-out always wins; otherwise honor the structured DirectorPlan. */
export function packagingEnabled(value: unknown, prompt: string, terms: string): boolean {
  return value !== false && !explicitlyDisabled(prompt, terms);
}

function canvasFor(aspectRatio: string) {
  switch (aspectRatio) {
    case "16:9": return { width: 1920, height: 1080 };
    case "1:1": return { width: 1080, height: 1080 };
    case "4:3": return { width: 1440, height: 1080 };
    default: return { width: 1080, height: 1920 };
  }
}

const storyboardEngine: ProductionEngine = {
  id: "storyboard",
  async execute(context) {
    const plan = context.directorPlan;
    const packaging = plan.packaging && typeof plan.packaging === "object"
      ? plan.packaging as Record<string, unknown>
      : {};
    const videoAssets = context.assets.filter((asset) => asset.mediaType === "video");
    const speechCut = plan.operation === "speech-cut";
    const keepOriginal = plan.operation === "keep-original" || speechCut;
    if (videoAssets.length < (keepOriginal ? 1 : 2)) throw new Error(keepOriginal ? "KEEP_ORIGINAL_REQUIRES_ONE_VIDEO" : "STORYBOARD_REQUIRES_TWO_VIDEOS");
    if (context.aspectRatio !== "9:16" && context.aspectRatio !== "16:9" && context.aspectRatio !== "1:1" && context.aspectRatio !== "4:3") {
      throw new Error("STORYBOARD_ASPECT_RATIO_UNSUPPORTED");
    }
    const warnings: string[] = [];
    const narration = typeof plan.narration === "string" ? plan.narration.trim() : "";
    const isTtsMode = Boolean(narration && !keepOriginal);

    let shotLines: string[] = [];
    if (isTtsMode) {
      const sentences = narration.split(/(?<=[。！？；，、])/).map((part) => part.trim()).filter(Boolean);
      while (sentences.length < videoAssets.length) {
        const longestIndex = sentences.reduce((best, part, index) => part.length > (sentences[best] || "").length ? index : best, 0);
        const longest = sentences[longestIndex] || narration;
        const splitAt = Math.max(1, Math.floor(longest.length / 2));
        sentences.splice(longestIndex, 1, longest.slice(0, splitAt), longest.slice(splitAt));
      }
      shotLines = Array.from({ length: videoAssets.length }, (_, index) => {
        const start = Math.floor(index * sentences.length / videoAssets.length);
        const end = Math.floor((index + 1) * sentences.length / videoAssets.length);
        return sentences.slice(start, Math.max(start + 1, end)).join("");
      });
    }

    const shots = await Promise.all(videoAssets.map(async (asset, idx) => ({
      mediaType: "video" as const,
      file: await context.storage.getFilePath(asset.storageKey),
      text: shotLines[idx] || "",
    })));

    if (speechCut) {
      if (context.directorPlan._serverValidatedSpeechCut !== true || !context.directorPlan.speechCut || typeof context.directorPlan.speechCut !== "object") {
        throw new Error("SPEECH_CUT_PLAN_NOT_SERVER_VALIDATED");
      }
      const saved = context.directorPlan.speechCut as Record<string, unknown>;
      const words = Array.isArray(saved.words) ? saved.words : [];
      const selected = Array.isArray(saved.selectedSuggestions) ? saved.selectedSuggestions as Array<Record<string, unknown>> : [];
      if (!words.length) throw new Error("SPEECH_CUT_WORDS_MISSING");
      const wordEntries = words as Array<{ start: number; end: number }>;
      const deletedStarts = new Set(wordEntries.filter((word) => selected.some((item) => item.reason !== "pause" && Number(word.start) < Number(item.end) && Number(word.end) > Number(item.start))).map((word) => Number(word.start)));
      const pauseCuts = selected.filter((item) => item.reason === "pause").map((item) => ({ start: Number(item.start), end: Number(item.end) })).filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start);
      const subtitlesEnabled = packagingEnabled(packaging.subtitles, context.prompt, "字幕");
      const bgmEnabled = packagingEnabled(packaging.bgm, context.prompt, "背景音乐|BGM|配乐|音乐");
      const canvas = canvasFor(context.aspectRatio);
      const introPath = path.join(context.taskDir, "intro.png");
      let introFile: string | undefined;
      if (packagingEnabled(packaging.intro, context.prompt, "开场|片头")) {
        try {
          renderIntroPng({
            title: String(plan.title || "JANSEE"),
            brandEn: "JANSEE",
            site: "JANSEE",
            note: "AI DIRECTOR",
            idx: "JANSEE FILM",
            width: canvas.width,
            height: canvas.height,
            outPath: introPath,
          });
          await access(introPath);
          introFile = introPath;
        } catch (error) {
          warnings.push(`INTRO_UNAVAILABLE: ${error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180)}`);
        }
      }
      const composed = await composeSpeechcut({
        videoFile: shots[0]!.file,
        taskDir: context.taskDir,
        words,
        deletedStarts,
        durationSec: Number(saved.durationSec),
        pauseCuts,
        introFile,
        subtitlesEnabled,
        bgmEnabled,
      });
      // 合规收束卡是交付硬约束；CTA 文案可变，但不能省略结尾收束。
      const endingEnabled = true;
      const tailed = await appendEndingTail({
        workDir: context.taskDir,
        videoFile: composed.finalPath,
        outPath: path.join(context.taskDir, "final_with_ending.mp4"),
        taskId: context.jobId,
        scene: sceneForPrompt(context.prompt),
        brandZh: "简兮",
        brandEn: "JANSEE",
      });
      if (endingEnabled && !tailed) warnings.push("ENDING_UNAVAILABLE: 片尾卡生成失败，已保留主体成片");
      const outputPath = tailed?.output || composed.finalPath;
      const size = probeVideoSize(outputPath);
      return {
        outputPath,
        durationMs: Math.round(Number((tailed?.durationSec || composed.durationSec) * 1000)),
        width: size?.width || canvas.width,
        height: size?.height || canvas.height,
        warnings,
        subtitleTimeline: subtitlesEnabled ? (composed.subtitleTimeline ?? []) : [],
      };
    }

    // 原声路径使用本地 Whisper；Whisper 不可用时保留原声继续出片，但绝不伪造字幕。
    const subtitlesEnabled = packagingEnabled(packaging.subtitles, context.prompt, "字幕");
    const subtitles = !subtitlesEnabled
      ? shots.map(() => ({ words: [], deleted: [], finalText: "" }))
      : await Promise.all(shots.map(async (shot, index) => {
          try {
            const asr = await runKeepOriginalAsr(shot.file, path.join(context.taskDir, `asr-${index + 1}`));
            return { words: asr.words, deleted: [], finalText: asr.text };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn("[jansee-director] local ASR unavailable; original audio will be preserved without captions for shot", index + 1, message);
            warnings.push(`ASR_UNAVAILABLE_SHOT_${index + 1}: ${message.slice(0, 180)}`);
            return { words: [], deleted: [], finalText: "" };
          }
        }));

    const emotion = String(plan.bgm_emotion || "warm");
    let bgmPath = "";
    if (packagingEnabled(packaging.bgm, context.prompt, "背景音乐|BGM|配乐")) {
      try {
        const picked = await selectBgmByEmotion(emotion, []);
        if (picked?.bgmPath) bgmPath = picked.bgmPath;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[jansee-director] BGM selection unavailable", message);
        warnings.push(`BGM_UNAVAILABLE: ${message.slice(0, 180)}`);
      }
    }

    const canvas = canvasFor(context.aspectRatio);
    const introPath = path.join(context.taskDir, "intro.png");
    let introFile: string | undefined;
    if (packagingEnabled(packaging.intro, context.prompt, "开场|片头")) {
      try {
        renderIntroPng({
          title: String(plan.title || "JANSEE"),
          brandEn: "JANSEE",
          site: "JANSEE",
          note: "AI DIRECTOR",
          idx: "JANSEE FILM",
          width: canvas.width,
          height: canvas.height,
          outPath: introPath,
        });
        await access(introPath);
        introFile = introPath;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[jansee-director] storyboard intro generation unavailable", message);
        warnings.push(`INTRO_UNAVAILABLE: ${message.slice(0, 180)}`);
      }
    }

    const voiceId = typeof plan.voice_id === "string" && /^\d{4,9}$/.test(plan.voice_id) ? plan.voice_id : "";
    const speechSpeed = typeof plan.speech_speed === "number" ? plan.speech_speed : NaN;
    if (!voiceId || !Number.isFinite(speechSpeed) || speechSpeed < 0.85 || speechSpeed > 1.25) {
      throw new Error("DIRECTOR_VOICE_SPEED_REQUIRED: 分镜导演方案必须明确提供有效腾讯音色和语速");
    }
    console.info(`[VideoEngine-分镜 | 任务:${context.jobId.slice(0, 8)}] 开始分镜合成 (镜头数=${shots.length}, 音色=${voiceId}, 语速=${speechSpeed})`);
    const result = await composeStoryboard({
      taskDir: context.taskDir,
      shots,
      autoMode: isTtsMode ? "tts" : "asr",
      voiceId,
      speed: speechSpeed,
      bgmPath,
      subtitles,
      introFile,
      aspectRatio: context.aspectRatio,
      keepOriginalAudio: keepOriginal,
    });

    const tailed = await appendEndingTail({
          workDir: context.taskDir,
          videoFile: result.output,
          outPath: path.join(context.taskDir, "final_with_ending.mp4"),
          taskId: context.jobId,
          scene: sceneForPrompt(context.prompt),
          brandZh: "简兮",
          brandEn: "JANSEE",
        });
    if (!tailed) {
      warnings.push("ENDING_UNAVAILABLE: 片尾卡生成失败，已保留主体成片");
    }
    const outputPath = tailed?.output || result.output;
    const size = probeVideoSize(outputPath);

    // 纯净宣发封面海报：基于首镜原视频纯净原画 + 开场排版设计 + 100%纯黑羽化遮罩，绝不含台词字幕与AI标识
    let coverStorageKey: string | undefined;
    const coverPath = path.join(context.taskDir, "cover.jpg");
    try {
      const introTitle = String(
        (plan.publish as Record<string, unknown> | undefined)?.cover_title ||
        plan.intro_title ||
        plan.title ||
        "JANSEE FILM"
      ).trim();
      const introEn = String(plan.intro_en || plan.site || "JANSEE FILM").trim();
      const introNote = String(plan.intro_note || plan.concept || "一席留白 · 静待亲临").trim();
      await composePureCover({
        bgSource: shots[0]!.file,
        title: introTitle,
        brandEn: introEn,
        site: introEn,
        note: introNote,
        idx: `NO. 01 / ${String(shots.length).padStart(2, "0")} SHOTS`,
        width: size?.width || canvas.width,
        height: size?.height || canvas.height,
        outPath: coverPath,
        captureSec: 1.0,
      });
      const key = `users/${context.userId}/covers/${context.jobId}`;
      await context.storage.putFile(key, coverPath);
      coverStorageKey = key;
    } catch (covErr) {
      console.warn("[storyboard] 纯净封面海报生成异常(非阻断):", covErr);
    }

    return {
      outputPath,
      durationMs: Math.round(Number(tailed?.durationSec || result.durationSec || 0) * 1000),
      width: size?.width || 1080,
      height: size?.height || 1920,
      warnings,
      ...(coverStorageKey ? { coverStorageKey } : {}),
    };
  },
};

function createRendererEngine(id: "image-film" | "video-dub"): ProductionEngine {
  return {
    id,
    async execute(context) {
      console.info(`[VideoEngine-${id} | 任务:${context.jobId.slice(0, 8)}] 引擎开始执行渲染...`);
      const job = { ...context.job, directorPlan: context.directorPlan };
      const rendered = await context.renderer.render(job, [...context.assets], context.onProgress);
      return {
        storageKey: rendered.storageKey,
        sizeBytes: rendered.sizeBytes,
        ...(rendered.mimeType === "video/mp4" ? { mimeType: "video/mp4" as const } : {}),
        durationMs: rendered.durationMs,
        width: rendered.width,
        height: rendered.height,
        ...(rendered.ttsDurationMs !== undefined ? { ttsDurationMs: rendered.ttsDurationMs } : {}),
        ...(rendered.ffmpegDurationMs !== undefined ? { ffmpegDurationMs: rendered.ffmpegDurationMs } : {}),
        ...(rendered.coverStorageKey ? { coverStorageKey: rendered.coverStorageKey } : {}),
      };
    },
  };
}

export function createDefaultProductionEngineRegistry() {
  return createProductionEngineRegistry([
    createRendererEngine("image-film"),
    createRendererEngine("video-dub"),
    storyboardEngine,
  ]);
}
