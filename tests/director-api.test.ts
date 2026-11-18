import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { TENCENT_VOICE_CANDIDATES, applyTencentVoiceHealthSnapshot } from "../packages/tts-kit/voices.js";
import { buildApp } from "../apps/api/src/app.ts";
import { createHeuristicDirectorPlanner, createOpenAICompatiblePlanner, DirectorPlanSchema, type DirectorPlan } from "../apps/api/src/director.ts";
import { buildDirectorSystemPrompt, buildDirectorUserPrompt, detectCreationScene, detectSceneIntent, resolveDirectorRoute } from "../apps/api/src/prompt-assembly.ts";
import type { AuthStore } from "../apps/api/src/auth.ts";
import type { AssetStore } from "../apps/api/src/assets.ts";

const healthyVoiceSnapshot = [...new Map(TENCENT_VOICE_CANDIDATES.map((voice) => [voice.voiceType, { voiceType: voice.voiceType, status: "healthy" }])).values()];
applyTencentVoiceHealthSnapshot(healthyVoiceSnapshot);

const validPlan: DirectorPlan = {
  title: "产品质感短片",
  concept: "以产品细节和真实使用场景建立可信赖的品牌印象。",
  durationSeconds: 24,
  scenes: [
    { order: 1, description: "用产品整体画面建立第一印象", durationSeconds: 5 },
    { order: 2, description: "通过细节画面呈现材质与功能", durationSeconds: 9 },
    { order: 3, description: "以使用场景和品牌信息收尾", durationSeconds: 10 },
  ],
  style: "自然光、克制的商业电影感",
  soundtrack: "轻节奏、现代感纯音乐",
  anchor: "yu-jie",
  voice_id: "403010",
  speech_speed: 1.0,
  variant_type: "H-情感共鸣型",
};

const requestBody = {
  mode: "image-film",
  prompt: "为新品制作一支高级感短片",
  aspectRatio: "9:16",
  assets: [{ name: "product.jpg", kind: "image", size: 1024 }],
};

test("director output contract rejects FPS and keeps frame-rate decisions inside the renderer", () => {
  const result = DirectorPlanSchema.safeParse({ ...validPlan, fps: 60 });
  assert.equal(result.success, false, "导演输出不得包含 fps 字段");
});

test("director endpoint clearly reports when the provider is not configured", async (t) => {
  const app = buildApp({ allowedOrigins: [], logLevel: "silent", production: false });
  t.after(async () => app.close());
  const response = await app.inject({ method: "POST", url: "/api/v1/director/plan", payload: requestBody });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "DIRECTOR_NOT_CONFIGURED");
});

test("director endpoint validates input before calling the provider", async (t) => {
  let called = false;
  const app = buildApp({
    allowedOrigins: [], logLevel: "silent", production: false,
    directorPlanner: { async createPlan() { called = true; return validPlan; } },
  });
  t.after(async () => app.close());
  const response = await app.inject({
    method: "POST", url: "/api/v1/director/plan",
    payload: { ...requestBody, assets: [{ name: "clip.mp4", kind: "video", size: 1024 }] },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
});

test("director endpoint preserves provider telemetry with the validated plan for worker attribution", async (t) => {
  const telemetry = {
    providerMode: "fallback", requestedModel: "primary-model", selectedModel: "fallback-model",
    modelsAttempted: ["primary-model", "fallback-model"], fallbackUsed: true,
    promptTokens: 10, completionTokens: 20, totalTokens: 30, usageAvailable: true, costUsageAvailable: true,
    scene: "online-ecommerce", sceneSource: "user-selected", anchorHit: true, variantMatched: null,
    voiceId: "403010", voiceType: 403010, voiceCandidateIds: [403010, 403009],
  };
  const app = buildApp({
    allowedOrigins: [], logLevel: "silent", production: false,
    directorPlanner: { async createPlan() { return Object.assign({ ...validPlan }, { _providerTelemetry: telemetry }); } },
  });
  t.after(async () => app.close());
  const response = await app.inject({ method: "POST", url: "/api/v1/director/plan", payload: requestBody });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().plan.title, validPlan.title);
  assert.deepEqual(response.json().plan._providerTelemetry, telemetry);
});

test("OpenAI-compatible planner keeps the API key server-side and parses structured output", async () => {
  let capturedHeaders: HeadersInit | undefined;
  let capturedBody: Record<string, unknown> | undefined;
  const planner = createOpenAICompatiblePlanner({
    baseUrl: "https://provider.example/v1/",
    apiKey: "server-secret",
    model: "test-model",
    maxTokens: 1_200,
    thinkingBudget: 512,
    fetchImpl: async (_input, init) => {
      capturedHeaders = init?.headers;
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validPlan) } }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  });
  const plan = await planner.createPlan(requestBody as Parameters<typeof planner.createPlan>[0]);
  assert.equal(plan.title, validPlan.title);
  assert.equal((capturedHeaders as Record<string, string>).authorization, "Bearer server-secret");
  assert.equal(capturedBody?.model, "test-model");
  assert.equal(capturedBody?.max_tokens, 1_200);
  assert.equal(capturedBody?.thinking_budget, 512);
});

