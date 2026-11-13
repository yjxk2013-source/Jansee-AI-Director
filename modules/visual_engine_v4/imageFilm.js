/**
 * 图片成片 · 执行引擎
 *
 * 定位：只执行，不创作。文案、时长、运镜种类由上游（LLM + 宪法导演）给定，
 * 这里只负责把"用户图 + 版式 + 动效"装配成一条 1080×1920 的成片。
 *
 * 三层彻底解耦（这是本文件最重要的约束）：
 *   1. 图片层 —— 唯一参与运镜与转场的层。每镜一张用户图，contain 进洞位，不裁不拉伸不改色。
 *   2. 版面层 —— 全片一套版式、一套字体配对，坐标恒定。文字只做入场动效，
 *               不参与运镜、不参与转场。镜边前 0.35s 文字 opacity 必须归零：
 *               slide 转场是整屏上滑，文字若还在，就会压在新旧两图的交界线上闪一下。
 *   3. 结尾   —— 全片统一：先 fadeblack 0.6s 到黑，再 CTA 2.6s 从黑里浮出来
 *                （黑停 0.35s + 淡入 0.85s 等片尾口径在 @jansee/ending-kit）。
 *
 * 时长口径：durationSec 由上游按 TTS 实测给，本引擎不估算、不凑整。
 * 台词为空的分镜（纯音乐镜）由上游给固定 2.5s，引擎不替它编时长。
 */
import { mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Resvg } from '@resvg/resvg-js';
import ffmpegStatic from 'ffmpeg-static';
import {
  CANVAS,
  FONTS_ROOT,
  LAYOUTS,
  buildLayoutSvg,
  fontFilesFor,
  imageBoxFor,
  layoutById,
  resolvePairing,
  slotForRatio,
} from './layouts.js';
import {
  ENDING_TAIL,
  endingCopyParts,
  pickEnding,
  renderEndingPng,
} from '@jansee/ending-kit';
import { SUBTITLE_FONT, SUBTITLE_PLAN, buildSubtitleCardSvg } from './subtitle.js';
/* 断句与时间轴在共享层，全平台唯一一份——别在这里再写一套断行规则。 */
import { planSubtitles } from '@jansee/subtitle-kit/plan.js';
import { AI_BADGE, renderAiBadgePng } from '@jansee/subtitle-kit/aiBadge.js';

/* ============ 可用的动效池 ============
   三条硬边界，决定了实验室的资产哪些能接、哪些不能：
   ① 缩放不能碰 —— ffmpeg 里"缩放随时间变"只有 zoompan 一条路，逐帧重采样步进会抖，
      静帧上尤其明显。实验室是 CSS + GPU 合成，transform: scale 免费且平滑，
      两套渲染栈的能力本来就不对等，不是偷懒。
   ② 整屏级转场不能碰 —— V4 的画面不是全幅图，是"洞位里的图 + 洞外近黑版面"，
      全屏变色（白闪）会在洞位边界露出矩形破绽。
   ③ 其余都可以 —— 纯位移 + 透明度都能用 crop / overlay 的坐标表达式连续驱动。 */
export const TEXT_ANIMS = ['fade_in', 'fade_up', 'slide_in'];
/* 运镜 4 种：全部是纯平移（含对角）。push_in / pull_out / breathing 属于①，不接。 */
export const MOTIONS = ['sweep_lr', 'sweep_rl', 'rise_up', 'diagonal'];
/** 导演运镜词表 → 引擎 4 种无损平移的映射 */
export const MOTION_MAP = {
  zoom_in: 'rise_up',
  zoom_out: 'diagonal',
  pan: 'sweep_lr',
  sweep: 'sweep_lr',
  sweep_lr: 'sweep_lr',
  sweep_rl: 'sweep_rl',
  rise_up: 'rise_up',
  diagonal: 'diagonal',
};

/* 转场 2 种：cut 硬切 / slide_down 整屏下滑。
   dissolve 实测过一轮（2026-10-23，seed=1 出片，抽帧 scratch/verify-ds/trans2_mid.png）：
   文字层的隐患确实已经被"淡出提前 2 帧 + 入场延后 0.4s"解决，转场窗口内一个字都没有；
   但**图片层过不去**——相邻两镜是两个不同场景/不同商品，交叉 0.4 秒等于给观众看双重曝光糊图，
   两张照片的高频细节叠在一起会变成一片噪点。滑动转场没有这个问题：两张图上下错位，各看各的。
   → dissolve 不是文字问题而是素材问题，商品图成片里不该开；同场景连续图才成立，代价是选题材。
   fadeblack / fadewhite 属于②：白闪会在洞位边界露馅；镜间黑场会让观众以为播完了。
   ⚠ 方向必须是下滑（slidedown）不是上滑：gyan 6.1.1-essentials 构建（ffmpeg-static 现用版本）
   的 xfade transition=slideup 有内存访问违例（0xC0000005），最小复现两张 1080×1080 图必崩、
   与时长无关；slideleft/slideright/slidedown/wipe/dissolve 全部正常（2026-10-24 逐个实测）。
   冒烟曾通过纯属随机种子没抽中它——线上 E2E 首跑即崩，别再改回 slideup。 */
export const TRANSITIONS = ['cut', 'slide_down'];

export const FILM_DEFAULTS = {
  /* 24fps（原 30）：渲染瓶颈在滤镜图逐帧处理，帧数是唯一线性杠杆——
     A/B 实测（scratch/bench-encode.mjs）同一条片 36.2s→24.9s（-31%），
     运镜/文字动效在 24fps 无感知差异，视频平台转码保留源帧率不吃第二刀。 */
  fps: 24,
  /**
   * 运镜过扫描：放大量。1.0 = 完全不动，1.10 = 四边各多出 5% 用来平移。
   * 这个值决定"运镜看不看得出来"：1.04 时 1080 宽的图只有 22px 可移动，
   * 三秒里挪 22px 肉眼等于静止——第一次试车就是这么废掉的。
   * 1.10 给出 108px 横移 / 72px 纵移，三秒内能明确读到"镜头在动"，
   * 代价是最外圈 5% 被裁掉。商品图四周通常有边距，裁不到主体。
   */
  overscan: 1.10,
  textInSec: 0.42,
  /** 镜边文字淡出时长。必须 ≥ 转场时长，否则文字会跨过镜边界压在两图交界上。 */
  textOutSec: 0.35,
  transitionSec: 0.4,
  /**
   * 淡黑时长。
   * 结束点就是 totalSec（正文最后一镜的结束时刻），所以它吃掉的正是最后一镜的尾巴。
   * 之后的黑停 / 结尾卡时长不在这里——片尾收束时间口径（黑停 0.35s + CTA 2.6s +
   * 淡入 0.85s）在 @jansee/ending-kit 的 ENDING_TAIL，与视频配音两条链路共用同一份。
   */
  fadeBlackSec: 0.6,
  /* crf23/veryfast（原 crf20/medium）：crf20 对手机端属画质过剩，23 视觉无损级
     且给平台再压缩留足余量（体积实测还小 25%）；veryfast 比 medium 再快 12%。
     基准：A(medium/20/30) 36.2s/0.22MB → C(veryfast/23/24) 24.9s/0.17MB。 */
  crf: 23,
  preset: 'veryfast',
};

