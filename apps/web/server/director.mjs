// 简兮 · LLM 大导演 (Director Cut)
// 架构定版（2026-10-12，用户拍板最高优先级）：LLM 是真正的大导演，全权编排成片；
// 程序只做特效执行器 + 兜底校验（非法值静默回退，绝不约束创作、绝不中断出片）。
// 通道定版：卖点台词与逐镜编排同一次 LLM 调用输出（语义最完整）。
// 失败兜底：LLM 任何异常 → 抛错，由 engineBridge 回落程序兜底剧本（mocker），保证出片永不中断。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recentCreative } from './creativeLedger.mjs';
import {
  decideVariantLocal,
  SELL_VARIANT_TYPES,
  LOCAL_VARIANT_TYPES
} from './prompt/index.js';
import { TEMPERAMENTS, isTemperament, detectUserVoiceIntent, CANTONESE_DIALECT, ENGLISH_VOICES } from '@jansee/tts-kit';
import { sanitizePublish } from '@jansee/publish-kit';
import { endingsForScene } from '@jansee/ending-kit';
import { LAYOUTS } from '@jansee/visual-engine-v4/layouts';
import {
  getAnchor,
  getDna,
  isCompat,
  rankAnchors,
  compatAnchors,
  SELL_VARIANTS,
  LOCAL_VARIANTS,
  HOST_LIBRARY,
  ANCHOR_REDLINE_MD,
  LOCAL_ROLES,
  LOCAL_ROLE_COMPAT,
  getLocalRole,
} from '@jansee/anchor-kit';


const API_URL = 'https://api.siliconflow.cn/v1/chat/completions';
// 导演 LLM 四级降级链（2026-10-18 用户定版，模型 ID 以硅基控制台为准，可用 .env 覆盖）：
//   一层 GLM-5.3-Flash      速度优先，正常请求快路径
//   二层 DeepSeek-V4.1-Flash 快速互备（关闭思考链，保证出片时长）
//   三层 DeepSeek-V3 Pro    质量兜底，旗舰智力基座
//   四层 Qwen2.5-14B-Instruct 最终低成本兜底；仍失败则由 mocker 剧本接管（出片永不中断）
export const PRIMARY_MODEL = process.env.SILICONFLOW_DIRECTOR_MODEL || 'zai-org/GLM-5.3-Flash';
export const SECONDARY_MODEL = process.env.SILICONFLOW_DIRECTOR_SECONDARY_MODEL || 'deepseek-ai/DeepSeek-V4.1-Flash';
export const TERTIARY_MODEL = process.env.SILICONFLOW_DIRECTOR_FALLBACK_MODEL || 'Pro/deepseek-ai/DeepSeek-V3';
export const QUATERNARY_MODEL = process.env.SILICONFLOW_DIRECTOR_QUATERNARY_MODEL || 'Qwen/Qwen2.5-14B-Instruct';

const llmUsable = () =>
  !['1', 'true', 'yes'].includes(String(process.env.JIANXI_MOCK || '').toLowerCase()) &&
  String(process.env.SILICONFLOW_API_KEY || '').trim().length >= 8;

// BGM 情绪池（materials/audio 情绪目录名，非法情绪由引擎选曲层自动兜底）
const BGM_EMOTIONS = ['luxury', 'warm', 'calm_narrative', 'relaxed', 'tech_future', 'fresh', 'inspirational', 'passionate', 'romantic', 'nostalgic', 'epic', 'playful', 'corporate', 'cozy', 'energetic', 'dreamy', 'generic'];

/**
 * 收束旁白合规擦除：命中联络方式（电话长数字 / 微信号）即整条作废返回空串。
 * end_line 会被 TTS 念出来——宁可没有收束，不能念出用户没给过的联系方式。
 * 宪法层已禁止编造，这里是包边界双保险；整条作废而非局部擦除，
 * 不留「加 领券」这种擦掉一半的碎话（残句比没有更劣）。
 */
function scrubContactInfo(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (/\d{7,}/.test(s)) return '';
  if (/[微Vv]\s*[信x]\s*[号h]?\s*[:：]?\s*[A-Za-z0-9_-]{4,}/.test(s)) return '';
  return s;
}

// ==================== 导演提示词（单一真相源：prompt/*.md，运行时读取） ====================
// constitution.md = 宪法导演（全局铁律 + 统一 JSON 契约）；director-sell/local.md = 人设导演（sell/local 整份注入，personal 无）。
// 变体强信号判定（engineBridge decideVariantLocal，规则与 md 选择逻辑同源）为第一权威；未命中交 LLM 按 md 选择逻辑兜底。
const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompt');
const CONSTITUTION_MD = readFileSync(path.join(PROMPT_DIR, 'constitution.md'), 'utf8');
const SELL_PERSONA_MD = readFileSync(path.join(PROMPT_DIR, 'director-sell.md'), 'utf8');
const LOCAL_PERSONA_MD = readFileSync(path.join(PROMPT_DIR, 'director-local.md'), 'utf8');
const STORYBOARD_DIRECTOR_MD = readFileSync(path.join(PROMPT_DIR, 'storyboard-director.md'), 'utf8');
// 发布方案规则（2026-10-24 提为独立 prompt 资产：宪法引用、三链路按需各取同一份；
// 规则文本的单一真相源在 md，代码只 readFileSync 消费，不内联定义）
const PUBLISH_RULES_MD = readFileSync(path.join(PROMPT_DIR, 'publish-rules.md'), 'utf8');

// ==================== 导演提示词组装 ====================
// 三段式架构（用户定版）：宪法导演（md 全文 + 素材基座）→ 人设导演（sell/local md 整份注入，personal 无）→ 特效菜单 + 变体判定态。
// JSON 输出契约唯一存在于 constitution.md，本函数不再重复定义（防止双真相源漂移）。
// 创作防重上下文（creativeLedger 跨任务账本 → LLM）：连续出片时把最近成片已用的
// 开场/结尾/视觉排版/BGM 情绪喂给导演，提示刻意差异化——只提示不强制，不约束创作自由。
function antiRepeatBlock() {
  const recent = recentCreative(5);
  if (!recent.length) return [];
  const lines = recent.map((r, i) => {
    const variant = r.variant_type ? `变体 ${r.variant_type}` : '无变体';
    const bgm = r.bgm_emotion ? `BGM情绪 ${r.bgm_emotion}` : '';
    return `${i + 1}. ${variant}${bgm ? ' / ' + bgm : ''}`;
  });
  const recentBgms = [...new Set(recent.map((r) => r.bgm_emotion).filter(Boolean))];
  const bgmNote = recentBgms.length ? `已用 BGM 情绪【${recentBgms.join(' / ')}】近期请主动避让，优先探索其他契合情绪；` : '';
  return [
    '===== 创作差异化上下文（最近成片已用基调，本次请优先给出有新意的变体或情绪） =====',
    ...lines,
    `（仅为参考提示，不限制创作：若某变体与本片内容气质天然契合也可沿用；${bgmNote}请优先考虑呈现新鲜感与视听差异。）`,
    '',
  ];
}

// ==================== 场景意图智能识别与自动纠偏引擎 ====================
const COMMERCE_REGEX = /(保暖|打底|衣服|裤|裙|鞋|包|手表|机械表|数码|手机|电脑|美妆|护肤|面霜|精华|防晒|口红|耳机|音响|水杯|保温杯|炒锅|收纳|零食|特产|材质|做工|尺码|面料|版型|修身|显瘦|加厚|防风|防水|透气|现货|性价比|包邮|秒杀|福利|活动价|特惠|买一赠|拍下|下单|到手价|正品|专柜|带货|同款|推荐买|值得入|神器|好物)/i;
const LOCAL_REGEX = /(老店|老字号|餐馆|火锅|烤鸭|烧烤|烤肉|咖啡|小酒馆|奶茶|甜品|门店|门头|档口|招牌菜|堂食|包间|人均|位置|同城|探店|打卡|免预约|地址|商圈|步行街|地铁站|营业时间|聚餐|约会|排队|环境好)/i;

/**
 * 智能识别文本中的商业实体属性并纠偏场景选择
 * @param {string} text 用户输入的标题或卖点文案
 * @param {string} clientScene 客户端传入的场景标签 ('sell' | 'local' | 'personal')
 * @returns {{ effectiveScene: string, isOverridden: boolean, detectedSceneZh: string, reason: string }}
 */
