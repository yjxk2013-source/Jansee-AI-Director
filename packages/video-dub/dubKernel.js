// 简兮合成引擎 · dubKernel.js —— 视频配音合成内核（从 modules/video_creator/video/dub.js 搬迁，2026-10-24）
//
// 职责收敛说明（搬迁时按「生产可达面」裁剪，行为对已上线路径逐一等价）：
//   保留：视频输入 + 预生成音轨（TTS 在编排层合成并实测）→ 音画对齐 → 淡入淡出 → 字幕烧录 → 混流。
//   裁剪：图片序列输入（mediaType=image，前端无此入口，图片成片走 @jansee/image-film）、
//         用户录音 upload 模式（含 ASR 字幕，口播链路归 speechcut）、保留原声 keep 模式（零调用方）、
//         内核内置 buildTtsAudio（编排层 synthesizeLines 已实测，杜绝二次 TTS）、
//         BGM 混音（上移编排层，与图片成片同一套 audio-kit 两段式闪避，见 index.js）。
//   以上被裁能力的原始实现见 git 历史（main 分支 modules/video_creator/video/dub.js）。
//
// 技术要点（不变）：
//   - 画面原封不动对齐【源视频时长】：视频绝不被截断、绝不被加速。
//     片尾收束卡（CTA 尾段）是追加在源视频完整结束之后的——tpad 黑尾 + CTA 淡入浮出，
//     时间口径在 @jansee/ending-kit（ENDING_TAIL），与图片成片同构。
//   - 音画对齐目标 = 源视频时长 + 尾段时长。长音频 → trim + 结束前 0.5s 淡出(afade)；
//     短音频 → 原声保留，静音补满(apad)，结尾同样淡出（BGM 垫着 CTA 全程，不硬断）。
//   - 字幕 cue 时间轴与音轨同从 0 起，天然对齐；超出源视频时长的字幕随音频裁剪不显示。
//   - AI 角标窗口只覆盖源视频段（badgeDur=baseDur），不顶到结尾卡上。
//   - 输出：mp4（libx264 + aac 192k + AIGC 元数据）。

import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { assetsDir } from '@jansee/shared/assetsPath.mjs';
import { FADE } from '@jansee/ffmpeg-kit/constitutionEffects.js';
import { ENDING_TAIL } from '@jansee/ending-kit';
import { buildIntroOverlayFilter } from '@jansee/intro-kit';
import { probeDurationSec, probeVideoSize } from '@jansee/ffmpeg-kit/probe.mjs';
import { buildDrawtextFilters, buildAiBadgeOverlay } from '@jansee/subtitle-kit/subtitle.js';
import { aiMetaArgs } from '@jansee/subtitle-kit/aiBadge.js';
import { audioDurationSec } from '@jansee/tts-kit/tts.js';

const FONTS_DIR = path.join(assetsDir(), 'fonts');

/* opts.totalSec + opts.onRatio：真实进度。-progress pipe:1 的 out_time_us ÷ 成片总时长
   = 实际编码比例；没传 opts 时行为与旧 execFile 版完全一致。 */
function runFfmpeg(args, cwd, opts = {}) {
  const { totalSec = 0, onRatio = null } = opts;
  const useProgress = typeof onRatio === 'function' && totalSec > 0;
  return new Promise((resolve, reject) => {
    const finalArgs = useProgress
      ? [...args.slice(0, 2), '-progress', 'pipe:1', '-nostats', ...args.slice(2)]
      : args;
    const child = spawn(ffmpegStatic, finalArgs, { cwd, windowsHide: true });
    let stderr = '';
    // 进程级超时保护（至少 3 分钟，或成片预期时长的 6 倍），防卡死孤儿子进程打满算力
    const timeoutMs = Math.max(180000, Math.ceil(totalSec * 6000));
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`FFmpeg 执行超时（>${Math.round(timeoutMs / 1000)}s），已强制终止进程`));
    }, timeoutMs);

    if (useProgress) {
      let buf = '';
      let lastSent = 0;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c) => {
        buf += c;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          const m = /^out_time_us=(\d+)/.exec(line);
          if (m && totalSec > 0) {
            const ratio = Math.min(1, Math.max(0, Number(m[1]) / 1e6 / totalSec));
            if (ratio - lastSent >= 0.01 || ratio >= 1) {
              lastSent = ratio;
              onRatio(ratio);
            }
          }
        }
      });
    }
    child.stderr.setEncoding('utf8');
    // 滑动窗口保留最新 64KB 错误日志，杜绝长视频连续告警引发主进程 OOM 内存泄漏
    child.stderr.on('data', (c) => {
      stderr = (stderr + c).slice(-65536);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) { resolve(); return; }
      const tail = String(stderr || '')
        .split('\n')
        .slice(-6)
        .join(' ')
        .trim();
      reject(new Error(`${tail || `FFmpeg exited with code ${code}`}`));
    });
  });
}

