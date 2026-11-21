import COS from "cos-nodejs-sdk-v5";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, rename, rm, stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ObjectStorage } from "./storage-local.js";

type CosClient = Pick<InstanceType<typeof COS>, "uploadFile" | "getObjectStream" | "headObject" | "deleteObject" | "getBucket" | "getObjectUrl">;

export interface TencentCosObjectStorageConfig {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
  cdnDomain?: string | undefined;
  cdnAuthKey?: string | undefined;
  cacheRoot?: string | undefined;
  maxObjectBytes: number;
  minFreeBytes?: number | undefined;
  client?: CosClient | undefined;
}

const SAFE_KEY = /^[a-zA-Z0-9._/-]{1,512}$/;

function assertKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.startsWith("/") || key.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Invalid private object key");
  }
}

export function createTencentCosObjectStorage(config: TencentCosObjectStorageConfig): ObjectStorage {
  if (!config.secretId || !config.secretKey || !config.bucket || !config.region) {
    throw new Error("Tencent COS configuration is incomplete");
  }
  if (!Number.isSafeInteger(config.maxObjectBytes) || config.maxObjectBytes <= 0) {
    throw new Error("COS object storage requires a positive object size limit");
  }

  const cacheRoot = resolve(config.cacheRoot ?? join(tmpdir(), "jansee-v4-cos-cache"));
  if (!isAbsolute(cacheRoot)) throw new Error("COS cache root must be an absolute path");
  const minFreeBytes = Math.max(0, config.minFreeBytes ?? 512 * 1024 * 1024);
  const client: CosClient = config.client ?? new COS({
    SecretId: config.secretId,
    SecretKey: config.secretKey,
    Protocol: "https:",
  });

  async function ensureCacheRoot(): Promise<void> {
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(cacheRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("COS cache root must be a real directory");
  }

  function cachePath(key: string): string {
    assertKey(key);
    return join(cacheRoot, createHash("sha256").update(key).digest("hex"));
  }

  async function removeCache(key: string): Promise<void> {
    await rm(cachePath(key), { force: true }).catch(() => undefined);
  }

  return {
    async putFile(key, sourcePath) {
      assertKey(key);
      await ensureCacheRoot();
      const source = await stat(sourcePath);
      if (!source.isFile() || source.size <= 0 || source.size > config.maxObjectBytes) {
        throw new Error("Source file is invalid or exceeds the COS object size limit");
      }
      const disk = await statfs(cacheRoot);
      const available = Number(disk.bavail) * Number(disk.bsize);
      if (available - source.size < minFreeBytes) throw new Error("Insufficient cache disk space for COS upload");

      let detectedContentType = "application/octet-stream";
      if (key.endsWith(".mp4") || key.includes("/outputs/")) {
        detectedContentType = "video/mp4";
      } else if (key.endsWith(".jpg") || key.endsWith(".jpeg") || key.includes("/covers/")) {
        detectedContentType = "image/jpeg";
      } else if (key.endsWith(".png")) {
        detectedContentType = "image/png";
      } else if (key.endsWith(".json")) {
        detectedContentType = "application/json";
      }

      await client.uploadFile({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
        FilePath: sourcePath,
        ContentType: detectedContentType,
        ACL: "private",
      });
      const head = await client.headObject({ Bucket: config.bucket, Region: config.region, Key: key });
      const sizeBytes = Number(head.headers?.["content-length"] ?? head.headers?.["Content-Length"] ?? 0);
      if (sizeBytes !== source.size || sizeBytes > config.maxObjectBytes) {
        throw new Error("COS object size verification failed");
      }
      await removeCache(key);
      return { sizeBytes };
    },

    async getFilePath(key) {
      assertKey(key);
      await ensureCacheRoot();
      const target = cachePath(key);
      try {
        const info = await lstat(target);
        if (info.isFile() && !info.isSymbolicLink()) return target;
        throw new Error("COS cache entry is not a regular file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      const temp = join(cacheRoot, "." + createHash("sha256").update(key).digest("hex") + "." + randomUUID() + ".part");
      try {
        const stream = client.getObjectStream({ Bucket: config.bucket, Region: config.region, Key: key });
        await pipeline(stream as Readable, createWriteStream(temp, { flags: "wx", mode: 0o600 }));
        const head = await client.headObject({ Bucket: config.bucket, Region: config.region, Key: key });
        const expected = Number(head.headers?.["content-length"] ?? head.headers?.["Content-Length"] ?? 0);
        const actual = await stat(temp);
        if (!actual.isFile() || actual.size <= 0 || actual.size !== expected || actual.size > config.maxObjectBytes) {
          throw new Error("Downloaded COS object failed size verification");
        }
        await rename(temp, target);
        return target;
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    },

    async deleteObject(key) {
      assertKey(key);
      await client.deleteObject({ Bucket: config.bucket, Region: config.region, Key: key });
      await removeCache(key);
    },

    async deleteExpired(prefix, olderThan, now = new Date()) {
      assertKey(prefix);
      if (olderThan.getTime() > now.getTime()) throw new Error("Expiry cutoff cannot be in the future");
      let marker: string | undefined;
      let removed = 0;
      do {
        const page = await client.getBucket({
          Bucket: config.bucket,
          Region: config.region,
          Prefix: prefix,
          MaxKeys: 1000,
          ...(marker ? { Marker: marker } : {}),
        });
        for (const item of page.Contents ?? []) {
          if (new Date(item.LastModified).getTime() <= olderThan.getTime()) {
            await client.deleteObject({ Bucket: config.bucket, Region: config.region, Key: item.Key });
            await removeCache(item.Key);
            removed += 1;
          }
        }
        marker = page.IsTruncated === "true" ? page.NextMarker : undefined;
      } while (marker);
      return removed;
    },

    createSignedUrl(key, options) {
      assertKey(key);
      const ttl = Math.min(Math.max(options?.ttlSeconds ?? 3600, 60), 86400);
      const query: Record<string, string> = {};
      if (options?.downloadFilename) {
        query["response-content-disposition"] = `attachment; filename="${encodeURIComponent(options.downloadFilename)}"`;
      }
      const rawUrl = client.getObjectUrl({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
        Method: "GET",
        Sign: true,
        Expires: ttl,
        Protocol: "https:",
        ...(Object.keys(query).length > 0 ? { Query: query } : {}),
      });

      // 腾讯云 CDN 在开启【私有回源鉴权】后，CDN 节点会自动使用主账号服务凭证与 COS 源站完成鉴权交互；
      // 同时为保障商业媒体资产防盗刷与用户隐私安全，只有在同时配置了 CDN 域名与 CDN 鉴权密钥时，才生成带 Type A 防盗链 Token 的加速链接；
      // 若缺少 CDN 鉴权密钥，严格执行安全 Fail-closed 策略：坚决不返回无签名的裸 CDN 链接，自动回退到原生 COS 签名 URL (rawUrl)。
      if (config.cdnDomain && config.cdnAuthKey) {
        try {
          const cleanKey = key.startsWith("/") ? key.slice(1) : key;
          const uri = `/${cleanKey}`;
          const issueTimestamp = Math.floor(Date.now() / 1000);
          const rand = "0";
          const uid = "0";
          const hash = createHash("md5")
            .update(`${uri}-${issueTimestamp}-${rand}-${uid}-${config.cdnAuthKey}`)
            .digest("hex");

          // 腾讯云 Type A 鉴权规范要求鉴权 URL 遵循严格格式，避免附加其他 query 参数导致部分边缘节点校验不匹配
          return `https://${config.cdnDomain}${uri}?sign=${issueTimestamp}-${rand}-${uid}-${hash}`;
        } catch {
          return rawUrl;
        }
      }
      return rawUrl;
    },
  };
}
