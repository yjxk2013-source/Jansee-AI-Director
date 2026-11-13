// 简兮合成引擎 · bgm.js —— 背景音乐按「情绪文件夹」动态选曲 + 混音（精简版）
// 1) assets/bgm/ 下每个子文件夹即一种 BGM 情绪（30 个情绪目录 + generic 兜底）。
//    director.mjs 把情绪清单（BGM_EMOTIONS）喂给大模型，模型把选中的那个写进剧本的 bgm_emotion 字段。
// 2) 后端拿 script.bgm_emotion 直接当作文件夹名 → 读该文件夹里的 mp3 → 随机选 1 首。
// 已用排除 + 重置：内存保存 bgm_used，选不听过的；用满整池后清空重新随机，
//    保证连续 8 次同情绪不重复、第 9 次又从这些曲子里随机。不同情绪独立池互不干扰。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import { assetsDir } from '@jansee/shared/assetsPath.mjs';
import { BGM } from '@jansee/ffmpeg-kit/constitutionEffects.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const _assetsBase = assetsDir(ROOT);
const BGM_ROOT = fsSync.existsSync(path.join(_assetsBase, 'audio'))
  ? path.join(_assetsBase, 'audio')
  : path.join(_assetsBase, 'bgm');
const FALLBACK_FOLDER = 'generic';

// 百搭常规情绪集合：供口播、分镜直出等通用场景做全域均衡轮巡（覆盖百余首高质量曲库）
export const UNIVERSAL_BGM_EMOTIONS = [
  'relaxed',
  'fresh',
  'warm',
  'cozy',
  'playful',
  'inspirational',
  'energetic',
  'calm_narrative',
];

// 近义词与淘汰情绪重定向字典：确保大模型或前端传入近义词时精准分流到 8 大核心目录
export const MOOD_REDIRECT = {
  // 映射至 warm：hopeful（充满希望）贴近 warm 温暖气质
  hopeful: 'warm',
  // 映射至 cozy（治愈温暖目录）：healing 为 cozy 的近义词
  healing: 'cozy',
  // dreamy 已于 2026-10-12 升级为独立情绪目录，不再重定向
  // nostalgic / romantic 已于 2026-10-12 升级为独立情绪目录（materials/audio/），不再重定向
  // 映射至 calm_narrative
  weary: 'calm_narrative',
  lonely: 'calm_narrative',
  resigned: 'calm_narrative',
  zen: 'calm_narrative',
  // 映射至 tech_future
  suspense: 'tech_future',
  tense: 'tech_future',
  mysterious: 'tech_future',
  cold: 'tech_future',
  curious: 'tech_future',
  // 映射至 passionate
  proud: 'passionate',
  anger: 'passionate',
  // epic 已于 2026-10-12 升级为独立情绪目录（materials/audio/），不再重定向
  // 映射至 relaxed
  cheerful: 'relaxed',
  humorous: 'relaxed',
};

export function normalizeBgmEmotion(emotion) {
  const e = String(emotion || '').trim().toLowerCase();
  return MOOD_REDIRECT[e] || e;
}


// ==================== 本地自动配乐·LFU 最小播放次数 + 内容指纹持久化选曲 ====================
// 机制升级（解决选曲重复与永久冷宫问题）：
//   1) 音频 MD5 内容去重：曲库虽有同名/同曲跨目录副本，统一按音频哈希记账，彻底封堵撞歌；
//   2) 持久化播放账本（bgm_history.json）：记录每个音频哈希的累计播放次数与流水号，服务重启进度不丢；
//   3) 最小播放次数优先（LFU）：候选曲目中优先挑选 playCount 最小（如 0 次未播）的一档；
//      全池/本情绪所有独立曲目均播满 1 次后，才整体进入第 2 轮，数学上杜绝遗漏与死角；
//   4) 近期避让黑名单：在同档位候选曲目中，主动避让最近全局播放过的 15 首曲目；
//   5) 多情绪平滑轮巡：当传入多情绪候选时，优先调度平均播放次数最少的情绪目录。

const _md5Cache = new Map(); // absPath -> md5 hex string

function getTrackMd5(absPath) {
  if (_md5Cache.has(absPath)) return _md5Cache.get(absPath);
  try {
    const buf = fsSync.readFileSync(absPath);
    const hash = crypto.createHash('md5').update(buf).digest('hex');
    _md5Cache.set(absPath, hash);
    return hash;
  } catch {
    return path.basename(absPath);
  }
}

