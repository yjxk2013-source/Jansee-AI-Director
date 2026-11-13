// 简兮口播模块 · E1 端到端测试（stub ASR 桩，零付费必跑）
// 桩点说明：仅拦截 modules/video_creator/asr/asr.js 的 runASR（伪造 whisper 识别结果），
// keepOriginal 宽集填充词标记、detect/compose/字幕/BGM/FFmpeg 全部走真实实现；不产生任何 LLM/TTS 费用。
// 运行：在仓库根执行 node apps/web/server/tests/speechcut/test-e2e-stub.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';

const PASS = [];
const FAIL = [];
function assert(name, cond, detail = '') {
  (cond ? PASS : FAIL).push(name);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : `（实际 ${detail}）`}`);
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..'); // speechcut → tests → server → web → apps → 仓库根

// stub whisper 输出：8 个词，含填充词「呃」（宽集标记由真实 keepOriginal 层叠加）
const STUB_WORDS = [
  { word: '大家好', start: 0.20, end: 0.80 },
  { word: '今天', start: 0.85, end: 1.10 },
  { word: '呃', start: 1.15, end: 1.35 },
  { word: '给大家', start: 1.40, end: 1.70 },
  { word: '介绍', start: 1.75, end: 2.00 },
  { word: '一个', start: 2.05, end: 2.25 },
  { word: '特别好的', start: 2.30, end: 2.60 },
  { word: '产品', start: 2.65, end: 2.95 },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'speechcut-e1-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const PORT = '3317';
const BASE = `http://localhost:${PORT}`;
let gw = null;

async function jfetch(p, opt) {
  const r = await fetch(BASE + p, opt);
  let j = null;
  try { j = await r.json(); } catch (e) {}
  return { status: r.status, json: j };
}
async function pollTask(taskId, statuses, maxSec) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxSec * 1000) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const { json } = await jfetch(`/api/v1/video/task/${taskId}`);
      const task = json && json.data;
      if (task && statuses.includes(task.status)) return task;
    } catch (e) {}
  }
  return null;
}

