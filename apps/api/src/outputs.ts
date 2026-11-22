import { createReadStream, existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthStore } from "./auth.js";
import { authenticatedUser } from "./assets.js";
import type { ObjectStorage } from "./storage-local.js";

const requireMod = createRequire(import.meta.url);
const bundledFfmpegPath: string | null = (() => {
  try {
    return requireMod("ffmpeg-static") as string;
  } catch {
    return null;
  }
})();

export interface WorkAssetSummary {
  assetId: string;
  name?: string;
  kind?: "image" | "video";
  size?: number;
}

export interface OutputRecord {
  id: string;
  jobId: string;
  userId: string;
  storageKey: string;
  coverStorageKey?: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  status: string;
  createdAt: Date;
  expiresAt: Date | null;
  title?: string | null;
  publish?: {
    caption?: string;
    cover_title?: string;
    pinned_comment?: string;
    post_time?: string;
  } | null;
  directorPlan?: Record<string, unknown> | null;
  assets?: WorkAssetSummary[];
}

export interface NewOutput {
  id?: string;
  jobId: string;
  userId: string;
  storageKey: string;
  coverStorageKey?: string;
  mimeType?: string;
  sizeBytes: number;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  expiresAt?: Date | null;
  workerId?: string;
}

export interface OutputStore {
  createOutput(output: NewOutput): Promise<OutputRecord>;
  listUserOutputs(userId: string): Promise<OutputRecord[]>;
  findOutputById(userId: string, outputId: string): Promise<OutputRecord | null>;
  findOutputCoverById?(userId: string, outputId: string): Promise<{ coverStorageKey: string } | null>;
  incrementDownloadCount?(userId: string, outputId: string): Promise<void>;
  findExpiredOutputs?(now: Date, limit?: number): Promise<Array<{ id: string; storageKey: string }>>;
  markOutputExpired?(outputId: string, now: Date): Promise<void>;
}

export async function cleanupExpiredOutputs(
  store: OutputStore,
  storage: ObjectStorage,
  now = new Date(),
): Promise<number> {
  if (!store.findExpiredOutputs || !store.markOutputExpired) return 0;
  const expired = await store.findExpiredOutputs(now, 100);
  let removed = 0;
  for (const output of expired) {
    try {
      await storage.deleteObject(output.storageKey);
      await store.markOutputExpired(output.id, now);
      removed += 1;
    } catch {
      // Keep the row eligible for the next cleanup pass if either operation fails.
    }
  }
  return removed;
}

export interface OutputRoutesOptions {
  authStore: AuthStore;
  outputStore: OutputStore;
  storage: ObjectStorage;
  allowedOrigins: string[];
}

