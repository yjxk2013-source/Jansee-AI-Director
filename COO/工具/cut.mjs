// 简兮 JANSEE 轻量切片器
// 两种用法：
// 1) 双击"切片.bat" → 拖入视频 → 填起点/终点 → 连续切多段（推荐）
// 2) 命令行：node cut.mjs 视频文件 起点 终点
//    时间写法：90 / 90.5 / 1:30 / 01:23:45 都行
// 输出：COO/素材/切片/原名-起-止.mp4（重编码精准对齐，参数与录屏器一致）
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FFMPEG = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const OUT_DIR = path.resolve(HERE, '../素材/切片');

// 时间格式兼容：90 / 90.5 / 1:30 / 01:23:45，统一转秒
function parseTime(s) {
  s = String(s || '').trim().replace(/^["']|["']$/g, '');
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const parts = s.split(':').map(Number);
  if (!parts.length || parts.some((v) => Number.isNaN(v))) return null;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

function cleanPath(s) {
  return String(s || '').trim().replace(/^"|"$|^'|'$/g, '');
}

// 核心切片：成功返回 true，失败打印原因返回 false
function doCut(src, t1, t2) {
  const start = parseTime(t1);
  const end = parseTime(t2);
  if (start === null || end === null || end <= start) {
    console.error(`[错误] 时间不对：起点 "${t1}" 终点 "${t2}"（终点必须大于起点）`);
    return false;
  }
  const base = path.basename(src).replace(/\.[^.]+$/, '');
  const tag = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
  const out = path.join(OUT_DIR, `${base}-${tag(start)}-${tag(end)}.mp4`);
  // -ss 放 -i 前跳转快；-t 用时长，时间轴无歧义，对齐精准
  const r = spawnSync(FFMPEG, [
    '-ss', String(start), '-i', src, '-t', String(end - start),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-y', out,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) {
    console.error('[错误] ffmpeg 切片失败：');
    console.error(String(r.stderr).split('\n').slice(-5).join('\n'));
    return false;
  }
  console.log(`已切出（${(end - start).toFixed(1)} 秒）：${out}`);
  return true;
}

// ── 交互模式（双击 bat 进入）：拖入视频 → 连续切多段 ──
async function interactive() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a)));

  console.log('=== 简兮 JANSEE 轻量切片器 ===');
  console.log(`输出目录：${OUT_DIR}`);
  console.log('时间用冒号写：0:05 = 0分05秒，1:30 = 1分30秒（别用小数点，0.05 会被当成 0.05 秒）。');
  console.log('');
  let src = cleanPath(await ask('把视频文件拖进本窗口，回车：'));
  while (!fs.existsSync(src)) {
    src = cleanPath(await ask('文件不存在，重新拖入或输入完整路径：'));
  }

  for (;;) {
    console.log('');
    const t1 = await ask('起点（冒号写法，如 0:05 = 0分05秒）：');
    const t2 = await ask('终点（如 0:20）：');
    doCut(src, t1, t2);
    console.log('');
    const next = await ask('回车继续切下一段，输入 q 退出：');
    if (next.trim().toLowerCase() === 'q') break;
  }
  rl.close();
  console.log('全部切片在 COO/素材/切片/ 里，去粗剪吧。');
}

// ── 参数模式：node cut.mjs 视频 起点 终点 ──
const [src, t1, t2] = process.argv.slice(2);

if (!fs.existsSync(FFMPEG)) {
  console.error(`[错误] 找不到 ffmpeg：${FFMPEG}`);
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

if (src && t1 && t2) {
  if (!fs.existsSync(src)) {
    console.error(`[错误] 找不到文件：${src}`);
    process.exit(1);
  }
  const ok = doCut(src, t1, t2);
  process.exit(ok ? 0 : 1);
} else {
  await interactive();
}
