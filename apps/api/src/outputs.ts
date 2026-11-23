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
// @ts-expect-error intro-kit exposes composePureCover
import { composePureCover } from "@jansee/intro-kit";

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
  app.route({
    method: ["GET", "HEAD"],
    url: "/api/v1/works/:id/cover",
    handler: async (request, reply) => {
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

      // 动态抽帧保底：针对历史作品或未生成封面的视频成片，现场通过 composePureCover 叠加开场设计，生成无字幕、无AI标纯净封面
      if (!coverKey && output && output.mimeType === "video/mp4") {
        try {
          const cacheDir = join(tmpdir(), "jansee-work-covers");
          await mkdir(cacheDir, { recursive: true });
          const cachedCoverPath = join(cacheDir, `${id}.jpg`);
          if (!existsSync(cachedCoverPath)) {
            const videoFilePath = await options.storage.getFilePath(output.storageKey);
            const plan = (output.directorPlan ?? {}) as Record<string, unknown>;
            const introTitle = String(output.publish?.cover_title || output.title || plan.title || "JANSEE FILM").trim();
            const introEn = String(plan.site || "JANSEE FILM").trim();
            const introNote = String(plan.concept || "一席留白 · 静待亲临").trim();
            await composePureCover({
              bgSource: videoFilePath,
              title: introTitle,
              brandEn: introEn,
              site: introEn,
              note: introNote,
              idx: "NO. 01 / CINEMATIC COVER",
              width: output.width || 1080,
              height: output.height || 1920,
              outPath: cachedCoverPath,
              captureSec: 1.0,
            });
          }
          if (existsSync(cachedCoverPath)) {
            const fileStat = await stat(cachedCoverPath);
            const etag = `W/"${fileStat.size.toString(16)}-${Math.floor(fileStat.mtimeMs).toString(16)}"`;
            const ifNoneMatch = request.headers["if-none-match"];
            if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch.includes(etag))) {
              return reply.code(304).header("etag", etag).header("cache-control", "private, max-age=2592000, stale-while-revalidate=86400").send();
            }
            reply.header("etag", etag);
            reply.header("cache-control", "private, max-age=2592000, stale-while-revalidate=86400");
            reply.header("content-type", "image/jpeg");
            reply.header("content-length", fileStat.size);
            if (request.method === "HEAD") return reply.send();
            return reply.send(createReadStream(cachedCoverPath));
          }
        } catch (err) {
          console.warn(`[outputs] 成片动态加开场纯净封面兜底失败 work=${id}:`, err instanceof Error ? err.message : String(err));
        }
      }

      if (!coverKey) return reply.code(404).send({ error: { code: "COVER_NOT_FOUND" } });

      // 封面图片以同源数据流直接返回，避免 302 重定向到外部 COS 域名触发浏览器 Content-Security-Policy 拦截导致黑屏
      try {
        const filePath = await options.storage.getFilePath(coverKey);
        const fileStat = await stat(filePath);
        const etag = `W/"${fileStat.size.toString(16)}-${Math.floor(fileStat.mtimeMs).toString(16)}"`;
        const ifNoneMatch = request.headers["if-none-match"];
        if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch.includes(etag))) {
          return reply.code(304).header("etag", etag).header("cache-control", "private, max-age=2592000, stale-while-revalidate=86400").send();
        }
        reply.header("etag", etag);
        reply.header("cache-control", "private, max-age=2592000, stale-while-revalidate=86400");
        reply.header("content-type", "image/jpeg");
        reply.header("content-length", fileStat.size);
        if (request.method === "HEAD") return reply.send();
        return reply.send(createReadStream(filePath));
      } catch (err) {
        console.warn(`[outputs] 读取封面文件失败 coverKey=${coverKey}:`, err instanceof Error ? err.message : String(err));
        return reply.code(404).send({ error: { code: "COVER_NOT_FOUND" } });
      }
    },
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

    // 同一地址制作与下载专项优化：
    // 用户制作成片后主要在本机/同网络/同部署地址下即时预览与下载，成片极少分散到外部其它地址。
    // 优先尝试从本地磁盘热缓存（0ms 延时、0 次 302 跨域握手、0 CDN 回源等待）同源直接流式传输或下载；
    // 仅当本地物理文件不存在时，才回退至远端 CDN / COS 直链进行 302 重定向兜底。
    let filePath: string | null = null;
    let fileSize = 0;
    try {
      const candidatePath = await options.storage.getFilePath(output.storageKey);
      const st = await stat(candidatePath);
      if (st.isFile() && st.size > 0) {
        filePath = candidatePath;
        fileSize = st.size;
      }
    } catch {
      filePath = null;
    }

    if (!filePath) {
      const signedUrl = await options.storage.createSignedUrl(output.storageKey, {
        ...(isDownload ? { downloadFilename: `jansee_${output.id.slice(0, 8)}.mp4` } : {}),
        ttlSeconds: isDownload ? 600 : 3600,
      });
      if (signedUrl.startsWith("http://") || signedUrl.startsWith("https://")) {
        reply.header("cache-control", "private, no-cache");
        return reply.redirect(signedUrl, 302);
      }
      return reply.code(404).send({ error: { code: "WORK_FILE_NOT_FOUND", message: "作品文件不可用" } });
    }
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

