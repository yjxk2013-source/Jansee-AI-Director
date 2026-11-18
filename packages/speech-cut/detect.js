// 简兮口播模块 · detect.js —— 冗余内容规则检测（纯规则，不调 LLM，0 成本）
// 输入：whisper 本地 ASR 词级时间戳（runKeepOriginalAsr 产物，已带 is_filler 建议标记）
// 输出：建议删除列表（默认建议删除，最终由用户逐条确认，未确认不删）
// 铁律：宁可少标记，也不误删重要内容（任务书定版）。
//
// 建议分两类（2026-10-24 长停顿对齐剪映「智能剪口播」口径）：
//   - 词级冗余（reason: filler/repeat/phrase）：start/end 是词的时间戳，键 = 词 start；
//   - 长停顿（reason: pause）：词与词之间 ≥0.8s 的沉默（剪映同款阈值），
//     start/end 是间隙边界（不是词），键 = 间隙 start；只标词与词之间的停顿，
//     片头前/片尾后的沉默是自然呼吸，不标（保守）。剪除时两端各留 0.12s 呼吸
//     （见 compose.planCutRanges），避免真人出镜画面硬跳。

// 保护集：含数字或英文字母的词永不标记（价格/型号/品牌/数量是有效内容）
const PROTECT_RE = /[0-9A-Za-z]/;

// 长停顿标记阈值：与相邻词间隙 ≥0.8s（剪映「智能剪口播」同款口径）
const PAUSE_MIN_GAP = 0.8;

// 清理标点与空白，仅保留有效字符（对齐判定用）
function cleanText(s) {
  return String(s || '').replace(/[，。！？、；：,.!?;:\s]/g, '');
}

function isValidWord(w) {
  const t = String(w && w.word || '').trim();
  return t && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start;
}

/**
 * 冗余内容检测
 * @param {Array<{word:string,start:number,end:number,is_filler?:boolean}>} words ASR 词级时间戳
 * @returns {Array<{start:number,end:number,word:string,reason:'filler'|'repeat'|'phrase'|'pause'}>}
 *   建议删除列表（按 start 升序），前端以此渲染删除线（pause 渲染为停顿块），用户可逐条切换保留
 */
export function detectRedundancy(words = []) {
  const list = (Array.isArray(words) ? words : [])
    .filter(isValidWord)
    .sort((a, b) => a.start - b.start);
  if (!list.length) return [];

  const marked = new Array(list.length).fill(null); // {reason}

  // 规则一：语气填充词（上游 keepOriginal.js 已按宽集标记 is_filler：呃/嗯/那个/就是/这个…）
  // 含数字/字母的词不标（保护价格/型号/品牌），≤3 字的判断由上游 isVoiceSuggestFiller 保证
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    if (w.is_filler && !PROTECT_RE.test(w.word)) marked[i] = { reason: 'filler' };
  }

  // 规则二：明显连续重复的词。连续 ≥3 次相同词 → 第 2 次起标记；
  // 连续 2 次（如「很好很好」）可能是刻意强调，不标记（保守）
  let i = 0;
  while (i < list.length) {
    const cur = cleanText(list[i].word);
    if (!cur || PROTECT_RE.test(list[i].word)) { i++; continue; }
    let j = i;
    while (j + 1 < list.length && cleanText(list[j + 1].word) === cur && !PROTECT_RE.test(list[j + 1].word)) j++;
    const runLen = j - i + 1;
    if (runLen >= 3) {
      for (let k = i + 1; k <= j; k++) {
        if (!marked[k]) marked[k] = { reason: 'repeat' };
      }
    }
    i = j + 1;
  }

  // 规则三：明显重复的短语。紧邻的 2~4 词窗口与下一窗口完全相同、总字数 ≥6、
  // 且窗口内无保护词 → 标记第二窗口中尚未标记的词（第一窗口保留，宁少勿多）
  const cleanSeq = list.map((w) => cleanText(w.word));
  const protectedSeq = list.map((w) => PROTECT_RE.test(w.word));
  for (let n = 4; n >= 2; n--) {
    let s = 0;
    while (s + 2 * n <= list.length) {
      let win1 = '';
      let win2 = '';
      let protectedHit = false;
      for (let k = 0; k < n; k++) {
        win1 += cleanSeq[s + k];
        win2 += cleanSeq[s + n + k];
        if (protectedSeq[s + k] || protectedSeq[s + n + k]) protectedHit = true;
      }
      if (!protectedHit && win1.length >= 6 && win1 === win2) {
        for (let k = s + n; k < s + 2 * n; k++) {
          if (!marked[k]) marked[k] = { reason: 'phrase' };
        }
        s += 2 * n; // 命中后跳过两段窗口，避免重叠标记
      } else {
        s++;
      }
    }
  }

  const out = [];
  for (let k = 0; k < list.length; k++) {
    if (marked[k]) {
      out.push({ start: list[k].start, end: list[k].end, word: list[k].word, reason: marked[k].reason });
    }
  }

  // 规则四：长停顿。相邻词间隙 ≥0.8s 标为可删建议（键 = 间隙 start，与词 start 天然不冲突；
  // 片头前/片尾后不标；间隙与词删除建议不互斥——切点归并在 compose 层统一处理）。
  // 1e-9 容差：whisper 时间戳与累加浮点噪声不应把 0.8s 边界卡掉
  for (let k = 0; k + 1 < list.length; k++) {
    const gapStart = list[k].end;
    const gapEnd = list[k + 1].start;
    const gap = gapEnd - gapStart;
    if (gap >= PAUSE_MIN_GAP - 1e-9) {
      out.push({ start: gapStart, end: gapEnd, word: `停顿 ${gap.toFixed(1)}s`, reason: 'pause' });
    }
  }

  return out.sort((a, b) => a.start - b.start);
}