test("OpenAI-compatible planner records model usage and falls back to heuristic output after invalid provider responses", async () => {
  const planner = createOpenAICompatiblePlanner({
    baseUrl: "https://provider.example/v1",
    apiKey: "server-secret",
    model: "test-model",
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }] }), {
      status: 200, headers: { "content-type": "application/json" },
    }),
  });
  const plan = await planner.createPlan(requestBody as Parameters<typeof planner.createPlan>[0]);
  const telemetry = (plan as typeof plan & { _providerTelemetry?: Record<string, unknown> })._providerTelemetry;
  assert.equal(typeof plan.title, "string");
  assert.equal(telemetry?.providerMode, "heuristic");
  assert.equal(telemetry?.fallbackUsed, true);
  assert.equal(telemetry?.usageAvailable, false);
  assert.equal(telemetry?.costUsageAvailable, false);
  assert.deepEqual(telemetry?.modelsAttempted, ["test-model"]);
});

test("director endpoint requires authentication when authStore is configured", async (t) => {
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async createSession() {},
    async findSession() { return null; },
    async revokeSession() {},
  };
  const app = buildApp({
    allowedOrigins: [], logLevel: "silent", production: false,
    authStore,
    directorPlanner: { async createPlan() { return validPlan; } },
  });
  t.after(async () => app.close());

  const response = await app.inject({ method: "POST", url: "/api/v1/director/plan", payload: requestBody });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "AUTH_REQUIRED");
});

