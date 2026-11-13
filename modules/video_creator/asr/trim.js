// 简兮合成引擎 · trim.js —— 口播原声「废话修剪」
// 输入：音频路径 + ASR 词级时间戳（whisper 输出）
// 逻辑：
//   1) 纯语气词（呃/那个/就是/嗯…）整词剪掉；
//   2) 相邻词间隔 > 1.5s 的长气口剪掉；
//   3) 剩余片段用 FFmpeg atrim+concat 拼接 → 输出修剪后的原声（libmp3lame）；
//   4) 同步把保留词的起止时间偏移到「修剪后时间轴」，供字幕逐词对齐。
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { acquireComposeSlot } from '@jansee/ffmpeg-kit/composeGate.mjs';

const GAP_THRESHOLD = 1.5; // 气口判定阈值（秒）：间隔超过则剪掉
const KEEP_PAD = 0.06;     // 保留片段前后各补 0.06s，避免拼接处有咔嚓声/吞字

// 语气词白名单（纯口语垫词）。词条先去掉标点再比对。
// 注意：'这个'不列入——"这个茶几"是有效指代内容，验收需保留。
const FILLER_WORDS = new Set([
  '呃', '嗯', '啊', '哦', '额', '唉', '哎', '诶', '呀', '哟', '嘛',
  '那个', '就是', '然后', '反正', '就是说', '怎么说', '那个啥',
]);

// 判断是否纯语气词（供 asr.js 标记 is_filler、前端标灰）
export function isFillerWord(text) {
  const t = String(text || '').replace(/[，。！？、；：,.!?;:\s]/g, '');
  return t.length > 0 && t.length <= 3 && FILLER_WORDS.has(t);
}

// 板块③「口播视频」专用「建议删除」语气词：在 FILLER_WORDS 基础上额外纳入 '这个'。
// 原因：板块③只对语气词做"建议删除"的视觉标记、最终由用户确认，不会自动剪；
// 而音频修剪流程（trimFillerAudio）默认会剪掉 is_filler，为避免误剪"这个茶几"等有效指代，
// 那里仍只用 narrow 的 FILLER_WORDS。故此处用独立、更宽的建议集。
export const VOICE_SUGGEST_FILLERS = new Set([...FILLER_WORDS, '这个']);
export function isVoiceSuggestFiller(text) {
  const t = String(text || '').replace(/[，。！？、；：,.!?;:\s]/g, '');
  return t.length > 0 && t.length <= 3 && VOICE_SUGGEST_FILLERS.has(t);
}

function isFiller(text) {
  return isFillerWord(text);
}

// 清理标点/空白，仅保留有效字符（对齐用）
function cleanText(s) {
  return String(s || '').replace(/[，。！？、；：,.!?;:\s]/g, '');
}

// 用「最终文本」重建字幕分段：把用户改好的文字按保留词的时间比例铺开，逐词对齐原声
export function buildSegmentsFromFinalText(shiftedWords, finalText) {
  const text = cleanText(finalText);
  if (!text || !Array.isArray(shiftedWords) || !shiftedWords.length) return [];
  const lens = shiftedWords.map((w) => cleanText(w.word).length || 1);
  const totalChars = lens.reduce((a, b) => a + b, 0);
  if (!totalChars) return [];
  let offset = 0;
  const segs = [];
  let buf = [];
  let bufStart = null;
  let bufChars = 0;
  shiftedWords.forEach((w, i) => {
    const n = Math.max(1, Math.round((lens[i] / totalChars) * text.length));
    const chunk = text.slice(offset, offset + n);
    offset += n;
    if (!chunk) return;
    if (bufStart === null) bufStart = w.start;
    buf.push(chunk);
    bufChars += chunk.length;
    if (bufChars >= 6) {
      segs.push({ start: Number(bufStart.toFixed(3)), end: Number(w.end.toFixed(3)), text: buf.join('') });
      buf = [];
      bufStart = null;
      bufChars = 0;
    }
  });
  if (buf.length && bufStart !== null) {
    segs.push({ start: Number(bufStart.toFixed(3)), end: Number(shiftedWords[shiftedWords.length - 1].end.toFixed(3)), text: buf.join('') });
  }
  return segs;
}

