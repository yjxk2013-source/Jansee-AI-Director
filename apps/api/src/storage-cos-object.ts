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
      // 同一地址即时预览/下载专项优化：
      // 上传 COS 成功后，将本地已生成的源文件保留到本地缓存池 cachePath(key)，
      // 避免刚制作完成的成片因本地无缓存而被迫走公网 302 CDN 绕弯或重新向 COS 发起回源下载。
      const target = cachePath(key);
      try {
        if (resolve(sourcePath) !== resolve(target)) {
          const { copyFile } = await import("node:fs/promises");
          await copyFile(sourcePath, target);
        }
      } catch {
        await removeCache(key);
      }
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

      // 腾讯云 CDN 优先分流：
      // 只要配置了 cdnDomain，下载与播放一律通过 CDN 边缘节点（如 cdn.jansee.cn）分发，
      // 彻底杜绝回退到 COS 源站产生昂贵的外网下行流量（0.50 元/GB）；
      // 若同时配置了 cdnAuthKey，则按照腾讯云 Type A 规范追加 URL 鉴权防盗链 token；
      // 若未配置 cdnAuthKey，则直接输出 CDN 加速链接（依赖 CDN 私有 Bucket 回源授权与系统接口鉴权）。
      if (config.cdnDomain) {
        const cleanKey = key.startsWith("/") ? key.slice(1) : key;
        const uri = `/${cleanKey}`;
        const queryParams = new URLSearchParams();

        if (config.cdnAuthKey) {
          try {
            const issueTimestamp = Math.floor(Date.now() / 1000);
            const rand = "0";
            const uid = "0";
            const hash = createHash("md5")
              .update(`${uri}-${issueTimestamp}-${rand}-${uid}-${config.cdnAuthKey}`)
              .digest("hex");

            queryParams.set("sign", `${issueTimestamp}-${rand}-${uid}-${hash}`);
          } catch {
            // 鉴权 token 计算异常时降级
          }
        }

        if (options?.downloadFilename) {
          queryParams.set("response-content-disposition", `attachment; filename="${encodeURIComponent(options.downloadFilename)}"`);
        }

        const queryString = queryParams.toString();
        return `https://${config.cdnDomain}${uri}${queryString ? `?${queryString}` : ""}`;
      }

      return rawUrl;
    },
  };
}