/* ============ 确定性随机 ============
   同一订单必须重出同一结果：用户改个错字重出一次，整片风格全换是灾难级体验。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickKinds(rand, pool, k) {
  const rest = [...pool];
  const picked = [];
  for (let i = 0; i < k && rest.length; i += 1) {
    picked.push(rest.splice(Math.floor(rand() * rest.length), 1)[0]);
  }
  return picked;
}

/* ============ 编排（纯函数，可单测） ============
   不做创意：版式与配对由调用方指定或按场景随机；动效/运镜/转场各抽 2–3 种在全片轮换，
   相邻两镜不会撞同一种（k ≥ 2 时）。 */
export function planImageFilm({
  shots,
  images,
  layoutId,
  pairingId,
  seed = 1,
  style = {},
  fps = FILM_DEFAULTS.fps,
  cta = null,
} = {}) {
  if (!Array.isArray(shots) || shots.length === 0) throw new Error('planImageFilm: shots 不能为空');
  if (!Array.isArray(images) || images.length !== shots.length) {
    throw new Error(`planImageFilm: images(${images?.length}) 必须与 shots(${shots.length}) 一一对应`);
  }

  const rand = mulberry32(seed);
  /* 洞位按第一张图的比例定，全片锁定。逐镜换洞位等于每镜重新排版，画面会跳版。 */
  const firstRatio = images[0].width / images[0].height;
  const slot = shots[0].slot || slotForRatio(firstRatio);

  const layout = layoutId ? layoutById(layoutId) : LAYOUTS[Math.floor(rand() * LAYOUTS.length)];
  let pairing;
  if (pairingId) {
    /* 上游点名了配对：在白名单里就命中；不在就切默认——静默换掉字体会让人以为功能坏了。 */
    pairing = layout.allowed.includes(pairingId) ? pairingId : layout.defaultPairing;
  } else {
    /* 没点名：从该版式的兼容白名单里按 seed 抽，而不是永远退默认——
       默认路径只覆盖 4 种配对，另外 4 套等于白入库。白名单"每套配对都有版式承载"
       已由 layouts 对账测试保证。注意：这消耗一次 rand，与旧版"退默认"的出片不同 seed 序。 */
    pairing = layout.allowed[Math.floor(rand() * layout.allowed.length)];
  }
  const pairingInfo = resolvePairing(pairing);

  const textAnimKinds = pickKinds(rand, TEXT_ANIMS, 2 + Math.floor(rand() * 2));
  const motionKinds = pickKinds(rand, MOTIONS, 2 + Math.floor(rand() * 2));
  const transKinds = pickKinds(rand, TRANSITIONS, Math.min(2, TRANSITIONS.length));

  let cursor = 0;
  let lastPanDir = 'sweep_rl';
  const timeline = shots.map((shot, i) => {
    const durationSec = Number(shot.durationSec);
    if (!(durationSec > 0)) {
      throw new Error(`planImageFilm: 第 ${i + 1} 镜缺少 durationSec（应由 TTS 实测给出，纯音乐镜给 2.5）`);
    }
    const start = cursor;
    cursor += durationSec;

    // 运镜放权：优先采纳上游 LLM 或用户指定的合法 motion；未指定则按 seed 抽选
    let selectedMotion = null;
    const reqMotion = String(shot.motion || '').trim().toLowerCase();
    if (reqMotion && MOTION_MAP[reqMotion]) {
      if (reqMotion === 'pan') {
        selectedMotion = lastPanDir === 'sweep_lr' ? 'sweep_rl' : 'sweep_lr';
        lastPanDir = selectedMotion;
      } else {
        selectedMotion = MOTION_MAP[reqMotion];
      }
    } else {
      selectedMotion = motionKinds[i % motionKinds.length];
    }

    return {
      index: i + 1,
      start,
      durationSec,
      end: cursor,
      motion: selectedMotion,
      climax: Boolean(shot.climax),
      textAnim: textAnimKinds[i % textAnimKinds.length],
      /* 最后一镜没有下一镜，转场无意义 */
      transition: i < shots.length - 1 ? transKinds[i % transKinds.length] : 'cut',
    };
  });

  const totalSec = cursor;
  /* 片尾：淡黑（吃正文尾巴）+ 黑停 + 结尾卡。后两段的时长口径在 ending-kit
     （ENDING_TAIL），视频配音复用同一套，两条链路的片尾节奏必须一致。 */
  const tailSec = FILM_DEFAULTS.fadeBlackSec + ENDING_TAIL.endHoldSec + ENDING_TAIL.ctaSec;
  /* —— 口播字幕 ——
     文案就是上游给 TTS 的那句 `line`，不另写一套：同一句话配音念它、字幕显示它，
     两边永远不会不同步。镜内分几屏由字数决定（见 subtitle.js），时间按字数比例切。
     末镜字幕要提前在 fadeBlack 之前收掉，否则它会跟着画面一起被淡掉，
     变成"字在变暗但还没消失"的糊状残影。 */
  const subtitleCards = [];
  timeline.forEach((seg, i) => {
    const text = String(shots[i].line ?? shots[i].subtitle ?? '').trim();
    if (!text) return;
    const prevTrans = i > 0 ? timeline[i - 1].transition : null;
    const enterDelay = i > 0 && prevTrans !== 'cut' ? FILM_DEFAULTS.transitionSec : 0;
    const st = seg.start + enterDelay;
    let en = seg.start + seg.durationSec - FILM_DEFAULTS.textOutSec;
    if (i === timeline.length - 1) en = Math.min(en, totalSec - FILM_DEFAULTS.fadeBlackSec);
    /* 极短镜（<1s）窗口会算成负数，退回整镜——短镜本来就一句话一闪，不能没有字幕 */
    if (en <= st) en = seg.start + seg.durationSec;
    for (const card of planSubtitles({ text, startSec: st, endSec: en, ...SUBTITLE_PLAN })) {
      subtitleCards.push({ ...card, shotIndex: i });
    }
  });

  /* 结尾卡：文案与骨架都由同一颗 seed 决定（传入 cta 才会抽） */
  const ending = cta ? planEnding(rand, cta) : null;
  return {
    slot,
    layout,
    pairing,
    pairingInfo,
    timeline,
    totalSec,
    tailSec,
    videoSec: totalSec + tailSec,
    fps,
    pools: { textAnimKinds, motionKinds, transKinds },
    subtitleCards,
    ending,
    style,
  };
}