test("director endpoint resolves owned assets by assetIds and rejects foreign assets", async (t) => {
  const token = "b".repeat(43);
  const user = { id: "user-abc", email: "user@example.com", displayName: "User", createdAt: new Date() };
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async createSession() {},
    async findSession(hash) {
      return hash === createHash("sha256").update(token).digest("hex") ? { user, expiresAt: new Date(Date.now() + 60_000) } : null;
    },
    async revokeSession() {},
  };

  const asset1Id = "11111111-1111-4111-8111-111111111111";
  const asset2Id = "22222222-2222-4222-8222-222222222222";
  const foreignAssetId = "99999999-9999-4999-8999-999999999999";

  const assetStore: AssetStore = {
    async createAssets() {},
    async findUserAssets(userId, assetIds) {
      if (userId !== "user-abc") return [];
      const owned = [
        { id: asset1Id, originalName: "clip1.mp4", mediaType: "video" as const, mimeType: "video/mp4", sizeBytes: 1000, sha256: "hash1", storageKey: "key1" },
        { id: asset2Id, originalName: "clip2.mp4", mediaType: "video" as const, mimeType: "video/mp4", sizeBytes: 2000, sha256: "hash2", storageKey: "key2" },
      ];
      return owned.filter((a) => assetIds.includes(a.id));
    },
  };

  let capturedInput: Parameters<NonNullable<Parameters<typeof buildApp>[0]["directorPlanner"]>["createPlan"]>[0] | undefined;
  const app = buildApp({
    allowedOrigins: [], logLevel: "silent", production: false,
    authStore,
    assetStore,
    directorPlanner: {
      async createPlan(input) {
        capturedInput = input;
        return validPlan;
      },
    },
  });
  t.after(async () => app.close());

  // 尝试使用未授权或他人的资产ID -> 404
  const foreignResponse = await app.inject({
    method: "POST", url: "/api/v1/director/plan",
    headers: { cookie: `jansee_session=${token}` },
    payload: {
      mode: "storyboard",
      prompt: "制作一段生活短视频",
      aspectRatio: "9:16",
      assetIds: [asset1Id, foreignAssetId],
    },
  });
  assert.equal(foreignResponse.statusCode, 404);
  assert.equal(foreignResponse.json().error.code, "ASSET_NOT_FOUND");

  // 使用自己的合法资产ID -> 200，并正确解析资产元数据
  const okResponse = await app.inject({
    method: "POST", url: "/api/v1/director/plan",
    headers: { cookie: `jansee_session=${token}` },
    payload: {
      mode: "storyboard",
      prompt: "制作一段生活短视频",
      aspectRatio: "9:16",
      assetIds: [asset1Id, asset2Id],
    },
  });
  assert.equal(okResponse.statusCode, 200);
  assert.equal(capturedInput?.mode, "storyboard");
  assert.equal(capturedInput?.assets.length, 2);
  assert.equal(capturedInput?.assets[0]?.name, "clip1.mp4");
  assert.equal(capturedInput?.assets[1]?.name, "clip2.mp4");
});


test("OpenAI-compatible director fails over across configured models after provider errors", async () => {
  const attempted: string[] = [];
  const planner = createOpenAICompatiblePlanner({
    baseUrl: "https://provider.example/v1",
    apiKey: "server-secret",
    model: "primary-model",
    fallbackModels: ["secondary-model", "tertiary-model"],
    timeoutMs: 1000,
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      attempted.push(body.model);
      if (body.model !== "tertiary-model") {
        return new Response("provider unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({
        model: "tertiary-model",
        usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
        choices: [{ message: { content: JSON.stringify(validPlan) } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const plan = await planner.createPlan(requestBody as Parameters<typeof planner.createPlan>[0]);
  const telemetry = (plan as typeof plan & { _providerTelemetry?: Record<string, unknown> })._providerTelemetry;
  assert.equal(plan.title, validPlan.title);
  assert.deepEqual(attempted, ["primary-model", "secondary-model", "tertiary-model"]);
  assert.equal(telemetry?.providerMode, "fallback");
  assert.equal(telemetry?.selectedModel, "tertiary-model");
  assert.equal(telemetry?.totalTokens, 200);
  assert.equal(telemetry?.usageAvailable, true);
  assert.equal(telemetry?.costUsageAvailable, true);
  assert.equal(telemetry?.fallbackUsed, true);
});

test("director fallback models receive their own longer timeout budget", async () => {
  const attempted: string[] = [];
  const planner = createOpenAICompatiblePlanner({
    baseUrl: "https://provider.example/v1",
    apiKey: "server-secret",
    model: "primary-model",
    fallbackModels: ["fallback-model"],
    timeoutMs: 5,
    fallbackTimeoutMs: 50,
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      attempted.push(body.model);
      if (body.model === "primary-model") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("primary timeout")), { once: true });
        });
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 20);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("fallback timeout"));
        }, { once: true });
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validPlan) } }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  });

  const plan = await planner.createPlan(requestBody as Parameters<typeof planner.createPlan>[0]);
  const telemetry = (plan as typeof plan & { _providerTelemetry?: Record<string, unknown> })._providerTelemetry;
  assert.equal(plan.title, validPlan.title);
  assert.deepEqual(attempted, ["primary-model", "fallback-model"]);
  assert.equal(telemetry?.providerMode, "fallback");
  assert.equal(telemetry?.selectedModel, "fallback-model");
});

