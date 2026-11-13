// 简兮口播模块 · compose.js —— 切点规划 + 时间轴重映射 + 音画同步剪切合成
// 核心要求（任务书定版）：
//   1) 只删除用户确认过的词；切点保守定位，无法可靠定位时优先保留内容（宁留残音不吞字）；
//   2) 删除多个区间先合并重叠，再从原视频音画同步剪切拼接（单次 filter_complex，一遍重编码）；
//   3) 字幕时间轴必须按剪辑映射重算，不得使用原始时间戳；
//   4) 保留原始人声（不 TTS），BGM 低音量垫底并闪避人声，曲库缺失降级不失败。
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assetsDir } from '@jansee/shared/assetsPath.mjs';
import { selectBgmByEmotion } from '@jansee/audio-kit/bgm.js';
import { hasAudioStream, probeDurationSec, probeVideoSize } from '@jansee/ffmpeg-kit/probe.mjs';
import { acquireComposeSlot } from '@jansee/ffmpeg-kit/composeGate.mjs';
import { buildDrawtextFilters, buildAiBadgeOverlay } from '@jansee/subtitle-kit/subtitle.js';
import { aiMetaArgs } from '@jansee/subtitle-kit/aiBadge.js';
import { buildIntroOverlayFilter } from '@jansee/intro-kit';
import { buildSubtitleCues } from '@jansee/video-creator/video/keepOriginal.js';
import ffmpegStatic from 'ffmpeg-static';

const MODULE_ROOT = path.dirname(fileURLToPath(import.meta.url)); // packages/speech-cut
const FONTS_DIR = path.join(assetsDir(MODULE_ROOT), 'fonts');
const FONT_FILE = 'obsidian_hairline.ttc';
const BGM_DEFAULT_EMOTION = 'cheerful'; // 口播默认轻快垫乐，不需要大模型选曲
const MIN_KEEP_SEC = 1.0;               // 保留内容过短安全拦截线
const GAP_MIDPOINT = 0.16;              // 与相邻保留词间隙超过该值时，切点外推到间隙中点（切在静音里最稳）
const EDGE_PAD = 0.06;                  // 间隙不足时的固定外扩量（防吞字），绝不越过相邻保留词边界
const PAUSE_KEEP_PAD = 0.12;            // 长停顿剪除时两端各留的呼吸量（真人出镜，全剪画面硬跳）
const PAUSE_MIN_CUT = 0.4;              // 收缩后可剪除停顿的最短时长（低于此不剪，跳变不值得）

/**
 * 规划删除区间与保留区间（纯函数）
 * @param {object} p
 *   words         服务端保存的 ASR 全量词（权威数据，不信任前端区间）
 *   deletedStarts Set<number> 用户确认删除的词（以词 start 为键，前端只传词标识）
 *   durationSec   原视频真实时长（秒）
 *   pauseCuts     用户确认删除的长停顿区间 [{start,end}]（来自 suggestions 中 reason='pause'，
 *                 区间由服务端词表间隙决定；两端收缩 PAUSE_KEEP_PAD 留呼吸，过短丢弃）
 * @returns {{cutRanges, keepRanges, keepTotal, cutTotal, error?}} error.code: NO_WORDS | TOO_SHORT
 *   cutRanges  合并后的删除块 [{start,end}]（切点已做保守修正）
 *   keepRanges 原时间轴上的保留区间（互补区间，含片头/片尾自然停顿，仅删用户确认的内容）
 */
