// 简兮 · 视频配音阶段 A 零付费回归（上传端点 + 导演 prompt 时长注入 + 图片场景零回归）
// 全程本地：测试素材由 ffmpeg-static 生成，网关起独立子进程实例（随机端口），不触发 LLM/TTS/真实出片。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

const PASS = [];
const FAIL = [];
function assert(name, cond, actual = '') {
  (cond ? PASS : FAIL).push(name);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : `（实际 ${actual}）`}`);
}

// ===== Part 1 本地生成测试素材（0 元） =====
const tmp = path.resolve('scratch/stage-a-materials');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const ff = (args) => execFileSync(ffmpegStatic, ['-nostdin', '-y', ...args], { stdio: 'ignore', cwd: tmp });
// 无声 6s mp4（竖屏小尺寸降低生成开销）
ff(['-f', 'lavfi', '-i', 'color=c=blue:s=320x568:d=6', '-r', '25', '-pix_fmt', 'yuv420p', 'silent.mp4']);
// 有声 6s mp4（正弦音轨）
ff([
  '-f', 'lavfi', '-i', 'color=c=red:s=320x568:d=6',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-map', '0:v', '-map', '1:a', '-shortest',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'voiced.mp4',
]);
// 多音轨 6s mp4（双 AAC 音轨）
ff([
  '-f', 'lavfi', '-i', 'color=c=green:s=320x568:d=6',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6',
  '-map', '0:v', '-map', '1:a', '-map', '2:a', '-shortest',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'multi.mp4',
]);
// mov 容器 6s
ff([
  '-f', 'lavfi', '-i', 'color=c=yellow:s=320x568:d=6',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-map', '0:v', '-map', '1:a', '-shortest',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mov', 'silent.mov',
]);
// 损坏文件（假 mp4）
fs.writeFileSync(path.join(tmp, 'broken.mp4'), Buffer.from('这不是视频文件，仅用于探测失败拒绝测试'));
// 非法扩展名（假 txt）
fs.writeFileSync(path.join(tmp, 'evil.txt'), Buffer.from('x'));
console.log('[Part1] 测试素材生成完成');

// ===== 隔离账本种子（prompt 基线确定性）：主进程与子网关均指向固定种子，不读真实业务账本 =====
// 每次运行重建 → 运行顺序/已有账本记录/真实业务状态均不影响断言；种子文件可审查可复现。
const SEED_DIR = path.resolve('scratch/prompt-baseline-data');
fs.rmSync(SEED_DIR, { recursive: true, force: true });
fs.mkdirSync(SEED_DIR, { recursive: true });
fs.copyFileSync(path.resolve('apps/web/server/tests/video-dub/baseline/ledger-seed.json'), path.join(SEED_DIR, 'creative_ledger.json'));
process.env.JX_DATA_DIR = SEED_DIR; // 必须先于 director.mjs 动态 import（paths.mjs 顶层读 env）

// ===== Part 2 独立网关实例 + 上传端点断言 =====
const PORT = 3211;
const childLogs = [];
const child = spawn(process.execPath, ['apps/web/server/index.mjs'], {
  cwd: path.resolve('.'),
  env: { ...process.env, PORT: String(PORT), JX_DATA_DIR: SEED_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => childLogs.push(String(d)));
child.stderr.on('data', (d) => childLogs.push(String(d)));
child.on('error', (e) => childLogs.push(`[spawn error] ${e.message}`));
const base = `http://127.0.0.1:${PORT}`;

