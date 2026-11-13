/**
 * @jansee/image-film —— 图片成片模块（对外唯一 API：produceImageFilm）
 *
 * 输入：导演剧本 cut（LLM 大导演产出，app 侧负责生成）+ 已校验商品图 + 音色 + 场景。
 * 输出：storage/outputs/<taskId>/final.mp4。
 *
 * 链路：台词对齐 → TTS 实测每镜时长（与画面预备并行）→ BGM 选曲+人声闪避 → V4 引擎一次合成。
 * 时长不估算：durationSec = TTS 实测 + 呼吸余量（0.7s），下限 2.4s——
 * 图片成片是唯一能纯 TTS 定时长的版块，画面是静图，配音说完才切下一张，
 * 任何"按字数估时长"都会造成音画错位。
 *
 * 调用方（任何需要图片成片的链路）：
 *   import { produceImageFilm } from '@jansee/image-film';
 *   const result = await produceImageFilm({ taskId, taskDir, materials, cut, voiceId, scene });
 * 导演剧本（cut）由调用方生成：LLM 大导演在 app 侧（依赖创作台账与变体判定），失败落程序兜底剧本。
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import { buildAiMetaTags } from '@jansee/subtitle-kit/aiBadge.js';
import { renderImageFilm, prepareImageFilm } from '@jansee/visual-engine-v4/imageFilm';
import { sceneForEngine, seedFromTaskId } from '@jansee/ending-kit';
import { synthesizeLines } from '@jansee/tts-kit/tts.js';
import { selectBgmByEmotion } from '@jansee/audio-kit/bgm.js';
import { composePureCover } from '@jansee/intro-kit';
import { acquireComposeSlot } from '@jansee/ffmpeg-kit/composeGate.mjs';

/* 说完话停一下再看下一张——沿用 scratch 真实试车验证过的节奏参数 */
const BREATH_SEC = 0.7;
const MIN_SHOT_SEC = 2.4;
/** 纯画面镜（无台词）：固定展示时长 */
const MUTE_SHOT_SEC = 2.5;
/** 静音占位时长（只为对齐音轨输入索引，越短越好） */
const SILENT_SEC = 0.4;
/** ffmpeg 滤镜图线程数：scale/overlay/crop 默认单线程。slice 线程化输出像素不变，
    但在 4 核机器上滤镜线程会与 x264 抢核导致耗时增加，默认 0（ffmpeg 原生行为）。大核机器可经环境变量开启。 */
const FILTER_THREADS = Number(process.env.IMAGE_FILM_FILTER_THREADS || 0);
/** x264 preset 覆盖：CRF 19 保证视觉无损画质，默认采用工业级极速预设 veryfast，兼顾极致速度与低内存驻留。 */
const PRESET_OVERRIDE = process.env.IMAGE_FILM_PRESET || 'veryfast';

/* 同一任务重出同一风格：seed 由 taskId 派生（FNV-1a）——实现在 @jansee/ending-kit，
   视频配音链路用同一颗种子抽同一款结尾卡，两边不许各写一套。 */

/* 静音占位：音轨输入索引 = 镜索引，一一对应，缺一镜会让后面全部错位。
   生成一段极短静音顶住索引，时间上被 atrim 裁掉，不影响成片。 */
function synthesizeSilence(outPath) {
  const r = spawnSync(ffmpegStatic, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `anullsrc=r=24000:cl=mono`,
    '-t', String(SILENT_SEC), '-q:a', '9', outPath,
  ], { timeout: 15000 });
  if (r.status !== 0) throw new Error(`静音占位生成失败：${String(r.stderr || '').slice(0, 200)}`);
}

/** 全片语速钳制：导演层已兜底，包边界再钳一次（0.85~1.25，防 atempo 失真）；缺省 1 零回归 */
function clampSpeechSpeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(1.25, Math.max(0.85, n));
}

