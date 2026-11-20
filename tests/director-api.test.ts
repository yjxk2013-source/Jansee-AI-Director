import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { TENCENT_VOICE_CANDIDATES, applyTencentVoiceHealthSnapshot } from "@jansee/tts-kit";
import { buildApp } from "../apps/api/src/app.ts";
import { createHeuristicDirectorPlanner, createOpenAICompatiblePlanner, DirectorPlanSchema, type DirectorPlan } from "../apps/api/src/director.ts";
import { buildDirectorSystemPrompt, buildDirectorUserPrompt, detectCreationScene, detectSceneIntent, resolveDirectorRoute, withCreationSceneMarker } from "../apps/api/src/prompt-assembly.ts";
import type { AuthStore } from "../apps/api/src/auth.ts";
import type { AssetStore } from "../apps/api/src/assets.ts";

const healthyVoiceSnapshot = [...new Map(TENCENT_VOICE_CANDIDATES.map((voice) => [voice.voiceType, { voiceType: voice.voiceType, status: "healthy" }])).values()];
applyTencentVoiceHealthSnapshot(healthyVoiceSnapshot);

const validPlan: DirectorPlan = {
  title: "产品质感短片",
  concept: "以产品细节和真实使用场景建立可信赖的品牌印象。",
  scenes: [
    { order: 1, description: "用产品整体画面建立第一印象" },
    { order: 2, description: "通过细节画面呈现材质与功能" },
    { order: 3, description: "以使用场景和品牌信息收尾" },
  ],
  style: "自然光、克制的商业电影感",
  soundtrack: "轻节奏、现代感纯音乐",
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

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 模拟兼容 OpenAI 的 SSE 响应；reason 是思考模型的首包，content 可能晚很多才到。 */
function sseResponse(options: {
  content: string;
  model?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  reason?: string;
  firstDelayMs?: number;
  contentDelayMs?: number;
}): Response {
  const { content, model = "test-model", usage, reason, firstDelayMs = 0, contentDelayMs = 0 } = options;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      if (firstDelayMs) await delay(firstDelayMs);
      if (reason) emit({ model, choices: [{ delta: { reasoning_content: reason } }] });
      if (contentDelayMs) await delay(contentDelayMs);
      emit({ model, choices: [{ delta: { content } }] });
      if (usage) emit({ model, usage, choices: [] });
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

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
    scene: "online-ecommerce", sceneSource: "user-selected", variantMatched: null,
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
      return sseResponse({ content: JSON.stringify(validPlan), model: "test-model" });
    },
  });
  const plan = await planner.createPlan(requestBody as Parameters<typeof planner.createPlan>[0]);
  assert.equal(plan.title, validPlan.title);
  assert.equal((capturedHeaders as Record<string, string>).authorization, "Bearer server-secret");
  assert.equal(capturedBody?.model, "test-model");
  assert.equal(capturedBody?.max_tokens, 1_200);
  assert.equal(capturedBody?.thinking_budget, 512);
  assert.equal(capturedBody?.stream, true);
  assert.deepEqual(capturedBody?.stream_options, { include_usage: true });
});

test("OpenAI-compatible planner throws instead of silent heuristic fallback after invalid provider responses", async () => {
  const planner = createOpenAICompatiblePlanner({
    baseUrl: "https://provider.example/v1",
    apiKey: "server-secret",
    model: "test-model",
    fetchImpl: async () => sseResponse({ content: "not-json" }),
  });
  // 所有模型失败后不再用模板拼装冒充 AI 方案；如实抛错让上层标记失败并退还积分。
  await assert.rejects(
    () => planner.createPlan(requestBody as Parameters<typeof planner.createPlan>[0]),
    /DIRECTOR_ALL_MODELS_FAILED/,
  );
});

