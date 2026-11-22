import { z } from "zod";
import { randomInt } from "node:crypto";
import type { CreationMode } from "@jansee/contracts";
import { TENCENT_VOICE_CANDIDATES, detectUserVoiceIntent, getAvailableTencentVoiceCandidates, isTencentVoiceAvailable, mapVoiceFor } from "@jansee/tts-kit";
import { decideVariantLocal, SELL_VARIANT_TYPES, LOCAL_VARIANT_TYPES } from "./variant-rules.js";
import { buildDirectorSystemPrompt, buildDirectorUserPrompt, resolveDirectorRoute, type DirectorRouteResolution } from "./prompt-assembly.js";
import { validatePublicUrlSafety } from "./security-shield.js";

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
  creationScene: z.enum(["online-ecommerce", "physical-store", "personal-creation", "quick-cut"]).optional(),
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
    durationSec?: number;
  }>;
  /** 批量赛马兜底：worker 补跑时服务端排定的变体类型，锁定本次规划风格（批内逐版不同）。 */
  /** 批量赛马：本次规划要求一次 LLM 调用产出的方案数（>1 时走 versions 数组契约，批内差异化由 LLM 统筹）。 */
  batchVersions?: number;
}

/**
 * 导演运镜能力白名单（受控枚举）：只有这 4 种是渲染引擎支持的无损平移运镜
 * （见 modules/visual_engine_v4/imageFilm.js 的 MOTIONS / MOTION_MAP）。
 * LLM 必须为每镜从这份清单里选一个 ID，禁止返回清单外或自造的运镜词——
 * 引擎的"运镜放权"逻辑只认这些 ID，返回其他词会被忽略、退化为 seed 随机运镜。
 */
export const DIRECTOR_MOTION_IDS = ["sweep_lr", "sweep_rl", "rise_up", "diagonal"] as const;

