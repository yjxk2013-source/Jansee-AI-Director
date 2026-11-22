import { randomInt } from "node:crypto";
import type { CreationMode } from "@jansee/contracts";
import { detectUserVoiceIntent, CANTONESE_DIALECT, ENGLISH_VOICES, getAvailableTencentVoiceCandidates } from "@jansee/tts-kit";
import { decideVariantLocal, SELL_VARIANT_TYPES, LOCAL_VARIANT_TYPES } from "./variant-rules.js";
import type { DirectorPlanResolvedInput } from "./director.ts";

export { decideVariantLocal, SELL_VARIANT_TYPES, LOCAL_VARIANT_TYPES };

// V4 原生全局宪法原则与真实性红线
const CONSTITUTION_RULES = [
  "2. 真实性红线：严禁编造未提及的商品/门店参数、价格或认证；严禁主动出现「左下角」「小黄车」「点击链接」等词汇。",
  "4. 视听与声音：配音跟随用户指定性别或由你自主匹配最契合文字情绪的合法音色 Key；BGM 按 bgm_emotion 情绪选曲。",
  "6. 发布方案铁律：publish 四件套（caption / cover_title / pinned_comment / post_time）是给商家的发布交付物，与旁白台词互补不重复；caption 是对外公开发布的广告文案，严禁极限词与虚假承诺。",
].join("\n");

// V4 分镜解说专属规则
const STORYBOARD_CORE_RULES = [
  "===== 分镜镜头与字数硬约束 =====",
  "1. 镜头数量绝对一致：输入有 N 个分镜素材，全局 narration 旁白必须且恰好由 N 句精炼台词组成（用标点隔开，按顺序严格对应第 1 到第 N 个分镜镜头），不多不少；scenes 数组包含对应的 N 个镜头节奏安排。",
  "2. 台词即时间：台词写多长，配音和镜头就多长；成片时长由 TTS 实测配音自然决定，严禁估算秒数、严禁输出任何时长字段；每句台词只需语义完整、适合口播。",
  "3. 纯文本原话：narration 中的每一句必须为主播口播台词原话，不得带运镜指示、动作提示或括号注释（如“（镜头拉近）”或“（微笑）”一律禁止）。",
].join("\n");

// V4 电商带货专属人设与变体规则
const SELL_PERSONA_RULES = [
  "【带货主播人设】：千万级商业短视频导演兼成交型主播，深谙用户心理，擅长制造转化。你的台词就是观众听到的原话，严禁输出任何创作说明指令。",
  "【变体类型】：从 A-痛点直击型、B-反差对比型、C-福利低价型、D-场景代入型、E-证言型、F-紧迫逼单型、G-结果先行型、H-情感共鸣型、I-权威专业型、J-反转型/避坑型、K-教程演示型、L-信任测评型、M-数字冲击型、N-保障安心型 中选 1 种最契合的填入 variant_type。",
  "【变体选择逻辑】：高客单/需背书优先 I/N；低价秒杀引流优先 C/F；数字量化优先 M；避坑干货优先 J；效果明显优先 B；家居/穿搭优先 D；教程/步骤一律 K；送礼/女性向一律 H；功能解决痛点才选 A。",
].join("\n");

// V4 本地探店专属人设与变体规则
const LOCAL_PERSONA_RULES = [
  "【同城探店人设】：深耕同城实体经济、懂得挖掘街头巷尾烟火气的本地导演。核心任务是为线下实体门店吸引同城顾客到店消费。语气真诚、实在、生活气息浓厚。",
  "【变体类型】：从 A-宝藏发现型、B-性价比种草型、C-环境氛围型、D-硬核测评型、E-避坑提醒型、F-限时活动型、G-信任背书型、H-高客单沉稳型 中选 1 种最契合的填入 variant_type。",
  "【探店选择逻辑】：高客单沉稳优先 H；老字号/熟客优先 G；平价实惠团购优先 B；环境拍照出片优先 C；限时活动优先 F；硬核用料优先 D；避雷提醒优先 E；小众新开优先 A。",
  "【绝对禁止电商网购与物流词汇】：严禁出现「现货直发、全国包邮、整箱发货、顺丰、拍下、下单、快递、小黄车、左下角」等任何电商词汇！必须引导同城顾客到店尝鲜与同城到店体验，提升收藏率与到店核销率。",
].join("\n");

