/**
 * 图片成片 · 口播字幕的**渲染**层
 *
 * 分工（重要，别往这里加断句代码）：
 *   断句 / 分屏 / 时间轴 / 行宽换算 → `@jansee/subtitle-kit/plan.js`，全平台唯一一份。
 *   渲染 → 本文件。只有它知道 V4 的画布是 1080×1920、字幕要压在洞位内、底衬是圆角胶囊。
 *
 * 为什么不能直接用共享包的 `buildDrawtextFilters`：
 *   V4 的版面文字走 resvg → SVG → PNG → alpha overlay，字形由 fontkit 度量。
 *   一旦混进 drawtext，同一画面里就有两套字形引擎（freetype vs fontkit），
 *   字距和字重对不上，肉眼能看出"字幕和标题不是同一套字"。
 *   而且 drawtext 的 box 只能画直角、只能贴着文字，做不出带内边距的圆角胶囊底衬。
 *
 * 三条固定口径（不跟版式/配对轮换）：
 *   1. 字体固定思源黑 Regular。书法体/圆胖体做 40 字连读会累，跟结尾卡同一条理由。
 *   2. 位置固定压在图片洞位内的下方。底部黑边只有 240px（A 档洞位），
 *      已经被版面的说明行/站名/编号占满，再塞一行字幕必然打架。
 *   3. 零动效。字幕逐条硬切，跟抖音/视频号的专业字幕一致；加淡入淡出反而干扰阅读。
 */
import { CANVAS } from './layouts.js';
import { measureText } from '@jansee/subtitle-kit/plan.js';

export const SUBTITLE_FONT = Object.freeze({
  zh: 'Noto Sans SC',
  file: 'NotoSansSC_400Regular.ttf',
});

/**
 * 渲染参数。断句参数（maxCharsPerLine / maxLineWidth / maxLines）在 `SUBTITLE_PLAN`
 * 里，别混进来——那三个是文本层的，改它们要动共享层。
 */
export const SUBTITLE_STYLE = Object.freeze({
  size: 44,
  /** 行高倍数。1.42 是中文两行字幕不粘连的下限，再小两行会读成一个字块。 */
  lineHeight: 1.42,
  /** 底衬到洞位底边的距离。120px ≈ 画布高度的 6%，避开抖音底部文案区。 */
  bottomInset: 120,
  padX: 26,
  padY: 18,
  radius: 10,
  fill: '#F8FAFC',
  bg: '#0A0A0E',
  /** 0.55 通透度：与全站黑曜石胶囊同一档，浅色商品上也读得清，又不至于糊成一坨黑块。 */
  bgOpacity: 0.55,
});

/** 文本层参数：透给 `plan.js`。19 字 × 44px = 836px，是手机竖屏一眼扫完的上限。 */
export const SUBTITLE_PLAN = Object.freeze({
  size: SUBTITLE_STYLE.size,
  maxCharsPerLine: 19,
  maxLineWidth: 856,
  maxLines: 2,
});

/**
 * 一条字幕的 SVG（整幅 1080×1920 透明画布，直接 overlay=0:0）。
 * 底衬宽度取最长行，居中；底边锚定洞位底边内侧，A/B/C 三档洞位自动跟着走。
 */
export function buildSubtitleCardSvg({ lines, slot }, style = SUBTITLE_STYLE) {
  if (!lines || !lines.length) return null;
  const { size, lineHeight, padX, padY, radius, fill, bg, bgOpacity } = style;
  const lineH = size * lineHeight;
  const textW = Math.max(...lines.map((l) => measureText(l, size)));
  const boxW = textW + padX * 2;
  const boxH = lines.length * lineH + padY * 2;
  const boxX = (CANVAS.width - boxW) / 2;
  /* 锚定洞位底边：横图洞（C 档）洞底在画布中部，字幕跟着上移，不会飘到黑边里。 */
  const boxBottom = slot.bar + slot.h - style.bottomInset;
  const boxY = boxBottom - boxH;

  /* 基线 = 行顶 + (行高 + 墨迹高) / 2。思源黑墨迹占 em 的 0.80，按墨迹居中比按 em 居中稳。 */
  const ink = 0.8;
  const texts = lines.map((line, i) => {
    const baseline = boxY + padY + lineH * i + (lineH + ink * size) / 2;
    const esc = String(line)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<text x="${(CANVAS.width / 2).toFixed(1)}" y="${baseline.toFixed(1)}" text-anchor="middle" ` +
      `fill="${fill}" font-family="${SUBTITLE_FONT.zh}" font-weight="400" font-size="${size.toFixed(1)}">${esc}</text>`;
  }).join('');

  const body =
    `<rect x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH.toFixed(1)}" ` +
    `rx="${radius}" ry="${radius}" fill="${bg}" fill-opacity="${bgOpacity}"/>${texts}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}" ` +
    `viewBox="0 0 ${CANVAS.width} ${CANVAS.height}">${body}</svg>`;
}