/* ============ 版面 PNG ============ */
function renderSvgToPng(svg, pairing, outPath) {
  const F = typeof pairing === 'string' ? resolvePairing(pairing) : pairing;
  const png = new Resvg(svg, {
    font: { fontFiles: fontFilesFor(F.id), loadSystemFonts: false, defaultFontFamily: F.display },
    fitTo: { mode: 'width', value: CANVAS.width },
  })
    .render()
    .asPng();
  mkdirSync(path.dirname(outPath), { recursive: true });
  /* PNG 只有几十到几百 KB，同步直写即可——为它把整条渲染链改成 async 不值得 */
  writeFileSync(outPath, png);
  return outPath;
}

export function renderLayoutPng({ layout, slot, pairing, copy, outPath }) {
  const svg = buildLayoutSvg({ layout, slot, pairing, copy });
  return renderSvgToPng(svg, pairing, outPath);
}

/** 字幕卡：字体固定思源黑，不跟随正文配对——可读性优先于风格统一。 */
export function renderSubtitlePng({ lines, slot, outPath }) {
  const svg = buildSubtitleCardSvg({ lines, slot });
  if (!svg) return null;
  const png = new Resvg(svg, {
    font: {
      fontFiles: [path.join(FONTS_ROOT, 'noto-sans-sc', SUBTITLE_FONT.file)],
      loadSystemFonts: false,
      defaultFontFamily: SUBTITLE_FONT.zh,
    },
    fitTo: { mode: 'width', value: CANVAS.width },
  })
    .render()
    .asPng();
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, png);
  return outPath;
}

/* 结尾卡渲染已移至 @jansee/ending-kit（renderEndingPng）：图片成片与视频配音
   两条链路烧同一张脸，渲染只许有一份。结尾卡固定 Noto Sans SC + Jost，
   不跟随正文配对——结尾是全片唯一「纯字卡」，跟随配对会每单变风格。 */

/* ============ 结尾卡编排 ============
   15 款全部来自 V4 视觉实验室（3 场景 × 5 款），引擎不自带任何尾句。
   抽样必须吃同一个 rand：用户改个错字重出一次，结尾标语整个换掉是灾难级体验。 */
function planEnding(rand, { scene = 'sell', endingId = null } = {}) {
  const item = pickEnding(rand, { scene, endingId });
  const { zh, en } = endingCopyParts(item);
  return { ...item, zh, en };
}

/* ============ 运镜表达式 ============ */
function motionExpr(motion, boxW, boxH, durationSec, overscan, isClimax = false) {
  const effOverscan = isClimax ? Math.max(overscan * 1.035, 1.135) : overscan;
  const ampX = Math.max(0, Math.round(boxW * (effOverscan - 1) / 2));
  const ampY = Math.max(0, Math.round(boxH * (effOverscan - 1) / 2));
  const cx = `(iw-${boxW})/2`;
  const cy = `(ih-${boxH})/2`;
  const progress = `min(t/${durationSec.toFixed(3)},1)`;
  if (motion === 'sweep_lr') {
    /* 起手在右，向左扫。t 是相对本段输入的秒数，每段都从 0 开始。 */
    return { x: `${cx}+${ampX}*(1-${progress})`, y: `${cy}` };
  }
  if (motion === 'sweep_rl') {
    return { x: `${cx}-${ampX}*(1-${progress})`, y: `${cy}` };
  }
  /* diagonal：两轴同时起手，从右上往左下斜掠。
     overscan 只有 10%，两轴各自幅度不变，斜向位移总量 √(108²+72²) ≈ 129px，
     比单轴更能读出"镜头在动"。 */
  if (motion === 'diagonal') {
    return { x: `${cx}+${ampX}*(1-${progress})`, y: `${cy}+${ampY}*(1-${progress})` };
  }
  /* rise_up：自下而上微抬（也是未知值的兜底） */
  return { x: `${cx}`, y: `${cy}+${ampY}*(1-${progress})` };
}

function textAnimOverlayXY(textAnim, start) {
  /* 位移只在入场 0.42s 内发生，之后恒为 0。t < start 时 alpha 已是 0，位移量不影响观感。 */
  const p = `max(0,min((t-${start.toFixed(3)})/${FILM_DEFAULTS.textInSec},1))`;
  if (textAnim === 'fade_up') return { x: '0', y: `'24*(1-${p})'` };
  if (textAnim === 'slide_in') return { x: `'-56*(1-${p})'`, y: '0' };
  return { x: '0', y: '0' };
}

/* ============ AI 显式标识（国标 GB 45438-2025 两段式） ============
   单一真源在共享层 @jansee/subtitle-kit/aiBadge.js：规则常量（AI_BADGE）+ PNG 渲染
   （renderAiBadgePng，思源黑 Regular）都在那里（文件头部 import）。引擎只消费——
   与 4 条视频链路的 drawtext 版是同一套规则、同一款字体、同一张脸。 */

/* 裁掉 PNG 的全透明边，返回内容在原画布上的偏移。
   overlay 逐帧做 alpha 混合，混合面积与 PNG 面积成正比——版面/字幕/结尾卡都是
   1080×1920 整幅图，实测内容只占 20%~30%（探针：全帧 4.3s vs 裁边 3.6s / 150 帧）。
   裁边后 overlay 坐标加回偏移，合成结果逐像素等价（透明边贡献本来就为零）。 */
async function trimAlphaBBox(pngPath) {
  const sharp = (await import('sharp')).default;
  const buf = await sharp(pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = buf;
  let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0 }; /* 全透明（不该发生）：不裁，保底 */
  await sharp(buf.data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 })
    .png()
    .toFile(pngPath);
  return { x: x0, y: y0 };
}

