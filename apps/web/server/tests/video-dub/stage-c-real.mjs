// 简兮 · 视频配音阶段 C —— 真实出片验证（真实 LLM 导演 + 真实腾讯 TTS + 真实 FFmpeg 合成）
// 前提：阶段 B 审核通过，用户批准进入阶段 C（真实调用预估成本 < 0.1 元/片 × 2 片）
// 【人工授权门槛】默认拒绝执行：需显式设置环境变量 STAGE_C_APPROVED=1（由负责人逐次批准），
// 防止任何自动化流程静默产生付费调用；另需生产网关 3000 已按真实配置（JIANXI_MOCK=0）启动。
// 目标：生产网关 3000（真实配置 JIANXI_MOCK=0），验证端到端真实链路产物质量：
//       时长 ±0.5s / 画幅与源一致 / 无原音轨 / 可播放 / videoUrl 可访问
if (process.env.STAGE_C_APPROVED !== '1') {
  console.error('[AUTH GATE] 本脚本触发真实 LLM/TTS 付费调用。需负责人逐次授权：设置环境变量 STAGE_C_APPROVED=1 后重跑。');
  process.exit(2);
}
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

const PASS = [];
const FAIL = [];
function assert(name, cond, actual = '') {
  (cond ? PASS : FAIL).push(name);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : `（实际 ${actual}）`}`);
}

const BASE = process.env.STAGE_C_BASE || 'http://localhost:3000';
const SRC_SECS = 8; // 源素材时长基准

// ===== Part 1 真实规格素材（720x1280 竖屏 25fps 8s，testsrc2 有运动画面）=====
const tmp = path.resolve('scratch/stage-c-materials');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const ff = (args) => execFileSync(ffmpegStatic, ['-nostdin', '-y', ...args], { stdio: 'ignore', cwd: tmp });
// 有声片：正弦 440Hz 假装原声，验证原音轨排除
ff(['-f', 'lavfi', '-i', 'testsrc2=s=720x1280:d=8:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
  '-map', '0:v', '-map', '1:a', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'real-voiced.mp4']);
// 无声片：验证 BGM/静音补满与画幅保持
ff(['-f', 'lavfi', '-i', 'testsrc2=s=720x1280:d=8:r=25', '-map', '0:v',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', 'real-silent.mp4']);
console.log('[Part1] 真实规格素材生成完成（720x1280 / 8s / 25fps）');

// ===== 探测工具 =====
function probe(file) {
  let out = '';
  try {
    execFileSync(ffmpegStatic, ['-nostdin', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { out = String(e.stderr || ''); } // ffmpeg -i 无输出必非零退出，但 stderr 含完整流信息
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(out);
  const secs = d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : -1;
  const streams = [...out.matchAll(/Stream #0:\d+.*?: (Video|Audio|Data):/g)].map((m) => m[1]);
  const wh = /Video:.*?, (\d+)x(\d+)[ ,]/.exec(out);
  return { secs, streams, w: wh ? +wh[1] : -1, h: wh ? +wh[2] : -1 };
}
function playable(file) {
  let err = '';
  try {
    execFileSync(ffmpegStatic, ['-nostdin', '-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { err = String(e.stderr || ''); }
  return err.trim().length === 0;
}

// ===== 网关健康前置检查 =====
let gwOk = false;
for (let i = 0; i < 10; i++) {
  try { const r = await fetch(`${BASE}/api/v1/health`); if (r.ok) { gwOk = true; break; } } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}
if (!gwOk) {
  console.error('生产网关不可达，终止（避免误报）');
  process.exit(1);
}
console.log('[Gate] 生产网关健康（真实配置）');

// ===== 单片全流程：上传 → produce → 轮询 → 产物校验 =====
async function runOne(file, label, title, desc) {
  console.log(`\n----- ${label} -----`);
  // 上传（真实落盘 + 真实时长探测）
  const up = await fetch(`${BASE}/api/v1/upload/video`, {
    method: 'POST',
    headers: { 'content-type': 'video/mp4', 'x-file-name': path.basename(file) },
    body: fs.readFileSync(file),
  });
  const upJson = await up.json();
  const d = Number(upJson?.data?.durationSec);
  assert(`${label} 真实上传 200 且探测 ≈8s`, up.status === 200 && d > SRC_SECS - 0.5 && d < SRC_SECS + 0.5, `status=${up.status} durationSec=${d}`);

  // produce（真实 LLM 导演）
  const pr = await fetch(`${BASE}/api/v1/video/produce`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scene: 'sell', title, description: desc,
      imageCount: 1, voice: '',
      videoPath: upJson.data.videoPath, uploadDir: upJson.data.uploadDir, durationSec: upJson.data.durationSec,
    }),
  });
  const prJson = await pr.json();
  const taskId = prJson?.data?.taskId;
  assert(`${label} produce 受理`, pr.status === 200 && !!taskId, `status=${pr.status} ${JSON.stringify(prJson).slice(0, 120)}`);
  if (!taskId) return;

  // 轮询至终态（真实 LLM + TTS + 合成，上限 10 分钟）
  const t0 = Date.now();
  let fin = null;
  while (Date.now() - t0 < 600000) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const r = await fetch(`${BASE}/api/v1/video/task/${taskId}`);
      const j = await r.json();
      const st = j?.data?.status;
      if (st === 'completed' || st === 'failed') { fin = j.data; break; }
    } catch {}
  }
  assert(`${label} 任务 completed（真实 LLM+TTS 全链路）`, fin?.status === 'completed', JSON.stringify({ status: fin?.status, stageText: fin?.stageText }));
  if (fin?.status !== 'completed') return;

  const shots = Array.isArray(fin.script?.shots) ? fin.script.shots.length : 0;
  assert(`${label} 导演旁白分段保留（shots>=1）`, shots >= 1, `shots=${shots}`);

  // videoUrl HTTP 可访问
  let httpOk = false, httpLen = -1;
  try {
    const vr = await fetch(`${BASE}${fin.videoUrl}`);
    httpLen = Number(vr.headers.get('content-length') || -1);
    httpOk = vr.status === 200 && httpLen > 0;
  } catch {}
  assert(`${label} videoUrl HTTP 200 可访问`, httpOk, `len=${httpLen}`);

  // 产物 ffprobe 校验
  const finalPath = path.resolve('storage/outputs', taskId, 'final.mp4');
  const stat = fs.existsSync(finalPath) ? fs.statSync(finalPath) : null;
  assert(`${label} final.mp4 落盘非空`, stat?.isFile() && stat.size > 0, stat ? `${stat.size}B` : '不存在');
  if (!stat) return;

  const p = probe(finalPath);
  assert(`${label} 成片时长与源偏差 ≤0.5s`, Math.abs(p.secs - SRC_SECS) <= 0.5, `final=${p.secs.toFixed(2)}s src=${SRC_SECS}s`);
  assert(`${label} 画幅与源一致 720x1280（不强制改画幅）`, p.w === 720 && p.h === 1280, `${p.w}x${p.h}`);
  assert(`${label} 流结构 1 视频 + 1 音频（原音轨不进入成片）`, p.streams.join(',') === 'Video,Audio', p.streams.join(','));
  assert(`${label} 成片可播放（全流解码无错误）`, playable(finalPath));
  console.log(`[INFO] ${label} taskId=${taskId} 时长=${p.secs.toFixed(2)}s 画幅=${p.w}x${p.h} 旁白=${shots}段`);
}

await runOne(path.join(tmp, 'real-voiced.mp4'), 'C1 有声视频真实出片',
  '轻氧冷萃挂耳咖啡', '10 秒冷萃工艺还原手冲风味，撕开即泡，办公室也能喝到精品咖啡');
await runOne(path.join(tmp, 'real-silent.mp4'), 'C2 无声视频真实出片',
  '山野 portable 折叠露营椅', '600 克仅手掌大小，承重 120 公斤，收纳 3 秒完成露营说走就走');

console.log(`\n========== 结果：${PASS.length} PASS / ${FAIL.length} FAIL ==========`);
process.exit(FAIL.length ? 1 : 0);
