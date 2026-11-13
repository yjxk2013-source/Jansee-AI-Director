// 简兮合成引擎 · tts.js —— 配音（从旧项目 apps/server/engine/tts.js 精简搬来）
// 主方案：腾讯云 TTS（精品音色，800 万字符免费额度），供应商链见 ttsProvider.js。
// TTS 通过网络调用腾讯云服务；失败时返回空 file，由编排层静音兜底，保证出片。

import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { mapVoiceFor, resolveTTSProvider } from './ttsProvider.js';
/* 不建缓存池（2026-10-25 定版）：台词是 LLM 每次现写的，同文本几乎不会复现，
   生产命中率≈0；缓存反而引入「缓存命中掩盖供应商失败」的 bug 类别（E5 教训）。
   每一 句都真实调腾讯，失败走既有重试 + 静音兜底。 */


// —— 音色解析（2026-10-24 收敛）：唯一真源=voices.js 抽象气质 key（f-warm 等 8 种）——
// 旧 Edge 时代的 MOOD_TO_VOICE / DEFAULT_VOICE（zh-CN-XiaoxiaoNeural 等）已删；
// 未传 voiceId 时落 f-warm 温柔女声（ temperament key，经 ttsProvider 翻译为腾讯 101027）。

// —— 语速基准（4字/秒 = 基准 1，LLM 判定倍率在此基础上等比缩放）——
// 正常语速对应约 4 字/秒 → 每字 0.25 秒。手动固定，避免纯经验值漂移。
const SECONDS_PER_CHAR = 1 / 4;

function resolveVoice(_mood, voiceId) {
  const vid = String(voiceId || '').trim();
  return vid || 'f-warm';
}