/* 批量裁边：全部版面与字幕 PNG 异步并发裁剪，消除逐图阻塞等待 */
async function trimOverlays({ layoutPngs, subtitlePngs, ctaPath }) {
  const [layoutOffsets, subtitleOffsets, ctaOffset] = await Promise.all([
    Promise.all((layoutPngs || []).map(trimAlphaBBox)),
    Promise.all((subtitlePngs || []).map(trimAlphaBBox)),
    ctaPath ? trimAlphaBBox(ctaPath) : Promise.resolve(null),
  ]);
  return { layoutOffsets, subtitleOffsets, ctaOffset };
}

/* ============ 滤镜图（纯函数，可单测） ============
   输入索引约定：0..N-1 为图片，N..2N-1 为版面 PNG，最后一支为 CTA（若有）。 */
export function buildFilmFilterGraph({ plan, images, hasCta, audio, overlays = {}, badges = null }) {
  const { slot, timeline, totalSec, tailSec, fps } = plan;
  const overscan = plan.style.overscan || FILM_DEFAULTS.overscan;
  const xf = FILM_DEFAULTS.transitionSec;
  const N = timeline.length;
  const proto = [];

  /* 底板：洞位上下条带的底色。文字与 CTA 都压在这块近黑上。 */
  proto.push(`color=c=0x0A0A0E:s=${CANVAS.width}x${CANVAS.height}:r=${fps}:d=${(totalSec + tailSec).toFixed(3)},format=yuv420p[base]`);

  /* —— 图片层：contain → 过扫描 → 运镜 crop → 透明 pad 到洞位宽 —— */
  timeline.forEach((seg, i) => {
    const img = images[i];
    const box = imageBoxFor(slot, img.width, img.height);
    const segOverscan = seg.climax ? Math.max(overscan * 1.035, 1.135) : overscan;
    const { x, y } = motionExpr(seg.motion, box.width, box.height, seg.durationSec + (i < N - 1 ? xf : 0), overscan, seg.climax);
    /* 段长 = 可见时长 + 转场时长：xfade 会吃掉转场那一段，多渲染一份才保证总时长不缩水 */
    const segDur = seg.durationSec + (i < N - 1 ? xf : 0);
    const targetW = Math.ceil((box.width * segOverscan) / 2) * 2;
    const targetH = Math.ceil((box.height * segOverscan) / 2) * 2;
    proto.push(
      `[${i}:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase:force_divisible_by=2,setsar=1,fps=${fps},` +
      `crop=${box.width}:${box.height}:x='${x}':y='${y}',` +
      `pad=${CANVAS.width}:${slot.h}:${Math.round((CANVAS.width - box.width) / 2)}:${Math.round((slot.h - box.height) / 2)}:color=0x00000000,` +
      `format=yuva420p,tpad=stop_mode=add:stop_duration=${xf.toFixed(3)}:color=0x00000000,` +
      `trim=duration=${segDur.toFixed(3)},setpts=PTS-STARTPTS,fps=${fps}[img${i}]`,
    );
  });

  /* —— 图片层串接：cut 走 concat，其余走 xfade。混合时统一走 xfade，cut 用 40ms 近似硬切 —— */
  let current = 'img0';
  const offsets = [];
  let acc = timeline[0].durationSec;
  for (let i = 1; i < N; i += 1) {
    offsets.push(acc);
    const prevTransition = timeline[i - 1].transition;
    /* 短镜（< 2 倍转场时长）容不下叠化或滑动，强制降级成 40ms 近似硬切 */
    const isCut = prevTransition === 'cut' || timeline[i - 1].durationSec < xf * 2;
    const dur = isCut ? 0.04 : xf;
    /* slidedown 不是 slideup：后者在 ffmpeg 6.1.1 gyan 构建必崩（见 TRANSITIONS 注释） */
    const trans = isCut ? 'fade' : 'slidedown';
    const out = i === N - 1 ? 'imgTrack' : `imgMix${i}`;
    proto.push(`[${current}][img${i}]xfade=transition=${trans}:duration=${dur}:offset=${acc.toFixed(3)}[${out}]`);
    current = out;
    acc += timeline[i].durationSec;
  }
  if (N === 1) proto.push('[img0]null[imgTrack]');

  proto.push(`[imgTrack]trim=duration=${totalSec.toFixed(3)},setpts=PTS-STARTPTS[imgFinal]`);

  /* —— 底图 = 纯色底板 + 图片层（只在洞位区域内） —— */
  proto.push(`[base][imgFinal]overlay=0:${slot.bar}:shortest=1:format=auto[canvas]`);

  /* —— 版面层：全片一套版式，坐标恒定，只做入场动效 —— */
  let v = 'canvas';
  timeline.forEach((seg, i) => {
    const idx = N + i;
    /* 文字必须等转场走完才出现。slidedown 是整屏下滑，转场期间画面里同时有两张图，
       文字这时淡入会正好骑在两图交界线上。cut 是硬切、没有重叠区，不需要延后。
       延后多少，淡出就要提前多少，否则整组会跨过镜边界推到下一镜。 */
    const prevTrans = i > 0 ? timeline[i - 1].transition : null;
    const enterDelay = i > 0 && prevTrans !== 'cut' ? xf : 0;
    const textStart = seg.start + enterDelay;
    /* 淡出必须在素材结束前整整收完。
       若让 fade 的结束点压在素材末尾，最后一帧的 alpha 不会精确等于 0
       （3.9s @30fps = 117 帧，末帧落在 3.867，淡出只走到 91%），
       而 overlay 的 eof_action=pass 会把这一帧冻结住——
       屏幕上就是一层去不掉的文字鬼影，而且因为版面坐标全片固定，
       它会跟下一镜的文字精确叠在同一位置，看起来只是"字有点脏"。
       提前两帧收尾，末帧 alpha 严格为 0。 */
    const outEnd = Math.max(0, seg.durationSec - enterDelay) - 2 / fps;
    const outSt = Math.max(0, outEnd - FILM_DEFAULTS.textOutSec);
    proto.push(
      `[${idx}:v]format=rgba,` +
      `fade=t=in:st=0:d=${FILM_DEFAULTS.textInSec}:alpha=1,` +
      `fade=t=out:st=${outSt.toFixed(3)}:d=${FILM_DEFAULTS.textOutSec}:alpha=1,` +
      `tpad=start_duration=${textStart.toFixed(3)}:start_mode=add:color=0x00000000[txt${i}]`,
    );
    const shift = textAnimOverlayXY(seg.textAnim, textStart);
    const off = overlays.layoutOffsets?.[i] || { x: 0, y: 0 };
    const out = i === N - 1 ? 'canvasText' : `vTxt${i}`;
    proto.push(`[${v}][txt${i}]overlay=${off.x}+${shift.x}:${off.y}+${shift.y}:eof_action=pass:format=auto[${out}]`);
    v = out;
  });
  if (N === 0) proto.push('[canvas]null[canvasText]');

  /* —— 字幕层：压在版面之上、淡黑之前 ——
     每条字幕一张整幅透明 PNG，靠 overlay 的 enable 时间窗控制显隐，不做 tpad 位移：
     位移方案一旦 eof 就会用 eof_action 冻结最后一帧，一条字幕会赖着不走。
     时间窗已经避开转场与镜末淡出，所以字幕之间是硬切——专业字幕本来就不该有动效。 */
  const subtitleCards = plan.subtitleCards || [];
  subtitleCards.forEach((card, k) => {
    const idx = 2 * N + k;
    proto.push(`[${idx}:v]format=rgba[sub${k}]`);
    const out = `vSub${k}`;
    const so = overlays.subtitleOffsets?.[k] || { x: 0, y: 0 };
    proto.push(
      `[${v}][sub${k}]overlay=${so.x}:${so.y}:eof_action=pass:format=auto:` +
      `enable='between(t,${card.startSec.toFixed(3)},${card.endSec.toFixed(3)})'[${out}]`,
    );
    v = out;
  });

  /* —— 结尾：先 fadeblack 到黑，再让 CTA 从黑里浮出来 —— */
  const fadeStart = Math.max(0, totalSec - FILM_DEFAULTS.fadeBlackSec);
  proto.push(
    `[${v}]fade=t=out:st=${fadeStart.toFixed(3)}:d=${FILM_DEFAULTS.fadeBlackSec}:color=black,` +
    `tpad=stop_mode=add:stop_duration=${tailSec.toFixed(3)}:color=black[body]`,
  );

  /* 输入索引必须显式算：图片 0..N-1、版面 N..2N-1、字幕 2N..2N+S-1、CTA 紧接字幕之后、AI 标识再后。 */
  const ctaIdx = 2 * N + subtitleCards.length;
  let finalLabel = 'body';
  if (hasCta) {
    proto.push(
      `[${ctaIdx}:v]format=rgba,fade=t=in:st=0:d=${ENDING_TAIL.fadeInSec}:alpha=1,tpad=start_duration=${(totalSec + ENDING_TAIL.endHoldSec).toFixed(3)}:start_mode=add:color=0x00000000[cta]`,
    );
    const co = overlays.ctaOffset || { x: 0, y: 0 };
    proto.push(`[body][cta]overlay=${co.x}:${co.y}:eof_action=pass:format=auto[withCta]`);
    finalLabel = 'withCta';
  }

  /* —— AI 显式标识层：两段式时间窗，压在包括结尾卡在内的所有画面之上 ——
     输入索引：AI 头段 = ctaIdx+(hasCta?1:0)，AI 尾段 = 头段+1（仅在无CTA且有尾标时），音轨输入再往后顺移。 */
  const outDur = totalSec + tailSec;
  let outLabel = finalLabel;
  let badgeCount = 0;
  if (badges) {
    const headIdx = ctaIdx + (hasCta ? 1 : 0);
    const headEnd = Math.min(AI_BADGE.headSec, outDur);
    if (badges.head) {
      badgeCount++;
      proto.push(`[${headIdx}:v]format=rgba[aiH]`);
      proto.push(
        `[${finalLabel}][aiH]overlay=${badges.head.x}:${badges.head.y}:eof_action=pass:format=auto:` +
        `enable='between(t,0,${headEnd.toFixed(3)})'[aiH1]`,
      );
      outLabel = 'aiH1';
    }
    // 只有在没有 CTA 结尾收束卡时，才由外部独立画 tail 尾标；若有 CTA 收束卡，收束卡已统一内置国标尾标，严禁重复烧录！
    if (badges.tail && !hasCta) {
      const tailIdx = headIdx + badgeCount;
      badgeCount++;
      const tailStart = Math.max(0, outDur - AI_BADGE.tailSec);
      proto.push(`[${tailIdx}:v]format=rgba[aiT]`);
      proto.push(
        `[${outLabel}][aiT]overlay=${badges.tail.x}:${badges.tail.y}:eof_action=pass:format=auto:` +
        `enable='between(t,${tailStart.toFixed(3)},${outDur.toFixed(3)})'[aiBadge]`,
      );
      outLabel = 'aiBadge';
    }
  }
  proto.push(`[${outLabel}]trim=duration=${outDur.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p[outv]`);

  /* —— 音轨：上游按镜切好的配音，按开始时间铺开；BGM 单独一支，降混由 audio-kit 做 ——
     输入索引必须显式算：图片 0..N-1、版面 N..2N-1、字幕跟着、CTA 再后、AI 标识再后、配音最后。
     写 [a0] 这种自造标签 ffmpeg 不认，会直接报 "Invalid file index"。 */
  if (audio && Array.isArray(audio.voiceClips) && audio.voiceClips.length) {
    const audioBase = 2 * N + subtitleCards.length + (hasCta ? 1 : 0) + badgeCount;
    const parts = audio.voiceClips.map((clip, i) => {
      const startMs = Math.round((timeline[i]?.start || 0) * 1000);
      proto.push(`[${audioBase + i}:a]aresample=48000,adelay=${startMs}|${startMs}[aP${i}]`);
      return `[aP${i}]`;
    });
    /* BGM 单独一支：选曲与人声闪避（两段式音量）由 audio-kit 做，这里只把它的滤镜链
       接到真实输入索引上。filterChain 以 [bgm] 占位开头、[bgmout] 结尾；曲长不足整片
       时靠 args 侧 -stream_loop 循环，末尾由 atrim 裁齐。依赖 voiceClips 存在（amix 复用同一出口）。 */
    if (audio.bgm?.file && audio.bgm.filterChain) {
      const bgmIdx = audioBase + audio.voiceClips.length;
      const chain = String(audio.bgm.filterChain)
        .replace('[bgm]', `[${bgmIdx}:a]aresample=48000,`)
        .replace('[bgmout]', '[aB]');
      proto.push(chain);
      parts.push('[aB]');
    }
    const totalAudioDur = totalSec + tailSec;
    // 结尾音频平滑淡出：成片结束前 1.5s 逐渐衰减至完全无声，杜绝片尾音乐断崖式戛然而止
    const audioFadeDur = Math.min(1.5, Math.max(0.3, +(totalAudioDur * 0.1).toFixed(3)));
    const audioFadeStart = Math.max(0, +(totalAudioDur - audioFadeDur).toFixed(3));
    proto.push(
      `${parts.join('')}amix=inputs=${parts.length}:duration=longest:dropout_transition=0:normalize=0,` +
      `atrim=duration=${totalAudioDur.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `afade=t=out:st=${audioFadeStart.toFixed(3)}:d=${audioFadeDur.toFixed(3)}[outa]`,
    );
  }

  return { graph: proto.join(';'), hasAudio: !!(audio && audio.voiceClips?.length) };
}

/* ============ ffmpeg 执行 ============
   opts.totalSec + opts.onRatio：真实进度。挂上 -progress pipe:1 后 ffmpeg 在 stdout
   按 key=value 吐进度，out_time_us 是已编码到的时间点——除以成片总时长就是真实比例，
   进度条不再需要任何估算或拍脑袋的阶段跳变。 */
function runFfmpeg(binary, args, crashDumpDir = null, opts = {}) {
  const { totalSec = 0, onRatio = null } = opts;
  const useProgress = typeof onRatio === 'function' && totalSec > 0;
  return new Promise((resolve, reject) => {
    /* -progress/-nostats 是全局选项，插在头部全局段末尾（-hide_banner 之后）最稳 */
    const finalArgs = useProgress
      ? [...args.slice(0, 2), '-progress', 'pipe:1', '-nostats', ...args.slice(2)]
      : args;
    const child = spawn(binary, finalArgs, {
      windowsHide: true,
      stdio: ['ignore', useProgress ? 'pipe' : 'ignore', 'pipe'],
    });
    let stderr = '';
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
            /* 每前进 1% 才上报一次，避免事件风暴 */
            if (ratio - lastSent >= 0.01 || ratio >= 1) {
              lastSent = ratio;
              onRatio(ratio);
            }
          }
        }
      });
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else {
        /* 0xC0000005（访问违例）这类原生崩溃 stderr 常是空的——不落盘完整命令与滤镜图，
           线上只能看到一个数字，没法复现。dump 到 workDir 供人工重放。 */
        if (crashDumpDir) {
          try {
            mkdirSync(crashDumpDir, { recursive: true });
            writeFileSync(path.join(crashDumpDir, 'ffmpeg-crash.json'),
              JSON.stringify({ code, args, graph: args[args.indexOf('-filter_complex') + 1] }, null, 2));
          } catch (_e) { /* dump 失败不影响原错误抛出 */ }
        }
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-3000)}`));
      }
    });
  });
}