export function registerOutputRoutes(app: FastifyInstance, options: OutputRoutesOptions): void {
  app.get("/api/v1/works", async (request, reply) => {
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });

    const outputs = await options.outputStore.listUserOutputs(user.id);
    return reply.header("cache-control", "no-store").send({
      works: outputs.map((out) => ({
        id: out.id,
        jobId: out.jobId,
        title: out.title ?? null,
        publish: out.publish ?? null,
        directorPlan: out.directorPlan ?? null,
        assets: out.assets ?? [],
        coverUrl: (out.coverStorageKey || out.mimeType === "video/mp4") ? `/api/v1/works/${out.id}/cover` : null,
        mimeType: out.mimeType,
        sizeBytes: out.sizeBytes,
        durationMs: out.durationMs,
        width: out.width,
        height: out.height,
        status: out.status,
        createdAt: out.createdAt.toISOString(),
        expiresAt: out.expiresAt?.toISOString() ?? null,
      })),
    });
  });

  app.get("/api/v1/works/:id", async (request, reply) => {
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return reply.code(400).send({ error: { code: "INVALID_OUTPUT_ID", message: "作品 ID 格式无效" } });
    }
    const output = await options.outputStore.findOutputById(user.id, id);
    if (!output) {
      return reply.code(404).send({ error: { code: "WORK_NOT_FOUND", message: "作品不存在或已过期" } });
    }
    return reply.header("cache-control", "no-store").send({ work: output });
  });

  // 纯净宣发封面（无烧录台词、无 AI 角标）。与视频预览一致，登录用户可读自己的封面。
  app.get("/api/v1/works/:id/cover", async (request, reply) => {
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return reply.code(400).send({ error: { code: "INVALID_OUTPUT_ID" } });
    }
    let coverKey = "";
    if (options.outputStore.findOutputCoverById) {
      const cover = await options.outputStore.findOutputCoverById(user.id, id);
      if (cover?.coverStorageKey) coverKey = cover.coverStorageKey;
    }
    const output = await options.outputStore.findOutputById(user.id, id);
    if (!coverKey && output?.coverStorageKey) {
      coverKey = output.coverStorageKey;
    }

    // 动态抽帧保底：针对历史作品或未生成封面的视频成片，现场提取首帧并缓存，杜绝 404 黑屏
    if (!coverKey && output && output.mimeType === "video/mp4") {
      try {
        const cacheDir = join(tmpdir(), "jansee-work-covers");
        await mkdir(cacheDir, { recursive: true });
        const cachedCoverPath = join(cacheDir, `${id}.jpg`);
        if (!existsSync(cachedCoverPath)) {
          const videoFilePath = await options.storage.getFilePath(output.storageKey);
          const ffmpegBin = process.env.FFMPEG_PATH || bundledFfmpegPath || "ffmpeg";
          try {
            execFileSync(ffmpegBin, [
              "-nostdin",
              "-y",
              "-ss", "0.5",
              "-i", videoFilePath,
              "-vframes", "1",
              "-q:v", "2",
              cachedCoverPath,
            ], { timeout: 8000, stdio: "ignore" });
          } catch {
            execFileSync(ffmpegBin, [
              "-nostdin",
              "-y",
              "-ss", "0.0",
              "-i", videoFilePath,
              "-vframes", "1",
              "-q:v", "2",
              cachedCoverPath,
            ], { timeout: 8000, stdio: "ignore" });
          }
        }
        if (existsSync(cachedCoverPath)) {
          const fileStat = await stat(cachedCoverPath);
          reply.header("cache-control", "private, max-age=604800, immutable");
          reply.header("content-type", "image/jpeg");
          reply.header("content-length", fileStat.size);
          return reply.send(createReadStream(cachedCoverPath));
        }
      } catch (err) {
        console.warn(`[outputs] 成片动态抽帧兜底失败 work=${id}:`, err instanceof Error ? err.message : String(err));
      }
    }

    if (!coverKey) return reply.code(404).send({ error: { code: "COVER_NOT_FOUND" } });

    // 若存储返回远端高速直链（如腾讯云 COS / CDN），直接 302 重定向，享受边缘极速加载
    const signedUrl = await options.storage.createSignedUrl(coverKey, {
      ttlSeconds: 3600,
    });
    if (signedUrl.startsWith("http://") || signedUrl.startsWith("https://")) {
      reply.header("cache-control", "private, no-cache");
      return reply.redirect(signedUrl, 302);
    }

    try {
      const filePath = await options.storage.getFilePath(coverKey);
      const fileStat = await stat(filePath);
      reply.header("cache-control", "private, max-age=604800, immutable");
      reply.header("content-type", "image/jpeg");
      reply.header("content-length", fileStat.size);
      return reply.send(createReadStream(filePath));
    } catch {
      return reply.code(404).send({ error: { code: "COVER_NOT_FOUND" } });
    }
  });

  const streamOrDownload = async (
    request: FastifyRequest,
    reply: FastifyReply,
    forceDownload = false
  ) => {
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    const isDownload = forceDownload || (request.query as { download?: string }).download === "1";
    const isGuest = !user.phone && !user.email;
    if (isDownload && isGuest) {
      return reply.code(401).send({ error: { code: "AUTH_REQUIRED_FOR_DOWNLOAD", message: "请先登录或注册账号后再下载原片作品" } });
    }
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return reply.code(400).send({ error: { code: "INVALID_OUTPUT_ID" } });
    }
    const output = await options.outputStore.findOutputById(user.id, id);
    if (!output) {
      return reply.code(404).send({ error: { code: "WORK_NOT_FOUND" } });
    }

    if (options.outputStore.incrementDownloadCount && isDownload) {
      try { await options.outputStore.incrementDownloadCount(user.id, output.id); }
      catch { /* 统计失败不影响作品下载 */ }
    }

    // 若当前存储驱动返回远端鉴权加速 URL（如腾讯云 COS / CDN），
    // 直接 302 重定向至直链，绕开服务器 3Mbps 带宽瓶颈，实现极速加载与满速下载。
    const signedUrl = await options.storage.createSignedUrl(output.storageKey, {
      ...(isDownload ? { downloadFilename: `jansee_${output.id.slice(0, 8)}.mp4` } : {}),
      ttlSeconds: isDownload ? 600 : 3600,
    });
    if (signedUrl.startsWith("http://") || signedUrl.startsWith("https://")) {
      reply.header("cache-control", "private, no-cache");
      return reply.redirect(signedUrl, 302);
    }

    const filePath = await options.storage.getFilePath(output.storageKey);
    const fileStat = await stat(filePath);

    const fileSize = fileStat.size;
    const rangeHeader = request.headers.range;

    // 支持移动端和现代浏览器标准的 HTTP 206 字节分片请求 (Range)
    if (rangeHeader && !isDownload) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const startStr = parts[0] ?? "";
      const endStr = parts[1] ?? "";
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : fileSize - 1;

      if (isNaN(start) || start >= fileSize || (parts[1] && end >= fileSize) || start > end) {
        reply.header("content-range", `bytes */${fileSize}`);
        return reply.code(416).send();
      }

      const chunkSize = end - start + 1;
      reply.code(206);
      reply.header("content-range", `bytes ${start}-${end}/${fileSize}`);
      reply.header("accept-ranges", "bytes");
      reply.header("content-length", chunkSize);
      reply.header("content-type", output.mimeType || "video/mp4");
      reply.header("cache-control", "private, max-age=604800, immutable");
      return reply.send(createReadStream(filePath, { start, end }));
    }

    reply.header("cache-control", isDownload ? "private, no-cache" : "private, max-age=604800, immutable");
    reply.header("content-type", output.mimeType || "video/mp4");
    reply.header("content-length", fileSize);
    reply.header("accept-ranges", "bytes");
    if (isDownload) {
      reply.header("content-disposition", `attachment; filename="${encodeURIComponent(`jansee_${output.id.slice(0, 8)}.mp4`)}"`);
    }
    return reply.send(createReadStream(filePath));
  };

  app.get("/api/v1/works/:id/stream", async (request, reply) => {
    return streamOrDownload(request, reply, false);
  });

  app.get("/api/v1/works/:id/download", async (request, reply) => {
    return streamOrDownload(request, reply, true);
  });
}

