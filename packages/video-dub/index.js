/**
 * @jansee/video-dub —— 视频配音模块（对外唯一 API：produceVideoDub）
 *
 * 输入：导演剧本 cut（LLM 大导演产出，app 侧负责生成）+ 已校验视频 + 音色 + 场景。
 * 输出：storage/outputs/<taskId>/final.mp4。
 *
 * 链路：旁白分段对齐 → TTS 逐段实测时长（并行 + 缓存）→ 按呼吸停顿拼接旁白音轨
 *       → BGM 按情绪选曲 + 两段式人声闪避（audio-kit，与图片成片同一套）→ 合成内核音画对齐成片。
 * 时长不估算：每段时长 = TTS 实测；段间停顿取导演剧本的 pause_after（缺省 0.5s）。
 * 旁白总长超出视频 → 内核 trim 到视频时长并在结束前淡出（视频绝不被截断/加速）；
 * 不足 → 静音补满，BGM 全程垫底——画面时长永远是源视频时长（+ 片尾收束卡）。
 * 结尾收束（视频配音）：与图片成片同一份真源——@jansee/ending-kit 的 15 款 CTA 卡
 *（3 场景 × 5 款），按 taskId 派生的同一颗 seed 抽同一款，contain 适配用户视频画幅，
 * 烧在「源视频结尾淡出 → 黑停一拍 → CTA 淡入浮出」的尾段里（同 ENDING_TAIL 口径）。
 * 口头收束是 cut.end_line（最后一段 TTS 旁白），画面收束是结尾卡，两者互不打架。
 *
 * 调用方（任何需要视频配音的链路）：
 *   import { produceVideoDub } from '@jansee/video-dub';
 *   const result = await produceVideoDub({ taskId, taskDir, videoFile, cut, voiceId, scene });
 * 导演剧本（cut）由调用方生成：LLM 大导演在 app 侧（依赖创作台账与变体判定），失败落程序兜底剧本；
 * cut 消费字段：shots[].{line,pause_after} + end_line + bgm_emotion/bgm_on。
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import { probeDurationSec, probeVideoSize } from '@jansee/ffmpeg-kit/probe.mjs';
import { synthesizeLines, audioDurationSec } from '@jansee/tts-kit/tts.js';
import { selectBgmByEmotion } from '@jansee/audio-kit/bgm.js';
import { FADE } from '@jansee/ffmpeg-kit/constitutionEffects.js';
import {
  ENDING_TAIL,
  pickEndingForTask,
  renderEndingPng,
  sceneForEngine,
} from '@jansee/ending-kit';
import { renderIntroPng, composePureCover } from '@jansee/intro-kit';
import { composeDubTrack, fitEndingCard } from './dubKernel.js';
import { acquireComposeSlot } from '@jansee/ffmpeg-kit/composeGate.mjs';

/** 段间呼吸停顿缺省值（导演剧本 pause_after 缺失时）；sanitize 侧已钳制 0~1.5s */
const DEFAULT_PAUSE_SEC = 0.5;
/** 音轨统一规格：44.1kHz 立体声 16bit（与旧内核 mixNarrationWithBgm 同口径） */
const AR = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo';
/** 片尾收束卡时长：黑停一拍 + CTA 卡（淡入+持续），口径在 ending-kit（ENDING_TAIL） */
const TAIL_SEC = ENDING_TAIL.endHoldSec + ENDING_TAIL.ctaSec;

/** 全片语速钳制：导演层已兜底，包边界再钳一次（0.85~1.25，防 atempo 失真）；缺省 1 零回归 */
function clampSpeechSpeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(1.25, Math.max(0.85, n));
}

/* ffmpeg 执行（spawn 版：错误带 stderr 尾部，崩溃可诊断） */
function runFfmpeg(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegStatic, args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}

function rel(cwd, p) {
  return path.relative(cwd, p).replace(/\\/g, '/');
}

/**
 * 把逐段配音按时间轴拼成一条旁白音轨（段间留 pause 呼吸停顿）。
 * 每段独立 adelay 到起点后 amix（normalize=0 不衰减音量），输出 pcm wav。
 * @returns {Promise<{file:string, durationSec:number}>}
 */
async function concatNarration(cwd, parts, totalSec) {
  const out = path.join(cwd, 'narration.wav');
  const filters = parts.map((p, i) => {
    const ms = Math.round(p.start * 1000);
    return `[${i}:a]${AR},adelay=${ms}|${ms}[a${i}]`;
  });
  filters.push(`${parts.map((_, i) => `[a${i}]`).join('')}amix=inputs=${parts.length}:duration=longest:dropout_transition=0:normalize=0[aout]`);
  const args = ['-nostdin', '-y'];
  parts.forEach((p) => args.push('-i', rel(cwd, p.file)));
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[aout]',
    '-c:a', 'pcm_s16le',
    rel(cwd, out),
  );
  await runFfmpeg(args, cwd);
  return { file: out, durationSec: audioDurationSec(out) || totalSec };
}