// 用 ffmpeg -i 解析音频时长（秒）；ffmpeg -i 无输出文件必然非零退出，需在 catch 里读 stderr
export function audioDurationSec(file) {
  let out = '';
  try {
    out = execFileSync(ffmpegStatic, ['-i', file], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    out = e?.stderr || out;
  }
  const m = out.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (m) return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
  return 0;
}

// 句级配音统一出口：走「TTS 供应商抽线层」（ttsProvider.js）。
// 收敛定版（2026-10-24）：唯一供应商=腾讯云，无主备链。
// 返回 true=成功/生成出非空音频，false=失败（由调用方静音兜底）。签名与历史一致，供音色试听接口复用。
export async function synthViaNode(text, mood, voiceId, outPath, speed = 1) {
  const semantic = resolveVoice(mood, voiceId);
  const { all } = resolveTTSProvider();
  for (const provider of all) {
    const voice = mapVoiceFor(provider.name, semantic);
    const res = await provider.synthesize({ text, mood, voiceId: voice, outPath, speed });
    if (res?.ok) {
      // 若实际走了备胎（不是列表第一个），记录一笔，便于确认兜底路径被触发
      if (all.length > 1 && provider !== all[0]) {
        console.warn(`[TTS] 供应商 "${all[0].name}" 失败，已自动回落 ${provider.name} 出音。`);
      }
      return true;
    }
    if (all.length > 1) {
      console.warn(
        `[TTS] 供应商 "${provider.name}" 配音失败（尝试第 ${all.indexOf(provider) + 1}/${all.length}）：`,
        res?.reason || 'unknown',
      );
    } else {
      console.warn(`[TTS] 供应商 "${provider.name}" 配音失败：`, res?.reason || 'unknown');
    }
  }
  return false;
}

// 批量：逐句合成 → 落盘，返回 [{file, durationSec, shotIndex, content, audioStart, audioEnd}]
// 每句失败静音兜底（file='' durationSec=0），不阻断出片。
export async function synthesizeLines(shots, voiceControl, taskDir) {
  const ttsDir = path.join(taskDir, 'tts');
  await fs.mkdir(ttsDir, { recursive: true });
  const mood = voiceControl?.mood || '';
  const voiceId = voiceControl?.voiceId || '';
  const speed = Number(voiceControl?.speed) > 0 ? Number(voiceControl.speed) : 1;
  const results = [];
  // 逐句 TTS 并行合成（执行层提速，不改变音色/时长/字幕逻辑）。
  // 不探测锁定：每句直接走 synthViaNode 的「主供应商→备供应商」failover，
  // 唯一 TTS 判定在 ttsProvider 内即时完成，不额外联网、不占时间。
  // 每句独立调 TTS 输出独立 mp3，互不依赖 → 用有界并发池并行，结果按下标顺序返回，保持原时序。
  const CONCURRENT = 6; // 句级并发上限（腾讯云并发配额高）
  const synthOne = async (i) => {
    const text = (shots[i].content || '').trim();
    // V2 逐镜语速：句级 speed 优先（结构骨架 fast 段微提/慢段微降），无句级值回落全片 speed
    const shotSpeed = Number(shots[i].speed) > 0 ? Number(shots[i].speed) : speed;
    // 逐句独立子目录：部分供应商实现固定输出文件名再 rename，若并发句共用同一目录会互相覆盖
    // ⇒ 每句一个独立子目录，杜绝并发抢写同名文件。
    const dir = path.join(ttsDir, `s${String(i + 1).padStart(2, '0')}`);
    const file = path.join(dir, `shot_${String(i + 1).padStart(2, '0')}.mp3`);
    await fs.mkdir(dir, { recursive: true });
    if (!text) {
      return { file: '', durationSec: 0, shotIndex: i, content: text, audioStart: 0, audioEnd: 0 };
    }

    // 直接真实调腾讯（不读缓存）：主供应商失败自动回落下一家，逻辑内即时判定、无需探测
    let ok = false;
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      if (attempt > 1) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        try {
          await fs.unlink(file);
        } catch (_e) {
          /* 忽略 */
        }
      }
      ok = await synthViaNode(text, mood, voiceId, file, shotSpeed);
    }

    let durationSec = 0;
    if (ok) {
      try {
        await fs.access(file);
        durationSec = audioDurationSec(file);
      } catch (_e) {
        durationSec = 0;
      }
      if (durationSec <= 0) {
        ok = false;
        try {
          await fs.unlink(file);
        } catch (_e) {
          /* 忽略 */
        }
      }
    }

    return {
      file: ok ? file : '',
      durationSec,
      shotIndex: i,
      content: text,
      audioStart: 0,
      audioEnd: 0,
    };
  };
  // 分批并行（每批 CONCURRENT 句），批次间串行；结果按下标回填，保持原时序与顺序稳定。
  results.length = shots.length;
  for (let start = 0; start < shots.length; start += CONCURRENT) {
    const batch = [];
    for (let j = start; j < Math.min(start + CONCURRENT, shots.length); j++) batch.push(synthOne(j));
    const done = await Promise.all(batch);
    done.forEach((r) => {
      results[r.shotIndex] = r;
    });
  }
  // 兼容过滤：消除稀疏占位（results 恒满秩，此处仅为稳妥）
  for (let i = 0; i < results.length; i++)
    if (!results[i]) results[i] = { file: '', durationSec: 0, shotIndex: i, content: '', audioStart: 0, audioEnd: 0 };
  // 可靠性：若所有分镜配音全部合成失败（可能 voice 下架/服务连不上）
  // → 抛错让任务标记 failed，避免产出一条"没有声音"的视频。
  const okCount = results.filter((r) => r.file).length;
  if (okCount === 0 && results.length > 0) {
    console.error(`[TTS] 全部 ${results.length} 句配音失败，判定任务失败（voice=${voiceId}）`);
    throw new Error(`配音全部失败（TTS 不可用或所选 voice 已下架：${voiceId})`);
  }
  if (okCount < results.length) {
    console.warn(`[TTS] ${results.length - okCount}/${results.length} 句配音失败静音兜底（voice=${voiceId}）`);
  }
  return results;
}

// ============ 共用：逐句 TTS 整轨拼接（dub 带货配音 / 口播 AI 配音共用，杜绝重写）============