export function detectSceneIntent(text = '', clientScene = 'sell') {
  if (!text || typeof text !== 'string') {
    return { effectiveScene: clientScene, isOverridden: false, detectedSceneZh: '', reason: '' };
  }
  const clean = text.trim();
  const hasCommerce = COMMERCE_REGEX.test(clean);
  const hasLocal = LOCAL_REGEX.test(clean);

  // 1. 用户选了 personal，但实际写了具体商品卖点（杜绝儿童保暖裤被做成文艺散文诗）
  if (clientScene === 'personal' && hasCommerce && !clean.includes('个人感悟') && !clean.includes('生活随笔')) {
    const matched = clean.match(COMMERCE_REGEX)?.[0] || '商品实物';
    return {
      effectiveScene: 'sell',
      isOverridden: true,
      detectedSceneZh: '线上电商商品带货',
      reason: `用户文案中包含强烈商品带货实体属性（命中关键词: "${matched}"），智能纠偏为人设完备的电商带货场景`
    };
  }

  // 2. 用户选了 sell，但实际写了同城餐饮或门店探店信息
  if (clientScene === 'sell' && hasLocal && (clean.includes('到店') || clean.includes('同城') || clean.includes('人均') || clean.includes('老店') || clean.includes('打卡'))) {
    const matched = clean.match(LOCAL_REGEX)?.[0] || '门店实体';
    return {
      effectiveScene: 'local',
      isOverridden: true,
      detectedSceneZh: '线下门店同城探店',
      reason: `用户文案中包含显著线下门店/同城探店属性（命中关键词: "${matched}"），智能纠偏为同城探店场景`
    };
  }

  return { effectiveScene: clientScene, isOverridden: false, detectedSceneZh: '', reason: '' };
}

function getPersonaMd(scene, decidedVariant) {
  if (scene === 'personal') return '';
  const fullMd = scene === 'local' ? LOCAL_PERSONA_MD : SELL_PERSONA_MD;
  if (!decidedVariant) return fullMd;

  // 变体已被强信号锁定时，彻底剔除全量变体类型表与长篇判定逻辑，只保留核心人设与台词红线
  return fullMd.replace(
    /## 变体类型[\s\S]*?(?=## 销售强度|## 配音性别|## 任务与台词红线)/,
    `## 变体类型（已由系统强信号锁定为「${decidedVariant}」，本片请严格以此风格创作，无需再重新判断）\n\n`
  );
}

// ==================== 主播风格层注入块（anchorContext 非 null 时才注入，缺省零回归） ====================
// 形态由调用方（creation.mjs / generateDirectorCut）排班决定：
//   lockedAnchor 有值  → 变体已被强信号锁定，程序按兼容集+黑名单+seed 预抽，LLM 不得改选；
//   否则              → 注入全池（黑名单物理剔除）+ DNA 细则 + 兼容表，LLM 判完变体后自选 anchor_id，
//                       sanitize 层兜底校验（乱给回退兼容首名）。
// 语速指引随块注入：speech_speed 全片档位 0.85~1.25（宪法契约已加字段，这里给风格化量程）。
function buildAnchorBlock(anchorContext, scene) {
  if (scene === 'personal') return [];

  /* 线下实体场景：彻底切断带货主播，注入 4 大实体角色体系 */
  if (scene === 'local') {
    const roleLines = LOCAL_ROLES.map((r, i) => `${i + 1}. ${r.id}（${r.label}）· 调性：${r.name} · 推荐音色：${r.temperaments.join(' / ')}`);
    const compatLines = Object.entries(LOCAL_ROLE_COMPAT).map(([v, roles]) => `${v}：${roles.join(' / ')}`);
    const roleDnaBlocks = LOCAL_ROLES.map((r) => r.md);

    return [
      '===== 实体角色风格层（线下实体专属表达人格，严禁任何电商带货腔） =====',
      '本片可选实体角色池（彻底禁止任何电商直播叫卖或喧闹催单，根据门店调性从下列 4 种实体角色中选 1 种）：',
      ...roleLines,
      '',
      '【实体角色 DNA 细则】（逐条遵守你选定角色的台词写法）：',
      ...roleDnaBlocks,
      '',
      '【变体-实体角色兼容表】：',
      ...compatLines,
      '',
      '【选定规则】按人设导演判定 variant_type 后，从兼容的实体角色中选 1 个，将其 id 填入 anchor_id 字段（可选：shopowner、local-friend、craftsman、budget-guide）。',
      '【线下实体绝对红线】：严禁在台词或文案中出现「现货直发 / 全国包邮 / 整箱囤货 / 拍下 / 下单 / 快递 / 顺丰」等任何电商词汇！无论素材是什么，必须写出同城烟火气，引导同城顾客到店尝鲜与线下体验。',
      '',
    ].filter(Boolean);
  }

  if (!anchorContext || !Array.isArray(anchorContext.ranked) || !anchorContext.ranked.length) return [];
  const variantList = SELL_VARIANTS;
  const rankedIds = anchorContext.ranked.map((a) => (typeof a === 'string' ? a : a.id));
  const rankedSet = new Set(rankedIds);
  const label = (a) => {
    const h = typeof a === 'string' ? getAnchor(a) : getAnchor(a.id);
    return h ? `${h.id}（锚点：${h.name}）` : String(typeof a === 'string' ? a : a.id);
  };

  /* 锁定模式：程序已定主播，只注入该主播的 DNA 细则 */
  const lockedId = anchorContext.lockedAnchor ? (anchorContext.lockedAnchor.id || anchorContext.lockedAnchor) : '';
  const locked = lockedId ? getAnchor(lockedId) : null;

  if (locked) {
    const dna = getDna(locked.dna);
    return [
      '===== 主播风格层（本片台词的表达人格，已由系统排班锁定） =====',
      `本片主播锁定：${locked.id}（锚点：${locked.name}）· 风格 DNA：${dna?.label || locked.dna}`,
      'anchor_id 字段必须输出「' + locked.id + '」，不得改选。',
      dna ? `台词风格细则（逐条遵守）：\n${dna.md}` : '',
      `推荐音色气质（voice_id 优先从这里选，商品调性明显不符才可改选）：${locked.temperaments.join(' / ')}`,
      ANCHOR_REDLINE_MD,
      '',
    ].filter(Boolean);
  }

  /* 自选模式：全池 + DNA 细则 + 兼容表，LLM 判完变体后自选 */
  const poolLines = rankedIds.map((id, i) => {
    const h = getAnchor(id);
    if (!h) return null;
    const dna = getDna(h.dna);
    return `${i + 1}. ${h.id}（锚点：${h.name}）· 风格：${dna?.label || h.dna} · 推荐音色气质：${h.temperaments.join(' / ')}`;
  }).filter(Boolean);

  const compatLines = variantList
    .map((v) => {
      const inPool = compatAnchors(v).filter((id) => rankedSet.has(id));
      return inPool.length ? `${v}：${inPool.join(' / ')}` : null;
    })
    .filter(Boolean);

  const dnaBlocks = [...new Set(rankedIds.map((id) => getAnchor(id)?.dna).filter(Boolean))]
    .map((dnaId) => {
      const dna = getDna(dnaId);
      return dna ? `【${dna.label}】\n${dna.md}` : null;
    })
    .filter(Boolean);

  return [
    '===== 主播风格层（本片台词的表达人格） =====',
    '本片主播池（系统已按排班剔除近期使用过的主播，推荐顺序即下列顺序）：',
    ...poolLines,
    anchorContext.reservedId ? `【排班优先主播】本次排班推荐使用 ${anchorContext.reservedId}；若你判定的 variant_type 与其兼容，anchor_id 必须选它；明显不契合商品调性时才从兼容集中另选。` : '',
    '',
    '【风格 DNA 细则】（每个主播锚点对应一种台词写法，只需遵守你选定主播对应的那一段）：',
    ...dnaBlocks,
    '',
    '【变体-主播兼容表】：',
    ...compatLines,
    '',
    '【选定规则】先按人设导演判定 variant_type，再从该变体的兼容主播中按推荐顺序选 1 个，把 id 填入 anchor_id；第一名与商品调性明显不契合时才可选后续名次。',
    ANCHOR_REDLINE_MD,
    '',
  ].filter(Boolean);
}

