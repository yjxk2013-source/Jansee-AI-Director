import test from "node:test";
import assert from "node:assert/strict";
import { createTencentCosStorage } from "../apps/api/src/storage-cos.js";

const storage = createTencentCosStorage({
  secretId: "test-secret-id",
  secretKey: "test-secret-key",
  bucket: "jansee-v4-test-1250000000",
  region: "ap-guangzhou",
});

test("Tencent COS creates short-lived HTTPS signed PUT URLs for a single private object", () => {
  const url = storage.createUploadUrl("v4/users/u1/assets/a1/source.mp4", "video/mp4");
  assert.match(url, /^https:\/\//);
  assert.match(url, /q-sign-algorithm=/);
});

test("Tencent COS creates signed GET URLs for private object download", () => {
  const url = storage.createDownloadUrl("v4/users/u1/outputs/o1/video.mp4");
  assert.match(url, /^https:\/\//);
  assert.match(url, /q-sign-algorithm=/);
});

test("Tencent COS rejects unsafe object keys and unsupported content types", () => {
  assert.throws(() => storage.createUploadUrl("../outside.mp4", "video/mp4"));
  assert.throws(() => storage.createDownloadUrl("/root/secret"));
  assert.throws(() => storage.createUploadUrl("v4/users/u1/a.exe", "application/octet-stream"));
});

test("Tencent COS requires complete server-side configuration", () => {
  assert.throws(() => createTencentCosStorage({
    secretId: "",
    secretKey: "secret",
    bucket: "bucket-1250000000",
    region: "ap-guangzhou",
  }));
});
