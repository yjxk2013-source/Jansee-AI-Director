// 简兮 · 视频配音阶段 D 契约测试（零付费）
// 锚定统一创作任务中心契约（POST /api/v1/creation/create，type=video_dub）+ 上传契约：
//   上传契约/错误路径 → 任务状态机与响应结构 → 产物访问（Range/404 语义）→ 失败不报告成功
//   → 参数校验 → 图片成片契约不变 → 服务重启任务态丢失行为。
// 零付费方案（与 test-stage-b 同源）：素材 ffmpeg-static 本地生成；LLM 走 JIANXI_MOCK=1 mocker 兜底；
//   TTS 经 stage-b-tts-stub-setup.mjs 桩为本地合成；网关起独立子进程（端口 3222，JX_DATA_DIR 账本隔离）。
// 端点说明：旧 /api/v1/video/produce 已于 2026-10-24 模块化升级中下线（410），本套件同步重写为
//   creation/create + creation/task 契约；原「伪造 videoPath 归属校验」随 materialIds 素材表契约
//   前移到上传端点（由本套件上传契约部分覆盖），不再重复断言。
// 差距锚定说明：G2（产物不存在落 SPA fallback 200）按现状断言，若未来修复须同步更新对应断言。
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

const PASS = [];
const FAIL = [];
function assert(name, cond, actual = '') {
  (cond ? PASS : FAIL).push(name);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : `（实际 ${actual}）`}`);
}

const ROOT = path.resolve('.');
const OUTPUTS = path.join(ROOT, 'storage/outputs');
const UPLOADS = path.join(ROOT, 'storage/uploads');
const TEST_DATA_DIR = path.resolve('scratch/stage-d-data');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });

// ===== Part 1 本地生成测试素材（0 元） =====
const tmp = path.resolve('scratch/stage-d-materials');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const ff = (args) => execFileSync(ffmpegStatic, ['-nostdin', '-y', ...args], { stdio: 'ignore', cwd: tmp });
// 有声 6s 竖屏 320x568（TTS 桩 long 模式配音 14.2s 超长 → 验证 trim 至「源时长 + 片尾收束卡」契约）
ff(['-f', 'lavfi', '-i', 'color=c=blue:s=320x568:d=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-map', '0:v', '-map', '1:a', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'voiced.mp4']);
fs.writeFileSync(path.join(tmp, 'broken.mp4'), Buffer.from('stage-d broken payload（非媒体字节）'));
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
console.log('[Part1] 测试素材生成完成');

// ===== 复用工具（与 test-stage-b 同源） =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnGateway(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['--import', './apps/web/server/tests/video-dub/stage-b-tts-stub-setup.mjs', 'apps/web/server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), JIANXI_MOCK: '1', JX_DATA_DIR: TEST_DATA_DIR, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  return { child, logs };
}

async function waitForGateway(base) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${base}/api/v1/health`); if (r.ok) return true; } catch (e) {}
    await sleep(300);
  }
  return false;
}

async function uploadVia(base, fp, name) {
  const buf = fs.readFileSync(fp);
  const resp = await fetch(`${base}/api/v1/upload/video`, {
    method: 'POST', headers: { 'content-type': 'video/mp4', 'x-file-name': name }, body: buf,
  });
  return { status: resp.status, json: await resp.json().catch(() => ({})) };
}

// 统一创作任务中心入口（旧 /api/v1/video/produce 已于模块化升级中下线，返回 410）
async function createVia(base, payload) {
  const resp = await fetch(`${base}/api/v1/creation/create`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { status: resp.status, json: await resp.json().catch(() => ({})) };
}

async function taskQuery(base, taskId) {
  const resp = await fetch(`${base}/api/v1/creation/task/${taskId}`);
  return { status: resp.status, json: await resp.json().catch(() => ({})) };
}

// 快速轮询收集状态快照（抓取 processing 中间态结构；completed/failed 即停）
async function snapshotPolling(base, taskId, maxMs = 180000) {
  const snaps = [];
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(150);
    try {
      const { json } = await taskQuery(base, taskId);
      if (json?.data) {
        snaps.push(json.data);
        if (json.data.status === 'completed' || json.data.status === 'failed') break;
      }
    } catch (e) {}
  }
  return snaps;
}