export function buildDirectorPrompt({ scene, title, sellingPoints, imageCount, voice, decidedVariant, videoMeta, variantAngle = '', variantIndex = 0, variantTotal = 0, anchorContext = null }) {
  const combinedContextText = `${title || ''} ${sellingPoints || ''}`.trim();
  const sceneIntent = detectSceneIntent(combinedContextText, scene);
  const effectiveScene = sceneIntent.effectiveScene;
  const isLocal = effectiveScene === 'local';
  const isPersonal = effectiveScene === 'personal';
  const personaMd = getPersonaMd(effectiveScene, decidedVariant);
  const subjectLabel = isPersonal ? '分享主题' : isLocal ? '门店' : '产品';
  const descLabel = isPersonal ? '内容描述' : isLocal ? '门店描述' : '产品描述';

  // 文本插槽需求已并入宪法 JSON 契约（line / side_typo / site；sub_theme 已随 V2 拆除），
  // 不再需要"第几镜放高潮位"这类程序预规划——旧 planShotSlots 随中缝题字一并下线。


  let videoBudget = null;
  if (videoMeta?.durationSec) {
    const dur = +Number(videoMeta.durationSec).toFixed(1);
    const availSec = Math.max(3, dur - 1.8);
    const minChars = Math.max(8, Math.floor(availSec * 2.5));
    const maxChars = Math.max(16, Math.floor(availSec * 3.4));
    const targetSentences = dur <= 8 ? '1~2' : dur <= 16 ? '2~3' : dur <= 25 ? '3~4' : '4~6';
    videoBudget = { dur, availSec, minChars, maxChars, targetSentences };
  }

  const userIntent = detectUserVoiceIntent(sellingPoints);
  const effectiveGender = userIntent.explicitGender || (voice === 'male' || voice === 'female' ? voice : null);

  // 组装方言与声音指令
  const voiceInstructions = [];
  if (effectiveGender) {
    voiceInstructions.push(`[配音性别]：用户明确指定 = ${effectiveGender === 'male' ? '男声' : '女声'}（最高铁律：voice_gender 必须严格输出 ${effectiveGender}，绝对禁止改判！）`);
  } else {
    voiceInstructions.push('[配音性别]：用户未指定性别，由你依据商品调性与变体类型自主判定输出 male 或 female');
  }

  if (userIntent.isCantonese) {
    voiceInstructions.push(`[方言配音最高铁律]：用户文案中明确指定了【${CANTONESE_DIALECT.name}】！台词${CANTONESE_DIALECT.stylePrompt}；voice_id 必须输出 "${CANTONESE_DIALECT.voiceId}"，voice_gender 必须输出 "${CANTONESE_DIALECT.gender}"。`);
  } else if (userIntent.isEnglish) {
    const chosenEn = userIntent.englishVoice || (effectiveGender === 'male' ? ENGLISH_VOICES.male : ENGLISH_VOICES.female);
    voiceInstructions.push(`[英文配音最高铁律]：用户文案中明确指定了【英文/外语配音】！所有口播台词（line 与 end_line）${ENGLISH_VOICES.stylePrompt}；开场花字 intro_title 与副标 intro_en 也必须为英文（如 SPECIAL OFFER / PREMIUM CRAFT）；voice_id 必须输出 "${chosenEn.voiceId}"，voice_gender 必须输出 "${chosenEn.gender}"。`);
  } else if (userIntent.explicitTemperament) {
    voiceInstructions.push(`[音色气质指定]：用户文案中明确要求了【${TEMPERAMENTS[userIntent.explicitTemperament]?.label || userIntent.explicitTemperament}】气质，voice_id 请优先输出 "${userIntent.explicitTemperament}"。`);
  }

  voiceInstructions.push('[配音音色池（腾讯云大模型音色，从以下合法 Key 中选 1 个填入 voice_id，不可自造）：]');
  for (const [k, v] of Object.entries(TEMPERAMENTS)) {
    if (!effectiveGender || v.gender === effectiveGender) {
      voiceInstructions.push(`  * ${k}: ${v.label}（${v.gender === 'male' ? '男' : '女'}）`);
    }
  }
  if (userIntent.isCantonese) {
    voiceInstructions.push(`  * ${CANTONESE_DIALECT.voiceId}: 云佳妍·粤语女声（腾讯超自然大模型2.0）`);
  } else if (userIntent.isEnglish) {
    voiceInstructions.push(`  * english-female: 云晓芙·英文女声（腾讯超自然中英大模型）`);
    voiceInstructions.push(`  * english-male: 云大围·英文男声（腾讯超自然中英大模型）`);
  }

  return [
    CONSTITUTION_MD,
    '',
    '===== 本次创作素材（程序按宪法预填的客观事实） =====',
    videoMeta
      ? `- 素材：用户上传实拍视频 × 1（单条连续视频，程序实测真实时长 ${videoBudget?.dur || videoMeta.durationSec} 秒）。`
      : `- 素材：用户上传实拍图 × ${imageCount}（编号 1..${imageCount}），全部为静态图片。`,
    `- ${subjectLabel}：${title || '（未命名）'}`,
    `- ${descLabel}/用户文案：${sellingPoints || '（未提供，请结合图片合理创作）'}`,
    ...voiceInstructions,
    `[BGM 情绪]（选 1 个，也可 bgm_on=false 不要配乐）：${BGM_EMOTIONS.join(' / ')}`,
    ...(videoMeta && videoBudget
      ? [
        '===== 视频场景声音与情绪总导演规则（源视频物理时长恒定为 ' + videoBudget.dur + ' 秒） =====',
        '1. 【画面事实与物理时间铁律】：素材是一条已拍好的连续实拍视频（物理总时长严格为 ' + videoBudget.dur + ' 秒），画面不可增减或加速，必须由你的台词完美贴合画面节奏。',
        '2. 【全片字数绝对算力预算（最高硬约束）】：为保证台词在画面结束前 1.5 秒干净说完、留出纯画面与音乐呼吸、绝对不在黑幕中念台词，全片全部口播台词（shots 数组各句 line 与 end_line 之字数总和）必须严格控制在 ' + videoBudget.minChars + ' ~ ' + videoBudget.maxChars + ' 字以内！绝对禁止超出 ' + videoBudget.maxChars + ' 字（字数写多会导致台词被底层截断或视频黑幕，属严重事故）！',
        '3. 【句数与呼吸节奏】：由你规划 ' + videoBudget.targetSentences + ' 句台词（shots 数组元素数量），每句 8~14 字精炼生动；句间停顿 pause_after 填 0.3~0.8s，让台词自然舒展分布在视频中。',
        '4. 【情绪通感与创意扩写（核心哲学）】：深入感受用户输入的文字内涵与情绪脉搏，把用户文字作为创意种子，写出契合画面意境的生动饱满台词。',
        '5. 【声学气质自主匹配】：若用户未锁死音色与性别，由你自主决定最契合情绪的音色（voice_id，沉稳治愈选 m-calm/f-warm，欢快热情选 m-energy/f-lively）与语速倍率（speech_speed，0.85~1.15）。',
        '6. 【结尾口播与片尾收束卡】：输出 end_line（口头收束，计入总字数预算，≤15字；个人创作场景若追求余韵可填空字符串）。同时从当前场景 5 款片尾卡中挑选最契合本片意境的 1 款填入 ending_id。',
        '7. 【开场视觉花字定制】：输出 intro_title（4~8字极具吸引力的大标题）、intro_en（大写英文副标或品牌名，如 JANSEE STUDIO）、intro_note（8~14字电影级留白态度短句，如“留一席留白 · 慢下来品味生活”）、intro_idx（场次编号，如 NO. 01 / CINEMATIC DUB）。',
        '',
      ]
      : [
        '===== 视听总导演放权规则（仅图片成片场景，由你全面执导视听与美学） =====',
        '1. 【版式美学策展（layout_id）】：从以下 5 套定稿高奢版面中选 1 个最契合的填入 layout_id：',
        '   * layout_t1: T1 时装编辑（大字左对齐+大留白，极适合时尚穿搭、香氛美妆、轻奢饰品、精致格调）',
        '   * layout_t2: T2 瑞士极简（贴顶绝对网格、超克制线条，极适合数码 3C、工业设计、建筑家居、前沿科技）',
        '   * layout_t3: T3 画册图录（居中双线夹标题、图鉴小字，极适合珍馐美食、手作器物、非遗文创、名茶佳酿）',
        '   * layout_t4: T4 电影片头（极宽字距、叙事光影，极适合户外旅行、汽车自驾、宏大场景、情感大片）',
        '   * layout_t5: T5 东方竖排（右列竖排书法、书脊细线，极适合国风新中式、老字号老店、传统手艺、文人雅趣）',
        '   * 【版式与字数联动】：选 T1/T3/T5 时，主标题（title）请凝练为 4~6 字高级短语或四字成语；选 T2/T4 支持 6~10 字。',
        '2. 【字体配对美学（pairing_id）】：在所选版式支持的字体中自选 1 款：',
        '   * layout_t1 兼容：modern-editorial（时装大牌）/ classic-serif（经典宋体）/ gallery-catalog（艺术图录）/ literary-light（轻文艺）/ playful-round（童趣圆体）',
        '   * layout_t2 兼容：swiss-grid（瑞士网格）/ modern-editorial（时装大牌）',
        '   * layout_t3 兼容：gallery-catalog（艺术图录）/ classic-serif（经典宋体）/ literary-light（轻文艺）/ retro-signboard（民国招牌）',
        '   * layout_t4 兼容：modern-editorial（时装大牌）/ swiss-grid（瑞士网格）/ classic-serif（经典宋体）/ gallery-catalog（艺术图录）/ retro-signboard（民国招牌）',
        '   * layout_t5 兼容：oriental-vertical（东方行楷）/ literary-light（轻文艺）',
        '3. 【分镜运镜呼吸（shots[].motion）】：每镜根据画面内容与台词情绪自选运镜：zoom_in（推进特写/聚焦点睛）、zoom_out（舒缓拉远/宏大留白）、pan（横摇平移/铺垫漫步）。',
        '4. 【全片高潮镜（climax_index）】：从 1..N 中指定哪一镜是全片视觉焦点或情感高潮（底层将施加推背动态强化与重音）；平铺叙事填 1。',
        '5. 【片尾收束卡意境自选（ending_id）】：从当前场景限定的 5 款中，挑 1 款最符合全片情感落点的 ID 填入 ending_id：',
        ...(effectiveScene === 'personal'
          ? [
            '   * 个人场景 5 款可选：cta_p1_hairline（发丝双翼/未完待续）/ cta_p2_ghost（幽灵微框/灵感回响）/ cta_p3_pillar（中心竖柱/下一站再会）/ cta_p4_typo（无框微距/步履不停）/ cta_p5_hairline（光影余韵/意犹未尽）',
          ]
          : effectiveScene === 'local'
            ? [
              '   * 实体门店 5 款可选：cta_l1_pillar（中心竖柱/虚位以待）/ cta_l2_hairline（发丝双翼/一席留白）/ cta_l3_ghost（幽灵微框/此处相逢）/ cta_l4_typo（无框微距/同城所见）/ cta_l5_hairline（暖意恭候/敬候佳期）',
            ]
            : [
              '   * 线上电商 5 款可选：cta_s1_ghost（幽灵微框/甄选呈现）/ cta_s2_hairline（发丝双翼/物有所值）/ cta_s3_typo（无框微距/匠心之作）/ cta_s4_pillar（中心竖柱/私享典藏）/ cta_s5_ghost（品质启程/心动拥有）',
            ]),
        '',
      ]),
    '',
    // 场景智能纠偏指令（仅当用户传入场景与文本实际意图严重冲突时注入，捍卫带货转化）
    ...(sceneIntent.isOverridden
      ? [
        `【AI 导演场景智能纠偏铁律（最高优先级）】：客户端传入场景标签为「${scene}」，但系统基于用户输入文本实测检测到强烈【${sceneIntent.detectedSceneZh}】商业属性（${sceneIntent.reason}）。`,
        `★ 核心指令：你必须以用户输入的真实实体与核心卖点为第一真相源！严格围绕该商品的参数材质、痛点解决与购买促单编写台词，绝对禁止脱离商品去进行与画面卖点无关的空泛抒情或假空大散文！`,
        '',
      ]
      : []),
    personaMd ? '===== 人设导演（本场景专属创作人格） =====' : '',
    personaMd,
    '',
    '',
    ...buildAnchorBlock(anchorContext, scene),
    ...antiRepeatBlock(),
    // 批量赛马差异化（可选）：仅当调用方显式传入角度时注入，缺省时 prompt 与既有基线逐字节一致
    ...(variantAngle
      ? [
        `【批量赛马差异化指令（最高优先级）】本片将与另外 ${Math.max(0, (Number(variantTotal) || 1) - 1)} 条视频使用完全相同的素材，交付商家用于投流赛马与矩阵分发。本片必须以「${variantAngle}」作为开场钩子与全片叙事主线切入（第 ${Number(variantIndex) || 1} 条 / 共 ${Number(variantTotal) || 1} 条），台词内容、镜头节奏与卖点呈现顺序都要体现该角度的独特性；严禁写成与其它条目雷同的通用文案。`,
        '',
      ]
      : []),
    decidedVariant
      ? `【变体锁定（不得改判）】本片变体已由系统强信号判定为「${decidedVariant}」。请严格按该变体的风格与基调创作台词/分镜/特效，variant_type 必须输出「${decidedVariant}」。`
      : isPersonal
        ? '【变体说明】个人创作场景无人设变体体系，variant_type 输出空字符串 ""。'
        : '【变体判定】按人设导演的「变体类型」表与「选择逻辑」，结合上方商品/门店信息与文案基调，选出最贴合的唯一 1 个，输出到 variant_type 字段。',
    '',
    // 发布方案规则（宪法铁律第 6 条引用的细则文件，全文注入；口播链路注入同一份）
    PUBLISH_RULES_MD,
    '',
    '【极度重要输出指令】：请立即直接输出符合 Schema 的合法 JSON 对象！严禁任何多余前后缀解释、严禁 Markdown 标记、严禁 ```json 代码块包裹，直接以 { 开头并以 } 结尾。',
  ]
    .filter((l) => l !== null)
    .join('\n');
}


