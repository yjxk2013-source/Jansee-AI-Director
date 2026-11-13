// 配音烧录器：视频 + 台词脚本（配音 mp3 + 字幕）+ BGM → 解说成片
// 用法：node dub.mjs <视频路径> [脚本路径]
// 字幕按段烧录（底部居中，半透明黑底），配音按 start 精确对齐，BGM 自动循环并结尾淡出。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FFMPEG = path.join(ROOT, 'node_modules/ffmpeg-static/ffmpeg.exe');
const OUT_DIR = path.resolve(HERE, '../素材/成片');

const video = process.argv[2];
const scriptPath = process.argv[3] || path.join(HERE, '../素材/台词/脚本.json');
if (!video || !fs.existsSync(video)) {
  console.error('用法：node dub.mjs <视频路径> [脚本路径]');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const segs = cfg.segments;
const voicesDir = path.join(path.dirname(scriptPath), 'voices');
for (const s of segs) {
  if (!fs.existsSync(path.join(voicesDir, `${s.id}.mp3`))) {
    console.error(`[错误] 缺配音 ${s.id}，先跑 gen-voice.mjs`);
    process.exit(1);
  }
}

// 探测视频时长与高度（字号按高度自适应）
const probe = spawnSync(FFMPEG, ['-i', video], { stdio: ['ignore', 'ignore', 'pipe'] });
const ps = String(probe.stderr);
const durMatch = ps.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
const hMatch = ps.match(/, (\d+)x(\d+)[, ]/);
if (!durMatch || !hMatch) {
  console.error('[错误] 读不出视频时长/分辨率');
  process.exit(1);
}
const totalSec = +durMatch[1] * 3600 + +durMatch[2] * 60 + +durMatch[3];
const height = +hMatch[2];
const fontSize = Math.round(height / 25); // 1080p → 43px
const marginB = Math.round(height / 17);

// 字幕 textfile（UTF-8），供 drawtext 引用
const subsDir = path.join(path.dirname(scriptPath), 'subs');
fs.mkdirSync(subsDir, { recursive: true });

const fc = [];
const inputs = ['-i', video];
segs.forEach((s, i) => {
  inputs.push('-i', path.join(voicesDir, `${s.id}.mp3`));
  const ms = Math.round(s.start * 1000);
  fc.push(`[${i + 1}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${ms}|${ms}[a${i}]`);
});
// BGM 循环铺底 + 结尾淡出
const bgmIdx = segs.length + 1;
inputs.push('-stream_loop', '-1', '-i', cfg.bgm);
fc.push(`[${bgmIdx}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${cfg.bgmVolume},afade=t=out:st=${Math.max(0, totalSec - 3)}:d=3[abgm]`);

const mixInputs = segs.map((_, i) => `[a${i}]`).join('') + '[abgm]';
fc.push(`${mixInputs}amix=inputs=${segs.length + 1}:normalize=0:duration=longest[aout]`);

// 逐段烧字幕（-vf 简单滤镜链，作用于映射出的视频流）
const vf = [];
segs.forEach((s, i) => {
  const sub = path.join(subsDir, `${s.id}.txt`);
  fs.writeFileSync(sub, s.text, 'utf8');
  const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  vf.push(
    `drawtext=fontfile='C\\:/Windows/Fonts/msyh.ttc':textfile='${esc(sub)}'` +
    `:fontsize=${fontSize}:fontcolor=white:borderw=3:bordercolor=black@0.85` +
    `:box=1:boxcolor=black@0.45:boxborderw=16:x=(w-text_w)/2:y=h-text_h-${marginB}` +
    `:enable='between(t,${s.start},${s.end})'`
  );
});

fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
const out = path.join(OUT_DIR, `解说成片-${stamp}.mp4`);

console.log(`烧录中：${segs.length} 段配音 + 字幕 + BGM（视频 ${totalSec.toFixed(1)}s）…`);
const r = spawnSync(FFMPEG, [
  ...inputs,
  '-filter_complex', fc.join(';'),
  '-vf', vf.join(','),
  '-map', '0:v', '-map', '[aout]',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k',
  '-t', String(totalSec),
  '-y', out,
], { stdio: ['ignore', 'ignore', 'pipe'] });

if (r.status !== 0) {
  console.error('[错误] 烧录失败：');
  console.error(String(r.stderr).split('\n').slice(-6).join('\n'));
  process.exit(1);
}
console.log(`完成：${out}`);
