// 模拟桌面图标在手机桌面的效果：1080×2400 桌面，图标网格，简兮居首行
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const iconSrc = path.resolve(__dirname, "../app/src/main/res/mipmap-xxxhdpi/ic_launcher.png");
const outPath = path.resolve(__dirname, "../release/launcher-on-desktop.png");

const D = 3, W = 360 * D, H = 800 * D; // 1080 x 2400

// 把方形图标裁成 Android 桌面常见的圆角方形（squircle 近似）
const iconPng = await sharp(iconSrc).resize(168, 168).png().toBuffer();
// 圆角白色矩形作为 alpha 遮罩：dest-in 保留图标在遮罩内的部分
const cornerMask = Buffer.from(
  `<svg width="168" height="168"><rect x="0" y="0" width="168" height="168" rx="42" fill="white"/></svg>`
);
const iconMasked = await sharp(iconPng)
  .composite([{ input: cornerMask, blend: "dest-in" }])
  .png().toBuffer();

// 用 SVG 画整个桌面（壁纸/状态栏/其他 App 图标为示意），再把简兮图标贴图进去
const cellW = 270, cols = 4;
const iconSize = 168;
const row1Y = 300; // 第一行图标顶部
const grid = (col, row, label, color, glyph) => {
  const cx = col * cellW + cellW / 2;
  const cy = row1Y + row * 300;
  return `<g>
    <rect x="${cx - 84}" y="${cy}" width="${iconSize}" height="${iconSize}" rx="42" fill="${color}"/>
    <text x="${cx}" y="${cy + 108}" text-anchor="middle" font-family="Arial,sans-serif" font-size="62" font-weight="bold" fill="#ffffff" opacity="0.92">${glyph}</text>
    <text x="${cx}" y="${cy + iconSize + 40}" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="26" fill="#ffffff">${label}</text>
  </g>`;
};

const desktopSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#4a5b74"/><stop offset="0.5" stop-color="#6b7f9e"/><stop offset="1" stop-color="#9fb0c9"/>
  </linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<!-- 状态栏 -->
<text x="60" y="62" font-family="Arial" font-size="30" fill="#ffffff">9:41</text>
<g fill="#ffffff">
  <rect x="880" y="42" width="34" height="16" rx="3"/>
  <rect x="922" y="38" width="34" height="20" rx="3"/>
  <rect x="964" y="34" width="34" height="24" rx="3"/>
  <circle cx="1030" cy="50" r="9"/>
</g>
<!-- 其它 App 示意（第一行第2格留给简兮） -->
${grid(0, 0, "电话", "#3aa76d", "⌕")}
${grid(2, 0, "相机", "#3c3f45", "◎")}
${grid(3, 0, "信息", "#3d8bfd", "✉")}
${grid(0, 1, "相册", "#e0a24a", "▲")}
${grid(2, 1, "音乐", "#e05263", "♫")}
${grid(3, 1, "设置", "#8a8f98", "⚙")}
<!-- 简兮图标标签（图标本体下面贴图） -->
<text x="${1 * cellW + cellW / 2}" y="${row1Y + iconSize + 40}" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="26" fill="#ffffff" font-weight="bold">简兮</text>
<!-- 底部 Dock -->
<rect x="40" y="${H - 260}" width="${W - 80}" height="200" rx="44" fill="#ffffff" opacity="0.16"/>
<!-- 手势指示条 -->
<rect x="${W / 2 - 90}" y="${H - 26}" width="180" height="8" rx="4" fill="#ffffff" opacity="0.85"/>
</svg>`;

const base = await sharp(Buffer.from(desktopSvg)).png().toBuffer();
const out = await sharp(base)
  .composite([{ input: iconMasked, left: 1 * cellW + cellW / 2 - 84, top: row1Y }])
  .png().toBuffer();
await sharp(out).toFile(outPath);
console.log(`生成 ${outPath}  ${W}x${H}`);