/**
 * 把 BGM 混到旁白下方：循环铺满整段视频时长（含片尾收束卡段），
 * 人声区间两段式闪避（audio-kit 滤镜链）。
 * filterChain 以 [bgm] 占位开头、[bgmout] 结尾（与视觉引擎同一约定），这里接到真实输入索引上。
 * @returns {Promise<{file:string}>}
 */
async function mixBgmUnder(cwd, narrationFile, bgmFile, filterChain, targetDur) {
  const out = path.join(cwd, 'narration_bgm.wav');
  const chain = String(filterChain)
    .replace('[bgm]', '[1:a]aresample=44100,aloop=loop=-1:size=200000000,atrim=0:' + Math.max(0.1, targetDur).toFixed(2) + ',aformat=sample_fmts=fltp,')
    .replace('[bgmout]', '[bgmdone]');
  await runFfmpeg(
    [
      '-nostdin',
      '-y',
      '-i', rel(cwd, narrationFile),
      '-i', rel(cwd, bgmFile),
      '-filter_complex',
      [
        `[0:a]${AR}[nar]`,
        chain,
        '[nar][bgmdone]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]',
      ].join(';'),
      '-map', '[aout]',
      '-c:a', 'pcm_s16le',
      rel(cwd, out),
    ],
    cwd,
  );
  return { file: out };
}

/**
 * 结尾卡适配用户视频画幅已移至 dubKernel（fitEndingCard）：合成前置职责，
 * 与 mux/字幕烧录同属内核面，测试也直接走它。
 */

/**
 * 视频配音模块唯一 API：输入导演剧本与源视频，输出 final.mp4。
 * @param {object} p
 * @param {string} p.taskId 任务 ID（派生结尾卡 seed + 日志；同 taskId 重出同款结尾）
 * @param {string} p.taskDir 输出目录（如 storage/outputs/<taskId>），自动创建
 * @param {string} p.videoFile 已校验源视频绝对路径（画面与时长权威源）
 * @param {object} p.cut 导演剧本（LLM 或程序兜底）：shots[].{line,pause_after} + end_line + bgm_emotion/bgm_on
 *   end_line（可选）：口头收束旁白，追加为最后一段 TTS；画面收束走 ending-kit 结尾卡（见 scene）
 * @param {string} p.voiceId TTS 音色
 * @param {string} p.scene 场景（online/offline/personal/sell/local 均可，归一到 sell/local/personal）
 * @param {string} [p.endingId] 钉结尾卡款（缺省按 seed 从场景池抽）
 * @param {(e:{progress?:number, stageText?:string})=>void} [p.onStage] 进度回调（0–100 任务中心刻度）
 * @returns {Promise<{outputPath:string, videoSec:number, narration:string, timings:object}>}
 */
