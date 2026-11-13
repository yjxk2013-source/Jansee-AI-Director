import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { renderEndingPng, ENDING_ASSETS, ENDING_TAIL } from '@jansee/ending-kit';
import { renderIntroPng } from '@jansee/intro-kit';
import { probeDurationSec, probeVideoSize } from '@jansee/ffmpeg-kit/probe.mjs';
import { composeDubTrack, fitEndingCard } from '../dubKernel.js';

function ff(args) {
  const r = spawnSync(ffmpegStatic, args, { encoding: 'utf8' });
  assert.equal(r.status, 0, `ffmpeg 失败: ${String(r.stderr || '').slice(-300)}`);
  return r;
}

function makeVideo(dir) {
  const file = path.join(dir, 'src.mp4');
  ff([
    '-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=320x240:d=4:r=30',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    '-c:a', 'aac', '-shortest', file,
  ]);
  return file;
}

function tmpdir(name) {
  return mkdtempSync(path.join(os.tmpdir(), `dub-intro-e2e-${name}-`));
}

test('composeDubTrack：开场微光花字 + 片尾收束卡全闭环合成', async () => {
  const dir = tmpdir('both');
  try {
    const video = makeVideo(dir);
    const taskDir = path.join(dir, 'out');
    mkdirSync(taskDir, { recursive: true });
    const size = probeVideoSize(video);

    // 1. 生成开场花字 PNG
    const introPng = path.join(taskDir, 'intro.png');
    renderIntroPng({
      title: '高山云雾好茶',
      brandEn: 'JANSEE CINEMATIC DUB',
      width: size.width,
      height: size.height,
      outPath: introPng,
    });

    // 2. 生成结尾收束卡 PNG
    const endingPng = path.join(taskDir, 'ending.png');
    renderEndingPng({
      ending: ENDING_ASSETS[0],
      brandZh: '品牌精选',
      brandEn: 'ORIGINAL CUT',
      outPath: endingPng,
    });
    const ctaFile = await fitEndingCard(taskDir, endingPng, size);

    // 3. 执行端到端混流合成
    const { output, durationSec } = await composeDubTrack({
      taskDir,
      videoFile: video,
      audioFile: video,
      cues: [{ content: '这是一句旁白字幕', audioStart: 0.5, audioEnd: 2.5 }],
      ctaFile,
      introFile: introPng,
    });

    assert.ok(existsSync(output), '输出成片 final.mp4 必须存在');
    const expectDur = 4 + ENDING_TAIL.endHoldSec + ENDING_TAIL.ctaSec;
    assert.ok(
      Math.abs(durationSec - expectDur) < 0.25,
      `最终时长应≈${expectDur.toFixed(2)}s，实际 ${durationSec}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
