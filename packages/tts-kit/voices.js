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
// 8 个普通话主音色：4 男 4 女，全部使用腾讯当前可用且逐个实测成功的独立 VoiceType。
export const TEMPERAMENT_TENCENT = {
  'm-calm': 403010, // 云嘉和·温和男声
  'm-deep': 403009, // 云嘉尔·慵懒男声
  'm-warm': 402002, // 云大围·磁性男声
  'm-sunny': 403012, // 云嘉辉·激情解说男声
  'f-warm': 402001, // 云小团·温柔甜美女声
  'f-soft': 403014, // 云佳洁·轻熟姐姐
  'f-passion': 403011, // 云嘉瑜·情感解说女声
  'f-bright': 403013, // 云小璇·活力女青年
};

// 腾讯真实音色候选池。主音色失效时，只能从同一性别的已探测可用音色中替补。
// 501xxx 为当前官方长文本音色清单中的真实 VoiceType，已通过本项目 TextToVoice 接口实测。
export const TENCENT_VOICE_CANDIDATES = [
  { voiceType: 403010, gender: 'male', language: 'zh', label: '云嘉和·温和男声' },
  { voiceType: 403009, gender: 'male', language: 'zh', label: '云嘉尔·慵懒男声' },
  { voiceType: 402002, gender: 'male', language: 'zh-en', label: '云大围·磁性男声' },
  { voiceType: 403012, gender: 'male', language: 'zh', label: '云嘉辉·激情解说男声' },
  { voiceType: 501000, gender: 'male', language: 'zh', label: '智斌·阅读男声' },
  { voiceType: 501003, gender: 'male', language: 'zh', label: '智宇·阅读男声' },
  { voiceType: 501005, gender: 'male', language: 'zh', label: '飞镜·聊天男声' },
  { voiceType: 501006, gender: 'male', language: 'zh', label: '千嶂·聊天男声' },
  { voiceType: 501007, gender: 'male', language: 'zh', label: '浅草·聊天男声' },
  { voiceType: 401002, gender: 'male', language: 'zh', label: '腾讯经典·磁性男声' },
  { voiceType: 401003, gender: 'male', language: 'zh', label: '腾讯经典·阳光男声' },
  { voiceType: 301000, gender: 'male', language: 'zh', label: '爱小广·解说男声' },
  { voiceType: 402001, gender: 'female', language: 'zh-en', label: '云小团·温柔甜美女声' },
  { voiceType: 403014, gender: 'female', language: 'zh', label: '云佳洁·轻熟姐姐' },
  { voiceType: 403011, gender: 'female', language: 'zh', label: '云嘉瑜·情感解说女声' },
  { voiceType: 403013, gender: 'female', language: 'zh', label: '云小璇·活力女青年' },
  { voiceType: 501001, gender: 'female', language: 'zh', label: '智兰·资讯女声' },
  { voiceType: 501002, gender: 'female', language: 'zh', label: '智菊·阅读女声' },
  { voiceType: 501004, gender: 'female', language: 'zh', label: '月华·聊天女声' },
  { voiceType: 401001, gender: 'female', language: 'zh', label: '腾讯经典·温柔女声' },
  { voiceType: 601000, gender: 'female', language: 'zh', label: '腾讯经典·知性女声' },
  { voiceType: 402000, gender: 'female', language: 'zh-en', label: '云晓芙·中英女声' },
  { voiceType: 402000, gender: 'female', language: 'en', label: '云晓芙·中英女声' },
  { voiceType: 404000, gender: 'female', language: 'yue', label: '云佳妍·广粤亲和女声' },
  { voiceType: 101019, gender: 'female', language: 'yue', label: '智彤·粤语女声' },
  { voiceType: 402002, gender: 'male', language: 'en', label: '云大围·中英男声' },
  { voiceType: 501008, gender: 'male', language: 'en', label: 'WeJames·英文男声' },
  { voiceType: 501009, gender: 'female', language: 'en', label: 'WeWinny·英文女声' },
];

const VOICE_SLOT_PREFERENCES = {
  'm-calm': [403010, 501000, 403009, 501003, 501005, 501006, 501007, 401002, 301000, 403012, 402002],
  'm-deep': [403009, 501003, 501006, 501007, 501000, 301000, 403010, 401002, 402002, 403012],
  'm-warm': [402002, 501005, 501006, 501007, 501000, 401002, 403010, 403009, 403012, 301000],
  'm-sunny': [403012, 501007, 501005, 501003, 501000, 401003, 403010, 403009, 402002, 301000],
  'f-warm': [402001, 501004, 501002, 501001, 401001, 402000, 403013, 403011, 403014, 601000],
  'f-soft': [403014, 501001, 501002, 501004, 601000, 401001, 402000, 402001, 403011, 403013],
  'f-passion': [403011, 501002, 501001, 501004, 601000, 401001, 402000, 403014, 402001, 403013],
  'f-bright': [403013, 501004, 501002, 501001, 402000, 401001, 402001, 403011, 403014, 601000],
};