export const DirectorPlanSchema = z.object({
  operation: z.enum(["standard", "video-slice", "keep-original"]).default("standard"),
  sliceSeconds: z.number().int().min(5).max(120).default(20),
  title: z.string().trim().min(2).max(60),
  concept: z.string().trim().min(10).max(500),
  // 时长不再由 LLM 决定：提示词不输出，执行层也完全不读。
  // 保留 optional 只是为了兼容旧缓存 / 模型惯性多吐一个字段，不让整份方案被 strict 拒绝。
  durationSeconds: z.number().int().min(1).max(300).optional(),
  narration: z.string().trim().min(2).max(1200).optional(),
  note: z.string().trim().min(2).max(24).optional(),
  scenes: z.array(z.object({
    order: z.number().int().positive(),
    description: z.string().trim().min(2).max(180),
    // 同上：每镜秒数仅兼容旧字段，渲染时长一律按该句 TTS 实测结果计算。
    durationSeconds: z.number().int().min(1).max(120).optional(),
    // 运镜编排：LLM 必须从 DIRECTOR_MOTION_IDS 中选一个；strict 会拒绝自造运镜词。
    // 缺失时给合法默认（不让单个字段遗漏毁掉整份方案）；清单外的值仍会被拒绝。
    motion: z.enum(DIRECTOR_MOTION_IDS).default("sweep_lr"),
  }).strict()).min(1).max(12),
  style: z.string().trim().min(2).max(100),
  soundtrack: z.string().trim().min(2).max(100),
  voice_id: z.string().trim().regex(/^\d{4,9}$/, "voice_id 必须由导演明确选择腾讯云真实 VoiceType 数字 ID"),
  speech_speed: z.number().min(0.85).max(1.25),
  bgm_emotion: z.string().trim().min(1).max(50).default("warm"),
  publish: z.object({
    caption: z.string().max(1000).optional(),
    cover_title: z.string().max(100).optional(),
    pinned_comment: z.string().max(300).optional(),
    post_time: z.string().max(100).optional(),
  }).optional(),
  // 片尾(compliance card)由系统固定生成，不作为 LLM 可选项：schema 不接收 ending。
  packaging: z.object({
    intro: z.boolean().default(true),
    subtitles: z.boolean().default(true),
    bgm: z.boolean().default(true),
  }).default({ intro: true, subtitles: true, bgm: true }),
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
  variantMatched: boolean | null;
  failureReason?: string;
  voiceId?: string;
  voiceType?: number;
  voiceSubstituted?: boolean;
  voiceCandidateIds?: number[];
}

export interface DirectorPlanner {
  createPlan(input: DirectorPlanResolvedInput): Promise<DirectorPlan>;
  /** 批量赛马：一次 LLM 调用产出 batchVersions 个差异化方案；batchVersions<=1 等价 createPlan。 */
  createPlans(input: DirectorPlanResolvedInput): Promise<DirectorPlan[]>;
}

const KEEP_ORIGINAL_TERMS = [
  String.fromCharCode(0x4fdd, 0x7559, 0x539f, 0x58f0), // 保留原声
  String.fromCharCode(0x539f, 0x58f0, 0x4fdd, 0x7559), // 原声保留
  String.fromCharCode(0x4e0d, 0x8981, 0x914d, 0x97f3), // 不要配音
  String.fromCharCode(0x4e0d, 0x52a0, 0x914d, 0x97f3), // 不加配音
  String.fromCharCode(0x4e0d, 0x9700, 0x8981, 0x914d, 0x97f3), // 不需要配音
  String.fromCharCode(0x539f, 0x58f0, 0x76f4, 0x51fa), // 原声直出
  String.fromCharCode(0x539f, 0x7247, 0x76f4, 0x51fa), // 原片直出
];

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

/**
 * 确定性剪辑决策：
 * 1. 只有用户在 prompt 中明确表达“保留原声”意图时，才路由到 keep-original（进而触发 ASR 和文本人声核对面板）；
 * 2. 默认三大场景（带货/门店/个人）与一句话剪辑均不拦截，完整交由 LLM 进行需求意图分析与导演规划。
 */
export function resolveDeterministicOperation(mode: DirectorPlanResolvedInput["mode"], prompt: string): "video-slice" | "keep-original" | null {
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

/** 校验导演方案的变体合法性，并遵守批量赛马锁定项（主播池已下线，不再校验 anchor）。 */
function resolveDirectorHits(input: DirectorPlanResolvedInput, plan: DirectorPlan, route: DirectorRouteResolution): { variantMatched: boolean | null } {
  if (route.isPersonal) return { variantMatched: null };
  const variantMatched = route.decidedVariant ? plan.variant_type === route.decidedVariant : null;
  return { variantMatched };
}

function findCanonicalVariant(rawVariant: unknown, allowedVariants: readonly string[]): string | null {
  if (typeof rawVariant !== "string") return null;
  const clean = rawVariant.trim();
  if (!clean) return null;
  if (allowedVariants.includes(clean)) return clean;
  const letterMatch = clean.match(/^([A-Za-z])[\s\-._、:：]?/);
  if (letterMatch) {
    const letter = letterMatch[1]!.toUpperCase();
    const candidate = allowedVariants.find((v) => v.startsWith(`${letter}-`));
    if (candidate) return candidate;
  }
  const stripped = clean.replace(/^[A-Za-z][\s\-._、:：]?/, "").trim();
  if (stripped) {
    const candidate = allowedVariants.find((v) => {
      const vDesc = v.replace(/^[A-Za-z]-/, "");
      return vDesc.includes(stripped) || stripped.includes(vDesc) || stripped.replace(/型$/, "") === vDesc.replace(/型$/, "");
    });
    if (candidate) return candidate;
  }
  return null;
}

function normalizePlanForRoute(parsed: Record<string, unknown>, route: DirectorRouteResolution): void {
  if (route.isPersonal) { delete parsed.anchor; delete parsed.variant_type; return; }
  // 风格与变体完全交给 LLM；仅移除历史兼容字段，避免旧规则限制创作。
  delete parsed.variant_type;
  // 主播池已下线：剥离 LLM 原始输出里可能残留的 anchor 字段，不进入校验。
  delete parsed.anchor;
}

export function isDirectorPlanCompatible(input: DirectorPlanResolvedInput, plan: DirectorPlan): boolean {
  const route = resolveDirectorRoute(input);
  const hits = resolveDirectorHits(input, plan, route);
  return true;
}

function routeTelemetry(route: DirectorRouteResolution, hits: { variantMatched: boolean | null }): Pick<DirectorProviderTelemetry, "scene" | "sceneSource" | "lockedVariant" | "variantMatched"> {
  return {
    scene: route.creationScene,
    sceneSource: route.sceneSource,
    lockedVariant: route.decidedVariant,
    variantMatched: hits.variantMatched,
  };
}

export function createHeuristicDirectorPlanner(): DirectorPlanner {
  return {
    async createPlan(input: DirectorPlanResolvedInput): Promise<DirectorPlan> {
      const mode = input.mode;
      const text = input.prompt;
      const route = resolveDirectorRoute(input);
      const variantType = route.isPersonal ? undefined : decideVariantLocal(text, route.creationScene === "physical-store" ? "local" : "sell");
      const voiceIntent = detectUserVoiceIntent(text) || {};
      const voiceLanguage = voiceIntent.isCantonese ? "yue" : voiceIntent.isEnglish ? "en" : "zh";
      const preferredTemperament = voiceIntent.explicitTemperament || (route.creationScene === "physical-store" ? "f-soft" : route.creationScene === "online-ecommerce" ? "f-bright" : "f-warm");
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
      const scenes = Array.from({ length: assetCount }, (_, i) => ({
        order: i + 1,
        // 只有素材元数据和上传顺序可用；不把文件名推断成画面事实。
        description: `按上传顺序呈现第 ${i + 1} 份素材；画面内容未进行视觉识别。`,
        // 规则兜底也给出合法运镜（4 种轮转），保持引擎可放权采纳。
        motion: DIRECTOR_MOTION_IDS[i % DIRECTOR_MOTION_IDS.length]!,
      }));

      const sliceSeconds = parseSliceSeconds(text);
      const deterministicOperation = resolveDeterministicOperation(mode, text);

      return {
        operation: deterministicOperation ?? "standard",
        sliceSeconds,
        title: `${input.prompt.slice(0, 15)} 商业成片方案`,
        concept: route.isPersonal ? "基于简兮宪法导演规则，围绕创作者个人表达与素材节奏组织成片。" : "基于简兮成熟 AI 导演引擎，结合变体叙事、两段式人声避让与叠画转场组织成片。",
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
        soundtrack: `情绪曲目 [${bgmEmotion}] 匹配${route.isPersonal ? "个人表达" : "内容"}风格`,
        voice_id: voiceId,
        speech_speed: 1.0,
        bgm_emotion: bgmEmotion,
        packaging: {
          intro: !explicitlyDisabled(text, "开场|片头"),
          subtitles: !explicitlyDisabled(text, "字幕"),
          bgm: !explicitlyDisabled(text, "背景音乐|BGM|配乐|音乐"),
        },
        ...(variantType ? { variant_type: variantType } : {}),
      };
    },
    async createPlans(input: DirectorPlanResolvedInput): Promise<DirectorPlan[]> {
      // 规则兜底的批量路径：逐版独立生成（音色每版随机），不涉及 LLM 调用。
      const count = Math.max(1, Math.floor(input.batchVersions ?? 1));
      const plans: DirectorPlan[] = [];
      for (let index = 0; index < count; index += 1) {
        plans.push(await this.createPlan(input));
      }
      return plans;
    },
  };
}

/**
 * 从 LLM 流式输出里提取并解析导演 JSON 方案。
 * V2 的 callDirectorLLM 用「截取首尾 {} + JSON.parse」，没有 zod 强校验层；V4 保留了强校验，
 * 但 LLM（尤其 GLM 思考模型）偶发两类脏输出会让 JSON.parse 直接抛错：
 *   1. JSON 前后夹带说明文字 / markdown 标记；
 *   2. 字符串值里出现未转义的裸控制字符（0x00-0x1f），如真实换行、制表。
 * 生产赛马实测 GLM 报 "Bad control character in string literal" / "Expected ':' after property name"，
 * 两个模型都解析失败后旧版会静默回退模板片（用户看到的 mock）。此处在解析前做无损清洗，
 * 只转义字符串字面量内部的控制字符、保留 JSON 结构空白，不改变方案语义。
 */
function parseDirectorJsonContent(content: string): Record<string, unknown> {
  const stripped = content
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("DIRECTOR_JSON_NOT_FOUND: 导演输出中未找到 JSON 方案");
  const sliced = stripped.slice(start, end + 1);
  let cleaned = "";
  let inString = false;
  let escaped = false;
  for (const ch of sliced) {
    if (inString) {
      if (escaped) { cleaned += ch; escaped = false; continue; }
      if (ch === "\\") { cleaned += ch; escaped = true; continue; }
      if (ch === '"') { cleaned += ch; inString = false; continue; }
      const code = ch.charCodeAt(0);
      if (code < 0x20) { cleaned += `\\u${code.toString(16).padStart(4, "0")}`; continue; }
      cleaned += ch;
      continue;
    }
    if (ch === '"') inString = true;
    cleaned += ch;
  }
  return JSON.parse(cleaned) as Record<string, unknown>;
}

/**
 * LLM 常把 voice_id（腾讯 VoiceType 数字，如 403010）输出成 JSON number，
 * 而 DirectorPlanSchema 要求数字字符串（^\d{4,9}$）。V2 用 String() 静默归一化，
 * V4 曾因 "expected string, received number" 让 DeepSeek 在赛马里每次都校验失败。
 * 这里只做类型归一化：转成字符串后仍要经过健康候选集白名单校验，不绕过任何安全约束。
 */
function normalizeDirectorVoiceId(parsed: Record<string, unknown>): void {
  const raw = parsed.voice_id;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    parsed.voice_id = String(Math.trunc(raw));
  }
}

/**
 * 批量赛马契约解析：批量请求要求模型输出 { "versions": [ 方案, ... ] }。
 * 容错三档：顶层 versions 数组 → 裸数组 [...] → 整包当单版方案（模型偶发不按数组契约输出时至少救回一版）。
 */
function parseDirectorPlansFromContent(content: string): Record<string, unknown>[] {
  const stripped = content
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (stripped.startsWith("[")) {
    const end = stripped.lastIndexOf("]");
    if (end > 0) {
      try {
        const arr = JSON.parse(stripped.slice(0, end + 1)) as unknown;
        if (Array.isArray(arr)) {
          const plans = arr.filter((item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item));
          if (plans.length) return plans;
        }
      } catch {
        // 裸数组解析失败 → 继续走对象路径（大概率也会失败并触发重试，保持行为可预期）
      }
    }
  }
  const parsed = parseDirectorJsonContent(content);
  const versions = (parsed as { versions?: unknown }).versions;
  if (Array.isArray(versions)) {
    const plans = versions.filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item));
    if (plans.length) return plans;
  }
  return [parsed];
}

