import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import ffmpegStatic from 'ffmpeg-static';
import { probeDurationSec } from '../probe.mjs';

function runFfmpeg(args) {
  return execFileSync(ffmpegStatic, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('finalized MP4 has a moov atom, expected duration, and decodes fully', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jansee-mp4-final-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'valid.mp4');

  runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=160x284:r=10:d=1',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-movflags', '+faststart', '-y', file,
  ]);

  assert.ok(fs.statSync(file).size > 1000);
  assert.ok(Number.isFinite(probeDurationSec(file)));
  assert.ok(probeDurationSec(file) >= 0.9);
  assert.doesNotThrow(() => runFfmpeg(['-v', 'error', '-i', file, '-f', 'null', '-']));
});

test('truncated MP4 is not accepted as a finalized deliverable', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jansee-mp4-truncated-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const valid = path.join(dir, 'valid.mp4');
  const truncated = path.join(dir, 'truncated.mp4');

  runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=160x284:r=10:d=1',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', valid,
  ]);
  const bytes = fs.readFileSync(valid);
  fs.writeFileSync(truncated, bytes.subarray(0, Math.max(32, Math.floor(bytes.length / 2))));

  assert.equal(Number.isFinite(probeDurationSec(truncated)), false);
  assert.throws(() => runFfmpeg(['-v', 'error', '-i', truncated, '-f', 'null', '-']));
});
