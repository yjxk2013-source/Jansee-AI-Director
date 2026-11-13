// 简兮合成引擎 · slicer.js —— 视频切片（第三阶段：切口/投流素材）
// 分两阶段：
//   prepareSlicer  —— 切割（可原片直出不切割）→ 逐段本地 whisper ASR → 词级时间戳+文字，供用户核对
//   composeSlicer  —— 按用户核对后的文字重建字幕；若用户删了词，对应原声按时间戳修剪（同口播 trimFillerAudio）
//                     → 烧字幕 + 人声区间 BGM 闪避 → 输出多条 MP4
// 全程本地处理：切割/ASR/修剪/字幕/BGM 均不调大模型，0 元成本。

import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';
import { runASR } from '../asr/asr.js';
import { assetsDir } from '@jansee/shared/assetsPath.mjs';
import { selectBgmByEmotion } from '@jansee/audio-kit/bgm.js';
import { hasAudioStream } from '@jansee/ffmpeg-kit/probe.mjs';
import { buildDrawtextFilters, buildAiBadgeOverlay } from '@jansee/subtitle-kit/subtitle.js';
import { aiMetaArgs } from '@jansee/subtitle-kit/aiBadge.js';
import { acquireComposeSlot } from '@jansee/ffmpeg-kit/composeGate.mjs';
import { buildSegmentsFromFinalText, trimFillerAudio } from '../asr/trim.js';

const COMPOSER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.resolve(COMPOSER_DIR, '..');
const FONTS_DIR = path.join(assetsDir(ENGINE_ROOT), 'fonts');
const BGM_DEFAULT_EMOTION = 'cheerful'; // 切片模式默认"轻快活泼"，不需要大模型选曲

// 用 ffmpeg -i 解析视频时长（秒），复用 ffmpeg-static，不额外装 ffprobe
export function videoDurationSec(file) {
  let out = '';
  try {
    out = execFileSync(ffmpegStatic, ['-i', file], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    out = e?.stderr || out; // ffmpeg -i 无输出文件时正常报错，时长信息在 stderr
  }
  const m = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function runFfmpeg(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegStatic, args, { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const tail = String(stderr || '')
          .split('\n')
          .slice(-6)
          .join(' ')
          .trim();
        reject(new Error(`${tail || err.message}`));
        return;
      }
      resolve();
    });
  });
}

// 1. 按固定时长切割（-c copy 不重编码，速度快不损画质）
// 返回按序号排好的切片文件名数组（slice_001.mp4 ...）
async function cutSegments(taskDir, videoFile, segSec) {
  const slicesDir = path.join(taskDir, 'slices');
  await fs.mkdir(slicesDir, { recursive: true });
  const relVideo = path.relative(taskDir, videoFile).replace(/\\/g, '/');
  const outPattern = 'slices/slice_%03d.mp4';
  const release = await acquireComposeSlot(`slicer_cut:${path.basename(taskDir)}`);
  try {
    await runFfmpeg(
      [
        '-nostdin',
        '-y',
        '-i',
        relVideo,
        '-map',
        '0',
        '-c',
        'copy',
        '-f',
        'segment',
        '-segment_time',
        String(segSec),
        '-reset_timestamps',
        '1',
        '-avoid_negative_ts',
        'make_zero',
        outPattern,
      ],
      taskDir,
    );
  } finally {
    release();
  }
  const names = (await fs.readdir(slicesDir)).filter((n) => /^slice_\d+\.mp4$/.test(n)).sort();
  return names;
}

/**
 * 阶段一：切割 + 逐段 ASR，返回供前端核对的片段（含词级时间戳）
 * @param {object} opts
 *   taskDir    outputs/{task_id} 绝对路径（slices/ 子目录存切片）
 *   videoFile  上传视频绝对路径
 *   segSec     每段时长（秒），passthrough 时忽略
 *   passthrough 原片直出：不切割，整片作为 1 段
 *   onProgress (progress:number, stage:string) => void
 * @returns {Promise<{segments:Array<{index,name,file,durationSec,text,words}>, count, passthrough}>}
 */
