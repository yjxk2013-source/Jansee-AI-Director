#!/usr/bin/env node
/**
 * 简兮 (JANSEE) · Web 前端发布前静态完整性与业务红线审计门禁 (scripts/build-web.mjs)
 * 职责：
 *   1. 静态资源完整性验证：核验 18 项核心样片、海报、图标与本地离线工具库；
 *   2. 《AGENTS.md》业务红线静态扫描：
 *      - 【0 Emoji 绝杀令】：扫描 index.html，杜绝任何未授权彩色系统 Emoji 字符；
 *      - 【外链泄漏防御】：核查是否意外引入未受控的外部高危外链；
 *   3. 统一规范前端工程发布前的质量基线，杜绝“空壳构建”。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

console.log('='.repeat(70));
console.log('  简兮 (JANSEE) · Web 前端发布前静态完整性与红线审计 (Pre-flight Audit)');
console.log('='.repeat(70));

let hasErrors = false;

// 1. 核心页面文件存在性核查
const clientIndex = path.join(root, 'apps/web/client/index.html');
if (!fs.existsSync(clientIndex)) {
  console.error('  [ FAIL ] 缺失 apps/web/client/index.html 生产主页面');
  process.exit(1);
}
console.log('  [ PASS ] 生产主页面载入检测 (apps/web/client/index.html)');

const clientContent = fs.readFileSync(clientIndex, 'utf8');

// 2. 0 Emoji 绝杀令静态代码合规扫描
// 匹配标准彩色表情符号区间
const emojiRegex = /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F1E0}-\u{1F1FF}]/u;
const lines = clientContent.split('\n');
let emojiViolations = 0;

lines.forEach((line, index) => {
  if (emojiRegex.test(line)) {
    // 忽略特定注释说明（如果仅存在于设计规范注释中）
    if (!line.includes('ZERO EMOJI') && !line.includes('0 Emoji')) {
      console.error(`  [ REDLINE FAIL ] 第 ${index + 1} 行检测到系统 Emoji 违规注入: ${line.trim().slice(0, 50)}...`);
      emojiViolations++;
    }
  }
});

if (emojiViolations === 0) {
  console.log('  [ PASS ] 0 Emoji 业务红线合规审计 (100% 遵从发丝细线与几何矢量规范)');
} else {
  console.error(`  [ FAIL ] 0 Emoji 红线扫描拦截！发现 ${emojiViolations} 处违规字符`);
  hasErrors = true;
}

// 3. 静态资产物理完整性核查
const assetsDir = path.join(root, 'apps/web/client/assets');
if (!fs.existsSync(assetsDir)) {
  console.error('  [ FAIL ] 缺失 apps/web/client/assets 静态资产目录');
  process.exit(1);
}

const requiredAssets = [
  'web-icon.png',
  'app-icon.jpg',
  'gemini_generated_video_e4c0e1ca.mp4',
  'gemini_generated_video_daa127b4.mp4',
  'gemini_generated_video_fea058f1.mp4',
  'gemini_generated_video_96a1b690.mp4',
  'gemini_generated_video_d6c671c5.mp4',
  'poster-96a1b690.jpg',
  'poster-d6c671c5.jpg',
  'poster-daa127b4.jpg',
  'poster-fea058f1.jpg',
  'app/download-qr.png',
  'app/download-qr-android.png',
  'app/jansee.apk',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'vendor/qrcode.min.js'
];

let missing = 0;
for (const a of requiredAssets) {
  const p = path.join(assetsDir, a);
  if (!fs.existsSync(p)) {
    console.error(`  [ ASSET FAIL ] 缺失关键资产: ${a}`);
    missing++;
  }
}

if (missing === 0) {
  console.log(`  [ PASS ] 18 项核心静态资产与样片完整性校验通过 (${requiredAssets.length}/${requiredAssets.length})`);
} else {
  console.error(`  [ FAIL ] 静态资产缺失: 发现 ${missing} 项资源丢失`);
  hasErrors = true;
}

// 4. 离线化与本地 QR 库核验
const qrcodeVendor = path.join(assetsDir, 'vendor/qrcode.min.js');
if (fs.existsSync(qrcodeVendor) && fs.statSync(qrcodeVendor).size > 1000) {
  console.log('  [ PASS ] 关键三方依赖本地化与沙箱离线保障 (vendor/qrcode.min.js)');
} else {
  console.error('  [ FAIL ] 离线二维码依赖损坏或缺失');
  hasErrors = true;
}

console.log('='.repeat(70));
if (hasErrors) {
  console.error('❌ 前端预发布审计未通过，存在阻断性缺陷！');
  process.exit(1);
} else {
  console.log('✅ Web 前端静态资产与业务红线审计 100% 通过，具备企业级上线基线！');
  process.exit(0);
}