// 产物 HTTP 访问（含 Range）
function fetchOutput(base, urlPath, range = '') {
  return new Promise((resolve) => {
    fetch(`${base}${urlPath}`, range ? { headers: { range } } : {})
      .then(async (resp) => {
        const headers = Object.fromEntries(resp.headers.entries());
        if (resp.status === 206) { resp.body?.cancel?.(); return resolve({ status: resp.status, headers }); }
        const buf = Buffer.from(await resp.arrayBuffer());
        resolve({ status: resp.status, headers, size: buf.length, isHtml: headers['content-type']?.includes('text/html') });
      })
      .catch((e) => resolve({ status: 0, error: String(e) }));
  });
}

// 原生 http 伪造 Content-Length 超限（不真实传输 200MB）
function rawOversizeUpload(port) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/v1/upload/video', method: 'POST',
      headers: { 'x-file-name': 'big.mp4', 'content-length': String(201 * 1024 * 1024) },
      timeout: 5000,
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch (e) { resolve({ status: res.statusCode, json: {} }); } });
    });
    req.on('error', (e) => resolve({ status: 0, json: {}, error: String(e) }));
    req.end('x');
  });
}

function listUploadDirs() {
  try { return fs.readdirSync(UPLOADS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch (e) { return []; }
}

const DUB_PAYLOAD_BASE = {
  type: 'video_dub', scene: 'sell', mode: 'dub', title: '契约测试商品', sellingPoints: '卖点甲。卖点乙，卖点丙。', voice: 'female',
};
const producedTaskIds = [];
const producedUploadDirs = [];

// ===== Part 2-6 主流程（子进程 D1，端口 3222） =====
const PORT1 = 3222;
const BASE1 = `http://127.0.0.1:${PORT1}`;
{
  const { child, logs } = spawnGateway(PORT1, { STUB_TTS_MODE: 'long' });
  try {
    assert('D1 网关启动健康（TTS 桩 + mocker 隔离实例）', await waitForGateway(BASE1), logs.slice(-6).join('||').slice(0, 300));

    // ---- 契约 §2：上传成功响应结构 ----
    const up = await uploadVia(BASE1, path.join(tmp, 'voiced.mp4'), 'voiced.mp4');
    producedUploadDirs.push(up.json?.data?.uploadDir);
    assert('上传契约 200/code=0/msg=上传成功', up.status === 200 && up.json.code === 0 && up.json.msg === '上传成功', JSON.stringify({ s: up.status, c: up.json.code, m: up.json.msg }));
    assert('上传 data 三字段齐全（videoPath/uploadDir/durationSec>0）',
      !!up.json?.data?.videoPath && !!up.json?.data?.uploadDir && Number(up.json?.data?.durationSec) > 0,
      JSON.stringify(up.json?.data || {}).slice(0, 160));
    assert('videoPath 指向 storage/uploads 目录内', String(up.json?.data?.videoPath || '').includes(path.join('storage', 'uploads')), up.json?.data?.videoPath);
    assert('durationSec ≈ 6s（真实探测非伪造）', Math.abs(Number(up.json?.data?.durationSec) - 6) < 1.5, up.json?.data?.durationSec);

    // ---- 契约 §2.4：格式不支持 ----
    const upAvi = await uploadVia(BASE1, path.join(tmp, 'voiced.mp4'), 'evil.avi');
    assert('格式不支持 400/code=40004', upAvi.status === 400 && upAvi.json.code === 40004, JSON.stringify({ s: upAvi.status, c: upAvi.json.code }));

    // ---- 契约 §2.4：超限（伪造 Content-Length，不真实传输） ----
    const os = await rawOversizeUpload(PORT1);
    assert('超限 413/code=40006', os.status === 413 && os.json.code === 40006, JSON.stringify({ s: os.status, c: os.json.code, e: os.error || '' }));

    // ---- 契约 §2.4/§2.5：损坏文件拒绝 + 失败即清理（diff 法验证目录无残留） ----
    const beforeUpload = new Set(listUploadDirs());
    const upBroken = await uploadVia(BASE1, path.join(tmp, 'broken.mp4'), 'broken.mp4');
    await sleep(600);
    const newDirs = listUploadDirs().filter((n) => !beforeUpload.has(n));
    const residue = newDirs.filter((n) => { try { return fs.readdirSync(path.join(UPLOADS, n)).length > 0; } catch (e) { return false; } });
    assert('损坏文件 400/code=40007（时长探测拒绝）', upBroken.status === 400 && upBroken.json.code === 40007, JSON.stringify({ s: upBroken.status, c: upBroken.json.code }));
    assert('失败即清理：上传目录无残留（铁律 §2.5）', residue.length === 0, `新目录=${newDirs.join(',')} 残留=${residue.join(',')}`);

    // ---- 契约 §3.4：创建任务立即响应结构 ----
    const p1 = await createVia(BASE1, { ...DUB_PAYLOAD_BASE, materialIds: [up.json.data.materialId] });
    const taskId = p1.json?.data?.taskId || '';
    if (taskId) producedTaskIds.push(taskId);
    assert('create 受理 200/code=0', p1.status === 200 && p1.json.code === 0, JSON.stringify({ s: p1.status, c: p1.json.code }));
    assert('taskId 格式 crt_ 前缀', /^crt_\d+_[a-z0-9]{5}$/.test(taskId), taskId);
    assert('立即响应 status=pending + stage/progress 结构', p1.json?.data?.status === 'pending' && Number.isFinite(p1.json?.data?.progress), JSON.stringify(p1.json?.data || {}));

    // ---- 契约 §4.2/§4.3：processing 中间态结构 ----
    const snaps = await snapshotPolling(BASE1, taskId);
    const procSnap = snaps.find((s) => s.status === 'processing');
    assert('状态机出现 processing 中间态', !!procSnap, `快照态序列=${snaps.map((s) => s.status).join('→') || '无'}`);
    if (procSnap) {
      assert('processing 结构含 stage/progress/stageText',
        !!procSnap.stage && Number.isFinite(procSnap.progress) && !!procSnap.stageText,
        JSON.stringify({ stage: procSnap.stage, progress: procSnap.progress }));
    }
    const t1 = snaps[snaps.length - 1] || {};

    // ---- 契约 §4.4：completed 响应结构（字段集逐项锚定） ----
    assert('任务最终 completed', t1.status === 'completed', `status=${t1.status} err=${JSON.stringify(t1.error || '')} log=${logs.slice(-3).join('||').slice(0, 200)}`);
    assert('completed stage=done/progress=100', t1.stage === 'done' && t1.progress === 100, JSON.stringify({ stage: t1.stage, progress: t1.progress }));
    assert('videoUrl = /storage/outputs/{taskId}/final.mp4', t1.outputs?.videoUrl === `/storage/outputs/${taskId}/final.mp4`, t1.outputs?.videoUrl);
    assert('subtitleUrl/audioUrl 恒空串（无独立产物交付）', t1.outputs?.subtitleUrl === '' && t1.outputs?.audioUrl === '', JSON.stringify({ sub: t1.outputs?.subtitleUrl, aud: t1.outputs?.audioUrl }));
    assert('duration ≈ 8.95s（配音超长 trim 至 源视频 6s + 片尾收束卡 2.95s，±0.7s）', Math.abs(Number(t1.outputs?.duration) - 8.95) < 0.7, `duration=${t1.outputs?.duration}`);

    // 发布方案（增值交付物）：导演层随成片产出，四件套到达任务态供前端复制卡渲染
    const pubD1 = t1.outputs?.publish;
    assert('D1 发布方案四件套齐全（caption 非空，其余为字符串）',
      !!pubD1 && typeof pubD1.caption === 'string' && pubD1.caption.length > 0
      && typeof pubD1.cover_title === 'string' && typeof pubD1.pinned_comment === 'string'
      && typeof pubD1.post_time === 'string',
      JSON.stringify(pubD1 || null));
    assert('D1 发布方案无调试字段与路径泄漏', !pubD1 || (!('_banned_hits' in pubD1) && !JSON.stringify(pubD1).includes(':\\')), JSON.stringify(pubD1));

    // ---- 契约 §5：产物访问（200 / MIME / Range 206） ----
    const out1 = await fetchOutput(BASE1, t1.outputs?.videoUrl);
    assert('产物 GET 200 + Content-Type video/mp4', out1.status === 200 && out1.headers['content-type']?.includes('video/mp4'), JSON.stringify({ s: out1.status, ct: out1.headers['content-type'] }));
    assert('产物非空（字节流完整返回）', out1.size > 0, String(out1.size));
    const outRange = await fetchOutput(BASE1, t1.outputs?.videoUrl, 'bytes=0-1023');
    assert('Range 请求 206 + Content-Range（断点续传）', outRange.status === 206 && !!outRange.headers['content-range'], JSON.stringify({ s: outRange.status, cr: outRange.headers['content-range'] }));
    const finalPath = path.join(OUTPUTS, taskId, 'final.mp4');
    assert('产物落盘 storage/outputs/{taskId}/final.mp4 非空', fs.existsSync(finalPath) && fs.statSync(finalPath).size > 0, finalPath);

    // ---- 契约 §4.6：任务不存在 404 ----
    const q404 = await taskQuery(BASE1, 'task_nonexist_00000');
    assert('不存在任务 404/code=40400「任务不存在或已过期」', q404.status === 404 && q404.json.code === 40400, JSON.stringify({ s: q404.status, c: q404.json.code }));

    // ---- 差距 G2 锚定：产物不存在落 SPA fallback 200 HTML（现状行为，修复时更新本断言） ----
    const out404 = await fetchOutput(BASE1, '/storage/outputs/task_nonexist_00000/final.mp4');
    assert('G2 锚定：不存在产物返回 200 text/html（SPA fallback 现状）', out404.status === 200 && out404.isHtml === true, JSON.stringify({ s: out404.status, ct: out404.headers?.['content-type'] }));

    // ---- 契约 §3.3：服务端权威时长复测（前端伪造 durationSec 不被信任） ----
    // 上传时文件有效（通过上传契约探测），随后在盘上损坏 → produce 阶段权威复测必须失败。
    // （旧「uploads 外伪造路径」用例随 materialIds 契约失效：路径白名单已前移到上传登记处，
    //   越界路径进不了素材表，由上方上传契约用例覆盖。）
    const upCorrupt = await uploadVia(BASE1, path.join(tmp, 'voiced.mp4'), 'voiced.mp4');
    producedUploadDirs.push(upCorrupt.json?.data?.uploadDir);
    fs.writeFileSync(upCorrupt.json.data.videoPath, Buffer.from('stage-d corrupted after upload'));
    const pBroken = await createVia(BASE1, { ...DUB_PAYLOAD_BASE, materialIds: [upCorrupt.json.data.materialId] });
    if (pBroken.json?.data?.taskId) producedTaskIds.push(pBroken.json.data.taskId);
    await snapshotPolling(BASE1, pBroken.json?.data?.taskId, 20000);
    const tBroken = (await taskQuery(BASE1, pBroken.json?.data?.taskId)).json?.data || {};
    assert('损坏视频（上传后）任务 failed（权威时长探测，不信前端值）', tBroken.status === 'failed', JSON.stringify({ s: tBroken.status }));
    assert('错误语义：服务端权威时长探测失败', /时长探测失败/.test(String(tBroken.error?.message || tBroken.error || '')), JSON.stringify(tBroken.error || ''));
    assert('失败任务产物不落盘', !fs.existsSync(path.join(OUTPUTS, pBroken.json?.data?.taskId || 'none', 'final.mp4')), '');

    // ---- 契约 §3.5：参数校验（materialIds>9 同步拒绝） ----
    const pImg9 = await createVia(BASE1, { ...DUB_PAYLOAD_BASE, materialIds: Array.from({ length: 10 }, (_, i) => `mat_fake_${i}`) });
    assert('materialIds>9 同步 400/code=40011', pImg9.status === 400 && pImg9.json.code === 40011, JSON.stringify({ s: pImg9.status, c: pImg9.json.code }));

    // ---- 契约 §3.2：voice 非法值视为未指定（任务照常受理） ----
    const pVoice = await createVia(BASE1, { ...DUB_PAYLOAD_BASE, materialIds: [up.json.data.materialId], voice: 'robot' });
    if (pVoice.json?.data?.taskId) producedTaskIds.push(pVoice.json.data.taskId);
    assert('voice 非法值不拒单（视为未指定交 LLM 判定，受理 200）', pVoice.status === 200 && !!pVoice.json?.data?.taskId, JSON.stringify({ s: pVoice.status, c: pVoice.json.code }));

    // ---- 契约锚定：视频配音接口变化不影响图片成片（契约级：共享端点立即响应结构一致） ----
    const upImg = await fetch(`${BASE1}/api/v1/upload/images`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ images: [TINY_PNG] }),
    });
    const upImgJson = await upImg.json().catch(() => ({}));
    producedUploadDirs.push(upImgJson?.data?.uploadDir);
    assert('upload/images 契约正常（200/code=0/materialIds 数组）', upImg.status === 200 && upImgJson.code === 0 && Array.isArray(upImgJson?.data?.materialIds) && upImgJson.data.materialIds.length === 1, JSON.stringify({ s: upImg.status, c: upImgJson.code }));
    const pImg = await createVia(BASE1, { type: 'image_creator', scene: 'sell', mode: 'product', title: '契约测试商品', sellingPoints: '卖点甲。卖点乙。', materialIds: upImgJson.data.materialIds });
    if (pImg.json?.data?.taskId) producedTaskIds.push(pImg.json.data.taskId);
    assert('图片分支 create 立即响应结构与视频分支一致（同端点 200 + taskId + pending）',
      pImg.status === 200 && !!pImg.json?.data?.taskId && pImg.json?.data?.status === 'pending',
      JSON.stringify(pImg.json?.data || {}).slice(0, 140));
    const imgSnaps = await snapshotPolling(BASE1, pImg.json?.data?.taskId, 6000); // 仅观察不等待渲染完成
    const imgProc = imgSnaps.find((s) => s.status === 'processing');
    if (imgProc) assert('图片分支 processing 结构正常（stage/progress 存在）', !!imgProc.stage && Number.isFinite(imgProc.progress), JSON.stringify({ stage: imgProc.stage, progress: imgProc.progress }));
    else console.log('INFO 图片分支渲染快于轮询窗口，中间态未捕获（由既有回归覆盖，不作 FAIL）');
  } finally {
    child.kill();
  }
}