// V4 宣发方案生成规则
const PUBLISH_RULES_CONTENT = [
  "【发布方案生成规范】：",
  "1. caption（发布正文）：给「刷到但还没看视频」的人的黄金吸睛钩子，严禁复述旁白台词（重复即扣分，信息互补），口语化、有网感，≤150字。结尾必须带 3-5 个垂直长尾话题标签（如 #打工人救星 #私藏宝藏好物）。",
  "2. cover_title（平台爆款封面标题）：10~25字，给抖音/小红书/视频号填写的引流大标题，直击痛点与利益点（如「打工人宵夜救星！2块钱一包的光友酸辣粉丝」）。必须必填，严禁输出空字符串 \"\"，与视频内主标题 title 互补互衬。",
  "3. pinned_comment（置顶评论）：高转化与互动钩子（≤50字），抛出让观众极有欲望站队、讨论的互动问句或客观到店指引。",
  "4. post_time（发布时机建议）：一句话黄金时段建议（如「晚间 19:30-21:30 黄金流量档」）。",
].join("\n");

const COMMERCE_REGEX = /(保暖|打底|衣服|裤|裙|鞋|包|手表|机械表|数码|手机|电脑|美妆|护肤|面霜|精华|防晒|口红|耳机|音响|水杯|保温杯|炒锅|收纳|零食|特产|材质|做工|尺码|面料|版型|修身|显瘦|加厚|防风|防水|透气|现货|性价比|包邮|秒杀|福利|活动价|特惠|买一赠|拍下|下单|到手价|正品|专柜|带货|同款|推荐买|值得入|神器|好物)/i;
const LOCAL_REGEX = /(老店|老字号|餐馆|火锅|烤鸭|烧烤|烤肉|咖啡|小酒馆|奶茶|甜品|门店|门头|档口|招牌菜|堂食|包间|人均|位置|同城|探店|打卡|免预约|地址|商圈|步行街|地铁站|营业时间|聚餐|约会|排队|环境好|到店|附近)/i;

/**
 * 智能识别文本中的商业实体属性（区分线上电商带货与同城探店）
 */
export type CreationScene = "online-ecommerce" | "physical-store" | "personal-creation";
/** 用户可见的创作入口；quick-cut 不走 LLM 导演场景路由。 */
export type CreationEntryScene = CreationScene | "quick-cut";

const SCENE_MARKER_RE = /^\[User-selected creation scene:\s*(?:online-ecommerce|physical-store|personal-creation|quick-cut)\.?\]\s*\n?/i;

/** 把前端明确选择的创作场景写成服务端可识别的提示词前缀（幂等，旧前缀会被替换）。 */
export function withCreationSceneMarker(prompt: string, scene?: CreationEntryScene): string {
  if (!scene || scene === "quick-cut") return prompt;
  return `[User-selected creation scene: ${scene}.]\n${prompt.replace(SCENE_MARKER_RE, "")}`;
}

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
  // 风格与变体完全交给 LLM，自主适配当前事实、受众与创作目标。
  const decidedVariant = null;
  return { creationScene, scene, isPersonal, decidedVariant, sceneSource: userSelected ? "user-selected" : "keyword-inferred" };
}

/**
 * 组装声音与音色指令
 */
