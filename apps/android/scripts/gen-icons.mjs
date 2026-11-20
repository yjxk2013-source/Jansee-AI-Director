// 生成 JANSEE Android 图标资源 —— 以项目 SVG 矢量源为准（唯一事实来源）
// 桌面图标：jansee-mark.svg（纯六芒星，无文字）
// 启动页 logo（透明底）：竖排 = 六芒星（mark.svg）+ JANSEE 字标（wordmark 字母 path）
//   —— 供 SplashActivity 布局用；slogan 由布局 TextView 渲染，不用图片
// 启动页背景（白底）：冷启动 windowBackground，logo 居中，避免系统启动窗口白屏
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const res = path.resolve(__dirname, "../app/src/main/res");
const src = path.resolve(__dirname, "../../web/public/assets");

const MARK = path.join(src, "jansee-mark.svg");
const WORDMARK = path.join(src, "jansee-wordmark.svg");
const SLOGAN = "行至简处 见光影 见山海 见简兮"; // 首页 welcome-copy，去掉标点

function pathD(svgText, index) {
  return [...svgText.matchAll(/<path[^>]*\bd="([^"]+)"/g)].map((m) => m[1])[index];
}
function bounds(d) {
  const nums = [...d.matchAll(/-?\d+\.?\d*/g)].map(Number);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    minX = Math.min(minX, nums[i]); maxX = Math.max(maxX, nums[i]);
    minY = Math.min(minY, nums[i + 1]); maxY = Math.max(maxY, nums[i + 1]);
  }
  return { minX, maxX, minY, maxY };
}

const markD = pathD(fs.readFileSync(MARK, "utf8"), 0);
const letterD = pathD(fs.readFileSync(WORDMARK, "utf8"), 1); // JANSEE 专用字标
const mb = bounds(markD);
const lb = bounds(letterD);

// ---- 桌面图标：实心深色六芒星，白底，四周留白（克制）----
// 六芒星图形占画布 61.8%（黄金比例），四周留白约 19%/边
function launcherSvg(size) {
  const target = size * 0.618;
  const scale = target / (mb.maxX - mb.minX);
  const tx = size / 2 - ((mb.minX + mb.maxX) / 2) * scale;
  const ty = size / 2 - ((mb.minY + mb.maxY) / 2) * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" fill="#ffffff"/>
<g transform="translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${scale.toFixed(4)})"><path d="${markD}" fill="#151a22" fill-rule="evenodd"/></g>
</svg>`;
}
const densities = [
  ["mdpi", 48], ["hdpi", 72], ["xhdpi", 96], ["xxhdpi", 144], ["xxxhdpi", 192],
];
for (const [density, size] of densities) {
  const buf = await sharp(Buffer.from(launcherSvg(size))).png().toBuffer();
  fs.writeFileSync(path.join(res, `mipmap-${density}`, "ic_launcher.png"), buf);
  fs.writeFileSync(path.join(res, `mipmap-${density}`, "ic_launcher_round.png"), buf);
}
console.log("launcher icons done");

// ---- 启动页 logo（透明底）：竖排六芒星 + JANSEE 字标 ----
// 基准画布 400×460：六芒星宽 240 居中于上，字标宽 280 居中于下，垂直居中留白
function logoSvg(w, h) {
  const mScale = 240 / (mb.maxX - mb.minX);
  const mTx = 200 - ((mb.minX + mb.maxX) / 2) * mScale;
  const mTy = 77 - mb.minY * mScale;
  const lScale = 280 / (lb.maxX - lb.minX);
  const lTx = 200 - ((lb.minX + lb.maxX) / 2) * lScale;
  const lTy = 347 - lb.minY * lScale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 400 460">
<g transform="translate(${mTx.toFixed(2)},${mTy.toFixed(2)}) scale(${mScale.toFixed(4)})"><path d="${markD}" fill="#151a22" fill-rule="evenodd"/></g>
<g transform="translate(${lTx.toFixed(2)},${lTy.toFixed(2)}) scale(${lScale.toFixed(4)})"><path d="${letterD}" fill="#151a22" fill-rule="evenodd"/></g>
</svg>`;
}
const logoSizes = [
  ["mdpi", 100, 115], ["hdpi", 150, 173], ["xhdpi", 200, 230],
  ["xxhdpi", 300, 345], ["xxxhdpi", 400, 460],
];
for (const [density, w, h] of logoSizes) {
  const buf = await sharp(Buffer.from(logoSvg(w, h))).png().toBuffer();
  fs.writeFileSync(path.join(res, `drawable-${density}`, "splash_logo.png"), buf);
}
console.log("splash logo done");

// ---- 启动页背景（白底 + 居中 logo）：冷启动 windowBackground ----
// 用正方形画布，logo 在其中居中；layer-list 里 gravity=center 显示
for (const [density, size] of [["mdpi",200],["hdpi",300],["xhdpi",400],["xxhdpi",600],["xxxhdpi",800]]) {
  const lw = Math.round(size * 0.72), lh = Math.round(lw * 460 / 400);
  const logo = await sharp(Buffer.from(logoSvg(400, 460))).resize(lw, lh).png().toBuffer();
  const out = await sharp({ create: { width: size, height: size, channels: 4, background: "#ffffff" } })
    .composite([{ input: logo, left: Math.round((size - lw) / 2), top: Math.round((size - lh) / 2) }])
    .png().toBuffer();
  fs.writeFileSync(path.join(res, `drawable-${density}`, "splash_brand.png"), out);
}
console.log("splash background done");

// ---- 真机模拟预览：1080×2400 白屏，logo 居中、slogan 底部 ----
// 布局参数：logo 宽 140dp，slogan 14sp 浅灰、距底 72dp；density=3
{
  const D = 3, W = 360 * D, H = 800 * D;
  const logoW = 140 * D, logoH = Math.round(logoW * 460 / 400);
  const logo = await sharp(Buffer.from(logoSvg(400, 460))).resize(logoW, logoH).png().toBuffer();
  const lLeft = Math.round((W - logoW) / 2), lTop = Math.round((H - logoH) / 2);
  const slogSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<text x="${W / 2}" y="${H - 72 * D}" text-anchor="middle" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="${14 * D}" letter-spacing="${(0.08 * 14 * D).toFixed(1)}" fill="#9AA0A6">${SLOGAN}</text>
</svg>`;
  const out = await sharp({ create: { width: W, height: H, channels: 4, background: "#ffffff" } })
    .composite([
      { input: logo, left: lLeft, top: lTop },
      { input: Buffer.from(slogSvg), left: 0, top: 0 },
    ]).png().toBuffer();
  fs.writeFileSync(path.resolve(__dirname, "../release/splash-on-phone-v2.png"), out);
}
console.log("phone preview done（源：项目 SVG + 首页文案）");

// ---- PWA / 网页安装图标：与桌面图标同源同规范（六芒星 61.8% + 白底）----
// manifest.webmanifest 与 index.html(apple-touch-icon) 引用，取消旧产物依赖。
const pwaDir = path.resolve(__dirname, "../../web/public/assets/app-icon");
fs.mkdirSync(pwaDir, { recursive: true });
for (const size of [180, 192, 512]) {
  const buf = await sharp(Buffer.from(launcherSvg(size))).png().toBuffer();
  fs.writeFileSync(path.join(pwaDir, `jansee-pwa-${size}.png`), buf);
}
console.log("PWA icons done（180/192/512，六芒星 61.8%）");
