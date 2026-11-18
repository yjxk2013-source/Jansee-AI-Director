import COS from "cos-nodejs-sdk-v5";

export interface TencentCosConfig {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
  uploadUrlTtlSeconds?: number;
  downloadUrlTtlSeconds?: number;
}

export interface ObjectHead {
  sizeBytes: number;
  etag: string;
  contentType?: string;
}

export interface PrivateObjectStorage {
  createUploadUrl(key: string, contentType: string): string;
  createDownloadUrl(key: string): string;
  headObject(key: string): Promise<ObjectHead>;
  deleteObject(key: string): Promise<void>;
}

const SAFE_KEY = /^[a-zA-Z0-9._/-]{1,512}$/;

function assertObjectKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.startsWith("/") || key.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Invalid private object key");
  }
}

export function createTencentCosStorage(config: TencentCosConfig): PrivateObjectStorage {
  if (!config.secretId || !config.secretKey || !config.bucket || !config.region) {
    throw new Error("Tencent COS configuration is incomplete");
  }

  const client = new COS({
    SecretId: config.secretId,
    SecretKey: config.secretKey,
    Protocol: "https:",
  });

  const uploadTtl = Math.min(Math.max(config.uploadUrlTtlSeconds ?? 300, 60), 900);
  const downloadTtl = Math.min(Math.max(config.downloadUrlTtlSeconds ?? 300, 60), 900);

  return {
    createUploadUrl(key, contentType) {
      assertObjectKey(key);
      if (!/^(image\/(jpeg|png|webp|heic)|video\/(mp4|quicktime|webm))$/i.test(contentType)) {
        throw new Error("Unsupported media content type");
      }
      return client.getObjectUrl({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
        Method: "PUT",
        Sign: true,
        Expires: uploadTtl,
        Protocol: "https:",
        Headers: { "Content-Type": contentType },
      });
    },

    createDownloadUrl(key) {
      assertObjectKey(key);
      return client.getObjectUrl({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
        Method: "GET",
        Sign: true,
        Expires: downloadTtl,
        Protocol: "https:",
      });
    },

    async headObject(key) {
      assertObjectKey(key);
      const result = await client.headObject({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
      });
      const sizeBytes = Number(result.headers?.["content-length"] ?? result.headers?.["Content-Length"] ?? 0);
      const contentType = result.headers?.["content-type"] ?? result.headers?.["Content-Type"];
      return {
        sizeBytes,
        etag: String(result.ETag ?? "").replaceAll('"', ""),
        ...(typeof contentType === "string" ? { contentType } : {}),
      };
    },

    async deleteObject(key) {
      assertObjectKey(key);
      await client.deleteObject({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
      });
    },
  };
}