function buildVoiceInstructions(prompt: string, creationScene: CreationScene): string[] {
  const userIntent = detectUserVoiceIntent(prompt) || {};
  const language = userIntent.isCantonese ? "yue" : userIntent.isEnglish ? "en" : "zh";
  const preferredTemperament = userIntent.explicitTemperament || (creationScene === "physical-store" ? "f-soft" : creationScene === "online-ecommerce" ? "f-bright" : "f-warm");
  const candidates = getAvailableTencentVoiceCandidates({ language, gender: userIntent.explicitGender || null, preferredTemperament });
  // 保持候选集展示，让大模型看到完整音色池；最终选择由 LLM 决定。
  const shuffled = [...candidates];
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
    lines.push(`[音色倾向]：用户表达了「${userIntent.explicitTemperament}」倾向；优先参考候选顺序，但仍由你结合场景、人设和内容决定最终音色。`);
  }

  lines.push("[真实腾讯 TTS 完整音色池清单]：以下均为腾讯官方真实 VoiceType，且健康状态明确为 healthy。必须严格从下方清单中挑选最契合本次文案人设与情绪的 voice_id，必须原样输出数字 ID（严禁别名、旧 ID 或自造 ID）：");
  if (!candidates.length) {
    lines.push("[无可用音色]：当前没有同时满足语言、性别与健康条件的腾讯音色。不得伪造 voice_id 或使用其他语言音色；必须返回无法满足配音条件。");
  } else {
    for (const gender of ["female", "male"]) {
      const group = shuffled.filter((item: { gender: string }) => item.gender === gender);
      if (group.length) {
        lines.push(`【${gender === "male" ? "男声音色库" : "女声音色库"}（共 ${group.length} 款）】：`);
        for (const item of group as Array<{ voiceType: number; label: string }>) {
          lines.push(`  - ID: ${item.voiceType} | 名称风格: ${item.label}`);
        }
      }
    }
  }
  lines.push("[导演音色决策]：必须结合当前场景、人设、旁白情绪与内容表达，从上方清单中挑选最契合的 voice_id；不得使用固定默认音色，不同任务根据内容主动变化。voice_id 必须是上方列出的数字 ID。");
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
  const personaRules = isPersonal
    ? "Personal creator direction: preserve authentic personal expression without forced commercial language."
    : scene === "local"
      ? "Local content direction: use the supplied facts and freely choose the most authentic current expression for the venue and audience."
      : "Commercial content direction: use the supplied facts and freely choose the freshest effective narrative, hook and voice for the audience.";
  const voiceBlock = buildVoiceInstructions(input.prompt, creationScene);

  const batchVersions = Math.max(1, Math.floor(input.batchVersions ?? 1));
  const planExample = {
    operation: "standard (默认) 或 video-slice (仅当用户明确要求截取高光切片时)",
    sliceSeconds: 20,
    title: "画面视觉主标题（4~6字最佳的凝练高奢短语，如「素履以往」「手作咖啡」「现烤蛋挞」，字数越少排版越大气高级，严禁冗长句子，严禁复制发布标题）",
    concept: "结合变体与口播人设的情绪创作阐述（20~100字）",
    note: "版式底部点睛说明行（6~16字，东方极简/品牌高奢短句，如「东方草本 匠心慢熬」「天然材质 触手生温」「寻味山野 一席清欢」，严禁句号，严禁写成英文水印套话如 JANSEE FILM，严禁复述旁白原文）",
    narration: "完整的中文口播旁白原话（40~120字，必须由对应素材数量的N句精炼台词组成，第一句必须为黄金3秒抓人钩子，去播音腔，绝不复述用户制作指令）；台词写多长成片就多长，时长由TTS实测决定，不要输出任何时长字段",
    scenes: [
      { order: 1, description: "第1个镜头的视觉焦点安排", motion: "sweep_lr" },
      { order: 2, description: "第2个镜头的视觉焦点安排", motion: "rise_up" },
    ],
    style: "简兮商业视觉流（叠化0.7s转场，人声音量0.10/0.22避让）",
    soundtrack: "匹配内容调性与情绪的 BGM 说明",
    voice_id: "真实腾讯 TTS VoiceType 数字 ID（例如 403010、402001、404000、402000）",
    speech_speed: 1.0,
    bgm_emotion: "从情绪池选 1 个",
    variant_type: isPersonal ? "personal-creation" : "由导演根据当前事实与受众自主判断，不使用固定变体池",
    packaging: { intro: true, subtitles: true, bgm: true },
    publish: {
      caption: "发布正文文案（≤150字，不复述旁白台词，文末带 3-5 个垂直长尾话题标签，如 #打工人救星 #私藏宝藏好物）",
      cover_title: "平台爆款引流标题（必填，10~25字，用于抖音/小红书封面与发布，直击痛点，如「打工人宵夜救星！2块钱一包的光友酸辣粉丝」，严禁为空）",
      pinned_comment: "高转化置顶互动评论（≤50字，抛出互动问题或客观指引，拉升评论区停留互动）",
      post_time: "黄金发布时段建议（一句话，如「晚间 19:30-21:30 黄金流量档」）",
    },
  };
  const contractSections = batchVersions > 1
    ? [
        `仅输出一个合法纯 JSON 对象，严禁 Markdown 代码块包裹（禁 \`\`\`json），严禁前后缀解释。本次为批量赛马规划：顶层必须是 { "versions": [ ... ] }，versions 数组恰好包含 ${batchVersions} 个方案对象（数组顺序即版本顺序），每个对象字段与下方模板一致：`,
        `批内差异化铁律（最高优先级）：${batchVersions} 个版本必须彼此明显不同——① variant_type 互不相同；② voice_id 严禁任何两版重复（每版从候选集中为该版单独挑选最契合的音色，性别与气质都要拉开）；③ bgm_emotion 尽量不重复；④ 台词的切入角度、开场钩子与情绪基调逐版拉开，让用户一眼听出是不同的成片。每个版本都独立满足全部创作规则（分镜数与素材数对齐、黄金3秒钩子、JSON 字段完整）。`,
        JSON.stringify({ versions: [planExample, `……（共 ${batchVersions} 个版本对象，每个都是完整方案，字段与上方模板一致）`] }, null, 2),
      ]
    : [
        "仅输出一个合法纯 JSON 对象，严禁 Markdown 代码块包裹（禁 ```json），严禁前后缀解释。字段列表：",
        JSON.stringify(planExample, null, 2),
      ];

  const sections: string[] = [
    `Director route: ${creationScene}. Constitution Director owns global rules; persona directors operate within its boundaries.`,
    "===== 简兮 AI 导演 · 全局宪法核心视听铁律 (Constitution Core) =====",
    input.mode === "image-film"
      ? "1. 图片与分镜对齐律：输入 N 张图片素材，规划 N 个分镜镜头，按视觉叙事顺序编排；全局 narration 旁白必须由 N 句精炼台词组成（每句用标点隔开，严格对应第 1 到第 N 个分镜镜头），每句台词经 TTS 实测后的真实时长决定对应图片的画面展示时长；"
      : input.mode === "video-dub"
        ? "1. 视频配音时长与字数对齐律：视频画面有其原生真实时长，成片总时长由源视频决定，视频绝不会变长；全局 narration 旁白必须根据视频实际秒数严格控制字数（口播净语速约 2.8~3.2 字/秒，扣除开头与片尾各约 1.2 秒留白），确保在视频结束前从容念完并收声，严禁字数超标导致台词没说完视频就结束；"
        : "1. 多视频分镜对齐律：输入 N 个视频素材，规划 N 个分镜镜头；全局 narration 旁白按顺序严格对应各分镜视觉焦点，每句台词经 TTS 实测后决定该镜头的剪辑呼吸；",
    "2. 真实性绝对红线：只提炼用户明确给出的客观事实，严禁编造参数、价格、功效或权威背书；严禁出现「左下角」「小黄车」「点击链接」等虚构导流；",
    "3. 视听高级感铁律：死守无损物理安全区与 0 Emoji 规范；标题极简克制，副标留白点睛，正文旁白自然松弛。",
    CONSTITUTION_RULES,
    input.mode === "storyboard" ? STORYBOARD_CORE_RULES : "",
    creationScene === "personal-creation" ? "[ROUTE] Personal creator path: Constitution Director directs knowledge, lifestyle, personal expression or personal IP. Do not use commercial variants." : "",
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
    "===== 成片旁白与分镜节奏编排规范 =====",
    ...(input.mode === "video-dub"
      ? [
          "1. 视频配音模式说明：本任务为单段已有视频配音，画面原生时长是固定的。narration 是全片主播口播台词，由 2~4 句精炼台词组成（由句号、感叹号或问号隔开）；",
          "2. 台词体量与时长严格契合：按自然净语速约 3 字/秒，台词总字数必须严格受控在视频时长对应的字数限额内，确保全片在画面结束前 1.5 秒从容收尾，切禁过长；",
          "3. scenes 数组输出 1 个主体镜头描述（order: 1, description: 针对全片核心画面的视觉呈现总结，motion: sweep_lr）。",
        ]
      : [
          "1. narration 字段是全片口播配音的唯一样本。如果用户输入提供了 N 个素材，narration 必须恰好由 N 句精炼台词组成，每句用标点符号（句号、感叹号或问号）清晰隔开；",
          "2. 每一句台词按顺序严格对应第 1 到第 N 个分镜素材，执行层会将每句话与对应分镜无缝绑定；",
          "3. 严禁单句长难句跨越多个分镜镜头，必须确保每一句话在当前镜头内语意完整、富有呼吸节奏；",
          "4. scenes 数组的长度必须为 N（与素材数量一致），order 从 1 到 N，description 为该分镜镜头的视觉焦点安排（只描述画面看点，不要写运镜动作）。",
          "5. 运镜编排铁律：每个 scene 必须额外输出 motion 字段，且只能从下面这份【引擎支持的运镜 ID 清单】里选一个原样填入，严禁自造运镜词、严禁输出清单外的任何值：",
          "   - sweep_lr：镜头横向平移，从左向右缓缓扫过（适合横向铺陈、多主体依次呈现）",
          "   - sweep_rl：镜头横向平移，从右向左缓缓扫过（适合横向铺陈、反向节奏）",
          "   - rise_up：镜头缓缓向上抬升（适合突出高度、纵深感、主体登场）",
          "   - diagonal：镜头斜向平移（适合增加动感、打破呆板构图）",
          "   运镜要服务于该镜内容：按情绪和画面看点为每个镜头编排，相邻镜头尽量不重复同一种运镜；motion 只填上面 4 个 ID 之一（如 \"motion\": \"rise_up\"），不要写中文描述。",
        ]),
    "   - diagonal：镜头斜向平移（适合增加动感、打破呆板构图）",
    "   运镜要服务于该镜内容：按情绪和画面看点为每个镜头编排，相邻镜头尽量不重复同一种运镜；motion 只填上面 4 个 ID 之一（如 \"motion\": \"rise_up\"），不要写中文描述。",
    "",
    "===== 场景人设与变体规则 =====",
    personaRules,
    "",
    "===== 声音与视听节奏规范 =====",
    ...voiceBlock,
    `[背景音乐 BGM 情绪池]（从下列合法项选 1 个填入 bgm_emotion）：${CANDIDATE_EMOTIONS.join(" / ")}`,
    "视听铁律：1.相邻分镜叠画转场0.7s（禁跳切）；2.两段式音量避让：口播段BGM=0.10，纯画面段BGM=0.22；3.packaging 只需给 intro/subtitles/bgm（合规片尾由系统固定生成，无需你决定，也不要输出 ending 字段）；4.operation: standard（默认口播成片）/ video-slice（视频高光切片）。除非用户在文案中明确指示「保留原声/不配音」，否则严禁输出 keep-original。",
    "",
    "===== 发布方案规则 =====",
    "publish四项全必填：caption(正文+3-5个精准长尾话题标签)、cover_title(10-25字爆款引流标题，严禁留空或填空字符串，必须吸睛)、pinned_comment(互动引流或置顶问句)、post_time(建议发布时段)。严禁过时年份与虚构物流。",
    "",
    "===== 统一 JSON 输出格式契约 (Strict JSON Only) =====",
    ...contractSections,
  ];

  return sections.filter((s) => typeof s === "string" && s.trim().length > 0).join("\n");
}

