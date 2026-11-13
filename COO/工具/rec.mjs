// 简兮 JANSEE 轻量录屏器
// 用法：双击"录屏.bat"（或命令行 node rec.mjs）→ 回车开始 → 3 秒倒计时后开录 → 录完回车停止
// 依赖：项目自带 node_modules/ffmpeg-static，无需安装任何东西
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// 本文件位于 COO/工具/，往上一级是 COO/，再上一级是项目根
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FFMPEG = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const OUT_DIR = path.resolve(HERE, '../素材/录屏');

const rl = createInterface({ input: process.stdin, output: process.stdout });
const waitEnter = () => new Promise((r) => rl.question('', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 本地时间戳，格式 20261101-152430
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

if (!fs.existsSync(FFMPEG)) {
  console.error(`[错误] 找不到 ffmpeg：${FFMPEG}`);
  console.error('请在简兮项目根目录下运行本工具。');
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log('=== 简兮 JANSEE 轻量录屏器 ===');
console.log(`保存目录：${OUT_DIR}`);
console.log('提示：开录前先清干净桌面和无关标签页，鼠标动作放慢。');
console.log('');
console.log('回车开始（随后 3 秒倒计时，切到你要录的页面）…');
await waitEnter();

for (let i = 3; i >= 1; i--) {
  console.log(`${i}…`);
  await sleep(1000);
}

const out = path.join(OUT_DIR, `录屏-${stamp()}.mp4`);
const ff = spawn(
  FFMPEG,
  [
    '-f', 'gdigrab', '-framerate', '30', '-i', 'desktop',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-y', out,
  ],
  { stdio: ['pipe', 'ignore', 'pipe'] }
);

ff.on('error', (e) => {
  console.error(`\n[错误] ffmpeg 启动失败：${e.message}`);
  process.exit(1);
});

// 实时刷新录制时长（取 ffmpeg 进度行里的 time= 字段）
ff.stderr.on('data', (d) => {
  const m = String(d).match(/time=(\d+:\d+:\d+\.\d+)/);
  if (m) process.stdout.write(`\r录制中… 已录 ${m[1]}`);
});

console.log('开始录制。录完回到本窗口，回车停止。');
await waitEnter();
ff.stdin.write('q\n');
ff.stdin.end();

await new Promise((r) => ff.on('close', r));
rl.close();
console.log(`\n已保存：${out}`);
console.log('粗剪提醒：只留"传图 → 打字 → 出片"三段精华，等待过程全剪掉。');