/**
 * 图片成片模块唯一 API：输入导演剧本与商品图，输出 final.mp4。
 * @param {object} p
 * @param {string} p.taskId 任务 ID（派生 seed + 日志；同 taskId 重出同风格）
 * @param {string} p.taskDir 输出目录（如 storage/outputs/<taskId>），自动创建
 * @param {Array<{filePath:string}>} p.materials 已校验的商品图（1–9 张，顺序即镜序）
 * @param {object} p.cut 导演剧本（LLM 或程序兜底）：shots[].asset 为 1-based 图片编号，
 *   消费字段 title/subtitle/site/bgm_emotion/bgm_on + shots[].{line,side_typo}
 * @param {string} p.voiceId 音色
 * @param {string} p.scene 场景（online/offline/personal/sell/local/personal 均可，归一到 sell/local/personal）
 * @param {string} [p.layoutId] 钉版式（缺省由引擎按 seed 抽）
 * @param {string} [p.pairingId] 钉字体配对（缺省按 seed 从版式白名单抽；必须在版式白名单内）
 * @param {(e:{progress?:number, stageText?:string})=>void} [p.onStage] 进度回调（progress 为 0–100 的任务中心刻度）
 * @returns {Promise<object>} { outputPath, videoSec, slot, layout, pairingInfo, timings }
 */
