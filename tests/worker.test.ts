import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { buildApp } from "../apps/api/src/app.ts";
import type { AuthStore, AuthUser } from "../apps/api/src/auth.ts";
import type { AssetStore, AssetRecord } from "../apps/api/src/assets.ts";
import type { JobStore, GenerationJobRecord } from "../apps/api/src/jobs.ts";
import type { OutputStore, OutputRecord, NewOutput } from "../apps/api/src/outputs.ts";
import type { LocalObjectStorage } from "../apps/api/src/storage-local.js";
import { createLocalObjectStorage } from "../apps/api/src/storage-local.js";
import { processJob, processNextQueuedJob, startJobWorkerLoop } from "../apps/api/src/worker.js";
import { createDefaultProductionEngineRegistry } from "../apps/api/src/engine-adapters.js";
import { createMediaRenderer } from "../apps/api/src/renderer.js";
// @ts-expect-error ffmpeg-kit exposes runtime media probes without bundled declarations
import { hasAudioStream } from "@jansee/ffmpeg-kit/probe.mjs";
import { createHeuristicDirectorPlanner } from "../apps/api/src/director.js";
import { TENCENT_VOICE_CANDIDATES, applyTencentVoiceHealthSnapshot } from "@jansee/tts-kit";
import { assertJobTransition } from "@jansee/domain";

const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string;
const healthyVoiceSnapshot = [...new Map(TENCENT_VOICE_CANDIDATES.map((voice) => [voice.voiceType, { voiceType: voice.voiceType, status: "healthy" }])).values()];
applyTencentVoiceHealthSnapshot(healthyVoiceSnapshot);
const origin = "https://jansee.example";
const token = "d".repeat(43);
const user: AuthUser = { id: "user-999", email: "creator999@example.com", displayName: "Creator999", createdAt: new Date() };

function createTestHarness() {
  const authStore: AuthStore = {
    async createUser() { return user; },
    async findUserByEmail() { return null; },
    async createSession() { },
    async findSession(hash) {
      return hash === createHash("sha256").update(token).digest("hex")
        ? { user, expiresAt: new Date(Date.now() + 60_000) }
        : null;
    },
    async revokeSession() { },
  };

  const assetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const assetKey = `users/${user.id}/${assetId}`;
  const assetRecord: AssetRecord = {
    id: assetId,
    originalName: "source.jpg",
    mediaType: "image",
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    sha256: "fakehash",
    storageKey: assetKey,
  };

  const savedFiles = new Map<string, Buffer>();
  savedFiles.set(assetKey, Buffer.from("dummy-image-data"));

  const storage: LocalObjectStorage = {
    async putFile(key, path) {
      const data = await readFile(path);
      savedFiles.set(key, data);
      return { sizeBytes: data.length };
    },
    async getFilePath(key) {
      const target = join(tmpdir(), `test-file-${key.replace(/\//g, "-")}`);
      await writeFile(target, savedFiles.get(key) ?? Buffer.alloc(10));
      return target;
    },
    async deleteObject(key) { savedFiles.delete(key); },
    async deleteExpired() { return 0; },
  };

  const assetStore: AssetStore = {
    async createAssets() { },
    async findUserAssets(userId, assetIds) {
      if (userId !== user.id) return [];
      return assetIds.includes(assetId) ? [assetRecord] : [];
    },
  };

  const jobs = new Map<string, GenerationJobRecord>();
  const jobStore: JobStore = {
    async createJob(userId, input) {
      const rec: GenerationJobRecord = {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        userId,
        mode: input.mode,
        status: "queued",
        prompt: input.prompt,
        aspectRatio: input.aspectRatio,
        idempotencyKey: input.idempotencyKey,
        requestPayload: {},
        directorPlan: input.directorPlan ?? null,
        progress: 0,
        errorCode: null,
        errorMessage: null,
        queuedAt: new Date(),
        startedAt: null,
        finishedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        assetIds: input.assetIds,
      };
      jobs.set(rec.id, rec);
      return rec;
    },
    async findJobById(userId, jobId) {
      const j = jobs.get(jobId);
      return j && j.userId === userId ? j : null;
    },
    async updateDirectorPlan(userId, jobId, directorPlan) {
      const j = jobs.get(jobId);
      if (j && j.userId === userId) j.directorPlan = directorPlan;
    },
    async updateJobStatus(userId, jobId, toStatus, progress, error) {
      const j = jobs.get(jobId);
      if (!j || j.userId !== userId) return null;
      assertJobTransition(j.status, toStatus);
      j.status = toStatus;
      if (typeof progress === "number") j.progress = progress;
      if (error) {
        j.errorCode = error.code;
        j.errorMessage = error.message;
      }
      return j;
    },
  };

  const outputs = new Map<string, OutputRecord>();
  const outputStore: OutputStore = {
    async createOutput(output: NewOutput) {
      const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const rec: OutputRecord = {
        id,
        jobId: output.jobId,
        userId: output.userId,
        storageKey: output.storageKey,
        mimeType: output.mimeType ?? "video/mp4",
        sizeBytes: output.sizeBytes,
        durationMs: output.durationMs ?? null,
        width: output.width ?? null,
        height: output.height ?? null,
        status: "ready",
        createdAt: new Date(),
        expiresAt: output.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
      };
      outputs.set(id, rec);
      return rec;
    },
    async listUserOutputs(userId) {
      return [...outputs.values()].filter((o) => o.userId === userId);
    },
    async findOutputById(userId, outputId) {
      const o = outputs.get(outputId);
      return o && o.userId === userId ? o : null;
    },
  };

  const renderer = {
    async render(job: GenerationJobRecord) {
      const storageKey = `users/${job.userId}/outputs/${job.id}.mp4`;
      const tempFile = join(tmpdir(), `test-render-${job.id}.mp4`);
      await writeFile(tempFile, Buffer.from("test-render-payload"));
      const stored = await storage.putFile(storageKey, tempFile);
      return { storageKey, mimeType: "video/mp4", sizeBytes: stored.sizeBytes, durationMs: 10_000, width: 1080, height: 1920 };
    },
  };

  return { authStore, assetStore, jobStore, outputStore, storage, renderer, jobs, outputs, assetId };
}