/* 预备与渲染的一致性指纹：图片路径 + 台词 + 文案。预备后任何一项被改动都必须报错，
   与其出一张错位的卡不如 fail fast——文案错位是产品事故，重跑只是几秒。 */
function shotsFingerprint(shots) {
  return createHash('sha1')
    .update(JSON.stringify(shots.map((s) => [s.imagePath, s.line ?? null, s.copy ?? null])))
    .digest('hex')
    .slice(0, 12);
}

/**
 * 预备阶段：plan + 源图超采样 + 版面/字幕/结尾卡 PNG。
 * 只依赖图片与文案（copy/line），不依赖 TTS 实测时长——时长只进 ffmpeg 的时间窗，
 * 因此本函数可与 TTS 并行执行，把整个预备段吃进配音等待窗口。
 * shots[].durationSec 在此阶段用占位值即可（如 MIN_SHOT_SEC），几何与卡片不受影响。
 * 返回 prepared 交给 renderImageFilm 的 prepared 参数；workDir 必须与最终渲染同一目录。
 */
export async function prepareImageFilm({
  shots,
  layoutId,
  pairingId,
  seed = 1,
  style = {},
  cta = null,
  workDir,
  onProgress = null,
} = {}) {
  if (!Array.isArray(shots) || !shots.length) throw new Error('prepareImageFilm: shots 不能为空');
  if (!workDir) throw new Error('prepareImageFilm: 缺少 workDir（必须与 renderImageFilm 同一目录）');
  const dir = workDir;
  mkdirSync(dir, { recursive: true });

  /* 读图片真实尺寸：洞位选择与 contain 都靠它，不能信上游给的宽高 */
  const images = await Promise.all(shots.map(async (s) => {
    if (!existsSync(s.imagePath)) throw new Error(`prepareImageFilm: 图片不存在 ${s.imagePath}`);
    const sharp = (await import('sharp')).default;
    const meta = await sharp(s.imagePath).metadata();
    return { path: s.imagePath, width: meta.width, height: meta.height };
  }));

  const plan = planImageFilm({ shots, images, layoutId, pairingId, seed, style, fps: FILM_DEFAULTS.fps, cta });
  if (onProgress) onProgress({ stage: 'plan', plan });

  /* —— 预缩放源图（与 renderImageFilm 内联路径同口径，见其注释） —— */
  const overscanBase = plan.style.overscan || FILM_DEFAULTS.overscan;
  const renderPaths = await Promise.all(images.map(async (img, i) => {
    const isClimax = Boolean(plan.timeline[i]?.climax);
    const overscanUsed = isClimax ? Math.max(overscanBase * 1.035, 1.135) : overscanBase;
    const box = imageBoxFor(plan.slot, img.width, img.height);
    const w = Math.ceil((box.width * overscanUsed) / 2) * 2;
    const h = Math.ceil((box.height * overscanUsed) / 2) * 2;
    if (w >= img.width || h >= img.height) return img.path; /* 原图本来就不大，缩了反而放大 */
    const out = path.join(dir, `src_${i}.jpg`);
    const sharp = (await import('sharp')).default;
    await sharp(img.path).resize(w, h, { fit: 'cover', kernel: sharp.kernel.lanczos3 }).jpeg({ quality: 96 }).toFile(out);
    return out;
  }));
  if (onProgress) onProgress({ stage: 'prescale', count: renderPaths.length });

  const layoutPngs = shots.map((shot, i) => {
    const outPath = path.join(dir, `layout_${i}.png`);
    renderLayoutPng({ layout: plan.layout, slot: plan.slot, pairing: plan.pairingInfo, copy: shot.copy || {}, outPath });
    return outPath;
  });
  if (onProgress) onProgress({ stage: 'layout', count: layoutPngs.length });

  const subtitlePngs = plan.subtitleCards
    .map((card, k) => renderSubtitlePng({ lines: card.lines, slot: plan.slot, outPath: path.join(dir, `sub_${k}.png`) }))
    .filter(Boolean);
  if (onProgress) onProgress({ stage: 'subtitle', count: subtitlePngs.length });

  let ctaPath = null;
  if (plan.ending) {
    ctaPath = path.join(dir, 'cta.png');
    renderEndingPng({ ending: plan.ending, brandZh: cta.brandZh, brandEn: cta.brandEn, outPath: ctaPath });
  }

  /* 裁掉三卡的全透明边（见 trimAlphaBBox 注释），偏移交给滤镜图回填 overlay 坐标 */
  const overlays = await trimOverlays({ layoutPngs, subtitlePngs, ctaPath });

  return {
    dir,
    images,
    renderPaths,
    layoutPngs,
    subtitlePngs,
    ctaPath,
    overlays,
    probe: {
      layoutId: plan.layout.id,
      pairing: plan.pairing,
      fps: FILM_DEFAULTS.fps,
      subtitleCount: plan.subtitleCards.length,
      endingId: plan.ending ? plan.ending.id : null,
      sig: shotsFingerprint(shots),
    },
  };
}

