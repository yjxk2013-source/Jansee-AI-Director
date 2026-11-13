/**
 * @jansee/intro-kit —— 开场微光 PNG 渲染器（Node 侧极速渲染）
 *
 * 采用 Rust 编写的 @resvg/resvg-js，单张毫秒级产出（~15ms），内存占用仅 ~2MB。
 * 字体使用 materials/fonts 中的思源黑体与 Jost。
 */
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { INTRO_FONTS, buildIntroSvg } from './intro.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
export const FONTS_ROOT = path.join(REPO_ROOT, 'materials/fonts');

/**
 * 渲染开场花字透明 PNG
 * @param {object} p
 * @param {string} [p.title] 主标题
 * @param {string} [p.brandEn] 装饰英文
 * @param {number} [p.width=1080] 视频物理宽
 * @param {number} [p.height=1920] 视频物理高
 * @param {string} p.outPath 输出文件路径
 * @returns {string} outPath
 */
export function renderIntroPng({ title, brandEn, site, note, idx, width = 1080, height = 1920, outPath }) {
  const W = Math.max(320, Math.round(Number(width) || 1080));
  const H = Math.max(240, Math.round(Number(height) || 1920));

  const svg = buildIntroSvg({ title, brandEn, site, note, idx, width: W, height: H });

  const zhPath = path.join(FONTS_ROOT, 'noto-sans-sc', INTRO_FONTS.zhFile);
  const enPath = path.join(FONTS_ROOT, 'jost', INTRO_FONTS.enFile);

  const png = new Resvg(svg, {
    font: {
      fontFiles: [zhPath, enPath],
      loadSystemFonts: false,
      defaultFontFamily: INTRO_FONTS.zh,
    },
    fitTo: { mode: 'width', value: W },
  })
    .render()
    .asPng();

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, png);
  return outPath;
}