// ==================== JSON 解析（容错：剥代码块标记） ====================
function extractJson(text) {
  const raw = String(text || '').trim();
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('LLM 输出中未找到 JSON');
  return JSON.parse(stripped.slice(start, end + 1));
}

// 思考档位（仅 GLM 系列支持）：low / high / max。GLM-5.3 官方默认 max（面向复杂编码），
// 导演任务是「按提示词输出结构化 JSON」，用低档即可，能显著降低首字延迟与思考 token 消耗。
const REASONING_EFFORT = String(process.env.JX_DIRECTOR_REASONING_EFFORT || 'low').toLowerCase();
// 首包超时：严格设置 30 秒超时（用户定版 2026-10-29，由 2026-10-27 的 20s 放宽）。
// 四层降级链在拥挤高峰期给予充分缓冲，30s 内未开始吐字则主动中止并自动顺次降级至下一层或本地保底剧本。
const FIRST_PACKET_MS = (() => {
  const n = Number(process.env.JX_DIRECTOR_FIRST_PACKET_MS || 30000);
  return Number.isFinite(n) && n > 0 ? n : 30000;
})();
const TOTAL_TIMEOUT_MS = (() => {
  const n = Number(process.env.JX_DIRECTOR_TIMEOUT_MS || 90000);
  return Number.isFinite(n) && n > 0 ? n : 90000;
})();

export async function callDirectorLLM(prompt, temperature, model = PRIMARY_MODEL) {
  const llmT0 = Date.now();
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    max_tokens: Number(process.env.JX_DIRECTOR_MAX_TOKENS) || 6144,
    response_format: { type: 'json_object' },
    stream: true, // 流式：不是为了提速，是为了 12s 内能看到数据在流动，避免被误判为超时
  };
  // 思考控制：GLM 用 reasoning_effort；DeepSeek-V4.1-Flash 显式关闭思考链。
  // 其他模型不下发未支持字段，避免直接 400。
  if (/glm/i.test(String(model))) body.reasoning_effort = REASONING_EFFORT;
  else if (/deepseek-v4\.1/i.test(String(model))) body.enable_thinking = false;

  const controller = new AbortController();
  let firstTimer = setTimeout(
    () => controller.abort(new Error(`LLM 首包超时（${FIRST_PACKET_MS}ms 内无数据）`)),
    FIRST_PACKET_MS,
  );
  const totalTimer = setTimeout(
    () => controller.abort(new Error(`LLM 总超时（${TOTAL_TIMEOUT_MS}ms）`)),
    TOTAL_TIMEOUT_MS,
  );

  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.SILICONFLOW_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`LLM HTTP ${resp.status}${errText ? ': ' + errText.slice(0, 200) : ''}`);
    }
    if (!resp.body) throw new Error('LLM 响应无可读流');

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let buf = '';
    let firstAt = 0;
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!firstAt) {
        firstAt = Date.now();
        if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
      }
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '').trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const delta = j?.choices?.[0]?.delta?.content;
          if (delta) text += delta;
        } catch {
          /* 忽略非 JSON 心跳行 */
        }
      }
    }
    if (!text.trim()) throw new Error('LLM 返回空内容');
    // LLM 返回耗时监控：总耗时 = 发起 → 流读完；首包 = 发起 → 首个数据块
    console.log(`[DIRECTOR] LLM 返回 model=${model} 总耗时=${((Date.now() - llmT0) / 1000).toFixed(1)}s 首包=${((firstAt - llmT0) / 1000).toFixed(1)}s 字数=${text.length}`);
    return extractJson(text);
  } finally {
    if (firstTimer) clearTimeout(firstTimer);
    clearTimeout(totalTimer);
  }
}

/**
 * 四级模型阶梯式容灾调用链（顺序即优先级，前一级失败自动降级）：
 *   1. 一层 GLM-5.3-Flash（速度优先）
 *   2. 二层 DeepSeek-V3.2 Pro（质量兜底）
 *   3. 三层 DeepSeek-V4.1-Flash（跨供应商互备）
 *   4. 四层 Qwen2.5-14B-Instruct（最终低成本兜底，仍失败则抛错交由 mocker）
 * 温度逐级递减：创意型在前，确定性在后，越往下越保守。
 */
async function callDirectorWithFallback(
  prompt,
  { primaryTemp = 0.85, secondaryTemp = 0.5, tertiaryTemp = 0.4, quaternaryTemp = 0.3, tag = 'DIRECTOR' } = {},
) {
  const chain = [
    { model: PRIMARY_MODEL, temp: primaryTemp, label: '一层首选' },
    { model: SECONDARY_MODEL, temp: secondaryTemp, label: '二层质量兜底' },
    { model: TERTIARY_MODEL, temp: tertiaryTemp, label: '三层快速互备' },
    { model: QUATERNARY_MODEL, temp: quaternaryTemp, label: '四层低成本兜底' },
  ];
  let lastErr = null;
  for (let i = 0; i < chain.length; i++) {
    const { model, temp, label } = chain[i];
    const tierT0 = Date.now();
    try {
      return await callDirectorLLM(prompt, temp, model);
    } catch (e) {
      lastErr = e;
      const costSec = ((Date.now() - tierT0) / 1000).toFixed(1);
      const next = chain[i + 1];
      if (next) {
        console.warn(`[${tag}] ${label}（${model}）调用失败（耗时 ${costSec}s，${e.message}），降级至${next.label}（${next.model}）...`);
      } else {
        console.error(`[${tag}] ${label}（${model}）亦调用失败（耗时 ${costSec}s）: ${e.message}，交由 mocker 兜底`);
      }
    }
  }
  throw lastErr;
}