export async function produceVideoDub({ taskId, taskDir, videoFile, cut, voiceId, scene, endingId, onStage = () => {} }) {
  mkdirSync(taskDir, { recursive: true });

  /* 逐阶段耗时：性能基线与回归对照用。T0 = 进模块时刻（LLM 在调用方，另行计时）。 */
  const T0 = Date.now();
  const timings = {};
  let lastMark = T0;
  const mark = (name) => {
    const now = Date.now();
    timings[name] = +((now - lastMark) / 1000).toFixed(2);
    lastMark = now;
  };

  /* —— 0. 旁白分段：导演剧本的视频分支 shots 即全片旁白分段（asset 恒 1）；
     end_line 口头收束追加为最后一段（同样走 TTS 实测，不估时长）。 —— */
  const segments = (Array.isArray(cut?.shots) ? cut.shots : [])
    .map((s) => ({
      line: String(s?.line ?? '').trim(),
      pauseAfter: Number(s?.pause_after) > 0 ? Math.min(1.5, Number(s.pause_after)) : DEFAULT_PAUSE_SEC,
    }))
    .filter((s) => s.line);
  const endLine = String(cut?.end_line || '').trim();
  if (endLine) segments.push({ line: endLine, pauseAfter: DEFAULT_PAUSE_SEC });
  if (!segments.length) throw new Error('配音文案为空：导演剧本未产出任何旁白分段');

  /* 源视频时长/画幅权威探测：先于 TTS，损坏文件直接失败（不浪费配音合成） */
  const baseDur = probeDurationSec(videoFile);
  if (!Number.isFinite(baseDur) || baseDur <= 0) {
    throw new Error('视频真实时长探测失败，文件可能已损坏，请重新上传');
  }
  const videoSize = probeVideoSize(videoFile);

  const workDir = path.join(taskDir, 'dub_work');
  mkdirSync(workDir, { recursive: true });

  /* —— 0.4 开场微光花字包装：共享层 @jansee/intro-kit，简兮经典 tpl_fashion_v1 上下双向微光排版 —— */
  let introFile = null;
  try {
    const introTitle = String(cut?.intro_title || cut?.title || cut?.publish?.cover_title || cut?.shots?.[0]?.line || '').trim();
    const introEn = String(cut?.intro_en || cut?.site || '').trim();
    const introNote = String(cut?.intro_note || cut?.shots?.[1]?.line || cut?.end_line || '留一席留白 · 慢下来品味').trim();
    const introIdx = String(cut?.intro_idx || 'NO. 01 / CINEMATIC DUB').trim();
    const introPng = path.join(workDir, 'intro.png');
    renderIntroPng({
      title: introTitle,
      brandEn: introEn,
      site: introEn,
      note: introNote,
      idx: introIdx,
      width: videoSize?.width || 1080,
      height: videoSize?.height || 1920,
      outPath: introPng,
    });
    introFile = introPng;
    console.log(`[video-dub] 开场花字与纯黑遮罩就绪: ${introPng}`);

    // 生成纯净宣发封面海报（方案 A：无台词字幕、无 AI 角标、电影级纯黑羽化遮罩）
    try {
      const coverOut = path.join(taskDir, 'cover.jpg');
      await composePureCover({
        bgSource: videoFile,
        title: introTitle,
        brandEn: introEn,
        site: introEn,
        note: introNote,
        idx: introIdx,
        width: videoSize?.width || 1080,
        height: videoSize?.height || 1920,
        outPath: coverOut,
        captureSec: 1.0,
      });
      console.log(`[video-dub] 纯净宣发封面海报就绪: ${coverOut}`);
    } catch (coverErr) {
      console.error('[video-dub] 封面海报制作跳过（不阻断成片）:', coverErr?.message || coverErr);
    }
  } catch (err) {
    console.error('[video-dub] 开场花字制作失败，本条不出开场花字:', err?.message || err);
    introFile = null;
  }
  mark('intro');

  /* —— 0.5 片尾收束卡：与图片成片同一份真源（ending-kit 15 款 = 3 场景 × 5 款），
     同 taskId 派生同一颗 seed——用户改个错字重出，结尾卡不换款。
     渲染只依赖 ending 与视频画幅，与 TTS 无依赖关系，串行成本一张 PNG 而已。 —— */
  onStage({ progress: 20, stageText: '正在制作片尾收束卡...' });
  let ctaFile = null;
  let endingUsed = null;
  try {
    const ending = pickEndingForTask(taskId, { scene: sceneForEngine(scene), endingId: endingId || cut?.ending_id || null });
    const endingPng = renderEndingPng({
      ending,
      brandZh: String(cut?.title || '').trim() || undefined,
      brandEn: String(cut?.site || '').trim() || undefined,
      outPath: path.join(workDir, 'ending.png'),
    });
    ctaFile = await fitEndingCard(workDir, endingPng, videoSize);
    endingUsed = ending.id;
  } catch (err) {
    /* 收束卡失败不阻断出片：配音成片是主交付，结尾卡是加分项 */
    console.error('[video-dub] 片尾收束卡制作失败，本条不出结尾卡:', err?.message || err);
    ctaFile = null;
  }
  mark('ending');

  /* —— 1. TTS 逐段实测（并行 + 缓存）；任何一段失败即任务失败——
     缺词的旁白是用户看不见的质量缺陷，不静默跳过。 */
  onStage({ progress: 25, stageText: '正在逐段合成配音...' });
  const ttsResults = await synthesizeLines(
    segments.map((s) => ({ content: s.line })),
    { voiceId, speed: clampSpeechSpeed(cut?.speech_speed) },
    taskDir,
  );
  mark('tts');

  /* —— 2. 时间轴：自适应呼吸压实与安全收束，确保台词在源视频结束前 0.8s 完整收声 ——
     杜绝“话还没念完画面就先黑”的恶劣体验：
     1) 纯语音时长探测与可用留白计算；
     2) 若总长逼近画面结尾，动态自适应压缩段间停顿（最小保留 0.08s 呼吸感）；
     3) 修正最后一段后不再累加无意义 pauseAfter，杜绝音轨虚胖。 */
  const safeVoiceEnd = Math.max(1.5, +(baseDur - 0.8).toFixed(2));
  const ttsDurs = segments.map((_, i) => ttsResults[i]?.durationSec || 0);
  const pureVoiceTotal = ttsDurs.reduce((a, b) => a + b, 0);

  // 计算每个段间实际停顿（最后一段无间隙）
  const gapsCount = Math.max(0, segments.length - 1);
  const actualPauses = [];
  if (gapsCount > 0) {
    const desiredPauses = segments.slice(0, -1).map((s) => s.pauseAfter);
    const desiredTotalPause = desiredPauses.reduce((a, b) => a + b, 0);
    const nominalTotal = pureVoiceTotal + desiredTotalPause;

    if (nominalTotal > safeVoiceEnd) {
      const availPausePool = Math.max(0, safeVoiceEnd - pureVoiceTotal);
      if (desiredTotalPause > 0 && availPausePool > 0) {
        const scale = availPausePool / desiredTotalPause;
        for (let i = 0; i < gapsCount; i += 1) {
          actualPauses.push(Math.max(0.08, +(desiredPauses[i] * scale).toFixed(2)));
        }
      } else {
        // 纯语音已逼近上限，段间停顿收敛为极简紧凑呼吸 0.06s
        for (let i = 0; i < gapsCount; i += 1) {
          actualPauses.push(0.06);
        }
      }
    } else {
      actualPauses.push(...desiredPauses);
    }
  }

  const parts = [];
  const cues = [];
  const duckWindows = [];
  let acc = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const r = ttsResults[i] || { file: '', durationSec: 0 };
    if (!r.file) throw new Error(`第 ${i + 1} 段配音合成失败（TTS 不可用或所选 voice 已下架：${voiceId}）`);
    const start = +acc.toFixed(2);
    const end = +(acc + r.durationSec).toFixed(2);
    parts.push({ file: r.file, start });
    cues.push({ content: segments[i].line, audioStart: start, audioEnd: end });
    duckWindows.push({ start, end });
    const gap = i < gapsCount ? actualPauses[i] : 0;
    acc = +(end + gap).toFixed(2);
  }
  const narrationTotal = parts.length ? cues[cues.length - 1].audioEnd : 0;

  /* —— 3. 拼接旁白音轨（段间呼吸停顿）—— */
  onStage({ progress: 40, stageText: '正在拼接旁白音轨...' });
  const narration = await concatNarration(workDir, parts, narrationTotal);
  mark('concat');

  /* —— 4. BGM：导演给情绪（bgm_emotion），audio-kit 选曲 + 两段式人声闪避。
     循环铺满整段视频时长（含片尾收束卡段，旁白结束尾段不空场）；
     bgm_on=false 或选曲失败都静默跳过，不阻断出片。 */
  let finalTrack = narration.file;
  if (cut?.bgm_on !== false) {
    onStage({ progress: 48, stageText: '正在挑选配乐...' });
    const picked = await selectBgmByEmotion(String(cut?.bgm_emotion || ''), duckWindows);
    if (picked?.bgmPath) {
      const mixed = await mixBgmUnder(workDir, narration.file, picked.bgmPath, picked.filterChain, baseDur + TAIL_SEC);
      finalTrack = mixed.file;
    }
  }
  mark('bgm');

  /* —— 5. 合成内核：音画对齐到「源视频 + 片尾收束卡」（trim+淡出 / 静音补满）
     → 开头淡入 + 结尾淡出 → tpad 黑尾 + CTA 卡淡入浮出 → 烧字幕 → final.mp4。 —— */
  onStage({ progress: 55, stageText: '正在混音与烧录字幕...' });
  const releaseSlot = await acquireComposeSlot(`video_dub_${taskId}`);
  let result;
  try {
    result = await composeDubTrack({
      taskDir,
      videoFile,
      audioFile: finalTrack,
      cues,
      ctaFile,
      introFile,
      onProgress: (pct, stageText) => {
        onStage({ progress: Math.round(60 + pct * 0.35), stageText });
      },
    });
  } finally {
    releaseSlot();
  }
  // 运行时过渡文件自动 GC：清理 workDir 碎片目录，仅保留最终成片 final.mp4 与 cover.jpg
  try {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  } catch (_gcErr) {}

  timings.grandTotalSec = +((Date.now() - T0) / 1000).toFixed(2);
  console.log(`[video-dub] ${taskId} 阶段耗时(s):`, JSON.stringify(timings));

  return {
    outputPath: result.output,
    videoSec: result.durationSec,
    coverPath: path.join(taskDir, 'cover.jpg'),
    narration: segments.map((s) => s.line).join(''),
    endingId: endingUsed,
    timings,
  };
}