async function waitForGateway() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${base}/api/v1/health`);
      if (r.ok) return true;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function upload(fp, name) {
  const buf = fs.readFileSync(fp);
  const resp = await fetch(`${base}/api/v1/upload/video`, {
    method: 'POST',
    headers: { 'content-type': 'video/mp4', 'x-file-name': name },
    body: buf,
  });
  return { status: resp.status, json: await resp.json() };
}

try {
  const up = await waitForGateway();
  assert('网关独立实例启动健康', up, childLogs.slice(-8).join(' || ').slice(0, 500));

  // 合法上传：有声 / 无声 / 多音轨 / mov —— 200 + durationSec ≈ 6s
  for (const [file, label] of [['voiced.mp4', '有声'], ['silent.mp4', '无声'], ['multi.mp4', '多音轨'], ['silent.mov', 'mov容器']]) {
    const { status, json } = await upload(path.join(tmp, file), file);
    const d = Number(json?.data?.durationSec);
    assert(`上传${label}视频返回 200`, status === 200, `status=${status}`);
    assert(`上传${label}视频探测时长 ≈ 6s`, d > 5.5 && d < 6.5, `durationSec=${d}`);
    assert(`上传${label}视频返回落盘路径`, typeof json?.data?.videoPath === 'string' && json.data.videoPath.includes('storage') && json.data.videoPath.includes('uploads'), json?.data?.videoPath);
  }

  // 损坏文件 → 400 可诊断错误（不伪造时长）
  const bad = await upload(path.join(tmp, 'broken.mp4'), 'broken.mp4');
  assert('损坏文件返回 400', bad.status === 400, `status=${bad.status}`);
  assert('损坏文件错误可诊断', /无法解析视频真实时长/.test(String(bad.json?.msg)), bad.json?.msg);

  // 非法扩展名 → 400
  const evil = await upload(path.join(tmp, 'evil.txt'), 'evil.txt');
  assert('非法扩展名返回 400', evil.status === 400, `status=${evil.status}`);

  // 存储目录恢复：确认探测失败后已清理无效文件
  const brokenLeftover = fs.existsSync(path.resolve('storage/uploads')) &&
    fs.readdirSync(path.resolve('storage/uploads')).some((d) => {
      const p = path.join('storage/uploads', d);
      return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'video.mp4')) && d.startsWith('upload_') &&
        fs.readFileSync(path.join(p, 'video.mp4')).slice(0, 6).toString().includes('这不是');
    });
  assert('探测失败后无效文件已清理（不残留损坏产物）', !brokenLeftover);
} finally {
  child.kill();
}

// ===== Part 3 导演 prompt 注入断言（纯内存，无网络） =====
const { buildDirectorPrompt } = await import('../../director.mjs');

const vp = buildDirectorPrompt({
  scene: 'sell', title: '测试商品标题六个字',
  sellingPoints: '这是一段用户输入的卖点描述文案用于统计',
  imageCount: 6, voice: '', decidedVariant: 'A-痛点直击型',
  videoMeta: { durationSec: 27.5 },
});
assert('视频素材行替换为实拍视频', vp.includes('用户上传实拍视频 × 1'));
assert('不残留图片素材行描述', !vp.includes('用户上传实拍图 × 6'));
assert('真实时长注入 prompt（27.5 秒）', vp.includes('27.5 秒'));
assert('旁白总时长硬约束注入', vp.includes('旁白总时长硬约束'));
assert('全片旁白规则注入', vp.includes('shots 数组在此场景表示旁白分段'));
assert('禁止照搬图片成片时长假设', vp.includes('严禁照搬图片成片的默认时长假设'));
assert('台词事实红线注入（不虚构画面外事实）', vp.includes('画面未呈现的内容不得描述为已发生'));
assert('画面不可拆改规则注入', vp.includes('画面不可增删、不可重排、不可加速减速'));

// ===== Part 4 图片场景零回归（不传 videoMeta 与 S1 后基线逐字节一致） =====
for (const [scene, variant] of [['sell', 'A-痛点直击型'], ['local', 'B-宝藏发现型'], ['personal', '']]) {
  const cur = buildDirectorPrompt({
    scene, title: '测试商品标题六个字',
    sellingPoints: '这是一段用户输入的卖点描述文案用于统计',
    imageCount: 6, voice: '', decidedVariant: variant,
  });
  const baseline = fs.readFileSync(new URL(`./baseline/${scene}.txt`, import.meta.url), 'utf8');
  assert(`图片场景零回归 ${scene}（与隔离账本基线逐字节一致）`, cur === baseline);
}

console.log(`\n========== 结果：${PASS.length} PASS / ${FAIL.length} FAIL ==========`);
process.exit(FAIL.length ? 1 : 0);
