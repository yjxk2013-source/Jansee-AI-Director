// 简兮合成引擎 · keepOriginal.js —— 「上传视频-保留原声-核对字幕」共享模块（全平台通用）
// 适用于任意板块：用户上传视频/录音 → 保留原声，不调大模型 → 本地 ASR 出词级时间戳 + 核对字幕分段，
// 用户核对（删词/改字）后据此重建成片字幕。口播视频、我的声音、商品成片等场景统一调本模块。
// 关键约束（宪法第 2.1 节·保留原声路径）：原声直通不转录、不 TTS、不修剪；台词是用户原话；全程本地不调大模型。
import { runASR } from '../asr/asr.js';
import { isVoiceSuggestFiller, buildSegmentsFromFinalText, groupSubtitleSegments } from '../asr/trim.js';

/**
 * 保留原声·本地 ASR（共享入口）：视频/录音 → 抽音频 → whisper 本地识别 → 词级时间戳 + 核对字幕分段。
 * 在 whisper 原词基础上，附加板块共通的「建议删除词」标记（语气词等，仅作视觉建议，最终由用户确认）。
 * @param {string}  inputFile  视频(MP4/MOV) 或音频(MP3/WAV) 绝对路径
 * @param {string}  workDir    工作目录（ASR 中间产物）
 * @returns {Promise<{text:string, words:Array, segments:Array, duration:number}>}
 */
export async function runKeepOriginalAsr(inputFile, workDir) {
  const r = await runASR(inputFile, workDir); // runASR 内部用 ffmpeg 抽音频，whisper 仅本地推理
  const words = (Array.isArray(r.words) ? r.words : []).map((w) => ({
    ...w,
    is_filler: !!isVoiceSuggestFiller(w.word) || !!w.is_filler,
  }));
  return {
    text: r.text,
    words,
    segments: r.segments,
    duration: r.duration,
  };
}

/**
 * 从 ASR 词 + 用户删除集 + 最终文本 重建字幕分段（供 drawtext 烧录）。
 * 规则：删除集（含一键清空语气词）先剔除 → 有 finalText 按用户改后文本重建（改错字生效），否则按保留词聚合。
 * @param {Array<{word,start,end}>} words          ASR 词级时间戳
 * @param {Array<{start}>}          deleted        用户删除的词（以 start 排除）
 * @param {string}                  finalText      用户核对/改错后的最终字幕文本（空 = 用 ASR 保留词聚合）
 * @returns {Array<{content,audioStart,audioEnd}>}
 */
export function buildSubtitleCues(words = [], deleted = [], finalText = '') {
  const delSet = new Set(
    (Array.isArray(deleted) ? deleted : []).map((d) => Number(d && d.start)).filter(Number.isFinite)
  );
  const kept = (Array.isArray(words) ? words : [])
    .map((w) => ({ word: String(w.word || ''), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.word && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .filter((w) => !delSet.has(Number(w.start)))
    .sort((a, b) => a.start - b.start);

  const ft = String(finalText || '').trim();
  const segs = ft ? buildSegmentsFromFinalText(kept, ft) : groupSubtitleSegments(kept);
  return segs
    .map((s) => ({ content: String(s.text || '').trim(), audioStart: Number(s.start) || 0, audioEnd: Number(s.end) || 0 }))
    .filter((c) => c.content && c.audioEnd > c.audioStart + 0.01);
}