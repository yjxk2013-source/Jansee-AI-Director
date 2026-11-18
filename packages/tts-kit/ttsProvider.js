// 简兮 · TTS 配音供应商抽线层（ttsProvider.js）
// 目标：把「配音合成」做成可切换供应商的统一接口。换供应商只需改环境变量，不重写合成逻辑。
//
// 使用方式（环境变量）：
//   JX_TTS_PROVIDER=<provider>      选择供应商；默认腾讯云(Tencent)。
//   每个付费供应商再读各自的 key（见下）。
//   定版（2026-10-12）：微软 Edge TTS 已彻底移除——不可商用且常态被风控 403，兜底价值为零。
//
// 供应商统一接口（provider.synthesize）：
//   synthesize({ text, mood, voiceId, outPath }) -> Promise<{ ok: boolean, reason?: string }>
//     - text      要合成的文本
//     - mood      情绪（语义线索，供供应商内部映射音色，可为空）
//     - voiceId   语义音色 id（微软命名 ShortName 为全系统语义音色名，腾讯/硅基在 provider 内翻译）
//     - outPath   合成音频写到哪个绝对路径（.mp3）
//     - 返回 { ok:true } 表示成功；{ ok:false, reason } 表示失败并附原因。
//
// 新增一个供应商的步骤：
//   1. 实现 synthesize（真实调用该厂商 SDK / HTTP）
//   2. 在此文件底部 registerTTSProvider({ name, label, synthesize }) 注册
//   3. （可选）在 provider 内做 voiceId 翻译：把语义 voiceId 映射到该厂商可用的音色。
// 注册后即可通过 JX_TTS_PROVIDER 一键切换。

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

// 默认供应商：腾讯云 TTS（精品音色，800 万字符免费额度）
// 唯一供应商=腾讯云；JX_TTS_PROVIDER 环境变量仅保留兼容读取，非 tencent 值警告并忽略。
// —— 注册表 ——
const registry = new Map();