// 计算相邻时间轴的公共偏移（修剪前时间 → 修剪后时间）
function computeShift(keepRanges, words) {
  // 每个保留区间内部所有词的偏移量 = 该区间之前已保留总时长 - 区间原起点
  let keptBefore = 0;
  const shiftByStart = []; // [{start, shift}] 按原时间
  for (const r of keepRanges) {
    shiftByStart.push({ start: r[0], shift: keptBefore - r[0] });
    keptBefore += r[1] - r[0];
  }
  return (originalStart) => {
    let shift = 0;
    // 找最后一个 start <= originalStart 的区间
    for (const e of shiftByStart) {
      if (e.start <= originalStart) shift = e.shift;
      else break;
    }
    return originalStart + shift;
  };
}

/**
 * 修剪废话并拼接
 * @param {string} audioPath 原始音频绝对路径
 * @param {Array<{word,start,end}>} words ASR 词级时间戳
 * @param {string} outMp3 输出 mp3 绝对路径
 * @param {Object} [opts]
 * @param {Array<{word,start,end}>} [opts.deleted] 用户删除的词（含语气词），传了则严格按它剪；
 *                                                  不传则沿用旧行为：默认剪掉全部语气词。
 * @param {string} [opts.finalText] 用户核对/改错后的最终文本；传了则用它重建字幕分段
 * @returns {Promise<{audio_file, text, words, segments, duration_sec, cut_sec}>}
 *   words/segments 的时间戳已偏移到修剪后时间轴
 */
