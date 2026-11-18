import { z } from "zod";
import { randomInt } from "node:crypto";
import type { CreationMode } from "@jansee/contracts";
// @ts-expect-error anchor-kit has no bundled type declarations
import { rankAnchors, HOST_LIBRARY, LOCAL_ROLES, LOCAL_ROLE_COMPAT, compatAnchors } from "@jansee/anchor-kit";
import { TENCENT_VOICE_CANDIDATES, detectUserVoiceIntent, getAvailableTencentVoiceCandidates, isTencentVoiceAvailable, mapVoiceFor } from "@jansee/tts-kit";
// @ts-expect-error prompts/index.js is plain JS module
import { decideVariantLocal, SELL_VARIANT_TYPES, LOCAL_VARIANT_TYPES } from "../prompts/index.js";
import { buildDirectorSystemPrompt, buildDirectorUserPrompt, resolveDirectorRoute, type DirectorRouteResolution } from "./prompt-assembly.js";

export const AssetInputSchema = z.object({
  name: z.string().trim().min(1).max(180),
  kind: z.enum(["image", "video"]),
  size: z.number().int().positive().max(200 * 1024 * 1024),
}).strict();
export type AssetInput = z.infer<typeof AssetInputSchema>;

export const DirectorPlanRequestSchema = z.object({
  mode: z.enum(["image-film", "video-dub", "storyboard"]),
  prompt: z.string().trim().min(1).max(2_000),
  aspectRatio: z.enum(["9:16", "16:9", "1:1", "4:3"]).default("9:16"),
  assetIds: z.array(z.string().uuid()).min(1).max(9)
    .refine((ids) => new Set(ids).size === ids.length, "素材不能重复")
    .optional(),
  assets: z.array(AssetInputSchema).min(1).max(9).optional(),
}).strict().superRefine((value, context) => {
  if (!value.assetIds && !value.assets) {
    context.addIssue({ code: "custom", message: "必须提供 assetIds 或 assets 素材信息" });
    return;
  }
  const count = value.assetIds ? value.assetIds.length : value.assets!.length;
  if (value.mode === "video-dub" && count !== 1) {
    context.addIssue({ code: "custom", path: [value.assetIds ? "assetIds" : "assets"], message: "视频配音只接受一个视频" });
  }
  if (value.mode === "storyboard" && count < 2) {
    context.addIssue({ code: "custom", path: [value.assetIds ? "assetIds" : "assets"], message: "分镜成片至少需要两个视频" });
  }
  if (value.assets) {
    const kinds = new Set(value.assets.map((asset) => asset.kind));
    if (kinds.size !== 1) context.addIssue({ code: "custom", path: ["assets"], message: "一次创作只能使用同一类素材" });
    if (value.mode === "image-film" && value.assets.some((asset) => asset.kind !== "image")) {
      context.addIssue({ code: "custom", path: ["assets"], message: "图片成片只接受图片素材" });
    }
    if (value.mode !== "image-film" && value.assets.some((asset) => asset.kind !== "video")) {
      context.addIssue({ code: "custom", path: ["assets"], message: "视频创作只接受视频素材" });
    }
  }
});

export type DirectorPlanRequest = z.infer<typeof DirectorPlanRequestSchema>;

export interface DirectorPlanResolvedInput {
  mode: CreationMode;
  prompt: string;
  aspectRatio: "9:16" | "16:9" | "1:1" | "4:3";
  assets: Array<{
    name: string;
    kind: "image" | "video";
    size: number;
  }>;
  /** 批量赛马：服务端排定的变体类型，锁定本次规划风格（批内逐版不同）。 */
  variantOverride?: string;
}

