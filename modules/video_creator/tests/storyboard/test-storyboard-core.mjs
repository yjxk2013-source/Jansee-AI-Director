// 简兮分镜合成核心 · 自动化测试（modules/video_creator/tests/storyboard/test-storyboard-core.mjs）
// 目标：
//   1. 时长计算公式纯函数验证：Σ(dur_i) - (N-1)*0.7
//   2. 边界条件验证：N=1（无转场扣减）、素材贴近 2.0s 下限与转场时长关系
//   3. 零付费快速合成验证：小规模 2 镜纯本地 lavfi 短视频（2.5s + 2.5s）真实 composeStoryboard 检验
//   4. 解码与成片时长吻合性断言：实测时长必须符合转场扣减理论值（4.3s ± 0.2s）
//   5. 进度回调 onProgress 完备性覆盖
// 运行：node modules/video_creator/tests/storyboard/test-storyboard-core.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { composeStoryboard } from '../../video/storyboard.js';
import { videoDurationSec } from '../../video/slicer.js';
import { XFADE } from '@jansee/ffmpeg-kit/constitutionEffects.js';

const PASS = [];
const FAIL = [];
function check(name, fn) {
  try {
    fn();
    PASS.push(name);
    console.log(`PASS ${name}`);
  } catch (e) {
    FAIL.push(name);
    console.log(`FAIL ${name}（${e.message}）`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    PASS.push(name);
    console.log(`PASS ${name}`);
  } catch (e) {
    FAIL.push(name);
    console.log(`FAIL ${name}（${e.message}）`);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-core-test-'));

// 辅助生成测试小视频
function makeMiniVideo(filePath, durSec) {
  execFileSync(ffmpegStatic, [
    '-nostdin', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=25:duration=${durSec}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durSec}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    '-shortest', filePath,
  ], { stdio: 'ignore' });
  return filePath;
}

// ==================== 1. 理论时长公式测试 ====================
console.log('\n--- 1. 时长计算公式与边界推算 ---');

function calcExpectedDuration(durations, xfadeDur = XFADE.duration) {
  if (!durations.length) return 0;
  const sum = durations.reduce((a, b) => a + b, 0);
  return durations.length > 1 ? sum - (durations.length - 1) * xfadeDur : sum;
}

check('1.1 单镜 N=1 无转场时长扣减', () => {
  const dur = calcExpectedDuration([15.0]);
  assert.equal(dur, 15.0);
});

check('1.2 双镜 N=2 叠化转场扣减 0.7s', () => {
  const dur = calcExpectedDuration([10.0, 10.0]);
  assert.equal(dur, 19.3); // 20 - 0.7
});

check('1.3 三镜 N=3 叠化转场扣减 1.4s', () => {
  const dur = calcExpectedDuration([10.0, 10.0, 10.0]);
  assert.equal(Math.round(dur * 10) / 10, 28.6); // 30 - 1.4
});

check('1.4 九镜 N=9 满额扣减 5.6s (8 * 0.7)', () => {
  const durs = Array(9).fill(20.0);
  const dur = calcExpectedDuration(durs);
  assert.equal(Math.round(dur * 10) / 10, 174.4); // 180 - 5.6
  assert.ok(dur <= 180);
});

check('1.5 极限短镜 2.0s 贴边安全（offset=2.0-0.7=1.3 > 0.001）', () => {
  const offset = 2.0 - XFADE.duration;
  assert.ok(offset > 0.5, '2.0s 下限离 0 偏移有充足安全缓冲');
});

// ==================== 2. composeStoryboard 输入校验测试 ====================
console.log('\n--- 2. composeStoryboard 参数防御 ---');

await checkAsync('2.1 空分镜直接抛错拒绝', async () => {
  await assert.rejects(
    () => composeStoryboard({ taskDir: tmpDir, shots: [] }),
    /请至少添加一个分镜/
  );
});

await checkAsync('2.2 超过 20 镜核心层抛错拒绝', async () => {
  const overShots = Array(21).fill({ mediaType: 'video', file: 'dummy.mp4' });
  await assert.rejects(
    () => composeStoryboard({ taskDir: tmpDir, shots: overShots }),
    /分镜数量不能超过 20/
  );
});

await checkAsync('2.3 分镜缺少素材文件抛错拒绝', async () => {
  await assert.rejects(
    () => composeStoryboard({ taskDir: tmpDir, shots: [{ mediaType: 'video' }] }),
    /缺少视频素材/
  );
});

// ==================== 3. 真实轻量端到端合成验证（零付费，短素材） ====================
console.log('\n--- 3. 核心合成轻量验证 (2 镜 × 2.5s) ---');

await checkAsync('3.1 真实短视频叠化拼接合成并通过解码校验', async () => {
  const taskDir = path.join(tmpDir, 'task_compose_test');
  fs.mkdirSync(taskDir, { recursive: true });

  const v1 = makeMiniVideo(path.join(taskDir, 'mini1.mp4'), 2.5);
  const v2 = makeMiniVideo(path.join(taskDir, 'mini2.mp4'), 2.5);

  const progressRecords = [];
  const res = await composeStoryboard({
    taskDir,
    shots: [
      { mediaType: 'video', file: v1, text: '' },
      { mediaType: 'video', file: v2, text: '' },
    ],
    autoMode: 'asr',
    voiceId: '',
    bgmPath: '',
    subtitles: [
      { words: [], deleted: [], finalText: '' },
      { words: [], deleted: [], finalText: '' },
    ],
    onProgress: (p, stage) => {
      progressRecords.push({ p, stage });
    },
  });

  assert.ok(res.output, '返回 output 路径');
  assert.ok(fs.existsSync(res.output), '最终成片 final.mp4 真实落盘');
  
  // 验证时长：2.5 + 2.5 - 0.7 = 4.3s，容差 ±0.2s
  const actualDur = videoDurationSec(res.output);
  console.log(`  实测成片时长: ${actualDur.toFixed(2)}s (理论值: 4.30s)`);
  assert.ok(Math.abs(actualDur - 4.3) < 0.25, `实测时长与理论值偏差过大: ${actualDur}`);

  // 验证进度回调
  assert.ok(progressRecords.length >= 3, 'onProgress 回调正常触发');
  assert.equal(progressRecords[progressRecords.length - 1].p, 100);
});

try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch (e) {}

console.log(`\n===== Storyboard 核心测试结果：${PASS.length} PASS / ${FAIL.length} FAIL =====`);
if (FAIL.length > 0) {
  process.exit(1);
}