/**
 * 出片主入口。
 * shots: [{ imagePath, durationSec, copy:{title,label,en,note,idx,site}, sourceShot }]
 *   时长与文案都由上游给；copy 里空字段会被版式整组跳过，不会留空槽。
 * prepared: prepareImageFilm 的返回值（可选）。给出后跳过 plan/超采样/卡片渲染阶段
 *   （它们只依赖图片与文案，不依赖时长，可与 TTS 并行预先完成）；
 *   本函数会用真实时长重算 plan 的时间线，并用 probe 指纹守卫两份 plan 的一致性。
 * filterThreads: -filter_complex_threads 值。0 = 不传（ffmpeg 默认单线程）。
 *   滤镜图（scale/overlay/crop）默认单线程跑，多核机器上是纯浪费；slice 线程化
 *   是逐帧分片并行，输出像素不变，纯免费提速。
 */
export async function renderImageFilm({
  shots,
  layoutId,
  pairingId,
  seed = 1,
  style = {},
  outputPath,
  workDir,
  prepared = null,
  filterThreads = 0,
  /**
   * 结尾卡。null = 不出结尾卡。
   * { scene: 'sell'|'local'|'personal', endingId?, brandZh?, brandEn? }
   * 15 款成品资产（3 场景 × 5 款）按 seed 从对应场景里抽一款，引擎不自带任何尾句。
   */
  cta = null,
  audio = null,
  fps = FILM_DEFAULTS.fps,
  crf = FILM_DEFAULTS.crf,
  preset = FILM_DEFAULTS.preset,
  ffmpegPath = ffmpegStatic,
  onProgress = null,
  /** 隐式标识（国标办法第五条）：['Key','Value'] 对数组，写入 mp4 元数据。null = 不写。 */
  metaTags = null,
} = {}) {
  if (!outputPath) throw new Error('renderImageFilm: 缺少 outputPath');
  if (!Array.isArray(shots) || !shots.length) throw new Error('renderImageFilm: shots 不能为空');

  let dir;
  let images;
  let renderPaths;
  let layoutPngs;
  let subtitlePngs;
  let ctaPath;
  let probe;
  let overlays;
  if (prepared) {
    ({
      dir, images, renderPaths, layoutPngs, subtitlePngs, ctaPath, overlays, probe,
    } = prepared);
    if (workDir && workDir !== dir) throw new Error('renderImageFilm: prepared.dir 与 workDir 不一致');
  } else {
    dir = workDir || path.join(path.dirname(outputPath), '.film-work');
    mkdirSync(dir, { recursive: true });

    /* 读图片真实尺寸：洞位选择与 contain 都靠它，不能信上游给的宽高 */
    images = await Promise.all(shots.map(async (s) => {
      if (!existsSync(s.imagePath)) throw new Error(`renderImageFilm: 图片不存在 ${s.imagePath}`);
      const sharp = (await import('sharp')).default;
      const meta = await sharp(s.imagePath).metadata();
      return { path: s.imagePath, width: meta.width, height: meta.height };
    }));
  }

  const plan = planImageFilm({ shots, images, layoutId, pairingId, seed, style, fps, cta });

  /* 守卫：prepared 的产物是在"占位时长"下生成的，但几何/卡片/结尾都不依赖时长
     （随机抽取只吃 seed 与镜数，字幕分组只看字数）。两份 plan 必须一致，
     不一致说明上游在预备后改了文案/图片/seed——与其出错位的片子不如直接报错。 */
  if (prepared) {
    const sig = shotsFingerprint(shots);
    const mismatch = plan.layout.id !== probe.layoutId
      || plan.pairing !== probe.pairing
      || fps !== probe.fps
      || plan.subtitleCards.length !== probe.subtitleCount
      || (plan.ending ? plan.ending.id : null) !== probe.endingId
      || sig !== probe.sig;
    if (mismatch) {
      throw new Error('renderImageFilm: prepared 与 shots 不匹配（预备后文案/图片/seed 被改动），请重新 prepareImageFilm');
    }
  }

  if (onProgress) onProgress({ stage: 'plan', plan });

  if (!prepared) {
    /* —— 预缩放源图 ——
       手机原图动辄 4000×6000，而 ffmpeg 是逐帧缩放的：每 4 秒素材要从 4000px 缩到 960px，
       实测吃掉 17.9 秒。提前用 sharp（libvips）缩到「过扫描之后的目标尺寸」，
       同一条素材降到 2.05 秒——快 8.7 倍，滤镜图一个字都不用改：
       缩到的正是 graph 里最后那次 scale 的大小，那两步 scale 退化成同尺寸 no-op，
       crop 的几何与 overscan 的位移量因此完全不变。 */
    const overscanBase = plan.style.overscan || FILM_DEFAULTS.overscan;
    renderPaths = await Promise.all(images.map(async (img, i) => {
      const isClimax = Boolean(plan.timeline[i]?.climax);
      const overscanUsed = isClimax ? Math.max(overscanBase * 1.035, 1.135) : overscanBase;
      const box = imageBoxFor(plan.slot, img.width, img.height);
      const w = Math.ceil((box.width * overscanUsed) / 2) * 2;
      const h = Math.ceil((box.height * overscanUsed) / 2) * 2;
      if (w >= img.width || h >= img.height) return img.path; /* 原图本来就不大，缩了反而放大 */
      const out = path.join(dir, `src_${i}.jpg`);
      const sharp = (await import('sharp')).default;
      await sharp(img.path).resize(w, h, { fit: 'cover', kernel: sharp.kernel.lanczos3 }).jpeg({ quality: 96 }).toFile(out);
      return out;
    }));
    if (onProgress) onProgress({ stage: 'prescale', count: renderPaths.length });

    /* 每镜一张版面 PNG。文字内容不同，但坐标完全一致——这正是"版面全片固定"的落地方式。 */
    layoutPngs = shots.map((shot, i) => {
      const outPath = path.join(dir, `layout_${i}.png`);
      renderLayoutPng({ layout: plan.layout, slot: plan.slot, pairing: plan.pairingInfo, copy: shot.copy || {}, outPath });
      return outPath;
    });
    if (onProgress) onProgress({ stage: 'layout', count: layoutPngs.length });

    /* 每条字幕一张整幅透明 PNG。数量 = 全片所有分屏之和（不是镜数），通常 6 镜 8–12 张。 */
    subtitlePngs = plan.subtitleCards
      .map((card, k) => renderSubtitlePng({ lines: card.lines, slot: plan.slot, outPath: path.join(dir, `sub_${k}.png`) }))
      .filter(Boolean);
    if (onProgress) onProgress({ stage: 'subtitle', count: subtitlePngs.length });

    if (plan.ending) {
      ctaPath = path.join(dir, 'cta.png');
      renderEndingPng({
        ending: plan.ending,
        /* 竖柱骨架要两侧副字。给了就用，没给落回 V4 原值——不像上一版那样默认塞用户站点名，
           因为 V4 的 15 款是成品资产，副字属于资产的一部分。 */
        brandZh: cta.brandZh,
        brandEn: cta.brandEn,
        outPath: ctaPath,
      });
    }

    overlays = await trimOverlays({ layoutPngs, subtitlePngs, ctaPath });
  }

  /* AI 标识 PNG：文字内容与时长窗都固定，直接内联渲染（各 ~几十 ms，不值得进预备并行）。
     dir 在 prepared 与内联两条路径下都已就绪。
     注意：若已有 ctaPath（结尾收束卡），@jansee/ending-kit 已统一内置国标显性尾标，
     尾标绝不二次烧录！此处只准备 head 即可；仅当无 cta 时才生成并准备 tail。 */
  let badgePaths = null;
  {
    const headPng = renderAiBadgePng(AI_BADGE.headText, path.join(dir, 'ai_badge_head.png'));
    const headOff = await trimAlphaBBox(headPng);
    badgePaths = { head: { path: headPng, x: headOff.x, y: headOff.y } };
    if (!ctaPath) {
      const tailPng = renderAiBadgePng(AI_BADGE.tailText, path.join(dir, 'ai_badge_tail.png'));
      const tailOff = await trimAlphaBBox(tailPng);
      badgePaths.tail = { path: tailPng, x: tailOff.x, y: tailOff.y };
    }
  }

  const { graph, hasAudio } = buildFilmFilterGraph({ plan, images, hasCta: !!ctaPath, audio, overlays, badges: badgePaths });

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (filterThreads > 0) args.push('-filter_complex_threads', String(filterThreads));
  const segDurTotal = plan.timeline.map((s, i) => s.durationSec + (i < plan.timeline.length - 1 ? FILM_DEFAULTS.transitionSec : 0));
  shots.forEach((s, i) => {
    args.push('-loop', '1', '-framerate', String(fps), '-t', String(segDurTotal[i].toFixed(3)), '-i', renderPaths[i]);
  });
  layoutPngs.forEach((p, i) => {
    args.push('-loop', '1', '-framerate', String(fps), '-t', String(plan.timeline[i].durationSec.toFixed(3)), '-i', p);
  });
  /* 字幕输入必须铺满整片：它在 t=0 就开始解码，靠 overlay 的 enable 决定哪一帧被画出来。
     只给该卡片的时长会让它在真正该出现之前就 eof，enable 到了也无帧可画。 */
  subtitlePngs.forEach((p) => {
    args.push('-loop', '1', '-framerate', String(fps), '-t', plan.videoSec.toFixed(3), '-i', p);
  });
  /* CTA 素材要铺满整条尾巴，不能只给 ctaSec：
     它前面还要被 tpad 补 totalSec+holdSec 的透明帧，给的素材太短就会提前 eof，
     而 overlay 的 eof_action=pass 会把最后一帧冻住——片尾多出一段静止定格。 */
  if (ctaPath) args.push('-loop', '1', '-framerate', String(fps), '-t', plan.tailSec.toFixed(3), '-i', ctaPath);
  /* AI 标识：头段必进；尾段仅在无 CTA 收束卡时作为独立输入进入滤镜图，铺满整片靠 enable 时间窗控制显隐 */
  if (badgePaths) {
    if (badgePaths.head) {
      args.push('-loop', '1', '-framerate', String(fps), '-t', plan.videoSec.toFixed(3), '-i', badgePaths.head.path);
    }
    if (badgePaths.tail && !ctaPath) {
      args.push('-loop', '1', '-framerate', String(fps), '-t', plan.videoSec.toFixed(3), '-i', badgePaths.tail.path);
    }
  }
  if (hasAudio) {
    for (const clip of audio.voiceClips) args.push('-i', clip.file || clip);
    if (audio.bgm?.file) args.push('-stream_loop', '-1', '-i', audio.bgm.file);
  }

  args.push('-filter_complex', graph, '-map', '[outv]');
  if (hasAudio) args.push('-map', '[outa]', '-c:a', 'aac', '-b:a', '192k');
  boolPush(args, '-an', !hasAudio);
  args.push(
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-r', String(fps), '-t', String(plan.videoSec.toFixed(3)),
  );
  /* 隐式标识（国标《标识办法》第五条）：use_metadata_tags 让自定义 key 进 mp4 udta，
     字段口径与视频链路（video-dub/speech-cut/storyboard/slicer）完全一致。 */
  if (Array.isArray(metaTags) && metaTags.length) {
    args.push('-movflags', '+faststart+use_metadata_tags');
    for (const [k, v] of metaTags) args.push('-metadata', `${k}=${v}`);
  } else {
    args.push('-movflags', '+faststart');
  }
  args.push(
    path.resolve(outputPath),
  );

  mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  if (onProgress) onProgress({ stage: 'render', graph });
  /* 渲染段真实进度：onProgress({stage:'render', ratio}) 随 ffmpeg 实际编码进度连续上报 */
  await runFfmpeg(ffmpegPath, args, dir, {
    totalSec: plan.videoSec,
    onRatio: (ratio) => { if (onProgress) onProgress({ stage: 'render', ratio }); },
  });

  const bytes = statSync(path.resolve(outputPath)).size;
  return {
    outputPath: path.resolve(outputPath),
    ...plan,
    hasAudio,
    bytes,
    graph,
  };
}

function boolPush(arr, flag, cond) {
  if (cond) arr.push(flag);
}
