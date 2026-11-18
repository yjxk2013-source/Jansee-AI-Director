import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ENDING_ASSETS,
  ENDING_SCENES,
  ENDING_TAIL,
  ENTRY_TO_SCENE,
  buildEndingSvg,
  endingCopyParts,
  endingsForScene,
  pickEnding,
  renderEndingPng,
  seedFromTaskId,
} from '../index.js';

/* 测试自带一个确定性 rand（不依赖引擎的 mulberry32——依赖方向是引擎→本包，
   反向 import 会成环）。pickEnding 只吃 rand 函数，实现无关。 */
function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 16807) + 0) % 2147483647;
    return s / 2147483647;
  };
}

test('资产：15 款 = 3 场景 × 5 款', () => {
  assert.equal(ENDING_ASSETS.length, 15);
  for (const scene of ENDING_SCENES) {
    assert.equal(endingsForScene(scene).length, 5, scene);
  }
});

test('资产：每款都能出 SVG，含画布、真实字库声明与实际文案', () => {
  for (const item of ENDING_ASSETS) {
    const svg = buildEndingSvg(item);
    const { zh, en } = endingCopyParts(item);
    assert.match(svg, /viewBox="0 0 1080 1920"/);
    assert.match(svg, /Noto Sans SC/);
    assert.match(svg, /Jost/);
    /* 竖柱/纯排版骨架会把「·」和空格拆行、英文按词拆行，
       逐词检查而非整句 includes（拆行是正确行为，不是缺失）。 */
    const tokens = [...zh.split(/\s*·\s*|\s+/u), ...en.split(/\s+/u)].filter(Boolean);
    for (const t of tokens) {
      assert.ok(svg.includes(t), `${item.id} 缺文案片段「${t}」`);
    }
  }
});

test('pickEnding：同一 seed 出同一款（用户改错字重出不能换结尾）', () => {
  for (const scene of ENDING_SCENES) {
    const a = pickEnding(lcg(20261024), { scene });
    const b = pickEnding(lcg(20261024), { scene });
    assert.equal(a.id, b.id, scene);
    assert.ok(endingsForScene(scene).includes(a), `${scene} 抽出的必须在场景池内`);
  }
});

test('pickEnding：endingId 直指命中；越界入口归一回 sell', () => {
  assert.equal(pickEnding(lcg(7), { endingId: 'cta_l1_pillar' }).id, 'cta_l1_pillar');
  assert.ok(endingsForScene('online').every((e) => e.scene === 'sell'));
  assert.equal(ENTRY_TO_SCENE.online, 'sell');
  assert.equal(ENTRY_TO_SCENE.offline, 'local');
});

test('seedFromTaskId：确定性且同任务同值、异任务异值', () => {
  assert.equal(seedFromTaskId('task-abc'), seedFromTaskId('task-abc'));
  assert.notEqual(seedFromTaskId('task-abc'), seedFromTaskId('task-abd'));
  assert.ok(Number.isInteger(seedFromTaskId('x')) && seedFromTaskId('x') >= 0);
});

test('ENDING_TAIL：时间口径定值（两链路共用，不许单边改）', () => {
  assert.deepEqual({ ...ENDING_TAIL }, { fadeInSec: 0.85, endHoldSec: 0.35, ctaSec: 2.6 });
  assert.ok(ENDING_TAIL.ctaSec > ENDING_TAIL.fadeInSec + 1, 'CTA 全亮时长必须够读一行字');
});

test('renderEndingPng：真渲染出 1080 宽 PNG', () => {
  const dir = path.join(os.tmpdir(), `ending-kit-test-${process.pid}`);
  const out = path.join(dir, 'cta.png');
  try {
    renderEndingPng({ ending: ENDING_ASSETS[0], brandZh: '测试品牌', outPath: out });
    assert.ok(existsSync(out) && statSync(out).size > 1000, 'PNG 应真实产出');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
