import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { CreationMode } from "@jansee/contracts";
// @ts-expect-error anchor-kit has no bundled type declarations
import { rankAnchors, HOST_LIBRARY, LOCAL_ROLES, LOCAL_ROLE_COMPAT, getAnchor, getDna, compatAnchors, SELL_VARIANTS, ANCHOR_REDLINE_MD } from "@jansee/anchor-kit";
import { detectUserVoiceIntent, CANTONESE_DIALECT, ENGLISH_VOICES, getAvailableTencentVoiceCandidates } from "@jansee/tts-kit";
// @ts-expect-error prompts/index.js is plain JS module
import { decideVariantLocal, SELL_VARIANT_TYPES, LOCAL_VARIANT_TYPES } from "../prompts/index.js";
import type { DirectorPlanResolvedInput } from "./director.ts";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

function resolvePromptsDir(): string {
  const candidates = [
    path.resolve(currentDir, "../prompts"),
    path.resolve(process.cwd(), "apps/api/prompts"),
    path.resolve(currentDir, "../../apps/api/prompts"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, "constitution.md"))) {
      return candidate;
    }
  }
  return candidates[0]!;
}

const PROMPT_DIR = resolvePromptsDir();

function safeReadFile(filename: string): string {
  try {
    const fullPath = path.join(PROMPT_DIR, filename);
    if (fs.existsSync(fullPath)) {
      return fs.readFileSync(fullPath, "utf-8");
    }
  } catch {
    // fallback below
  }
  return "";
}

