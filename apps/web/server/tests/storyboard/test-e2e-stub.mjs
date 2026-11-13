// 简兮分镜与切片模块 · E2E 端到端回归测试（隔离端口 + 临时目录 + 真实 HTTP 网关 + 零付费）
// 覆盖：
//   1. 视频上传接口附带返回 materialId；
//   2. 统一创作编排 creation/create（type=storyboard）受理并扣减 mock 积分 200 点（taskId 防重）；
//   3. 非法素材 ID 或重复提交返回适当错误；
//   4. 智能切片 creation/create（type=slicer）受理并交付切片清单；
//   5. 隔离实例优雅退出。
// （2026-10-24 全版块收敛：/storyboard/produce、/slicer/prepare 等旧 stage 路由已删除，
//   分镜/切片统一走 creation/create 契约，本文件同步迁移。）

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-e2e-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const PORT = '3319';
const BASE = `http://localhost:${PORT}`;
let gw = null;

async function jfetch(p, opt) {
  const r = await fetch(BASE + p, opt);
  let j = null;
  try { j = await r.json(); } catch (e) {}
  return { status: r.status, json: j };
}

try {
  // 1. 启动隔离网关（mock 模式 + 隔离端口）
  gw = spawn(process.execPath, ['apps/web/server/index.mjs'], {
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
    try {
      const r = await fetch(`${BASE}/api/v1/health`);
      if (r.ok) { gwOk = true; break; }
    } catch (e) {}
  }
  assert('E0 隔离网关健康启动', gwOk, gwLog.slice(-400));

  // 2. 生成 2.5 秒有效 MP4 素材并上传
  const src = path.join(tmp, 'sample.mp4');
  execFileSync(ffmpegStatic, [
    '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=25:duration=2.5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    '-shortest', src,
  ], { stdio: 'ignore' });

  const buf = fs.readFileSync(src);
  const up = await jfetch('/api/v1/upload/video', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(buf.length),
      'x-file-name': 'sample.mp4',
    },
    body: buf,
  });

  assert('E1 上传视频成功并返回 200', up.status === 200);
  assert('E1 上传返回包含 materialId', !!up.json?.data?.materialId, JSON.stringify(up.json));
  const matId = up.json?.data?.materialId;

  // 3. 初始积分查询
  const profileBefore = await jfetch('/api/v1/user/profile');
  const creditsBefore = profileBefore.json?.data?.credits;
  assert('E2 获取用户初始积分成功', typeof creditsBefore === 'number');

  // 4. 发起分镜成片创作任务（统一创作编排 type=storyboard，LLM 台词 → TTS → 叠化拼接 → 结尾卡）
  const sbCreate = await jfetch('/api/v1/creation/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'storyboard',
      title: '测试分镜成片',
      sellingPoints: '第一段台词',
      materialIds: [matId],
      scriptMode: 'auto',
    }),
  });
  assert('E3 分镜创作任务受理返回 200', sbCreate.status === 200, JSON.stringify(sbCreate.json));
  const taskId = sbCreate.json?.data?.taskId;
  assert('E3 返回有效 taskId (crt_ 前缀)', taskId && taskId.startsWith('crt_'), String(taskId));

  // 5. 校验积分扣减 200（creation 异步编排：扣费发生在底层任务受理瞬间，轮询等待落账）
  let creditsAfter = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const pf = await jfetch('/api/v1/user/profile');
    if (creditsBefore - (pf.json?.data?.credits ?? creditsBefore) >= 200) { creditsAfter = pf.json?.data?.credits; break; }
  }
  assert('E4 积分准确扣减 200 点', creditsAfter !== null && creditsBefore - creditsAfter === 200, `before: ${creditsBefore}, after: ${creditsAfter}`);

  // 6. 重复提交相同 taskId 拦截 (409)
  const duplicateSubmit = await jfetch('/api/v1/creation/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'storyboard',
      taskId,
      materialIds: [matId],
    }),
  });
  assert('E5 重复提交同一任务返回 409', duplicateSubmit.status === 409, `status: ${duplicateSubmit.status}`);

  // 7. 轮询创作任务端点验证结构
  const pollRes = await jfetch(`/api/v1/creation/task/${taskId}`);
  assert('E6 任务进度端点可查且返回 200', pollRes.status === 200);
  assert('E6 任务对象包含 type=storyboard', pollRes.json?.data?.type === 'storyboard', JSON.stringify(pollRes.json?.data?.type));

  // 8. 非法素材 ID 拒绝 (400)
  const invalidMat = await jfetch('/api/v1/creation/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'storyboard',
      materialIds: ['mat_non_exist'],
    }),
  });
  assert('E7 非法素材 ID 返回 404', invalidMat.status === 404, `status: ${invalidMat.status}`);

  // 9. 智能切片：creation type=slicer（切割 + 本地 ASR + 注册切片素材），交付切片清单
  const slicerCreate = await jfetch('/api/v1/creation/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'slicer',
      materialIds: [matId],
      options: { segSec: 20 },
    }),
  });
  assert('E8 智能切片创作任务受理返回 200', slicerCreate.status === 200, JSON.stringify(slicerCreate.json));
  const slicerTaskId = slicerCreate.json?.data?.taskId;
  assert('E8 返回有效创作 taskId (crt_ 前缀)', slicerTaskId && slicerTaskId.startsWith('crt_'), String(slicerTaskId));

  // 10. 轮询智能切片任务至完成，验证切片清单交付（本地 whisper 推理可达分钟级；ECONNRESET 为高负载瞬时抖动，容错重试）
  let slicerDone = null;
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const pr = await jfetch(`/api/v1/creation/task/${slicerTaskId}`);
      const st = pr.json?.data?.status;
      if (st === 'completed' || st === 'failed') { slicerDone = pr.json?.data; break; }
    } catch (e) {}
  }
  assert('E9 智能切片任务完成', slicerDone?.status === 'completed', JSON.stringify({ s: slicerDone?.status, e: slicerDone?.error }) + (slicerDone?.status === 'completed' ? '' : ` | gwLog: ${gwLog.split('\n').slice(-12).join(' / ')}`));
  assert('E9 切片清单 slices 已交付', Array.isArray(slicerDone?.outputs?.slices) && slicerDone.outputs.slices.length >= 1,
    JSON.stringify(slicerDone?.outputs?.slices?.length));
  assert('E9 切片段带 materialId（可进分镜成片二次消费）', !!slicerDone?.outputs?.slices?.[0]?.materialId,
    JSON.stringify(slicerDone?.outputs?.slices?.[0]));

  // 11. 安全素材列表接口端到端测试（S3 阶段：前端专用素材列表，零物理路径泄露）
  const matListRes = await jfetch('/api/v1/materials');
  assert('E10 素材列表接口返回 200', matListRes.status === 200);
  const foundMat = (matListRes.json?.data?.materials || []).find((m) => m.materialId === matId);
  assert('E10 素材列表中包含刚刚上传并登记的素材', !!foundMat);
  assert('E10 返回的素材对象绝对不包含物理路径 filePath', foundMat && foundMat.filePath === undefined);

  // 12. 单个素材详情查询
  const matDetailRes = await jfetch(`/api/v1/materials/${matId}`);
  assert('E11 单个素材详情查询返回 200', matDetailRes.status === 200);
  assert('E11 详情中 materialId 吻合且无 filePath', matDetailRes.json?.data?.materialId === matId && matDetailRes.json?.data?.filePath === undefined);

} finally {
  if (gw && !gw.killed) {
    gw.kill('SIGTERM');
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) {}
}

console.log(`\n========== E2E 回归测试结果：${PASS.length} PASS / ${FAIL.length} FAIL ==========`);
if (FAIL.length > 0) {
  process.exit(1);
}