// —— ffmpeg atempo 变速（保留音调的时间拉伸，0.5~2.0/级）——
// 用途：部分付费音色（如腾讯精品音色 101xxx）原生不支持/几乎不吃 Speed 参数，
// 用 atempo 后处理实现「真实、线性、保留音调」的语速调整，覆盖 LLM 四档（0.85~1.3）。
function runFfmpeg(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegStatic, args, { cwd, maxBuffer: 200 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const tail = String(stderr || '')
          .split('\n')
          .slice(-6)
          .join(' ')
          .trim();
        reject(new Error(tail || err.message));
        return;
      }
      resolve();
    });
  });
}
// rate>1 加速、rate<1 减速；ffmpeg 单条 atempo 仅支持 0.5~2.0，超出链式分解。
async function applyAtempo(filePath, rate) {
  const r = Math.min(rate, 50);
  const absPath = path.resolve(filePath);
  const dir = path.dirname(absPath);
  const ext = path.extname(absPath) || '.mp3';
  const tmp = path.join(dir, `.tmp_atempo_${Date.now()}${ext}`);
  const factors = [];
  let cur = r;
  while (cur > 2.0) {
    factors.push('2.000');
    cur /= 2.0;
  }
  while (cur < 0.5) {
    factors.push('0.500');
    cur /= 0.5;
  }
  if (Math.abs(cur - 1) > 0.001) factors.push(cur.toFixed(3));
  if (factors.length === 0) return; // 无需变速
  const filter = factors.map((f) => `atempo=${f}`).join(',');
  try {
    await runFfmpeg(['-nostdin', '-y', '-i', absPath, '-filter:a', filter, tmp], dir);
    await fs.rename(tmp, absPath);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/**
 * 注册一个 TTS 供应商。
 * @param {{ name: string, label: string, synthesize: Function }} provider
 *   name: 唯一标识（收敛定版后仅 'tencent'）
 *   label: 人类可读描述
 *   synthesize: 见文件头接口注释
 */
export function registerTTSProvider(provider) {
  if (!provider || typeof provider.name !== 'string' || typeof provider.synthesize !== 'function') {
    console.warn('[TTS] 注册供应商参数非法，已忽略之一（需 name + synthesize）');
    return;
  }
  registry.set(provider.name.toLowerCase(), provider);
}

/**
 * 解析当前激活的供应商。收敛定版（2026-10-24）：唯一供应商=腾讯云。
 * JX_TTS_PROVIDER 若配置了非 tencent 的值，仅警告并忽略（不再支持多供应商主备链）。
 */
export function resolveTTSProvider() {
  const envChain = String(process.env.JX_TTS_PROVIDER || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (envChain.some((n) => n !== 'tencent')) {
    console.warn(`[TTS] JX_TTS_PROVIDER=${envChain.join(',')} 含非 tencent 供应商，已忽略（唯一供应商=腾讯云）。`);
  }
  const hit = registry.get('tencent');
  if (!hit) throw new Error('TTS 供应商未初始化：腾讯云供应商未注册。');
  return { provider: hit, fallbacks: [], all: [hit] };
}

// ============ 唯一供应商：腾讯云 TTS（精品音色，800 万字符免费额度）============
// 走腾讯云 API 3.0（TC3-HMAC-SHA256 签名）调 tts.tencentcloudapi.com 的 TextToVoice。
// 精品/基础音色共享「通用语音合成」800 万字符免费额度：只开免费档、填好密钥即可用，无需充值。
// 需在 .env 配：JX_TTS_TENCENT_SECRET_ID / JX_TTS_TENCENT_SECRET_KEY。
// 说明：此接口单次最多约 150 汉字；引擎已按句拆分调用，天然满足。
// 收敛定版（2026-10-24）：多供应商注册表/主备链/硅基/Edge 遗留映射全删——合成只有腾讯一条路。

// 懒加载腾讯官方 SDK（体积大，仅在使用腾讯供应商时才载入一次）。
let tencentSdkReady = null;
async function loadTencentClient() {
  if (tencentSdkReady) return tencentSdkReady;
  const sdk = await import('tencentcloud-sdk-nodejs');
  const ttsModule = sdk.tts ?? sdk.default?.tts;
  const TtsClient = ttsModule?.v20190823?.Client;
  if (typeof TtsClient !== 'function') {
    throw new Error('腾讯云 SDK 未提供 TTS v20190823 客户端，请检查 tencentcloud-sdk-nodejs 安装版本。');
  }
  const secretId = String(process.env.JX_TTS_TENCENT_SECRET_ID || '').trim();
  const secretKey = String(process.env.JX_TTS_TENCENT_SECRET_KEY || '').trim();
  if (secretId.length < 8 || secretKey.length < 8) {
    throw new Error('腾讯云 TTS 未配置 JX_TTS_TENCENT_SECRET_ID / SECRET_KEY，无法使用。');
  }
  tencentSdkReady = new TtsClient({
    credential: { secretId, secretKey },
    region: '',
    profile: { httpProfile: { endpoint: 'tts.tencentcloudapi.com', reqTimeout: 120 } },
  });
  return tencentSdkReady;
}

/** 对指定腾讯 VoiceType 做真实合成探测，不写入用户作品，也不经过语义映射。 */
export async function probeTencentVoiceType(voiceType, language = 'zh') {
  const startedAt = Date.now();
  try {
    const client = await loadTencentClient();
    const text = language === 'en'
      ? 'Hello, this is a short voice availability test.'
      : language === 'yue'
        ? '\u4eca\u65e5\u5929\u6c23\u5e7e\u597d\uff0c\u6b61\u8fce\u4f7f\u7528\u7cb5\u8a9e\u914d\u97f3\u3002'
        : '\u4eca\u5929\u5929\u6c14\u5f88\u597d\uff0c\u6b22\u8fce\u4f7f\u7528\u8bed\u97f3\u5408\u6210\u3002';
    const response = await client.TextToVoice({
      Text: text,
      SessionId: randomUUID(),
      ModelType: 1,
      VoiceType: Number(voiceType),
      Codec: 'mp3',
      SampleRate: 16000,
      Volume: 0,
      Speed: 1,
      PrimaryLanguage: language === 'en' ? 2 : 1,
      EnableSubtitle: false,
    });
    const audioBytes = Buffer.from(String(response?.Audio || ''), 'base64');
    if (audioBytes.length < 512) {
      return { ok: false, errorCode: 'EMPTY_AUDIO', reason: '腾讯云返回的音频数据为空或过短。', latencyMs: Date.now() - startedAt };
    }
    return { ok: true, bytes: audioBytes.length, requestId: response?.RequestId || null, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      errorCode: String(error?.code || error?.Code || 'TTS_PROBE_ERROR'),
      reason: String(error?.message || error).slice(0, 240),
      latencyMs: Date.now() - startedAt,
    };
  }
}

const tencentProvider = {
  name: 'tencent',
  label: '腾讯云 TTS（精品音色，800万免费额度）',
  async synthesize({ text, voiceId, outPath, speed }) {
    if (!text) return { ok: false, reason: '待配音文本为空。' };
    let client;
    try {
      client = await loadTencentClient();
    } catch (e) {
      return { ok: false, reason: String(e?.message || e).slice(0, 200) };
    }
    const voiceType = Number(voiceId);
    if (!Number.isInteger(voiceType) || voiceType <= 0) return { ok: false, reason: `无效的腾讯 TTS VoiceType：${String(voiceId)}` };
    // 语速(LLM判定)：正常档=1.0 对应「4字/秒」基准。
    // 【关键】腾讯精品音色(101xxx)原生 Speed 几乎不生效（0.6~1.5 实测时长变化极小、被压扁），
    // 故这里请求固定 Speed=1，用 ffmpeg atempo 后处理实现真实保留音调的变速。
    // 放缓基准 JX_TTS_TENCENT_SPEED_BASE（实测 腾讯原生/微软原生 = 9.50s/12.02s ≈ 0.79，默认 0.79）
    // 使 speech_speed=1.0（正常）时腾讯输出语速与行业基准一致；LLM 各档位在此基准上等比缩放。
    const TS_BASE = (() => {
      const v = parseFloat(process.env.JX_TTS_TENCENT_SPEED_BASE || '');
      return Number.isFinite(v) && v > 0 ? v : 0.79;
    })();
    const eff = Number(speed) > 0 ? Number(speed) * TS_BASE : TS_BASE; // atempo 实际倍率
    const isEng = voiceType === 402000 || voiceType === 402002 || voiceType === 1050 || voiceType === 1051 || (/[a-zA-Z]{3,}/.test(text) && !/[\u4e00-\u9fa5]/.test(text));
    try {
      const resp = await client.TextToVoice({
        Text: text,
        SessionId: randomUUID(),
        ModelType: 1,
        VoiceType: voiceType,
        Codec: 'mp3',
        SampleRate: 16000,
        Volume: 2,
        Speed: 1, // 固定 1，变速交给 atempo
        PrimaryLanguage: isEng ? 2 : 1,
        EnableSubtitle: false,
      });
      const audio = String(resp?.Audio || '');
      if (!audio) return { ok: false, reason: '腾讯云 TTS 未返回音频数据。' };
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, Buffer.from(audio, 'base64'));
      if (Math.abs(eff - 1) > 0.001) await applyAtempo(outPath, eff); // 保留音调的真实变速
      return { ok: true };
    } catch (err) {
      const code = String(err?.code || err?.Code || '');
      return { ok: false, reason: `腾讯云 TTS 错误 [${code}]: ${String(err?.message || err).slice(0, 200)}` };
    }
  },
};

// LLM 优先返回腾讯真实 VoiceType 数字 ID；旧语义 key 仅为历史任务兼容，不再静默猜测。
import { isTemperament, TEMPERAMENT_TENCENT, ACTIVE_TEMPERAMENT_TENCENT, TENCENT_VOICE_CANDIDATES, isTencentVoiceAvailable, getReplacementTencentVoiceType, getAvailableEnglishVoice } from './voices.js';

function mapSemanticVoiceToTencent(voiceId, text = '') {
  const v = String(voiceId || '').trim();
  const direct = {
    cantonese: 404000,
    'english-female': 402000,
    '1051': 402000,
    'english-male': 402002,
    '1050': 402002,
    english: 402000,
  };
  if (Object.prototype.hasOwnProperty.call(direct, v)) {
    const voiceType = direct[v];
    if (isTencentVoiceAvailable(voiceType)) return voiceType;
    if (['english-female', '1051', 'english'].includes(v)) {
      const englishReplacement = getAvailableEnglishVoice('female');
      if (englishReplacement) return englishReplacement;
    }
    if (['english-male', '1050'].includes(v)) {
      const englishReplacement = getAvailableEnglishVoice('male');
      if (englishReplacement) return englishReplacement;
    }
    const replacement = getReplacementTencentVoiceType(voiceType, text);
    if (replacement) return replacement;
    throw new Error(`TTS_VOICE_UNAVAILABLE: 腾讯音色 ${voiceType} 当前不可用且没有同语种替补`);
  }
  if (isTemperament(v) && !/^\d{4,9}$/.test(v)) {
    const voiceType = ACTIVE_TEMPERAMENT_TENCENT[v];
    if (Number.isInteger(voiceType) && isTencentVoiceAvailable(voiceType)) return voiceType;
    const replacement = getReplacementTencentVoiceType(TEMPERAMENT_TENCENT[v], text);
    if (replacement) return replacement;
    throw new Error(`TTS_VOICE_UNAVAILABLE: 音色 ${v} 暂无可用的腾讯替补音色`);
  }
  if (/^\d{4,9}$/.test(v)) {
    const voiceType = Number(v);
    if (!TENCENT_VOICE_CANDIDATES.some((candidate) => candidate.voiceType === voiceType)) {
      throw new Error(`TTS_VOICE_ID_UNKNOWN: 腾讯音色 ID ${voiceType} 不在白名单中`);
    }
    if (isTencentVoiceAvailable(voiceType)) return voiceType;
    const replacement = getReplacementTencentVoiceType(voiceType, text);
    if (replacement) return replacement;
    throw new Error(`TTS_VOICE_UNAVAILABLE: 腾讯音色 ID ${voiceType} 当前不可用且没有同语种替补`);
  }
  const legacy = {
    'zh-cn-yunyangneural': 403010,
    'zh-cn-yunjianneural': 402002,
    'zh-cn-yunxiineural': 403012,
    'zh-cn-yunxianeural': 403009,
    'zh-cn-xiaoxioneural': 402001,
    'zh-cn-xiaoyineural': 403014,
    'zh-hk-hiugaaineural': 404000,
    'zh-hk-hiumaanneural': 404000,
    'zh-cn-liaoning-xiaobeineural': 402001,
    'zh-cn-shaanxi-xiaonineural': 403014,
    'zh-tw-yunjheneural': 402002,
    'zh-tw-hsiaochenneural': 402001,
    'zh-tw-hsiaoyuneural': 403014,
  };
  const legacyVoice = legacy[v.toLowerCase()];
  if (legacyVoice) return mapSemanticVoiceToTencent(String(legacyVoice));
  throw new Error(`TTS_VOICE_ID_UNKNOWN: 未登记的腾讯音色 ID：${v || '(empty)'}`);
}

export function mapVoiceFor(_providerName, voiceId, text = '') {
  return mapSemanticVoiceToTencent(voiceId, text);
}

// —— 注册：仅腾讯一家 ——
registerTTSProvider(tencentProvider);

// 兜底说明：未知音色必须显式失败，禁止静默变成默认女声。