export function createOpenAICompatiblePlanner(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fallbackModels?: string[];
  timeoutMs?: number;
  fallbackTimeoutMs?: number;
  streamTimeoutMs?: number;
  maxTokens?: number;
  thinkingBudget?: number;
  fetchImpl?: typeof fetch;
}): DirectorPlanner {
  const fetchImpl = config.fetchImpl ?? fetch;
  const fallbackPlanner = createHeuristicDirectorPlanner();

  // SSRF 安全校验：生产环境或非模拟调用时，校验 baseUrl 绝不能指向内网或保留地址
  if (config.baseUrl && !config.apiKey.startsWith("mock-") && config.apiKey !== "test-key") {
    const safetyCheck = validatePublicUrlSafety(config.baseUrl);
    if (!safetyCheck.safe && process.env.NODE_ENV === "production") {
      throw new Error(`DIRECTOR_API_BASE_URL security violation: ${safetyCheck.reason}`);
    }
  }

  const attachTelemetry = (plan: DirectorPlan, telemetry: DirectorProviderTelemetry): DirectorPlan =>
    Object.assign(plan, { _providerTelemetry: telemetry });

  /**
   * 快捷路径：确定性剪辑决策 / 模拟密钥——不进 LLM，逐版走规则兜底。
   * 返回空数组表示不命中快捷路径，应走主模型调用。
   */
  async function planViaShortcuts(input: DirectorPlanResolvedInput): Promise<DirectorPlan[]> {
    const count = Math.max(1, Math.floor(input.batchVersions ?? 1));
    const deterministicOperation = resolveDeterministicOperation(input.mode, input.prompt);
    const isMockKey = !config.apiKey || config.apiKey === "test-key" || config.apiKey.startsWith("mock-");
    if (!deterministicOperation && !isMockKey) return [];
    const route = resolveDirectorRoute(input);
    const plans: DirectorPlan[] = [];
    for (let index = 0; index < count; index += 1) {
      const plan = await fallbackPlanner.createPlan(input);
      plans.push(attachTelemetry(plan, deterministicOperation ? {
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
      } : {
        providerMode: "heuristic", requestedModel: config.model, selectedModel: null,
        modelsAttempted: [], modelAttempts: [], fallbackUsed: true, promptTokens: 0, completionTokens: 0, totalTokens: 0, usageAvailable: false, costUsageAvailable: false,
        ...routeTelemetry(route, resolveDirectorHits(input, plan, route)),
        failureReason: "模型密钥未配置或处于模拟模式",
      }));
    }
    return plans;
  }

  /** 主路径：模型调用循环，一次调用产出 expectedPlans 个方案（expectedPlans=1 即单版老契约）。 */
  async function callModels(input: DirectorPlanResolvedInput, expectedPlans: number): Promise<DirectorPlan[]> {
    // 批量赛马：提示词契约按版数切换（versions 数组），单版保持原样。
    const planningInput = expectedPlans > 1 ? { ...input, batchVersions: expectedPlans } : input;
    const route = resolveDirectorRoute(planningInput);
    const deterministicOperation = resolveDeterministicOperation(input.mode, input.prompt);
    const models = [...new Set([config.model, ...(config.fallbackModels ?? [])].map((model) => model.trim()).filter(Boolean))];
    const modelsAttempted: string[] = [];
    const modelAttempts: DirectorModelAttempt[] = [];
    let lastError: unknown;
    for (const model of models) {
      if (!modelsAttempted.includes(model)) modelsAttempted.push(model);
      // 严格单次调用：禁止反复重试 LLM，首选 1 次 + 备选 1 次，杜绝 Token 浪费。
      const attemptStartedAt = Date.now();
      const controller = new AbortController();
      // 首包预算：首选 DeepSeek 25s 吐首字，备选 GLM 60s 吐首字。
      // 一旦收到任意首包（无论是 reasoning 还是 content），立即彻底清除计时器，后续全程耐心等待，不限时。
      const firstPacketTimeoutMs = model === config.model
        ? (Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 25_000)
        : (Number(config.fallbackTimeoutMs) > 0 ? Number(config.fallbackTimeoutMs) : 60_000);
      let timeoutError: Error | undefined;
      let rejectTimeout!: (reason: Error) => void;
      const timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject; });
      const fireTimeout = (error: Error) => {
        timeoutError = error;
        rejectTimeout(error);
        controller.abort();
      };
      let firstPacketReceived = false;
      let timer: NodeJS.Timeout | null = setTimeout(() => {
        fireTimeout(new Error(`Director provider first token timed out after ${firstPacketTimeoutMs}ms`));
      }, firstPacketTimeoutMs);
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
            temperature: 0.8,
            stream: true,
            stream_options: { include_usage: true },
            // 批量赛马：一次调用要吐 N 个完整方案，按版数放大输出预算（单版按配置不变；仍受 8192 硬上限钳制）。
            ...(Number.isFinite(config.maxTokens) && Number(config.maxTokens) > 0
              ? {
                max_tokens: Math.max(128, Math.min(8192, Math.floor(
                  expectedPlans > 1
                    ? Math.max(Number(config.maxTokens), Math.ceil(expectedPlans * 1400))
                    : Number(config.maxTokens),
                ))),
              }
              : {}),
            // thinking_budget 只发给主模型：备选 DeepSeek 收到该参数会只吐残缺 JSON。
            ...(model === config.model && Number.isFinite(config.thinkingBudget) && Number(config.thinkingBudget) >= 128
              ? { thinking_budget: Math.max(128, Math.min(32768, Math.floor(Number(config.thinkingBudget)))) }
              : {}),
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: buildDirectorSystemPrompt(planningInput),
              },
              {
                role: "user",
                content: buildDirectorUserPrompt(planningInput),
              },
            ],
          }),
        }), timeoutPromise]);
        if (!response.ok) {
          const detail = (await Promise.race([response.text(), timeoutPromise])).slice(0, 200).replace(/\s+/g, " ");
          throw new Error(`Director provider returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Director provider returned no stream body");
        const decoder = new TextDecoder();
        let buffer = "";
        let content = "";
        let streamedModel: string | undefined;
        let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
        const consumeLine = (line: string) => {
          const raw = line.trim();
          if (!raw.startsWith("data:")) return;
          const data = raw.slice(5).trim();
          if (!data || data === "[DONE]") return;
          const chunk = JSON.parse(data) as {
            model?: string;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            error?: { message?: string } | string;
            choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }>;
          };
          if (chunk.error) throw new Error(`Director provider stream error: ${typeof chunk.error === "string" ? chunk.error : (chunk.error.message ?? "unknown")}`);
          // 思考模型的 reasoning_content 或 content 均代表首包到达：停止首包计时，后续不限时等待完整吐出。
          if (!firstPacketReceived) {
            firstPacketReceived = true;
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
          }
          if (typeof chunk.model === "string") streamedModel = chunk.model;
          if (chunk.usage) usage = chunk.usage;
          const delta = chunk.choices?.[0]?.delta;
          if (typeof delta?.content === "string") content += delta.content;
        };
        while (true) {
          // 首字到达后 timer 已销毁，timeoutPromise 不再触发超时中断，安心等待流完成。
          const { value, done } = firstPacketReceived
            ? await reader.read()
            : await Promise.race([reader.read(), timeoutPromise]);
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) consumeLine(line);
        }
        consumeLine(buffer);
        if (!content.trim()) throw new Error("Director provider returned no structured content");
        // 解析：批量走 versions 数组契约（容错三档）；单版保持原有单对象解析不变。
        const rawPlans = expectedPlans > 1
          ? parseDirectorPlansFromContent(content)
          : [parseDirectorJsonContent(content)];
        // 音色健康候选集一次计算，逐版共用（支持全量健康音色池）。
        const voiceIntent = detectUserVoiceIntent(input.prompt) || {};
        const voiceLanguage = voiceIntent.isCantonese ? "yue" : voiceIntent.isEnglish ? "en" : "zh";
        const preferredTemperament = voiceIntent.explicitTemperament || (route.creationScene === "physical-store" ? "f-soft" : route.creationScene === "online-ecommerce" ? "f-bright" : "f-warm");
        const allowedVoiceCandidates = getAvailableTencentVoiceCandidates({ language: voiceLanguage, gender: voiceIntent.explicitGender || null, preferredTemperament });
        if (!allowedVoiceCandidates.length) throw new Error(`TTS_VOICE_UNAVAILABLE: 当前没有通过健康探测且符合${voiceLanguage === "yue" ? "粤语" : voiceLanguage === "en" ? "英语" : "普通话"}语言/性别要求的腾讯音色`);
        // 逐版校验：normalize + strict schema + 音色健康替换，任何一版不合格整包重试（保住"N 版都要能出片"的承诺）。
        const validatedPlans = rawPlans.map((rawPlan) => {
          const parsed = { ...rawPlan };
          normalizeDirectorVoiceId(parsed);
          // A clear slicing request is a deterministic operation decision, even if the LLM omits it.
          if (deterministicOperation) {
            parsed.operation = deterministicOperation;
          } else {
            // 用户没有要求保留原声或切片，禁止 LLM 自行决定 keep-original 导致静默跳过 TTS 与字幕
            if (parsed.operation === "keep-original") {
              parsed.operation = "standard";
            }
          }
          if (deterministicOperation === "video-slice") parsed.sliceSeconds = parseSliceSeconds(input.prompt);
          if (!parsed.packaging || typeof parsed.packaging !== "object") {
            parsed.packaging = { intro: true, subtitles: true, bgm: true };
          }
          normalizePlanForRoute(parsed, route);
          const validatedPlan = DirectorPlanSchema.parse(parsed);
          // 赛马每条都必须出片（2026-11-20 用户定案）：变体偏离不再整版失败。
          // 方案是完整真实的 LLM 创作，保留其实际选择的变体（标签与内容一致），
          // 遥测自然记录 variantMatched=false 供追溯。执行层无条件执行（2026-11-20 用户定案）：
          // 创作归 LLM，物理可行性静默归一化——LLM 选了不健康/不在候选集的音色时，
          // 静默替换为健康候选，替换事实记录在遥测 voiceSubstituted 供追溯。
          const requestedVoiceType = Number(validatedPlan.voice_id);
          const requestedCandidate = allowedVoiceCandidates.find((candidate: { voiceType: number }) => candidate.voiceType === requestedVoiceType);
          let finalCandidate = requestedCandidate;
          if (!finalCandidate || !isTencentVoiceAvailable(requestedVoiceType)) {
            finalCandidate = allowedVoiceCandidates[0]!;
          }
          // 以映射层解析结果为最终事实：候选集与映射目录同源，正常情况恒等。
          const selectedVoiceType = mapVoiceFor("tencent", String(finalCandidate.voiceType));
          validatedPlan.voice_id = String(selectedVoiceType);
          return { plan: validatedPlan, substituted: finalCandidate.voiceType !== requestedVoiceType, selectedVoiceType };
        });
        if (validatedPlans.length < expectedPlans) {
          throw new Error(`DIRECTOR_BATCH_INCOMPLETE: 导演本次只输出了 ${validatedPlans.length}/${expectedPlans} 个版本`);
        }
        const selectedModel = streamedModel ?? model;
        const promptTokens = Number(usage?.prompt_tokens ?? 0);
        const completionTokens = Number(usage?.completion_tokens ?? 0);
        const totalTokens = Number(usage?.total_tokens ?? (promptTokens + completionTokens));
        const baseTelemetry = {
          providerMode: model === config.model ? "primary" as const : "fallback" as const,
          requestedModel: config.model,
          selectedModel,
          modelsAttempted: [...modelsAttempted],
          modelAttempts: [...modelAttempts, { model, durationMs: Date.now() - attemptStartedAt, ok: true }],
          fallbackUsed: model !== config.model,
          promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
          completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
          totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
          usageAvailable: Boolean(usage && (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined || usage.total_tokens !== undefined)),
          costUsageAvailable: Boolean(usage && usage.prompt_tokens !== undefined && usage.completion_tokens !== undefined),
          ...routeTelemetry(route, resolveDirectorHits(input, validatedPlans[0]!.plan, route)),
          voiceCandidateIds: allowedVoiceCandidates.map((candidate: { voiceType: number }) => candidate.voiceType),
        };
        // 每版携带共享遥测 + 各自的音色事实（批量赛马时 N 版音色由 LLM 统筹、互不相同）。
        return validatedPlans.slice(0, expectedPlans).map((item) => attachTelemetry(item.plan, {
          ...baseTelemetry,
          modelAttempts: [...baseTelemetry.modelAttempts],
          voiceId: item.plan.voice_id,
          voiceType: item.selectedVoiceType,
          voiceSubstituted: item.substituted,
        }));
      } catch (error) {
        lastError = timeoutError ?? error;
        modelAttempts.push({
          model,
          durationMs: Date.now() - attemptStartedAt,
          ok: false,
          error: lastError instanceof Error ? lastError.message.slice(0, 240) : String(lastError).slice(0, 240),
        });
      } finally {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }
    }
    // 所有配置模型均调用失败：如实抛错，由调用方降级/标 failed。不再静默 heuristic 兜底。
    const lastDetail = lastError instanceof Error
      ? lastError.message.slice(0, 160)
      : String(lastError ?? "unknown").slice(0, 160);
    throw new Error(
      `DIRECTOR_ALL_MODELS_FAILED: AI 导演服务暂时不可用（已尝试 ${modelsAttempted.join("、")}），请稍后重试。详情：${lastDetail}`,
    );
  }

  /** 单版规划：快捷路径 → 主模型调用。 */
  const createSinglePlan = async (singleInput: DirectorPlanResolvedInput): Promise<DirectorPlan> => {
    const shortcut = await planViaShortcuts(singleInput);
    if (shortcut.length) return shortcut[0]!;
    const plans = await callModels(singleInput, 1);
    return plans[0]!;
  };

  return {
    createPlan: (input) => createSinglePlan({ ...input, batchVersions: 1 }),
    async createPlans(input) {
      const count = Math.max(1, Math.floor(input.batchVersions ?? 1));
      if (count <= 1) return [await createSinglePlan({ ...input, batchVersions: 1 })];
      const shortcut = await planViaShortcuts(input);
      if (shortcut.length) return shortcut;
      try {
        // 批量赛马主路径：一次 LLM 调用统筹 N 版差异化（台词/音色/BGM 由 LLM 统一拉开）。
        return await callModels(input, count);
      } catch (batchError) {
        // 整包失败降级：逐版独立单版调用（老链路），交付保证优先于一次调用优化。
        const plans: DirectorPlan[] = [];
        for (let index = 0; index < count; index += 1) {
          plans.push(await createSinglePlan({ ...input, batchVersions: 1 }));
        }
        return plans;
      }
    },
  };
}
