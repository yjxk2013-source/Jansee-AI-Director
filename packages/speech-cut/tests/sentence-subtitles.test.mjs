// @jansee/speech-cut · 整句字幕聚合与单行呈现测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSubtitleSegments } from '../../../modules/video_creator/asr/trim.js';
import { buildDrawtextFilters } from '../../subtitle-kit/subtitle.js';

test('groupSubtitleSegments：自然长句（<=16字）整句呈现，不再按6字粗暴切碎', () => {
  // 模拟一句完整口播台词：“今天给大家推荐一款超高颜值的钛金机械手表” （19字）
  const words = [
    { word: '今天', start: 1.0, end: 1.3 },
    { word: '给大家', start: 1.3, end: 1.8 },
    { word: '推荐一款', start: 1.8, end: 2.4 },
    { word: '超高颜值', start: 2.4, end: 3.0 },
    { word: '的钛金', start: 3.0, end: 3.4 },
    { word: '机械手表。', start: 3.4, end: 4.1 },
  ];

  const segs = groupSubtitleSegments(words);
  // 整句话带句末标点，应聚合成 1~2 个自然整句，绝不会切成原来的 4~5 个碎片
  assert.ok(segs.length <= 2, `期望不超过 2 句，实际 ${segs.length} 句：${JSON.stringify(segs)}`);
  const fullText = segs.map((s) => s.text).join('');
  assert.equal(fullText, '今天给大家推荐一款超高颜值的钛金机械手表');
});

test('groupSubtitleSegments：弱逗号在字数较少时不切断，确保连贯语意', () => {
  const words = [
    { word: '其实，', start: 0.5, end: 0.9 }, // 3字带逗号，不应割裂成独立孤儿句
    { word: '这款腕表', start: 0.9, end: 1.5 },
    { word: '非常低调有质感。', start: 1.5, end: 2.6 },
  ];

  const segs = groupSubtitleSegments(words);
  // 应聚合成 1 整句：“其实这款腕表非常低调有质感”
  assert.equal(segs.length, 1, `应整合成 1 句，实际 ${segs.length}：${JSON.stringify(segs)}`);
  assert.equal(segs[0].text, '其实这款腕表非常低调有质感');
  assert.equal(segs[0].start, 0.5);
  assert.equal(segs[0].end, 2.6);
});

test('groupSubtitleSegments：换气长停顿（>=0.45s）自然平滑分句', () => {
  const words = [
    { word: '第一句话说完', start: 1.0, end: 1.8 },
    // 停顿 0.6s 换气
    { word: '第二句话开始', start: 2.4, end: 3.2 },
  ];

  const segs = groupSubtitleSegments(words);
  assert.equal(segs.length, 2, '遇到显著换气停顿应分为 2 句');
  assert.equal(segs[0].text, '第一句话说完');
  assert.equal(segs[1].text, '第二句话开始');
});

test('buildDrawtextFilters：配置 maxPerLine=18 时单行完整呈现 16 字整句', () => {
  const cues = [
    { content: '今天给大家推荐一款高颜值的机械表', audioStart: 1.0, audioEnd: 3.5 }
  ];
  const filters = buildDrawtextFilters(cues, 'fake_font.ttc', {
    maxPerLine: 18,
    motion: 'smooth_fade'
  });
  // 必须只生成 1 个 drawtext 过滤器，整句在 1.0~3.5s 稳稳呈现，绝不均分轮播
  assert.equal(filters.length, 1, `期望 1 个过滤器，实际生成 ${filters.length} 个`);
  assert.ok(filters[0].includes('smooth_fade') || filters[0].includes('alpha'), '应带有平滑淡入动效');
  assert.ok(filters[0].includes('enable=\'between(t,1.00,3.50)\''), '应完整覆盖 1.00 到 3.50 秒整段时长');
});
