// 简兮合成引擎 · storyboard.js —— 分镜成片（板块⑥：多段素材 → 拼接 + 自动配音/字幕 → 一条完整视频）
//
// 两种「自动」模式（由后端按用户是否写了台词决定，前端不再有手动控件）：
//   tts  —— 用户写了台词（任一分镜有台词即整板走此模式）：台词直接用用户所写原文（不走 LLM 润色）→ 统一音色 TTS；
//          超长自动 atempo 压缩对齐视频（音频绝不溢出视频结尾）；台词烧成硬字幕；自动 BGM。
//   asr  —— 用户只传视频、没写台词：默认视频原声即台词 → 前端逐镜跑本地 ASR 识别 →
//          弹窗核对字幕 → 烧录校正后字幕；原声不动；自动 BGM。无台词分镜只铺 BGM。
//
// 技术要点：
//   - 拼接：相邻分镜 xfade 叠化转场（宪法 XFADE.duration，禁止硬切）+ acrossfade 音频交叉淡化对齐
//   - 结尾：视频淡出至黑屏（宪法 FADE.endOut，color=black）
//   - 图片：转视频轨，每张 ~12s
//   - 字幕：drawtext 烧录（白字黑边，与全站一致）；tts 按字符占比均摊时间轴，asr 用 ASR 时间戳
//   - BGM：getVoiceBgmByEmotion 按 LLM 情绪自动选曲 → selectBgmByPath 两段式闪避混音（人声区间压低）
//   - 输出：mp4
//   - tts 模式调大模型（仅音色/BGM 决策，不改动台词）；asr 模式仅本地 ASR+ffmpeg，0 元成本

import { execFile } from 'node:child_process';
import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';
import { assetsDir } from '@jansee/shared/assetsPath.mjs';
import { selectBgmByPath } from '@jansee/audio-kit/bgm.js';
import { FADE, XFADE } from '@jansee/ffmpeg-kit/constitutionEffects.js';
import { buildAtempoFilter } from '@jansee/ffmpeg-kit/atempo.mjs';
import { buildIntroOverlayFilter } from '@jansee/intro-kit';
import { buildSubtitleCues } from './keepOriginal.js'; // 「上传视频-保留原声-核对字幕」共享模块
import { videoDurationSec } from './slicer.js';
import { buildDrawtextFilters, buildAiBadgeOverlay } from '@jansee/subtitle-kit/subtitle.js';
import { aiMetaArgs } from '@jansee/subtitle-kit/aiBadge.js';
import { audioDurationSec, buildTtsAudio } from '@jansee/tts-kit/tts.js';
import { buildDubbedCuesFromText } from '../audio/voiceVideo.js';

const COMPOSER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.resolve(COMPOSER_DIR, '..');
const FONTS_DIR = path.join(assetsDir(ENGINE_ROOT), 'fonts');

const SB_PER_IMAGE_SEC = 12; // 单张图片展示时长（秒）
const COMMON_FPS = 25;

// 简兮 (JANSEE) 短视频黄金标准规范：出片底座恒定硬锁定为 1080×1920 (9:16 竖屏)
// 适配抖音、视频号、小红书、TikTok。横屏素材等比居中自适应适配，绝不拉伸变形
const CANVAS_W = 1080;
const CANVAS_H = 1920;

function runFfmpeg(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegStatic, args, { cwd, maxBuffer: 200 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const tail = String(stderr || '')
          .split('\n')
          .slice(-8)
          .join(' ')
          .trim();
        reject(new Error(`${tail || err.message}`));
        return;
      }
      resolve();
    });
  });
}

const rel = (cwd, p) => path.relative(cwd, p).replace(/\\/g, '/');

