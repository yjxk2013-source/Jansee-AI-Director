// 简兮口播模块 · E2 真实语音端到端测试（真 whisper 本地识别，零付费）
// 链路：SAPI 本地合成中文语音（零付费）→ ffmpeg 合成测试视频 → 真实上传 →
//       analyze（真 whisper.cpp 词级时间戳 + 真实建议标记）→ produce（真实剪切合成）→ 产物校验
// 不调用任何真实付费 API（无 LLM / 云 TTS）。
// 降级方案：若本机 SAPI 无中文语音，脚本以 exit 2 结束并给出 SKIP 说明，
//           E1 stub 测试（test-e2e-stub.mjs）已覆盖全链路逻辑，可作为降级验证基线。
// 运行：在仓库根执行 node apps/web/server/tests/speechcut/test-e2e-real.mjs
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
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');

// 中文测试文案：包含「呃」「那个」「这个」等填充词与可删短语，供真实识别与建议标记验证
const SPEECH_TEXT = '大家好，今天呃给大家介绍一下我们家的这一款产品。那个这一款产品呢，它的质量真的非常非常好，而且价格也特别实惠，喜欢的家人们可以放心购买。';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'speechcut-e2-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const PORT = '3318';
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
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const { json } = await jfetch(`/api/v1/video/task/${taskId}`);
      const task = json && json.data;
      if (task && statuses.includes(task.status)) return task;
    } catch (e) {}
  }
  return null;
}
function wavDurationSec(file) {
  try {
    execFileSync(ffmpegStatic, ['-nostdin', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    return 0; // 无 stderr 异常时不走这里
  } catch (e) {
    const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(e.stderr || ''));
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
}

try {
  // 0. SAPI 本地合成中文语音（环境不可用则明确降级退出，不误报为 FAIL）
  const wav = path.join(tmp, 'speech.wav');
  let sapiOk = false;
  try {
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'sapi-tts.ps1'), '-OutFile', wav, '-Text', SPEECH_TEXT],
      { encoding: 'utf8', timeout: 60000 });
    sapiOk = fs.existsSync(wav) && fs.statSync(wav).size > 10000;
    if (sapiOk) console.log(`[E2] SAPI 合成成功: ${String(out).trim()} 时长≈${wavDurationSec(wav).toFixed(1)}s`);
  } catch (e) {
    console.log(`[E2] SAPI 合成失败: ${String(e.stderr || e.message || e).slice(0, 300)}`);
  }
  if (!sapiOk) {
    console.log('\n===== SKIP：本机 SAPI 无可用中文语音，E2 真实语音链路未运行（不算通过）；降级基线为 E1 stub 测试 =====');
    process.exit(2);
  }

  // 1. 启动隔离网关（真实 ASR + mock 模式 + 隔离账本目录；不挂任何桩）
  gw = spawn(process.execPath, ['apps/web/server/index.mjs'],
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
  assert('R0 隔离网关健康（真实 ASR，无桩）', gwOk, gwLog.slice(-400));

  // 2. 语音 + 测试画面 → 竖屏测试视频（真实媒体文件）
  const src = path.join(tmp, 'src.mp4');
  execFileSync(ffmpegStatic, ['-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x568:r=25',
    '-i', wav,
    '-map', '0:v', '-map', '1:a', '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src,
  ], { stdio: 'ignore' });
  const srcDur = wavDurationSec(src);
  assert('R1 测试视频合成（语音+画面）', fs.existsSync(src) && srcDur > 5, `dur=${srcDur.toFixed(1)}s`);

  // 3. 真实上传
  const up = await jfetch('/api/v1/upload/video', {
    method: 'POST',
    headers: { 'content-type': 'video/mp4', 'x-file-name': 'e2-src.mp4' },
    body: fs.readFileSync(src),
  });
  assert('R2 真实上传 200 且时长探测一致', up.status === 200 && Math.abs(Number(up.json?.data?.durationSec) - srcDur) < 0.6,
    `status=${up.status} dur=${up.json?.data?.durationSec}`);

  // 4. analyze：真 whisper 本地识别（词级时间戳，零付费）
  const an = await jfetch('/api/v1/speech/analyze', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ videoPath: up.json.data.videoPath, uploadDir: up.json.data.uploadDir, durationSec: up.json.data.durationSec }),
  });
  const taskId = an.json?.data?.taskId;
  assert('R3 analyze 受理', an.status === 200 && !!taskId, `status=${an.status} ${JSON.stringify(an.json)}`);
  const taskA = await pollTask(taskId, ['analyzed', 'failed'], 300);
  assert('R4 真 whisper 分析完成 analyzed', taskA?.status === 'analyzed',
    JSON.stringify({ s: taskA?.status, e: String(taskA?.error || '').slice(0, 200) }));
  const words = taskA?.words || [];
  assert('R5 词表非空（真实识别）', words.length >= 3, String(words.length));
  assert('R6 ASR 文本非空', !!taskA?.asrText && /[\u4e00-\u9fa5]/.test(taskA.asrText), String(taskA?.asrText || '').slice(0, 80));
  const sugCount = (taskA?.suggestions || []).length;
  console.log(`[E2] 真实识别：${words.length} 词，建议删除 ${sugCount} 处，文本「${String(taskA?.asrText || '').slice(0, 60)}…」`);

  // 5. produce：删除集 = 服务端建议（无建议时取中段词验证剪辑能力），全部来自服务端权威词表
  let deletedStarts = (taskA?.suggestions || []).map((s) => Number(s.start));
  let expectCut = deletedStarts.length > 0;
  if (!expectCut && words.length > 2) {
    deletedStarts = [Number(words[Math.floor(words.length / 2)].start)];
    expectCut = true;
  }
  const pr = await jfetch('/api/v1/speech/produce', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId, deletedStarts }),
  });
  assert('R7 produce 受理', pr.status === 200, `status=${pr.status} ${JSON.stringify(pr.json)}`);
  const taskP = await pollTask(taskId, ['completed', 'failed'], 300);
  assert('R8 真实剪切合成 completed', taskP?.status === 'completed',
    JSON.stringify({ s: taskP?.status, e: String(taskP?.error || '').slice(0, 200) }));
  const dur = Number(taskP?.duration);
  /* 成片 = 剪除后原片 + 结尾收束尾段 2.95s（ending-kit ENDING_TAIL），
     所以总时长会大于源时长；判定剪除生效要看「扣掉尾段后的正文」是否短于源。 */
  const TAIL_SEC = 2.95;
  if (expectCut) {
    assert('R9 剪除生效：正文时长（成片-尾段）< 源时长', dur > 0 && dur - TAIL_SEC < srcDur - 0.2, `dur=${dur} src=${srcDur} tail=${TAIL_SEC}`);
    assert('R10 剪除时长 > 0', Number(taskP?.cutSec) > 0, String(taskP?.cutSec));
  } else {
    assert('R9 全保留分支：成片时长 ≈ 源时长 + 尾段', Math.abs(dur - (srcDur + TAIL_SEC)) < 0.8, `dur=${dur} src=${srcDur} tail=${TAIL_SEC}`);
  }
  assert('R11 videoUrl 存在', !!taskP?.videoUrl, taskP?.videoUrl);

  const finalPath = path.join(REPO_ROOT, 'storage', 'outputs', taskId, 'final.mp4');
  let probeOut = '';
  try { execFileSync(ffmpegStatic, ['-nostdin', '-i', finalPath], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { probeOut = String(e.stderr || ''); }
  const streams = [...probeOut.matchAll(/Stream #0:\d+.*?: (Video|Audio|Data):/g)].map((m) => m[1]);
  assert('R12 流结构 1 视频 + 1 音频', streams.join(',') === 'Video,Audio', streams.join(','));
  let playable = false;
  try { execFileSync(ffmpegStatic, ['-nostdin', '-v', 'error', '-i', finalPath, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }); playable = true; } catch (e) {}
  assert('R13 成片可播放（全流解码无错误）', playable);

  // 6. completed 后重复 produce 拦截（真实状态机）
  const pr2 = await jfetch('/api/v1/speech/produce', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId, deletedStarts: [] }),
  });
  assert('R14 completed 后重复 produce 拦截 409', pr2.status === 409, `status=${pr2.status}`);
} finally {
  if (gw) { try { gw.kill(); } catch (e) {} }
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}

console.log(`\n===== e2e-real 结果：${PASS.length} PASS / ${FAIL.length} FAIL =====`);
process.exit(FAIL.length ? 1 : 0);
