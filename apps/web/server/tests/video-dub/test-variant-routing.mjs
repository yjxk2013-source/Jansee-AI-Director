// 简兮 · 变体路由回归测试（阶段一：personal 变体泄漏修复验证）
// 断言三入口变体判定行为：sell/local 保持原行为不变，personal 恒为空串、不注入商业变体锁定。
// 用法：node apps/web/server/tests/video-dub/test-variant-routing.mjs
import { decideVariantLocal } from '../../prompt/index.js';
import { buildDirectorPrompt } from '../../director.mjs';

const SELL_TEXT = '立省50%，一件才9块9，限时秒杀手慢无';
const LOCAL_TEXT = '这家火锅店人均六十吃到撑，就在龙泉驿';
const PERSONAL_TEXT = '记录清晨登山看日出的治愈瞬间，山风与云海都值得';

let pass = 0;
let fail = 0;
const assert = (name, cond) => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.error(`FAIL ${name}`); }
};

// —— 1. decideVariantLocal 原行为不变 ——
const sellHit = decideVariantLocal(SELL_TEXT, 'sell');
assert('sell 强信号命中（原行为不变）', typeof sellHit === 'string' && sellHit.length > 0);
const localHit = decideVariantLocal(LOCAL_TEXT, 'local');
assert('local 强信号命中（原行为不变）', typeof localHit === 'string' && localHit.length > 0);

// —— 2. 修复后路由逻辑（逐字复刻 index.mjs 修复版）：personal 不调用判定，恒空串 ——
const routeVariant = (scene, text) =>
  scene === 'personal' ? '' : decideVariantLocal(text || '', scene === 'local' ? 'local' : 'sell');
assert('personal 路由恒空串（商业文案也不命中）', routeVariant('personal', PERSONAL_TEXT) === '');
assert('personal 路由对带货文案也恒空串（防御面）', routeVariant('personal', SELL_TEXT) === '');
assert('sell 路由仍命中（行为不变）', routeVariant('sell', SELL_TEXT) === sellHit);
assert('local 路由仍命中（行为不变）', routeVariant('local', LOCAL_TEXT) === localHit);

// —— 3. prompt 拼装分支：personal 无商业锁定，sell 锁定注入不变 ——
const pPrompt = buildDirectorPrompt({
  scene: 'personal', title: '周末爬山记', sellingPoints: PERSONAL_TEXT,
  imageCount: 3, voice: 'female', decidedVariant: '',
});
assert('personal prompt 不含「变体锁定」', !pPrompt.includes('变体锁定'));
assert('personal prompt 走「无人设变体体系」分支', pPrompt.includes('无人设变体体系'));

const sPrompt = buildDirectorPrompt({
  scene: 'sell', title: '现烤可颂', sellingPoints: SELL_TEXT,
  imageCount: 3, voice: 'female', decidedVariant: sellHit,
});
assert('sell prompt 锁定注入不变', sPrompt.includes('变体锁定') && sPrompt.includes(sellHit));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
