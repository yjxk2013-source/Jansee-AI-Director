// @jansee/speech-cut · 长停顿检测与切点规划测试（纯函数，零 IO）
// 覆盖：detectRedundancy 规则四（pause 建议）、planCutRanges pauseCuts 收缩与归并、
//       与词删除块重叠时的合并、字幕 cue 不受 pause 影响（pause 区间内无词）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRedundancy } from '../detect.js';
import { planCutRanges, buildShiftFn } from '../compose.js';

// 构造一段词级时间轴：词之间可控间隙
function wordsFromGaps(gaps) {
  // gaps: [{word, gapBefore}] 依次铺开，首词从 1.0s 开始
  let t = 1.0;
  return gaps.map((g) => {
    const start = t;
    t += 0.3; // 每个词 0.3s
    const end = t;
    t += g.gapBefore || 0; // 词后间隙
    return { word: g.word, start, end };
  });
}

test('detect：词间隙 ≥0.8s 标记为 pause 建议，<0.8s 不标', () => {
  const words = wordsFromGaps([
    { word: '今天', gapBefore: 1.2 },   // 长停顿 → 标
    { word: '我们', gapBefore: 0.3 },   // 正常停顿 → 不标
    { word: '聊聊', gapBefore: 0.8 },   // 恰好 0.8 → 标（≥）
    { word: '发货', gapBefore: 0.1 },
  ]);
  const out = detectRedundancy(words);
  const pauses = out.filter((s) => s.reason === 'pause');
  assert.equal(pauses.length, 2, `应标 2 处长停顿，实际 ${JSON.stringify(pauses)}`);
  assert.equal(pauses[0].start, words[0].end);
  assert.equal(pauses[0].end, words[1].start);
  assert.match(pauses[0].word, /停顿 1\.2s/);
});

test('detect：片头前/片尾后的沉默不标（保守）', () => {
  const words = [
    { word: '开头', start: 3.0, end: 3.3 },  // 0~3s 片头沉默不标
    { word: '结尾', start: 3.4, end: 3.7 },  // 之后到片尾不标
  ];
  const out = detectRedundancy(words);
  assert.equal(out.filter((s) => s.reason === 'pause').length, 0, JSON.stringify(out));
});

test('detect：词冗余与 pause 键不冲突，输出按 start 升序', () => {
  const words = wordsFromGaps([
    { word: '呃', gapBefore: 1.0 },
    { word: '那个', gapBefore: 1.0 },
    { word: '好的', gapBefore: 0.0 },
  ]);
  words[0].is_filler = true;
  words[1].is_filler = true;
  const out = detectRedundancy(words);
  const starts = out.map((s) => s.start);
  assert.deepEqual([...starts].sort((a, b) => a - b), starts, '输出必须按 start 升序');
  const keys = out.map((s) => `${s.start}:${s.reason}`);
  assert.equal(new Set(out.map((s) => s.start)).size, out.length, '键不得重复');
  assert.ok(out.some((s) => s.reason === 'filler') && out.some((s) => s.reason === 'pause'), keys.join('|'));
});

test('planCutRanges：pause 块两端收缩 0.12s，剪除量 = 间隙 - 0.24', () => {
  const words = [
    { word: '前', start: 1.0, end: 1.3 },
    { word: '后', start: 2.5, end: 2.8 },   // 间隙 1.2s
  ];
  const pause = [{ start: 1.3, end: 2.5 }];
  const plan = planCutRanges({ words, deletedStarts: new Set(), durationSec: 10, pauseCuts: pause });
  assert.equal(plan.cutRanges.length, 1);
  const cut = plan.cutRanges[0];
  assert.ok(Math.abs(cut.start - (1.3 + 0.12)) < 1e-9, `start=${cut.start}`);
  assert.ok(Math.abs(cut.end - (2.5 - 0.12)) < 1e-9, `end=${cut.end}`);
  assert.ok(Math.abs((cut.end - cut.start) - (1.2 - 0.24)) < 1e-9);
});

test('planCutRanges：pause 与相邻词删除块重叠时正确归并', () => {
  // 词「嗯」紧邻长停顿，两者同时删除应合并为一个连续块
  const words = [
    { word: '说', start: 1.0, end: 1.3 },
    { word: '嗯', start: 1.5, end: 1.8 },
    { word: '好', start: 3.0, end: 3.3 },   // 1.8~3.0 间隙 1.2s
  ];
  const plan = planCutRanges({
    words,
    deletedStarts: new Set([1.5]),
    durationSec: 10,
    pauseCuts: [{ start: 1.8, end: 3.0 }],
  });
  // 「嗯」块（切点保守外扩）与 pause 块（收缩后 1.92~2.88）应归并成一块
  assert.equal(plan.cutRanges.length, 1, JSON.stringify(plan.cutRanges));
  assert.ok(plan.cutRanges[0].start < 1.6 && plan.cutRanges[0].end > 2.8);
});

test('planCutRanges：过短 pause（收缩后 <0.4s）被丢弃', () => {
  // 0.5s 间隙虽低于 0.8 标记阈值，但伪造传入也安全
  const words = [
    { word: '前', start: 1.0, end: 1.3 },
    { word: '后', start: 1.8, end: 2.1 },
  ];
  const plan = planCutRanges({ words, deletedStarts: new Set(), durationSec: 10, pauseCuts: [{ start: 1.3, end: 1.8 }] });
  assert.equal(plan.cutRanges.length, 0, JSON.stringify(plan.cutRanges));
  assert.equal(plan.keepRanges.length, 1);
});

test('buildShiftFn：pause 剪除后字幕时间轴正确重映射（区间内无词，天然安全）', () => {
  const words = [
    { word: '前', start: 1.0, end: 1.3 },
    { word: '后', start: 2.5, end: 2.8 },
  ];
  const plan = planCutRanges({ words, deletedStarts: new Set(), durationSec: 10, pauseCuts: [{ start: 1.3, end: 2.5 }] });
  const shift = buildShiftFn(plan.keepRanges);
  assert.ok(Math.abs(shift(1.0) - 1.0) < 1e-9);          // 保留区间 1 内不动
  assert.ok(Math.abs(shift(2.5) - (2.5 - 0.96)) < 1e-9); // 越过一个 pause 删除块（1.42~2.38，长 0.96）
});
