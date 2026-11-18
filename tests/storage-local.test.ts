import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLocalObjectStorage } from "../apps/api/src/storage-local.js";

test("local storage atomically stores, reads and deletes an object inside its private root", async () => {
  const root = await mkdtemp(join(tmpdir(), "jansee-v4-storage-"));
  const source = join(root, "source.mp4");
  const storageRoot = join(root, "private");
  await writeFile(source, Buffer.from("video-bytes"));
  const storage = createLocalObjectStorage({ rootDir: storageRoot, maxObjectBytes: 1024, minFreeBytes: 0 });
  try {
    const result = await storage.putFile("incoming/user1/asset1", source);
    assert.equal(result.sizeBytes, 11);
    const stored = await storage.getFilePath("incoming/user1/asset1");
    assert.deepEqual(await readFile(stored), Buffer.from("video-bytes"));
    await storage.deleteObject("incoming/user1/asset1");
    await assert.rejects(() => storage.getFilePath("incoming/user1/asset1"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local storage rejects traversal, absolute paths, oversized objects and non-absolute roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "jansee-v4-storage-"));
  const source = join(root, "large.bin");
  await writeFile(source, Buffer.alloc(32));
  const storage = createLocalObjectStorage({ rootDir: join(root, "private"), maxObjectBytes: 16, minFreeBytes: 0 });
  try {
    await assert.rejects(() => storage.putFile("../escape", source));
    await assert.rejects(() => storage.getFilePath("/etc/passwd"));
    await assert.rejects(() => storage.putFile("incoming/large", source), /size limit/);
    assert.throws(() => createLocalObjectStorage({ rootDir: "relative/path", maxObjectBytes: 10 }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local storage does not follow a symlink inside its root", async () => {
  const root = await mkdtemp(join(tmpdir(), "jansee-v4-storage-"));
  const outside = join(root, "outside");
  const storageRoot = join(root, "private");
  await mkdir(storageRoot);
  await mkdir(outside);
  const source = join(root, "source.bin");
  await writeFile(source, "safe");
  const storage = createLocalObjectStorage({ rootDir: storageRoot, maxObjectBytes: 128, minFreeBytes: 0 });
  try {
    await symlink(outside, join(storageRoot, "incoming"), "dir");
    await assert.rejects(() => storage.putFile("incoming/escape", source));
    assert.equal(resolve(outside, "escape").startsWith(outside), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
