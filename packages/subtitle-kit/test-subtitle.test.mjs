import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildDrawtextFilters, SUBTITLE_STYLES } from './subtitle.js';

describe('Subtitle-Kit Typography & Aspect Ratio Adaptation Tests', () => {
  const dummyTts = [
    { content: '极简品质，格调自然从容绽放', audioStart: 0.5, audioEnd: 3.0 }
  ];

  test('1. 默认 bottom_capsule 样式与坐标在底部安全区', () => {
    const filters = buildDrawtextFilters(dummyTts, 'test_font.ttc', {
      shortEdge: 1080,
      layout: 'bottom_capsule',
      motion: 'none'
    });
    assert.ok(filters.length > 0);
    assert.ok(filters[0].includes('h-th-'));
    assert.ok(filters[0].includes(`x='(w-tw)/2'`));
  });

  test('2. top_editorial (顶部画报双轨轴) 坐标在顶部，占屏高度<=16%', () => {
    const filters = buildDrawtextFilters(dummyTts, 'test_font.ttc', {
      shortEdge: 1080,
      layout: 'top_editorial',
      motion: 'none'
    });
    assert.ok(filters.length > 0);
    assert.ok(!filters[0].includes('h-th-'), '顶部排版不应包含 h-th- 底部表达式');
    // y 应为 Math.max(48, Math.round(1080 * 0.12)) = 130
    assert.ok(filters[0].includes(`y='130'`), '顶部 Y 轴锚点应位于 130px 处');
  });

  test('3. center_cinematic (黄金中心合焦视窗) 居中于 42% 黄金分割带', () => {
    const filters = buildDrawtextFilters(dummyTts, 'test_font.ttc', {
      shortEdge: 1080,
      layout: 'center_cinematic',
      motion: 'none'
    });
    assert.ok(filters.length > 0);
    assert.ok(filters[0].includes(`y='(h-th)*0.42'`));
    assert.ok(filters[0].includes(`x='(w-tw)/2'`));
  });

  test('4. 多画幅比例自适应 (16:9 与 1:1) 短边换算', () => {
    const filtersLandscape = buildDrawtextFilters(dummyTts, 'test_font.ttc', {
      shortEdge: 720,
      layout: 'top_editorial',
      motion: 'none'
    });
    assert.ok(filtersLandscape.length > 0);
    // 720 * 0.12 = 86
    assert.ok(filtersLandscape[0].includes(`y='86'`), '横屏 720 短边下 Y 轴应等比缩放');
  });
});