test("OpenAI-compatible director normalizes numeric voice_id instead of failing schema validation", async () => {
  // 生产赛马实测：DeepSeek 稳定把 voice_id 输出成 JSON number（403010），旧校验直接报
  // "expected string, received number" 让该模型尝试失败，最终整条降级成模板片。
  const planWithNumericVoice = { ...validPlan, voice_id: 403010 };
  const planner = createOpenAICompatiblePlanner({
    baseUrl: "https://provider.example/v1",
    apiKey: "server-secret",
    model: "primary-model",
    fetchImpl: async () => sseResponse({ content: JSON.stringify(planWithNumericVoice) }),
  });
  const plan = await planner.createPlan(requestBody as Parameters<typeof planner.createPlan>[0]);
  assert.equal(plan.voice_id, "403010", "数字 VoiceType 应归一化为字符串并保留健康候选校验");
  const telemetry = (plan as typeof plan & { _providerTelemetry?: Record<string, unknown> })._providerTelemetry;
  assert.equal(telemetry?.fallbackUsed, false, "数字 voice_id 不应再触发模型降级");
});

test("OpenAI-compatible director substitutes an unavailable voice instead of failing the plan", async () => {
  // 执行层无条件执行（2026-11-20 用户定案）：LLM 选了不健康/不存在的音色时静默替换为健康候选，
  // 不中断出片（V2 原则"非法值静默回退，绝不中断出片"）；替换事实记录在遥测 voiceSubstituted。
  const planner = createOpenAICompatiblePlanner({
    baseUrl: "https://provider.example/v1",
    apiKey: "server-secret",
    model: "primary-model",
    fetchImpl: async () => sseResponse({ content: JSON.stringify({ ...validPlan, voice_id: "9999999" }) }),
  });
  const plan = await planner.createPlan(requestBody as Parameters<typeof planner.createPlan>[0]);
  assert.notEqual(plan.voice_id, "9999999", "不可用音色应被静默替换");
  assert.ok(/^\d{4,9}$/.test(String(plan.voice_id)), "替换结果必须是合法腾讯 VoiceType");
  const telemetry = (plan as typeof plan & { _providerTelemetry?: Record<string, unknown> })._providerTelemetry;
  assert.equal(telemetry?.voiceSubstituted, true, "遥测应如实记录发生了音色替换");
});

test("OpenAI-compatible director parses JSON containing raw control characters in string values", async () => {
  // 生产赛马实测：GLM 偶发在字符串值里吐未转义的裸换行，JSON.parse 报
  // "Bad control character in string literal"，两模型都失败后旧版回退模板片（mock）。
  const rawJson = JSON.stringify({ ...validPlan, narration: "第一段台词\n第二段台词" })
    .replace("第一段台词\\n第二段台词", "第一段台词\n第二段台词");
  assert.ok(rawJson.includes("\n"), "测试输入必须真的包含裸控制字符");
  const planner = createOpenAICompatiblePlanner({
    baseUrl: "https://provider.example/v1",
    apiKey: "server-secret",
    model: "primary-model",
    fetchImpl: async () => sseResponse({ content: rawJson }),
  });
  const plan = await planner.createPlan(requestBody as Parameters<typeof planner.createPlan>[0]);
  assert.equal(plan.narration, "第一段台词\n第二段台词");
  const telemetry = (plan as typeof plan & { _providerTelemetry?: Record<string, unknown> })._providerTelemetry;
  assert.equal(telemetry?.fallbackUsed, false, "带裸控制字符的合法方案不应触发模型降级");
});