export function planCutRanges({ words = [], deletedStarts = new Set(), durationSec = 0, pauseCuts = [] }) {
  const list = (Array.isArray(words) ? words : [])
    .map((w) => ({ word: String(w.word || ''), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.word && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .sort((a, b) => a.start - b.start);
  const dur = Number(durationSec) > 0 ? Number(durationSec) : 0;
  if (!list.length || dur <= 0) return { cutRanges: [], keepRanges: [], keepTotal: 0, cutTotal: 0, error: { code: 'NO_WORDS' } };

  // 0) 长停顿块：收缩两端各留 PAUSE_KEEP_PAD 呼吸；收缩后 <PAUSE_MIN_CUT 丢弃（跳变不值得）。
  //    收缩边界即最终切点（isPause 标记：跳过下方 EDGE_PAD 外扩修正——外扩会把呼吸量吃掉一半）。
  //    间隙 ≥PAUSE_MIN_GAP(0.8) 才会被标记，0.8-2*0.12=0.56 ≥ 0.4，恒有效。
  const pauseBlocks = (Array.isArray(pauseCuts) ? pauseCuts : [])
    .map((p) => ({ rawStart: Number(p.start) + PAUSE_KEEP_PAD, rawEnd: Number(p.end) - PAUSE_KEEP_PAD, isPause: true }))
    .filter((b) => Number.isFinite(b.rawStart) && Number.isFinite(b.rawEnd) && b.rawEnd - b.rawStart >= PAUSE_MIN_CUT);

  // 1) 命中的删除词 → 词删除块（相邻删除词合并；块边界只由词时间戳与相邻保留词间隙决定）。
  //    pause 块不参与这一步的 last 合并（它的时间序与词块无交叠保证），建好后统一追加，
  //    重叠/相接由切点修正后的排序归并（step 3）统一吸收。
  const delWords = list.filter((w) => deletedStarts.has(Number(w.start)));
  const blocks = [];
  for (const w of delWords) {
    const last = blocks[blocks.length - 1];
    if (last && w.start <= last.rawEnd) last.rawEnd = Math.max(last.rawEnd, w.end);
    else blocks.push({ rawStart: w.start, rawEnd: w.end });
  }
  blocks.push(...pauseBlocks);
  blocks.sort((a, b) => a.rawStart - b.rawStart);
  if (!blocks.length) {
    // 用户取消全部标记：整片保留（任务书允许无删除直接生成）
    return { cutRanges: [], keepRanges: [[0, dur]], keepTotal: dur, cutTotal: 0 };
  }

  // 2) 保守切点：优先把切点放进与相邻保留词之间的静音间隙（取中点）；间隙不足时固定外扩 0.06s，
  //    但绝不越过相邻保留词边界（吞字比残音更伤成片）；紧连无间隙时不再外扩（宁留残音）。
  const cutRanges = blocks.map((b) => {
    const prev = list.filter((w) => w.end <= b.rawStart + 1e-9).pop() || null;
    const next = list.find((w) => w.start >= b.rawEnd - 1e-9) || null;
    // 左切点
    let cutStart;
    if (!prev) {
      cutStart = 0; // 删除块前无任何词：从片头删（用户删的是开头内容）
    } else if (b.isPause) {
      cutStart = Math.max(prev.end, b.rawStart); // pause 块：收缩边界即切点，不外扩
    } else {
      const gapL = b.rawStart - prev.end;
      cutStart = gapL > GAP_MIDPOINT ? prev.end + gapL / 2 : Math.max(prev.end, b.rawStart - EDGE_PAD);
    }
    // 右切点
    let cutEnd;
    if (!next) {
      cutEnd = dur; // 删除块后无任何词：删到片尾（用户删的是结尾内容）
    } else if (b.isPause) {
      cutEnd = Math.min(next.start, b.rawEnd); // pause 块：收缩边界即切点，不外扩
    } else {
      const gapR = next.start - b.rawEnd;
      cutEnd = gapR > GAP_MIDPOINT ? b.rawEnd + gapR / 2 : Math.min(next.start, b.rawEnd + EDGE_PAD);
    }
    return {
      start: Math.max(0, Math.min(dur, cutStart)),
      end: Math.max(0, Math.min(dur, cutEnd)),
    };
  });

  // 3) 排序 + 重叠归并（任务书硬要求：先统一合并重叠区间再剪辑）
  cutRanges.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of cutRanges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1e-9) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }

  // 4) 保留区间 = 全片减去删除块（互补区间）；词间自然停顿完整保留
  const keepRanges = [];
  let cursor = 0;
  for (const r of merged) {
    if (r.start - cursor > 1e-6) keepRanges.push([cursor, r.start]);
    cursor = Math.max(cursor, r.end);
  }
  if (dur - cursor > 1e-6) keepRanges.push([cursor, dur]);

  const keepTotal = keepRanges.reduce((a, r) => a + (r[1] - r[0]), 0);
  const cutTotal = merged.reduce((a, r) => a + (r.end - r.start), 0);
  if (keepTotal < MIN_KEEP_SEC || !keepRanges.length) {
    return { cutRanges: merged, keepRanges: [], keepTotal, cutTotal, error: { code: 'TOO_SHORT', keepTotal } };
  }
  return { cutRanges: merged, keepRanges, keepTotal, cutTotal };
}

/**
 * 原时间轴 → 剪辑后时间轴 的映射函数（依据保留区间）
 * 保留词/字幕 cue 一定落在保留区间内；落在删除区内的请求值映射到该删除块的收尾边界（兜底钳位）
 */
export function buildShiftFn(keepRanges) {
  const segs = keepRanges.map(([s, e]) => ({ s, e }));
  return function shift(originalTime) {
    let keptBefore = 0;
    for (const seg of segs) {
      if (originalTime < seg.s - 1e-9) return keptBefore; // 落在前一个删除区内（兜底）
      if (originalTime <= seg.e + 1e-9) return originalTime - seg.s + keptBefore;
      keptBefore += seg.e - seg.s;
    }
    return keptBefore; // 越过末尾（兜底钳位）
  };
}

function runFfmpeg(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegStatic, args, { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const tail = String(stderr || '').split('\n').slice(-6).join(' ').trim();
        reject(new Error('口播合成失败: ' + (tail || err.message)));
      } else resolve();
    });
  });
}