export async function produceImageFilm({ taskId, taskDir, materials, cut, voiceId, scene, layoutId, pairingId, onStage = () => {} }) {
  const n = materials.length;
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
  /* 引擎阶段（plan/prescale/layout/subtitle/render）走 onProgress 事件差值计时 */
  const engineLast = { t: T0 };
  const engineMark = (stage) => {
    const now = Date.now();
    timings[`engine_${stage}`] = +((now - engineLast.t) / 1000).toFixed(2);
    engineLast.t = now;
  };

  /* —— 1. 台词对齐：导演输出的 asset 是 1-based 图片编号，可能与数组顺序不同 —— */
  const byAsset = new Map((Array.isArray(cut?.shots) ? cut.shots : []).map((s) => [Number(s.asset), s]));
  const shotTexts = materials.map((m, i) => byAsset.get(i + 1) || {});

  /* 全片级文案：说明行 = 副标题，署名 = 英文 site。五个槽位里 note/site 对全片五套版式
     都有实槽（T1–T5 底部说明行 + 署名位），不喂的话 T1/T2/T3/T5 底部全空、T4 主英文标尺废一半。 */
  const filmNote = String(cut?.subtitle || '').trim();
  const filmSite = String(cut?.site || '').trim();

  mark('align');

  /* 版面文案先定稿：预备与渲染必须用同一份 copy，两边现拼有漂移风险。 */
  /* V4 收敛定版（2026-10-24）：title 槽 = 成片主标题（cut.title，全片恒定，88-150px 主视觉大字，
     与实验室 LY_COPY.title='手作咖啡' 同口径）。V2 时代喂的每镜 sub_theme 已从契约拆除——
     实验室根本没有这个槽位；每镜差异由 label/en（side_typo）与 idx 承担，与实验室一致。 */
  const filmTitle = String(cut?.title || '').trim() || '精选好物';
  const copies = shotTexts.map((s, i) => {
    /* side_typo 只可能是字符串（sanitizeDirectorCut 已归一；这里再兜一层对象取 text）。
       同一个英文标尺喂 label 和 en 两个槽位：T1 用顶部小标、T2/T4 用英文槽，各取所需。 */
    const st = s.side_typo;
    const ruler = typeof st === 'string' ? st.trim() : String(st?.text || '').trim();
    return {
      title: filmTitle,
      label: ruler,
      en: ruler,
      note: filmNote,
      site: filmSite,
      idx: `${String(i + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}`,
    };
  });

  const effectiveLayoutId = layoutId || cut?.layout_id || undefined;
  const effectivePairingId = pairingId || cut?.pairing_id || undefined;

  /* —— 2. TTS 与「预备」并行：预备（plan + 图片超采样 + 版面/字幕/结尾卡 PNG）
        只依赖文案与图片，不等配音实测时长，整段吃进 TTS 等待窗口。
        prep 失败不阻断——renderImageFilm 没拿到 prepared 会走自带的全流程内联路径。 —— */
  onStage({ progress: 25, stageText: '正在逐镜合成配音...' });
  const filmWorkDir = path.join(taskDir, '.film-work');
  const filmCta = {
    scene: sceneForEngine(scene),
    endingId: cut?.ending_id || undefined,
    brandZh: String(cut?.title || '').trim() || undefined,
    brandEn: filmSite || undefined,
  };
  const prepPromise = prepareImageFilm({
    shots: materials.map((m, i) => ({
      imagePath: m.filePath,
      durationSec: MIN_SHOT_SEC, /* 占位：时长只影响时间窗，不影响本阶段任何产物 */
      line: String(shotTexts[i].line || '').trim(),
      copy: copies[i],
      motion: shotTexts[i].motion,
      climax: Boolean(shotTexts[i].climax || (cut?.climax_index && Number(cut.climax_index) === i + 1)),
    })),
    layoutId: effectiveLayoutId,
    pairingId: effectivePairingId,
    seed: seedFromTaskId(taskId),
    cta: filmCta,
    workDir: filmWorkDir,
    onProgress: (e) => { if (e && e.stage) engineMark(e.stage); },
  }).catch((err) => {
    console.error('[image-film] 预备阶段失败，渲染将走内联全流程:', err?.message || err);
    return null;
  });

  const ttsResults = await synthesizeLines(
    shotTexts.map((s) => ({ content: String(s.line || '').trim() })),
    { voiceId, speed: clampSpeechSpeed(cut?.speech_speed) },
    taskDir,
  );
  mark('tts');

  const shots = [];
  const voiceClips = [];
  const duckWindows = []; /* 人声区间（BGM 闪避窗口）：镜起点累加，与引擎时间线同一口径 */
  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    const r = ttsResults[i] || { file: '', durationSec: 0 };
    const line = String(shotTexts[i].line || '').trim();
    const copy = copies[i];
    const isClimax = Boolean(shotTexts[i].climax || (cut?.climax_index && Number(cut.climax_index) === i + 1));
    if (r.file) {
      const dur = Math.max(MIN_SHOT_SEC, +(r.durationSec + BREATH_SEC).toFixed(2));
      if (line) duckWindows.push({ start: +acc.toFixed(2), end: +(acc + r.durationSec).toFixed(2) });
      acc += dur;
      shots.push({
        imagePath: materials[i].filePath,
        durationSec: dur,
        line,
        copy,
        motion: shotTexts[i].motion,
        climax: isClimax,
      });
      voiceClips.push({ file: r.file });
    } else if (!line) {
      /* 纯画面镜：无台词 → 固定展示 + 静音占位对齐索引 */
      const silent = path.join(taskDir, 'tts', `silence_${String(i + 1).padStart(2, '0')}.mp3`);
      synthesizeSilence(silent);
      acc += MUTE_SHOT_SEC;
      shots.push({
        imagePath: materials[i].filePath,
        durationSec: MUTE_SHOT_SEC,
        line: '',
        copy,
        motion: shotTexts[i].motion,
        climax: isClimax,
      });
      voiceClips.push({ file: silent });
    } else {
      throw new Error(`第 ${i + 1} 镜配音合成失败（台词：${line.slice(0, 20)}…）`);
    }
  }

  /* —— 3. BGM：导演给情绪（bgm_emotion），audio-kit 轮转选曲 + 两段式人声闪避 ——
     duck 窗口 = 每镜人声区间（起点累加与引擎时间线同口径）；bgm_on=false 或选曲失败都静默跳过，
     不阻断出片。曲长不足整片由引擎 -stream_loop 循环。 */
  let bgm = null;
  if (cut?.bgm_on !== false) {
    onStage({ progress: 38, stageText: '正在挑选配乐...' });
    const picked = await selectBgmByEmotion(String(cut?.bgm_emotion || ''), duckWindows);
    if (picked) bgm = { file: picked.bgmPath, filterChain: picked.filterChain };
  }
  mark('bgm');

  /* —— 4. V4 引擎一次成型：近黑底 → 图片运镜 → 版面 → 字幕 → 淡黑 → 结尾卡 → 配音对齐 ——
     预备产物已就绪（通常 TTS 结束前就完成），这里只剩 ffmpeg 单遍合成。
     filterThreads：滤镜图 slice 并行，逐帧分片、输出像素不变，纯免费提速。 */
  onStage({ progress: 45, stageText: '正在渲染图片成片...' });
  const prepared = await prepPromise;
  mark('prepare');  /* 阶段刻度：plan/prescale/layout/subtitle 只在非预备路径（内联全流程）出现。
     render 段不再用固定 90 一跳到底——改为消费 ffmpeg 真实编码比例（46→99 连续爬升），
     预备路径下渲染占全片约 80% 时长，虚标就是从这里来的。 */
  /* 隐式标识（国标《标识办法》第五条，抖音等平台算法读元数据判 AIGC，缺了会限流）：
     字段单一真源 = subtitle-kit aiMetaTags（显式半边=两段式角标 PNG，同为共享层）。 */
  const metaTags = buildAiMetaTags(taskId);
  const stageProgress = { plan: 55, prescale: 62, layout: 72, subtitle: 82 };
  let renderSent = 0;
  const releaseSlot = await acquireComposeSlot(`image_film_${taskId}`);
  let result;
  try {
    result = await renderImageFilm({
      shots,
      prepared,
      layoutId: effectiveLayoutId,
      pairingId: effectivePairingId,
      filterThreads: FILTER_THREADS,
      preset: PRESET_OVERRIDE,
      seed: seedFromTaskId(taskId),
      cta: filmCta,
      audio: { voiceClips, bgm },
      metaTags,
      outputPath: path.join(taskDir, 'final.mp4'),
      workDir: filmWorkDir,
      onProgress: (e) => {
        if (e && e.stage) engineMark(e.stage);
        if (!e) return;
        if (e.stage === 'render' && Number.isFinite(e.ratio)) {
          /* 真实进度：ffmpeg 已编码时长 ÷ 成片总时长 → 任务刻度 46→99，只升不降 */
          const p = Math.min(99, 46 + Math.round(e.ratio * 53));
          if (p > renderSent) { renderSent = p; onStage({ progress: p }); }
          return;
        }
        const p = stageProgress[e.stage];
        if (p) onStage({ progress: p });
      },
    });
  } finally {
    releaseSlot();
  }
  mark('total');

  /* —— 5. 纯净宣发封面海报：基于首张原图 + 标题/英文字标 + 100%纯黑羽化遮罩，绝不含字幕与AI标识 —— */
  const coverPath = path.join(taskDir, 'cover.jpg');
  try {
    const firstImagePath = materials[0]?.filePath;
    if (firstImagePath) {
      await composePureCover({
        bgSource: firstImagePath,
        title: filmTitle,
        brandEn: filmSite || 'JANSEE FILM',
        site: filmSite || 'JANSEE STUDIO',
        note: filmNote || shotTexts[0]?.line || '一席留白 · 静待亲临',
        idx: `NO. 01 / ${String(n).padStart(2, '0')} SHOTS`,
        outPath: coverPath,
      });
      console.log(`[image-film] 纯净宣发封面海报就绪: ${coverPath}`);
      result.coverPath = coverPath;
    }
  } catch (covErr) {
    console.error('[image-film] 宣发封面海报生成异常(非阻断):', covErr?.message || covErr);
  }

  // 运行时过渡文件自动 GC：清理 filmWorkDir 与 tts 碎片目录，仅保留最终成片 final.mp4 与 cover.jpg
  try {
    if (filmWorkDir) rmSync(filmWorkDir, { recursive: true, force: true });
    rmSync(path.join(taskDir, 'tts'), { recursive: true, force: true });
  } catch (_gcErr) {}

  timings.grandTotalSec = +((Date.now() - T0) / 1000).toFixed(2);
  console.log(`[image-film] ${taskId} 阶段耗时(s):`, JSON.stringify(timings));
  result.timings = timings;
  return result;
}
