/**
 * 字幕计划器（全平台唯一实现）
 *
 * 为什么它在共享层：每一部成片都要字幕。断句口径、行尾标点规则、分屏节奏、时间轴切分
 * 一旦各引擎各写一套，同一个用户的话术在口播链路和图片成片里会排出两种断法——
 * 这不是"风格差异"，是 bug。
 *
 * 为什么它只做文本、不做渲染：渲染器物理上不同。
 *   · 口播/切片/配音/分镜/语音视频 —— `buildDrawtextFilters`，ffmpeg 用 freetype 逐帧画字，
 *     天然按视频分辨率缩放，样式靠描边/阴影，五套动效是 drawtext 标量表达式。
 *   · 图片成片（V4）—— resvg 渲 SVG 再 alpha overlay，画布固定 1080×1920，
 *     需要圆角胶囊底衬和与版面一致的字形度量。
 * 两套字形引擎不能混用（fontkit vs freetype，字距与字重对不上），所以本文件
 * 只生产「第几秒到第几秒，画哪几行字」，怎么画由调用方的渲染器决定。
 *
 * 依赖：`wrapCJK` 是断句的唯一真源，本文件只在它之上补「分屏 + 时间轴 + 像素宽」。
 */
import { wrapCJK } from './subtitle.js';

/* 行末要剥掉的停顿符。wrapCJK 已剥过一次（`，。？！；`），这里补它没管的 `：、,.;:`。
   语气符（？！）也剥——这是共享包的既有口径，五条链路一致；字幕不是文章，
   标点在画面上只占宽不传递信息（听的人本来就有语气）。 */
const TRIM_TAIL = /[，。；：、,.;:]+$/;
const ONLY_PUNCT = /^[，。；：、？！,.;:?!…]+$/;

export const SUBTITLE_PLAN_DEFAULTS = Object.freeze({
  size: 44,
  /**
   * 一行最多几个字。**19 不是随手定的**：共享包的 wrapCJK 在单段超限时会「平分折行」，
   * 一个 19 字的完整短句在 18 上限下会被劈成 10+9 两行（断在词中间，还白占一屏）。
   * 设 19 让"最长的一句话短句"正好整行放下，像素侧由 maxLineWidth 兜底。
   */
  maxCharsPerLine: 19,
  maxLineWidth: 856,
  maxLines: 2,
});

/**
 * 单字宽度估算（px）。
 * 中文全角 = 1 em；英文按字面比例压窄。共享包按**字数**断行，这是准的；
 * 但底衬定位、以及中英混排的溢出复核需要真实像素，那一步只能在这里做。
 */
export function charWidth(ch, size = SUBTITLE_PLAN_DEFAULTS.size) {
  const cp = ch.codePointAt(0);
  if (cp >= 0x2e80) return size;                      /* CJK 汉字与全角标点 */
  if (ch === ' ') return size * 0.28;
  if (/[A-Z]/.test(ch)) return size * 0.66;
  if (/[a-z]/.test(ch)) return size * 0.52;
  if (/[0-9]/.test(ch)) return size * 0.56;
  return size * 0.5;
}

export function measureText(str, size = SUBTITLE_PLAN_DEFAULTS.size) {
  return [...String(str || '')].reduce((n, ch) => n + charWidth(ch, size), 0);
}

/**
 * 像素兜底：wrapCJK 只保证"字数"不超，中英混排仍可能超宽
 * （"Espresso 40ml" 只算 13 字，实际占 700px+）。
 * 已经放得下就原样返回，不重排——重排会破坏共享包按标点断好的语义边界。
 */
function fitWidth(row, size, maxW) {
  if (measureText(row, size) <= maxW) return [row];
  const rows = [];
  let line = '';
  let w = 0;
  for (const ch of [...row]) {
    const cw = charWidth(ch, size);
    /* 标点永不触发换行。行尾标点本来就要剥掉，为它单独开一行等于白扔半屏——
       实测过「…器具，」刚好超 24px，结果逗号独占一屏。 */
    if (!ONLY_PUNCT.test(ch) && line && w + cw > maxW) {
      rows.push(line);
      line = '';
      w = 0;
    }
    line += ch;
    w += cw;
  }
  if (line) rows.push(line);
  return rows;
}

/**
 * 一句台词 → 若干屏（每屏 ≤ maxLines 行）。
 * 返回 [{ text, lines }]：text 保留原文标点，只用于按字数切分时长；
 * lines 是真正画到画面上的行（行尾停顿符已剥）。
 */
export function splitSubtitleCards(text, opts = {}) {
  const { size, maxCharsPerLine, maxLineWidth, maxLines } = { ...SUBTITLE_PLAN_DEFAULTS, ...opts };
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];

  const rows = wrapCJK(trimmed, maxCharsPerLine)
    .flatMap((row) => fitWidth(row, size, maxLineWidth));

  const cards = [];
  for (let i = 0; i < rows.length; i += maxLines) {
    const rawLines = rows.slice(i, i + maxLines);
    const lines = rawLines.map((r) => r.replace(TRIM_TAIL, '').trim()).filter(Boolean);
    if (!lines.length) continue;
    cards.push({ text: rawLines.join(' ').trim(), lines });
  }
  return cards;
}

/**
 * 把若干屏铺进一个可见时间窗，按字数比例分配时长。
 * TTS 只给整句时长，没有逐字时间戳——按字数比例是这套链路的精度上限，够用
 * （人念一句话语速基本均匀）。末屏吃掉剩余时间，避免浮点误差留 20ms 空档。
 */
export function layoutSubtitleTiming(cards, startSec, endSec) {
  const total = Math.max(0, endSec - startSec);
  if (!cards.length || total <= 0) return [];
  const weights = cards.map((c) => Math.max(1, [...c.text].length));
  const sum = weights.reduce((a, b) => a + b, 0);
  let acc = startSec;
  return cards.map((card, i) => {
    const start = acc;
    const end = i === cards.length - 1 ? endSec : acc + (total * weights[i]) / sum;
    acc = end;
    return { ...card, startSec: start, endSec: end };
  });
}

/** 二合一：一句话 + 时间窗 → 带时间的分屏计划。各引擎的常规入口。 */
export function planSubtitles({ text, startSec, endSec, ...opts }) {
  return layoutSubtitleTiming(splitSubtitleCards(text, opts), startSec, endSec);
}
