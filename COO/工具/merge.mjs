// 简兮 JANSEE 轻量合并器
// 用法：双击"合并.bat" → 按顺序逐个拖入视频（每拖一个回车）→ 直接回车结束 → 自动合并
// 也支持命令行：node merge.mjs 段1.mp4 段2.mp4 [段3.mp4 ...]
// 输出：COO/素材/切片/合并-时间戳.mp4
// 智能处理：自动探测每段有没有音轨；没有的补静音轨，保证能合；输出统一重编码，参数与录屏/切片一致
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FFMPEG = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const OUT_DIR = path.resolve(HERE, '../素材/切片');

const cleanPath = (s) => String(s || '').trim().replace(/^"|"$|^'|'$/g, '');

// 用 ffmpeg -i 的 stderr 探测：时长 + 有无音轨
function probe(file) {
  const r = spawnSync(FFMPEG, ['-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  const s = String(r.stderr);
  const d = s.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (!d) return null;
  const dur = +d[1] * 3600 + +d[2] * 60 + +d[3];
  return { dur, hasAudio: s.includes('Audio:') };
}

function merge(files) {
  const metas = files.map((f) => {
    const m = probe(f);
    if (!m) {
      console.error(`[错误] 读不了这个文件：${f}`);
      process.exit(1);
    }
    return { file: f, ...m };
  });

  const allNoAudio = metas.every((m) => !m.hasAudio);
  const anyNoAudio = metas.some((m) => !m.hasAudio);

  // 两遍构造：先加完所有文件输入（编号 0..N-1），再追加静音输入（编号 N 起），
  // 否则 lavfi 输入插在中间会把后续文件输入的编号顶乱，滤镜图标号全错
  const args = [];
  metas.forEach((m) => args.push('-i', m.file));
  const vParts = [];
  const aParts = [];
  metas.forEach((m, i) => {
    // 无音轨且其它段有音轨时，补一路静音轨（与视频等长），保证 concat 音频流齐全
    if (!m.hasAudio && !allNoAudio) {
      const aIn = metas.length + i;
      args.push('-f', 'lavfi', '-t', String(m.dur), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
      aParts.push(`[${aIn}:a]anull[a${i}]`);
    } else if (m.hasAudio) {
      // 统一采样率与声道，避免 concat 因音频参数不一致失败
      aParts.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,anull[a${i}]`);
    }
    vParts.push(`[${i}:v]setsar=1[v${i}]`);
  });

  const map = allNoAudio
    ? `${vParts.join(';')};${metas.map((_, i) => `[v${i}]`).join('')}concat=n=${metas.length}:v=1:a=0`
    : `${vParts.concat(aParts).join(';')};${metas.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${metas.length}:v=1:a=1`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  const out = path.join(OUT_DIR, `合并-${stamp}.mp4`);

  args.push(
    '-filter_complex', map, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
  );
  if (!allNoAudio) args.push('-c:a', 'aac');
  args.push('-y', out);

  console.log(`合并中（${metas.length} 段，共 ${metas.reduce((s, m) => s + m.dur, 0).toFixed(1)} 秒${anyNoAudio && !allNoAudio ? '，缺音轨的段已补静音' : allNoAudio ? '，纯画面无音轨' : ''}）…`);
  const r = spawnSync(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) {
    console.error('[错误] 合并失败：');
    console.error(String(r.stderr).split('\n').slice(-5).join('\n'));
    process.exit(1);
  }
  console.log(`已合并：${out}`);
}

// ── 入口 ──
const cliFiles = process.argv.slice(2).map(cleanPath).filter(Boolean);

if (cliFiles.length >= 2) {
  merge(cliFiles);
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a)));

  console.log('=== 简兮 JANSEE 轻量合并器 ===');
  console.log(`输出目录：${OUT_DIR}`);
  console.log('按播放顺序逐个把视频拖进本窗口回车；全部拖完直接回车开始合并。');
  console.log('');
  const files = [];
  for (;;) {
    const line = cleanPath(await ask(files.length ? `第 ${files.length + 1} 段（直接回车=开始合并）：` : '第 1 段：'));
    if (!line) break;
    if (!fs.existsSync(line)) {
      console.error('文件不存在，重新拖。');
      continue;
    }
    files.push(line);
    console.log(`已加入第 ${files.length} 段。`);
  }
  if (files.length < 2) {
    console.error('[错误] 至少要 2 段才能合并。');
    process.exit(1);
  }
  merge(files);
  rl.close();
}
