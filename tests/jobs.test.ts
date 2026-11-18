import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { buildApp } from "../apps/api/src/app.ts";
import type { AuthStore, AuthUser } from "../apps/api/src/auth.ts";
import type { AssetStore, AssetRecord } from "../apps/api/src/assets.ts";
import type { JobStore, GenerationJobRecord, CreateJobRequest } from "../apps/api/src/jobs.ts";
import { InMemoryBillingStore, type BillingStore } from "../apps/api/src/billing.ts";
import { assertJobTransition } from "@jansee/domain";

const origin = "https://jansee.example";
const token = "c".repeat(43);
const user: AuthUser = { id: "user-123", email: "director@example.com", displayName: "Director", createdAt: new Date() };

function createMocks() {
  const authStore: AuthStore = {
    async createUser() { return user; },
    async findUserByEmail() { return null; },
    async createSession() {},
    async findSession(hash) {
      return hash === createHash("sha256").update(token).digest("hex")
        ? { user, expiresAt: new Date(Date.now() + 60_000) }
        : null;
    },
    async revokeSession() {},
  };

  const assets: AssetRecord[] = [
    { id: "11111111-1111-4111-8111-111111111111", originalName: "clip1.mp4", mediaType: "video", mimeType: "video/mp4", sizeBytes: 1000, sha256: "hash1", storageKey: "key1" },
    { id: "22222222-2222-4222-8222-222222222222", originalName: "clip2.mp4", mediaType: "video", mimeType: "video/mp4", sizeBytes: 2000, sha256: "hash2", storageKey: "key2" },
  ];

  const assetStore: AssetStore = {
    async createAssets() {},
    async findUserAssets(userId, assetIds) {
      if (userId !== user.id) return [];
      return assets.filter((a) => assetIds.includes(a.id));
    },
  };

  const jobs = new Map<string, GenerationJobRecord>();
  let jobSequence = 0;

  const jobStore: JobStore = {
    async createJob(userId, input) {
      const existing = [...jobs.values()].find((j) => j.userId === userId && j.idempotencyKey === input.idempotencyKey);
      if (existing) return existing;

      jobSequence += 1;
      const record: GenerationJobRecord = {
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(jobSequence).padStart(12, "0")}`,
        userId,
        mode: input.mode,
        status: "queued",
        prompt: input.prompt,
        aspectRatio: input.aspectRatio,
        idempotencyKey: input.idempotencyKey,
        requestPayload: input as unknown as Record<string, unknown>,
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
      jobs.set(record.id, record);
      return record;
    },
    async findJobById(userId, jobId) {
      const job = jobs.get(jobId);
      return job && job.userId === userId ? job : null;
    },
    async findUserActiveJob(userId) {
      return [...jobs.values()].find((job) => job.userId === userId
        && ["queued", "inspecting", "planning", "rendering", "quality-check"].includes(job.status)) ?? null;
    },
    async updateJobStatus(userId, jobId, toStatus, progress, error) {
      const job = jobs.get(jobId);
      if (!job || job.userId !== userId) return null;
      assertJobTransition(job.status, toStatus);
      job.status = toStatus;
      if (typeof progress === "number") job.progress = progress;
      if (error) {
        job.errorCode = error.code;
        job.errorMessage = error.message;
      }
      return job;
    },
  };

  return { authStore, assetStore, jobStore, jobs };
}

test("job creation requires authentication", async (t) => {
  const mocks = createMocks();
  const app = buildApp({
    allowedOrigins: [origin],
    logLevel: "silent",
    production: false,
    authStore: mocks.authStore,
    assetStore: mocks.assetStore,
    jobStore: mocks.jobStore,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/jobs",
    headers: { origin },
    payload: {
      mode: "video-dub",
      prompt: "做解说",
      aspectRatio: "9:16",
      assetIds: ["11111111-1111-4111-8111-111111111111"],
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
    },
  });
  assert.equal(response.statusCode, 401);
});

test("job creation validates asset ownership and rejects foreign asset IDs", async (t) => {
  const mocks = createMocks();
  const app = buildApp({
    allowedOrigins: [origin],
    logLevel: "silent",
    production: false,
    authStore: mocks.authStore,
    assetStore: mocks.assetStore,
    jobStore: mocks.jobStore,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/jobs",
    headers: { origin, cookie: `jansee_session=${token}` },
    payload: {
      mode: "video-dub",
      prompt: "做解说",
      aspectRatio: "9:16",
      assetIds: ["99999999-9999-4999-8999-999999999999"],
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
    },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, "ASSET_NOT_FOUND");
});

test("authenticated user creates a job with idempotency deduplication", async (t) => {
  const mocks = createMocks();
  const app = buildApp({
    allowedOrigins: [origin],
    logLevel: "silent",
    production: false,
    authStore: mocks.authStore,
    assetStore: mocks.assetStore,
    jobStore: mocks.jobStore,
  });
  t.after(async () => app.close());

  const payload = {
    mode: "storyboard",
    prompt: "[User-selected creation scene: online-ecommerce.]\n合成一段产品宣传片",
    aspectRatio: "9:16",
    assetIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
    directorPlan: { title: "产品大片" },
    idempotencyKey: "44444444-4444-4444-8444-444444444444",
  };

  const response1 = await app.inject({
    method: "POST",
    url: "/api/v1/jobs",
    headers: { origin, cookie: `jansee_session=${token}` },
    payload,
  });
  assert.equal(response1.statusCode, 201);
  const job = response1.json().job;
  assert.equal(job.status, "queued");
  assert.equal(job.progress, 0);
  assert.equal(mocks.jobs.get(job.id)?.requestPayload.creationScene, "online-ecommerce", "server-resolved creation scene must be persisted for the renderer");

  // 相同幂等键再次请求 -> 依然 201 返回同一个 Job
  const response2 = await app.inject({
    method: "POST",
    url: "/api/v1/jobs",
    headers: { origin, cookie: `jansee_session=${token}` },
    payload,
  });
  assert.equal(response2.statusCode, 201);
  assert.equal(response2.json().job.id, job.id);
  assert.equal(mocks.jobs.size, 1);
});

test("job status can be queried and transitions safely through domain lifecycle", async (t) => {
  const mocks = createMocks();
  const app = buildApp({
    allowedOrigins: [origin],
    logLevel: "silent",
    production: false,
    authStore: mocks.authStore,
    assetStore: mocks.assetStore,
    jobStore: mocks.jobStore,
  });
  t.after(async () => app.close());

  const created = await mocks.jobStore.createJob(user.id, {
    mode: "video-dub",
    prompt: "测试",
    aspectRatio: "9:16",
    assetIds: ["11111111-1111-4111-8111-111111111111"],
    idempotencyKey: "55555555-5555-4555-8555-555555555555",
  });

  // 查询任务状态
  const getRes = await app.inject({
    method: "GET",
    url: `/api/v1/jobs/${created.id}`,
    headers: { cookie: `jansee_session=${token}` },
  });
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.json().job.status, "queued");

  // 安全状态流转：queued -> inspecting -> planning -> rendering -> quality-check -> completed
  await mocks.jobStore.updateJobStatus!(user.id, created.id, "inspecting", 20);
  await mocks.jobStore.updateJobStatus!(user.id, created.id, "planning", 40);
  await mocks.jobStore.updateJobStatus!(user.id, created.id, "rendering", 75);
  await mocks.jobStore.updateJobStatus!(user.id, created.id, "quality-check", 95);
  await mocks.jobStore.updateJobStatus!(user.id, created.id, "completed", 100);

  const getCompletedRes = await app.inject({
    method: "GET",
    url: `/api/v1/jobs/${created.id}`,
    headers: { cookie: `jansee_session=${token}` },
  });
  assert.equal(getCompletedRes.json().job.status, "completed");
  assert.equal(getCompletedRes.json().job.progress, 100);

  // 终态不允许非法反向流转
  await assert.rejects(
    () => mocks.jobStore.updateJobStatus!(user.id, created.id, "queued", 0),
    /Invalid job state transition/,
  );
});

test("job creation is gated to one in-flight task per user", async (t) => {
  const mocks = createMocks();
  const app = buildApp({
    allowedOrigins: [origin],
    logLevel: "silent",
    production: false,
    authStore: mocks.authStore,
    assetStore: mocks.assetStore,
    jobStore: mocks.jobStore,
  });
  t.after(async () => app.close());

  const first = await app.inject({
    method: "POST",
    url: "/api/v1/jobs",
    headers: { origin, cookie: `jansee_session=${token}` },
    payload: {
      mode: "video-dub",
      prompt: "做一支带货解说视频",
      aspectRatio: "9:16",
      assetIds: ["11111111-1111-4111-8111-111111111111"],
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
    },
  });
  assert.equal(first.statusCode, 201);

  // 已有在途任务时，换一个幂等键再次提交 → 409 门禁拦截
  const second = await app.inject({
    method: "POST",
    url: "/api/v1/jobs",
    headers: { origin, cookie: `jansee_session=${token}` },
    payload: {
      mode: "video-dub",
      prompt: "做另一支带货解说视频",
      aspectRatio: "9:16",
      assetIds: ["11111111-1111-4111-8111-111111111111"],
      idempotencyKey: "77777777-7777-4777-8777-777777777777",
    },
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error.code, "ACTIVE_JOB_EXISTS");
  assert.equal(second.json().error.activeJobId, first.json().job.id);
  assert.equal(mocks.jobs.size, 1);
});

test("batch versions create N independent jobs with per-version credit holds", async (t) => {
  const mocks = createMocks();
  const billingStore = new InMemoryBillingStore({ initialGrant: 1000 });
  const app = buildApp({
    allowedOrigins: [origin],
    logLevel: "silent",
    production: false,
    authStore: mocks.authStore,
    assetStore: mocks.assetStore,
    jobStore: mocks.jobStore,
    billingStore,
  });
  t.after(async () => app.close());

  const clientKey = "88888888-8888-4888-8888-888888888888";
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/jobs",
    headers: { origin, cookie: `jansee_session=${token}` },
    payload: {
      mode: "video-dub",
      prompt: "做一支带货解说视频，突出性价比",
      aspectRatio: "9:16",
      assetIds: ["11111111-1111-4111-8111-111111111111"],
      directorPlan: { title: "批量方案" },
      idempotencyKey: clientKey,
      versions: 3,
    },
  });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.batch.total, 3);
  assert.equal(body.jobs.length, 3);
  assert.equal(body.job.id, body.jobs[0].id);
  assert.equal(new Set(body.jobs.map((job: { id: string }) => job.id)).size, 3);

  // 计费：3 版各冻结 200，共 600
  const wallet = await billingStore.getWallet(user.id);
  assert.equal(wallet.frozenCredits, 600);
  assert.equal(wallet.availableCredits, 400);

  const records = [...mocks.jobs.values()];
  assert.equal(records.length, 3);
  const v1 = records.find((record) => record.idempotencyKey === clientKey)!;
  assert.ok(v1);
  assert.deepEqual(v1.directorPlan, { title: "批量方案" });
  assert.equal(v1.requestPayload.batchIndex, undefined);

  for (let index = 1; index < 3; index += 1) {
    const record = records.find((item) => item.idempotencyKey !== clientKey && item.requestPayload.batchIndex === index + 1)!;
    assert.ok(record, `version ${index + 1} record missing`);
    // v2..N：剥掉客户端方案，由 worker 补跑 LLM；幂等键为确定性派生的合法 uuid
    assert.equal(record.directorPlan, null);
    assert.equal(typeof record.requestPayload.variantOverride, "string");
    assert.match(record.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  const overrides = records
    .filter((record) => record.idempotencyKey !== clientKey)
    .map((record) => record.requestPayload.variantOverride);
  assert.equal(new Set(overrides).size, overrides.length, "batch variants must be distinct within the batch");
});

test("batch creation requires N×200 credits upfront", async (t) => {
  const mocks = createMocks();
  const billingStore = new InMemoryBillingStore({ initialGrant: 500 });
  const app = buildApp({
    allowedOrigins: [origin],
    logLevel: "silent",
    production: false,
    authStore: mocks.authStore,
    assetStore: mocks.assetStore,
    jobStore: mocks.jobStore,
    billingStore,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/jobs",
    headers: { origin, cookie: `jansee_session=${token}` },
    payload: {
      mode: "video-dub",
      prompt: "做一支带货解说视频",
      aspectRatio: "9:16",
      assetIds: ["11111111-1111-4111-8111-111111111111"],
      idempotencyKey: "99999999-9999-4999-8999-999999999999",
      versions: 3,
    },
  });
  assert.equal(response.statusCode, 402);
  const body = response.json();
  assert.equal(body.error.code, "INSUFFICIENT_CREDITS");
  assert.equal(body.error.requiredCredits, 600);
  assert.equal(mocks.jobs.size, 0);
});

test("batch creation rolls back created jobs and refunds holds when a hold fails", async (t) => {
  const mocks = createMocks();
  const base = new InMemoryBillingStore({ initialGrant: 1000 });
  const originalHold = base.holdCredits.bind(base);
  let holdCalls = 0;
  const billingStore = Object.assign(base, {
    async holdCredits(...args: Parameters<BillingStore["holdCredits"]>) {
      holdCalls += 1;
      if (holdCalls === 3) throw new Error("HOLD_EXPLODED");
      return originalHold(...args);
    },
  }) as BillingStore;
  const app = buildApp({
    allowedOrigins: [origin],
    logLevel: "silent",
    production: false,
    authStore: mocks.authStore,
    assetStore: mocks.assetStore,
    jobStore: mocks.jobStore,
    billingStore,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/jobs",
    headers: { origin, cookie: `jansee_session=${token}` },
    payload: {
      mode: "video-dub",
      prompt: "做一支带货解说视频",
      aspectRatio: "9:16",
      assetIds: ["11111111-1111-4111-8111-111111111111"],
      idempotencyKey: "aaaaaaaa-1111-4111-8111-111111111111",
      versions: 3,
    },
  });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.code, "BATCH_CREATE_FAILED");

  // 第 3 版冻结失败：该任务已创建入列（push-before-hold 防孤儿），三版全部回退为 failed，积分全额解冻
  assert.equal(mocks.jobs.size, 3);
  for (const record of mocks.jobs.values()) {
    const fetched = await app.inject({
      method: "GET",
      url: `/api/v1/jobs/${record.id}`,
      headers: { cookie: `jansee_session=${token}` },
    });
    assert.equal(fetched.json().job.status, "failed");
    assert.equal(fetched.json().job.errorCode, "BATCH_CREATE_ROLLBACK");
  }
  const wallet = await billingStore.getWallet(user.id);
  assert.equal(wallet.frozenCredits, 0);
  assert.equal(wallet.availableCredits, 1000);
});

test("personal scene requests are forced to single version even when versions is supplied", async (t) => {
  const mocks = createMocks();
  const billingStore = new InMemoryBillingStore({ initialGrant: 1000 });
  const app = buildApp({
    allowedOrigins: [origin],
    logLevel: "silent",
    production: false,
    authStore: mocks.authStore,
    assetStore: mocks.assetStore,
    jobStore: mocks.jobStore,
    billingStore,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/jobs",
    headers: { origin, cookie: `jansee_session=${token}` },
    payload: {
      mode: "video-dub",
      prompt: "[User-selected creation scene: personal-creation.]\n拍一支口播自我介绍",
      aspectRatio: "9:16",
      assetIds: ["11111111-1111-4111-8111-111111111111"],
      idempotencyKey: "bbbbbbbb-1111-4111-8111-111111111111",
      versions: 5,
    },
  });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.ok(body.job);
  assert.equal(body.jobs, undefined);
  assert.equal(mocks.jobs.size, 1);
  const wallet = await billingStore.getWallet(user.id);
  assert.equal(wallet.frozenCredits, 200);
});