// ==================== 兜底校验（只兜底不限制：非法值静默回退，图片每张必现） ====================
// 铁律（hard constraint）：分镜数量与用户上传图片数量一一对应，每张图必须完整显示，不得遗漏。
// 视频配音场景（videoMeta 存在）：shots 表示全片旁白分段（asset 恒 1），与图片素材去重逻辑严格分离，
// 多段旁白必须全部保留，绝不按 asset 去重；空 line 段丢弃（无 TTS 价值）。

/* 变体名归一：LLM 偶发输出裸字母/前缀（如 'D' 而非 'D-场景代入型'），
   不归一会让 compatAnchors 查表落空 → 兼容链全灭 → 落到排名首名（可能与真实变体不兼容）。
   场景池内精确命中不动；前缀唯一命中补全为全名；歧义/未知原样返回（由兼容链自然兜底）。 */
function normalizeVariantType(v, scene) {
  const key = String(v || '').trim();
  if (!key) return '';
  const pool = scene === 'local' ? LOCAL_VARIANTS : SELL_VARIANTS;
  if (pool.includes(key)) return key;
  const hits = pool.filter((n) => n.startsWith(key));
  return hits.length === 1 ? hits[0] : key;
}

/* 主播/实体角色解析：LLM 给的 anchor_id 必须在对应池内且与 variant_type 兼容；
   线下实体场景走 LOCAL_ROLES 实体角色池；线上带货走 HOST_LIBRARY 主播池；无池返回 null。 */
function resolveAnchor(cut, anchorContext) {
  /* 线下实体场景：从实体角色池解析 */
  if (anchorContext?.scene === 'local') {
    const variant = normalizeVariantType(cut.variant_type, 'local');
    const requested = String(cut.anchor_id || '').trim();
    const role = getLocalRole(requested);
    if (role) {
      return { id: role.id, name: role.name, dna: role.label, temperaments: role.temperaments };
    }
    const compatRoleIds = LOCAL_ROLE_COMPAT[variant] || ['shopowner'];
    const fallbackRole = getLocalRole(compatRoleIds[0]) || LOCAL_ROLES[0];
    return { id: fallbackRole.id, name: fallbackRole.name, dna: fallbackRole.label, temperaments: fallbackRole.temperaments };
  }

  const ranked = Array.isArray(anchorContext?.ranked)
    ? anchorContext.ranked.map((a) => (typeof a === 'string' ? getAnchor(a) : getAnchor(a.id))).filter(Boolean)
    : [];
  if (!ranked.length) return null;
  const variant = normalizeVariantType(cut.variant_type, anchorContext?.scene);
  const requested = String(cut.anchor_id || '').trim();
  const picked = ranked.find((h) => h.id === requested && isCompat(variant, h.id));
  if (picked) return picked;
  /* 兼容性 > 轮转：黑名单是公平性机制（防止商家总刷到同几个主播），兼容是正确性约束。
     压测抓到的洞：某变体兼容主播很少（如 G-信任背书型只有 3 人），轮转账本把
     兼容集全拉黑时，排班池过滤后一个兼容的都不剩，旧兜底直接放行 ranked[0]
     （不兼容主播念台词）。最后一跳改为从全池找兼容者——宁可复用，不可错配。 */
  const poolCompat = HOST_LIBRARY.find((h) => isCompat(variant, h.id)) || null;
  const reserved = anchorContext?.reservedId ? ranked.find((h) => h.id === anchorContext.reservedId) : null;
  return (reserved && isCompat(variant, reserved.id) ? reserved : null)
    || ranked.find((h) => isCompat(variant, h.id))
    || poolCompat
    || ranked[0];
}

/* 全片语速：LLM 档位钳制 0.85~1.25（超出直接钳回，防 atempo 失真）；缺省 1 零回归 */
function clampSpeechSpeed(cut) {
  const v = Number(cut.speech_speed);
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.min(1.25, Math.max(0.85, v));
}