test("director provider hard timeout falls back even when fetch ignores abort", async () => {
  const planner = createOpenAICompatiblePlanner({
    baseUrl: "https://provider.example/v1",
    apiKey: "server-secret",
    model: "stalled-model",
    timeoutMs: 10,
    fetchImpl: async () => new Promise<Response>(() => undefined),
  });
  const plan = await planner.createPlan(requestBody as Parameters<typeof planner.createPlan>[0]);
  const telemetry = (plan as typeof plan & { _providerTelemetry?: Record<string, unknown> })._providerTelemetry;
  assert.equal(plan.title.length > 0, true);
  assert.equal(telemetry?.providerMode, "heuristic");
  assert.match(String(telemetry?.failureReason), /timed out after 10ms/);
});

test("prompt assembly generates rich 2025-2026 hooks, emotions and persona for sell scene", () => {
  const input = {
    mode: "image-film" as const,
    prompt: "秋冬加厚保暖羊绒衫，软糯亲肤，不扎人，办公室穿搭必备",
    aspectRatio: "9:16" as const,
    assets: [
      { name: "sweater1.jpg", kind: "image" as const, size: 2048 },
      { name: "sweater2.jpg", kind: "image" as const, size: 4096 },
    ],
  };

  const scene = detectSceneIntent(input.prompt, input.mode);
  assert.equal(scene, "sell");

  const systemPrompt = buildDirectorSystemPrompt(input);
  assert.doesNotMatch(systemPrompt, /\bfps\b|frame.?rate|帧率/i, "系统提示词不得向导演开放帧率决策");
  // 必须包含 2025-2026 黄金3秒与情绪价值
  assert.match(systemPrompt, /黄金 3 秒法则/);
  assert.match(systemPrompt, /反常识\/认知颠覆型/);
  assert.match(systemPrompt, /去播音腔与去 AI 感/);
  assert.match(systemPrompt, /松弛感与情绪价值/);
  // 必须包含电商带货变体与主播池
  assert.match(systemPrompt, /变体类型/);
  assert.match(systemPrompt, /主播风格层/);
  // 必须包含发布四件套规范
  assert.match(systemPrompt, /发布方案规则/);
  assert.match(systemPrompt, /caption/);
  assert.match(systemPrompt, /cover_title/);

  const userPrompt = buildDirectorUserPrompt(input);
  assert.doesNotMatch(userPrompt, /\bfps\b|frame.?rate|帧率/i, "用户提示词不得传入帧率参数");
  const parsedUser = JSON.parse(userPrompt) as Record<string, unknown>;
  assert.equal(parsedUser.mode, "image-film");
  assert.equal((parsedUser.mediaFacts as Record<string, unknown>).assetCount, 2);
});

test("prompt assembly distinguishes local store scene with anti-ecommerce redlines and save-for-later orientation", () => {
  const input = {
    mode: "video-dub" as const,
    prompt: "巷子里的老字号铜锅涮肉，开了二十多年，手切鲜羊肉，同城街坊聚餐必去，人均60吃到撑",
    aspectRatio: "9:16" as const,
    assets: [{ name: "hotpot.mp4", kind: "video" as const, size: 10240 }],
  };

  const scene = detectSceneIntent(input.prompt, input.mode);
  assert.equal(scene, "local");

  const systemPrompt = buildDirectorSystemPrompt(input);
  // 必须包含同城到店和实体角色
  assert.match(systemPrompt, /实体角色风格层/);
  assert.match(systemPrompt, /绝对禁止电商网购与物流词汇/);
  assert.match(systemPrompt, /同城到店/);
  assert.match(systemPrompt, /收藏率与到店核销率/);
  assert.match(systemPrompt, /烟火气/);
});

