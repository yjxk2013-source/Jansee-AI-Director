import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AuthStore } from "./auth.js";
import { authenticatedUser } from "./assets.js";
import { detectMediaMagicBytes } from "./security-shield.js";
// @ts-expect-error keepOriginal is a runtime JS module in video-creator
import { runKeepOriginalAsr } from "@jansee/video-creator/video/keepOriginal.js";

const MAX_VOICE_BYTES = 25 * 1024 * 1024; // 25MB

export interface VoiceTranscribeOptions {
  authStore: AuthStore;
  allowedOrigins: string[];
  transcribeAudio?: (audioPath: string, workDir: string) => Promise<{ text?: string; duration?: number }>;
}

export function registerVoiceTranscribeRoutes(app: FastifyInstance, options: VoiceTranscribeOptions): void {
  app.post("/api/v1/voice/transcribe", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (typeof request.headers.origin === "string" && !options.allowedOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    }
    // 允许已登录用户或访客通过，若未建立会话先返回 401 提示
    const user = await authenticatedUser(request, options.authStore);
    if (!user) {
      return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请刷新页面建立会话后再使用语音识别" } });
    }

    let tempDir: string | null = null;
    try {
      tempDir = await mkdtemp(join(tmpdir(), "jansee-voice-"));
      let audioPath: string | null = null;

      for await (const part of request.parts()) {
        if (part.type !== "file") continue;
        const targetPath = join(tempDir, `input-${randomUUID()}.audio`);
        await pipeline(part.file, createWriteStream(targetPath, { flags: "wx", mode: 0o600 }));
        if (part.file.truncated) {
          return reply.code(413).send({ error: { code: "FILE_TOO_LARGE", message: "录音文件过大" } });
        }
        audioPath = targetPath;
        break; // 只处理单个录音文件
      }

      if (!audioPath) {
        return reply.code(400).send({ error: { code: "NO_AUDIO_FILE", message: "未收到录音数据" } });
      }

      const fileInfo = await stat(audioPath);
      if (fileInfo.size <= 0) {
        return reply.code(400).send({ error: { code: "EMPTY_AUDIO", message: "录音文件为空" } });
      }
      if (fileInfo.size > MAX_VOICE_BYTES) {
        return reply.code(413).send({ error: { code: "FILE_TOO_LARGE", message: "录音文件超过大小限制" } });
      }

      // 魔数检测：确保上传的为合法音频格式（WAV, WebM, OGG, MP3, MP4/M4A, AAC 等）
      const handle = await import("node:fs/promises");
      const fileHandle = await handle.open(audioPath, "r");
      const head = Buffer.alloc(32);
      try {
        await fileHandle.read(head, 0, 32, 0);
      } finally {
        await fileHandle.close();
      }
      const detected = detectMediaMagicBytes(head);
      if (!detected || (detected.mediaType !== "audio" && detected.mediaType !== "video")) {
        return reply.code(415).send({ error: { code: "UNSUPPORTED_AUDIO_FORMAT", message: "录音文件格式无法识别或不受支持" } });
      }

      // 根据识别出的真实类型赋予标准化文件扩展名，确保 FFmpeg 解封装准确无误
      let normalizedExt = "mp4";
      if (detected.mimeType.includes("wav")) normalizedExt = "wav";
      else if (detected.mimeType.includes("webm")) normalizedExt = "webm";
      else if (detected.mimeType.includes("ogg")) normalizedExt = "ogg";
      else if (detected.mimeType.includes("mpeg")) normalizedExt = "mp3";
      else if (detected.mimeType.includes("flac")) normalizedExt = "flac";
      else if (detected.mimeType.includes("aac")) normalizedExt = "aac";

      const typedAudioPath = join(tempDir, `recording-input.${normalizedExt}`);
      await handle.rename(audioPath, typedAudioPath);
      audioPath = typedAudioPath;

      const workDir = join(tempDir, "whisper-work");
      const asr = options.transcribeAudio
        ? await options.transcribeAudio(audioPath, workDir)
        : await runKeepOriginalAsr(audioPath, workDir);
      const transcript = String(asr?.text || "").trim();

      return reply.send({
        text: transcript,
        durationSec: asr?.duration || 0,
      });
    } catch (error) {
      request.log.error({ err: error }, "voice transcription failed via whisper");
      return reply.code(500).send({
        error: {
          code: "WHISPER_TRANSCRIPTION_FAILED",
          message: "语音识别失败，请稍后重试",
        },
      });
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });
}