test("renderer uses the V4 bundled FFmpeg binary to create a real MP4 from an image", async () => {
  const root = await mkdtemp(join(tmpdir(), "jansee-render-integration-"));
  const inputPath = join(root, "input.bmp");
  const storage = createLocalObjectStorage({ rootDir: join(root, "objects"), maxObjectBytes: 5 * 1024 * 1024, minFreeBytes: 0 });
  const bmpHeader = Buffer.alloc(54);
  bmpHeader.write("BM", 0, "ascii");
  bmpHeader.writeUInt32LE(58, 2);
  bmpHeader.writeUInt32LE(54, 10);
  bmpHeader.writeUInt32LE(40, 14);
  bmpHeader.writeInt32LE(1, 18);
  bmpHeader.writeInt32LE(1, 22);
  bmpHeader.writeUInt16LE(1, 26);
  bmpHeader.writeUInt16LE(24, 28);
  bmpHeader.writeUInt32LE(4, 34);
  await writeFile(inputPath, Buffer.concat([bmpHeader, Buffer.from([0, 0, 255, 0])]));
  const assetKey = "users/test-user/source-image";
  const assetKey2 = "users/test-user/source-image-two";
  await storage.putFile(assetKey, inputPath);
  await storage.putFile(assetKey2, inputPath);
  const asset: AssetRecord = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", userId: "test-user", originalName: "source.bmp",
    mediaType: "image", mimeType: "image/bmp", sizeBytes: 58, sha256Hex: "test", storageKey: assetKey,
    status: "ready", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
  };
  const job = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", userId: "test-user", mode: "image-film" as const,
    status: "rendering" as const, prompt: "red square product visual", aspectRatio: "1:1", idempotencyKey: "render-integration",
    requestPayload: {}, directorPlan: null, progress: 70, errorCode: null, errorMessage: null,
    queuedAt: new Date(), startedAt: new Date(), finishedAt: null, createdAt: new Date(), updatedAt: new Date(), assetIds: [asset.id],
  };
  const secondAsset: AssetRecord = { ...asset, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", originalName: "source-two.bmp", storageKey: assetKey2 };
  try {
    const renderer = createMediaRenderer({ storage });
    const result = await renderer.render(job, [asset, secondAsset]);
    assert.ok(result.sizeBytes > 1024);
    const outputPath = await storage.getFilePath(result.storageKey);
    const output = await readFile(outputPath);
    assert.equal(output.subarray(4, 8).toString("ascii"), "ftyp");
    assert.equal(result.mimeType, "video/mp4");
    assert.equal(result.durationMs, 9300);
    assert.equal(result.width, 1080);
    assert.equal(result.height, 1080);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("video-dub jobs dispatch to the migrated V2 production engine with default director packaging", async () => {
  const root = await mkdtemp(join(tmpdir(), "jansee-video-dub-dispatch-"));
  const storage = createLocalObjectStorage({ rootDir: join(root, "objects"), maxObjectBytes: 5 * 1024 * 1024, minFreeBytes: 0 });
  const sourcePath = join(root, "source.mp4");
  await writeFile(sourcePath, Buffer.from("test-source-video"));
  const assetKey = "users/test-user/source-video";
  await storage.putFile(assetKey, sourcePath);
  const asset: AssetRecord = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", userId: "test-user", originalName: "source.mp4",
    mediaType: "video", mimeType: "video/mp4", sizeBytes: 17, sha256Hex: "test", storageKey: assetKey,
    status: "ready", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
  };
  const job = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", userId: "test-user", mode: "video-dub" as const,
    status: "rendering" as const, prompt: "制作一支产品宣传片", aspectRatio: "9:16", idempotencyKey: "video-dub-dispatch",
    requestPayload: {}, directorPlan: { title: "产品宣传片", narration: "这是用户提供产品信息后形成的旁白。", voice_id: "403010", speech_speed: 1.0, bgm_emotion: "warm" },
    progress: 70, errorCode: null, errorMessage: null, queuedAt: new Date(), startedAt: new Date(), finishedAt: null,
    createdAt: new Date(), updatedAt: new Date(), assetIds: [asset.id],
  };
  let received: Record<string, unknown> | undefined;
  try {
    const renderer = createMediaRenderer({
      storage,
      videoDubEngine: async (input) => {
        received = input as unknown as Record<string, unknown>;
        const outputPath = join(input.taskDir, "final.mp4");
        await writeFile(outputPath, Buffer.from("finished-video-output"));
        return { outputPath, videoSec: 12, timings: { tts: 1.25, ffmpeg: 3.5 } };
      },
    });
    const result = await renderer.render(job, [asset]);
    assert.equal(result.mimeType, "video/mp4");
    assert.ok(result.sizeBytes > 0);
    assert.equal(result.durationMs, 12_000);
    assert.equal(result.ttsDurationMs, 1_250);
    assert.equal(result.ffmpegDurationMs, 3_500);
    assert.ok(received);
    const cut = received.cut as Record<string, unknown>;
    assert.equal(cut.intro_en, "JANSEE");
    assert.equal(cut.bgm_on, true);
    assert.deepEqual(cut.shots, [{ line: "这是用户提供产品信息后形成的旁白。", pause_after: 0.25 }]);
    assert.equal(received.voiceId, "403010");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renderer refuses to publish placeholder MP4 files when FFmpeg is unavailable", async () => {
  const h = createTestHarness();
  const job = await h.jobStore.createJob(user.id, {
    mode: "image-film",
    prompt: "验证渲染器失败保护",
    aspectRatio: "9:16",
    assetIds: [h.assetId],
    idempotencyKey: "22222222-3333-4444-8555-666666666666",
  });
  const assets = await h.assetStore.findUserAssets!(user.id, [h.assetId]);
  const renderer = createMediaRenderer({ storage: h.storage, ffmpegPath: "jansee-ffmpeg-binary-not-installed" });
  await assert.rejects(() => renderer.render(job, assets), /FFMPEG_UNAVAILABLE/);
});

test("worker pipeline transitions job through stages, renders output, and publishes ready work", async () => {
  const h = createTestHarness();
  const job = await h.jobStore.createJob(user.id, {
    mode: "image-film",
    prompt: "生产一支短片",
    aspectRatio: "9:16",
    assetIds: [h.assetId],
    idempotencyKey: "11111111-2222-4333-8444-555555555555",
  });

  const success = await processJob(job, {
    storage: h.storage,
    renderer: h.renderer,
    jobStore: h.jobStore,
    assetStore: h.assetStore,
    outputStore: h.outputStore,
    directorPlanner: {
      async createPlan(input) {
        const plan = await createHeuristicDirectorPlanner().createPlan(input);
        return Object.assign(plan, {
          _providerTelemetry: {
            providerMode: "primary", requestedModel: "unit-test-model", selectedModel: "unit-test-model",
            modelsAttempted: ["unit-test-model"], fallbackUsed: false,
            promptTokens: 10, completionTokens: 20, totalTokens: 30, usageAvailable: true, costUsageAvailable: true,
          },
        });
      },
    },
  });

  assert.equal(success, true);
  assert.equal(job.status, "completed");
  assert.equal(job.progress, 100);
  assert.equal(h.outputs.size, 1);
  assert.ok(job.directorPlan);
  assert.equal(typeof job.directorPlan?.variant_type, "string");
  const telemetry = job.directorPlan?._telemetry as Record<string, unknown>;
  assert.equal(typeof telemetry.llmDurationMs, "number");
  assert.equal(typeof telemetry.ffmpegDurationMs, "number");
  assert.equal(typeof telemetry.e2eDurationMs, "number");
  assert.equal(telemetry.providerMode, "primary");
  assert.equal(telemetry.selectedModel, "unit-test-model");
  assert.equal(telemetry.tokensUsed, 30);
  assert.equal(telemetry.tokenUsageAvailable, true);
  assert.ok(Number(telemetry.ttsChars) > 0);
  assert.equal(job.directorPlan?._providerTelemetry, undefined);
  const out = [...h.outputs.values()][0]!;
  assert.equal(out.mimeType, "video/mp4");
  assert.ok(out.sizeBytes > 0);
});

test("worker preserves planning API model, scene and selected voice telemetry when reusing a client plan", async () => {
  const h = createTestHarness();
  const prompt = "[User-selected creation scene: online-ecommerce] 为商品制作一支完整短片";
  const input = { mode: "image-film" as const, prompt, aspectRatio: "9:16" as const, assets: [{ name: "source.jpg", kind: "image" as const, size: 1024 }] };
  const generated = await createHeuristicDirectorPlanner().createPlan(input);
  const sourceTelemetry = {
    providerMode: "fallback", requestedModel: "primary-model", selectedModel: "fallback-model",
    modelsAttempted: ["primary-model", "fallback-model"], fallbackUsed: true,
    promptTokens: 11, completionTokens: 19, totalTokens: 30, usageAvailable: true, costUsageAvailable: true,
    scene: "online-ecommerce", sceneSource: "user-selected", variantMatched: null,
    voiceId: generated.voice_id, voiceType: Number(generated.voice_id), voiceCandidateIds: [Number(generated.voice_id)],
  };
  const job = await h.jobStore.createJob(user.id, {
    mode: input.mode, prompt, aspectRatio: input.aspectRatio, assetIds: [h.assetId],
    idempotencyKey: "66666666-2222-4333-8444-555555555555",
    directorPlan: Object.assign({ ...generated }, { _providerTelemetry: sourceTelemetry }),
  });
  const success = await processJob(job, { storage: h.storage, renderer: h.renderer, jobStore: h.jobStore, assetStore: h.assetStore, outputStore: h.outputStore });
  assert.equal(success, true);
  const telemetry = job.directorPlan?._telemetry as Record<string, unknown>;
  assert.equal(telemetry.providerMode, "fallback");
  assert.equal(telemetry.selectedModel, "fallback-model");
  assert.equal(telemetry.scene, "online-ecommerce");
  assert.equal(telemetry.sceneSource, "user-selected");
  assert.equal(telemetry.voiceId, generated.voice_id);
  assert.deepEqual(telemetry.voiceCandidateIds, [Number(generated.voice_id)]);
  assert.equal(job.directorPlan?._providerTelemetry, undefined);
});
test("worker runs Auto-QC before publishing and records the quality grade", async () => {
  const h = createTestHarness();
  const job = await h.jobStore.createJob(user.id, {
    mode: "image-film",
    prompt: "生成一条完整产品短片",
    aspectRatio: "9:16",
    assetIds: [h.assetId],
    idempotencyKey: "77777777-2222-4333-8444-555555555555",
  });
  let checks = 0;
  const success = await processJob(job, {
    storage: h.storage,
    renderer: h.renderer,
    jobStore: h.jobStore,
    assetStore: h.assetStore,
    outputStore: h.outputStore,
    directorPlanner: createHeuristicDirectorPlanner(),
    qualityChecker: async (_filePath, options) => {
      checks += 1;
      assert.equal(options?.requireAudio, true);
      return { passed: true, grade: "A", metrics: { durationSec: 10 }, warnings: [], errors: [], suggestedCorrections: [] };
    },
  });

  assert.equal(success, true);
  assert.equal(checks, 1);
  assert.equal(h.outputs.size, 1);
  const telemetry = job.directorPlan?._telemetry as Record<string, unknown>;
  assert.deepEqual(telemetry.qualityChecks, [{ grade: "A", metrics: { durationSec: 10 }, warnings: [] }]);
  assert.equal(telemetry.qualityPassed, true);
  assert.equal(telemetry.qualityCheckCount, 1);
});

test("worker blocks publication and refunds the job when Auto-QC rejects a render", async () => {
  const h = createTestHarness();
  const job = await h.jobStore.createJob(user.id, {
    mode: "image-film",
    prompt: "生成一条完整产品短片",
    aspectRatio: "9:16",
    assetIds: [h.assetId],
    idempotencyKey: "66666666-2222-4333-8444-555555555555",
  });
  let deletedOutputs = 0;
  const deleteObject = h.storage.deleteObject.bind(h.storage);
  h.storage.deleteObject = async (key) => {
    deletedOutputs += 1;
    await deleteObject(key);
  };
  const success = await processJob(job, {
    storage: h.storage,
    renderer: h.renderer,
    jobStore: h.jobStore,
    assetStore: h.assetStore,
    outputStore: h.outputStore,
    directorPlanner: createHeuristicDirectorPlanner(),
    qualityChecker: async () => ({
      passed: false,
      grade: "REJECT",
      metrics: {},
      warnings: [],
      errors: ["missing audio stream"],
      suggestedCorrections: [],
    }),
  });

  assert.equal(success, false);
  assert.equal(job.status, "failed");
  assert.equal(job.errorMessage, "AUTO_QC_REJECTED: generated media failed integrity checks");
  assert.equal(h.outputs.size, 0);
  assert.ok(deletedOutputs >= 1, "rejected private outputs must be cleaned up");
});

test("free entry jobs complete without touching billing settlement", async () => {
  const h = createTestHarness();
  const job = await h.jobStore.createJob(user.id, {
    mode: "image-film",
    prompt: "[User-selected creation scene: personal-creation.]\n拍一支个人口播自我介绍",
    aspectRatio: "9:16",
    assetIds: [h.assetId],
    idempotencyKey: "12121212-2222-4333-8444-555555555555",
  });
  job.requestPayload = { creationScene: "personal-creation" };
  let billingCalls = 0;
  const billingStore = {
    async completeJobAndSettle() { billingCalls += 1; throw new Error("free job must not settle credits"); },
    async settleCredits() { billingCalls += 1; throw new Error("free job must not settle credits"); },
    async refundCredits() { billingCalls += 1; throw new Error("free job must not refund credits"); },
  } as never;

  const success = await processJob(job, {
    storage: h.storage,
    renderer: h.renderer,
    jobStore: h.jobStore,
    assetStore: h.assetStore,
    outputStore: h.outputStore,
    directorPlanner: createHeuristicDirectorPlanner(),
    billingStore,
    workerId: "unit-free-worker",
  });

  assert.equal(success, true);
  assert.equal(job.status, "completed");
  assert.equal(job.progress, 100);
  assert.equal(billingCalls, 0);
});

test("worker permanently fails exhausted expired leases and refunds their held credits", async () => {
  const h = createTestHarness();
  const expiredJobId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  let recoverySql = "";
  let refunded = 0;
  const client = {
    async query(sql: string) {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (/WITH candidate AS/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/UPDATE generation_jobs/i.test(sql)) {
        recoverySql = sql;
        return { rows: [{ id: expiredJobId, user_id: user.id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() { },
  };
  const pool = {
    async connect() { return client; },
  };
  const handled = await processNextQueuedJob({
    pool: pool as never,
    storage: h.storage,
    renderer: h.renderer,
    jobStore: h.jobStore,
    assetStore: h.assetStore,
    outputStore: h.outputStore,
    billingStore: {
      async refundCredits(userId, jobId) {
        assert.equal(userId, user.id);
        assert.equal(jobId, expiredJobId);
        refunded += 1;
      },
    } as never,
  });

  assert.equal(handled, true);
  assert.match(recoverySql, /SET status = 'failed'/i);
  assert.match(recoverySql, /finished_at = COALESCE\(finished_at, now\(\)\)/i);
  assert.match(recoverySql, /worker_id = NULL/i);
  assert.match(recoverySql, /lease_expires_at = NULL/i);
  assert.match(recoverySql, /attempt_count >= 3/i);
  assert.match(recoverySql, /RETURNING id, user_id/i);
  assert.equal(refunded, 1);
});

test("worker retries refunds for already-failed exhausted jobs after a previous refund failure", async () => {
  const h = createTestHarness();
  const expiredJobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let retrySql = "";
  let refunded = 0;
  const client = {
    async query(sql: string) {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (/UPDATE generation_jobs/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT job\.id, job\.user_id/i.test(sql)) {
        retrySql = sql;
        return { rows: [{ id: expiredJobId, user_id: user.id }], rowCount: 1 };
      }
      if (/WITH candidate AS/i.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release() { },
  };
  const handled = await processNextQueuedJob({
    pool: { async connect() { return client; } } as never,
    storage: h.storage,
    renderer: h.renderer,
    jobStore: h.jobStore,
    assetStore: h.assetStore,
    outputStore: h.outputStore,
    billingStore: {
      async refundCredits(userId, jobId) {
        assert.equal(userId, user.id);
        assert.equal(jobId, expiredJobId);
        refunded += 1;
      },
    } as never,
  });

  assert.equal(handled, true);
  assert.match(retrySql, /WORKER_ATTEMPTS_EXHAUSTED/);
  assert.match(retrySql, /NOT EXISTS/i);
  assert.match(retrySql, /type = 'refund'/i);
  assert.equal(refunded, 1);
});

test("queue worker atomically claims one queued job before releasing it to rendering", async () => {
  const h = createTestHarness();
  const job = await h.jobStore.createJob(user.id, {
    mode: "image-film",
    prompt: "验证队列任务原子领取",
    aspectRatio: "9:16",
    assetIds: [h.assetId],
    idempotencyKey: "99999999-2222-4333-8444-555555555555",
  });
  let claimSql = "";
  const pool = {
    async connect() {
      return {
        async query(sql: string) {
          if (/WITH candidate AS/i.test(sql)) {
            claimSql = sql;
            job.status = "inspecting";
            job.progress = 20;
            return { rows: [{ id: job.id, user_id: job.userId }] };
          }
          return { rows: [] };
        },
        release() { },
      };
    },
  };

  const success = await processNextQueuedJob({
    pool: pool as never,
    storage: h.storage,
    renderer: h.renderer,
    jobStore: h.jobStore,
    assetStore: h.assetStore,
    outputStore: h.outputStore,
    directorPlanner: createHeuristicDirectorPlanner(),
  });

  assert.match(claimSql, /WITH candidate AS/i);
  assert.match(claimSql, /FOR UPDATE SKIP LOCKED/i);
  assert.match(claimSql, /SET status = 'inspecting'/i);
  assert.match(claimSql, /billing_ledger ledger[\s\S]*ledger.type = 'hold'/i);
  assert.match(claimSql, /lease_expires_at = now\(\) \+ interval '120 seconds'/i);
  assert.match(claimSql, /lease_expires_at IS NOT NULL AND lease_expires_at < now\(\)/i);
  assert.match(claimSql, /attempt_count < 3/i);
  assert.equal(success, true);
  assert.equal(job.status, "completed");
  assert.equal(h.outputs.size, 1);
});

test("authenticated user can query works library and stream mp4 output", async (t) => {
  const h = createTestHarness();
  const app = buildApp({
    allowedOrigins: [origin],
    logLevel: "silent",
    production: false,
    authStore: h.authStore,
    assetStore: h.assetStore,
    jobStore: h.jobStore,
    outputStore: h.outputStore,
    mediaStorage: h.storage,
  });
  t.after(async () => app.close());

  // 渲染并产生一个成片
  const job = await h.jobStore.createJob(user.id, {
    mode: "image-film",
    prompt: "生产一支短片",
    aspectRatio: "9:16",
    assetIds: [h.assetId],
    idempotencyKey: "11111111-2222-4333-8444-555555555555",
  });
  await processJob(job, {
    storage: h.storage,
    renderer: h.renderer,
    jobStore: h.jobStore,
    assetStore: h.assetStore,
    outputStore: h.outputStore,
  });

  // 获取作品库列表
  const listRes = await app.inject({
    method: "GET",
    url: "/api/v1/works",
    headers: { cookie: `jansee_session=${token}` },
  });
  assert.equal(listRes.statusCode, 200);
  const works = listRes.json().works;
  assert.equal(works.length, 1);
  const workId = works[0].id;

  // 查询单条作品元数据
  const detailRes = await app.inject({
    method: "GET",
    url: `/api/v1/works/${workId}`,
    headers: { cookie: `jansee_session=${token}` },
  });
  assert.equal(detailRes.statusCode, 200);
  assert.equal(detailRes.json().work.id, workId);

  // 流式下载 / 播放
  const streamRes = await app.inject({
    method: "GET",
    url: `/api/v1/works/${workId}/stream`,
    headers: { cookie: `jansee_session=${token}` },
  });
  assert.equal(streamRes.statusCode, 200);
  assert.equal(streamRes.headers["content-type"], "video/mp4");
  assert.ok(streamRes.rawPayload.length > 0);
});


test("worker routes an explicit fixed-duration slicing request to the multi-output V2 slicer", async () => {
  const root = await mkdtemp(join(tmpdir(), "jansee-worker-video-slice-"));
  const sourcePath = join(root, "source.mp4");
  const h = createTestHarness();
  const assetId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const assetKey = `users/${user.id}/${assetId}`;
  const asset: AssetRecord = {
    id: assetId,
    originalName: "source.mp4",
    mediaType: "video",
    mimeType: "video/mp4",
    sizeBytes: 1024,
    sha256: "video-test-hash",
    storageKey: assetKey,
  };
  let outputWrites = 0;
  const createOutput = h.outputStore.createOutput.bind(h.outputStore);
  h.outputStore.createOutput = async (output: NewOutput) => {
    outputWrites += 1;
    return createOutput(output);
  };

  try {
    execFileSync(ffmpeg, [
      "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "12",
      "-c:v", "libx264", "-g", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", sourcePath,
    ], { stdio: "ignore" });
    await h.storage.putFile(assetKey, sourcePath);
    h.assetStore.findUserAssets = async (userId, ids) => userId === user.id && ids.includes(assetId) ? [asset] : [];

    const job = await h.jobStore.createJob(user.id, {
      mode: "video-dub",
      prompt: "\u6bcf\u6bb5 5 \u79d2\u5207\u7247\uff0c\u4e0d\u8981\u5b57\u5e55\uff0c\u4e0d\u8981\u80cc\u666f\u97f3\u4e50",
      aspectRatio: "9:16",
      assetIds: [assetId],
      idempotencyKey: "88888888-2222-4333-8444-555555555555",
    });

    // 模拟 LLM 经过意图分析后，向执行层输出的结构化切片与分发决策
    const customPlanner: DirectorPlanner = {
      async createPlan(input) {
        const base = await createHeuristicDirectorPlanner().createPlan(input);
        return { ...base, operation: "video-slice", sliceSeconds: 5 };
      },
      async createPlans(input) {
        return [await this.createPlan(input)];
      },
    };

    const success = await processJob(job, {
      storage: h.storage,
      renderer: h.renderer,
      jobStore: h.jobStore,
      assetStore: h.assetStore,
      outputStore: h.outputStore,
      directorPlanner: customPlanner,
    });

    assert.equal(success, true);
    assert.equal(job.status, "completed");
    assert.equal(job.directorPlan?.operation, "video-slice");
    assert.equal(outputWrites, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker routes a one-video preserve-original-audio request through the ASR/original-audio production engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "jansee-worker-keep-original-"));
  const sourcePath = join(root, "source.mp4");
  const h = createTestHarness();
  const assetId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const assetKey = `users/${user.id}/${assetId}`;
  const asset: AssetRecord = {
    id: assetId,
    originalName: "source.mp4",
    mediaType: "video",
    mimeType: "video/mp4",
    sizeBytes: 1024,
    sha256: "original-audio-test-hash",
    storageKey: assetKey,
  };

  try {
    execFileSync(ffmpeg, [
      "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "6",
      "-c:v", "libx264", "-g", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", sourcePath,
    ], { stdio: "ignore" });
    await h.storage.putFile(assetKey, sourcePath);
    h.assetStore.findUserAssets = async (userId, ids) => userId === user.id && ids.includes(assetId) ? [asset] : [];

    const prompt = String.fromCharCode(0x4fdd, 0x7559, 0x539f, 0x58f0, 0xff0c, 0x4e0d, 0x8981, 0x914d, 0x97f3, 0xff0c, 0x4e0d, 0x8981, 0x5b57, 0x5e55, 0xff0c, 0x4e0d, 0x8981, 0x80cc, 0x666f, 0x97f3, 0x4e50);
    const job = await h.jobStore.createJob(user.id, {
      mode: "video-dub",
      prompt,
      aspectRatio: "9:16",
      assetIds: [assetId],
      idempotencyKey: "77777777-2222-4333-8444-555555555555",
    });

    const success = await processJob(job, {
      storage: h.storage,
      renderer: h.renderer,
      jobStore: h.jobStore,
      assetStore: h.assetStore,
      outputStore: h.outputStore,
      directorPlanner: createHeuristicDirectorPlanner(),
      engineRegistry: createDefaultProductionEngineRegistry(),
    });

    assert.equal(success, true);
    assert.equal(job.status, "completed");
    assert.equal(job.directorPlan?.operation, "keep-original");
    assert.equal(h.outputs.size, 1);
    const output = [...h.outputs.values()][0]!;
    assert.equal(hasAudioStream(await h.storage.getFilePath(output.storageKey)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("worker executes server-confirmed speech-cut using persisted ASR words and selected suggestion IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "jansee-worker-speech-cut-"));
  const sourcePath = join(root, "source.mp4");
  const h = createTestHarness();
  const assetId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const assetKey = `users/${user.id}/${assetId}`;
  const asset: AssetRecord = {
    id: assetId,
    originalName: "speech-source.mp4",
    mediaType: "video",
    mimeType: "video/mp4",
    sizeBytes: 1024,
    sha256: "speech-cut-test-hash",
    storageKey: assetKey,
  };

  try {
    execFileSync(ffmpeg, [
      "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "6",
      "-c:v", "libx264", "-g", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", sourcePath,
    ], { stdio: "ignore" });
    await h.storage.putFile(assetKey, sourcePath);
    h.assetStore.findUserAssets = async (userId, ids) => userId === user.id && ids.includes(assetId) ? [asset] : [];

    const job = await h.jobStore.createJob(user.id, {
      mode: "video-dub",
      prompt: "按确认结果剪掉口头语，保留原声",
      aspectRatio: "9:16",
      assetIds: [assetId],
      idempotencyKey: "88888888-2222-4333-8444-555555555556",
      directorPlan: {
        operation: "speech-cut",
        _serverValidatedSpeechCut: true,
        title: "口播精剪",
        packaging: { intro: false, ending: false, subtitles: false, bgm: false },
        speechCut: {
          durationSec: 6,
          words: [
            { word: "嗯", start: 1, end: 1.2, is_filler: true },
            { word: "我们", start: 2, end: 2.3 },
            { word: "开始", start: 2.4, end: 2.8 },
          ],
          selectedSuggestions: [
            { id: "99999999-9999-4999-8999-999999999999", start: 1, end: 1.2, word: "嗯", reason: "filler" },
          ],
        },
      },
    });

    const success = await processJob(job, {
      storage: h.storage,
      renderer: h.renderer,
      jobStore: h.jobStore,
      assetStore: h.assetStore,
      outputStore: h.outputStore,
      directorPlanner: createHeuristicDirectorPlanner(),
      engineRegistry: createDefaultProductionEngineRegistry(),
      qualityChecker: async () => ({ passed: true, grade: "A", metrics: { decoded: true }, warnings: [], errors: [], suggestedCorrections: [] }),
    });

    assert.equal(success, true);
    assert.equal(job.status, "completed");
    assert.equal(job.directorPlan?.operation, "speech-cut");
    assert.equal(h.outputs.size, 1);
    const output = [...h.outputs.values()][0]!;
    assert.ok(output.sizeBytes > 1024);
    assert.equal(hasAudioStream(await h.storage.getFilePath(output.storageKey)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("worker loop runs two queued heavy media jobs concurrently by default", async () => {
  const h = createTestHarness();
  const first = await h.jobStore.createJob(user.id, {
    mode: "image-film", prompt: "第一条并发验收", aspectRatio: "9:16",
    assetIds: [h.assetId], idempotencyKey: "worker-slot-first",
  });
  const second = {
    ...first,
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc",
    idempotencyKey: "worker-slot-second",
    prompt: "第二条并发验收",
    status: "queued" as const,
  };
  h.jobs.set(second.id, second);
  const queued = [first, second];
  let activeRenders = 0;
  let maxActiveRenders = 0;

  const pool = {
    async connect() {
      return {
        async query(sql: string) {
          if (/SELECT id, user_id FROM generation_jobs/i.test(sql)) return { rows: [] };
          if (/WITH candidate AS/i.test(sql)) {
            const next = queued.shift();
            if (!next) return { rows: [] };
            next.status = "inspecting";
            next.progress = 20;
            return { rows: [{ id: next.id, user_id: next.userId }] };
          }
          return { rows: [] };
        },
        release() { },
      };
    },
  };

  const renderer = {
    async render(job: GenerationJobRecord) {
      activeRenders += 1;
      maxActiveRenders = Math.max(maxActiveRenders, activeRenders);
      await new Promise((resolve) => setTimeout(resolve, 180));
      const tempFile = join(tmpdir(), `test-worker-slot-${job.id}.mp4`);
      await writeFile(tempFile, Buffer.from("parallel-render-output"));
      const storageKey = `users/${job.userId}/outputs/${job.id}.mp4`;
      const stored = await h.storage.putFile(storageKey, tempFile);
      activeRenders -= 1;
      return { storageKey, mimeType: "video/mp4", sizeBytes: stored.sizeBytes, durationMs: 10_000, width: 1080, height: 1920 };
    },
  };

  const loop = startJobWorkerLoop({
    pool: pool as never,
    storage: h.storage,
    renderer: renderer as never,
    jobStore: h.jobStore,
    assetStore: h.assetStore,
    outputStore: h.outputStore,
    directorPlanner: createHeuristicDirectorPlanner(),
  }, 10, 2);

  try {
    const deadline = Date.now() + 5_000;
    while ((first.status !== "completed" || second.status !== "completed") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    loop.stop();
  }

  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(maxActiveRenders, 2, "V2 baseline allows exactly two concurrent heavy media jobs");
});

test("worker honors batch variantOverride from requestPayload when replanning", async () => {
  const h = createTestHarness();
  const job = await h.jobStore.createJob(user.id, {
    mode: "image-film",
    prompt: "生产一支短片",
    aspectRatio: "9:16",
    assetIds: [h.assetId],
    idempotencyKey: "55555555-2222-4333-8444-555555555555",
  });
  // 批量赛马 v2..N：服务端在 requestPayload 注入轮转变体，worker 补跑 LLM 时必须锁定
  job.requestPayload = { variantOverride: "C-福利低价型" };

  const seenInputs: Array<{ variantOverride?: string }> = [];
  const success = await processJob(job, {
    storage: h.storage,
    renderer: h.renderer,
    jobStore: h.jobStore,
    assetStore: h.assetStore,
    outputStore: h.outputStore,
    directorPlanner: {
      async createPlan(input) {
        seenInputs.push(input);
        return createHeuristicDirectorPlanner().createPlan(input);
      },
    },
  });

  assert.equal(success, true);
  assert.equal(job.status, "completed");
  assert.equal(seenInputs[0]?.variantOverride, "C-福利低价型");
  assert.equal(job.directorPlan?.variant_type, "C-福利低价型");
});