test("OpenAI-compatible planner passes assembled prompts into provider completions payload", async () => {
  let capturedBody: { messages?: Array<{ role: string; content: string }> } | undefined;
  const planner = createOpenAICompatiblePlanner({
    baseUrl: "https://provider.example/v1",
    apiKey: "server-secret",
    model: "test-model",
    fetchImpl: async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content: string }> };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validPlan) } }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  });

  const plan = await planner.createPlan(requestBody as Parameters<typeof planner.createPlan>[0]);
  assert.equal(plan.title, validPlan.title);
  assert.ok(capturedBody?.messages && capturedBody.messages.length === 2);
  const systemMsg = capturedBody!.messages![0]!.content;
  const userMsg = capturedBody!.messages![1]!.content;
  // 验证注入的不是简陋的20行写死代码，而是包含了完整的 2025-2026 拼装体系
  assert.match(systemMsg, /黄金 3 秒法则/);
  assert.match(systemMsg, /主播风格层|实体角色风格层/);
  assert.match(userMsg, /creationGoal/);
  assert.match(userMsg, /mediaFacts/);
});




test("personal creation fallback is isolated and ordinary commercial routes leave variant choice to the persona director", async () => {
  const base = { mode: "image-film" as const, aspectRatio: "9:16" as const, assets: [{ name: "asset.jpg", kind: "image" as const, size: 1024 }] };
  const sellPrompt = "[User-selected creation scene: online-ecommerce.]\nCreate a product video";
  const personalPrompt = "[User-selected creation scene: personal-creation.]\nCreate a personal knowledge video";
  const route = resolveDirectorRoute({ ...base, prompt: sellPrompt });
  assert.equal(route.decidedVariant, null);
  const plan = await createHeuristicDirectorPlanner().createPlan({ ...base, prompt: personalPrompt });
  assert.equal(plan.anchor, "none");
  assert.equal(plan.variant_type, undefined);
});

test("explicit creation scene selects isolated director routes under the Constitution Director", () => {
  const base = { mode: "image-film" as const, aspectRatio: "9:16" as const, assets: [{ name: "asset.jpg", kind: "image" as const, size: 1024 }] };
  const onlinePrompt = "[User-selected creation scene: online-ecommerce.]\nCreate a product video";
  const localPrompt = "[User-selected creation scene: physical-store.]\nCreate a store visit video";
  const personalPrompt = "[User-selected creation scene: personal-creation.]\nCreate a personal knowledge video";
  assert.equal(detectCreationScene(onlinePrompt), "online-ecommerce");
  assert.equal(detectCreationScene(localPrompt), "physical-store");
  assert.equal(detectCreationScene(personalPrompt), "personal-creation");
  const online = buildDirectorSystemPrompt({ ...base, prompt: onlinePrompt });
  const local = buildDirectorSystemPrompt({ ...base, prompt: localPrompt });
  const personal = buildDirectorSystemPrompt({ ...base, prompt: personalPrompt });
  assert.match(online, /14 ecommerce variants/);
  assert.match(online, /yu-jie|laoba-pingce|b-tai/);
  assert.doesNotMatch(online, /local-friend|shopowner|craftsman|budget-guide/);
  assert.match(local, /8 local variants/);
  assert.match(local, /local-friend|shopowner|craftsman|budget-guide/);
  assert.doesNotMatch(local, /li-jiaqi|dong-yuhui/);
  assert.match(personal, /Personal creator path/);
  assert.doesNotMatch(personal, /yu-jie|laoba-pingce|b-tai|shopowner|local-friend|craftsman|budget-guide/);
  assert.match(personal, /\"anchor\": \"none\"/);
  assert.match(online, /Constitution Director owns global rules/);
  assert.doesNotMatch(online, /layout_id/);
});
