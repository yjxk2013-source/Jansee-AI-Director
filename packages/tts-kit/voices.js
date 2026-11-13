// 简兮 · voice 白名单（唯一事实源）
// 音色命名说明：全系统语义音色名沿用微软 ShortName 风格（zh-CN-YunyangNeural 等），
// 仅作命名/映射用——微软 Edge TTS 服务已于 2026-10-12 彻底移除（不可商用且常态风控 403），
// 实际合成由腾讯云供应商翻译为真实音色（见 ttsProvider.js mapEdgeVoiceToTencent）。
// dialect 惯例：mandarin(普通话) / northeast(东北话) / shaanxi(陕西话) / cantonese(粤语) / taiwan(台湾腔)

export const VOICE_WHITELIST = {
  male: {
    mandarin: ['zh-CN-YunyangNeural', 'zh-CN-YunjianNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunxiaNeural'],
    northeast: [],
    shaanxi: [],
    cantonese: ['zh-HK-WanLungNeural'],
    taiwan: ['zh-TW-YunJheNeural'],
  },
  female: {
    mandarin: ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural'],
    northeast: ['zh-CN-liaoning-XiaobeiNeural'],
    shaanxi: ['zh-CN-shaanxi-XiaoniNeural'],
    cantonese: ['zh-HK-HiuGaaiNeural', 'zh-HK-HiuMaanNeural'],
    taiwan: ['zh-TW-HsiaoChenNeural', 'zh-TW-HsiaoYuNeural'],
  },
};

// 性别 + 方言 → 首选 default voice（降级/兜底用）
export const DEFAULT_VOICE = {
  male: {
    mandarin: 'zh-CN-YunyangNeural',
    northeast: 'zh-CN-YunyangNeural', // 东北无男声 → 落普通话男声
    shaanxi: 'zh-CN-YunyangNeural',
    cantonese: 'zh-HK-WanLungNeural',
    taiwan: 'zh-TW-YunJheNeural',
  },
  female: {
    mandarin: 'zh-CN-XiaoxiaoNeural',
    northeast: 'zh-CN-liaoning-XiaobeiNeural',
    shaanxi: 'zh-CN-shaanxi-XiaoniNeural',
    cantonese: 'zh-HK-HiuGaaiNeural',
    taiwan: 'zh-TW-HsiaoYuNeural',
  },
};

export const DEFAULT_DIALECT = 'mandarin';

// 所有合法 voice_id（用于校验大模型输出）
export const ALL_VOICE_IDS = new Set(
  Object.values(VOICE_WHITELIST).flatMap((byDialect) => Object.values(byDialect).flat()),
);

// ===== 抽象气质音色层 =====
// LLM 只从"抽象气质 key"里选（如下 8 种），不感知供应商；唯一供应商=腾讯云，
// 在 ttsProvider.mapVoiceFor 翻译成腾讯精品音色 VoiceType。
// 方言音色仍是第一优先：用户显式指定方言（东北/陕西/粤/台）且有对应音色 → 直接用方言音色；无该方言音色（如川/湘）或用普通话 → 由 LLM 从本表选。
// key 命名：m-=男声 f-=女声，其后为气质。
export const TEMPERAMENTS = {
  'm-calm': { label: '沉稳男声', gender: 'male' },
  'm-deep': { label: '低沉男声', gender: 'male' },
  'm-warm': { label: '磁性男声', gender: 'male' },
  'm-sunny': { label: '阳光男声', gender: 'male' },
  'f-warm': { label: '温柔女声', gender: 'female' },
  'f-soft': { label: '知性女声', gender: 'female' },
  'f-passion': { label: '激情女声', gender: 'female' },
  'f-bright': { label: '欢快女声', gender: 'female' },
};