function sanitizeDirectorCut(cut, { imageCount, voice, videoMeta, scene, anchorContext = null, sellingPoints = '' }) {
  const rawShots = Array.isArray(cut.shots) ? cut.shots.filter(Boolean) : [];

  if (videoMeta) {
    const dur = Number(videoMeta.durationSec) || 10;
    const availSec = Math.max(3, dur - 1.8);
    const maxSafeChars = Math.max(18, Math.floor(availSec * 3.6));

    let totalChars = 0;
    const safeRawShots = [];
    for (const s of rawShots) {
      const line = String(s?.line ?? '').trim();
      if (!line) continue;
      if (totalChars + line.length > maxSafeChars && safeRawShots.length >= 1) {
        break;
      }
      totalChars += line.length;
      safeRawShots.push(s);
    }

    const shots = (safeRawShots.length ? safeRawShots : rawShots.slice(0, 1))
      .map((s) => ({
        line: String(s?.line ?? '').trim(),
        duration: Number(s?.duration),
        pause_after: Number(s?.pause_after),
      }))
      .filter((s) => s.line)
      .map((s, i) => ({
        order: i + 1,
        asset: 1, // 视频场景唯一画面素材，编号恒 1
        line: s.line,
        duration: Number.isFinite(s.duration) && s.duration > 0 ? s.duration : 0,
        pause_after: Number.isFinite(s.pause_after) ? Math.min(1.0, Math.max(0.2, s.pause_after)) : 0.4,
      }));

    const userIntent = detectUserVoiceIntent(sellingPoints);
    const finalGender = userIntent.explicitGender || (voice === 'male' || voice === 'female' ? voice : (cut.voice_gender === 'female' ? 'female' : 'male'));
    let finalVoiceId = String(cut.voice_id || '').trim();
    if (finalVoiceId === 'cantonese' || finalVoiceId === '404000' || finalVoiceId === '101019' || userIntent.isCantonese) {
      finalVoiceId = 'cantonese'; // 腾讯超自然大模型2.0 粤语亲和女声
    } else if (finalVoiceId === 'english-female' || finalVoiceId === 'english-male' || finalVoiceId === 'english' || finalVoiceId === '402000' || finalVoiceId === '402002' || userIntent.isEnglish) {
      finalVoiceId = finalGender === 'male' ? 'english-male' : 'english-female';
    } else if (!isTemperament(finalVoiceId) || TEMPERAMENTS[finalVoiceId]?.gender !== finalGender) {
      if (userIntent.explicitTemperament && TEMPERAMENTS[userIntent.explicitTemperament]?.gender === finalGender) {
        finalVoiceId = userIntent.explicitTemperament;
      } else {
        finalVoiceId = finalGender === 'female' ? 'f-warm' : 'm-calm';
      }
    }

    /* 结尾收束（纯文本，非画面字段）：个人场景一律门控清空（生活记录不贴收束）；
       长度钳制防刷屏；若正文台词已占满预算，自动压制 end_line，严防溢出黑屏 */
    let endLineRaw = scene === 'personal' ? '' : scrubContactInfo(String(cut.end_line || '').trim()).slice(0, 16);
    if (totalChars + endLineRaw.length > maxSafeChars + 2) {
      endLineRaw = '';
    }

    const validEndings = new Set(endingsForScene(scene).map((e) => e.id));
    const rawEnding = String(cut.ending_id || '').trim();
    const ending_id = validEndings.has(rawEnding) ? rawEnding : '';

    const anchor = resolveAnchor(cut, anchorContext);

    return {
      title: String(cut.title || '').trim().slice(0, 24) || '精选好物',
      site: String(cut.site || '').trim(),
      intro_title: String(cut.intro_title || '').trim().slice(0, 24),
      intro_en: String(cut.intro_en || '').trim(),
      intro_note: String(cut.intro_note || '').trim().slice(0, 30),
      intro_idx: String(cut.intro_idx || '').trim().slice(0, 30),
      variant_type: normalizeVariantType(cut.variant_type, scene),
      voice_gender: finalGender,
      voice_id: finalVoiceId,
      // 主播风格层：程序兜底校验后的锚点（无池时为 null，链路零回归）
      anchor_id: anchor?.id || '',
      anchor_name: anchor?.name || '',
      anchor_dna: anchor?.dna || '',
      speech_speed: clampSpeechSpeed(cut),
      bgm_emotion: String(cut.bgm_emotion || '').trim(),
      bgm_on: cut.bgm_on !== false,
      end_line: endLineRaw,
      ending_id,
      climax_index: 1,
      director: 'llm',
      // 发布方案（共享层兜底：视频配音封面是用户视频帧，需要贴纸大字）
      publish: sanitizePublish(cut.publish, { scene, title: String(cut.title || '').trim().slice(0, 24) || '精选好物', subtitle: '', coverTitleRequired: true }),
      shots,
    };
  }

  const n = Math.max(1, Math.min(9, Number(imageCount) || 1));

  // 图片序列：按 LLM 给的 asset 顺序首次出现排列，遗漏的图按序补位（保证 N 图 = N 镜）
  const seen = new Set();
  const assetOrder = [];
  for (const s of rawShots) {
    const a = Number(s?.asset);
    if (Number.isInteger(a) && a >= 1 && a <= n && !seen.has(a)) {
      seen.add(a);
      assetOrder.push(a);
    }
  }
  for (let a = 1; a <= n; a++) if (!seen.has(a)) assetOrder.push(a);

  // 台词/参数按 LLM 输出顺序对齐到图片序列：LLM 专精文本，缺失时平滑兜底。
  // 图片成片时长契约：每镜 = 该镜 TTS 实测 + 0.7s 呼吸（铁律 3），LLM 的 duration/
  // pause_after 在图片链路无人消费（宪法也已不再要求），不再产出。
  const lineQueue = rawShots.map((s) => String(s?.line ?? '').trim());
  const rawMotionQueue = rawShots.map((s) => String(s?.motion || '').trim().toLowerCase());
  const validMotions = new Set(['zoom_in', 'zoom_out', 'pan', 'sweep', 'sweep_lr', 'sweep_rl', 'rise_up', 'diagonal']);
  /* side_typo 归一为纯字符串：新版契约是字符串，旧版 LLM 可能回对象 {text, subText}，
     取 text 兜底——版式槽位只吃一行字符串，对象直接透传会渲染成 "[object Object]"。 */
  const sideTypoQueue = rawShots.map((s) => {
    const st = s?.side_typo;
    if (typeof st === 'string') return st.trim();
    return String(st?.text || '').trim();
  });

  const rawClimax = Number(cut.climax_index);
  const climax_index = Number.isInteger(rawClimax) && rawClimax >= 1 && rawClimax <= n ? rawClimax : 1;

  const shots = assetOrder.map((asset, i) => {
    const m = rawMotionQueue[i];
    const shotMotion = validMotions.has(m) ? m : '';
    const isClimax = (i + 1) === climax_index;
    return {
      order: i + 1,
      asset, // 1-based 用户图片编号
      line: lineQueue[i] || '',
      motion: shotMotion,
      climax: isClimax,
      // 顶部英文标尺每镜都要：V4 五套版式都有英文槽位（T1 label / T2·T4 en）。
      // 缺失时留空字符串，由版式整组不画。
      side_typo: sideTypoQueue[i],
    };
  });

  const userIntent = detectUserVoiceIntent(sellingPoints);
  const finalGender = userIntent.explicitGender || (voice === 'male' || voice === 'female' ? voice : (cut.voice_gender === 'female' ? 'female' : 'male'));
  let finalVoiceId = String(cut.voice_id || '').trim();
  if (finalVoiceId === 'cantonese' || finalVoiceId === '404000' || finalVoiceId === '101019' || userIntent.isCantonese) {
    finalVoiceId = 'cantonese'; // 腾讯超自然大模型2.0 粤语亲和女声
  } else if (finalVoiceId === 'english-female' || finalVoiceId === 'english-male' || finalVoiceId === 'english' || finalVoiceId === '402000' || finalVoiceId === '402002' || userIntent.isEnglish) {
    finalVoiceId = finalGender === 'male' ? 'english-male' : 'english-female';
  } else if (!isTemperament(finalVoiceId) || TEMPERAMENTS[finalVoiceId]?.gender !== finalGender) {
    if (userIntent.explicitTemperament && TEMPERAMENTS[userIntent.explicitTemperament]?.gender === finalGender) {
      finalVoiceId = userIntent.explicitTemperament;
    } else {
      finalVoiceId = finalGender === 'female' ? 'f-warm' : 'm-calm';
    }
  }

  const anchor = resolveAnchor(cut, anchorContext);

  const cleanLayoutId = (() => {
    const raw = String(cut.layout_id || '').trim().toLowerCase();
    if (/^layout_t[1-5]$/.test(raw)) return raw;
    if (/^t[1-5]$/.test(raw)) return `layout_${raw}`;
    return '';
  })();

  const cleanPairingId = (() => {
    const raw = String(cut.pairing_id || '').trim().toLowerCase();
    const ly = LAYOUTS.find((l) => l.id === cleanLayoutId);
    if (ly && ly.allowed.includes(raw)) return raw;
    return ly ? ly.defaultPairing : '';
  })();

  const validEndings = new Set(endingsForScene(scene).map((e) => e.id));
  const rawEnding = String(cut.ending_id || '').trim();
  const ending_id = validEndings.has(rawEnding) ? rawEnding : '';

  const result = {
    title: String(cut.title || '').trim().slice(0, 24) || '精选好物',
    subtitle: String(cut.subtitle || cut.cover_line || '').trim().slice(0, 16) || '品质臻选 · 值得拥有',
    /* 全片署名（英文）：印在每镜版面 site 槽位。LLM 没给就留空——V4 版式空文案整组不画，
       不塞 JANSEE.CN 这种假署名（每个商品都印同一句，一眼假）。 */
    site: String(cut.site || '').trim(),
    variant_type: normalizeVariantType(cut.variant_type, scene),
    voice_gender: finalGender,
    voice_id: finalVoiceId,
    // 版式美学策展层：校验归一化（仅允许 layout_t1~t5，或简写 t1~t5 归一）
    layout_id: cleanLayoutId,
    pairing_id: cleanPairingId,
    ending_id,
    climax_index,
    // 主播风格层：程序兜底校验后的锚点（无池时为空串，链路零回归）
    anchor_id: anchor?.id || '',
    anchor_name: anchor?.name || '',
    anchor_dna: anchor?.dna || '',
    speech_speed: clampSpeechSpeed(cut),
    bgm_emotion: String(cut.bgm_emotion || '').trim(),
    bgm_on: cut.bgm_on !== false,
    director: 'llm',
    // 发布方案（包含 4~8 字短视频封面黄金大字）
    publish: sanitizePublish(cut.publish, { scene, title: String(cut.title || '').trim().slice(0, 24) || '精选好物', subtitle: String(cut.subtitle || cut.cover_line || '').trim().slice(0, 16), coverTitleRequired: true }),
    shots,
  };

  return result;
}

/**
 * LLM 大导演入口：一次调用输出台词 + 逐镜编排（特效/运镜/BGM/音色全权）。
 * @returns 剧本对象（已兜底校验）；LLM 不可用或两次调用失败时抛错，由调用方回落程序兜底剧本。
 */
export async function generateDirectorCut({ scene = 'sell', title = '', sellingPoints = '', imageCount = 0, voice = 'male', decidedVariant = '', videoMeta = null, model = '', variantAngle = '', variantIndex = 0, variantTotal = 0, anchorContext = null } = {}) {
  if (!llmUsable()) throw new Error('LLM 未配置（JIANXI_MOCK 开启或缺少 SILICONFLOW_API_KEY）');

  // 1. 组装导演提示词（文本插槽需求已并入宪法 JSON 契约，无需程序预规划）
  const n = Math.max(1, Math.min(9, Number(imageCount) || 1));
  const prompt = buildDirectorPrompt({ scene, title, sellingPoints, imageCount, voice, decidedVariant, videoMeta, variantAngle, variantIndex, variantTotal, anchorContext });

  // 若显式指定 model，则直接调用该模型，否则走三模型主备容灾调用链
  let cut;
  if (model) {
    cut = await callDirectorLLM(prompt, 0.85, model);
  } else {
    cut = await callDirectorWithFallback(prompt, { primaryTemp: 0.85, secondaryTemp: 0.5, tertiaryTemp: 0.3, tag: 'DIRECTOR' });
  }

  // 2. 将 LLM 文本缝合为结构化剧本
  const script = sanitizeDirectorCut(cut, { imageCount, voice, videoMeta, scene, anchorContext, sellingPoints });
  if (!script.shots.length) throw new Error('导演输出无有效分镜');
  return script;
}


// ==================== S5 分镜解说文案大导演 (Storyboard Script Director) ====================

/**
 * 组装分镜文案生成提示词
 */
// 分镜链路专用主播注入块：解说词无 variant_type 判定（不是叫卖变体，是按镜旁白），
// 不走「变体-兼容表自选」，直接用排班锁定的 reservedId——LLM 按该主播 DNA 写台词，无改选权。
// anchorContext 为 null（personal / 无池）时返回空数组，提示词与历史完全一致（零回归）。
// anchor_id / speech_speed 输出要求写在本块内而非 storyboard-director.md 契约——宪法基线零改动。
function buildStoryboardAnchorBlock(anchorContext) {
  if (!anchorContext || !anchorContext.reservedId) return [];
  const h = getAnchor(anchorContext.reservedId);
  if (!h) return [];
  const dna = getDna(h.dna);
  return [
    '',
    '===== 主播风格层（本片解说的表达人格，已由系统排班锁定） =====',
    `本片解说主播：${h.id}（锚点：${h.name}）· 风格 DNA：${dna?.label || h.dna}`,
    'anchor_id 字段必须输出「' + h.id + '」，不得改选。',
    dna ? `台词风格细则（每个镜头的解说词逐条遵守）：\n${dna.md}` : '',
    '【speech_speed】全片语速倍率数字（0.85~1.25）：按该主播 DNA 的节奏指引给 1 个数字（沉稳叙事 0.9~1.0、元气快节奏 1.05~1.2），无法判断给 1。',
    ANCHOR_REDLINE_MD,
    '',
  ].filter(Boolean);
}