// ===== Part 7 服务重启行为（契约 §4.6：任务态丢失 → 404；产物文件存续 → 仍可访问） =====
{
  const { child: child2, logs: logs2 } = spawnGateway(PORT1);
  try {
    const ok2 = await waitForGateway(BASE1);
    assert('D2 重启网关健康', ok2, logs2.slice(-4).join('||').slice(0, 200));
    const oldTaskId = producedTaskIds[0];
    const q = await taskQuery(BASE1, oldTaskId);
    assert('重启后旧 taskId 404/code=40400（内存任务态丢失）', q.status === 404 && q.json.code === 40400, JSON.stringify({ s: q.status, c: q.json.code }));
    const outAfter = await fetchOutput(BASE1, `/storage/outputs/${oldTaskId}/final.mp4`);
    assert('重启后历史产物仍可访问（产物不随任务态消失）', outAfter.status === 200 && outAfter.headers['content-type']?.includes('video/mp4'), JSON.stringify({ s: outAfter.status, ct: outAfter.headers?.['content-type'] }));
  } finally {
    child2.kill();
  }
}

// ===== 测试产物清理（仅清理本测试创建的目录，不触碰既有业务记录） =====
try {
  for (const id of producedTaskIds) fs.rmSync(path.join(OUTPUTS, id), { recursive: true, force: true });
  for (const d of producedUploadDirs) { if (d && d.includes(UPLOADS)) fs.rmSync(d, { recursive: true, force: true }); }
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  console.log('[Cleanup] 测试产物清理完成（任务目录/上传目录/素材/隔离数据）');
} catch (e) {
  console.warn('[Cleanup] 清理异常（不影响测试结论）:', e.message);
}

console.log(`\n========== 契约测试结果：${PASS.length} PASS / ${FAIL.length} FAIL ==========`);
process.exit(FAIL.length ? 1 : 0);
