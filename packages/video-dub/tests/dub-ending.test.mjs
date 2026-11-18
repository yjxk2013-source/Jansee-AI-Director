/**
 * 视频配音 · 片尾收束卡接线测试（2026-10-24 复用图片成片方案后重写）
 *
 * 旧版测的是 scrubCtaText/planCtaCue（自造字幕条方案，已随 end_cta 一并删除）。
 * 现在收束 = @jansee/ending-kit 的 15 款 CTA 卡，本测试只测 video-dub 侧的接线：
 *   ① seed 确定性（同 taskId 同款，用户改错字重出不换结尾）
 *   ② 场景归一（online/offline/... → sell/local/personal）
 *   ③ 结尾卡适配用户画幅（contain + 黑边，横屏视频不拉伸）
 *   ④ composeDubTrack 端到端：源视频完整 + 尾段（黑停 + CTA），时长精确可验
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import {
  ENDING_ASSETS,
  ENDING_TAIL,
  endingsForScene,
  pickEndingForTask,
  renderEndingPng,
  sceneForEngine,
} from '@jansee/ending-kit';
import { probeDurationSec, probeVideoSize } from '@jansee/ffmpeg-kit/probe.mjs';
import { composeDubTrack, fitEndingCard } from '../dubKernel.js';

const TAIL_SEC = ENDING_TAIL.endHoldSec + ENDING_TAIL.ctaSec; // 2.95

function ff(args) {
  const r = spawnSync(ffmpegStatic, args, { encoding: 'utf8' });
  assert.equal(r.status, 0, `ffmpeg 失败: ${String(r.stderr || '').slice(-300)}`);
  return r;
}

/* 2 秒 320×240 横屏小视频（横屏专门验证 CTA 卡 contain 适配，不拉伸不变形） */
function makeVideo(dir) {
  const file = path.join(dir, 'src.mp4');
  ff([
    '-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=320x240:d=2:r=30',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    '-c:a', 'aac', '-shortest', file,
  ]);
  return file;
}

/* mkdtempSync 会在前缀末尾自动加随机后缀——直接返回它创建的目录 */
function tmpdir(name) {
  return mkdtempSync(path.join(os.tmpdir(), `video-dub-test-${name}-`));
}

test('pickEndingForTask：同 taskId 同款（改错字重出不换结尾）', () => {
  for (let i = 0; i < 20; i += 1) {
    const id = `task-${i}`;
    assert.equal(pickEndingForTask(id, { scene: 'sell' }).id, pickEndingForTask(id, { scene: 'sell' }).id, id);
  }
  /* endingId 直指优先于 seed */
  assert.equal(pickEndingForTask('whatever', { endingId: 'cta_s3_typo' }).id, 'cta_s3_typo');
});

test('pickEndingForTask：按场景池抽（personal 生活记录不出商业 CTA）', () => {
  for (let i = 0; i < 30; i += 1) {
    const e = pickEndingForTask(`t-${i}`, { scene: 'personal' });
    assert.ok(endingsForScene('personal').includes(e), `personal 抽出 ${e.id}`);
  }
});

test('sceneForEngine：入口词表归一到引擎三态，越界回落 sell', () => {
  assert.equal(sceneForEngine('online'), 'sell');
  assert.equal(sceneForEngine('offline'), 'local');
  assert.equal(sceneForEngine('personal'), 'personal');
  assert.equal(sceneForEngine('sell'), 'sell');
  assert.equal(sceneForEngine('local'), 'local');
  assert.equal(sceneForEngine(''), 'sell');
  assert.equal(sceneForEngine(undefined), 'sell');
  assert.equal(sceneForEngine('weird'), 'sell');
});

test('probeVideoSize：解析真实视频宽高（320×240）', () => {
  const dir = tmpdir('probe');
  try {
    const video = makeVideo(dir);
    assert.deepEqual(probeVideoSize(video), { width: 320, height: 240 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fitEndingCard：竖卡 contain 进横屏（320×240 不拉伸，两侧黑边）', async () => {
  const dir = tmpdir('fit');
  try {
    const video = makeVideo(dir);
    const size = probeVideoSize(video);
    const png = renderEndingPng({ ending: ENDING_ASSETS[0], outPath: path.join(dir, 'ending.png') });
    const fit = await fitEndingCard(dir, png, size);
    assert.ok(existsSync(fit), '适配卡应产出');
    assert.deepEqual(probeVideoSize(fit), { width: 320, height: 240 }, '必须与视频同尺寸');
    /* 尺寸不可用时不出卡（返回 null），不烧一张错位卡 */
    assert.equal(await fitEndingCard(dir, png, null), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('composeDubTrack：无结尾卡时成片 = 源视频时长', async () => {
  const dir = tmpdir('mux-plain');
  try {
    const video = makeVideo(dir);
    const taskDir = path.join(dir, 'out');
    mkdirSync(taskDir, { recursive: true });
    const { output, durationSec } = await composeDubTrack({
      taskDir, videoFile: video, audioFile: video, cues: [],
    });
    assert.ok(existsSync(output));
    assert.ok(Math.abs(durationSec - 2) < 0.15, `时长应≈2s，实际 ${durationSec}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('composeDubTrack：有结尾卡时成片 = 源视频 + 尾段（黑停 + CTA）', async () => {
  const dir = tmpdir('mux-cta');
  try {
    const video = makeVideo(dir);
    const taskDir = path.join(dir, 'out');
    mkdirSync(taskDir, { recursive: true });
    const size = probeVideoSize(video);
    const png = renderEndingPng({ ending: ENDING_ASSETS[5], brandZh: '测试品牌', outPath: path.join(taskDir, 'ending.png') });
    const ctaFile = await fitEndingCard(taskDir, png, size);
    const { output, durationSec } = await composeDubTrack({
      taskDir, videoFile: video, audioFile: video, cues: [], ctaFile,
    });
    assert.ok(existsSync(output));
    const expect = 2 + TAIL_SEC;
    assert.ok(
      Math.abs(durationSec - expect) < 0.2,
      `时长应≈${expect.toFixed(2)}s（源 2s + 黑停 ${ENDING_TAIL.endHoldSec} + CTA ${ENDING_TAIL.ctaSec}），实际 ${durationSec}`,
    );
    /* 源视频本体不被截断：尾段起点前画面仍在（转正文件比源长，且大于源时长） */
    assert.ok(durationSec > probeDurationSec(video));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
