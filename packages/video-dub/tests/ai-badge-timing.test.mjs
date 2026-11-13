import test from 'node:test';
import assert from 'node:assert/strict';
import { ENDING_TAIL } from '@jansee/ending-kit';
import { AI_BADGE } from '@jansee/subtitle-kit/aiBadge.js';
import { buildAiBadgeOverlay } from '@jansee/subtitle-kit/subtitle.js';

test('AI显性标识断言：默认只在开头2.5s展示，片尾由ending-kit原生内置，绝不重复烧录', () => {
  // 模拟源视频 10 秒
  const baseDur = 10.0;
  const tailSec = ENDING_TAIL.endHoldSec + ENDING_TAIL.ctaSec;
  const totalDur = baseDur + tailSec;

  // 1. 默认调用（全平台标配）：只生成开头 2.5s 标识，防止与收束卡内置角标双层叠加
  const filtersDefault = buildAiBadgeOverlay(null, totalDur, 1080);
  assert.equal(filtersDefault.length, 1, '全平台默认仅输出开头段标识，杜绝结尾重复烧录');
  assert.ok(filtersDefault[0].includes('AI'), '开头段必须包含AI标识');

  // 2. 显式开启 withTail 时才生成两段
  const filtersWithTail = buildAiBadgeOverlay(null, totalDur, 1080, { withTail: true });
  assert.equal(filtersWithTail.length, 2, '显式传 withTail 时才生成结尾标识');
});
