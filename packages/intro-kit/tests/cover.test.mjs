import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { composePureCover } from '../index.js';

test('intro-kit: composePureCover 消费静态图片底图合成纯净封面', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'cover-test-'));
  try {
    // 制造一张 1080x1920 测试原图
    const bgImg = path.join(tmp, 'test_bg.jpg');
    await sharp({
      create: {
        width: 1080,
        height: 1920,
        channels: 3,
        background: { r: 180, g: 140, b: 100 },
      },
    })
      .jpeg()
      .toFile(bgImg);

    const coverOut = path.join(tmp, 'cover.jpg');
    const res = await composePureCover({
      bgSource: bgImg,
      title: '高定美学 · 极简质感',
      brandEn: 'JANSEE STUDIO',
      note: '留一席留白 · 慢下来品味生活',
      idx: 'NO. 01 / CINEMATIC DUB',
      outPath: coverOut,
    });

    assert.equal(res.coverPath, coverOut);
    assert.ok(existsSync(coverOut), '封面文件必须已落盘');
    assert.ok(statSync(coverOut).size > 10000, '封面大小应合理大于 10KB');

    const meta = await sharp(coverOut).metadata();
    assert.equal(meta.width, 1080);
    assert.equal(meta.height, 1920);
    assert.equal(meta.format, 'jpeg');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('intro-kit: composePureCover 消费视频素材自动抽纯净帧并压制封面', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'cover-vid-test-'));
  try {
    const vidPath = path.join(tmp, 'test_vid.mp4');
    const { execFileSync } = await import('node:child_process');
    const ffmpegStatic = (await import('ffmpeg-static')).default;
    execFileSync(ffmpegStatic, [
      '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x223344:s=720x1280:d=2:r=25',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      vidPath,
    ]);

    const coverOut = path.join(tmp, 'cover_from_vid.jpg');
    const res = await composePureCover({
      bgSource: vidPath,
      title: '极简空间',
      brandEn: 'MINIMAL ARCHITECTURE',
      note: '呼吸一刻 · 净享安宁',
      outPath: coverOut,
      captureSec: 0.5,
    });

    assert.equal(res.coverPath, coverOut);
    assert.ok(existsSync(coverOut), '封面文件必须已落盘');
    const meta = await sharp(coverOut).metadata();
    assert.equal(meta.width, 720);
    assert.equal(meta.height, 1280);
    assert.equal(meta.format, 'jpeg');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