export const ACTIVE_TEMPERAMENT_TENCENT = { ...TEMPERAMENT_TENCENT };
export const ACTIVE_ENGLISH_VOICES = { male: 402002, female: 402000 };
const ENGLISH_VOICE_PREFERENCES = { male: [402002, 501008], female: [402000, 501009] };
const VOICE_HEALTH = new Map();
let voiceUnavailableHandler = null;

export function registerTencentVoiceUnavailableHandler(handler) {
  voiceUnavailableHandler = typeof handler === 'function' ? handler : null;
}

export async function markTencentVoiceUnavailable(voiceType, reason = '') {
  const id = Number(voiceType);
  if (!TENCENT_VOICE_CANDIDATES.some((item) => item.voiceType === id)) return;
  VOICE_HEALTH.set(id, 'unavailable');
  applyTencentVoiceHealthSnapshot([...VOICE_HEALTH.entries()].map(([type, status]) => ({ voiceType: type, status })));
  if (voiceUnavailableHandler) await voiceUnavailableHandler({ voiceType: id, reason: String(reason).slice(0, 500) });
}

export function applyTencentVoiceHealthSnapshot(rows = []) {
  // 每次以数据库/探测返回的完整快照为准；缺失记录保持 unknown，不得沿用旧进程状态。
  VOICE_HEALTH.clear();
  for (const row of rows) {
    const voiceType = Number(row.voiceType ?? row.voice_type);
    const status = String(row.status || '').toLowerCase();
    if (Number.isInteger(voiceType) && ['healthy', 'unavailable', 'unknown'].includes(status)) VOICE_HEALTH.set(voiceType, status);
  }
  const hasDefinitiveProbe = rows.some((row) => ['healthy', 'unavailable'].includes(String(row.status || '').toLowerCase()));
  if (!hasDefinitiveProbe) return { ...ACTIVE_TEMPERAMENT_TENCENT };
  const used = new Set();
  for (const [key, temperament] of Object.entries(TEMPERAMENTS)) {
    const choices = VOICE_SLOT_PREFERENCES[key] || [];
    const voiceType = choices.find((candidate) => {
      const candidateInfo = TENCENT_VOICE_CANDIDATES.find((item) => item.voiceType === candidate && item.gender === temperament.gender && item.language !== 'en' && item.language !== 'yue');
      const status = VOICE_HEALTH.get(candidate);
      return candidateInfo && status === 'healthy' && !used.has(candidate);
    });
    if (voiceType) {
      ACTIVE_TEMPERAMENT_TENCENT[key] = voiceType;
      used.add(voiceType);
    } else {
      delete ACTIVE_TEMPERAMENT_TENCENT[key];
    }
  }
  for (const gender of ['male', 'female']) {
    const replacement = ENGLISH_VOICE_PREFERENCES[gender].find((candidate) =>
      TENCENT_VOICE_CANDIDATES.some((item) => item.voiceType === candidate && item.gender === gender && item.language === 'en')
      && isTencentVoiceAvailable(candidate),
    );
    if (replacement) ACTIVE_ENGLISH_VOICES[gender] = replacement;
    else delete ACTIVE_ENGLISH_VOICES[gender];
  }
  return { ...ACTIVE_TEMPERAMENT_TENCENT };
}

export function getAvailableEnglishVoice(gender) {
  const voiceType = ACTIVE_ENGLISH_VOICES[gender];
  const candidate = TENCENT_VOICE_CANDIDATES.find((item) => item.voiceType === voiceType && item.gender === gender && item.language === 'en');
  return candidate && isTencentVoiceAvailable(voiceType) ? voiceType : null;
}

export function getAvailableCantoneseVoice() {
  return [404000, 101019].find((voiceType) => isTencentVoiceAvailable(voiceType)) ?? null;
}

/**
 * 为本次导演请求生成严格的腾讯 TTS 候选集。
 * language: zh | en | yue；只返回明确健康、明确支持该语言的唯一数字 VoiceType。
 * 普通话默认最多 8 个；英语/粤语候选不足时返回全部，不跨语言凑数。
 */