export async function trimFillerAudio(audioPath, words = [], outMp3, opts = {}) {
  const list = (Array.isArray(words) ? words : [])
    .map((w) => ({ word: String(w.word || ''), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.word && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .sort((a, b) => a.start - b.start);

  if (!list.length) {
    throw new Error('ASR 未识别到任何词，无法修剪');
  }

  // 1. 保留片段：默认剪掉语气词；若传了 deleted 则严格按用户删除集合剪
  const hasExplicitDelete = Array.isArray(opts.deleted);
  const deletedSet = new Set(
    (hasExplicitDelete ? opts.deleted : [])
      .map((d) => Number(d && d.start))
      .filter(Number.isFinite)
  );
  const keepWords = list.filter((w) => {
    if (deletedSet.has(w.start)) return false;
    if (!hasExplicitDelete && isFiller(w.word)) return false; // 老行为兜底：默认剪语气词
    return true;
  });
  if (!keepWords.length) {
    throw new Error('全部为语气词或被删除，无可保留内容');
  }

  // 2. 按气口合并：间隔 <=1.5s 连成一段，>1.5s 断开
  const ranges = [];
  let cur = [keepWords[0].start, keepWords[0].end];
  for (let i = 1; i < keepWords.length; i++) {
    const w = keepWords[i];
    if (w.start - cur[1] > GAP_THRESHOLD) {
      ranges.push(cur);
      cur = [w.start, w.end];
    } else {
      cur[1] = Math.max(cur[1], w.end);
    }
  }
  ranges.push(cur);

  // 3. 每段前后补一点边距（不越界）
  const padded = ranges.map(([s, e]) => [Math.max(0, s - KEEP_PAD), e + KEEP_PAD]);

  // 4. FFmpeg 拼接（纯相对 cwd，规避 Windows 盘符冒号转义问题）
  const outDir = path.dirname(outMp3);
  await fs.mkdir(outDir, { recursive: true });
  const relInput = path.relative(outDir, audioPath).replace(/\\/g, '/');
  const relOut = path.relative(outDir, outMp3).replace(/\\/g, '/');

  const filterParts = [];
  const concatParts = [];
  padded.forEach(([s, e], i) => {
    filterParts.push(`[0:a]atrim=start=${s.toFixed(3)}:end=${e.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
    concatParts.push(`[a${i}]`);
  });
  const filterGraph = [
    ...filterParts,
    `${concatParts.join('')}concat=n=${padded.length}:v=0:a=1[out]`,
  ].join(';');

  const release = await acquireComposeSlot(`audio_trim:${path.relative(process.cwd(), outMp3).replace(/[\\/]+/g, '_')}`);
  try {
    await new Promise((resolve, reject) => {
      execFile(
        ffmpegStatic,
        [
          '-y', '-i', relInput,
          '-filter_complex', filterGraph,
          '-map', '[out]',
          '-c:a', 'libmp3lame', '-q:a', '4',
          relOut,
        ],
        { cwd: outDir, maxBuffer: 50 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (err) {
            const tail = String(stderr || '').split('\n').slice(-6).join(' ').trim();
            reject(new Error('修剪拼接失败: ' + (tail || err.message)));
          } else {
            resolve();
          }
        }
      );
    });
  } finally {
    release();
  }

  // 5. 偏移时间戳到修剪后时间轴
  const shiftFn = computeShift(padded, keepWords);
  const shiftedWords = keepWords
    .map((w) => ({
      word: w.word,
      start: Number(shiftFn(w.start).toFixed(3)),
      end: Number(shiftFn(w.end).toFixed(3)),
    }))
    .filter((w) => w.end > w.start);

  // 6. 字幕分段：用户传了最终文本 → 按保留词时间比例重建（改错字生效）；否则按保留词聚块
  const finalText = String(opts.finalText || '').trim();
  const segments = finalText
    ? buildSegmentsFromFinalText(shiftedWords, finalText)
    : groupSubtitleSegments(shiftedWords);

  // 7. 干净文本（用户已改则用其文本，否则去掉语气词与标点）
  const text = finalText
    ? cleanText(finalText)
    : shiftedWords.map((w) => cleanText(w.word)).join('').trim();

  const originalDur = list.length ? list[list.length - 1].end : 0;
  const keptDur = padded.reduce((a, r) => a + (r[1] - r[0]), 0);
  return {
    audio_file: outMp3,
    text,
    words: shiftedWords,
    segments,
    duration_sec: Number(keptDur.toFixed(3)),
    original_duration_sec: Number(originalDur.toFixed(3)),
    cut_sec: Number(Math.max(0, originalDur - keptDur).toFixed(3)),
  };
}

// 把词级时间戳聚合成完整自然句展示块：一整句一整句呈现，杜绝碎字蹦跳
export function groupSubtitleSegments(words, options = {}) {
  const maxChars = Number(options.maxChars) || 16;              // 舒适单句字数上限，默认 16 字
  const pauseThreshold = Number(options.pauseThreshold) || 0.45; // 词间停顿 >= 0.45s 视为换气自然分句
  const commaMinChars = Number(options.commaMinChars) || 10;     // 弱标点（逗号）断句门槛：满 10 字才断，防止碎片孤儿句

  const segs = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const start = buf[0].start;
    const end = buf[buf.length - 1].end;
    const text = buf.map((w) => w.word).join('').replace(/[，。！？、；：,.!?;:]/g, '').trim();
    if (text) {
      segs.push({
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
        text,
      });
    }
    buf = [];
  };

  for (let i = 0; i < (words || []).length; i++) {
    const w = words[i];
    const rawWord = String(w.word || '');
    const clean = rawWord.replace(/[，。！？、；：,.!?;:\s]/g, '');
    if (!clean) continue;

    const currentChars = buf.reduce((acc, item) => acc + item.word.replace(/[，。！？、；：,.!?;:\s]/g, '').length, 0);

    // 检查词间换气长停顿：若停顿显著（>= pauseThreshold），前句收尾
    if (buf.length > 0) {
      const prevEnd = buf[buf.length - 1].end;
      const gap = w.start - prevEnd;
      if (gap >= pauseThreshold) {
        flush();
      }
    }

    const isStrongPunct = /[。！？!?；;\n]/.test(rawWord);
    const isWeakPunct = /[，,、]/.test(rawWord);

    buf.push(w);

    if (isStrongPunct) {
      flush();
    } else if (isWeakPunct && currentChars + clean.length >= commaMinChars) {
      flush();
    } else if (currentChars + clean.length >= maxChars) {
      flush();
    }
  }
  flush();

  // 微缝隙顺延平滑：两句间隔短于 0.25s 时自动平滑贴合，消除字幕闪烁
  for (let i = 0; i < segs.length - 1; i++) {
    const curr = segs[i];
    const next = segs[i + 1];
    const gap = next.start - curr.end;
    if (gap > 0 && gap <= 0.25) {
      curr.end = Number(next.start.toFixed(3));
    }
  }

  return segs;
}
