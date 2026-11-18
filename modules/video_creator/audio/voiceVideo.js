// 简兮合成引擎 · voiceVideo.js —— AI 配音字幕分段（引擎纯执行层）
// 历史：本文件原含口播视频合成三路径（保留原声 / AI 配音 / 音画对齐），
// 2026-10-28 AI 配音链路统一收敛到 packages/video-dub（dubKernel），旧合成实现整体删除。
// 现仅保留 buildDubbedCuesFromText：从纯文案 + 配音总时长重建字幕分段（按字符占比均摊），
// 供 storyboard.js 在无词级时间戳的 AI 配音分支使用。

// 从纯文案 + 配音总时长 重建字幕分段（AI 配音替换分支用：无词级时间戳，按字符占比均摊）
export function buildDubbedCuesFromText(text = '', audioDur = 0) {
  const raw = String(text || '').trim();
  const dur = Number(audioDur) || 0;
  if (!raw || dur <= 0.2) return [];
  const clean = (s) => String(s || '').replace(/[，。！？、；：,.!?;:\s]/g, '');

  // ① 按句号/叹号/问号/分号切句，长句再按每段 ≈12 字内折行
  const sentences = raw
    .split(/(?<=[。！？!?；;])\s*/)
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const chunks = [];
  for (const s of sentences) {
    const cur = clean(s);
    if (!cur) continue;
    if (cur.length <= 12) {
      chunks.push({ text: s, chars: cur.length });
      continue;
    }
    for (let i = 0; i < cur.length; i += 12) {
      const seg = cur.slice(i, i + 12);
      if (seg) chunks.push({ text: seg, chars: seg.length });
    }
  }
  if (!chunks.length) {
    const cur = clean(raw);
    for (let i = 0; i < cur.length; i += 12) {
      const seg = cur.slice(i, i + 12);
      if (seg) chunks.push({ text: seg, chars: seg.length });
    }
  }

  // ② 按有效字符占比均摊时长，产出与音频同步的字幕时间轴
  const total = chunks.reduce((a, c) => a + c.chars, 0) || 1;
  let t = 0;
  const cues = [];
  for (const c of chunks) {
    const partDur = Math.max(1.2, (c.chars / total) * dur);
    const end = Math.min(dur, t + partDur);
    if (end > t + 0.05)
      cues.push({ content: c.text, audioStart: Number(t.toFixed(2)), audioEnd: Number(end.toFixed(2)) });
    t = end;
  }
  return cues;
}