try {
  // 1. 启动隔离网关（stub ASR + mock 模式 + 隔离账本目录）
  // 注意：--import 必须用相对路径（Node 22 拒绝裸盘符路径，报 ERR_UNSUPPORTED_ESM_URL_SCHEME）
  gw = spawn(process.execPath,
    ['--import', './apps/web/server/tests/speechcut/e2e-speech-asr-stub-loader.mjs', 'apps/web/server/index.mjs'],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT, JIANXI_MOCK: '1', JX_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  let gwLog = '';
  gw.stdout.on('data', (d) => { gwLog += d; });
  gw.stderr.on('data', (d) => { gwLog += d; });
  let gwOk = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { const r = await fetch(`${BASE}/api/v1/health`); if (r.ok) { gwOk = true; break; } } catch (e) {}
  }
  assert('E0 隔离网关健康', gwOk, gwLog.slice(-400));

  // 2. 测试素材（320x568 竖屏 3s + 正弦假人声）→ 真实上传
  const src = path.join(tmp, 'src.mp4');
  execFileSync(ffmpegStatic, ['-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x568:d=3:r=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-map', '0:v', '-map', '1:a', '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src,
  ], { stdio: 'ignore' });
  const up = await jfetch('/api/v1/upload/video', {
    method: 'POST',
    headers: { 'content-type': 'video/mp4', 'x-file-name': 'e1-src.mp4' },
    body: fs.readFileSync(src),
  });
  assert('E1 真实上传 200 且探测 ≈3s', up.status === 200 && Math.abs(Number(up.json?.data?.durationSec) - 3) < 0.5,
    `status=${up.status} dur=${up.json?.data?.durationSec}`);

  // 3. 安全校验：路径穿越与不存在文件必须拒绝
  const evil1 = await jfetch('/api/v1/speech/analyze', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ videoPath: path.join(tmp, 'evil', '..', 'src.mp4').replace(tmp, 'F:/janseeV2/evil') }),
  });
  assert('E2 越目录路径 analyze 拒绝', evil1.status === 400, `status=${evil1.status}`);
  const evil2 = await jfetch('/api/v1/speech/analyze', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ videoPath: path.join(REPO_ROOT, 'storage', 'uploads', 'upload_not_exist_9999', 'video.mp4') }),
  });
  assert('E3 不存在文件 analyze 拒绝', evil2.status === 400, `status=${evil2.status}`);

  // 4. analyze → analyzed（stub 词表 + 真实建议标记）
  const an = await jfetch('/api/v1/speech/analyze', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ videoPath: up.json.data.videoPath, uploadDir: up.json.data.uploadDir, durationSec: up.json.data.durationSec }),
  });
  const taskId = an.json?.data?.taskId;
  assert('E4 analyze 受理', an.status === 200 && !!taskId, `status=${an.status}`);
  const taskA = await pollTask(taskId, ['analyzed', 'failed'], 60);
  assert('E5 analyze 完成 analyzed', taskA?.status === 'analyzed', JSON.stringify({ s: taskA?.status, e: taskA?.error }));
  assert('E6 词表 = stub 8 词（服务端权威）', taskA?.words?.length === 8, String(taskA?.words?.length));
  const fillerSug = (taskA?.suggestions || []).find((s) => s.word === '呃');
  assert('E7 建议标记含填充词「呃」（宽集真实生效）', !!fillerSug && fillerSug.reason === 'filler', JSON.stringify(taskA?.suggestions));

  // 5. produce（删「呃」）→ completed + 产物校验
  const pr = await jfetch('/api/v1/speech/produce', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId, deletedStarts: [1.15] }),
  });
  assert('E8 produce 受理', pr.status === 200, `status=${pr.status} ${JSON.stringify(pr.json)}`);
  const taskP = await pollTask(taskId, ['completed', 'failed'], 120);
  assert('E9 合成 completed', taskP?.status === 'completed', JSON.stringify({ s: taskP?.status, e: taskP?.error }));
  const dur = Number(taskP?.duration);
  // 删「呃」cut≈[1.10,1.40]=0.3s → 原片 2.7s + 结尾卡尾段 2.95s ≈ 5.65s
  //（2026-10-24 全版块结尾收束标配：成片 = 剪除后原片 + 淡出黑停 CTA 尾段）
  assert('E10 成片时长 ≈5.65s（2.7s 原片 + 2.95s 结尾尾段）', dur > 4.9 && dur < 6.4, String(dur));
  assert('E11 剪除时长 ≈0.3s', Math.abs(Number(taskP?.cutSec) - 0.3) < 0.1, String(taskP?.cutSec));
  assert('E12 videoUrl 存在', !!taskP?.videoUrl, taskP?.videoUrl);

  let httpOk = false, httpLen = -1;
  try {
    const vr = await fetch(BASE + taskP.videoUrl);
    httpLen = Number(vr.headers.get('content-length') || -1);
    httpOk = vr.status === 200 && httpLen > 0;
  } catch (e) {}
  assert('E13 videoUrl HTTP 200 可访问', httpOk, `len=${httpLen}`);

  const finalPath = path.join(REPO_ROOT, 'storage', 'outputs', taskId, 'final.mp4');
  let probeOut = '';
  try { execFileSync(ffmpegStatic, ['-nostdin', '-i', finalPath], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { probeOut = String(e.stderr || ''); }
  const streams = [...probeOut.matchAll(/Stream #0:\d+.*?: (Video|Audio|Data):/g)].map((m) => m[1]);
  assert('E14 流结构 1 视频 + 1 音频', streams.join(',') === 'Video,Audio', streams.join(','));
  let playable = false;
  try { execFileSync(ffmpegStatic, ['-nostdin', '-v', 'error', '-i', finalPath, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }); playable = true; } catch (e) {}
  assert('E15 成片可播放（全流解码无错误）', playable);

  // 6. 重复 produce 拦截（completed 状态）
  const pr2 = await jfetch('/api/v1/speech/produce', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId, deletedStarts: [] }),
  });
  assert('E16 completed 后重复 produce 拦截 409', pr2.status === 409, `status=${pr2.status}`);

  // 7. produce 未知 taskId
  const pr3 = await jfetch('/api/v1/speech/produce', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 'spk_none_xyz', deletedStarts: [] }),
  });
  assert('E17 未知 taskId → 404', pr3.status === 404, `status=${pr3.status}`);
} finally {
  if (gw) { try { gw.kill(); } catch (e) {} }
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}

console.log(`\n===== e2e-stub 结果：${PASS.length} PASS / ${FAIL.length} FAIL =====`);
process.exit(FAIL.length ? 1 : 0);