// 相对路径（ffmpeg 在 cwd 下执行，路径需相对 cwd 且用正斜杠）
function rel(cwd, p) {
  return path.relative(cwd, p).replace(/\\/g, '/');
}

// ============ 音画对齐（视频输入专用）============
// 输出一条时长恰好 === targetDur 的音轨。核心约束：视频绝不被截断、音频绝不被加速。
// targetDur = 源视频时长 + 片尾收束卡时长（无结尾卡时 = 源视频时长）。
//   - 长音频(audioDur > targetDur)：trim 到 targetDur，并在结束前 0.5s 淡出(afade)。
//   - 短音频(audioDur <= targetDur)：原声完整保留；静音补满(apad)，
//     结尾同样淡出——BGM 要垫着 CTA 卡全程，不能硬断在黑屏前。
//     （BGM 已在编排层按 targetDur 全长混入音轨，此处不再接触 BGM。）
async function buildAlignedAudio(cwd, audioPath, audioDur, targetDur) {
  const relAudio = rel(cwd, audioPath);
  const out = path.join(cwd, 'dub_audio_aligned.wav');
  const dur = targetDur;
  const longCase = audioDur > targetDur + 0.2;
  const fadeStart = Math.max(0, dur - 0.5);

  const wavFilter = (i, af) => ['-nostdin', '-y', '-i', i, '-af', af, '-c:a', 'pcm_s16le', rel(cwd, out)];

  if (longCase) {
    // 长音频：trim + 结束前 0.5s 淡出（绝不加速）
    await runFfmpeg(
      wavFilter(
        relAudio,
        `atrim=0:${dur.toFixed(2)},asetpts=PTS-STARTPTS,afade=t=out:st=${fadeStart.toFixed(2)}:d=0.5,aformat=sample_fmts=fltp`,
      ),
      cwd,
    );
    return out;
  }

  // 短（或相等）音频：静音补满到 targetDur，确保视频不被截断
  await runFfmpeg(
    wavFilter(
      relAudio,
      `apad,atrim=0:${dur.toFixed(2)},asetpts=PTS-STARTPTS,afade=t=out:st=${fadeStart.toFixed(2)}:d=0.5,aformat=sample_fmts=fltp`,
    ),
    cwd,
  );
  return out;
}

/**
 * 把字幕 cue 与 AI 显性标识烧进视频（重编码绘制 drawtext，音频直接复制）。
 * cue 时间轴与音轨同从 0 起，天然对齐；超出视频时长的字幕随音频裁剪不显示。
 * totalDur：整片成片总长（含片尾收束卡）。
 * 结尾角标严格锁定在全片最后 2.5s，伴随片尾收束卡（CTA）浮出，杜绝提前在源视频中破坏正片画面。
 * @param {Array<{content,audioStart,audioEnd}>} cues
 */