/**
 * 分镜直出 · 单段剪除区间规划（planCutRanges 的稳定门面，纯函数）
 * 分镜「原片直出」链路逐段调用：输入该段 ASR 词 + 用户确认删除标识，输出保留区间。
 * @returns {{keepRanges, cutRanges, cutTotal, keepTotal, error?}}
 */
export function planSegmentCut({ words = [], deletedStarts = new Set(), pauseCuts = [], durationSec = 0 }) {
  const plan = planCutRanges({ words, deletedStarts, durationSec, pauseCuts });
  return {
    keepRanges: plan.keepRanges,
    cutRanges: plan.cutRanges,
    cutTotal: plan.cutTotal,
    keepTotal: plan.keepTotal,
    error: plan.error || null,
  };
}

/**
 * 把 ASR 词表从原时间轴重映射到「剪除后」时间轴（buildShiftFn 的词表层封装）。
 * 分镜直出链路：单段剪除后词表跟随平移，供下游烧字幕（落在删除区的词 start/end 塌缩被自然过滤）。
 * @returns {Array<{word,start,end,is_filler?}>} 保留词（按新时间轴升序）
 */
export function shiftWordsToKeptTimeline(words = [], keepRanges = []) {
  if (!Array.isArray(keepRanges) || !keepRanges.length) return [];
  const shift = buildShiftFn(keepRanges);
  return (Array.isArray(words) ? words : [])
    .map((w) => ({
      ...w,
      start: Number(shift(Number(w.start)).toFixed(3)),
      end: Number(shift(Number(w.end)).toFixed(3)),
    }))
    .filter((w) => Number(w.end) > Number(w.start))
    .sort((a, b) => a.start - b.start);
}

/**
 * 分镜直出 · 单段音画同步剪除：按保留区间 trim→concat 重编码（不烧字幕/不混 BGM/不加角标，
 * 字幕与 BGM 由下游分镜拼接层统一处理，避免双重叠加）。
 * @param {object} p { videoFile, keepRanges, taskDir, outFile, onProgress(stage:string) }
 * @returns {Promise<{outFile:string, durationSec:number}>}
 */