// 抽象 key → 腾讯云 TTS「大模型语音合成」音色（VoiceType 整数）。唯一映射表（2026-11-11 升级）：
// 普通话全面采用大模型语音合成真实音色（401xxx / 601xxx / 301xxx），拟真度与表现力远优于传统音色。
// 未命中兜底 401001（大模型温柔女声）。
export const TEMPERAMENT_TENCENT = {
  'm-calm': 401002, // 大模型·磁性稳重男声
  'm-deep': 301000, // 大模型·爱小广·深度解说男声
  'm-warm': 401002, // 大模型·磁性男声
  'm-sunny': 401003, // 大模型·阳光活力男声
  'f-warm': 401001, // 大模型·温柔女声
  'f-soft': 601000, // 大模型·亲和知性女声
  'f-passion': 401000, // 大模型·激情带货女声
  'f-bright': 401000, // 大模型·欢快女声
};

export const ALL_TEMPERAMENTS = new Set(Object.keys(TEMPERAMENTS));

// ==================== 真实方言（粤语）与自然语言意图探测 ====================
// 机制（2026-11-11 升级）：
//   1) 粤语：锁定腾讯官方超自然大模型 2.0 音色 404000（云佳妍·广粤亲和女声）+ 粤语白话台词；
//   2) 英语：锁定腾讯官方超自然大模型中英音色 402000(女·云晓芙) / 402002(男·云大围) + 地道纯英文口播；
//   3) 普通话：全面使用腾讯大模型语音合成（401xxx / 601xxx / 301xxx），由 LLM 按商品调性从 8 种大模型音色中自由匹配。

export const CANTONESE_DIALECT = Object.freeze({
  key: 'cantonese',
  name: '岭南粤语',
  regex: /(粤语|广东话|白话|广州话|香港话|佛山话|东莞话)/i,
  voiceType: 404000, // 腾讯云超自然大模型 2.0 音色：云佳妍·广粤亲和女声
  voiceId: 'cantonese',
  gender: 'female',
  stylePrompt: '必须采用粤语口播表达习惯（使用地道港风与广府白话，如“真系好正”、“好抵”、“啱晒”等）',
});

export const ENGLISH_VOICES = Object.freeze({
  female: {
    key: 'english-female',
    name: '英语女声',
    voiceType: 402000, // 腾讯云超自然大模型：云晓芙（中英双语女声，自然灵动）
    voiceId: 'english-female',
    gender: 'female',
  },
  male: {
    key: 'english-male',
    name: '英语男声',
    voiceType: 402002, // 腾讯云超自然大模型：云大围（中英双语男声，磁性成熟）
    voiceId: 'english-male',
    gender: 'male',
  },
  regex: /(英语|英文|外语|全英|纯英|纯英文|tiktok英文|海外版|出海|english)/i,
  stylePrompt: '必须采用纯正地道的海外商业英文口播（Natural, fluent and engaging English marketing copy suited for global TikTok/Reels/Instagram audiences, no Chinese characters）',
});

/**
 * 从用户描述框文案中探测配音意图（性别、粤语方言、英语外语、音色气质）
 * @param {string} text 用户输入的文案/描述（sellingPoints / prompt）
 * @returns {{ explicitGender: 'male'|'female'|null, isCantonese: boolean, cantoneseDialect: object|null, isEnglish: boolean, englishVoice: object|null, explicitTemperament: string|null }}
 */
