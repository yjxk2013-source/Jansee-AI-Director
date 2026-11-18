import test from 'node:test';
import assert from 'node:assert/strict';

test('视频配音时间轴自适应压实算法验证', () => {
  // 模拟场景 1: 10 秒视频，安全截止时间点 safeVoiceEnd = 10 - 0.8 = 9.2s
  // 3 段旁白，TTS 耗时分别为 2.5s, 3.0s, 2.8s，合计 8.3s
  // 期望停顿默认 0.5s * 2 = 1.0s，名义总长 9.3s > 9.2s
  const baseDur = 10.0;
  const safeVoiceEnd = Math.max(1.5, +(baseDur - 0.8).toFixed(2)); // 9.2
  const segments = [
    { line: '段落1', pauseAfter: 0.5 },
    { line: '段落2', pauseAfter: 0.5 },
    { line: '段落3', pauseAfter: 0.5 },
  ];
  const ttsResults = [
    { durationSec: 2.5 },
    { durationSec: 3.0 },
    { durationSec: 2.8 },
  ];

  const ttsDurs = segments.map((_, i) => ttsResults[i]?.durationSec || 0);
  const pureVoiceTotal = ttsDurs.reduce((a, b) => a + b, 0); // 8.3
  const gapsCount = Math.max(0, segments.length - 1); // 2
  const desiredPauses = segments.slice(0, -1).map((s) => s.pauseAfter); // [0.5, 0.5]
  const desiredTotalPause = desiredPauses.reduce((a, b) => a + b, 0); // 1.0
  const nominalTotal = pureVoiceTotal + desiredTotalPause; // 9.3

  assert.ok(nominalTotal > safeVoiceEnd);

  const availPausePool = Math.max(0, safeVoiceEnd - pureVoiceTotal); // 0.9s
  const scale = availPausePool / desiredTotalPause; // 0.9
  const actualPauses = desiredPauses.map((p) => Math.max(0.08, +(p * scale).toFixed(2))); // [0.45, 0.45]

  let acc = 0;
  const parts = [];
  for (let i = 0; i < segments.length; i += 1) {
    const start = +acc.toFixed(2);
    const end = +(acc + ttsDurs[i]).toFixed(2);
    parts.push({ start, end });
    const gap = i < gapsCount ? actualPauses[i] : 0;
    acc = +(end + gap).toFixed(2);
  }

  const narrationTotal = parts[parts.length - 1].end;
  // 旁白最末尾必须落在 safeVoiceEnd (9.2s) 内，且严格小于画面时长 10s
  assert.ok(narrationTotal <= safeVoiceEnd, `narrationTotal (${narrationTotal}) 应 <= safeVoiceEnd (${safeVoiceEnd})`);
  assert.ok(narrationTotal < baseDur - 0.6, `最后一句台词收尾必须留出 >0.6s 留白，防止被淡出或黑幕吃掉`);
});