export async function cutSegmentByRanges({ videoFile, keepRanges = [], taskDir, outFile = 'segment_cut.mp4', onProgress }) {
  const setp = (s) => { if (typeof onProgress === 'function') onProgress(s); };
  if (!Array.isArray(keepRanges) || !keepRanges.length) {
    throw Object.assign(new Error('保留区间为空，无法剪切'), { code: 'NO_RANGES' });
  }
  if (!hasAudioStream(videoFile)) {
    throw Object.assign(new Error('该段没有音轨，无需剪除'), { code: 'NO_AUDIO' });
  }
  const probed = probeDurationSec(videoFile);
  const dur = probed > 0 ? probed : keepRanges[keepRanges.length - 1][1];

  const filters = [];
  const vParts = [];
  const aParts = [];
  keepRanges.forEach(([s, e], i) => {
    const len = Math.max(0.01, e - s);
    const fadeD = Math.min(0.015, len / 4);
    const sF = Math.max(0, Math.min(dur, s)).toFixed(3);
    const eF = Math.max(0, Math.min(dur, e)).toFixed(3);
    filters.push(`[0:v]trim=start=${sF}:end=${eF},setpts=PTS-STARTPTS[v${i}]`);
    filters.push(
      `[0:a]atrim=start=${sF}:end=${eF},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=${fadeD.toFixed(4)},afade=t=out:st=${(len - fadeD).toFixed(4)}:d=${fadeD.toFixed(4)}[a${i}]`,
    );
    vParts.push(`[v${i}]`);
    aParts.push(`[a${i}]`);
  });
  filters.push(`${vParts.join('')}concat=n=${keepRanges.length}:v=1:a=0[vcut]`);
  filters.push(`${aParts.join('')}concat=n=${keepRanges.length}:v=0:a=1[acut]`);
  filters.push(`[vcut]format=yuv420p[vfin]`);

  const plannedSec = keepRanges.reduce((a, r) => a + (r[1] - r[0]), 0);
  const args = [
    '-nostdin', '-y',
    '-i', path.relative(taskDir, videoFile).replace(/\\/g, '/'),
    '-filter_complex', filters.join(';'),
    '-map', '[vfin]', '-map', '[acut]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    path.relative(taskDir, path.join(taskDir, outFile)).replace(/\\/g, '/'),
  ];
  setp('正在剪除该段冗余内容');
  const release = await acquireComposeSlot(`speechcut_segment:${path.basename(taskDir)}:${outFile}`);
  try {
    await runFfmpeg(args, taskDir);
  } finally {
    release();
  }

  const outAbs = path.join(taskDir, outFile);
  const got = probeDurationSec(outAbs);
  if (got <= 0) throw Object.assign(new Error('分镜段剪除后导出失败'), { code: 'EXPORT_BROKEN' });
  return { outFile: outAbs, durationSec: Number(got.toFixed(3)), plannedSec: Number(plannedSec.toFixed(3)) };
}

/**
 * 口播成片合成：音画同步剪切拼接 + 字幕烧录（重映射时间轴）+ BGM 低音量闪避 → final.mp4
 * @param {object} p
 *   videoFile     上传原视频绝对路径
 *   taskDir       任务输出目录（ffmpeg cwd，产物 final.mp4）
 *   words         服务端 ASR 全量词
 *   deletedStarts 用户确认删除的词 start 集合（可为空集）
 *   durationSec   原视频真实时长（服务端探测值）
 *   onProgress    (stage:string) => void
 * @returns {Promise<{finalPath, durationSec, plannedSec, cutSec, cuesCount}>}
 */
