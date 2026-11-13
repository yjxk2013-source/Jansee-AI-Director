// 简兮 · 视频配音阶段 B 零付费回归（sanitize 视频分支 + mocker 兜底 + 端到端合成接线 + 原音排除 + 图片回归）
// 全程本地零付费：测试素材由 ffmpeg-static 生成；TTS 经 ESM loader 桩为本地 sine 合成（不触网）；
// LLM 走 JIANXI_MOCK=1 的 mocker 兜底路径；BGM 选曲为本地曲库真实选曲；网关起独立子进程实例。
// 端到端入口：POST /api/v1/creation/create（type=video_dub，materialIds 素材登记表）+ GET /api/v1/creation/task/:taskId。
// （旧 /api/v1/video/produce 端点已随模块化升级下线 410，2026-10-24 起重写为统一创作任务中心入口。）
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

// 数据目录隔离：仅网关子进程设置 JX_DATA_DIR（paths.mjs 测试约定）——端到端任务的
// recordCreative 落临时目录，不污染真实创作防重账本。主进程（Part 2-4 单测）使用独立
// 隔离账本种子（prompt 基线在种子状态下保存，确定性可复现，不读真实业务账本）。
const TEST_DATA_DIR = path.resolve('scratch/stage-b-data');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
const SEED_DIR = path.resolve('scratch/prompt-baseline-data');
fs.rmSync(SEED_DIR, { recursive: true, force: true });
fs.mkdirSync(SEED_DIR, { recursive: true });
fs.copyFileSync(path.resolve('apps/web/server/tests/video-dub/baseline/ledger-seed.json'), path.join(SEED_DIR, 'creative_ledger.json'));
process.env.JX_DATA_DIR = SEED_DIR; // 必须先于 director.mjs 动态 import（paths.mjs 顶层读 env）

