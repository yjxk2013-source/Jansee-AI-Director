import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { authenticatedSession, type AuthStore, type AuthUser } from "./auth.js";
import type { LocalObjectStorage } from "./storage-local.js";
import sharp from "sharp";
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_DIMENSION = 12_000;
const IMAGE_LIMIT = 20 * 1024 * 1024, VIDEO_LIMIT = 200 * 1024 * 1024, REQUEST_LIMIT = 500 * 1024 * 1024, MAX_FILES = 9;
const ASSET_RETENTION_MS = 24 * 60 * 60 * 1000;
const ASSET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVABLE_IMAGE_MIME_RE = /^image\/(png|jpeg|gif|webp|bmp|avif|heic|heif|tiff)$/i;
let activeUploads = 0;
export function resolveUploadConcurrencyLimit(value: string | undefined = process.env.MAX_CONCURRENT_UPLOADS): number {
  const requested = Number(value);
  if (!Number.isSafeInteger(requested)) return 2;
  return Math.min(4, Math.max(1, requested));
}
const MAX_CONCURRENT_UPLOADS = resolveUploadConcurrencyLimit();
export interface AssetRecord {
  id: string;
  originalName: string;
  mediaType: "image" | "video";
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  status?: string;
  createdAt?: Date;
  expiresAt?: Date | null;
}
export interface AssetStore {
  createAssets(userId: string, assets: AssetRecord[]): Promise<void>;
  findUserAssets?(userId: string, assetIds: string[]): Promise<AssetRecord[]>;
  listUserAssets?(userId: string): Promise<AssetRecord[]>;
  deleteAsset?(userId: string, assetId: string): Promise<{ storageKey: string } | null>;
  findExpiredAssets?(cutoff: Date, limit?: number): Promise<Array<{ id: string; userId: string; storageKey: string }>>;
  markAssetsExpired?(ids: string[]): Promise<void>;
}
export interface UploadOptions { authStore: AuthStore; assetStore: AssetStore; storage: LocalObjectStorage; allowedOrigins: string[] }
type Detected = { mediaType: "image" | "video"; mimeType: string };
function detectFile(bytes: Buffer): Detected | null {
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return { mediaType: "image", mimeType: "image/gif" };
  if (bytes.length >= 2 && bytes.toString("ascii", 0, 2) === "BM") return { mediaType: "image", mimeType: "image/bmp" };
  if (bytes.length >= 4 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))) return { mediaType: "image", mimeType: "image/tiff" };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mediaType: "image", mimeType: "image/jpeg" };
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mediaType: "image", mimeType: "image/png" };
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return { mediaType: "image", mimeType: "image/webp" };
  if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp") { const brand = bytes.toString("ascii", 8, 12); if (["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heif", "heim"].includes(brand)) return { mediaType: "image", mimeType: "image/heic" }; if (["avif", "avis"].includes(brand)) return { mediaType: "image", mimeType: "image/avif" }; if (brand === "qt  ") return { mediaType: "video", mimeType: "video/quicktime" }; return { mediaType: "video", mimeType: "video/mp4" }; }
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { mediaType: "video", mimeType: "video/webm" };
  return null;
}
function safeName(value: string): string { const name = basename(value.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim(); return (name || "upload").slice(0, 255); }

export function isImageMetadataWithinLimits(metadata: { width?: number | undefined; height?: number | undefined; pageHeight?: number | undefined; pages?: number | undefined }): boolean {
  const width = Number(metadata.width ?? 0);
  const height = Number(metadata.pageHeight ?? metadata.height ?? 0);
  const pages = Math.max(1, Number(metadata.pages ?? 1));
  return Number.isSafeInteger(width) && width > 0 && width <= MAX_IMAGE_DIMENSION
    && Number.isSafeInteger(height) && height > 0 && height <= MAX_IMAGE_DIMENSION
    && Number.isSafeInteger(pages) && pages <= 100
    && width * height * pages <= MAX_IMAGE_PIXELS;
}
export async function authenticatedUser(request: FastifyRequest, store: AuthStore): Promise<AuthUser | null> {
  const session = await authenticatedSession(request, store);
  return session?.user ?? null;
}
export function registerAssetRoutes(app: FastifyInstance, options: UploadOptions): void {
  app.register(multipart, { limits: { files: MAX_FILES, fileSize: VIDEO_LIMIT, fields: 0, parts: MAX_FILES } });
  app.post("/api/v1/assets", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (typeof request.headers.origin !== "string" || !options.allowedOrigins.includes(request.headers.origin)) return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    const user = await authenticatedUser(request, options.authStore); if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    if (activeUploads >= MAX_CONCURRENT_UPLOADS) return reply.code(429).send({ error: { code: "UPLOAD_BUSY", message: "\u5f53\u524d\u4e0a\u4f20\u4efb\u52a1\u8f83\u591a\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5" } });
    activeUploads += 1;
    let staging: string | null = null;
    const staged: Array<{ path: string; name: string; size: number; detected: Detected; id: string; key: string; sha256: string }> = []; let total = 0; let kind: "image" | "video" | null = null;
    try {
      staging = await mkdtemp(join(tmpdir(), "jansee-v4-upload-"));
      for await (const part of request.parts()) {
        if (part.type !== "file") continue;
        if (staged.length >= MAX_FILES) return reply.code(413).send({ error: { code: "TOO_MANY_FILES", message: "\u6bcf\u6b21\u6700\u591a\u4e0a\u4f20 9 \u4e2a\u7d20\u6750" } });
        const path = join(staging, String(staged.length) + "-" + randomUUID() + ".upload"); await pipeline(part.file, createWriteStream(path, { flags: "wx", mode: 0o600 }));
        if (part.file.truncated) return reply.code(413).send({ error: { code: "FILE_TOO_LARGE", message: "\u7d20\u6750\u6587\u4ef6\u8d85\u8fc7\u5927\u5c0f\u9650\u5236" } });
        const info = await stat(path); if (info.size <= 0) return reply.code(400).send({ error: { code: "EMPTY_FILE", message: "\u4e0d\u80fd\u4e0a\u4f20\u7a7a\u6587\u4ef6" } });
        const handle = await import("node:fs/promises"); const fileHandle = await handle.open(path, "r"); const head = Buffer.alloc(32); try { await fileHandle.read(head, 0, 32, 0); } finally { await fileHandle.close(); }
        const detected = detectFile(head); if (!detected) return reply.code(415).send({ error: { code: "UNSUPPORTED_FILE", message: "\u6587\u4ef6\u683c\u5f0f\u65e0\u6cd5\u8bc6\u522b\u6216\u6682\u4e0d\u652f\u6301" } });
        const limit = detected.mediaType === "image" ? IMAGE_LIMIT : VIDEO_LIMIT; if (info.size > limit) return reply.code(413).send({ error: { code: "FILE_TOO_LARGE", message: detected.mediaType === "image" ? "\u5355\u5f20\u56fe\u7247\u4e0d\u80fd\u8d85\u8fc7 20 MB" : "\u5355\u4e2a\u89c6\u9891\u4e0d\u80fd\u8d85\u8fc7 200 MB" } });
        if (detected.mediaType === "image") {
          try {
            const metadata = await sharp(path, { limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true }).metadata();
            if (!isImageMetadataWithinLimits(metadata)) {
              return reply.code(413).send({ error: { code: "IMAGE_PIXEL_LIMIT", message: "图片尺寸或总像素过大，单张图片最多支持 4000 万像素" } });
            }
          } catch {
            return reply.code(415).send({ error: { code: "INVALID_IMAGE", message: "图片文件损坏或格式无法安全解析" } });
          }
        }
        if (kind && kind !== detected.mediaType) return reply.code(400).send({ error: { code: "MIXED_MEDIA_TYPES", message: "\u4e00\u6b21\u4e0a\u4f20\u8bf7\u53ea\u9009\u62e9\u56fe\u7247\u6216\u89c6\u9891\u7d20\u6750" } }); kind = detected.mediaType;
        total += info.size; if (total > REQUEST_LIMIT) return reply.code(413).send({ error: { code: "REQUEST_TOO_LARGE", message: "\u672c\u6b21\u4e0a\u4f20\u603b\u5927\u5c0f\u4e0d\u80fd\u8d85\u8fc7 500 MB" } });
        const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
        const id = randomUUID(); staged.push({ path, name: safeName(part.filename), size: info.size, detected, id, key: "users/" + user.id + "/" + id, sha256: hash.digest("hex") });
      }
      if (!staged.length) return reply.code(400).send({ error: { code: "NO_FILES", message: "\u8bf7\u9009\u62e9\u9700\u8981\u4e0a\u4f20\u7684\u7d20\u6750" } });
      const expiresAt = new Date(Date.now() + ASSET_RETENTION_MS);
      const records: AssetRecord[] = staged.map(x => ({ id: x.id, originalName: x.name, mediaType: x.detected.mediaType, mimeType: x.detected.mimeType, sizeBytes: x.size, sha256: x.sha256, storageKey: x.key, expiresAt }));
      const stored: string[] = [];
      try {
        for (const item of staged) {
          await options.storage.putFile(item.key, item.path);
          stored.push(item.key);
        }
        await options.assetStore.createAssets(user.id, records);
      } catch (error) {
        await Promise.all(stored.map(key => options.storage.deleteObject(key).catch(() => undefined)));
        throw error;
      }
      return reply.code(201).send({ assets: records.map(x => ({ assetId: x.id, mediaType: x.mediaType, mimeType: x.mimeType, sizeBytes: x.sizeBytes, status: "uploaded" as const })) });
    } finally {
      activeUploads -= 1;
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  app.get("/api/v1/assets", async (request, reply) => {
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    if (!options.assetStore.listUserAssets) return reply.code(501).send({ error: { code: "NOT_IMPLEMENTED" } });
    const assets = await options.assetStore.listUserAssets(user.id);
    return reply.header("cache-control", "no-store").send({
      assets: assets.map((a) => ({
        assetId: a.id,
        originalName: a.originalName,
        mediaType: a.mediaType,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        status: a.status ?? "uploaded",
        createdAt: a.createdAt ? a.createdAt.toISOString() : new Date().toISOString(),
      })),
    });
  });

  /** 工作台缩略图的长期来源：blob 预览刷新后失效，服务端素材是唯一可靠来源。 */
  app.get("/api/v1/assets/:id/preview", async (request, reply) => {
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    const { id } = request.params as { id: string };
    if (!ASSET_ID_RE.test(id)) return reply.code(400).send({ error: { code: "INVALID_ASSET_ID", message: "素材 ID 格式无效" } });
    if (!options.assetStore.findUserAssets) return reply.code(501).send({ error: { code: "NOT_IMPLEMENTED" } });

    const [asset] = await options.assetStore.findUserAssets(user.id, [id]);
    if (!asset || asset.mediaType !== "image" || !SERVABLE_IMAGE_MIME_RE.test(asset.mimeType)
      || (asset.status && asset.status !== "uploaded" && asset.status !== "ready" && asset.status !== "processing")) {
      return reply.code(404).send({ error: { code: "ASSET_NOT_FOUND", message: "素材不存在或无法预览" } });
    }
    try {
      const filePath = await options.storage.getFilePath(asset.storageKey);
      const bytes = await readFile(filePath);
      return reply
        .header("content-type", asset.mimeType)
        .header("content-length", bytes.length)
        .header("cache-control", "private, max-age=3600")
        .header("x-content-type-options", "nosniff")
        .send(bytes);
    } catch {
      return reply.code(404).send({ error: { code: "ASSET_NOT_FOUND", message: "素材文件不存在或已过期" } });
    }
  });

  app.delete("/api/v1/assets/:id", async (request, reply) => {
    if (typeof request.headers.origin === "string" && !options.allowedOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    }
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    const { id } = request.params as { id: string };
    if (!ASSET_ID_RE.test(id)) {
      return reply.code(400).send({ error: { code: "INVALID_ASSET_ID", message: "素材 ID 格式无效" } });
    }
    if (!options.assetStore.deleteAsset) return reply.code(501).send({ error: { code: "NOT_IMPLEMENTED" } });
    const deleted = await options.assetStore.deleteAsset(user.id, id);
    if (!deleted) {
      return reply.code(404).send({ error: { code: "ASSET_NOT_FOUND", message: "素材不存在或已被删除" } });
    }
    await options.storage.deleteObject(deleted.storageKey).catch(() => undefined);
    return reply.code(204).send();
  });
}

export async function cleanupExpiredAssets(
  assetStore: AssetStore,
  storage: LocalObjectStorage,
  cutoff: Date = new Date(),
): Promise<{ databaseMarked: number; storageDeleted: number }> {
  let databaseMarked = 0;
  let storageDeleted = 0;
  if (assetStore.findExpiredAssets && assetStore.markAssetsExpired) {
    const expired = await assetStore.findExpiredAssets(cutoff);
    const deletedIds: string[] = [];
    for (const item of expired) {
      try {
        await storage.deleteObject(item.storageKey);
        storageDeleted += 1;
        deletedIds.push(item.id);
      } catch {
        // Keep failed objects eligible for the next cleanup pass.
      }
    }
    if (deletedIds.length > 0) {
      await assetStore.markAssetsExpired(deletedIds);
      databaseMarked = deletedIds.length;
    }
  }
  return { databaseMarked, storageDeleted };
}

