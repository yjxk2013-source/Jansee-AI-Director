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
      "【选定规则】按人设导演判定 variant_type 后，从兼容的实体角色中选 1 个填入 anchor 字段（可选：shopowner、local-friend、craftsman、budget-guide；注意：必须使用键名 anchor，禁止输出为 anchor_id）。",
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
    "【选定规则】先按人设导演判定 variant_type，再从契合的主播中选 1 个填入 anchor 字段（注意：必须使用键名 anchor，禁止输出为 anchor_id）。",
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
    `Director route: ${creationScene}. Constitution Director owns global rules; persona directors operate within its boundaries.`,
    "===== 简兮 AI 导演 · 全局宪法核心视听铁律 (Constitution Core) =====",
    "1. 素材与分镜对齐铁律：用户的 N 个实拍素材是唯一定格画面来源，输入 N 个素材必须且恰好规划 N 个分镜镜头，按视觉叙事顺序编排，严禁遗漏任何素材；",
    "2. 时长与呼吸气口铁律：各分镜物理时长由台词人声实测与镜间呼吸停顿驱动，严禁凭空估算虚假时长；成片 durationSeconds 代表全片预计总时长（6~60秒）；",
    "3. 真实性绝对红线：只提炼用户明确给出的客观事实，严禁编造参数、价格、功效或权威背书；严禁出现「左下角」「小黄车」「点击链接」等虚构导流；",
    "4. 视听高级感铁律：死守无损物理安全区与 0 Emoji 规范；标题极简克制，副标留白点睛，正文旁白自然松弛。",
    CONSTITUTION_RULES_MD,
    input.mode === "storyboard" ? STORYBOARD_CORE_MD : "",
    creationScene === "online-ecommerce" ? "[ROUTE] Ecommerce: use 14 ecommerce variants + ecommerce hosts only." : "",
    creationScene === "physical-store" ? "[ROUTE] Local: use 8 local variants + store-tour hosts only." : "",
    creationScene === "personal-creation" ? "[ROUTE] Personal creator path: Constitution Director directs knowledge, lifestyle, personal expression or personal IP. Do not use commercial variants or hosts." : "",
    `简兮总导演。Mode: ${input.mode === "image-film" ? "image film" : input.mode === "video-dub" ? "single video dub" : "storyboard"}. Scene: ${input.prompt.includes("online-ecommerce") ? "product sales" : input.prompt.includes("physical-store") ? "store attraction" : input.prompt.includes("personal-creation") ? "personal creation" : scene === "local" ? "local business" : "ecommerce"}.`,
    input.prompt.includes("personal-creation") ? "[SCENE] Personal: focus on creator expression, not selling." : "",
    input.prompt.includes("online-ecommerce") ? "[SCENE] Ecommerce: only use supplied product facts." : "",
    input.prompt.includes("physical-store") ? "[SCENE] Local: focus on venue and visit reasons." : "",
    "",
    "===== 爆款准则（黄金 3 秒法则与情绪价值） =====",
    "1. 黄金 3 秒法则：第一句口播必须使用反常识/认知颠覆型、痛点具象唤醒、极致省钱或生活治愈钩子，严禁「大家好/今天介绍」等平铺开场；",
    "2. 去播音腔与去 AI 感：narration 台词像闺蜜发语音一样松弛自然，赋予松弛感与情绪价值，严禁书面语和咆哮逼单；",
    "3. 单一卖点刺穿（USP）：只聚焦讲透 1-2 个核心卖点，不盲目罗列；",
    "4. 事实红线：只用用户明确提供的事实，严禁编造参数/价格/功效/资质背书；禁止从文件名推测画面内容；",
    "",
    "===== 成片旁白与分镜节奏对齐律（极其重要） =====",
    "1. narration 字段是全片口播配音的唯一样本。如果用户输入提供了 N 个素材（无论是图片还是视频），narration 必须恰好由 N 句精炼台词组成，每句用标点符号（句号、感叹号或问号）清晰隔开；",
    "2. 每一句台词按顺序严格对应第 1 到第 N 个分镜素材，执行层会将每句话与对应分镜无缝绑定；",
    "3. 严禁单句长难句跨越多个分镜镜头，必须确保每一句话在当前镜头内语意完整、富有呼吸节奏；",
    "4. scenes 数组的长度必须为 N（与素材数量一致），order 从 1 到 N，description 为该分镜镜头的视觉焦点与运镜节奏安排。",
    "",
    "===== 场景人设与变体规则 =====",
    isPersonal ? "【个人创作导演】围绕创作者本人表达、知识分享、生活记录或个人 IP 创作；不加入商品成交或门店引流话术。" : personaMd || (scene === "local" ? "【同城探店人设】：主打真实探店、烟火气、同城到店体验，绝对禁止电商网购与物流词汇！" : "【带货人设】：主打消费心理洞察、痛点共情、真实体验促单，明确变体类型与主播风格！"),
    decidedVariant ? `【系统强信号锁定】：根据用户输入，系统已锁定变体类型为「${decidedVariant}」，请严格以此风格创作。` : "",
    "",
    ...anchorBlock,
    "",
    "===== 声音与视听节奏规范 =====",
    ...voiceBlock,
    `[背景音乐 BGM 情绪池]（从下列合法项选 1 个填入 bgm_emotion）：${CANDIDATE_EMOTIONS.join(" / ")}`,
    "视听铁律：1.相邻分镜叠画转场0.7s（禁跳切）；2.两段式音量避让：口播段BGM=0.10，纯画面段BGM=0.22；3.packaging中intro/ending/subtitles/bgm默认全true；4.operation: standard/video-slice/keep-original。",
    "",
    "===== 发布方案规则 =====",
    "publish必填：caption(正文+3-5个精准长尾话题标签)、cover_title(10-25字爆款标题)、pinned_comment(互动引流或置顶问句)、post_time(建议发布时段)。严禁过时年份与虚构物流。",
    "",
    "===== 统一 JSON 输出格式契约 (Strict JSON Only) =====",
    "仅输出一个合法纯 JSON 对象，严禁 Markdown 代码块包裹（禁 ```json），严禁前后缀解释。字段列表：",
    JSON.stringify({
      operation: "standard 或 video-slice 或 keep-original",
      sliceSeconds: 20,
      title: "画面视觉主标题（4~6字最佳的凝练高奢短语，如「素履以往」「手作咖啡」「现烤蛋挞」，字数越少排版越大气高级，严禁冗长句子，严禁复制发布标题）",
      concept: "结合变体与主播风格的情绪创作阐述（20~100字）",
      note: "版式底部点睛说明行（6~16字，东方极简/品牌高奢短句，如「东方草本 匠心慢熬」「天然材质 触手生温」「寻味山野 一席清欢」，严禁句号，严禁写成英文水印套话如 JANSEE FILM，严禁复述旁白原文）",
      durationSeconds: 15,
      narration: "完整的中文口播旁白原话（40~120字，必须由对应素材数量的N句精炼台词组成，第一句必须为黄金3秒抓人钩子，去播音腔，绝不复述用户制作指令）",
      scenes: [
        { order: 1, description: "第1个镜头的视觉焦点与运镜节奏安排", durationSeconds: 5 },
        { order: 2, description: "第2个镜头的视觉焦点与运镜节奏安排", durationSeconds: 5 },
      ],
      style: "简兮商业视觉流（叠化0.7s转场，人声音量0.10/0.22避让）",
      soundtrack: "匹配主播与调性的 BGM 说明",
      anchor: isPersonal ? "none" : (scene === "local" ? "从上方实体角色中选1个填入其ID（如 shopowner、local-friend、craftsman、budget-guide；键名为 anchor）" : "从上方主播池中选1个填入其ID（如 yu-jie、b-tai、laoba-pingce 等；键名为 anchor）"),
      voice_id: "真实腾讯 TTS VoiceType 数字 ID（例如 403010、402001、404000、402000）",
      speech_speed: 1.0,
      bgm_emotion: "从情绪池选 1 个",
      variant_type: isPersonal ? "personal-creation" : (decidedVariant || `从当前场景变体池选1个精确填入：${(scene === "local" ? LOCAL_VARIANT_TYPES : SELL_VARIANT_TYPES).join(" / ")}`),
      packaging: { intro: true, ending: true, subtitles: true, bgm: true },
      publish: {
        caption: "发布正文文案（≤150字，不复述旁白台词，文末带 3-5 个垂直长尾话题标签，如 #打工人救星 #私藏宝藏好物）",
        cover_title: "平台发布爆款标题（10~25字，给抖音/小红书/视频号填写的引流标题，直击痛点与利益点，如「打工人宵夜救星！2块钱一包的光友酸辣粉丝」）",
        pinned_comment: "高转化置顶互动评论（≤50字，抛出互动问题或客观指引，拉升评论区停留互动）",
        post_time: "黄金发布时段建议（一句话，如「晚间 19:30-21:30 黄金流量档」）",
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
      `分镜与台词精准对齐：本次任务共有 ${assetCount} 个实拍素材。请规划恰好 ${assetCount} 个分镜镜头（scenes 数组长度为 ${assetCount}，order 为 1 到 ${assetCount}）；全局 narration 旁白必须恰好由 ${assetCount} 句口播台词组成（用标点隔开），按顺序严格对应每个分镜镜头，严禁跨镜头长句。`,
      "切记：第一句台词必须是抓人的黄金3秒钩子，去播音腔，不要编造用户未提及的任何数据或事实！",
      "标题与说明行规范：title 必须为 4~6 字高级主标题（不可写成引流长句）；note 为 6~16 字调性说明行（不可复述旁白，不可写套话，不可留空）；publish.cover_title 为 10~25 字爆款发布标题。",
    ],
  }, null, 2);
}