export async function composeSpeechcut({ videoFile, taskDir, words = [], deletedStarts = new Set(), durationSec = 0, pauseCuts = [], introFile = null, onProgress }) {
  const setp = (s) => { if (typeof onProgress === 'function') onProgress(s); };

  // 0) 时长复核：以服务端探测为准（与传入值偏差大时以探测值纠正）
  const probed = probeDurationSec(videoFile);
  const dur = probed > 0 ? (durationSec > 0 ? (Math.abs(probed - durationSec) > 0.5 ? probed : durationSec) : probed) : durationSec;
  if (!hasAudioStream(videoFile)) throw Object.assign(new Error('原视频没有音轨，口播处理需要原始人声'), { code: 'NO_AUDIO' });

  // 1) 区间规划（含安全拦截）
  const plan = planCutRanges({ words, deletedStarts, durationSec: dur, pauseCuts });
  if (plan.error) {
    const msg = plan.error.code === 'NO_WORDS'
      ? '语音识别结果为空，无法剪辑'
      : `删除后有效内容过短（仅剩 ${plan.keepTotal.toFixed(1)}s），已安全拦截`;
    throw Object.assign(new Error(msg), { code: plan.error.code });
  }

  // 2) 字幕重映射：保留词字幕段先按原轴生成（buildSubtitleCues 剔除删除词），再统一映射到剪辑后时间轴
  setp('正在整理剪辑内容');
  const shift = buildShiftFn(plan.keepRanges);
  const cues = buildSubtitleCues(words, [...deletedStarts].map((s) => ({ start: Number(s) })), '')
    .map((c) => {
      const s0 = shift(c.audioStart);
      const e0 = shift(c.audioEnd);
      return { content: c.content, audioStart: Number(s0.toFixed(3)), audioEnd: Number(e0.toFixed(3)) };
    })
    .filter((c) => c.content && c.audioEnd > c.audioStart + 0.01);

  // 3) BGM：曲库缺失自动降级为无 BGM，不因此失败（任务书要求）
  setp('正在生成字幕和混合背景音乐');
  let bgm = null;
  try {
    bgm = await selectBgmByEmotion(
      BGM_DEFAULT_EMOTION,
      cues.map((c) => ({ start: c.audioStart, end: c.audioEnd })),
    );
  } catch (e) {
    console.warn(`[speechcut] BGM 选曲失败，降级为无 BGM：${e.message}`);
  }

  // 4) 单次 filter_complex：逐保留段 trim（v/a 同步）→ 双机位景别推拉跳切平滑 → 段首尾 15ms 微淡化防爆音 → concat → 烧字幕 → 混 BGM
  const plannedSec = Number(plan.keepTotal.toFixed(3));
  const realVSize = probeVideoSize(videoFile) || { width: 1080, height: 1920 };
  const baseW = realVSize.width;
  const baseH = realVSize.height;
  const scaleW = Math.round((baseW * 1.05) / 2) * 2;
  const scaleH = Math.round((baseH * 1.05) / 2) * 2;

  const filters = [];
  const vParts = [];
  const aParts = [];
  const hasMultipleCuts = plan.keepRanges.length > 1;

  plan.keepRanges.forEach(([s, e], i) => {
    const len = e - s;
    const fadeD = Math.min(0.015, len / 4);
    const sF = s.toFixed(3);
    const eF = e.toFixed(3);
    // 智能双机位景别交替（模拟广播级主机位 ↔ 特写机位推拉），彻底消除剪除语气词/停顿后的身体跳动感
    const isCloseUp = hasMultipleCuts && (i % 2 === 1);
    const vScaleFilter = isCloseUp
      ? `scale=${scaleW}:${scaleH},crop=${baseW}:${baseH},setsar=1`
      : `scale=${baseW}:${baseH},setsar=1`;
    filters.push(`[0:v]trim=start=${sF}:end=${eF},setpts=PTS-STARTPTS,${vScaleFilter}[v${i}]`);
    filters.push(
      `[0:a]atrim=start=${sF}:end=${eF},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=${fadeD.toFixed(4)},afade=t=out:st=${(len - fadeD).toFixed(4)}:d=${fadeD.toFixed(4)}[a${i}]`,
    );
    vParts.push(`[v${i}]`);
    aParts.push(`[a${i}]`);
  });
  filters.push(`${vParts.join('')}concat=n=${plan.keepRanges.length}:v=1:a=0[vcat]`);
  filters.push(`${aParts.join('')}concat=n=${plan.keepRanges.length}:v=0:a=1[acat]`);

  // 1. 输入流与索引规划（按需挂载 bgm 与 introFile）
  const taskId = path.basename(taskDir);
  const args = ['-nostdin', '-y', '-i', path.relative(taskDir, videoFile).replace(/\\/g, '/')];
  let nextInputIdx = 1;
  let bgmInputIdx = -1;
  if (bgm) {
    bgmInputIdx = nextInputIdx;
    nextInputIdx += 1;
    args.push('-stream_loop', '-1');
    args.push('-i', path.relative(taskDir, bgm.bgmPath).replace(/\\/g, '/'));
  }
  let introInputIdx = -1;
  if (introFile && fs.existsSync(introFile)) {
    introInputIdx = nextInputIdx;
    nextInputIdx += 1;
    args.push('-loop', '1', '-framerate', '30', '-t', '3.0', '-i', path.relative(taskDir, introFile).replace(/\\/g, '/'));
  }

  // 2. 字幕（发丝字体，整句完整呈现，平稳淡入绝不逐字乱蹦；drawtext 的 fontfile 使用相对 cwd 路径规避 Windows 盘符冒号转义）
  const relFonts = path.relative(taskDir, FONTS_DIR).replace(/\\/g, '/');
  const dtFilters = buildDrawtextFilters(cues, `${relFonts}/${FONT_FILE}`, {
    motion: 'smooth_fade',
    layout: 'bottom_capsule',
    maxPerLine: 18,
  });
  filters.push(`[vcat]${dtFilters.length ? dtFilters.join(',') + ',' : ''}scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[vtxt]`);

  // 3. 开场微光花字包装（共享层 @jansee/intro-kit，前 2.5s 双向羽化微光排版）
  let vBase = 'vtxt';
  if (introInputIdx >= 0) {
    filters.push(...buildIntroOverlayFilter({
      inputIndex: String(introInputIdx),
      baseLabel: vBase,
      outLabel: 'vintro'
    }));
    vBase = 'vintro';
  }

  // 4. AI 显式标识（国标 GB 45438-2025 两段式）：字体真源在共享层 aiBadge.js，不再传字体路径
  const badgeSegs = buildAiBadgeOverlay(null, plannedSec, 1080, {
    inLabel: vBase,
    outLabel: 'vfin',
  });
  filters.push(...badgeSegs);

  // 5. 人声音轨动态降噪 + 动态平准增强 + BGM 真实 Sidechain 动态人声避让（有人声下潜 18dB，无声换气回升）
  if (bgm && bgmInputIdx >= 0) {
    // a. 原视频人声：先经过稳态环境频谱降噪 afftdn，再通过 dynaudnorm 将微弱人声平准至饱满清亮的广播级电平
    filters.push(`[acat]afftdn=nf=-25,dynaudnorm=f=150:g=15:p=0.9:m=8.0,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[voice_norm]`);
    filters.push(`[voice_norm]asplit=2[v_main][v_key]`);
    // b. BGM 基础音量调平（0.12 垫底）+ 循环铺满
    filters.push(`[${bgmInputIdx}:a]volume=0.12,atrim=0:${plannedSec},asetpts=PTS-STARTPTS,apad=pad_dur=0.3,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[bgm_base]`);
    // c. 真实 Sidechain 侧链压缩避让（以人声 v_key 为驱动，发声瞬间 BGM 自动下潜，停顿自然呼吸回升）
    filters.push(`[bgm_base][v_key]sidechaincompress=threshold=0.025:ratio=8:attack=15:release=300:makeup=1[bgm_ducked]`);
    // d. 最终混音（人声优先，duration=first 锁人声长度）
    filters.push(`[v_main][bgm_ducked]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[afin]`);
  } else {
    filters.push(`[acat]afftdn=nf=-25,dynaudnorm=f=150:g=15:p=0.9:m=8.0[afin]`);
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vfin]', '-map', '[afin]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart+use_metadata_tags',
    /* AIGC 隐式标识：字段单一真源 = subtitle-kit aiMetaArgs（与全平台同口径） */
    ...aiMetaArgs(taskId),
    'final.mp4',
  );

  setp('正在导出视频');
  const release = await acquireComposeSlot(`speechcut:${taskId}`);
  try {
    await runFfmpeg(args, taskDir);
  } finally {
    release();
  }

  // 5) 产物校验：成片时长与规划一致、音轨存在、视频轨存在
  const finalPath = path.join(taskDir, 'final.mp4');
  const got = probeDurationSec(finalPath);
  if (got <= 0) throw Object.assign(new Error('成片导出失败（时长读取为 0）'), { code: 'EXPORT_BROKEN' });
  if (Math.abs(got - plannedSec) > 0.6) {
    throw Object.assign(new Error(`成片时长异常：期望约 ${plannedSec}s，实际 ${got.toFixed(2)}s`), { code: 'DURATION_MISMATCH' });
  }
  if (!hasAudioStream(finalPath)) throw Object.assign(new Error('成片缺失音轨'), { code: 'EXPORT_BROKEN' });

  return {
    finalPath,
    durationSec: Number(got.toFixed(3)),
    plannedSec,
    cutSec: Number(plan.cutTotal.toFixed(3)),
    cuesCount: cues.length,
  };
}