// ffmpeg promise 封装（cwd 下执行，失败 reject 精简 stderr）
function runFfmpeg(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegStatic, args, { cwd, maxBuffer: 200 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const tail = String(stderr || '')
          .split('\n')
          .slice(-6)
          .join(' ')
          .trim();
        reject(new Error(`${tail || err.message}`));
        return;
      }
      resolve();
    });
  });
}

// 把配音文案拆成短句：优先按换行，再按句末标点拆长句，供逐句 TTS + 自然停顿
export function splitNarrationLines(text) {
  const MAX_LINES = 16;
  const out = [];
  const push = (s) => {
    const t = String(s || '').trim();
    if (t) out.push(t);
  };
  for (const raw of String(text || '').split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line
      .split(/(?<=[。！？；\n])/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 1) parts.forEach(push);
    else push(line);
    if (out.length >= MAX_LINES) break;
  }
  return out.slice(0, MAX_LINES);
}

// 自动细切文案为更多短片段：当文案明显短于目标视频时长时，把文案拆成更多小句
// （优先按标点、必要时按字数），使「分句平铺」的句间留白被分摊成多个小停顿，均匀铺满整段视频，
// 而非只切两句导致中间出现一大段超长留白。
const FINE_SEPS = ['。', '！', '？', '；', '，', '、', '：'];
export function fineSplit(text, targetSpan, speed = 1) {
  const clean = String(text || '').replace(/\s+/g, '');
  if (!clean) return [];
  const total = clean.length;
  const sp = Number(speed) > 0 ? Number(speed) : 1;
  const estVoice = (total * SECONDS_PER_CHAR) / sp; // 估算实际朗读时长（4字/秒基准，sp 为 LLM 判定的倍率）
  const surplus = Math.max(0, Number(targetSpan) - estVoice);
  const gapTarget = 1.6; // 希望的句间留白上限（秒）
  const nDesired = Math.min(40, Math.max(2, Math.ceil(surplus / gapTarget) + 1));
  const maxPer = Math.max(4, Math.ceil(total / nDesired));
  const frags = [];
  let buf = '';
  for (const ch of clean) {
    buf += ch;
    if (FINE_SEPS.includes(ch) || buf.length >= maxPer) {
      frags.push(buf);
      buf = '';
    }
  }
  if (buf) frags.push(buf);
  if (frags.length === 1 && frags[0].length > maxPer) {
    const one = frags[0];
    frags.length = 0;
    for (let i = 0; i < one.length; i += maxPer) frags.push(one.slice(i, i + maxPer));
  }
  return frags;
}