// 单图/多图 → 固定时长视频轨（每张 ~12s，恒定硬锁定 1080x1920 竖版画布）
async function buildImageVideo(cwd, imageFiles) {
  const tmp = path.join(cwd, 'sb_imgs');
  await fsp.mkdir(tmp, { recursive: true });
  await Promise.all(
    imageFiles.map((img, i) => {
      const name = `img${String(i + 1).padStart(3, '0')}.png`;
      return runFfmpeg(['-nostdin', '-y', '-i', rel(cwd, img), rel(cwd, path.join(tmp, name))], cwd);
    })
  );
  const pattern = rel(cwd, path.join(tmp, 'img%03d.png'));
  const vf = `scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=decrease,pad=${CANVAS_W}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
  const dur = (SB_PER_IMAGE_SEC * imageFiles.length).toFixed(2);
  const out = path.join(cwd, 'sb_img_seq.mp4');
  await runFfmpeg(
    [
      '-nostdin',
      '-y',
      '-framerate',
      `1/${SB_PER_IMAGE_SEC}`,
      '-start_number',
      '1',
      '-i',
      pattern,
      '-vf',
      vf,
      '-r',
      String(COMMON_FPS),
      '-t',
      dur,
      '-pix_fmt',
      'yuv420p',
      rel(cwd, out),
    ],
    cwd,
  );
  return out;
}

// 任意视频 → 统一 1080x1920 竖屏画布 / 25fps 的归一化视频（保证后续 concat 兼容）；默认保留原声音轨
async function normalizeVideo(cwd, videoFile) {
  const out = path.join(cwd, `sb_norm_${Math.random().toString(36).slice(2, 8)}.mp4`);
  const vf = `scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=decrease:out_color_matrix=bt709:out_range=tv,pad=${CANVAS_W}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`;
  await runFfmpeg(
    [
      '-nostdin',
      '-y',
      '-i',
      rel(cwd, videoFile),
      '-vf',
      vf,
      '-r',
      String(COMMON_FPS),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-color_range',
      'tv',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-ar',
      '44100',
      '-ac',
      '2',
      rel(cwd, out),
    ],
    cwd,
  );
  return out;
}

// 把 TTS 配音对齐到视频时长：超长 → atempo 加速压缩进视频内（音频绝不溢出视频结尾）；
// 短于视频 → 原样返回（后续按视频时长 apad 补齐，尾部留 BGM，容错率高）。
async function alignTtsToVideo(cwd, ttsFile, targetDur, idx) {
  const ttsDur = audioDurationSec(ttsFile);
  if (!(ttsDur > 0)) throw new Error('TTS 音频无效，请确认文件为有效 MP3');
  // 基本一致（略短/略长）→ 直接复用，交给后续 apad/atempo 兜底
  if (ttsDur <= targetDur + 0.15) return { file: ttsFile, dur: ttsDur };
  const factor = ttsDur / targetDur; // >1 → 加速压缩
  const out = path.join(cwd, `sb_tts_align_${String(idx).padStart(2, '0')}.mp3`);
  await runFfmpeg(
    [
      '-nostdin',
      '-y',
      '-i',
      rel(cwd, ttsFile),
      '-af',
      buildAtempoFilter(factor),
      '-c:a',
      'libmp3lame',
      '-q:a',
      '4',
      rel(cwd, out),
    ],
    cwd,
  );
  return { file: out, dur: targetDur };
}

// 单分镜合成：画面（baseVideo，已归一化）+ 字幕(drawtext 烧录) + 音轨 + BGM 混音
// audioKind: 'tts'(用 audioFile) | 'original'(取 baseVideo 原声 [0:a]) | 'none'(静音垫底)
async function composeShotWithSubs(cwd, baseVideo, baseDur, audioKind, audioFile, cues, bgmPath, outFile) {
  const relFonts = path.relative(cwd, FONTS_DIR).replace(/\\/g, '/');
  const dt = buildDrawtextFilters(cues || [], `${relFonts}/obsidian_hairline.ttc`);
  const vChain = `${dt.length ? `${dt.join(',')},` : ''}scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`;
  const filters = [`[0:v]${vChain}[v]`];
  const segDur = baseDur.toFixed(2);

  const args = ['-nostdin', '-y', '-i', rel(cwd, baseVideo)];
  let aLabel;
  if (audioKind === 'tts') {
    args.push('-i', rel(cwd, audioFile));
    filters.push(`[1:a]apad,atrim=0:${segDur},asetpts=PTS-STARTPTS[oa]`);
    aLabel = '[oa]';
  } else if (audioKind === 'original') {
    filters.push(`[0:a]apad,atrim=0:${segDur},asetpts=PTS-STARTPTS[oa]`);
    aLabel = '[oa]';
  } else {
    filters.push(`anullsrc=r=44100:cl=stereo,atrim=0:${segDur},asetpts=PTS-STARTPTS[oa]`);
    aLabel = '[oa]';
  }

  // BGM（自动循环铺满整段；人声区间两段式闪避）。tts 模式占 [2:a]，其余占 [1:a]
  const bgmIdx = audioKind === 'tts' ? '[2:a]' : '[1:a]';
  if (bgmPath && fs.existsSync(bgmPath)) {
    args.push('-stream_loop', '-1', '-i', rel(cwd, bgmPath));
    const bgm = await selectBgmByPath(
      bgmPath,
      (cues || []).map((c) => ({ start: c.audioStart, end: c.audioEnd })),
    );
    if (bgm) {
      filters.push(bgm.filterChain.replace(/\[bgm\]/g, bgmIdx));
      filters.push(`[bgmout]atrim=0:${segDur},asetpts=PTS-STARTPTS[bgmfin]`);
      filters.push(
        `${aLabel}[bgmfin]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,alimiter=limit=0.95,atrim=0:${segDur},asetpts=PTS-STARTPTS[a]`,
      );
    } else {
      filters.push(`${aLabel}atrim=0:${segDur},asetpts=PTS-STARTPTS[a]`);
    }
  } else {
    filters.push(`${aLabel}atrim=0:${segDur},asetpts=PTS-STARTPTS[a]`);
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
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-r',
    String(COMMON_FPS),
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-ar',
    '44100',
    '-ac',
    '2',
    rel(cwd, outFile),
  );
  await runFfmpeg(args, cwd);
}

/**
 * 分镜成片 · 合成（自动模式）
 * @param {object} opts
 *   taskDir     outputs/{task_id}
 *   shots       [{ mediaType:'video'|'image', file, imageFiles:[], text }]
 *   autoMode    'tts' | 'asr'（后端按是否写台词决定）
 *   voiceId     tts 模式音色（Edge shortname）；asr 模式忽略
 *   speed       tts 模式全片语速倍率（主播层 anchor DNA 节奏，0.85~1.25）；缺省 1.0；asr 模式忽略
 *   bgmPath     BGM 绝对路径（已解析）；空 = 不混 BGM
 *   subtitles   仅 asr 模式：逐镜校正后字幕分段 [{start,end,text}][]
 * @returns {Promise<{output, durationSec}>}
 */
export async function composeStoryboard({ taskDir, shots, autoMode, voiceId, bgmPath, subtitles, onProgress, speed = 1, introFile }) {
  const setp = (p, stage) => {
    if (typeof onProgress === 'function') onProgress(Math.max(0, Math.min(100, p)), stage);
  };
  // 语速（主播层 anchor DNA 节奏）：直接影响每字实测朗读时长，非法回 1.0
  const ttsSpeed = Number(speed) > 0 ? Number(speed) : 1;
  if (!Array.isArray(shots) || !shots.length) throw new Error('请至少添加一个分镜');
  if (shots.length > 20) throw new Error('分镜数量不能超过 20');

  setp(5, '准备分镜素材');
  console.log(`[JANSEE STORYBOARD] 出片底座恒定硬锁定: ${CANVAS_W}x${CANVAS_H} (9:16 竖屏带货黄金标准)`);

  const bases = [];
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    let baseVideo;
    if (s.mediaType === 'image') {
      if (!s.imageFiles?.length) throw new Error(`分镜 ${i + 1} 缺少图片素材`);
      baseVideo = await buildImageVideo(taskDir, s.imageFiles);
    } else {
      if (!s.file) throw new Error(`分镜 ${i + 1} 缺少视频素材`);
      baseVideo = await normalizeVideo(taskDir, s.file); // 保留原声（asr/无台词分镜需要）
    }
    const d = videoDurationSec(baseVideo);
    if (!Number.isFinite(d) || d <= 0) throw new Error(`分镜 ${i + 1} 无法读取时长`);
    bases.push({ baseVideo, baseDur: d });
  }

  // —— 逐分镜：配音/字幕/混音 ——
  setp(20, autoMode === 'tts' ? '并发合成配音音轨' : '准备字幕');
  const hasBgm = !!bgmPath && fs.existsSync(bgmPath);

  // 并发拉取全部分镜的配音音频，避免逐镜串行网络 I/O 阻塞
  const ttsAudios = autoMode === 'tts'
    ? await Promise.all(
        shots.map(async (s, i) => {
          const text = String(s.text || '').trim();
          if (!text) return null;
          const shotTtsDir = path.join(taskDir, `tts_shot_${i}`);
          await fsp.mkdir(shotTtsDir, { recursive: true });
          return await buildTtsAudio(shotTtsDir, text, voiceId, { speed: ttsSpeed });
        })
      )
    : [];

  const shotFiles = [];
  for (let i = 0; i < bases.length; i++) {
    const { baseVideo, baseDur } = bases[i];
    const text = String(shots[i].text || '').trim();
    let audioKind = 'none';
    let audioFile = null;
    let cues = [];

    if (autoMode === 'tts') {
      if (text && ttsAudios[i]) {
        const t = ttsAudios[i];
        const perShot = path.join(taskDir, `sb_tts_${String(i).padStart(2, '0')}.mp3`);
        await fsp.copyFile(t.audioFile, perShot);
        const al = await alignTtsToVideo(taskDir, perShot, baseDur, i);
        audioFile = al.file;
        cues = buildDubbedCuesFromText(text, al.dur);
        audioKind = 'tts';
      } else {
        // 写了台词的分镜板里，某镜没写 → 保留原视频原声（如有），不叠新配音
        audioKind = shots[i].mediaType === 'image' ? 'none' : 'original';
      }
    } else {
      // asr：字幕来自前端「核对字幕」窗的结果（ASR 词 + 删除集 + 用户改后文本），复用 buildSubtitleCues 重建；原声不动
      const data = Array.isArray(subtitles) && subtitles[i] ? subtitles[i] : null;
      cues = buildSubtitleCues(data?.words || [], data?.deleted || [], data?.finalText || '');
      audioKind = shots[i].mediaType === 'image' ? 'none' : 'original';
    }

    await composeShotWithSubs(
      taskDir,
      baseVideo,
      baseDur,
      audioKind,
      audioFile,
      cues,
      hasBgm ? bgmPath : '',
      path.join(taskDir, `sb_shot_${String(i).padStart(2, '0')}.mp4`),
    );
    shotFiles.push(path.join(taskDir, `sb_shot_${String(i).padStart(2, '0')}.mp4`));
    setp(45 + Math.round(((i + 1) / bases.length) * 35), '拼接分镜与混音');
  }

  // —— 宪法第 1 条第 4 点：相邻分镜必须叠化转场（xfade dissolve，禁止硬切）——
  // —— 宪法第 1 条第 5 点：结尾淡出至黑屏（FADE.endOut，color=black）——
  // 所有效果参数来自 constitutionEffects.js（XFADE / FADE），引擎只执行不另设。
  setp(85, '叠化拼接成片');
  const xfadeD = XFADE.duration;
  const outPath = path.join(taskDir, 'final.mp4');
  const filters = [];
  const args = ['-nostdin', '-y'];
  shotFiles.forEach((f) => {
    args.push('-i', rel(taskDir, f));
  });
  const N = shotFiles.length;

  // 视频：逐镜统一格式 → 相邻分镜 xfade 叠化链（offset 按已累计时长累加，重叠 xfadeD 秒）
  shotFiles.forEach((_, i) => {
    filters.push(`[${i}:v]format=yuv420p,fps=${COMMON_FPS},setpts=PTS-STARTPTS[v${i}]`);
  });
  let prevDur = 0;
  let prevVLabel = null;
  for (let i = 0; i < N; i++) {
    const dur = bases[i].baseDur;
    if (i === 0) {
      prevVLabel = 'v0';
      prevDur = dur;
    } else {
      const offset = Math.max(0.001, prevDur - xfadeD);
      const outLabel = `x${i}`;
      filters.push(
        `[${prevVLabel}][v${i}]xfade=transition=dissolve:duration=${xfadeD.toFixed(2)}:offset=${offset.toFixed(3)}[${outLabel}]`,
      );
      prevVLabel = outLabel;
      prevDur = prevDur + dur - xfadeD;
    }
  }
  const composedLen = prevDur; // 叠化后视频总长
  // 结尾淡出至黑屏
  const fadeSt = Math.max(0.001, composedLen - FADE.endOut);
  filters.push(`[${prevVLabel}]fade=t=out:st=${fadeSt.toFixed(2)}:d=${FADE.endOut.toFixed(2)}:color=black[vfade]`);

  // 开场微光花字包装（共享层 @jansee/intro-kit，前 2.5s 优雅浮现与淡出，电影级纯黑羽化遮罩）
  let currentVBase = 'vfade';
  if (introFile && fs.existsSync(introFile)) {
    const introInputIdx = N;
    args.push('-loop', '1', '-framerate', String(COMMON_FPS), '-t', '3.0', '-i', rel(taskDir, introFile));
    filters.push(...buildIntroOverlayFilter({
      inputIndex: String(introInputIdx),
      baseLabel: currentVBase,
      outLabel: 'vintro',
    }));
    currentVBase = 'vintro';
  }

  // AI 显式标识（国标 GB 45438-2025 两段式）：开头2.5s「AI 生成」+ 结尾2.5s「本视频由 AI 生成 · JANSEE」，字号=短边5%
  const relFonts = path.relative(taskDir, FONTS_DIR).replace(/\\/g, '/');
  /* AI 角标：字体真源在共享层 aiBadge.js，不再传字体路径 */
  const badgeSegs = buildAiBadgeOverlay(null, composedLen, Math.min(CANVAS_W, CANVAS_H), {
    inLabel: currentVBase,
    outLabel: 'vout',
  });
  filters.push(...badgeSegs);

  // 音频：acrossfade 两两交叉淡化，交叉时长与 xfade 一致（输出总长同样缩短 xfadeD*(N-1)）→ 音画同步
  let prevALabel = null;
  for (let i = 0; i < N; i++) {
    if (i === 0) {
      prevALabel = '0:a';
    } else {
      const outLabel = `a${i}`;
      filters.push(`[${prevALabel}][${i}:a]acrossfade=d=${xfadeD.toFixed(2)}:c1=tri:c2=tri[${outLabel}]`);
      prevALabel = outLabel;
    }
  }
  filters.push(
    `[${prevALabel}]aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]`,
  );

  const taskId = path.basename(taskDir);
  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-r',
    String(COMMON_FPS),
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-movflags',
    '+faststart+use_metadata_tags',
    /* AIGC 隐式标识：字段单一真源 = subtitle-kit aiMetaArgs（与全平台同口径） */
    ...aiMetaArgs(taskId),
    rel(taskDir, outPath),
  );
  await runFfmpeg(args, taskDir);

  const finalDur = videoDurationSec(outPath);
  setp(100, '完成');
  return { output: outPath, durationSec: finalDur };
}
