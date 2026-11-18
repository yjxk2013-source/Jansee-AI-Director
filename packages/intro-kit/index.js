/**
 * @jansee/intro-kit —— 简兮开场微光中台（对外统一出口）
 *
 * 供视频配音（video-dub）、出镜口播（speech-cut）、切片分镜（slicer/storyboard）
 * 跨视频业务线共用同一份开场花字包装与黑曜石羽化暗晕。
 */

export { INTRO_FONTS, INTRO_TIMING, buildIntroSvg } from './intro.js';
export { FONTS_ROOT, renderIntroPng } from './render.js';
export { composePureCover } from './cover.js';

import { INTRO_TIMING } from './intro.js';

/**
 * 构建开场图层在 FFmpeg 中的标准淡入淡出与叠加滤镜
 * 时间结构：startSec 开始淡入 (fadeInSec) → 保持 → fadeOutSec 淡出至透明
 * @param {object} p
 * @param {string} [p.inputIndex='2'] 开场 PNG 在 ffmpeg 中的输入流索引（如 '2' 即 [2:v]）
 * @param {string} [p.baseLabel='vbody'] 底层视频标签
 * @param {string} [p.outLabel='vwithintro'] 输出视频标签
 * @returns {Array<string>} 滤镜图片段
 */
export function buildIntroOverlayFilter({ inputIndex = '2', baseLabel = 'vbody', outLabel = 'vwithintro' } = {}) {
  const { startSec, fadeInSec, durationSec, fadeOutSec } = INTRO_TIMING;
  const fadeOutStart = Math.max(0, startSec + durationSec - fadeOutSec);
  const fadeOutEnd = startSec + durationSec;

  // 1. [inputIndex:v] 施加淡入淡出透明度滤镜
  // 2. overlay 到 baseLabel 上，通过 enable 窗口仅在前 fadeOutEnd 秒执行叠加，此后无损放行
  const introLabel = `introFaded${inputIndex}`;
  return [
    `[${inputIndex}:v]format=rgba,` +
      `fade=t=in:st=${startSec.toFixed(2)}:d=${fadeInSec.toFixed(2)}:alpha=1,` +
      `fade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeOutSec.toFixed(2)}:alpha=1[${introLabel}]`,
    `[${baseLabel}][${introLabel}]overlay=0:0:eof_action=pass:format=auto:` +
      `enable='between(t,0,${(fadeOutEnd + 0.1).toFixed(2)})'[${outLabel}]`,
  ];
}
