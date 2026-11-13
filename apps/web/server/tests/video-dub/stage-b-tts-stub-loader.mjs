// 简兮 · 阶段 B 测试专用 ESM loader（零付费桩 TTS）
// 拦截 @jansee/tts-kit/tts.js，把两个合成入口替换为本地 ffmpeg sine 合成桩（不触网、零费用）：
//   synthesizeLines —— @jansee/video-dub 配音链（逐段实测时长，返回与真实实现同构的结果数组）
//   buildTtsAudio   —— modules/video_creator/video/storyboard.js 分镜链（保留兼容）
// 其余导出（audioDurationSec 等）保持真实实现，保证后续音画对齐/混音/字幕/混流全链路真实执行。
// STUB_TTS_MODE=long  → 每段 2.6s（5 段 × 2.6s + 4 × 0.5s 停顿 ≈ 15s），供「配音超长 trim + 淡出」分支
// STUB_TTS_MODE=short → 每段 0.6s（5 段 × 0.6s + 4 × 0.5s 停顿 ≈ 5.0s），供「配音不足补满/BGM 垫底」分支

const pad = (n) => String(n).padStart(2, '0');

const STUB_SYNTHESIZE_LINES = [
  'export async function synthesizeLines(shots, voiceControl, taskDir) {',
  "  const fsp = (await import('node:fs')).promises;",
  "  const path = await import('node:path');",
  "  const { execFile } = await import('node:child_process');",
  "  const ffmpeg = (await import('ffmpeg-static')).default;",
  '  await fsp.mkdir(taskDir, { recursive: true });',
  "  const mode = String(process.env.STUB_TTS_MODE || 'short');",
  "  const perShotDur = mode === 'long' ? 2.6 : 0.6;",
  '  const results = [];',
  '  for (let i = 0; i < shots.length; i++) {',
  "    const text = String(shots[i]?.content || '').trim();",
  "    const dir = path.join(taskDir, 'tts', 's' + String(i + 1).padStart(2, '0'));",
  '    await fsp.mkdir(dir, { recursive: true });',
  "    const f = path.join(dir, 'shot_' + String(i + 1).padStart(2, '0') + '.mp3');",
  '    if (text) {',
  "      await new Promise((res, rej) => execFile(ffmpeg, ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=' + (440 + i * 60) + ':duration=' + perShotDur, f], (e) => (e ? rej(new Error(String(e.message))) : res())));",
  '    }',
  '    results.push({ file: text ? f : \'\', durationSec: text ? perShotDur : 0, shotIndex: i, content: text, audioStart: 0, audioEnd: 0 });',
  '  }',
  "  if (!results.some((r) => r.file)) throw new Error('配音全部失败（桩：无有效文本）');",
  '  return results;',
  '}',
].join('\n');

const STUB_BUILD_TTS_AUDIO = [
  'export async function buildTtsAudio(cwd, text, voiceId, opts = {}) {',
  "  const fsp = (await import('node:fs')).promises;",
  "  const path = await import('node:path');",
  "  const { execFile } = await import('node:child_process');",
  "  const ffmpeg = (await import('ffmpeg-static')).default;",
  '  await fsp.mkdir(cwd, { recursive: true });',
  "  const lines = String(text || '').split(/\\n+/).map((s) => s.trim()).filter(Boolean);",
  "  if (!lines.length) throw new Error('配音文案为空');",
  "  const mode = String(process.env.STUB_TTS_MODE || 'short');",
  "  const perLineDur = mode === 'long' ? 2.6 : 0.6;",
  '  const gap = 0.3;',
  '  const SR = 44100;',
  '  const parts = [];',
  '  for (let i = 0; i < lines.length; i++) {',
  "    const f = path.join(cwd, 'stub_tts_' + String(i + 1).padStart(2, '0') + '.wav');",
  "    await new Promise((res, rej) => execFile(ffmpeg, ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=' + (440 + i * 60) + ':duration=' + perLineDur, f], (e) => (e ? rej(new Error(String(e.message))) : res())));",
  "    parts.push({ file: f, content: lines[i], dur: perLineDur });",
  '  }',
  "  const args = ['-nostdin', '-y'];",
  "  for (const p of parts) args.push('-i', path.relative(cwd, p.file).replace(/\\\\/g, '/'));",
  '  const filters = parts.map((p, i) => "[" + i + ":a]aformat=sample_fmts=fltp:sample_rates=" + SR + ":channel_layouts=mono,adelay=" + Math.round(i * (perLineDur + gap) * 1000) + "[a" + i + "]");',
  '  filters.push(parts.map((_, i) => "[a" + i + "]").join("") + "amix=inputs=" + parts.length + ":duration=longest:normalize=0,aresample=async=1,aformat=sample_fmts=fltp:sample_rates=" + SR + ":channel_layouts=stereo[aout]");',
  "  args.push('-filter_complex', filters.join(';'), '-map', '[aout]', '-c:a', 'libmp3lame', '-q:a', '4', 'stub_voice.mp3');",
  "  await new Promise((res, rej) => execFile(ffmpeg, args, { cwd }, (e) => (e ? rej(new Error(String(e.message))) : res())));",
  '  const cues = parts.map((p, i) => ({ content: p.content, audioStart: i * (perLineDur + gap), audioEnd: i * (perLineDur + gap) + perLineDur }));',
  "  return { audioFile: path.join(cwd, 'stub_voice.mp3'), cues, durationSec: parts.length * perLineDur + (parts.length - 1) * gap };",
  '}',
].join('\n');

export async function load(url, context, next) {
  const normalized = String(url).replace(/\\/g, '/');
  if (normalized.includes('tts-kit/tts.js')) {
    const r = await next(url, context);
    let src = Buffer.from(r.source).toString('utf8');
    if (!src.includes('export async function synthesizeLines') && !src.includes('export async function buildTtsAudio')) return r;
    src = src
      .replace('export async function buildTtsAudio', 'export async function __stub_disabled_buildTtsAudio')
      .replace('export async function synthesizeLines', 'export async function __stub_disabled_synthesizeLines');
    src += '\n' + STUB_SYNTHESIZE_LINES + '\n' + STUB_BUILD_TTS_AUDIO + '\n';
    return { format: 'module', source: src, shortCircuit: true };
  }
  return next(url, context);
}