// ===== Part 1 本地生成测试素材（0 元） =====
const tmp = path.resolve('scratch/stage-b-materials');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const ff = (args) => execFileSync(ffmpegStatic, ['-nostdin', '-y', ...args], { stdio: 'ignore', cwd: tmp });
ff(['-f', 'lavfi', '-i', 'color=c=blue:s=320x568:d=6', '-r', '25', '-pix_fmt', 'yuv420p', 'silent.mp4']);
ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x568:d=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-map', '0:v', '-map', '1:a', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'voiced.mp4']);
ff(['-f', 'lavfi', '-i', 'color=c=green:s=320x568:d=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-shortest',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'multi.mp4']);
ff(['-f', 'lavfi', '-i', 'color=c=yellow:s=320x568:d=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-map', '0:v', '-map', '1:a', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mov', 'voiced.mov']);
console.log('[Part1] 测试素材生成完成');

// ===== Part 2 sanitize 视频分支单测（桩 global.fetch 模拟 LLM 输出，无网络） =====
process.env.SILICONFLOW_API_KEY = 'stageb-test-key-12345678';
delete process.env.JIANXI_MOCK;
const { generateDirectorCut, generateConstitutionScript } = await import('../../director.mjs');

const LLM_VIDEO_CUT = {
  title: '测试商品标题', variant_type: 'A-痛点直击型', emotion: '种草推荐',
  voice_gender: 'female', bgm_emotion: 'warm', bgm_on: true, sfx_on: false,
  opening: 'dive_in', ending: 'black_out', cover_line: '测试封面副标',
  end_line: '看完记得点个关注',
  visual_design: { layout: 'center', font: 'sans', graphic: 'thin_line', color: 'obsidian' },
  shots: [
    { asset: 1, line: '第一段旁白台词', duration: 12.5, pause_after: 2.5, motion: 'push_in', transition: 'dissolve' },
    { asset: 1, line: '   ', duration: 3, pause_after: 0.5 },
    { asset: 1, line: '第二段旁白台词', duration: 4, pause_after: 0.5 },
    { asset: 1, line: '第三段旁白台词' },
  ],
};

/* 流式 SSE 桩：director 自 2026-10-18 走流式调用（resp.body.getReader + data: 行），
   非流式 { json } 形状会在「LLM 响应无可读流」处直接抛错——本桩与 callDirectorLLM 同口径。 */
function sseStub(contentObj) {
  const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(contentObj) } }] })}\n\n`;
  const chunk = new TextEncoder().encode(payload);
  let sent = false;
  return {
    ok: true,
    body: {
      getReader() {
        return {
          read() {
            if (sent) return Promise.resolve({ done: true, value: undefined });
            sent = true;
            return Promise.resolve({ done: false, value: chunk });
          },
        };
      },
    },
  };
}

const origFetch = global.fetch;
global.fetch = async () => sseStub(LLM_VIDEO_CUT);
try {
  // 视频场景：多段 shots 全 asset=1 不同 line → 全部保留、顺序不变、空段丢弃
  const vCut = await generateDirectorCut({ scene: 'sell', title: '测试商品标题', sellingPoints: '卖点', imageCount: 1, voice: '', decidedVariant: '', videoMeta: { durationSec: 27.5 } });
  assert('视频分支多段旁白全保留（空段丢弃后 3 段）', vCut.shots.length === 3, `len=${vCut.shots.length}`);
  assert('视频分支旁白顺序与文本不丢失', vCut.shots.map((s) => s.line).join('|') === '第一段旁白台词|第二段旁白台词|第三段旁白台词', vCut.shots.map((s) => s.line).join('|'));
  assert('视频分支 asset 恒 1（不触发素材去重）', vCut.shots.every((s) => s.asset === 1), JSON.stringify(vCut.shots.map((s) => s.asset)));
  assert('视频分支 duration 不套用图片 8s 上限（12.5 保留）', vCut.shots[0].duration === 12.5, `dur=${vCut.shots[0].duration}`);
  assert('视频分支 pause_after 钳位到 1.5 上限', vCut.shots[0].pause_after === 1.5, `pause=${vCut.shots[0].pause_after}`);
  assert('视频分支缺省 duration 归 0（交合成层按 TTS 实测校正）', vCut.shots[2].duration === 0, `dur=${vCut.shots[2].duration}`);
  assert('视频分支 LLM 未指定时采信 voice_gender=female', vCut.voice_gender === 'female', vCut.voice_gender);

  // 配音性别硬约束：用户指定 male 时 LLM 判定不得改判
  const vCutMale = await generateDirectorCut({ scene: 'sell', title: '测试商品标题', sellingPoints: '卖点', imageCount: 1, voice: 'male', decidedVariant: '', videoMeta: { durationSec: 27.5 } });
  assert('视频分支用户指定男声为硬约束（跟随 male）', vCutMale.voice_gender === 'male', vCutMale.voice_gender);

  // 收束旁白合规擦除：LLM 编造联络方式时 sanitize 整条清空（end_line 会被 TTS 念出来）
  global.fetch = async () => sseStub({ ...LLM_VIDEO_CUT, end_line: '喜欢就加微信 jansee_vip 联系我们' });
  const vCutScrub = await generateDirectorCut({ scene: 'sell', title: '测试商品标题', sellingPoints: '卖点', imageCount: 1, voice: '', decidedVariant: '', videoMeta: { durationSec: 27.5 } });
  global.fetch = async () => sseStub(LLM_VIDEO_CUT); // 还原默认桩，避免影响后续用例

  // 结尾收束（文本字段）：归一保留 + 合规擦除
  assert('视频分支 end_line 收束旁白归一保留', vCut.end_line === '看完记得点个关注', vCut.end_line);
  assert('视频分支 end_line 命中微信号整条擦除', vCutScrub.end_line === '', vCutScrub.end_line);

  // 个人场景门控：生活记录不收束旁白（片尾结尾卡仍按场景自动装配，见 video-dub 模块）
  const vCutPersonal = await generateDirectorCut({ scene: 'personal', title: '生活记录', sellingPoints: '卖点', imageCount: 1, voice: '', decidedVariant: '', videoMeta: { durationSec: 27.5 } });
  assert('个人场景 end_line 门控清空', vCutPersonal.end_line === '', JSON.stringify({ l: vCutPersonal.end_line }));

  // 程序兜底剧本：视频分支同样产出收束旁白（LLM 全挂时链路不缺收尾；画面收束由合成模块装配）
  const fbCut = generateConstitutionScript('sell', '', '测试商品', '卖点甲。卖点乙。', 1, 'female', { durationSec: 27.5 });
  assert('兜底剧本视频分支产出收束旁白', fbCut.end_line !== '', JSON.stringify({ l: fbCut.end_line }));
  assert('兜底剧本收束不再混在 shots 里（原 CTA 句已迁入 end_line）', !fbCut.shots.some((s) => s.line.includes('点个关注')), fbCut.shots.map((s) => s.line).join('|'));
  const fbPersonal = generateConstitutionScript('personal', '', '生活记录', '日常片段', 1, 'female', { durationSec: 27.5 });
  assert('兜底剧本个人场景无收束', fbPersonal.end_line === '', JSON.stringify({ l: fbPersonal.end_line }));

  // 图片场景回归：同 LLM payload 不带 videoMeta → 素材去重既有行为（多段 asset=1 只留首现 1 镜）
  const iCut = await generateDirectorCut({ scene: 'sell', title: '测试商品标题', sellingPoints: '卖点', imageCount: 1, voice: '', decidedVariant: '' });
  assert('图片分支素材去重行为不变（1 图 = 1 镜）', iCut.shots.length === 1 && iCut.shots[0].asset === 1, `len=${iCut.shots.length}`);
  // 重桩 LLM：3 段 shots 且 asset 顺序 3/1/3（重复）→ 图片分支按首现去重 + 缺失补位
  global.fetch = async () => sseStub({ ...LLM_VIDEO_CUT, shots: [
    { asset: 3, line: 'a', duration: 3, pause_after: 0.5 },
    { asset: 1, line: 'b', duration: 3, pause_after: 0.5 },
    { asset: 3, line: 'c', duration: 3, pause_after: 0.5 },
  ] });
  const iCut6 = await generateDirectorCut({ scene: 'sell', title: '测试商品标题', sellingPoints: '卖点', imageCount: 6, voice: '', decidedVariant: '' });
  assert('图片分支重复 asset 只保留首次出现（去重不回归）', iCut6.shots.map((s) => s.asset).join(',') === '3,1,2,4,5,6', iCut6.shots.map((s) => s.asset).join(','));
} finally {
  global.fetch = origFetch;
}

// ===== Part 3 mocker 视频兜底单测 =====
const mSell = generateConstitutionScript('sell', 'dub', '测试商品', '卖点甲。卖点乙，卖点丙。', 1, 'male', { durationSec: 20 });
// 收束旁白已从 shots 迁入 end_line（2026-10-24 片尾收束）：Hook + 3 卖点句 = 4 段；
// 片尾画面收束（V4 结尾卡）由 @jansee/video-dub 按 seed 自动装配，兜底剧本不碰画面字段。
assert('mocker 视频兜底多段旁白（4 段 + 收束字段）', mSell.shots.length === 4, `len=${mSell.shots.length}`);
assert('mocker 视频兜底全段 asset=1 且 line 非空', mSell.shots.every((s) => s.asset === 1 && s.line), JSON.stringify(mSell.shots.map((s) => [s.asset, !!s.line])));
assert('mocker 视频兜底配音性别跟随用户指定 male', mSell.voice_gender === 'male', mSell.voice_gender);
assert('mocker 视频兜底 sell 变体非空', !!mSell.variant_type, mSell.variant_type);
assert('mocker 视频兜底收束旁白就位（sell）', mSell.end_line !== '', JSON.stringify({ l: mSell.end_line }));
const mPersonal = generateConstitutionScript('personal', 'dub', '测试商品', '描述', 1, 'female', { durationSec: 15 });
assert('mocker 视频兜底 personal variant_type 空串（契约 §4）', mPersonal.variant_type === '', mPersonal.variant_type);
assert('mocker 视频兜底 personal 无收束（门控）', mPersonal.end_line === '', JSON.stringify({ l: mPersonal.end_line }));
const mFemale = generateConstitutionScript('sell', 'dub', '测试商品', '描述', 1, 'female', { durationSec: 15 });
assert('mocker 视频兜底配音性别跟随 female', mFemale.voice_gender === 'female', mFemale.voice_gender);
const mImage = generateConstitutionScript('sell', 'product', '测试商品', '卖点甲。卖点乙。', 1, 'male');
assert('mocker 图片模式行为不变（1 图 1 镜）', mImage.shots.length === 1 && mImage.shots[0].asset === 1, `len=${mImage.shots.length}`);

// ===== Part 4 图片场景 prompt 零回归（先于端到端执行；主进程已隔离种子账本，与基线逐字节一致） =====
const { buildDirectorPrompt } = await import('../../director.mjs');
for (const [scene, variant] of [['sell', 'A-痛点直击型'], ['local', 'B-宝藏发现型'], ['personal', '']]) {
  const cur = buildDirectorPrompt({
    scene, title: '测试商品标题六个字',
    sellingPoints: '这是一段用户输入的卖点描述文案用于统计',
    imageCount: 6, voice: '', decidedVariant: variant,
  });
  const baseline = fs.readFileSync(new URL(`./baseline/${scene}.txt`, import.meta.url), 'utf8');
  assert(`图片场景 prompt 零回归 ${scene}（与隔离账本基线逐字节一致）`, cur === baseline);
}

// ===== Part 5 端到端接线测试（网关子进程 + TTS 桩 loader，零付费） =====
const producedTaskIds = []; // 收集测试任务 ID，供结束后清理任务产物目录
function spawnGateway(port, extraEnv = [], withStub = true) {
  const args = withStub ? ['--import', './apps/web/server/tests/video-dub/stage-b-tts-stub-setup.mjs', 'apps/web/server/index.mjs'] : ['apps/web/server/index.mjs'];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), JIANXI_MOCK: '1', JX_DATA_DIR: TEST_DATA_DIR, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  child.on('error', (e) => logs.push(`[spawn error] ${e.message}`));
  return { child, logs };
}

async function waitForGateway(base) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${base}/api/v1/health`);
      if (r.ok) return true;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function uploadVia(base, fp, name) {
  const buf = fs.readFileSync(fp);
  return fetch(`${base}/api/v1/upload/video`, {
    method: 'POST',
    headers: { 'content-type': 'video/mp4', 'x-file-name': name },
    body: buf,
  }).then(async (resp) => ({ status: resp.status, json: await resp.json() }));
}