/**
 * 组装动态 User Prompt
 */
export function buildDirectorUserPrompt(input: DirectorPlanResolvedInput): string {
  const assetCount = input.assets.length;
  const isVideoDub = input.mode === "video-dub";
  const videoDurationSec = isVideoDub && typeof input.assets[0]?.durationSec === "number" && input.assets[0].durationSec > 0
    ? Math.round(input.assets[0].durationSec)
    : null;

  const promptInstructions: string[] = [
    "请作为专业导演，提炼用户文案中的客观事实，匹配最精准的变体与主播人设，输出可直接交付并可执行的完整成片方案与发布四件套。",
  ];

  if (isVideoDub) {
    if (videoDurationSec) {
      // 中文自然口播语速约为 3.0~3.3 字/秒，且必须为片头留出约 1 秒淡入、为片尾留出约 1.5 秒收束空间。
      // 可用口播净时长 = Math.max(3, videoDurationSec - 2.5) 秒
      const voiceTimeSec = Math.max(3, videoDurationSec - 2.5);
      const minChars = Math.max(15, Math.round(voiceTimeSec * 2.5));
      const maxChars = Math.max(minChars + 10, Math.round(voiceTimeSec * 3.1));
      promptInstructions.push(
        `【视频配音专属时长铁律】：当前用户提供了一段实拍视频，视频真实时长恰好为 ${videoDurationSec} 秒。`,
        `【字数绝对上限】：成片视频总长不会变长。为了保证台词能在视频结束前从容念完并留出片尾余韵，全局 narration 口播台词总字数必须严格控制在 ${minChars}~${maxChars} 字以内（严禁超过 ${maxChars} 字，否则台词没念完视频画面就会结束）！`,
        `请为全片规划自然流畅、有呼吸感且字数适中的精炼口播解说，分成 2~4 句简练台词（由句号、感叹号或问号隔开），节奏紧凑，精准贴合 ${videoDurationSec} 秒画面节奏。`,
        "台词需包含抓人的黄金3秒钩子、核心看点/卖点阐述与收尾行动引导，去播音腔，字字珠玑，绝不臃肿赘述！",
      );
    } else {
      promptInstructions.push(
        "【视频配音专属指令】：当前用户提供了一段实拍视频进行配音。请为整段视频创作完整精炼、有起承转合的口播旁白，分句输出（用标点清晰隔开），字数严格控制在 35~60 字以内，避免台词过长超出视频画面。",
      );
    }
  } else {
    promptInstructions.push(
      `分镜与台词精准对齐：本次任务共有 ${assetCount} 个实拍素材。请规划恰好 ${assetCount} 个分镜镜头（scenes 数组长度为 ${assetCount}，order 为 1 到 ${assetCount}）；全局 narration 旁白必须恰好由 ${assetCount} 句口播台词组成（用标点隔开），按顺序严格对应每个分镜镜头，严禁跨镜头长句。`,
    );
  }

  promptInstructions.push(
    "切记：第一句台词必须是抓人的黄金3秒钩子，去播音腔，不要编造用户未提及的任何数据或事实！",
    "标题与说明行规范：title 必须为 4~6 字片头画面主标题（不可写成引流长句）；note 为 6~16 字调性说明行（不可复述旁白，不可写套话，不可留空）；publish.cover_title 必须且必填 10~25 字平台爆款引流标题（用于抖音/小红书封面，严禁为空字符串）。",
  );

  return JSON.stringify({
    creationGoal: input.prompt,
    assetCount,
    promptInstructions,
  }, null, 2);
}