export async function prepareSlicer({ taskDir, videoFile, segSec = 20, passthrough = false, onProgress }) {
  const setp = (p, stage) => {
    if (typeof onProgress === 'function') onProgress(Math.max(0, Math.min(100, p)), stage);
  };

  const total = videoDurationSec(videoFile);
  if (total <= 0) throw new Error('无法读取视频时长，请确认文件为有效 MP4/MOV/WebM');

  const slicesDir = path.join(taskDir, 'slices');
  let sliceNames;
  if (passthrough) {
    // 原片直出：不切割，把原片作为唯一一段
    await fs.mkdir(slicesDir, { recursive: true });
    const name = 'slice_001.mp4';
    await fs.copyFile(videoFile, path.join(slicesDir, name));
    sliceNames = [name];
    setp(3, '正在识别原片…');
  } else {
    setp(3, '正在切割视频…');
    sliceNames = await cutSegments(taskDir, videoFile, segSec);
    if (!sliceNames.length) throw new Error('视频切割未产生任何切片');
  }
  // 2. 逐段 ASR：词级时间戳 + 文字（进度 5→13，最终由路由卡在 15 等用户核对）
  const segments = [];
  for (let i = 0; i < sliceNames.length; i++) {
    setp(5 + Math.round((i / sliceNames.length) * 8), `正在识别第 ${i + 1}/${sliceNames.length} 段…`);
    const abs = path.join(slicesDir, sliceNames[i]);
    const asrWork = path.join(slicesDir, `_asr_${i + 1}`);
    let asr;
    try {
      asr = await runASR(abs, asrWork);
    } catch (e) {
      // 单条识别失败不阻断整批：该段文字留空，交给用户核对时手动填
      console.warn(`[slicer] 第 ${i + 1}/${sliceNames.length} 段 ASR 失败，等待用户手动核对：${e.message}`);
      asr = { text: '', words: [], segments: [], duration: 0 };
    }
    segments.push({
      index: i + 1,
      name: sliceNames[i],
      file: abs,
      durationSec: videoDurationSec(abs) || 20,
      text: asr.text,
      words: asr.words || [],
    });
  }

  return { segments, count: segments.length, passthrough };
}

/**
 * 阶段二：按用户核对结果合成出片（修剪删词原声 + 烧用户文字字幕 + BGM 闪避）
 * @param {object} opts
 *   taskDir    outputs/{task_id} 绝对路径
 *   segments  prepareSlicer 返回的 segments，叠加用户编辑：
 *             { index, file, name, durationSec, words, final_text, deleted:[{word,start,end}] }
 *   onProgress (progress, stage) => void
 * @returns {Promise<{slices:Array<{index,name,durationSec,text}>, count}>}
 */
export async function composeSlicer({ taskDir, segments = [], onProgress }) {
  const setp = (p, stage) => {
    if (typeof onProgress === 'function') onProgress(Math.max(0, Math.min(100, p)), stage);
  };
  const slicesDir = path.join(taskDir, 'slices');
  const list = segments.filter((s) => s?.file);
  const count = list.length;
  if (!count) throw new Error('没有可合成的切片');

  const slices = [];
  for (let i = 0; i < count; i++) {
    setp(15 + Math.round((i / count) * 80), `正在合成第 ${i + 1}/${count} 段…`);
    const r = await composeSlice(slicesDir, list[i], i + 1, count);
    slices.push(r);
  }

  setp(100, '已完成');
  return { slices, count };
}