// 缓存各提示词文档资产
const CONSTITUTION_MD = safeReadFile("constitution.md");
const SELL_PERSONA_MD = safeReadFile("director-sell.md");
const LOCAL_PERSONA_MD = safeReadFile("director-local.md");
const STORYBOARD_DIRECTOR_MD = safeReadFile("storyboard-director.md");
const PUBLISH_RULES_MD = safeReadFile("publish-rules.md");
// Keep global constitution principles, excluding its legacy JSON schema (V4 owns the output contract).
const CONSTITUTION_RULES_MD = CONSTITUTION_MD.split(/^# ==================== 2\..*$/m)[0]!.split(/\r?\n/).filter((line) => !/^[1357]\./.test(line.trim())).join("\n").trim();
// Add storyboard constraints without the legacy output schema.
const STORYBOARD_CORE_MD = STORYBOARD_DIRECTOR_MD.split(/^# ==================== 3\..*$/m)[0]!.trim();

const COMMERCE_REGEX = /(保暖|打底|衣服|裤|裙|鞋|包|手表|机械表|数码|手机|电脑|美妆|护肤|面霜|精华|防晒|口红|耳机|音响|水杯|保温杯|炒锅|收纳|零食|特产|材质|做工|尺码|面料|版型|修身|显瘦|加厚|防风|防水|透气|现货|性价比|包邮|秒杀|福利|活动价|特惠|买一赠|拍下|下单|到手价|正品|专柜|带货|同款|推荐买|值得入|神器|好物)/i;
const LOCAL_REGEX = /(老店|老字号|餐馆|火锅|烤鸭|烧烤|烤肉|咖啡|小酒馆|奶茶|甜品|门店|门头|档口|招牌菜|堂食|包间|人均|位置|同城|探店|打卡|免预约|地址|商圈|步行街|地铁站|营业时间|聚餐|约会|排队|环境好|到店|附近)/i;

/**
 * 智能识别文本中的商业实体属性（区分线上电商带货与同城探店）
 */
export type CreationScene = "online-ecommerce" | "physical-store" | "personal-creation";

/** Resolve explicit composer choice before any keyword inference. */
export function detectCreationScene(text = "", mode: CreationMode = "image-film"): CreationScene {
  const selected = text.match(/User-selected creation scene:\s*(online-ecommerce|physical-store|personal-creation)/i)?.[1]?.toLowerCase();
  if (selected === "online-ecommerce" || selected === "physical-store" || selected === "personal-creation") return selected;
  if (text.includes("physical-store")) return "physical-store";
  if (text.includes("online-ecommerce")) return "online-ecommerce";
  if (text.includes("personal-creation")) return "personal-creation";
  return detectSceneIntent(text, mode) === "local" ? "physical-store" : "online-ecommerce";
}

export function detectSceneIntent(text = "", mode: CreationMode = "image-film"): "sell" | "local" {
  const clean = text.trim();
  if (clean.includes("physical-store")) return "local";
  if (["online-ecommerce", "personal-creation"].some((key) => clean.includes(key))) return "sell";
  const hasLocal = LOCAL_REGEX.test(clean);
  const hasCommerce = COMMERCE_REGEX.test(clean);

  if (hasLocal && (clean.includes("到店") || clean.includes("同城") || clean.includes("人均") || clean.includes("老店") || clean.includes("打卡") || clean.includes("附近") || clean.includes("堂食"))) {
    return "local";
  }
  if (hasCommerce) {
    return "sell";
  }
  return mode === "image-film" ? "sell" : "local";
}

/** 导演路由解析结果：场景识别、人设方向与系统锁定变体，用于提示词组装与遥测上报。 */
export interface DirectorRouteResolution {
  creationScene: CreationScene;
  scene: "sell" | "local";
  isPersonal: boolean;
  decidedVariant: string | null;
  sceneSource: "user-selected" | "keyword-inferred";
}

/** 统一解析创建场景与锁定变体，供提示词组装与导演遥测共用，保证单一事实来源。 */
export function resolveDirectorRoute(input: DirectorPlanResolvedInput): DirectorRouteResolution {
  const userSelected = /User-selected creation scene:\s*(online-ecommerce|physical-store|personal-creation)/i.test(input.prompt)
    || ["physical-store", "online-ecommerce", "personal-creation"].some((key) => input.prompt.includes(key));
  const creationScene = detectCreationScene(input.prompt, input.mode);
  const scene = creationScene === "physical-store" ? "local" : "sell";
  const isPersonal = creationScene === "personal-creation";
  // 普通任务由人设导演自主选择；仅批量赛马的服务端 variantOverride 锁定变体。
  const decidedVariant = isPersonal ? null : input.variantOverride || null;
  return { creationScene, scene, isPersonal, decidedVariant, sceneSource: userSelected ? "user-selected" : "keyword-inferred" };
}

/**
 * 组装主播/实体角色风格层
 */
function buildAnchorBlock(scene: "sell" | "local", prompt: string, decidedVariant?: string): string[] {
  if (scene === "local") {
    const roleLines = (LOCAL_ROLES as Array<{ id: string; label: string; name: string; temperaments: string[] }> || []).map(
      (r, i) => `${i + 1}. ${r.id}（${r.label}）· 调性：${r.name} · 推荐音色：${(r.temperaments || []).join(" / ")}`
    );
    const compatLines = Object.entries(LOCAL_ROLE_COMPAT || {}).map(([v, roles]) => `${v}：${(roles as string[]).join(" / ")}`);
    return [
      "===== 实体角色风格层（线下实体专属表达人格，严禁任何电商带货腔） =====",
      "本片可选实体角色池（彻底禁止任何电商直播叫卖或喧闹催单，根据门店调性从下列 4 种实体角色中选 1 种）：",
      ...roleLines,
      "",
      "【变体-实体角色兼容表】：",
      ...compatLines,
      "",
      "【选定规则】按人设导演判定 variant_type 后，从兼容的实体角色中选 1 个填入 anchor 字段（可选：shopowner、local-friend、craftsman、budget-guide）。",
      "【线下实体绝对红线】：严禁在台词或文案中出现「现货直发 / 全国包邮 / 整箱囤货 / 拍下 / 下单 / 快递 / 顺丰」等任何电商词汇！无论素材是什么，必须写出同城烟火气与真实人均消费，引导同城顾客到店尝鲜与线下体验。",
      "",
    ];
  }

  const ranked = decidedVariant
    ? rankAnchors({ variantType: decidedVariant, taskId: prompt }) || HOST_LIBRARY || []
    : HOST_LIBRARY || [];
  const poolLines = ranked.map((h: { id: string; name: string; temperaments?: string[] }, i: number) => {
    return `${i + 1}. ${h.id}（风格锚点：${h.name}）· 推荐音色气质：${(h.temperaments || []).join(" / ")}`;
  });

  return [
    "===== 主播风格层（本片台词的表达人格与营销穿透力） =====",
    "本片候选主播池（推荐顺序如下，请根据商品调性与变体类型挑选契合的 anchor）：",
    ...poolLines,
    "",
    "【选定规则】先按人设导演判定 variant_type，再从契合的主播中选 1 个填入 anchor 字段。",
    ANCHOR_REDLINE_MD || "【红线】：主播姓名仅作为风格锚点参考，台词中严禁出现任何真实公众人物姓名。",
    "",
  ];
}

/**
 * 组装声音与音色指令
 */
function buildVoiceInstructions(prompt: string, creationScene: CreationScene): string[] {
  const userIntent = detectUserVoiceIntent(prompt) || {};
  const language = userIntent.isCantonese ? "yue" : userIntent.isEnglish ? "en" : "zh";
  const preferredTemperament = userIntent.explicitTemperament || (creationScene === "physical-store" ? "f-soft" : creationScene === "online-ecommerce" ? "f-bright" : "f-warm");
  const candidates = getAvailableTencentVoiceCandidates({ language, gender: userIntent.explicitGender || null, limit: 8, preferredTemperament });
  // 随机调整候选展示顺序，打破模型对固定首位音色的偏好；最终选择仍由 LLM 完成。
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const lines: string[] = [];

  if (userIntent.explicitGender) {
    lines.push(`[配音性别硬约束]：用户明确指定${userIntent.explicitGender === "male" ? "男声" : "女声"}；候选集已按性别过滤，不得选择其他性别。`);
  } else {
    lines.push("[配音性别]：用户未指定性别，可从候选集中的男声或女声自主选择。");
  }
  if (language === "yue") {
    lines.push(`[粤语语言硬约束]：用户明确指定${CANTONESE_DIALECT?.name || "粤语"}；${CANTONESE_DIALECT?.stylePrompt || "必须使用地道粤语"}。候选集只包含腾讯明确支持粤语的音色。`);
  } else if (language === "en") {
    lines.push(`[英语语言硬约束]：用户明确指定英文/外语配音；${ENGLISH_VOICES?.stylePrompt || "必须使用地道英语"}。候选集只包含腾讯明确支持英语的音色。`);
  } else {
    lines.push("[普通话语言约束]：本次使用腾讯明确支持普通话的健康音色候选。");
  }
  if (userIntent.explicitTemperament) {
    lines.push(`[音色倾向]：用户表达了「${userIntent.explicitTemperament}」倾向；优先参考候选顺序，但仍由你结合场景、人设 DNA 和内容决定最终音色。`);
  }

  lines.push("[真实腾讯 TTS 动态候选集]：以下数字均为腾讯官方 VoiceType，且在本次提示词组装时健康状态明确为 healthy。只能从本次候选集选择一个 voice_id，必须原样输出数字 ID；禁止输出别名、旧 ID 或自行编造 ID。");
  if (!candidates.length) {
    lines.push("[无可用音色]：当前没有同时满足语言、性别与健康条件的腾讯音色。不得伪造 voice_id 或使用其他语言音色；必须返回无法满足配音条件。");
  } else {
    for (const gender of (randomInt(2) === 0 ? ["male", "female"] : ["female", "male"])) {
      const group = shuffled.filter((item: { gender: string }) => item.gender === gender);
      if (group.length) lines.push(`${gender === "male" ? "男声" : "女声"}候选：${group.map((item: { voiceType: number; label: string }) => `${item.voiceType}（${item.label}）`).join(" / ")}`);
    }
    lines.push(`本次候选数量：${candidates.length}；候选上限：8。候选不足时只提供全部合格音色，不得跨语言或跨性别凑数。`);
  }
  lines.push("[导演音色决策]：必须结合当前场景、人设 DNA、旁白情绪与内容表达，从本次候选中明确选择 voice_id；不得使用固定默认音色，不得总是选择候选列表第一项。不同任务应根据内容主动变化，不能为了省事反复复用同一个音色。voice_id 必须是上方列出的数字 ID。");
  lines.push("[语速控制]：必须输出 speech_speed，范围 0.85–1.25；1.00 为正常语速，低于 1.00 放慢，高于 1.00 加快。根据旁白情绪、信息密度和视频节奏选择，不得省略或超范围。");
  return lines;
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

/**
 * 组装动态 System Prompt
 */
export function buildDirectorSystemPrompt(input: DirectorPlanResolvedInput): string {
  const { creationScene, scene, isPersonal, decidedVariant } = resolveDirectorRoute(input);
  const personaMd = creationScene === "physical-store" ? LOCAL_PERSONA_MD : creationScene === "online-ecommerce" ? SELL_PERSONA_MD : "";
  const anchorBlock = isPersonal
    ? ["===== Personal creative direction =====", "Focus on the creator's own voice, knowledge, lifestyle or personal IP; do not use ecommerce host or store-tour personas."]
    : buildAnchorBlock(scene, input.prompt, decidedVariant ?? undefined);
  const voiceBlock = buildVoiceInstructions(input.prompt, creationScene);

  const sections: string[] = [
    `Director route: ${creationScene}. The Constitution Director owns global rules and quality; persona directors operate only inside its boundaries.`,
    CONSTITUTION_RULES_MD,
    input.mode === "storyboard" ? STORYBOARD_CORE_MD : "",
    creationScene === "online-ecommerce" ? "[DIRECTOR ROUTE] Online persona director only: use the 14 ecommerce variants and their compatible ecommerce hosts; never use store-tour roles." : "",
    creationScene === "physical-store" ? "[DIRECTOR ROUTE] Local persona director only: use the 8 local variants and their compatible store-tour hosts; never use ecommerce hosts." : "",
    creationScene === "personal-creation" ? "[DIRECTOR ROUTE] Personal creator path: Constitution Director directs knowledge, lifestyle, personal expression or personal IP. Do not use either commercial variant set or commercial hosts." : "",
    `你是简兮 JANSEE 的成熟商业短视频总导演。你具备顶尖短视频爆款网感，深谙 2025-2026 年最新流量与转化逻辑。`,
    `Mode: ${input.mode === "image-film" ? "image film" : input.mode === "video-dub" ? "single video dub" : "storyboard"}. User-selected scene: ${input.prompt.includes("online-ecommerce") ? "product sales" : input.prompt.includes("physical-store") ? "store attraction" : input.prompt.includes("personal-creation") ? "personal creation" : scene === "local" ? "local business" : "ecommerce"}.`,
    input.prompt.includes("personal-creation") ? "[USER SCENE RULE] Personal creation: focus on the creator, knowledge, lifestyle or personal IP; do not default to product selling, store traffic or promotions." : "",
    input.prompt.includes("online-ecommerce") ? "[USER SCENE RULE] Online ecommerce: use only supplied product facts and buyer needs; never invent specifications, effects, prices or credentials." : "",
    input.prompt.includes("physical-store") ? "[USER SCENE RULE] Physical store: focus on the real venue, service and reasons to visit; never use ecommerce shipping or checkout language." : "",
    "",
    "===== 2025-2026 短视频爆款与情绪价值最高准则 =====",
    "1. 【黄金 3 秒法则（前 3 秒留存生死线）】：",
    "   * 第一句台词严禁任何平铺直叙或客套寒暄（严禁「今天给大家介绍/这是一款/哈喽大家好/欢迎光临」）；",
    "   * 必须在前 3 秒使用以下四大黄金钩子之一瞬间抓住注意力：",
    "     - 反常识/认知颠覆型（如「别再以为...90%的人都踩坑了」）",
    "     - 痛点具象/尴尬唤醒型（如「谁懂啊！每次...尴尬得脚趾抠地」）",
    "     - 极致省钱/质价比暴击（如「省下大几百，效果一模一样的宝藏平替终于找到了」「人均20块吃到扶墙出」）",
    "     - 情绪价值/生活治愈型（如「下班回到家闻到这个味道那一刻，感觉整天的疲惫都被治愈了」）；",
    "2. 【去播音腔与去 AI 感（口语生活化）】：",
    "   * 口播台词 narration 必须像「闺蜜/兄弟发微信语音」或「同城老饕给朋友安利」一样真实自然，富有松弛感与情绪价值；",
    "   * 严禁机械僵硬的书面语或咆哮式无脑逼单叫卖，多用有温度的生活化语言；",
    "3. 【单一卖点刺穿（USP）】：",
    "   * 短视频完播率第一！不要把所有优点罗列一遍，聚焦 1~2 个最能打动用户的核心卖点或招牌菜讲透；",
    "4. 【真实性与客观事实红线】：",
    "   * 严格遵守素材事实白名单：你只能根据用户明确提供的文字和素材基本元数据创作；",
    "   * 绝对禁止编造未被用户明确提供的商品外观、参数、工艺、功效、价格、资质背书或虚假承诺；",
    "   * 绝对禁止把文件名推测为画面事实；没有视觉模型支撑时，scenes 仅描述节奏与镜头制作安排；",
    "",
    "===== 场景人设与变体规则 =====",
    isPersonal ? "\u3010\u4e2a\u4eba\u521b\u4f5c\u5bfc\u6f14\u3011\u56f4\u7ed5\u521b\u4f5c\u8005\u672c\u4eba\u8868\u8fbe\u3001\u77e5\u8bc6\u5206\u4eab\u3001\u751f\u6d3b\u8bb0\u5f55\u6216\u4e2a\u4eba IP \u521b\u4f5c\uff1b\u4e0d\u52a0\u5165\u5546\u54c1\u6210\u4ea4\u6216\u95e8\u5e97\u5f15\u6d41\u8bdd\u672f\u3002" : personaMd || (scene === "local" ? "\u3010\u540c\u57ce\u63a2\u5e97\u4eba\u8bbe\u3011\uff1a\u4e3b\u6253\u771f\u5b9e\u63a2\u5e97\u3001\u70df\u706b\u6c14\u3001\u540c\u57ce\u5230\u5e97\u4f53\u9a8c\uff0c\u4e25\u7981\u7535\u5546\u7269\u6d41\u8bcd\uff01" : "\u3010\u5e26\u8d27\u4eba\u8bbe\u3011\uff1a\u4e3b\u6253\u6d88\u8d39\u5fc3\u7406\u6d1e\u5bdf\u3001\u75db\u70b9\u5171\u60c5\u3001\u771f\u5b9e\u4f53\u9a8c\u4fc3\u5355\uff01"),
    decidedVariant ? `【系统强信号锁定】：根据用户输入，系统已锁定变体类型为「${decidedVariant}」，请严格以此风格创作。` : "",
    "",
    ...anchorBlock,
    "",
    "===== 声音与视听节奏规范 =====",
    ...voiceBlock,
    `[背景音乐 BGM 情绪池]（从下列合法项选 1 个填入 bgm_emotion）：${CANDIDATE_EMOTIONS.join(" / ")}`,
    "【简兮视听宪法铁律】：",
    "1. 视觉：相邻分镜必须采用叠画过渡（cross-dissolve 0.7秒），绝对禁止生硬跳切；",
    "2. 听觉：两段式音量避让——有人声口播区间 BGM 压低避让至 0.10，无人声纯画面区间 BGM 恢复至 0.22 垫底；",
    "3. 完整包装：默认 packaging 中 intro、ending、subtitles、bgm 全部为 true；除非用户明确要求取消某项时对应设为 false；",
    "4. 剪辑意图操作：operation 必须为 standard、video-slice 或 keep-original 之一；用户明确要求切片/拆条时选 video-slice 并设置 sliceSeconds（5-120秒）；用户要求保留原声不配音时选 keep-original；其余为 standard。",
    "",
    "===== 发布方案规则（全链路必填） =====",
    PUBLISH_RULES_MD || "【发布交付物】：必须在 publish 字段输出 caption（带3-5个精准长尾话题标签）、cover_title（10-25字爆款标题）、pinned_comment（引流与互动问句置顶评论）、post_time（建议发布时间）。严禁过时年份，严禁虚构物流。",
    "",
    "===== 统一 JSON 输出格式契约 (Strict JSON Only) =====",
    "你必须且仅输出一个纯 JSON 对象，严禁任何 markdown 标记（严禁 ```json 包裹），严禁任何前后缀解释。字段完整列表：",
    JSON.stringify({
      operation: "standard 或 video-slice 或 keep-original",
      sliceSeconds: 20,
      title: "4~15字凝练主标题",
      concept: "结合变体与主播风格的情绪创作阐述（20~100字）",
      note: "版式底部说明行：6~16字品牌感短句，与画面调性一致，不带句号，不写制作流程字眼，绝不复述旁白原文",
      durationSeconds: 15,
      narration: "完整的中文口播旁白原话（40~120字，必须有黄金前3秒抓人钩子，去播音腔，绝不复述用户制作指令）",
      scenes: [
        { order: 1, description: "镜头制作节奏安排", durationSeconds: 5 },
        { order: 2, description: "镜头制作节奏安排", durationSeconds: 5 },
        { order: 3, description: "镜头制作节奏安排", durationSeconds: 5 },
      ],
      style: "简兮商业视觉流（叠化0.7s转场，人声音量0.10/0.22避让）",
      soundtrack: "匹配主播与调性的 BGM 说明",
      anchor: isPersonal ? "none" : "selected-compatible-host-from-current-director-route",
      voice_id: "真实腾讯 TTS VoiceType 数字 ID（例如 403010、402001、404000、402000）",
      speech_speed: 1.0,
      bgm_emotion: "从情绪池选 1 个",
      variant_type: isPersonal ? "personal-creation" : decidedVariant || "selected-variant-from-current-persona-director",
      packaging: { intro: true, ending: true, subtitles: true, bgm: true },
      publish: {
        caption: "发布正文文案，带 3-5 个垂直长尾话题标签（如 #打工人救星 #私藏宝藏好物）",
        cover_title: "10~25字爆款短视频标题",
        pinned_comment: "高互动置顶评论，抛出互动问题或客观指引",
        post_time: "黄金发布时段建议",
      },
    }, null, 2),
  ];

  return sections.filter((s) => typeof s === "string" && s.trim().length > 0).join("\n");
}

/**
 * 组装动态 User Prompt
 */
export function buildDirectorUserPrompt(input: DirectorPlanResolvedInput): string {
  const isVideo = input.mode !== "image-film";
  const assetCount = input.assets.length;

  return JSON.stringify({
    creationGoal: input.prompt,
    mode: input.mode,
    aspectRatio: input.aspectRatio,
    mediaFacts: {
      assetCount,
      assetType: isVideo ? "实拍视频" : "实拍图片",
      assets: input.assets.map((a, i) => ({
        index: i + 1,
        name: a.name,
        kind: a.kind,
        sizeBytes: a.size,
      })),
    },
    promptInstructions: [
      "请作为专业导演，提炼用户文案中的客观事实，匹配最精准的变体与主播人设，输出可直接交付并可执行的完整成片方案与发布四件套。",
      "切记：第一句台词必须是抓人的黄金3秒钩子，去播音腔，不要编造用户未提及的任何数据或事实！",
    ],
  }, null, 2);
}