export const DirectorPlanSchema = z.object({
  operation: z.enum(["standard", "video-slice", "keep-original"]).default("standard"),
  sliceSeconds: z.number().int().min(5).max(120).default(20),
  title: z.string().trim().min(2).max(60),
  concept: z.string().trim().min(10).max(500),
  durationSeconds: z.number().int().min(6).max(60),
  narration: z.string().trim().min(2).max(1200).optional(),
  note: z.string().trim().min(2).max(24).optional(),
  scenes: z.array(z.object({
    order: z.number().int().positive(),
    description: z.string().trim().min(2).max(180),
    durationSeconds: z.number().int().min(1).max(30),
  }).strict()).min(2).max(12),
  style: z.string().trim().min(2).max(100),
  soundtrack: z.string().trim().min(2).max(100),
  anchor: z.string().trim().min(1).max(50),
  voice_id: z.string().trim().regex(/^\d{4,9}$/, "voice_id 必须由导演明确选择腾讯云真实 VoiceType 数字 ID"),
  speech_speed: z.number().min(0.85).max(1.25),
  bgm_emotion: z.string().trim().min(1).max(50).default("warm"),
  publish: z.object({
    caption: z.string().max(1000).optional(),
    cover_title: z.string().max(100).optional(),
    pinned_comment: z.string().max(300).optional(),
    post_time: z.string().max(100).optional(),
  }).optional(),
  packaging: z.object({
    intro: z.boolean().default(true),
    ending: z.boolean().default(true),
    subtitles: z.boolean().default(true),
    bgm: z.boolean().default(true),
  }).default({ intro: true, ending: true, subtitles: true, bgm: true }),
  variant_type: z.string().trim().max(50).optional(),
}).strict();
export type DirectorPlan = z.infer<typeof DirectorPlanSchema>;