// 单条切片合成：决定音源（原音/修剪后）+ 字幕分段（用户最终文字）→ 烧字幕 + BGM 闪避 → final_%03d.mp4
async function composeSlice(slicesDir, seg, index, total) {
  const sliceAbs = seg.file;
  const sliceName = path.basename(sliceAbs);
  const sliceDur = seg.durationSec || videoDurationSec(sliceAbs) || 20;
  const hasA = hasAudioStream(sliceAbs);
  const words = Array.isArray(seg.words) ? seg.words : [];
  const finalText = String(seg.final_text || '').trim();
  const deleted = (Array.isArray(seg.deleted) ? seg.deleted : []).filter((d) => d && Number.isFinite(Number(d.start)));

  // ① 决定音源与字幕分段
  let audioRel = sliceName; // 相对 slicesDir 的音频输入（默认原片音轨）
  let cues = buildSegmentsFromFinalText(words, finalText);
  if (deleted.length && hasA && words.length) {
    // 用户删了词 → 按时间戳修剪原声（同口播 trimFillerAudio）
    const trimmedMp3 = path.join(slicesDir, `_trim_${index}.mp3`);
    try {
      const tr = await trimFillerAudio(sliceAbs, words, trimmedMp3, { deleted, finalText });
      audioRel = path.relative(slicesDir, trimmedMp3).replace(/\\/g, '/');
      cues = tr.segments;
    } catch (e) {
      console.warn(`[slicer] 第 ${index}/${total} 段修剪失败，回退原音：${e.message}`);
      audioRel = sliceName;
      cues = buildSegmentsFromFinalText(words, finalText);
    }
  }
  // 无词级时间戳但用户填了文字 → 整段铺一条字幕，避免丢失用户输入
  if (!cues.length && finalText) {
    cues = [{ start: 0, end: sliceDur, text: finalText }];
  }

  // ② BGM：默认轻快活泼 + 人声区间闪避
  const drawCues = cues
    .filter((c) => c && String(c.text || '').trim())
    .map((c) => ({ content: String(c.text).trim(), audioStart: Number(c.start) || 0, audioEnd: Number(c.end) || 0 }));
  const bgm = await selectBgmByEmotion(
    BGM_DEFAULT_EMOTION,
    drawCues.map((c) => ({ start: c.audioStart, end: c.audioEnd })),
  );

  // ③ drawtext 字幕（与第一/二阶段一致）；fontfile 相对 cwd=slicesDir
  const relFonts = path.relative(slicesDir, FONTS_DIR).replace(/\\/g, '/');
  const dtFilters = buildDrawtextFilters(drawCues, `${relFonts}/obsidian_hairline.ttc`);
  const vChain = dtFilters.length ? dtFilters.join(',') : 'format=yuv420p';

  const filters = [`[0:v]${vChain}[vtxt]`];
  const segDurF = sliceDur.toFixed(2);

  // AI 显式标识（国标 GB 45438-2025 两段式）：开头2.5s「AI 生成」+ 结尾2.5s「本视频由 AI 生成 · JANSEE」，字号=短边5%
  /* AI 角标：字体真源在共享层 aiBadge.js，不再传字体路径 */
  const badgeSegs = buildAiBadgeOverlay(null, sliceDur, 1080, {
    inLabel: 'vtxt',
    outLabel: 'v',
  });
  filters.push(...badgeSegs);

  const useTrim = audioRel !== sliceName; // 是否使用了修剪后的 mp3 音源
  const bgmIdx = useTrim ? 2 : 1; // 输入序号：0=原片 1=修剪音频 2=BGM
  const bgmFrag = bgm ? bgm.filterChain.replace(/\[bgm\]/g, `[${bgmIdx}:a]`) : '';

  if (useTrim) {
    // 修剪音源：apad 补足到整段时长；有 BGM 则混合闪避
    filters.push(`[1:a]apad=pad_dur=0.5[av]`);
    if (bgmFrag) {
      filters.push(`${bgmFrag}`);
      filters.push(`[bgmout]atrim=0:${segDurF},asetpts=PTS-STARTPTS,apad=pad_dur=0.3[bgmfin]`);
      filters.push(`[av][bgmfin]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[mix]`);
      filters.push(`[mix]atrim=0:${segDurF},asetpts=PTS-STARTPTS[a]`);
    } else {
      filters.push(`[av]atrim=0:${segDurF}[a]`);
    }
  } else if (hasA) {
    // 原音轨（未修剪）
    filters.push(`[0:a]atrim=0:${segDurF},asetpts=PTS-STARTPTS[av]`);
    if (bgmFrag) {
      filters.push(`${bgmFrag}`);
      filters.push(`[bgmout]atrim=0:${segDurF},asetpts=PTS-STARTPTS,apad=pad_dur=0.3[bgmfin]`);
      filters.push(`[av][bgmfin]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[a]`);
    } else {
      filters.push(`[av]apad=pad_dur=0.3[a]`);
    }
  } else {
    // 原片无音轨：BGM 单独作为音轨（有 BGM 就用，没有则静音底）
    if (bgmFrag) {
      filters.push(`${bgmFrag}`);
      filters.push(`[bgmout]atrim=0:${segDurF},asetpts=PTS-STARTPTS[a]`);
    } else {
      filters.push(`anullsrc=r=44100:cl=stereo,atrim=0:${segDurF}[a]`);
    }
  }

  const taskId = path.basename(taskDir);
  const args = ['-nostdin', '-y', '-i', sliceName];
  if (useTrim) args.push('-i', audioRel);
  if (bgm) {
    args.push('-stream_loop', '-1'); // BGM 不足切片时长时循环，避免后半段静音
    args.push('-i', path.relative(slicesDir, bgm.bgmPath).replace(/\\/g, '/'));
  }
  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart+use_metadata_tags',
    /* AIGC 隐式标识：字段单一真源 = subtitle-kit aiMetaArgs（切片以 taskId_N 溯源） */
    ...aiMetaArgs(`${taskId}_${index}`),
    `final_${String(index).padStart(3, '0')}.mp4`,
  );
  const release = await acquireComposeSlot(`slicer_compose:${taskId}:${index}`);
  try {
    await runFfmpeg(args, slicesDir);
  } finally {
    release();
  }

  const name = `final_${String(index).padStart(3, '0')}.mp4`;
  return { index, name, durationSec: sliceDur, text: finalText };
}