// 统一创作任务中心入口（旧 /api/v1/video/produce 已于模块化升级中下线，返回 410）
async function createVia(base, payload) {
  const resp = await fetch(`${base}/api/v1/creation/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'video_dub', ...payload }),
  });
  return { status: resp.status, json: await resp.json() };
}

async function pollTask(base, taskId, timeoutMs = 150000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 800));
    try {
      const r = await fetch(`${base}/api/v1/creation/task/${taskId}`);
      const j = await r.json();
      if (j?.data?.status === 'completed' || j?.data?.status === 'failed') return j.data;
    } catch (e) {}
  }
  return { status: 'timeout' };
}

// ffmpeg -i 解析流结构（视频/音频流数、画幅）
function streamsOf(file) {
  let out = '';
  try {
    execFileSync(ffmpegStatic, ['-nostdin', '-i', file], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    out = e?.stderr || '';
  }
  const lines = out.split('\n').filter((l) => l.includes('Stream #'));
  return {
    video: lines.filter((l) => l.includes('Video:')).length,
    audio: lines.filter((l) => l.includes('Audio:')).length,
    raw: lines.join(' | '),
  };
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
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e) }));
    req.end('x');
  });
}

const DUB_PAYLOAD_BASE = {
  scene: 'sell', mode: 'dub', title: '测试商品', sellingPoints: '卖点甲。卖点乙，卖点丙。', voice: 'female',
};

// ---- 子进程 A1：STUB_TTS_MODE=long（配音 ≈15s 超长 → trim + 淡出）----
{
  const port = 3212;
  const base = `http://127.0.0.1:${port}`;
  const { child, logs } = spawnGateway(port, { STUB_TTS_MODE: 'long' });
  try {
    const up = await waitForGateway(base);
    assert('A1 网关启动健康（TTS 桩 loader + mocker 模式）', up, logs.slice(-6).join(' || ').slice(0, 400));

    // 超限上传：伪造 Content-Length 201MB → 413（不真实传输大文件）
    const os = await rawOversizeUpload(port);
    assert('200MB 超限上传返回 413（可控伪造头测试）', os.status === 413, `status=${os.status} body=${os.body.slice(0, 120)}`);

    // E1 有声视频端到端：mocker 多段旁白 → 桩 TTS（≈15s 超长）→ 原音排除 → trim 淡出 → 片尾收束卡尾段
    const up1 = await uploadVia(base, path.join(tmp, 'voiced.mp4'), 'voiced.mp4');
    assert('E1 有声视频上传成功', up1.status === 200 && !!up1.json?.data?.videoPath, JSON.stringify(up1.json?.msg || up1.status));
    assert('E1 上传返回素材 ID（materialIds 链路）', !!up1.json?.data?.materialId, JSON.stringify(up1.json?.data || {}));
    const p1 = await createVia(base, { ...DUB_PAYLOAD_BASE, materialIds: [up1.json.data.materialId] });
    if (p1.json?.data?.taskId) producedTaskIds.push(p1.json.data.taskId);
    assert('E1 create 接受视频任务（200 + taskId）', p1.status === 200 && !!p1.json?.data?.taskId, JSON.stringify(p1.json?.msg || p1.status));
    const t1 = await pollTask(base, p1.json?.data?.taskId);
    assert('E1 任务 completed（mocker 兜底链路端到端成功）', t1.status === 'completed', `status=${t1.status} err=${JSON.stringify(t1.error || '')} log=${logs.slice(-4).join('||').slice(0, 300)}`);
    assert('E1 成片时长 ≈ 8.95s（配音超长 trim 至 源视频 6s + 片尾收束卡 2.95s）', Number(t1.outputs?.duration) > 8.3 && Number(t1.outputs?.duration) < 9.6, `duration=${t1.outputs?.duration}`);
    const final1 = path.join(OUTPUTS, p1.json.data.taskId, 'final.mp4');
    const st1 = fs.existsSync(final1) ? fs.statSync(final1) : null;
    assert('E1 final.mp4 落盘且非空', !!st1 && st1.size > 0, st1 ? String(st1.size) : '不存在');
    const s1 = streamsOf(final1);
    assert('E1 原音轨被排除：成片仅 1 视频流 + 1 音频流（源含 1 音轨）', s1.video === 1 && s1.audio === 1, `v=${s1.video} a=${s1.audio} ${s1.raw.slice(0, 160)}`);
    assert('E1 videoUrl 指向任务产物', t1.outputs?.videoUrl === `/storage/outputs/${p1.json.data.taskId}/final.mp4`, t1.outputs?.videoUrl);
  } finally {
    child.kill();
  }
}

// ---- 子进程 A2：STUB_TTS_MODE=short（配音 ≈5s 不足 → 补满 / BGM 垫底）----
{
  const port = 3213;
  const base = `http://127.0.0.1:${port}`;
  const { child, logs } = spawnGateway(port, { STUB_TTS_MODE: 'short' });
  try {
    const up = await waitForGateway(base);
    assert('A2 网关启动健康', up, logs.slice(-6).join(' || ').slice(0, 400));

    // E6 上传后文件被损坏 → 服务端权威时长探测防线 failed。
    // （旧「伪造 videoPath」用例随 materialIds 契约失效：路径白名单已前移到上传登记处，
    //   越界路径根本进不了素材表——该防线由 stage-d 上传契约用例覆盖。）
    const up6 = await uploadVia(base, path.join(tmp, 'voiced.mp4'), 'voiced.mp4');
    fs.writeFileSync(up6.json.data.videoPath, Buffer.from('stageb corrupted after upload'));
    const p6 = await createVia(base, { ...DUB_PAYLOAD_BASE, materialIds: [up6.json.data.materialId] });
    if (p6.json?.data?.taskId) producedTaskIds.push(p6.json.data.taskId);
    const t6 = await pollTask(base, p6.json?.data?.taskId);
    assert('E6 损坏视频任务 failed（服务端权威时长探测，不信前端值）', t6.status === 'failed', `status=${t6.status}`);
    assert('E6 错误可诊断（时长探测失败）', /时长探测失败/.test(String(t6.error?.message || '')), JSON.stringify(t6.error || ''));

    // E2 无声视频端到端：配音不足 → 补满/BGM 垫底，画面时长不变
    const up2 = await uploadVia(base, path.join(tmp, 'silent.mp4'), 'silent.mp4');
    const p2 = await createVia(base, { ...DUB_PAYLOAD_BASE, materialIds: [up2.json.data.materialId] });
    if (p2.json?.data?.taskId) producedTaskIds.push(p2.json.data.taskId);
    const t2 = await pollTask(base, p2.json?.data?.taskId);
    assert('E2 无声视频任务 completed', t2.status === 'completed', `status=${t2.status} err=${JSON.stringify(t2.error || '')}`);
    assert('E2 成片时长 ≈ 8.95s（配音不足补满/BGM 垫底至 源视频+片尾收束卡，不截断画面）', Number(t2.outputs?.duration) > 8.3 && Number(t2.outputs?.duration) < 9.6, `duration=${t2.outputs?.duration}`);
    const final2 = path.join(OUTPUTS, p2.json.data.taskId, 'final.mp4');
    const s2 = streamsOf(final2);
    assert('E2 成片 1 视频流 + 1 音频流', s2.video === 1 && s2.audio === 1, `v=${s2.video} a=${s2.audio} ${s2.raw.slice(0, 160)}`);

    // E2.1 发布方案（增值交付物）：四件套必须随 outputs 到达前端复制卡
    const pub2 = t2.outputs?.publish;
    assert('E2 发布方案四件套齐全（caption/cover_title/pinned_comment/post_time）',
      !!pub2 && typeof pub2.caption === 'string' && pub2.caption.length > 0
      && typeof pub2.cover_title === 'string' && typeof pub2.pinned_comment === 'string'
      && typeof pub2.post_time === 'string',
      JSON.stringify(pub2 || null));
    assert('E2 发布方案无调试字段外泄', !pub2 || !('_banned_hits' in pub2), JSON.stringify(Object.keys(pub2 || {})));
    assert('E2 发布方案无服务器物理路径泄漏', !JSON.stringify(pub2 || {}).includes(':\\') && !JSON.stringify(pub2 || {}).includes('/storage/'), JSON.stringify(pub2));

    // E3 多音轨视频：原双音轨必须全部排除
    const up3 = await uploadVia(base, path.join(tmp, 'multi.mp4'), 'multi.mp4');
    const p3 = await createVia(base, { ...DUB_PAYLOAD_BASE, materialIds: [up3.json.data.materialId] });
    if (p3.json?.data?.taskId) producedTaskIds.push(p3.json.data.taskId);
    const t3 = await pollTask(base, p3.json?.data?.taskId);
    assert('E3 多音轨视频任务 completed', t3.status === 'completed', `status=${t3.status} err=${JSON.stringify(t3.error || '')}`);
    const final3 = path.join(OUTPUTS, p3.json.data.taskId, 'final.mp4');
    const s3 = streamsOf(final3);
    assert('E3 原双音轨全部排除：成片仅 1 音频流', s3.video === 1 && s3.audio === 1, `v=${s3.video} a=${s3.audio} ${s3.raw.slice(0, 160)}`);

    // E4 MOV 容器 + 画幅不强制改变（320x568 竖屏直通）
    const up4 = await uploadVia(base, path.join(tmp, 'voiced.mov'), 'voiced.mov');
    assert('E4 MOV 上传成功', up4.status === 200, JSON.stringify(up4.json?.msg || up4.status));
    const p4 = await createVia(base, { ...DUB_PAYLOAD_BASE, materialIds: [up4.json.data.materialId] });
    if (p4.json?.data?.taskId) producedTaskIds.push(p4.json.data.taskId);
    const t4 = await pollTask(base, p4.json?.data?.taskId);
    assert('E4 MOV 任务 completed', t4.status === 'completed', `status=${t4.status} err=${JSON.stringify(t4.error || '')}`);
    const final4 = path.join(OUTPUTS, p4.json.data.taskId, 'final.mp4');
    const s4 = streamsOf(final4);
    assert('E4 画幅保持源竖屏 320x568（不强制改画幅）', s4.raw.includes('320x568') && s4.video === 1 && s4.audio === 1, s4.raw.slice(0, 200));
  } finally {
    child.kill();
  }
}

// ---- 子进程 B：无桩（真实 TTS 供应商链）+ 无可用供应商 → TTS 失败任务 failed ----
// 收敛定版（2026-10-24）后唯一供应商=腾讯云，失败注入改为配坏腾讯密钥（签名必然失败）。
{
  const port = 3214;
  const base = `http://127.0.0.1:${port}`;
  const { child, logs } = spawnGateway(port, { JX_TTS_TENCENT_SECRET_ID: 'dummy-invalid-secret-id', JX_TTS_TENCENT_SECRET_KEY: 'dummy-invalid-key' }, false);
  try {
    const up = await waitForGateway(base);
    assert('B 网关启动健康（无桩模式）', up, logs.slice(-6).join(' || ').slice(0, 400));
    const up5 = await uploadVia(base, path.join(tmp, 'voiced.mp4'), 'voiced.mp4');
    const p5 = await createVia(base, { ...DUB_PAYLOAD_BASE, materialIds: [up5.json.data.materialId] });
    if (p5.json?.data?.taskId) producedTaskIds.push(p5.json.data.taskId);
    const t5 = await pollTask(base, p5.json?.data?.taskId);
    assert('E5 TTS 不可用时任务 failed（绝不伪造成功）', t5.status === 'failed', `status=${t5.status}`);
    assert('E5 TTS 失败错误可诊断', /TTS|配音/.test(String(t5.error?.message || '')), JSON.stringify(t5.error || ''));
    const final5 = path.join(OUTPUTS, p5.json?.data?.taskId || 'none', 'final.mp4');
    assert('E5 失败任务无成片产物落盘', !fs.existsSync(final5), final5);
  } finally {
    child.kill();
  }
}

// ===== 测试产物清理（任务目录 / 素材 / 隔离数据目录） =====
try {
  for (const id of producedTaskIds) fs.rmSync(path.join(OUTPUTS, id), { recursive: true, force: true });
  fs.rmSync(path.resolve('scratch/stage-b-materials'), { recursive: true, force: true });
  fs.rmSync(path.resolve('scratch/stage-b-data'), { recursive: true, force: true });
  fs.rmSync(path.resolve('scratch/prompt-baseline-data'), { recursive: true, force: true });
  console.log('[Cleanup] 测试产物清理完成（真实业务账本全程未触碰）');
} catch (e) {
  console.warn('[Cleanup] 清理异常（不影响测试结论）:', e.message);
}

console.log(`\n========== 结果：${PASS.length} PASS / ${FAIL.length} FAIL ==========`);
process.exit(FAIL.length ? 1 : 0);
