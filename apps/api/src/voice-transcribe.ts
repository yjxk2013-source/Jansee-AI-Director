import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AuthStore } from "./auth.js";
import { authenticatedUser } from "./assets.js";
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
    const user = await authenticatedUser(request, options.authStore);
    if (!user) {
      return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
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
