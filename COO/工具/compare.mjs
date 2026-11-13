// 两段对比片合成器（"AI 照妖镜"系列）：开场卡 + 片段1 → 叠化 → 片段2 → 叠化 → 结尾卡
// 用法：node compare.mjs <脚本json路径>
// json 结构见 COO/素材/台词/照妖镜.json：clips(2段+start/duration)、intro/outro、xfade、segments(台词+时间)
// 配音 mp3 由 gen-voice.mjs 预生成（voices/段id.mp3）；字幕烧录；BGM 循环+结尾淡出
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FFMPEG = path.join(ROOT, 'node_modules/ffmpeg-static/ffmpeg.exe');
const OUT_DIR = path.resolve(HERE, '../素材/成片');

const jsonPath = process.argv[2];
if (!jsonPath || !fs.existsSync(jsonPath)) {
  console.error('用法：node compare.mjs <脚本json路径>');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const clips = cfg.clips;
if (clips.length !== 2) {
  console.error('[错误] 本工具固定两段结构');
  process.exit(1);
}
for (const c of clips) {
  if (!fs.existsSync(c.file)) {
    console.error(`[错误] 素材不存在：${c.file}`);
    process.exit(1);
  }
}

function probe(f) {
  const r = spawnSync(FFMPEG, ['-i', f], { stdio: ['ignore', 'ignore', 'pipe'] });
  const s = String(r.stderr);
  const d = s.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  const dim = s.match(/, (\d+)x(\d+)[, ]/);
  if (!d || !dim) return null;
  return { dur: +d[1] * 3600 + +d[2] * 60 + +d[3], w: +dim[1], h: +dim[2] };
}

const p1 = probe(clips[0].file);
if (!p1) { console.error('[错误] 读不出素材参数'); process.exit(1); }
const { w, h } = p1;
for (const c of clips) {
  const p = probe(c.file);
  if (p && (c.start + c.duration) > p.dur) {
    console.error(`[错误] ${path.basename(c.file)} 总长 ${p.dur.toFixed(1)}s，不够取 ${c.start}-${c.start + c.duration}s`);
    process.exit(1);
  }
}

// 台词配音路径与时间
const voicesDir = path.join(path.dirname(jsonPath), 'voices');
for (const s of cfg.segments) {
  if (!fs.existsSync(path.join(voicesDir, `${s.id}.mp3`))) {
    console.error(`[错误] 缺配音 ${s.id}，先跑 gen-voice.mjs`);
    process.exit(1);
  }
}

const xf = cfg.xfade || 0.6;
const tIntro = cfg.intro.duration;
const t1 = clips[0].duration;
const t2 = clips[1].duration;
const tOutro = cfg.outro.duration;
// xfade 时间轴：每段完整播放，仅边界 0.6s 交叉淡化
const off1 = tIntro - xf;            // intro→clip1 转场起点
const acc1 = tIntro + t1 - xf;       // v1 总长
const off2 = acc1 - xf;              // clip1→clip2 转场起点
const acc2 = acc1 + t2 - xf;         // v2 总长
const off3 = acc2 - xf;              // clip2→outro 转场起点
const total = acc2 + tOutro - xf;

// 卡片与字幕的 textfile（UTF-8，drawtext 引用）
const tmpDir = path.join(HERE, 'tmp_subs');
fs.mkdirSync(tmpDir, { recursive: true });
const introTxt = path.join(tmpDir, 'intro.txt');
const outroTxt = path.join(tmpDir, 'outro.txt');
fs.writeFileSync(introTxt, cfg.intro.text, 'utf8');
fs.writeFileSync(outroTxt, cfg.outro.text, 'utf8');
const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
const FONT = "fontfile='C\\:/Windows/Fonts/msyh.ttc'";

const fc = [];
const inputs = [];
// 0: 开场卡（黑底+大字）
inputs.push('-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:d=${tIntro}:r=30`);
// 1,2: 两段素材（-ss 精确截取）
clips.forEach((c) => inputs.push('-ss', String(c.start), '-t', String(c.duration), '-i', c.file));
// 3: 结尾卡
inputs.push('-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:d=${tOutro}:r=30`);
// 4+: 台词配音
cfg.segments.forEach((s) => inputs.push('-i', path.join(voicesDir, `${s.id}.mp3`)));
// BGM（循环）
const bgmIdx = 4 + cfg.segments.length;
inputs.push('-stream_loop', '-1', '-i', cfg.bgm);

// 视频链：卡片文字 + 素材规格统一 + 三次叠化 + 字幕
fc.push(`[0:v]drawtext=${FONT}:textfile='${esc(introTxt)}':fontsize=${Math.round(w / 7)}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2[v0]`);
fc.push(`[1:v]fps=30,setsar=1,scale=${w}:${h}[v1]`);
fc.push(`[2:v]fps=30,setsar=1,scale=${w}:${h}[v2]`);
fc.push(`[3:v]drawtext=${FONT}:textfile='${esc(outroTxt)}':fontsize=${Math.round(w / 15)}:line_spacing=${Math.round(w / 22)}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2[v3]`);
fc.push(`[v0][v1]xfade=transition=fade:duration=${xf}:offset=${off1.toFixed(3)}[x1]`);
fc.push(`[x1][v2]xfade=transition=fade:duration=${xf}:offset=${off2.toFixed(3)}[x2]`);
fc.push(`[x2][v3]xfade=transition=fade:duration=${xf}:offset=${off3.toFixed(3)}[xv]`);
const subs = cfg.segments
  .map((s) => {
    const sub = path.join(tmpDir, `${s.id}.txt`);
    // 竖屏一行放不了几个字：字号按宽度定，文本按每行 maxChars 硬切多行
    const fsz = Math.round(w / 18);
    const maxChars = Math.floor((w * 0.92) / fsz);
    const lines = [];
    for (let j = 0; j < s.text.length; j += maxChars) lines.push(s.text.slice(j, j + maxChars));
    fs.writeFileSync(sub, lines.join('\n'), 'utf8');
    return `drawtext=${FONT}:textfile='${esc(sub)}':fontsize=${fsz}:fontcolor=white:borderw=3:bordercolor=black@0.85:box=1:boxcolor=black@0.45:boxborderw=16:x=(w-text_w)/2:y=h-text_h-${Math.round(h / 17)}:enable='between(t,${s.start},${s.end})'`;
  })
  .join(',');
fc.push(`[xv]${subs}[vout]`);

// 音频链：配音对齐 + BGM
cfg.segments.forEach((s, i) => {
  const ms = Math.round(s.start * 1000);
  fc.push(`[${4 + i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${ms}|${ms}[a${i}]`);
});
fc.push(`[${bgmIdx}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${cfg.bgmVolume},afade=t=out:st=${(total - 2.5).toFixed(2)}:d=2.5[abgm]`);
const mixIn = cfg.segments.map((_, i) => `[a${i}]`).join('') + '[abgm]';
fc.push(`${mixIn}amix=inputs=${cfg.segments.length + 1}:normalize=0:duration=longest[aout]`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
const out = path.join(OUT_DIR, `照妖镜-${stamp}.mp4`);

console.log(`合成中：开场卡 ${tIntro}s + 段1 ${t1}s + 段2 ${t2}s + 结尾卡 ${tOutro}s（叠化 ${xf}s × 3，总长 ${total.toFixed(1)}s）…`);
const r = spawnSync(FFMPEG, [
  ...inputs,
  '-filter_complex', fc.join(';'),
  '-map', '[vout]', '-map', '[aout]',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k',
  '-t', total.toFixed(3),
  '-y', out,
], { stdio: ['ignore', 'ignore', 'pipe'] });

if (r.status !== 0) {
  console.error('[错误] 合成失败：');
  console.error(String(r.stderr).split('\n').slice(-6).join('\n'));
  process.exit(1);
}
console.log(`完成：${out}`);