function resolveHistoryFile() {
  if (process.env.JX_DATA_DIR) {
    return path.join(path.resolve(process.env.JX_DATA_DIR), 'bgm_history.json');
  }
  const projectRoot = path.resolve(ROOT, '..');
  const serverDataDir = path.join(projectRoot, 'apps', 'web', 'server', 'data');
  if (fsSync.existsSync(serverDataDir)) {
    return path.join(serverDataDir, 'bgm_history.json');
  }
  return path.join(projectRoot, 'storage', 'data', 'bgm_history.json');
}

function loadHistory() {
  const file = resolveHistoryFile();
  try {
    if (fsSync.existsSync(file)) {
      const parsed = JSON.parse(fsSync.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return {
          hashes: parsed.hashes && typeof parsed.hashes === 'object' ? parsed.hashes : {},
          recent: Array.isArray(parsed.recent) ? parsed.recent : [],
          seq: Number(parsed.seq) || 0,
        };
      }
    }
  } catch { }
  return { hashes: {}, recent: [], seq: 0 };
}

function saveHistory(history) {
  const file = resolveHistoryFile();
  try {
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    fsSync.writeFileSync(file, JSON.stringify(history, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[bgm] 保存选曲历史失败（不影响出片）: ${e.message}`);
  }
}

/**
 * 获取曲库各情绪目录的历史播放统计（供导演层差异化或监控展示）
 */
export async function getBgmEmotionStats() {
  const history = loadHistory();
  const folders = await listBgmEmotionFolders();
  const stats = {};
  for (const folder of folders) {
    const tracks = await listTracks(folder);
    let totalPlays = 0;
    let unplayedCount = 0;
    for (const track of tracks) {
      const absPath = path.join(BGM_ROOT, folder, track);
      const hash = getTrackMd5(absPath);
      const playCount = Number(history.hashes[hash]?.playCount) || 0;
      totalPlays += playCount;
      if (playCount === 0) unplayedCount++;
    }
    stats[folder] = {
      totalTracks: tracks.length,
      totalPlays,
      unplayedCount,
      avgPlays: tracks.length ? (totalPlays / tracks.length).toFixed(2) : '0.00',
    };
  }
  return stats;
}

/**
 * 轮转选曲核心：给定按优先级的情绪文件夹列表（第一匹配在前），返回本次命中的曲目。
 * 机制：LFU 最小播放次数优先 + MD5 内容指纹排重 + 近期避让 + 持久化落盘。
 * @param {string[]} folderPriority  情绪文件夹名数组，如 ['passionate','luxury','cheerful']
 * @returns {Promise<{folder:string, track:string, match:number}|null>} 无可用曲目返回 null
 */
export async function pickBgmByPriorityChain(folderPriority = []) {
  // 过滤并重定向掉淘汰/近义词目录，形成实际 order
  const order = [];
  const folderTracks = {};
  for (const raw of folderPriority) {
    const f = normalizeBgmEmotion(raw);
    if (!order.includes(f)) {
      const t = await listTracks(f);
      if (t.length) {
        order.push(f);
        folderTracks[f] = t;
      }
    }
  }
  if (!order.length) return null;

  const history = loadHistory();
  const recentHashes = new Set(history.recent || []);

  // 为各目录构建候选曲目对象列表（含音频 MD5 和累计播放次数）
  const folderCandidateMap = {};
  for (const folder of order) {
    const tracks = folderTracks[folder] || [];
    folderCandidateMap[folder] = tracks.map((track) => {
      const absPath = path.join(BGM_ROOT, folder, track);
      const hash = getTrackMd5(absPath);
      const playCount = Number(history.hashes[hash]?.playCount) || 0;
      return { folder, track, hash, playCount, absPath };
    });
  }

  // 若传入多个候选情绪，按各目录的平均播放次数排序（优先选择累计播得最少的情绪目录）
  let targetOrder = [...order];
  if (targetOrder.length > 1) {
    targetOrder.sort((a, b) => {
      const candsA = folderCandidateMap[a] || [];
      const candsB = folderCandidateMap[b] || [];
      const avgA = candsA.reduce((sum, c) => sum + c.playCount, 0) / (candsA.length || 1);
      const avgB = candsB.reduce((sum, c) => sum + c.playCount, 0) / (candsB.length || 1);
      return avgA - avgB;
    });
  }

  // 从排序后的情绪目录中寻找可用曲目
  for (let idx = 0; idx < targetOrder.length; idx++) {
    const folder = targetOrder[idx];
    const candidates = folderCandidateMap[folder] || [];
    if (!candidates.length) continue;

    // ① LFU 最小播放次数筛选（保证全池曲目均播过 1 次后才进入第 2 次）
    const minPlayCount = Math.min(...candidates.map((c) => c.playCount));
    const minPool = candidates.filter((c) => c.playCount === minPlayCount);

    // ② 近期避让黑名单：在同档候选曲目中，剔除最近全局播放过的曲目 MD5（防连续出片撞歌）
    let eligiblePool = minPool.filter((c) => !recentHashes.has(c.hash));
    if (!eligiblePool.length) {
      eligiblePool = minPool; // 若该档全部在近期黑名单中，则回退为同档全集
    }

    // ③ 随机挑选 1 首
    const picked = eligiblePool[Math.floor(Math.random() * eligiblePool.length)];

    // ④ 更新持久化账本（记录 MD5、累计播放次数、流水号和最近历史）
    history.seq = (history.seq || 0) + 1;
    const currentCount = Number(history.hashes[picked.hash]?.playCount) || 0;
    history.hashes[picked.hash] = {
      playCount: currentCount + 1,
      lastPlayedSeq: history.seq,
      lastPlayedAt: new Date().toISOString(),
      folder: picked.folder,
      track: picked.track,
    };

    history.recent.push(picked.hash);
    while (history.recent.length > 20) {
      history.recent.shift(); // 保留最近 20 首全局防重
    }

    saveHistory(history);

    const originalMatchIdx = order.indexOf(picked.folder);
    return {
      folder: picked.folder,
      track: picked.track,
      match: originalMatchIdx >= 0 ? originalMatchIdx + 1 : idx + 1,
    };
  }

  return null;
}

// 列出曲库根目录下全部情绪文件夹（排除音效目录 *_sfx），供导演情绪名白名单校验与兜底顺延
const _SFX_DIR_RE = /_sfx$/i;
async function listBgmEmotionFolders() {
  let entries = [];
  try {
    entries = await fs.readdir(BGM_ROOT, { withFileTypes: true });
  } catch (e) {
    console.warn(`[bgm] 读取曲库根目录失败：${e.message}`);
    return [];
  }
  return entries
    .filter((d) => d.isDirectory() && !_SFX_DIR_RE.test(d.name))
    .map((d) => d.name)
    .sort();
}

// 读取某情绪文件夹里的 mp3 曲目（generic 为通用兜底曲库：跨情绪精选曲，直接全量取用）
async function listTracks(folder) {
  const dir = path.join(BGM_ROOT, folder);
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    console.warn(`[bgm] 读取 ${folder} 目录失败：${e.message}`);
    return [];
  }
  return names.filter((f) => /\.mp3$/i.test(f)).sort();
}

// 两段式音量滤镜（人声区间 duckVol 不抢戏，其余 baseVol 垫底）——供所有本地配乐入口复用
function buildDuckFilter(duckWindows, baseVol, duckVol) {
  const winExpr = duckWindows
    .filter((w) => w && typeof w.start === 'number' && typeof w.end === 'number')
    .map((w) => `between(t\\,${w.start.toFixed(2)}\\,${w.end.toFixed(2)})`)
    .join('+');
  if (winExpr) {
    // 人声区间 → duckVol，其余 → baseVol；两个 volume 之间不标中间输出（避免 FFmpeg unconnected output）
    return `[bgm]volume=enable='${winExpr}':volume=${duckVol},volume=enable='1-(${winExpr})':volume=${baseVol}[bgmout]`;
  }
  return `[bgm]volume=${baseVol}[bgmout]`;
}

/**
 * 按大模型给出的 bgm_emotion（情绪文件夹名）选曲并生成 FFmpeg 滤镜链
 * 两段式音量：配音区间（duckWindows）压低到 duckVol 保证人声清晰，
 * 其余（含句间停顿 / 纯呼吸镜）恢复到 baseVol 正常垫底——有张有弛，不再全程一个音量。
 * @param {string}  bgmEmotion  剧本里的情绪文件夹名，如 'warm'/'passionate'/'tense'
 * @param {Array<{start,end}>}  duckWindows  配音区间（其间压低 BGM 保证人声清晰）
 * @returns {Promise<{bgmPath, filterChain, folder, track} | null>}
 *   filterChain 以 [bgm] 为输入占位符、[bgmout] 为输出
 */
export async function selectBgmByEmotion(bgmEmotion = '', duckWindows = []) {
  const folders = await listBgmEmotionFolders();
  const rawEmotion = String(bgmEmotion || '').trim();

  // 若传入的是 'cheerful'（口播/分镜直出通用配乐标记），直接进入 8 大百搭常规情绪链，全域均衡轮巡
  let folderPriority = [];
  if (rawEmotion === 'cheerful' || rawEmotion === 'universal') {
    folderPriority = UNIVERSAL_BGM_EMOTIONS.filter((f) => folders.includes(f));
  } else if (rawEmotion.includes(',')) {
    // 兼容逗号分隔的多情绪链
    folderPriority = rawEmotion.split(',').map((s) => normalizeBgmEmotion(s)).filter((f) => folders.includes(f));
  }

  if (!folderPriority.length) {
    const emotion = normalizeBgmEmotion(rawEmotion);
    const folder = folders.includes(emotion)
      ? emotion
      : folders.includes(FALLBACK_FOLDER)
        ? FALLBACK_FOLDER
        : folders[0] || FALLBACK_FOLDER;
    folderPriority = [folder];
  }

  // 走共享轮转核心（LFU 最小播放次数 + 内容哈希排重 + 近期避让）
  const picked = await pickBgmByPriorityChain(folderPriority);
  if (!picked) {
    console.warn(`[bgm] ${folderPriority.join('/')} 无可用 BGM，跳过背景乐`);
    return null;
  }
  const bgmPath = path.join(BGM_ROOT, picked.folder, picked.track);
  return {
    bgmPath,
    filterChain: buildDuckFilter(duckWindows, BGM.baseVol, BGM.duckVol),
    folder: picked.folder,
    track: picked.track,
  };
}

// 2026-10-23：删掉零引用的 selectLocalBgmByPriority（情绪优先级链入口）。
// 运行时选曲只有两条真入口：selectBgmByEmotion（按情绪选）与 selectBgmByPath（用户指定曲目）。

/**
 * 按「用户指定的具体曲目路径」构建 BGM 混音滤镜（不随机、不读曲库）。
 * 用于板块③口播视频：用户在前端从候选里选定某首 BGM 后，用其绝对路径生成两段式（duck）滤镜。
 * @param {string} bgmPath  BGM mp3 绝对路径
 * @param {Array<{start,end}>} [duckWindows]  人声区间（其间压低 BGM 不抢戏）
 * @returns {Promise<{bgmPath, filterChain, folder, track} | null>}
 */
export async function selectBgmByPath(bgmPath = '', duckWindows = []) {
  const abs = String(bgmPath || '').trim();
  if (!abs?.toLowerCase().endsWith('.mp3')) {
    console.warn('[bgm] selectBgmByPath 收到非法路径，跳过背景乐');
    return null;
  }
  let folder = 'custom';
  let track = path.basename(abs);
  try {
    const rel = path.relative(BGM_ROOT, abs).split(path.sep).join('/');
    const parts = rel.split('/');
    if (parts.length >= 2) {
      folder = parts[0];
      track = parts[parts.length - 1];
    }
  } catch (_e) {
    /* 忽略 */
  }

  const baseVol = BGM.baseVol; // 无人声区间（宪法 6.2 条：BGM 仅作垫底）
  const duckVol = BGM.duckVol; // 人声区间压低（宪法 6.2 条：人声突出、BGM 明显避让）
  const winExpr = (duckWindows || [])
    .filter((w) => w && typeof w.start === 'number' && typeof w.end === 'number')
    .map((w) => `between(t\\,${w.start.toFixed(2)}\\,${w.end.toFixed(2)})`)
    .join('+');

  let filter;
  if (winExpr) {
    filter = `[bgm]volume=enable='${winExpr}':volume=${duckVol},volume=enable='1-(${winExpr})':volume=${baseVol}[bgmout]`;
  } else {
    filter = `[bgm]volume=${baseVol}[bgmout]`;
  }

  return { bgmPath: abs, filterChain: filter, folder, track };
}