export function detectUserVoiceIntent(text = '') {
  const str = String(text || '').trim();
  if (!str) return { explicitGender: null, isCantonese: false, cantoneseDialect: null, isEnglish: false, englishVoice: null, explicitTemperament: null };

  // 1. 性别意图探测（男声 vs 女声）
  let explicitGender = null;
  const malePattern = /(男声|男生配音|男主播|男配音|小哥配音|大叔音|男人声音)/i;
  const femalePattern = /(女声|女生配音|女主播|女配音|小姐姐配音|妹子声音|女人声音)/i;
  if (malePattern.test(str) && !femalePattern.test(str)) {
    explicitGender = 'male';
  } else if (femalePattern.test(str) && !malePattern.test(str)) {
    explicitGender = 'female';
  }

  // 2. 唯一真实方言探测：粤语
  const isCantonese = CANTONESE_DIALECT.regex.test(str);
  const cantoneseDialect = isCantonese ? CANTONESE_DIALECT : null;

  // 3. 英文/外语意图探测
  const isEnglish = !isCantonese && ENGLISH_VOICES.regex.test(str);
  const englishVoice = isEnglish
    ? (explicitGender === 'male' ? ENGLISH_VOICES.male : ENGLISH_VOICES.female)
    : null;

  // 4. 抽象音色气质意图探测
  let explicitTemperament = null;
  if (/(沉稳|稳重|大气|新闻腔)/i.test(str)) explicitTemperament = 'm-calm';
  else if (/(低沉|磁性低音|厚重男声)/i.test(str)) explicitTemperament = 'm-deep';
  else if (/(磁性|男神音|温暖男声)/i.test(str)) explicitTemperament = 'm-warm';
  else if (/(阳光|活力男声|轻快男声|幽默男声)/i.test(str)) explicitTemperament = 'm-sunny';
  else if (/(温柔|柔美|治愈女声|甜美女声)/i.test(str)) explicitTemperament = 'f-warm';
  else if (/(知性|干练|职业女声|助手女声)/i.test(str)) explicitTemperament = 'f-soft';
  else if (/(激情|热烈|激昂|带劲女声)/i.test(str)) explicitTemperament = 'f-passion';
  else if (/(欢快|活泼|俏皮女声|少女音)/i.test(str)) explicitTemperament = 'f-bright';

  return { explicitGender, isCantonese, cantoneseDialect, isEnglish, englishVoice, explicitTemperament };
}

// 判断是否为合法音色标识（含 8 种抽象气质 key、方言/外语 key 以及官方数字 ID）
export function isTemperament(key) {
  const k = String(key || '').trim().toLowerCase();
  if (k === 'cantonese' || k === '404000' || k === '101019') return true;
  if (k === 'english-female' || k === 'english-male' || k === 'english' || k === '402000' || k === '402002' || k === '1050' || k === '1051') return true;
  return ALL_TEMPERAMENTS.has(String(key || '').trim());
}

// 归一化 dialect：非法值回退普通话
export function normalizeDialect(d) {
  const key = String(d || '').trim();
  return VOICE_WHITELIST.male[key] || VOICE_WHITELIST.female[key] ? key : DEFAULT_DIALECT;
}

/**
 * 校验并归一 voice_id：
 * - 若 voice_id 在该 gender+dialect 白名单内 → 原样返回
 * - 否则 → 用 DEFAULT_VOICE[gender][dialect] 兜底，并 console.warn
 */
export function resolveVoice(gender, dialect, voiceId) {
  const g = gender === 'female' ? 'female' : 'male';
  const d = normalizeDialect(dialect);
  const vid = String(voiceId || '').trim();
  // 抽象气质 key：供应商无关、全局有效，直接放行（由 ttsProvider 映射到真实音色）。
  if (isTemperament(vid)) return vid;
  // 旧值：可能是 edge 方言音色名 → 仍按 gender+dialect 白名单强校验兜底。
  const candidates = VOICE_WHITELIST[g][d] || [];
  if (vid && candidates.includes(vid)) return vid;
  if (vid && !ALL_VOICE_IDS.has(vid)) {
    console.warn(`[WARN] voice_id "${vid}" not in whitelist, fallback to ${DEFAULT_VOICE[g][d]}`);
  } else if (vid && !candidates.includes(vid)) {
    console.warn(
      `[WARN] voice_id "${vid}" not allowed for gender=${g} dialect=${d}, fallback to ${DEFAULT_VOICE[g][d]}`,
    );
  }
  return DEFAULT_VOICE[g][d];
}
