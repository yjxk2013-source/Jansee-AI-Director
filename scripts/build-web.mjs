/**
 * 简兮 (JANSEE) — 生产构建与静态资源验证脚本
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../');

console.log('[BUILD] 正在校验 Web 前端生产环境资源完整性...');

const clientIndex = path.join(root, 'apps/web/client/index.html');
if (!fs.existsSync(clientIndex)) {
  console.error('[BUILD FAIL] 缺失 apps/web/client/index.html 生产主页面');
  process.exit(1);
}

const assetsDir = path.join(root, 'apps/web/client/assets');
if (!fs.existsSync(assetsDir)) {
  console.error('[BUILD FAIL] 缺失 apps/web/client/assets 静态资产目录');
  process.exit(1);
}

const requiredAssets = [
  // 当前生产首页实际使用的品牌图标、样片、海报、下载入口与二维码库。
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
    console.error(`[BUILD FAIL] 缺失关键资产: ${a}`);
    missing++;
  }
}

if (missing === 0) {
  console.log('[BUILD SUCCESS] 前端生产资源校验 100% 完整，具备独立上线条件！');
  process.exit(0);
} else {
  process.exit(1);
}