async function burnSubtitles(cwd, srcVideo, cues, outPath, totalDur, shortEdge = 1080, onRatio = null) {
  const relFonts = path.relative(cwd, FONTS_DIR).replace(/\\/g, '/');
  const dur = Number(totalDur) > 0 ? totalDur : probeDurationSec(srcVideo) || 10;
  const dtFilters = Array.isArray(cues) && cues.length
    ? buildDrawtextFilters(cues, `${relFonts}/obsidian_hairline.ttc`)
    : [];
  /* AI 角标：字体真源在共享层 aiBadge.js（思源黑 Regular），不再传字体路径 */
  const badgeSegs = buildAiBadgeOverlay(null, dur, shortEdge);

  const allFilters = [];
  if (dtFilters.length) {
    allFilters.push(`[0:v]${dtFilters.join(',')}[vtxt]`);
    allFilters.push(...badgeSegs);
  } else {
    allFilters.push(...badgeSegs.map((s) => s.replace('[vtxt]', '[0:v]')));
  }

  const taskId = path.basename(cwd);
  await runFfmpeg(
    [
      '-nostdin',
      '-y',
      '-i',
      rel(cwd, srcVideo),
      '-filter_complex',
      allFilters.join(';'),
      '-map',
      '[vout]',
      '-map',
      '0:a',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-c:a',
      'copy',
      '-movflags',
      '+faststart+use_metadata_tags',
      /* AIGC 隐式标识：字段单一真源 = subtitle-kit aiMetaArgs（与全平台同口径） */
      ...aiMetaArgs(taskId),
      '-shortest',
      rel(cwd, outPath),
    ],
    cwd,
    {
      /* 烧字幕与AI标识真实进度：输出时长 = 整片总长 */
      totalSec: dur,
      onRatio,
    },
  );
  return outPath;
}

/**
 * 结尾卡适配用户视频画幅已上移 @jansee/ending-kit（fitEndingCard，2026-10-24 全版块
 * 收束下沉：口播/分镜链路同需要）。此处再导出仅为既有测试与调用面兼容，实现单一份。
 */
export { fitEndingCard } from '@jansee/ending-kit';

/**
 * 视频配音 · 合成内核：把一条预生成音轨（含 BGM）铺到视频上，烧字幕，出 final.mp4。
 * 音画对齐到「源视频 + 片尾收束卡」：长音频 trim + 结束前淡出；短音频静音补满。
 * 视频绝不被截断/加速——收束卡是追加在源视频完整结束之后的尾段，
 * 与图片成片同一套时间结构（ending-kit ENDING_TAIL）：结尾淡出 → 黑停一拍 → CTA 淡入浮出。
 * @param {object} opts
 *   taskDir      outputs/{task_id} 绝对路径
 *   videoFile    源视频绝对路径（画面基准，时长权威源）
 *   audioFile    预生成音轨绝对路径（旁白 [+ BGM]，编排层已实测时长）
 *   cues         字幕 cue [{content,audioStart,audioEnd}]（与音轨同从 0 起的时间轴）
 *   ctaFile      片尾收束卡 PNG（已适配视频画幅；null = 不出结尾卡）
 *   onProgress   (progress:number, stage:string) => void
 * @returns {Promise<{output:string, durationSec:number}>}
 */
