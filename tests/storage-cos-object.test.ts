import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createTencentCosObjectStorage } from "../apps/api/src/storage-cos-object.js";

test("Tencent COS object storage persists files remotely and verifies cached downloads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jansee-cos-object-"));
  const source = join(root, "source.mp4");
  const remote = new Map<string, Buffer>();
  const fakeClient = {
    async uploadFile({ Key, FilePath }: { Key: string; FilePath: string }) {
      remote.set(Key, await readFile(FilePath));
      return { ETag: "etag" };
    },
    async headObject({ Key }: { Key: string }) {
      const data = remote.get(Key);
      if (!data) throw new Error("NoSuchKey");
      return { headers: { "content-length": String(data.length) } };
    },
    getObjectStream({ Key }: { Key: string }) {
      const data = remote.get(Key);
      if (!data) throw new Error("NoSuchKey");
      return Readable.from([data]);
    },
    async deleteObject({ Key }: { Key: string }) {
      remote.delete(Key);
      return {};
    },
    async getBucket() {
      return { Contents: [], IsTruncated: false };
    },
  };

  t.after(async () => rm(root, { recursive: true, force: true }));
  const payload = Buffer.from("cos-backed-private-media-payload");
  await writeFile(source, payload);
  const storage = createTencentCosObjectStorage({
    secretId: "test-id",
    secretKey: "test-secret",
    bucket: "jansee-test-1250000000",
    region: "ap-guangzhou",
    cacheRoot: join(root, "cache"),
    maxObjectBytes: 1024 * 1024,
    minFreeBytes: 0,
    client: fakeClient as never,
  });

  const stored = await storage.putFile("users/test/source", source);
  assert.equal(stored.sizeBytes, payload.length);
  assert.deepEqual(remote.get("users/test/source"), payload);

  const downloadedPath = await storage.getFilePath("users/test/source");
  assert.deepEqual(await readFile(downloadedPath), payload);
  const cachedPath = await storage.getFilePath("users/test/source");
  assert.equal(cachedPath, downloadedPath);

  await storage.deleteObject("users/test/source");
  assert.equal(remote.has("users/test/source"), false);
  await assert.rejects(storage.getFilePath("users/test/source"));
});

test("Tencent COS object storage rejects unsafe keys and oversized source files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jansee-cos-guard-"));
  const source = join(root, "source.bin");
  await writeFile(source, Buffer.alloc(32));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const fakeClient = {
    async uploadFile() { return {}; },
    async headObject() { return { headers: { "content-length": "32" } }; },
    getObjectStream() { return Readable.from([Buffer.alloc(32)]); },
    async deleteObject() { return {}; },
    async getBucket() { return { Contents: [], IsTruncated: false }; },
  };
  const storage = createTencentCosObjectStorage({
    secretId: "test-id",
    secretKey: "test-secret",
    bucket: "jansee-test-1250000000",
    region: "ap-guangzhou",
    cacheRoot: join(root, "cache"),
    maxObjectBytes: 16,
    minFreeBytes: 0,
    client: fakeClient as never,
  });

  await assert.rejects(storage.putFile("../escape", source), /Invalid private object key/);
  await assert.rejects(storage.putFile("users/test/large", source), /exceeds the COS object size limit/);
});
