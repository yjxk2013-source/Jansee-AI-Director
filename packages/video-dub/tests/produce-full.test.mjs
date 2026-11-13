import '../../../apps/web/server/env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { produceVideoDub } from '../index.js';

function ff(args) {
  const r = spawnSync(ffmpegStatic, args, { encoding: 'utf8' });
  assert.equal(r.status, 0, `ffmpeg 失败: ${String(r.stderr || '').slice(-300)}`);
  return r;
}

function makeVideo(dir) {
  const file = path.join(dir, 'src.mp4');
  ff([
    '-y', '-f', 'lavfi', '-i', 'color=c=0x182030:s=320x240:d=4:r=30',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    '-c:a', 'aac', '-shortest', file,
  ]);
  return file;
}

test('produceVideoDub: 全链路生成 intro.png 开场花字与片尾收束卡', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dub-full-test-'));
  try {
    const video = makeVideo(tmp);
    const taskDir = path.join(tmp, 'out');
    mkdirSync(taskDir, { recursive: true });

    const cut = {
      title: '极品武夷岩茶',
      site: 'WUYI MOUNTAIN TEA',
      shots: [{ line: '这是一杯先苦后甘的岩茶' }],
      bgm_on: false,
    };

    const res = await produceVideoDub({
      taskId: 'test-full-intro',
      taskDir,
      videoFile: video,
      cut,
      voiceId: 'f-warm',
      scene: 'sell',
    });

    assert.ok(existsSync(res.outputPath), '成片必须存在');
    const introFile = path.join(taskDir, 'dub_work', 'intro.png');
    assert.ok(existsSync(introFile), 'intro.png 必须成功生成在 dub_work 目录下');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
