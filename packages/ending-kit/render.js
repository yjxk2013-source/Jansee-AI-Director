/**
 * 结尾收束 · PNG 渲染 + 片尾时间口径（与图片成片引擎、视频配音共用）
 *
 * renderEndingPng 原在 modules/visual_engine_v4/imageFilm.js（2026-10-24 随
 * ending 提升一并搬出）：结尾卡是全平台唯一「纯字卡」，两条链路（图片成片 /
 * 视频配音）必须烧出同一张脸，渲染逻辑只许有一份。
 *
 * 结尾卡固定 Noto Sans SC + Jost，不跟随正文配对——结尾是全片唯一纯字卡，
 * 跟随配对会每单变风格，而它跟商品图的调性本来就无关。
 */
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { ENDING_FONTS, buildEndingSvg } from './ending.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
export const FONTS_ROOT = path.join(REPO_ROOT, 'materials/fonts');

/**
 * 片尾收束的时间结构（两条链路同一口径，原引擎 FILM_DEFAULTS 的
 * endHoldSec / ctaSec 与此处的 fadeInSec）：
 *   正文结束 →（各链路自己的淡黑，吃正文尾巴）→ 黑屏停顿 endHoldSec
 *   → CTA 卡淡入 fadeInSec + 持续，总长 ctaSec。
 * 1.8s 太短——CTA 淡入就吃掉 0.85s，全亮只剩 0.7s，观众还没看清就黑了；
 * 2.6s 才够读一行标题加一行英文。少了黑停那一拍，观感是"刚黑就冒字"，
 * 观众的眼睛还没从画面切到黑场，"淡黑到黑屏，然后结尾出现"的"然后"等于不存在。
 */
export const ENDING_TAIL = Object.freeze({
  fadeInSec: 0.85,
  endHoldSec: 0.35,
  ctaSec: 2.6,
});

/**
 * 把一款结尾卡渲染成整幅 PNG（1080×1920，透明底由 SVG 内的半黑 backdrop 负责）。
 * @param {object} p
 * @param {object} p.ending ENDING_ASSETS 里的一款（pickEnding 产出）
 * @param {string} [p.brandZh] 竖柱骨架左侧副字（缺省「原 创 呈 现」）
 * @param {string} [p.brandEn] 竖柱骨架右侧副字（缺省「JANSEE AI STUDIO」）
 * @param {string} p.outPath 输出 PNG 绝对路径
 * @returns {string} outPath
 */
export function renderEndingPng({ ending, brandZh, brandEn, withAiBadge = true, outPath }) {
  const svg = buildEndingSvg(ending, { brandZh, brandEn, withAiBadge });
  const png = new Resvg(svg, {
    font: {
      fontFiles: [
        path.join(FONTS_ROOT, 'noto-sans-sc', ENDING_FONTS.zhFile),
        path.join(FONTS_ROOT, 'jost', ENDING_FONTS.enFile),
      ],
      loadSystemFonts: false,
      defaultFontFamily: ENDING_FONTS.zh,
    },
    fitTo: { mode: 'width', value: 1080 },
  })
    .render()
    .asPng();
  mkdirSync(path.dirname(outPath), { recursive: true });
  /* PNG 只有几十到几百 KB，同步直写即可——为它把整条渲染链改成 async 不值得 */
  writeFileSync(outPath, png);
  return outPath;
}