function buildStoryboardPrompt({ title, sellingPoints, shotsMeta, variantAngle = '', variantIndex = 0, variantTotal = 0, anchorContext = null }) {
  const metaLines = shotsMeta.map((s) => {
    const dur = Number(s.durationSec) || 0;
    // 每镜字数黄金配比：2.8~3.8 字/秒（严格物理上限 4.0 字/秒，兼顾气口与留白）
    const minChars = Math.max(4, Math.floor(dur * 2.8));
    const maxChars = Math.max(minChars + 2, Math.floor(dur * 3.8));
    const hardLimit = Math.ceil(dur * 4.0);
    return `- 第 ${s.shotIndex} 镜 [素材 ID: ${s.materialId}]：实测物理时长 ${dur.toFixed(1)} 秒，建议口播字数区间 ${minChars}~${maxChars} 字（严格上限 ≤ ${hardLimit} 字）。`;
  });

  return [
    STORYBOARD_DIRECTOR_MD,
    '',
    '===== 创作任务输入（客观事实） =====',
    `- 视频主题/标题：${title || '未指定'}`,
    `- 用户提供卖点/描述：${sellingPoints || '未提供，请根据主题创作中性、高级的视听白描，切勿编造具体功效数据'}`,
    `- 分镜素材列表（共 ${shotsMeta.length} 镜，输出必须严格保持数量一致与对应顺序）：`,
    ...metaLines,
    '',
    ...(variantAngle
      ? [
        `【批量赛马差异化指令（最高优先级）】本片将与另外 ${Math.max(0, (Number(variantTotal) || 1) - 1)} 条视频使用完全相同的分镜素材，交付商家用于投流赛马与矩阵分发。全部解说词必须以「${variantAngle}」作为开场钩子与叙事主线切入（第 ${Number(variantIndex) || 1} 条 / 共 ${Number(variantTotal) || 1} 条），严禁写成与其它条目雷同的通用文案。`,
        '',
      ]
      : []),
    ...buildStoryboardAnchorBlock(anchorContext),
    '请严格根据每个镜头的物理时长与推荐字数区间，创作严丝合缝、紧凑卡点的视听解说词，严格输出 JSON 对象。',
  ].join('\n');
}

/**
 * 严格校验分镜剧本文案结构、镜头数量、顺序与字数限制
 */
function validateStoryboardScript(rawCut, shotsMeta) {
  if (!rawCut || typeof rawCut !== 'object') {
    throw new Error('LLM 未返回有效 JSON 对象');
  }

  const rawShots = Array.isArray(rawCut.shots) ? rawCut.shots : [];
  if (rawShots.length !== shotsMeta.length) {
    throw new Error(`分镜镜头数量不匹配：输入 ${shotsMeta.length} 镜，模型返回 ${rawShots.length} 镜`);
  }

  const resultShots = [];
  const overLengthIndices = [];

  for (let i = 0; i < shotsMeta.length; i++) {
    const expected = shotsMeta[i];
    const s = rawShots[i];
    const idx = Number(s?.shotIndex);
    if (idx !== expected.shotIndex) {
      throw new Error(`分镜索引错误或乱序：第 ${i + 1} 项期望 shotIndex=${expected.shotIndex}，实际得到 ${s?.shotIndex}`);
    }

    const text = String(s?.text ?? '').trim();
    if (!text) {
      throw new Error(`第 ${idx} 镜文案为空或未提供`);
    }

    // 字数红线校验：超过物理时长对应的字数上限（dur * 4.0）判定为超长
    const dur = Number(expected.durationSec) || 0;
    const maxAllowedChars = Math.ceil(dur * 4.0);
    if (text.length > maxAllowedChars) {
      overLengthIndices.push({
        shotIndex: idx,
        currentLen: text.length,
        maxAllowed: maxAllowedChars,
        dur,
        text,
      });
    }

    resultShots.push({
      shotIndex: idx,
      materialId: expected.materialId,
      text,
      durationSec: dur,
    });
  }

  return {
    title: String(rawCut.title || '').trim().slice(0, 20) || '精选分镜视频',
    shots: resultShots,
    overLength: overLengthIndices,
  };
}

/**
 * S5 分镜解说文案生成入口
 * @param {object} opts { title, sellingPoints, shotsMeta }
 *   shotsMeta: [{ shotIndex: 1, materialId: 'mat_...', durationSec: 15.5 }]
 * @returns {Promise<{title: string, shots: Array<{shotIndex, materialId, text}>}>}
 */
export async function generateStoryboardScript({ title = '', sellingPoints = '', shotsMeta = [], variantAngle = '', variantIndex = 0, variantTotal = 0, anchorContext = null }) {
  if (!llmUsable()) throw new Error('LLM 未配置（JIANXI_MOCK 开启或缺少 SILICONFLOW_API_KEY）');
  if (!Array.isArray(shotsMeta) || !shotsMeta.length) {
    throw new Error('分镜镜头列表不能为空');
  }

  const prompt = buildStoryboardPrompt({ title, sellingPoints, shotsMeta, variantAngle, variantIndex, variantTotal });

  // 1. 调用大模型（日常 GLM-5.3-Flash，兜底 DeepSeek-V4.1-Flash）
  let rawCut = await callDirectorWithFallback(prompt, { primaryTemp: 0.7, fallbackTemp: 0.2, tag: 'STORYBOARD DIRECTOR' });

  // 2. 第一轮结果校验
  let checked = validateStoryboardScript(rawCut, shotsMeta);

  // 3. 超长镜头要求模型重写（自愈防线：禁止静默截断）
  if (checked.overLength && checked.overLength.length > 0) {
    console.warn(`[STORYBOARD DIRECTOR] 检测到 ${checked.overLength.length} 处文案超长，发起精确精简重写...`);
    const fixList = checked.overLength
      .map((o) => `第 ${o.shotIndex} 镜当前文字「${o.text}」（${o.currentLen}字）超出物理上限 ${o.maxAllowed} 字，必须缩减至 ${o.maxAllowed} 字以内！`)
      .join('\n');
    const rewritePrompt = [
      prompt,
      '',
      '【严重警告：上次生成的文案存在镜头超长溢出风险，请必须重写精炼以下镜头】：',
      fixList,
      '请重新输出完整的纯 JSON 对象，保持所有镜头数量严格等于 ' + shotsMeta.length + ' 且文字紧凑精炼！',
    ].join('\n');

    const rewriteCut = await callDirectorWithFallback(rewritePrompt, { primaryTemp: 0.3, fallbackTemp: 0.2, tag: 'STORYBOARD REWRITE' });
    checked = validateStoryboardScript(rewriteCut, shotsMeta);

    // 重写后若仍然超长，严格报错拒绝，绝不把残缺截断文本返回
    if (checked.overLength && checked.overLength.length > 0) {
      const failedShots = checked.overLength.map((o) => `第 ${o.shotIndex} 镜`).join('、');
      throw new Error(`分镜解说文案生成失败：${failedShots} 文字字数超出镜头物理时长，重写后仍超长`);
    }
  }

  // 主播层出口：排班锁定 reservedId，LLM 输出仅日志核对（改选不采纳）；speech_speed 越界回退 1。
  // anchorContext 为 null（personal / 无池）时三字段空值兜底，与历史返回结构兼容。
  const anchorFields = (() => {
    if (!anchorContext || !anchorContext.reservedId) return { anchor_id: '', anchor_dna: '', speech_speed: 1 };
    const h = getAnchor(anchorContext.reservedId);
    const rawSpeed = Number(rawCut?.speech_speed);
    if (Number.isFinite(rawSpeed) && (rawSpeed < 0.85 || rawSpeed > 1.25)) {
      console.warn(`[STORYBOARD DIRECTOR] speech_speed 越界（${rawSpeed}），回退 1.0`);
    }
    const speed = Number.isFinite(rawSpeed) && rawSpeed >= 0.85 && rawSpeed <= 1.25 ? rawSpeed : 1;
    const llmAnchor = String(rawCut?.anchor_id || '').trim();
    if (llmAnchor && llmAnchor !== anchorContext.reservedId) {
      console.warn(`[STORYBOARD DIRECTOR] LLM 改选主播（${llmAnchor}），按排班锁定回退 ${anchorContext.reservedId}`);
    }
    return { anchor_id: anchorContext.reservedId, anchor_dna: h?.dna || '', speech_speed: speed };
  })();

  return {
    title: checked.title,
    shots: checked.shots.map((s) => ({
      shotIndex: s.shotIndex,
      materialId: s.materialId,
      text: s.text,
    })),
    ...anchorFields,
  };
}

// ==================== 轻量发布方案生成（口播 / 分镜直出 / 分镜 AI 配音共用）====================
/**
 * 独立发布方案生成：这三条链路没有「导演写词」环节可以顺手出 publish，
 * 用一次轻量 LLM 调用按成片文本（口播 = 清理后保留词；分镜 = 各镜解说/原声词）
 * 生成四件套。设计红线：
 *   1. 永不抛错、永不阻断出片——LLM 全链失败/超时/输出脏，一律落 sanitizePublish 全兜底；
 *   2. 整体 30s 软上限（与 ffmpeg 合成并行跑，正常几秒即回，不拖慢交付）；
 *   3. 规则单一真相源仍是 prompt/publish-rules.md（此处注入全文，与宪法同源）。
 * @param {object} opts { transcript, title, sellingPoints, scene }
 * @returns {Promise<object>} sanitizePublish 清洗后的 { caption, cover_title, pinned_comment, post_time, _banned_hits }
 */