test("OpenAI-compatible director retries the same model once before moving to the fallback model", async () => {
  // 赛马"每一条都出片"的关键保险：LLM 输出有随机性，偶发脏 JSON/网络抖动重试一次即可成功；
  // 重试仍失败才切换备选模型，全部失败仍如实抛错退分（不静默兜底）。
  let callCount = 0;
  const planner = createOpenAICompatiblePlanner({
    baseUrl: "https://provider.example/v1",
    apiKey: "server-secret",
    model: "primary-model",
    maxAttemptsPerModel: 2,
    fetchImpl: async () => {
      callCount += 1;
      if (callCount === 1) return sseResponse({ content: "not-json" });
      return sseResponse({ content: JSON.stringify(validPlan) });
    },
  });
  const plan = await planner.createPlan(requestBody as Parameters<typeof planner.createPlan>[0]);
  assert.equal(callCount, 2, "首个模型失败后应原地重试一次而不是立即切换备选");
  assert.equal(plan.title, validPlan.title);
  const telemetry = (plan as typeof plan & { _providerTelemetry?: Record<string, unknown> })._providerTelemetry;
  const attempts = telemetry?.modelAttempts as Array<{ ok: boolean; error?: string }>;
  assert.equal(attempts.length, 2, "遥测应记录失败与成功两次尝试");
  assert.equal(attempts[0]?.ok, false);
  assert.equal(attempts[1]?.ok, true);
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
    thinkingBudget: 512,
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; thinking_budget?: number };
      attempted.push(body.model);
      if (body.model !== "tertiary-model") {
        return new Response("provider unavailable", { status: 503 });
      }
      // 备选模型不接收 thinking_budget（DeepSeek 收到会返回残缺 JSON）。
      assert.equal(body.thinking_budget, undefined);
      return sseResponse({
        content: JSON.stringify(validPlan), model: "tertiary-model",
        usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
      });
    },
  });

  const plan = await planner.createPlan(requestBody as Parameters<typeof planner.createPlan>[0]);
  const telemetry = (plan as typeof plan & { _providerTelemetry?: Record<string, unknown> })._providerTelemetry;
  assert.equal(plan.title, validPlan.title);
  // 每个模型严格单次调用（杜绝反复重试与 Token 浪费），失败后依次切换下一个备选模型。
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
      return sseResponse({ content: JSON.stringify(validPlan), model: "fallback-model" });
    },
  });

  const plan = await planner.createPlan(requestBody as Parameters<typeof planner.createPlan>[0]);
  const telemetry = (plan as typeof plan & { _providerTelemetry?: Record<string, unknown> })._providerTelemetry;
  assert.equal(plan.title, validPlan.title);
  // 主模型首包超时后不重复重试，直接切换备选模型。
  assert.deepEqual(attempted, ["primary-model", "fallback-model"]);
  assert.equal(telemetry?.providerMode, "fallback");
  assert.equal(telemetry?.selectedModel, "fallback-model");
});

test("first packet inside the timeout keeps the primary model even when the full stream finishes later", async () => {
  const attempted: string[] = [];
  const planner = createOpenAICompatiblePlanner({
    baseUrl: "https://provider.example/v1",
    apiKey: "server-secret",
    model: "primary-model",
    fallbackModels: ["fallback-model"],
    timeoutMs: 40,
    streamTimeoutMs: 1_000,
    thinkingBudget: 512,
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; thinking_budget?: number };
      attempted.push(body.model);
      if (body.model === "primary-model") {
        assert.equal(body.thinking_budget, 512);
        return sseResponse({
          content: JSON.stringify(validPlan), model: "primary-model", reason: "thinking",
          firstDelayMs: 5, contentDelayMs: 80,
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      }
      return sseResponse({ content: JSON.stringify(validPlan), model: "fallback-model" });
    },
  });

  const plan = await planner.createPlan(requestBody as Parameters<typeof planner.createPlan>[0]);
  const telemetry = (plan as typeof plan & { _providerTelemetry?: Record<string, unknown> })._providerTelemetry;
  assert.deepEqual(attempted, ["primary-model"], "首包已到达就不得再降级到备选模型");
  assert.equal(telemetry?.providerMode, "primary");
  assert.equal(telemetry?.fallbackUsed, false);
  assert.equal(telemetry?.totalTokens, 30);
});

test("director provider hard timeout throws when fetch ignores abort", async () => {
  const planner = createOpenAICompatiblePlanner({
    baseUrl: "https://provider.example/v1",
    apiKey: "server-secret",
    model: "stalled-model",
    timeoutMs: 10,
    fetchImpl: async () => new Promise<Response>(() => undefined),
  });
  await assert.rejects(
    () => planner.createPlan(requestBody as Parameters<typeof planner.createPlan>[0]),
    /DIRECTOR_ALL_MODELS_FAILED.*timed out after 10ms/,
  );
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
  // 必须包含电商带货变体规则
  assert.match(systemPrompt, /变体类型/);
  assert.match(systemPrompt, /变体选择逻辑/);
  // 必须包含发布四件套规范
  assert.match(systemPrompt, /发布方案规则/);
  assert.match(systemPrompt, /caption/);
  assert.match(systemPrompt, /cover_title/);

  const userPrompt = buildDirectorUserPrompt(input);
  assert.doesNotMatch(userPrompt, /\bfps\b|frame.?rate|帧率/i, "用户提示词不得传入帧率参数");
  const parsedUser = JSON.parse(userPrompt) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsedUser).sort(), ["assetCount", "creationGoal", "promptInstructions"]);
  assert.equal(parsedUser.assetCount, 2);
  assert.doesNotMatch(userPrompt, /sweater1\.jpg|sweater2\.jpg|mediaFacts|"mode"|"aspectRatio"|"kind"|"size"/);
});

