// @jansee/ending-kit · 通用尾段追加测试（真实 ffmpeg 集成）
// appendEndingTail 是口播 / 分镜直出 / 分镜 AI 配音三条链路的共用收束能力（2026-10-24 全版块标配）：
//   成片 = 源视频完整保留（不截断不加速）+ 结尾淡出 → 黑停一拍 → CTA 卡淡入浮出（追加 2.95s）。
// 失败兜底契约：任何异常返回 null（调用方保持原片交付），绝不抛错、绝不阻断出片。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { probeDurationSec, probeVideoSize, hasAudioStream } from '@jansee/ffmpeg-kit/probe.mjs';
import { appendEndingTail, fitEndingCard } from '../tail.js';
import { ENDING_ASSETS } from '../ending.js';

function ff(args) {
  execFileSync(ffmpegStatic, ['-nostdin', ...args], { stdio: 'ignore' });
}

/* 2 秒 320×240 横屏小视频（横屏验证 CTA 卡 contain 适配不变形） */
function makeVideo(dir, { withAudio = true } = {}) {
  const file = path.join(dir, withAudio ? 'src.mp4' : 'src_mute.mp4');
  const args = ['-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=320x240:d=2:r=30'];
  if (withAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=2');
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast');
  if (withAudio) args.push('-c:a', 'aac', '-shortest');
  args.push(file);
  ff(args);
  return file;
}

function tmpdir(name) {
  return mkdtempSync(path.join(os.tmpdir(), `ending-kit-tail-${name}-`));
}

test('appendEndingTail：成片 = 源视频 + 2.95s 尾段，音轨保留，同 taskId 同款', async () => {
  const dir = tmpdir('basic');
  try {
    const video = makeVideo(dir);
    const out = path.join(dir, 'final_tail.mp4');
    const r = await appendEndingTail({ workDir: dir, videoFile: video, outPath: out, taskId: 't-tail-1', scene: 'local' });
    assert.ok(r, '应成功产出尾段成片');
    assert.equal(r.output, out);
    assert.ok(Math.abs(r.durationSec - 4.95) < 0.25, `时长应≈4.95s（2s + 2.95s 尾段），实际 ${r.durationSec}`);
    assert.ok(hasAudioStream(out), '尾段成片应保留音轨');
    assert.ok(ENDING_ASSETS.some((e) => e.id === r.endingId), `endingId=${r.endingId} 应在场景池内`);
    // 同 taskId 重出同款（确定性 seed 契约）
    const out2 = path.join(dir, 'final_tail2.mp4');
    const r2 = await appendEndingTail({ workDir: dir, videoFile: video, outPath: out2, taskId: 't-tail-1', scene: 'local' });
    assert.equal(r2.endingId, r.endingId, '同 taskId 必须抽同一款结尾卡');
    // 适配卡必须与源视频同尺寸（contain + pad，不变形）
    assert.deepEqual(probeVideoSize(out), { width: 320, height: 240 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendEndingTail：无音轨源片自动垫静音轨（分镜空镜场景）', async () => {
  const dir = tmpdir('mute');
  try {
    const video = makeVideo(dir, { withAudio: false });
    const out = path.join(dir, 'final_tail.mp4');
    const r = await appendEndingTail({ workDir: dir, videoFile: video, outPath: out, taskId: 't-tail-2', scene: 'sell' });
    assert.ok(r, '无声源片也应成功追加尾段');
    assert.ok(hasAudioStream(out), '无音轨源片应垫出静音轨（下游混流/播放器兼容）');
    assert.ok(Math.abs(r.durationSec - 4.95) < 0.25, `时长应≈4.95s，实际 ${r.durationSec}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendEndingTail：源片损坏时恒不抛错，返回 null（原片交付兜底契约）', async () => {
  const dir = tmpdir('broken');
  try {
    const broken = path.join(dir, 'broken.mp4');
    writeFileSync(broken, 'not a video at all');
    const out = path.join(dir, 'final_tail.mp4');
    const r = await appendEndingTail({ workDir: dir, videoFile: broken, outPath: out, taskId: 't-tail-3', scene: 'local' });
    assert.equal(r, null, '失败必须返回 null 而非抛错');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fitEndingCard：尺寸不可用返回 null（不出错位卡）', async () => {
  const dir = tmpdir('fit-null');
  try {
    const png = path.join(dir, 'ending.png');
    ff(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:d=0.04:r=25', '-frames:v', '1', png]);
    assert.equal(await fitEndingCard(dir, png, null), null);
    assert.equal(existsSync(path.join(dir, 'ending_fit.png')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