const PUBLISH_ONLY_TIMEOUT_MS = (() => {
  const n = Number(process.env.JX_PUBLISH_ONLY_TIMEOUT_MS || 30000);
  return Number.isFinite(n) && n > 0 ? n : 30000;
})();

export async function generatePublishOnly({ transcript = '', title = '', sellingPoints = '', scene = 'sell' } = {}) {
  const ctx = {
    scene: String(scene || 'sell'),
    title: String(title || '').trim().slice(0, 24) || '精选好物',
    subtitle: '',
    coverTitleRequired: true,
  };
  const fallback = () => sanitizePublish(null, ctx);
  // 调试字段统一出口：剥掉 _banned_hits（命中已在日志留痕）——三条消费链路的任务对象
  // 经 GET /video/task 原样透传，调试字段绝不进客户端。
  const stripDebug = ({ caption, cover_title, pinned_comment, post_time }) => ({ caption, cover_title, pinned_comment, post_time });
  const cleanTranscript = String(transcript || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  // 无有效文本（全静音/全剪光）直接兜底，不值得烧一次调用
  if (!cleanTranscript) return stripDebug(fallback());
  if (!llmUsable()) return stripDebug(fallback());

  const prompt = [
    '你是短视频发布运营专家。视频已经剪好，现在只需要为它生成「发布方案」四件套。',
    '',
    '【视频主题】' + ctx.title,
    sellingPoints ? '【补充卖点】' + String(sellingPoints).slice(0, 200) : '',
    '【视频内容（语音识别原文，即观众将听到的话）】',
    cleanTranscript,
    '',
    PUBLISH_RULES_MD,
    '',
    '只输出一个纯 JSON 对象（不要任何解释/代码块标记），字段：',
    '{"caption":"...","cover_title":"...","pinned_comment":"...","post_time":"..."}',
    'caption 基于视频实际内容写钩子（观众还没看视频），严禁复述上面原文里的句子。',
  ].filter(Boolean).join('\n');

  try {
    const result = await Promise.race([
      (async () => {
        const raw = await callDirectorWithFallback(prompt, { primaryTemp: 0.7, secondaryTemp: 0.4, tertiaryTemp: 0.3, quaternaryTemp: 0.2, tag: 'PUBLISH ONLY' });
        const clean = sanitizePublish(raw?.publish || raw, ctx);
        if (clean._banned_hits?.length) {
          console.warn(`[PUBLISH ONLY] 红线词命中（已清洗）: ${clean._banned_hits.join('、')}`);
        }
        return stripDebug(clean);
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('发布方案生成超时')), PUBLISH_ONLY_TIMEOUT_MS)),
    ]);
    return result;
  } catch (e) {
    console.warn(`[PUBLISH ONLY] 轻量发布方案生成失败，落全兜底: ${e.message}`);
    return stripDebug(fallback());
  }
}

// ==================== 程序兜底剧本（mocker）====================
/**
 * 编排层退役（2026-10-12 LLM 全权导演定版）：
 * VARIANT_EDIT_MAP / VARIANT_OPENING_MAP / VARIANT_TITLE_MAP 等程序编排规则已全部废除，
 * 编排权完全移交 LLM 大导演（本文件 generateDirectorCut）；仅保留程序兜底剧本（LLM 失败时回落，保证出片永不中断）。
 */

/**
 * 变体判定（唯一权威：prompt/index.js 的 decideVariantLocal）
 */
function decideVariant(scene, text) {
  const role = scene === 'local' ? 'local' : (scene === 'personal' ? 'personal' : 'sell');
  const clean = String(text || '').trim();

  // 1. 个人创作场景：遵循 constitution.md 纯创作宪法，不设带货变体
  if (role === 'personal') {
    return {
      type: '宪法纯生活叙事'
    };
  }

  // 2. 线上带货与同城探店：直接调用 prompt/index.js 官方权威本地检索优先层
  const decided = decideVariantLocal(clean, role, []);
  const defaultType = role === 'local' ? LOCAL_VARIANT_TYPES[0] : SELL_VARIANT_TYPES[0];
  const type = decided || defaultType;

  return {
    type
  };
}

/**
 * 程序兜底剧本（mocker）：LLM 导演失败时回落，保证出片永不中断。
 * 结构：N 图 = N 镜（每图必现），首镜 Hook / 末镜 CTA / 中间卖点拆句轮播（耗尽转纯呼吸镜）。
 */
export function generateConstitutionScript(scene, mode, title, sellingPoints, imageCount = 0, voice = 'female', videoMeta = null) {
  const cleanTitle = (title || '高品质精选商品').trim();
  const cleanDesc = (sellingPoints || '大厂匠心打磨，质感出众，限时尊享特惠').trim();
  const role = scene === 'local' ? 'local' : (scene === 'personal' ? 'personal' : 'sell');
  const { type: variantType } = decideVariant(scene, `${cleanTitle} ${cleanDesc}`);
  const n = Math.max(1, Math.min(9, imageCount || 1));
  const sentences = cleanDesc.split(/[，。；,.;\n]/u).map((s) => s.trim()).filter(Boolean);

  // 视频配音兜底（阶段 B）：shots=旁白分段（asset 恒 1），与图片兜底的 N 图=N 镜逻辑严格分离；
  // 首段 Hook / 中段卖点拆句 / 收束旁白 end_line，保证 TTS 有文本、合成不空转。
  // 片尾画面收束（V4 结尾卡）由合成模块按 seed 自动装配，兜底剧本不碰画面字段。
  if (videoMeta) {
    const endLine = role === 'personal' ? '' : role === 'local' ? '喜欢就点个关注，欢迎到店实地体验！' : '看完记得点个关注，更多好物持续分享！';
    const segs = [
      `如果你也一直在找一款真正省心的好物，一定要看这款${cleanTitle}。`,
      ...sentences.slice(0, 3),
    ].filter(Boolean);
    const shots = segs.map((line, i) => ({
      order: i + 1,
      asset: 1, // 视频场景唯一画面素材，编号恒 1
      line,
      duration: 3.5,
      pause_after: 0.5,
    }));
    return {
      title: role === 'local' ? `${cleanTitle} · 同城探店` : role === 'personal' ? `${cleanTitle} · 创意分享` : `${cleanTitle} · 商业带货`,
      subtitle: cleanDesc.slice(0, 16) || '品质精选 · 诚挚分享',
      variant_type: role === 'personal' ? '' : variantType,
      voice_gender: voice === 'male' ? 'male' : 'female',
      voice_id: voice === 'male' ? 'm-calm' : 'f-warm',
      bgm_emotion: role === 'local' ? 'warm' : role === 'personal' ? 'calm_narrative' : 'passionate',
      bgm_on: true,
      end_line: endLine,
      director: 'fallback',
      // 发布方案（LLM 全挂时也不能缺角：走共享层全兜底拼装）
      publish: sanitizePublish(null, { scene, title: role === 'local' ? `${cleanTitle} · 同城探店` : role === 'personal' ? `${cleanTitle} · 创意分享` : `${cleanTitle} · 商业带货`, subtitle: '', coverTitleRequired: true }),
      shots,
    };
  }

  // 图片成片兜底：程序自造台词（视觉由 V4 执行引擎按 seed 抽）
  const shots = [];
  for (let k = 0; k < n; k++) {
    let line = '';
    if (k === 0) line = `如果你也一直在找一款真正省心的好物，一定要看这款${cleanTitle}。`;
    else if (k === n - 1 && n >= 2) line = '限时特惠，点击下方立即体验！';
    else line = sentences[(k - 1) % Math.max(1, sentences.length)] || '';

    shots.push({
      order: k + 1,
      asset: k + 1, // 1-based 用户图片编号（N 图 = N 镜，每图必现）
      line,
      /* 兜底剧本没有 LLM 出词，英文标尺与署名无源。留空让 V4 版式整组不画，
         不塞 'COLLECTION / 01 EDITION' 这种假英文——每个商品都印同一句，一眼假。 */
      side_typo: '',
    });
  }

  return {
    title: role === 'local' ? `${cleanTitle} · 同城探店` : role === 'personal' ? `${cleanTitle} · 创意分享` : `${cleanTitle} · 商业带货`,
    site: '',
    subtitle: cleanDesc.slice(0, 16) || '品质臻选 · 值得拥有',
    variant_type: role === 'personal' ? '' : variantType,
    voice_gender: voice === 'male' ? 'male' : 'female',
    voice_id: voice === 'male' ? 'm-calm' : 'f-warm',
    bgm_emotion: role === 'local' ? 'warm' : role === 'personal' ? 'calm_narrative' : 'passionate',
    bgm_on: true,
    director: 'fallback',
    // 发布方案（包含 4~8 字短视频封面黄金大字）
    publish: sanitizePublish(null, { scene, title: role === 'local' ? `${cleanTitle} · 同城探店` : role === 'personal' ? `${cleanTitle} · 创意分享` : `${cleanTitle} · 商业带货`, subtitle: cleanDesc.slice(0, 16) || '品质精选 · 诚挚分享', coverTitleRequired: true }),
    shots,
  };
}