// 逐句 TTS 拼接成单条音轨（adelay 定位 + 统一采样率后 concat）
// 返回 { audioFile, cues, durationSec }：cues=[{content, audioStart, audioEnd}] 与配音位置严格一致，可直接烧字幕。
// opts.targetSpanSec>0：把文案「分句平铺」到该时长（每句原速、仅拉开句间留白，让最后一句恰在目标时长结尾），供铺满整段视频。
export async function buildTtsAudio(cwd, text, voiceId, opts = {}) {
  // 语速（LLM 判定：>1 快语速、<1 慢语速）：直接影响每字实测朗读时长，故估算要用速度折算
  const speed = Number(opts?.speed) > 0 ? Number(opts.speed) : 1;
  // 文案明显短于目标时长时，自动切成更多小句，让分句平铺更均匀、句间留白不致过大
  const targetSpan0 = Number(opts?.targetSpanSec) > 0 ? Number(opts.targetSpanSec) : 0;
  const estVoice0 = (String(text || '').replace(/\s+/g, '').length * SECONDS_PER_CHAR) / speed;
  const lines =
    targetSpan0 && targetSpan0 > estVoice0 + 0.3 ? fineSplit(text, targetSpan0, speed) : splitNarrationLines(text);
  if (!lines.length) throw new Error('配音文案为空');
  const ttsResults = await synthesizeLines(
    lines.map((content) => ({ content })),
    { voiceId, speed },
    cwd,
  );
  if (!ttsResults.some((r) => r.file)) {
    throw new Error(`配音全部合成失败（TTS 不可用或所选 voice 已下架：${voiceId})`);
  }
  const GAP = 0.4; // 句间停顿（秒，默认）
  const MAX_GAP = 2.5; // 分句平铺时的句间留白上限（秒）：超过则不再拉伸，剩余时长作尾部留白
  const rawParts = [];
  for (const r of ttsResults) {
    if (!r.file) continue;
    rawParts.push({ file: r.file, content: r.content, dur: r.durationSec || 0 });
  }
  const voiceSum = rawParts.reduce((s, p) => s + p.dur, 0);
  const n = rawParts.length;
  // 分句平铺：文案实际配音时长 < 目标时长(targetSpanSec) 时，拉开句间留白，让最后一句正好落在目标时长结尾。
  // 每句仍按原速朗读、语义不变 —— 供「AI读文案」把文案分句铺满整个视频，而非整段重复或变调。
  const targetSpan = Number(opts?.targetSpanSec) > 0 ? Number(opts.targetSpanSec) : 0;
  const parts = [];
  const cues = []; // [{content, audioStart, audioEnd}]：与 adelay 位置严格一致，供烧字幕
  if (targetSpan > voiceSum + 0.25 && n > 1) {
    // 均匀分句平铺：每句原速、拉大句间留白铺满目标时长。句间留白设上限（MAX_GAP），
    // 防止「字太少 + 视频很长」时把每个停顿硬拉到十几秒、听起来像一个字一个字数（太难受）。
    // 超出上限的剩余时长不再强拉伸，作为尾部背景留白，交给 BGM / 尾段承接。
    const gapEach = Math.min((targetSpan - voiceSum) / (n - 1), MAX_GAP);
    let cursor = 0;
    for (const p of rawParts) {
      const start = cursor;
      parts.push({ file: p.file, delayMs: Math.round(start * 1000), dur: p.dur });
      cues.push({ content: p.content, audioStart: start, audioEnd: start + p.dur });
      cursor = start + p.dur + gapEach;
    }
  } else {
    let cursor = 0;
    for (const p of rawParts) {
      const start = cursor;
      parts.push({ file: p.file, delayMs: Math.round(start * 1000), dur: p.dur });
      cues.push({ content: p.content, audioStart: start, audioEnd: start + p.dur });
      cursor = start + p.dur + GAP;
    }
  }
  const out = path.join(cwd, 'dub_voice.mp3');
  const SR = 44100;
  const args = ['-nostdin', '-y'];
  parts.forEach((p) => {
    args.push('-i', path.relative(cwd, p.file).replace(/\\/g, '/'));
  });
  // 精确时间轴拼接（杜绝「adelay 前置静音被整段拼入」导致的整轨虚长）：
  // 每句先 atrim 到自身时长并重置 PTS，再 adelay 定位到累计起点，最后 amix 按 longest 求和；
  // 整轨时长 = 最后一句结束点（Σ 句长 + 句间停顿），而非被延迟重复累计而膨胀。
  const filters = parts.map(
    (p, i) =>
      `[${i}:a]atrim=0:${p.dur.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=${SR}:channel_layouts=mono,adelay=${p.delayMs}[a${i}]`,
  );
  filters.push(
    `${parts.map((_, i) => `[a${i}]`).join('')}amix=inputs=${parts.length}:duration=longest:dropout_transition=0:normalize=0,aresample=async=1,aformat=sample_fmts=fltp:sample_rates=${SR}:channel_layouts=stereo[aout]`,
  );
  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[aout]',
    '-c:a',
    'libmp3lame',
    '-q:a',
    '4',
    path.relative(cwd, out).replace(/\\/g, '/'),
  );
  await runFfmpeg(args, cwd);
  const durationSec = audioDurationSec(out);
  return { audioFile: out, cues, durationSec };
}