export async function composeDubTrack({ taskDir, videoFile, audioFile, cues = [], ctaFile = null, introFile = null, onProgress }) {
  const setp = (p, stage) => {
    if (typeof onProgress === 'function') onProgress(Math.max(0, Math.min(100, p)), stage);
  };

  setp(5, '准备视频素材');
  if (!videoFile) throw new Error('缺少视频文件');
  if (!audioFile) throw new Error('缺少配音音轨');

  const baseDur = probeDurationSec(videoFile);
  if (!Number.isFinite(baseDur) || baseDur <= 0) {
    throw new Error('视频真实时长探测失败，文件可能已损坏，请重新上传');
  }

  /* 片尾收束卡尾段：黑停一拍 + CTA 卡（淡入在滤镜图里给 ENDING_TAIL.fadeInSec）。
     结尾淡出（FADE.voiceOut）照旧吃源视频尾巴，在 baseDur 内，不占尾段。 */
  const tailSec = ctaFile ? ENDING_TAIL.endHoldSec + ENDING_TAIL.ctaSec : 0;
  const totalDur = baseDur + tailSec;

  setp(20, '音画对齐');
  const audioDur = audioDurationSec(audioFile);
  if (!(audioDur > 0)) throw new Error('配音音轨读取失败，无法混音');
  const aligned = await buildAlignedAudio(taskDir, audioFile, audioDur, totalDur);

  setp(60, '混音合成');
  // 优化：源视频尾部的淡黑收敛为 0.4s 微弱自然呼吸（不再是 1.5s 漫长死黑，彻底杜绝话没念完画面就变黑）
  const fadeOutSec = 0.4;
  const fadeSt = Math.max(0, baseDur - fadeOutSec).toFixed(2);
  const muxOut = path.join(taskDir, 'dub_muxed.mp4');
  const args = [
    '-nostdin',
    '-y',
    '-i',
    rel(taskDir, videoFile),
    '-i',
    rel(taskDir, aligned),
  ];
  let nextInputIdx = 2;

  const filters = [
    `[0:v]fade=t=in:st=0:d=${FADE.voiceIn},fade=t=out:st=${fadeSt}:d=${fadeOutSec},` +
    `tpad=stop_mode=add:stop_duration=${tailSec.toFixed(2)}:color=black[vbody]`,
  ];
  let currentBase = 'vbody';

  // 1. 开场微光花字包装（前 2.5s 优雅浮现与淡出，黑曜石羽化暗晕保底）
  if (introFile) {
    const introIdx = nextInputIdx;
    nextInputIdx += 1;
    args.push('-loop', '1', '-framerate', '30', '-t', '3.0', '-i', rel(taskDir, introFile));
    filters.push(...buildIntroOverlayFilter({ inputIndex: String(introIdx), baseLabel: currentBase, outLabel: 'vintro' }));
    currentBase = 'vintro';
  }

  // 2. 片尾收束卡（源视频结束后黑停一拍 + CTA 浮出）
  if (ctaFile) {
    const ctaIdx = nextInputIdx;
    nextInputIdx += 1;
    args.push('-loop', '1', '-framerate', '30', '-t', tailSec.toFixed(2), '-i', rel(taskDir, ctaFile));
    filters.push(
      `[${ctaIdx}:v]format=rgba,fade=t=in:st=0:d=${ENDING_TAIL.fadeInSec}:alpha=1,` +
      `tpad=start_duration=${(baseDur + ENDING_TAIL.endHoldSec).toFixed(3)}:start_mode=add:color=0x00000000[cta]`,
      `[${currentBase}][cta]overlay=0:0:eof_action=pass:format=auto[vending]`,
    );
    currentBase = 'vending';
  }

  // 3. 烧录字幕 (drawtext 发丝级)
  const relFonts = path.relative(taskDir, FONTS_DIR).replace(/\\/g, '/');
  const dtFilters = Array.isArray(cues) && cues.length
    ? buildDrawtextFilters(cues, `${relFonts}/obsidian_hairline.ttc`)
    : [];
  let badgeIn = currentBase;
  if (dtFilters.length) {
    filters.push(`[${currentBase}]${dtFilters.join(',')}[vtxt]`);
    badgeIn = 'vtxt';
  }

  // 4. 烧录 AI 溯源显式标识
  let shortEdge = 1080;
  try {
    const size = probeVideoSize(videoFile);
    if (size?.width && size?.height) {
      shortEdge = Math.min(size.width, size.height);
    }
  } catch (_) {}
  const badgeSegs = buildAiBadgeOverlay(null, totalDur, shortEdge, {
    inLabel: badgeIn,
    outLabel: 'vout',
    tailInCta: !!ctaFile,
  });
  if (badgeSegs.length) {
    filters.push(...badgeSegs);
  } else {
    filters.push(`[${badgeIn}]null[vout]`);
  }

  const taskId = path.basename(taskDir);
  const outPath = path.join(taskDir, 'final.mp4');
  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-map',
    '1:a',
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
    '192k',
    '-movflags',
    '+faststart+use_metadata_tags',
    ...aiMetaArgs(taskId),
    '-shortest',
    rel(taskDir, outPath),
  );

  /* 单次流式合成真实进度：内部刻度 60→95 随实际编码比例连续爬升 */
  await runFfmpeg(args, taskDir, {
    totalSec: totalDur,
    onRatio: (ratio) => setp(60 + Math.round(ratio * 35), '混音与字幕烧录'),
  });

  const finalDur = probeDurationSec(outPath) || totalDur;
  setp(100, '完成');
  return { output: outPath, durationSec: finalDur };
}