test("director user prompt never exposes asset filenames or media metadata", () => {
  const prompt = buildDirectorUserPrompt({
    mode: "image-film",
    prompt: "简小兮毛绒玩具，好柔软。出4条视频",
    aspectRatio: "9:16",
    assets: [
      { name: "01_hotpot_base_craft.jpg", kind: "image", size: 100 },
      { name: "02_hotpot_sneeze_twist.jpg", kind: "image", size: 200 },
      { name: "简小兮_下班悠闲盖碗茶_首帧_20261114_194201.jpg", kind: "image", size: 300 },
    ],
  });

  assert.doesNotMatch(prompt, /盖碗茶|hotpot|\.jpg/);
  assert.doesNotMatch(prompt, /mediaFacts|sizeBytes|assetType|"kind"|"mode"|"aspectRatio"/);
  assert.equal((JSON.parse(prompt) as { assetCount: number }).assetCount, 3);
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
  // 必须包含同城到店和实体门店人设
  assert.match(systemPrompt, /同城探店人设/);
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
      return sseResponse({ content: JSON.stringify(validPlan) });
    },
  });

  const plan = await planner.createPlan(requestBody as Parameters<typeof planner.createPlan>[0]);
  assert.equal(plan.title, validPlan.title);
  assert.ok(capturedBody?.messages && capturedBody.messages.length === 2);
  const systemMsg = capturedBody!.messages![0]!.content;
  const userMsg = capturedBody!.messages![1]!.content;
  // 验证注入的不是简陋的20行写死代码，而是包含了完整的 2025-2026 拼装体系
  assert.match(systemMsg, /黄金 3 秒法则/);
  assert.match(systemMsg, /带货主播人设|同城探店人设/);
  assert.match(userMsg, /creationGoal/);
  assert.match(userMsg, /"assetCount": 1/);
  assert.doesNotMatch(userMsg, /product\.jpg|mediaFacts|"kind"|"size"|"mode"|"aspectRatio"/);
});




test("explicit composer scene marker is idempotent and overrides a stale marker", () => {
  assert.equal(
    withCreationSceneMarker("拍一支口播", "personal-creation"),
    "[User-selected creation scene: personal-creation.]\n拍一支口播",
  );
  assert.equal(
    withCreationSceneMarker("[User-selected creation scene: online-ecommerce.]\n拍一支口播", "personal-creation"),
    "[User-selected creation scene: personal-creation.]\n拍一支口播",
  );
  assert.equal(withCreationSceneMarker("按 5 秒切片", "quick-cut"), "按 5 秒切片");
});

test("personal creation fallback is isolated and ordinary commercial routes leave variant choice to the persona director", async () => {
  const base = { mode: "image-film" as const, aspectRatio: "9:16" as const, assets: [{ name: "asset.jpg", kind: "image" as const, size: 1024 }] };
  const sellPrompt = "[User-selected creation scene: online-ecommerce.]\nCreate a product video";
  const personalPrompt = "[User-selected creation scene: personal-creation.]\nCreate a personal knowledge video";
  const route = resolveDirectorRoute({ ...base, prompt: sellPrompt });
  assert.equal(route.decidedVariant, null);
  const plan = await createHeuristicDirectorPlanner().createPlan({ ...base, prompt: personalPrompt });
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
  assert.doesNotMatch(local, /ecommerce variants/);
  assert.match(local, /8 local variants/);
  assert.doesNotMatch(online, /宝藏发现型/);
  assert.match(personal, /Personal creator path/);
  assert.doesNotMatch(personal, /变体类型|带货人设|探店人设/);
  assert.match(online, /Constitution Director owns global rules/);
  assert.doesNotMatch(online, /layout_id/);
});
