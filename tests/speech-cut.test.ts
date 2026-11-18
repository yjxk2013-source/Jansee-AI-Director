import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildApp } from "../apps/api/src/app.ts";
import { InMemoryBillingStore } from "../apps/api/src/billing.ts";
import type { AuthStore, AuthUser } from "../apps/api/src/auth.ts";
import type { AssetStore, AssetRecord } from "../apps/api/src/assets.ts";
import type { JobStore, GenerationJobRecord, CreateJobRequest } from "../apps/api/src/jobs.ts";
import type { SpeechCutStore, SpeechCutSession, SpeechCutSuggestion } from "../apps/api/src/speech-cut-store.ts";

const origin = "https://jansee.example";
const token = "s".repeat(43);
const user: AuthUser = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  email: "speech@example.com",
  displayName: "Speech User",
  createdAt: new Date(),
};
const asset: AssetRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  originalName: "talking-head.mp4",
  mediaType: "video",
  mimeType: "video/mp4",
  sizeBytes: 1024,
  sha256: "a".repeat(64),
  storageKey: "users/test/video",
};

function createSpeechMocks() {
  let session: SpeechCutSession = {
    id: "22222222-2222-4222-8222-222222222222",
    userId: user.id,
    assetId: asset.id,
    status: "analyzing",
    durationSec: null,
    transcript: "",
    words: [],
    suggestions: [],
    selectedSuggestionIds: null,
    jobId: null,
    errorMessage: null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  let resolveAnalysis!: () => void;
  const analysisCompleted = new Promise<void>((resolve) => { resolveAnalysis = resolve; });
  const speechCutStore: SpeechCutStore = {
    async createSession() { return session; },
    async completeAnalysis(_userId, _sessionId, result) {
      session = {
        ...session,
        status: "awaiting_confirmation",
        durationSec: result.durationSec,
        transcript: result.transcript,
        words: result.words,
        suggestions: result.suggestions,
        updatedAt: new Date(),
      };
      resolveAnalysis();
    },
    async failAnalysis(_userId, _sessionId, message) {
      session = { ...session, status: "failed", errorMessage: message };
      resolveAnalysis();
    },
    async findSession(userId, sessionId) {
      return userId === user.id && sessionId === session.id ? session : null;
    },
    async claimForProduction(userId, sessionId, suggestionIds) {
      if (userId !== user.id || sessionId !== session.id || session.status !== "awaiting_confirmation") return false;
      session = { ...session, status: "producing", selectedSuggestionIds: suggestionIds };
      return true;
    },
    async attachJob(_userId, _sessionId, jobId) {
      session = { ...session, status: "consumed", jobId };
    },
    async releaseClaim() {
      session = { ...session, status: "awaiting_confirmation", selectedSuggestionIds: null };
    },
  };

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
  const assetStore: AssetStore = {
    async createAssets() {},
    async findUserAssets(userId, ids) {
      return userId === user.id && ids.includes(asset.id) ? [asset] : [];
    },
  };
  let createdJob: GenerationJobRecord | null = null;
  const jobStore: JobStore = {
    async createJob(userId, input: CreateJobRequest) {
      createdJob = {
        id: "33333333-3333-4333-8333-333333333333",
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
      return createdJob;
    },
    async findJobById() { return createdJob; },
  };
  const suggestions: Array<Omit<SpeechCutSuggestion, "id">> = [
    { start: 1, end: 1.2, word: "嗯", reason: "filler" },
    { start: 1.2, end: 1.9, word: "停顿 0.7s", reason: "pause" },
  ];
  const app = buildApp({
    allowedOrigins: [origin],
    logLevel: "silent",
    production: false,
    authStore,
    assetStore,
    jobStore,
    speechCutStore,
    billingStore: new InMemoryBillingStore({ initialGrant: 1000 }),
    mediaStorage: {
      async putFile() { return { sizeBytes: 1 }; },
      async getFilePath() { return "test-video-file"; },
      async deleteObject() {},
      async deleteExpired() { return 0; },
    },
    speechCutAnalyzer: async () => ({
      text: "嗯，我们开始",
      words: [
        { word: "嗯", start: 1, end: 1.2, is_filler: true },
        { word: "我们", start: 2, end: 2.3 },
        { word: "开始", start: 2.4, end: 2.8 },
      ],
    }),
    speechCutSuggestionDetector: () => suggestions,
    speechCutInspectVideo: () => ({ durationSec: 30, hasAudio: true }),
  });
  return { app, analysisCompleted, getSession: () => session, getJob: () => createdJob };
}

test("speech-cut analysis is authenticated and persists server-generated suggestion IDs", async (t) => {
  const mocks = createSpeechMocks();
  t.after(async () => mocks.app.close());

  const unauthenticated = await mocks.app.inject({
    method: "POST",
    url: "/api/v1/speech-cut/analyze",
    headers: { origin },
    payload: { assetId: asset.id },
  });
  assert.equal(unauthenticated.statusCode, 401);

  const accepted = await mocks.app.inject({
    method: "POST",
    url: "/api/v1/speech-cut/analyze",
    headers: { origin, cookie: `jansee_session=${token}` },
    payload: { assetId: asset.id },
  });
  assert.equal(accepted.statusCode, 202);
  assert.equal(accepted.json().session.status, "analyzing");

  await mocks.analysisCompleted;
  const sessionId = accepted.json().session.id;
  const result = await mocks.app.inject({
    method: "GET",
    url: `/api/v1/speech-cut/${sessionId}`,
    headers: { cookie: `jansee_session=${token}` },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().session.status, "awaiting_confirmation");
  assert.equal(result.json().session.words.length, 3);
  assert.ok(result.json().session.suggestions[0].id);
  assert.notEqual(result.json().session.suggestions[0].id, "1");
});

test("speech-cut confirmation accepts only stored suggestion IDs and creates a protected job", async (t) => {
  const mocks = createSpeechMocks();
  t.after(async () => mocks.app.close());

  const accepted = await mocks.app.inject({
    method: "POST",
    url: "/api/v1/speech-cut/analyze",
    headers: { origin, cookie: `jansee_session=${token}` },
    payload: { assetId: asset.id },
  });
  await mocks.analysisCompleted;
  const sessionId = accepted.json().session.id;
  const session = mocks.getSession();
  const suggestionId = session.suggestions[0]!.id;

  const tampered = await mocks.app.inject({
    method: "POST",
    url: `/api/v1/speech-cut/${sessionId}/confirm`,
    headers: { origin, cookie: `jansee_session=${token}` },
    payload: { suggestionIds: ["99999999-9999-4999-8999-999999999999"] },
  });
  assert.equal(tampered.statusCode, 400);
  assert.equal(mocks.getSession().status, "awaiting_confirmation");

  const confirmed = await mocks.app.inject({
    method: "POST",
    url: `/api/v1/speech-cut/${sessionId}/confirm`,
    headers: { origin, cookie: `jansee_session=${token}` },
    payload: { suggestionIds: [suggestionId] },
  });
  assert.equal(confirmed.statusCode, 202);
  assert.equal(confirmed.json().jobId, "33333333-3333-4333-8333-333333333333");
  assert.equal(mocks.getSession().status, "consumed");
  assert.equal(mocks.getJob()?.directorPlan?.operation, "speech-cut");
  const speechCut = mocks.getJob()?.directorPlan?.speechCut as { selectedSuggestions: SpeechCutSuggestion[] };
  assert.equal(speechCut.selectedSuggestions[0]?.id, suggestionId);

  const duplicate = await mocks.app.inject({
    method: "POST",
    url: `/api/v1/speech-cut/${sessionId}/confirm`,
    headers: { origin, cookie: `jansee_session=${token}` },
    payload: { suggestionIds: [suggestionId] },
  });
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.json().jobId, confirmed.json().jobId);
});

test("public job endpoint rejects client-authored speech-cut execution plans", async (t) => {
  const mocks = createSpeechMocks();
  t.after(async () => mocks.app.close());

  const response = await mocks.app.inject({
    method: "POST",
    url: "/api/v1/jobs",
    headers: { origin, cookie: `jansee_session=${token}` },
    payload: {
      mode: "video-dub",
      prompt: "精剪",
      assetIds: [asset.id],
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      directorPlan: { operation: "speech-cut", _serverValidatedSpeechCut: true },
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "UNTRUSTED_SPEECH_CUT_PLAN");
});
