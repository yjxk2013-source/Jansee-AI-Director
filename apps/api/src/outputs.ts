import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { AuthStore } from "./auth.js";
import { authenticatedUser } from "./assets.js";
import type { LocalObjectStorage } from "./storage-local.js";

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
  incrementDownloadCount?(userId: string, outputId: string): Promise<void>;
  findExpiredOutputs?(now: Date, limit?: number): Promise<Array<{ id: string; storageKey: string }>>;
  markOutputExpired?(outputId: string, now: Date): Promise<void>;
}

export async function cleanupExpiredOutputs(
  store: OutputStore,
  storage: LocalObjectStorage,
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
  storage: LocalObjectStorage;
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
        coverUrl: out.coverStorageKey ? `/api/v1/works/${out.id}/cover` : null,
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
    const output = await options.outputStore.findOutputById(user.id, id);
    if (!output) return reply.code(404).send({ error: { code: "WORK_NOT_FOUND" } });
    if (!output.coverStorageKey) return reply.code(404).send({ error: { code: "COVER_NOT_FOUND" } });

    // 若存储支持高速直连，封面同样直接 302 重定向到 COS 直链，享受边缘极速加载
    if (typeof options.storage.createSignedUrl === "function") {
      const signedUrl = await options.storage.createSignedUrl(output.coverStorageKey, {
        ttlSeconds: 3600,
      });
      reply.header("cache-control", "private, no-cache");
      return reply.redirect(302, signedUrl);
    }

    try {
      const filePath = await options.storage.getFilePath(output.coverStorageKey);
      const fileStat = await stat(filePath);
      reply.header("cache-control", "private, max-age=604800, immutable");
      reply.header("content-type", "image/jpeg");
      reply.header("content-length", fileStat.size);
      return reply.send(createReadStream(filePath));
    } catch {
      return reply.code(404).send({ error: { code: "COVER_NOT_FOUND" } });
    }
  });

  app.get("/api/v1/works/:id/stream", async (request, reply) => {
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    const isDownload = (request.query as { download?: string }).download === "1";
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

    // 若当前存储驱动支持直接生成带鉴权的高速下载/播放 URL（如腾讯云 COS），
    // 直接 302 重定向至对象存储直链，绕开服务器 3Mbps 带宽瓶颈，实现极速加载与满速下载。
    if (typeof options.storage.createSignedUrl === "function") {
      const filename = isDownload ? `jansee_${output.id.slice(0, 8)}.mp4` : undefined;
      const signedUrl = await options.storage.createSignedUrl(output.storageKey, {
        downloadFilename: filename,
        ttlSeconds: isDownload ? 600 : 3600,
      });
      reply.header("cache-control", "private, no-cache");
      return reply.redirect(302, signedUrl);
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
    return reply.send(createReadStream(filePath));
  });
}

