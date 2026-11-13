// 自动化脚本：BGM 曲库账本重建，自动化重写 index.json
// 2026-10-12 Mixkit 扩容定版：12 个白名单情绪目录（目标各 20 首）+ generic 兜底池 + outro_sfx 结尾音效池；
// intro_sfx 已整体迁移移除；运行时选曲由 packages/audio-kit/bgm.js（@jansee/audio-kit）按情绪目录直接扫描，本账本仅作参考与盘点。
import fs from 'node:fs';
import path from 'node:path';

const audioRoot = path.resolve('materials/audio');

// 发现全部音频目录（情绪目录 + outro_sfx 结尾音效池一并纳入账本盘点）
const emotionDirs = fs
  .readdirSync(audioRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const tracks = {};
let totalMp3 = 0;

for (const dirName of emotionDirs) {
  const dirPath = path.join(audioRoot, dirName);
  const files = fs
    .readdirSync(dirPath)
    .filter((f) => /\.(mp3|m4a|wav|flac)$/i.test(f))
    .sort();

  tracks[dirName] = files.map((f) => `${dirName}/${f}`);
  totalMp3 += files.length;
}

const indexData = {
  version: 'llm-director-v3',
  note: '2026-10-12 Mixkit 扩容定版：12 个白名单情绪目录（目标各 20 首，新增 romantic/nostalgic/epic/playful）+ generic 兜底池 + outro_sfx 结尾音效池（用户手工裁剪后现状）；intro_sfx 已整体迁移移除。运行时选曲由 packages/audio-kit/bgm.js（@jansee/audio-kit）按情绪目录直接扫描，本账本仅作参考与盘点',
  tracks: tracks,
};

const indexPath = path.join(audioRoot, 'index.json');
fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2), 'utf8');

console.log('index.json 重写完成！');
console.log('目录清单及文件数:');
for (const [k, v] of Object.entries(tracks)) {
  console.log(`  - ${k}: ${v.length} 首`);
}
console.log(`情绪目录总数: ${emotionDirs.length}，音频文件总数: ${totalMp3}`);