export function getAvailableTencentVoiceCandidates({ language = 'zh', gender = null, limit = 8, preferredTemperament = null } = {}) {
  const lang = String(language || 'zh').toLowerCase();
  if (!['zh', 'en', 'yue'].includes(lang)) return [];
  const cap = Math.max(1, Math.min(8, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 8));
  const allowed = TENCENT_VOICE_CANDIDATES.filter((item) => {
    const languageMatch = lang === 'yue'
      ? item.language === 'yue'
      : lang === 'en'
        ? item.language === 'en' || item.language === 'zh-en'
        : item.language === 'zh' || item.language === 'zh-en';
    return languageMatch && (!gender || item.gender === gender) && isTencentVoiceAvailable(item.voiceType);
  });
  const unique = [...new Map(allowed.map((item) => [item.voiceType, item])).values()];
  const slots = preferredTemperament && VOICE_SLOT_PREFERENCES[preferredTemperament]
    ? [preferredTemperament]
    : lang === 'yue'
      ? []
      : lang === 'en'
        ? ['m-warm', 'f-soft']
        : ['m-calm', 'f-warm'];
  const rankedIds = slots.flatMap((slot) => VOICE_SLOT_PREFERENCES[slot] || []);
  const ranked = [
    ...rankedIds.map((id) => unique.find((item) => item.voiceType === id)).filter(Boolean),
    ...unique,
  ];
  const deduped = [...new Map(ranked.map((item) => [item.voiceType, item])).values()];
  if (gender) return deduped.slice(0, cap);
  if (lang !== 'zh') return deduped.slice(0, cap);
  // 普通话未指定性别时尽量保持男女候选均衡，再用其余健康音色补足上限。
  const male = deduped.filter((item) => item.gender === 'male');
  const female = deduped.filter((item) => item.gender === 'female');
  const balanced = [];
  for (let i = 0; balanced.length < cap && (i < male.length || i < female.length); i += 1) {
    if (male[i]) balanced.push(male[i]);
    if (female[i] && balanced.length < cap) balanced.push(female[i]);
  }
  return balanced.slice(0, cap);
}

export function getAvailableTemperamentOptions() {
  return Object.entries(TEMPERAMENTS)
    .filter(([key]) => Number.isInteger(ACTIVE_TEMPERAMENT_TENCENT[key]) && isTencentVoiceAvailable(ACTIVE_TEMPERAMENT_TENCENT[key]))
    .map(([key, info]) => {
      const voiceType = ACTIVE_TEMPERAMENT_TENCENT[key];
      const actualVoice = TENCENT_VOICE_CANDIDATES.find((candidate) => candidate.voiceType === voiceType && candidate.gender === info.gender);
      return { key, label: actualVoice?.label || info.label, gender: info.gender, voiceType };
    });
}

export function getTencentVoiceHealthSnapshot() {
  return [...VOICE_HEALTH.entries()].map(([voiceType, status]) => ({ voiceType, status }));
}

export function isTencentVoiceAvailable(voiceType) {
  // 新任务只允许明确探测 healthy 的音色；unknown / 未探测 / unavailable 一律拒绝。
  return VOICE_HEALTH.get(Number(voiceType)) === 'healthy';
}

/** 已排队任务遇到刚下架的音色时，按语言与性别即时换到已探测健康的候选音色。 */
export function getReplacementTencentVoiceType(voiceType, text = '') {
  const id = Number(voiceType);
  const candidate = TENCENT_VOICE_CANDIDATES.find((item) => item.voiceType === id);
  if (!candidate) return null;
  if (candidate.language === 'yue') {
    return [404000, 101019].find((voice) => voice !== id && isTencentVoiceAvailable(voice)) ?? null;
  }
  const sampleText = String(text);
  const englishText = /[a-zA-Z]{3,}/.test(sampleText) && !Array.from(sampleText).some((character) => {
    const code = character.codePointAt(0) || 0;
    return code >= 0x4e00 && code <= 0x9fa5;
  });
  if (englishText) {
    const englishReplacement = getAvailableEnglishVoice(candidate.gender);
    if (englishReplacement && englishReplacement !== id) return englishReplacement;
  }
  const slot = Object.entries(TEMPERAMENT_TENCENT).find(([, primary]) => primary === id);
  if (slot) {
    const activeReplacement = ACTIVE_TEMPERAMENT_TENCENT[slot[0]];
    if (activeReplacement && activeReplacement !== id && isTencentVoiceAvailable(activeReplacement)) return activeReplacement;
  }
  const backup = TENCENT_VOICE_CANDIDATES.find((item) =>
    item.voiceType !== id && item.gender === candidate.gender && item.language !== 'en' && item.language !== 'yue' && isTencentVoiceAvailable(item.voiceType),
  );
  return backup?.voiceType ?? null;
}

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
