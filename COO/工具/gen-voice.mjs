// 台词配音生成器（腾讯云版）：读 脚本.json，逐段调项目自有 tts-kit 中台合成
// 用法：node --env-file=F:/janseeV2/.env gen-voice.mjs [脚本路径] [音色mood]
// 只消费 @jansee/tts-kit 导出 API，不改中台任何代码。
// 音色 mood 可选：m-calm 磁性男声 / m-warm 磁性暖男 / f-soft 知性女声 / f-warm 温柔女声
import { synthViaNode } from '../../packages/tts-kit/index.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = process.argv[2] || path.join(HERE, '../素材/台词/脚本.json');
const mood = process.argv[3] || 'm-calm';
const cfg = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const outDir = path.join(path.dirname(scriptPath), 'voices');
fs.mkdirSync(outDir, { recursive: true });

let ok = 0;
for (const seg of cfg.segments) {
  const out = path.join(outDir, `${seg.id}.mp3`);
  const speed = Number(seg.speed) > 0 ? Number(seg.speed) : 1;
  const done = await synthViaNode(seg.text, mood, '', out, speed);
  if (done) {
    ok++;
    console.log(`已生成 ${seg.id}（${seg.start}s-${seg.end}s）：${seg.text.slice(0, 18)}…`);
  } else {
    console.error(`[失败] ${seg.id}`);
  }
}
console.log(`完成 ${ok}/${cfg.segments.length} →`, outDir);
if (ok < cfg.segments.length) process.exit(1);