export interface DirectorModelAttempt {
  model: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface DirectorProviderTelemetry {
  providerMode: "primary" | "fallback" | "heuristic" | "deterministic";
  requestedModel: string;
  selectedModel: string | null;
  modelsAttempted: string[];
  modelAttempts: DirectorModelAttempt[];
  fallbackUsed: boolean;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageAvailable: boolean;
  costUsageAvailable: boolean;
  scene: "online-ecommerce" | "physical-store" | "personal-creation";
  sceneSource: "user-selected" | "keyword-inferred";
  lockedVariant: string | null;
  anchorHit: boolean;
  variantMatched: boolean | null;
  failureReason?: string;
  voiceId?: string;
  voiceType?: number;
  voiceCandidateIds?: number[];
}

export interface DirectorPlanner {
  createPlan(input: DirectorPlanResolvedInput): Promise<DirectorPlan>;
}

const SLICE_INTENT_TERMS = [
  String.fromCharCode(0x5207, 0x7247), // 切片
  String.fromCharCode(0x62c6, 0x6761), // 拆条
  String.fromCharCode(0x5206, 0x6bb5), // 分段
  String.fromCharCode(0x62c6, 0x5206), // 拆分
  String.fromCharCode(0x5206, 0x5272), // 分割
  String.fromCharCode(0x5207, 0x6bb5), // 切段
];
const KEEP_ORIGINAL_TERMS = [
  String.fromCharCode(0x4fdd, 0x7559, 0x539f, 0x58f0),
  String.fromCharCode(0x539f, 0x58f0, 0x4fdd, 0x7559),
  String.fromCharCode(0x4e0d, 0x8981, 0x914d, 0x97f3),
  String.fromCharCode(0x4e0d, 0x52a0, 0x914d, 0x97f3),
  String.fromCharCode(0x4e0d, 0x9700, 0x8981, 0x914d, 0x97f3),
  String.fromCharCode(0x539f, 0x58f0, 0x76f4, 0x51fa),
  String.fromCharCode(0x539f, 0x7247, 0x76f4, 0x51fa),
];
function isVideoSliceRequest(prompt: string): boolean {
  if (explicitlyDisabled(prompt, "切片|拆条|分段|拆分|分割|切段|切成|分成|拆成|剪成|拆为|分为|多段|多条|多个视频|多个片段")) return false;
  if (SLICE_INTENT_TERMS.some((term) => prompt.includes(term))) return true;
  const splitVerb = /切成|切出|分成|拆成|剪成|拆为|分为|每隔.{0,10}(?:切|截|分)|每\s*[0-9一二两三四五六七八九十]+\s*秒.{0,8}(?:输出|生成|剪|切|截)/.test(prompt);
  const multipleOutputs = /多段|多条|多个(?:视频|片段|短视频)|几段|几条|[0-9一二两三四五六七八九十]+\s*(?:个)?(?:段|条|短视频|视频)|每段|每条/.test(prompt);
  const interval = /(?:[0-9]{1,3}|[一二两三四五六七八九十百]+)\s*秒/.test(prompt);
  const perSegmentInterval = /每段\s*(?:[0-9]{1,3}|[一二两三四五六七八九十百]+)\s*秒/.test(prompt);
  const perSegmentDuration = /每段\s*(?:(?:[0-9]{1,3}|[一二两三四五六七八九十百]+)\s*秒|(?:[0-9]{1,2}|[一二两三四五六七八九十百]+|半)\s*分钟)/.test(prompt);
  return perSegmentDuration || perSegmentInterval || (splitVerb && (multipleOutputs || interval));
}
function isKeepOriginalRequest(prompt: string): boolean {
  return KEEP_ORIGINAL_TERMS.some((term) => prompt.includes(term));
}
function parseChineseNumber(value: string): number {
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  let current = 0;
  for (const char of value) {
    if (char === "百") { total += (current || 1) * 100; current = 0; }
    else if (char === "十") { total += (current || 1) * 10; current = 0; }
    else current = digits[char] ?? 0;
  }
  return total + current;
}

function parseSliceSeconds(prompt: string): number {
  const secondMatch = /([0-9]{1,3}|[一二两三四五六七八九十百]+)\s*秒/.exec(prompt);
  const minuteMatch = /([0-9]{1,2}|[一二两三四五六七八九十百]+|半)\s*分钟/.exec(prompt);
  let seconds = 20;
  if (secondMatch) seconds = /^[0-9]+$/.test(secondMatch[1]!) ? Number(secondMatch[1]) : parseChineseNumber(secondMatch[1]!);
  else if (minuteMatch) {
    const minutes = minuteMatch[1] === "半" ? 0.5 : /^[0-9]+$/.test(minuteMatch[1]!) ? Number(minuteMatch[1]) : parseChineseNumber(minuteMatch[1]!);
    seconds = minutes * 60;
  }
  return Math.max(5, Math.min(120, Math.round(seconds)));
}

/** 切片与保留原声是确定性剪辑决策，由本地规则直接产出方案，不消耗 LLM 调用（对齐 V2：切片口播不进大模型）。 */
export function resolveDeterministicOperation(mode: DirectorPlanResolvedInput["mode"], prompt: string): "video-slice" | "keep-original" | null {
  if (mode !== "image-film" && isVideoSliceRequest(prompt)) return "video-slice";
  if (mode === "video-dub" && isKeepOriginalRequest(prompt)) return "keep-original";
  return null;
}

const CANDIDATE_EMOTIONS = [
  "warm",
  "relaxed",
  "fresh",
  "cozy",
  "playful",
  "energetic",
  "calm_narrative",
  "inspirational",
  "tech_future",
  "luxury",
];

function explicitlyDisabled(prompt: string, terms: string): boolean {
  const stop = "(?:不要|不需要|不加|取消|去掉|关闭|省略|无需)";
  // 不跨逗号、句号等语义边界，避免“保留结尾，不需要字幕”误判成不要结尾。
  const bridge = "[^，。；！？,;.!?]{0,6}";
  return new RegExp(`(?:${stop})${bridge}(?:${terms})|(?:${terms})${bridge}(?:${stop})`, "i").test(prompt);
}

/** 校验时使用导演最终选定变体对应的兼容主播/角色集合；个人创作强制 anchor=none。 */
function anchorPoolForRoute(route: DirectorRouteResolution, taskId: string): string[] {
  if (route.isPersonal) return [];
  if (route.scene === "local") {
    return ((LOCAL_ROLES as Array<{ id: string }> | undefined) ?? []).map((role) => role.id);
  }
  const ranked = rankAnchors({ variantType: route.decidedVariant || "A-痛点直击型", taskId }) || HOST_LIBRARY || [];
  return ranked.slice(0, 8).map((h: { id: string }) => h.id);
}

/** 校验导演方案的变体与主播/实体角色兼容关系，并遵守批量赛马锁定项。 */
function resolveDirectorHits(input: DirectorPlanResolvedInput, plan: DirectorPlan, route: DirectorRouteResolution): { anchorHit: boolean; variantMatched: boolean | null } {
  if (route.isPersonal) return { anchorHit: plan.anchor === "none" && !plan.variant_type, variantMatched: null };
  const variants = route.scene === "local" ? LOCAL_VARIANT_TYPES : SELL_VARIANT_TYPES;
  const compatible = route.scene === "local"
    ? ((LOCAL_ROLE_COMPAT as Record<string, string[]>)[plan.variant_type ?? ""] ?? [])
    : compatAnchors(plan.variant_type);
  const anchorHit = variants.includes(plan.variant_type ?? "") && compatible.includes(plan.anchor);
  const variantMatched = route.decidedVariant ? plan.variant_type === route.decidedVariant : null;
  return { anchorHit: anchorHit && (!route.decidedVariant || plan.variant_type === route.decidedVariant), variantMatched };
}

function normalizePlanForRoute(parsed: Record<string, unknown>, route: DirectorRouteResolution): void {
  if (route.isPersonal) { parsed.anchor = "none"; delete parsed.variant_type; return; }
  const variants = route.scene === "local" ? LOCAL_VARIANT_TYPES : SELL_VARIANT_TYPES;
  const variant = typeof parsed.variant_type === "string" ? parsed.variant_type : "";
  if (!variants.includes(variant)) throw new Error("DIRECTOR_VARIANT_INVALID: 导演未选择当前场景允许的人设变体");
  const compatible = route.scene === "local"
    ? ((LOCAL_ROLE_COMPAT as Record<string, string[]>)[variant] ?? [])
    : compatAnchors(variant);
  if (typeof parsed.anchor !== "string" || !compatible.includes(parsed.anchor)) throw new Error("DIRECTOR_ANCHOR_MISMATCH: 主播/实体角色与导演选择的变体不兼容");
}

export function isDirectorPlanCompatible(input: DirectorPlanResolvedInput, plan: DirectorPlan): boolean {
  const route = resolveDirectorRoute(input);
  const hits = resolveDirectorHits(input, plan, route);
  return hits.anchorHit && (!route.decidedVariant || plan.variant_type === route.decidedVariant);
}

function routeTelemetry(route: DirectorRouteResolution, hits: { anchorHit: boolean; variantMatched: boolean | null }): Pick<DirectorProviderTelemetry, "scene" | "sceneSource" | "lockedVariant" | "anchorHit" | "variantMatched"> {
  return {
    scene: route.creationScene,
    sceneSource: route.sceneSource,
    lockedVariant: route.decidedVariant,
    anchorHit: hits.anchorHit,
    variantMatched: hits.variantMatched,
  };
}

export function createHeuristicDirectorPlanner(): DirectorPlanner {
  return {
    async createPlan(input: DirectorPlanResolvedInput): Promise<DirectorPlan> {
      const mode = input.mode;
      const text = input.prompt;
      const route = resolveDirectorRoute(input);
      const variantType = route.isPersonal ? undefined : input.variantOverride
        || decideVariantLocal(text, route.scene)
        || (route.scene === "local" ? LOCAL_VARIANT_TYPES[0] : SELL_VARIANT_TYPES[0]);
      const localRoleIds = variantType && route.scene === "local" ? ((LOCAL_ROLE_COMPAT as Record<string, string[]>)[variantType] ?? []) : [];
      const topAnchor = route.isPersonal
        ? { id: "none", name: "个人创作", temperaments: ["m-warm"] }
        : route.scene === "local"
          ? ((LOCAL_ROLES as Array<{id:string;name?:string;temperaments?:string[]}>).find((role) => localRoleIds.includes(role.id)) ?? null)
          : ((rankAnchors({ variantType: variantType!, taskId: text }) || HOST_LIBRARY || [])[0] ?? null);
      if (!topAnchor) throw new Error("DIRECTOR_ANCHOR_UNAVAILABLE: 当前变体没有可用兼容主播/实体角色");
      const voiceIntent = detectUserVoiceIntent(text) || {};
      const voiceLanguage = voiceIntent.isCantonese ? "yue" : voiceIntent.isEnglish ? "en" : "zh";
      const preferredTemperament = voiceIntent.explicitTemperament || topAnchor.temperaments?.find((key: string) => ["m-calm", "m-deep", "m-warm", "m-sunny", "f-warm", "f-soft", "f-passion", "f-bright"].includes(key)) || (route.creationScene === "physical-store" ? "f-soft" : route.creationScene === "online-ecommerce" ? "f-bright" : "f-warm");
      const voiceCandidates = getAvailableTencentVoiceCandidates({ language: voiceLanguage, gender: voiceIntent.explicitGender || null, limit: 8, preferredTemperament });
      let voiceId: string;
      if (!voiceCandidates.length) throw new Error(`TTS_VOICE_UNAVAILABLE: 当前没有通过健康探测且符合${voiceLanguage === "yue" ? "粤语" : voiceLanguage === "en" ? "英语" : "普通话"}语言/性别要求的腾讯音色`);
      // 规则兜底同样只能从本次健康候选集中选，不能使用目录默认值或未经探测的 ID。
      voiceId = String(voiceCandidates[randomInt(voiceCandidates.length)]!.voiceType);

      let bgmEmotion = "warm";
      if (/科技|未来|数码|AI|智能/.test(text)) bgmEmotion = "tech_future";
      else if (/快节奏|热血|运动|狂欢|冲刺|爆款/.test(text)) bgmEmotion = "energetic";
      else if (/治愈|温馨|家庭|宝宝|宠物/.test(text)) bgmEmotion = "cozy";
      else if (/轻松|惬意|下午茶|咖啡|日常/.test(text)) bgmEmotion = "relaxed";
      else if (/高档|奢华|高级|品质|黄金/.test(text)) bgmEmotion = "luxury";

      const assetCount = Math.max(2, Math.min(input.assets.length || 3, 6));
      const sceneDuration = Math.max(2, Math.floor(15 / assetCount));
      const scenes = Array.from({ length: assetCount }, (_, i) => ({
        order: i + 1,
        // 只有素材元数据和上传顺序可用；不把文件名推断成画面事实。
        description: `按上传顺序呈现第 ${i + 1} 份素材；画面内容未进行视觉识别。`,
        durationSeconds: sceneDuration,
      }));

      const totalDuration = scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
      const sliceSeconds = parseSliceSeconds(text);
      const deterministicOperation = resolveDeterministicOperation(mode, text);

      return {
        operation: deterministicOperation ?? "standard",
        sliceSeconds,
        title: `${input.prompt.slice(0, 15)} 商业成片方案`,
        concept: route.isPersonal ? "基于简兮宪法导演规则，围绕创作者个人表达与素材节奏组织成片。" : `基于简兮成熟 AI 导演引擎，选用【${topAnchor.name}】风格叙事，结合两段式人声避让与叠画转场。`,
        durationSeconds: Math.max(6, Math.min(60, totalDuration)),
        // 规则兜底不把用户的制作目标原样朗读，也不补充未经核实的产品事实。
        narration: "让每一处细节都被认真呈现，让内容表达更清晰、更有吸引力。",
        note: bgmEmotion === "tech_future" ? "科技质感 · 逐帧呈现"
          : bgmEmotion === "energetic" ? "活力节奏 · 每一秒都好看"
          : bgmEmotion === "cozy" ? "温馨画面 · 慢慢看"
          : bgmEmotion === "luxury" ? "高级质感 · 静待亲临"
          : bgmEmotion === "relaxed" ? "轻松日常 · 慢慢逛"
          : "治愈画面 · 慢慢看",
        scenes,
        style: `简兮商业视觉流（叠化0.7s转场，人声音量0.10/0.22避让）`,
        soundtrack: route.isPersonal ? `情绪曲目 [${bgmEmotion}] 匹配个人表达风格` : `情绪曲目 [${bgmEmotion}] 匹配 ${topAnchor.name} 风格`,
        anchor: route.isPersonal ? "none" : topAnchor.id,
        voice_id: voiceId,
        speech_speed: 1.0,
        bgm_emotion: bgmEmotion,
        packaging: {
          intro: !explicitlyDisabled(text, "开场|片头"),
          ending: !explicitlyDisabled(text, "结尾|片尾"),
          subtitles: !explicitlyDisabled(text, "字幕"),
          bgm: !explicitlyDisabled(text, "背景音乐|BGM|配乐|音乐"),
        },
        ...(variantType ? { variant_type: variantType } : {}),
      };
    },
  };
}

export function createOpenAICompatiblePlanner(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fallbackModels?: string[];
  timeoutMs?: number;
  fallbackTimeoutMs?: number;
  maxTokens?: number;
  thinkingBudget?: number;
  fetchImpl?: typeof fetch;
}): DirectorPlanner {
  const fetchImpl = config.fetchImpl ?? fetch;
  const fallbackPlanner = createHeuristicDirectorPlanner();
  const attachTelemetry = (plan: DirectorPlan, telemetry: DirectorProviderTelemetry): DirectorPlan =>
    Object.assign(plan, { _providerTelemetry: telemetry });

  return {
    async createPlan(input) {
      // 切片/保留原声是确定性剪辑决策：本地规则直接产出方案，不调用 LLM（一条成片只允许一次 LLM 调用的前置闸门）。
      const deterministicOperation = resolveDeterministicOperation(input.mode, input.prompt);
      if (deterministicOperation) {
        const route = resolveDirectorRoute(input);
        const plan = await fallbackPlanner.createPlan(input);
        return attachTelemetry(plan, {
          providerMode: "deterministic",
          requestedModel: config.model,
          selectedModel: null,
          modelsAttempted: [],
          modelAttempts: [],
          fallbackUsed: false,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          usageAvailable: false,
          costUsageAvailable: false,
          ...routeTelemetry(route, resolveDirectorHits(input, plan, route)),
        });
      }
      if (!config.apiKey || config.apiKey === "test-key" || config.apiKey.startsWith("mock-")) {
        const route = resolveDirectorRoute(input);
        const plan = await fallbackPlanner.createPlan(input);
        return attachTelemetry(plan, {
          providerMode: "heuristic", requestedModel: config.model, selectedModel: null,
          modelsAttempted: [], modelAttempts: [], fallbackUsed: true, promptTokens: 0, completionTokens: 0, totalTokens: 0, usageAvailable: false, costUsageAvailable: false,
          ...routeTelemetry(route, resolveDirectorHits(input, plan, route)),
          failureReason: "模型密钥未配置或处于模拟模式",
        });
      }

      const route = resolveDirectorRoute(input);
      const models = [...new Set([config.model, ...(config.fallbackModels ?? [])].map((model) => model.trim()).filter(Boolean))];
      const modelsAttempted: string[] = [];
      const modelAttempts: DirectorModelAttempt[] = [];
      let lastError: unknown;
      for (const model of models) {
      modelsAttempted.push(model);
      const attemptStartedAt = Date.now();
      const controller = new AbortController();
      const modelTimeoutMs = model === config.model
        ? config.timeoutMs ?? 12_000
        : config.fallbackTimeoutMs ?? config.timeoutMs ?? 12_000;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('Director provider timed out after ' + modelTimeoutMs + 'ms'));
        }, modelTimeoutMs);
      });
      try {
        const response = await Promise.race([fetchImpl(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            temperature: 0.4,
            ...(Number.isFinite(config.maxTokens) && Number(config.maxTokens) > 0
              ? { max_tokens: Math.max(128, Math.min(8192, Math.floor(Number(config.maxTokens)))) }
              : {}),
            ...(Number.isFinite(config.thinkingBudget) && Number(config.thinkingBudget) >= 128
              ? { thinking_budget: Math.max(128, Math.min(32768, Math.floor(Number(config.thinkingBudget)))) }
              : {}),
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: buildDirectorSystemPrompt(input),
              },
              {
                role: "user",
                content: buildDirectorUserPrompt(input),
              },
            ],
          }),
        }), timeoutPromise]);
        if (!response.ok) throw new Error(`Director provider returned HTTP ${response.status}`);
        const payload: unknown = await Promise.race([response.json(), timeoutPromise]);
        const responseData = payload as {
          model?: string;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const content = responseData.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new Error("Director provider returned no structured content");
        const cleanJson = content.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();
        const parsed = JSON.parse(cleanJson) as Record<string, unknown>;
        // A clear slicing request is a deterministic operation decision, even if the LLM omits it.
        if (deterministicOperation) parsed.operation = deterministicOperation;
        if (deterministicOperation === "video-slice") parsed.sliceSeconds = parseSliceSeconds(input.prompt);
        if (!parsed.packaging || typeof parsed.packaging !== "object") {
          parsed.packaging = { intro: true, ending: true, subtitles: true, bgm: true };
        }
        normalizePlanForRoute(parsed, route);
        const validatedPlan = DirectorPlanSchema.parse(parsed);
        if (!resolveDirectorHits(input, validatedPlan, route).anchorHit) throw new Error("DIRECTOR_ROUTE_MISMATCH: 导演方案不符合用户选择的场景或主播兼容关系");
        // LLM 必须从本次实际发送的健康候选集中原样选择；不允许映射层静默替换。
        const voiceIntent = detectUserVoiceIntent(input.prompt) || {};
        const voiceLanguage = voiceIntent.isCantonese ? "yue" : voiceIntent.isEnglish ? "en" : "zh";
        const preferredTemperament = voiceIntent.explicitTemperament || (route.creationScene === "physical-store" ? "f-soft" : route.creationScene === "online-ecommerce" ? "f-bright" : "f-warm");
        const allowedVoiceCandidates = getAvailableTencentVoiceCandidates({ language: voiceLanguage, gender: voiceIntent.explicitGender || null, limit: 8, preferredTemperament });
        const selectedVoiceType = Number(validatedPlan.voice_id);
        const selectedCandidate = allowedVoiceCandidates.find((candidate: { voiceType: number }) => candidate.voiceType === selectedVoiceType);
        if (!selectedCandidate || !isTencentVoiceAvailable(selectedVoiceType)) {
          throw new Error("DIRECTOR_VOICE_MISMATCH: voice_id 不在本次发给 LLM 的健康腾讯音色候选集中");
        }
        if (voiceIntent.explicitGender && selectedCandidate.gender !== voiceIntent.explicitGender) {
          throw new Error("DIRECTOR_VOICE_MISMATCH: 导演选择的腾讯音色与用户指定性别不一致");
        }
        // 仅做严格白名单解析；候选集校验已保证不会触发旧音色自动替补。
        if (mapVoiceFor("tencent", validatedPlan.voice_id) !== selectedVoiceType) {
          throw new Error("DIRECTOR_VOICE_MISMATCH: 腾讯音色解析结果与 LLM 原始 VoiceType 不一致");
        }
        const selectedModel = typeof responseData.model === "string" ? responseData.model : model;
        const promptTokens = Number(responseData.usage?.prompt_tokens ?? 0);
        const completionTokens = Number(responseData.usage?.completion_tokens ?? 0);
        const totalTokens = Number(responseData.usage?.total_tokens ?? (promptTokens + completionTokens));
        return attachTelemetry(validatedPlan, {
          providerMode: model === config.model ? "primary" : "fallback",
          requestedModel: config.model,
          selectedModel,
          modelsAttempted: [...modelsAttempted],
          modelAttempts: [...modelAttempts, { model, durationMs: Date.now() - attemptStartedAt, ok: true }],
          fallbackUsed: model !== config.model,
          promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
          completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
          totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
          usageAvailable: Boolean(responseData.usage && (responseData.usage.prompt_tokens !== undefined || responseData.usage.completion_tokens !== undefined || responseData.usage.total_tokens !== undefined)),
          costUsageAvailable: Boolean(responseData.usage && responseData.usage.prompt_tokens !== undefined && responseData.usage.completion_tokens !== undefined),
          ...routeTelemetry(route, resolveDirectorHits(input, validatedPlan, route)),
          voiceId: validatedPlan.voice_id,
          voiceType: selectedVoiceType,
          voiceCandidateIds: allowedVoiceCandidates.map((candidate: { voiceType: number }) => candidate.voiceType),
        });
      } catch (error) {
        lastError = error;
        modelAttempts.push({
          model,
          durationMs: Date.now() - attemptStartedAt,
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
        });
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      }
      const plan = await fallbackPlanner.createPlan(input);
      return attachTelemetry(plan, {
        providerMode: "heuristic",
        requestedModel: config.model,
        selectedModel: null,
        modelsAttempted: [...modelsAttempted],
        modelAttempts: [...modelAttempts],
        fallbackUsed: true,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        usageAvailable: false,
        costUsageAvailable: false,
        ...routeTelemetry(route, resolveDirectorHits(input, plan, route)),
        failureReason: lastError instanceof Error ? lastError.message.slice(0, 240) : "所有配置模型均调用失败",
      });
    },
  };
}
