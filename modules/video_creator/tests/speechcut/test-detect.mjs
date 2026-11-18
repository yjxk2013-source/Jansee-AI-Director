// 简兮口播模块 · 测试：冗余规则检测 detectRedundancy（纯函数，零依赖零付费）
// 运行：在仓库根执行 node modules/video_creator/tests/speechcut/test-detect.mjs
import { detectRedundancy } from '../../speechcut/detect.js';

const PASS = [];
const FAIL = [];
function assert(name, cond, detail = '') {
  (cond ? PASS : FAIL).push(name);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : `（实际 ${detail}）`}`);
}
// 辅助：按词文本找建议（同词多次时取第一个未消费的）
function markOf(res, word, nth = 1) {
  const hits = res.filter((r) => r.word === word);
  return hits[nth - 1] || null;
}

// 约定：detect 的输入为 runKeepOriginalAsr 产物（is_filler 已按宽集标记，含「这个」）
const W = (word, start, end, is_filler = false) => ({ word, start, end, is_filler });

// 1. 空输入
assert('1 空输入返回空建议', detectRedundancy([]).length === 0);

// 2. 语气填充词标记（含「这个」宽集）
{
  const res = detectRedundancy([W('大家好', 0, 1), W('嗯', 1, 1.2, true), W('这个', 1.3, 1.6, true), W('产品很好', 1.7, 2.5)]);
  assert('2a 填充词「嗯」被标记', markOf(res, '嗯')?.reason === 'filler');
  assert('2b 宽集填充词「这个」被标记', markOf(res, '这个')?.reason === 'filler');
  assert('2c 正文词不被标记', !markOf(res, '产品很好') && !markOf(res, '大家好'), JSON.stringify(res));
}

// 3. 连续重复词 ≥3 次标记第 2 次起；2 次是强调不标记
{
  const res = detectRedundancy([W('好', 0, 0.5), W('好', 0.5, 1), W('好', 1, 1.5), W('很好', 2, 2.5), W('很好', 2.5, 3)]);
  const goodMarks = res.filter((r) => r.word === '好');
  assert('3a 连续 3 次重复标记第 2、3 次', goodMarks.length === 2 && goodMarks.every((r) => r.reason === 'repeat'), JSON.stringify(goodMarks));
  assert('3b 连续 2 次强调性重复不标记', res.filter((r) => r.word === '很好').length === 0);
}

// 4. 保护集：含数字/字母的词永不标记（价格/型号/品牌）
{
  const res = detectRedundancy([
    W('A4', 0, 0.5, true), W('纸', 0.5, 0.9),
    W('iPhone', 1, 1.5, true), W('Pro', 1.5, 2, true),
    W('9块9', 2, 2.5, true),
  ]);
  assert('4 含数字/字母的词全部不标记', res.length === 0, JSON.stringify(res));
}

// 5. 相邻重复短语：两窗完全相同且 ≥6 字 → 只标第二窗
{
  const res = detectRedundancy([
    W('这个', 0, 0.4), W('东西', 0.4, 0.8), W('真的', 0.8, 1.2), W('很好', 1.2, 1.6),
    W('这个', 1.6, 2.0), W('东西', 2.0, 2.4), W('真的', 2.4, 2.8), W('很好', 2.8, 3.2),
  ]);
  const markedStarts = res.map((r) => r.start);
  assert('5a 重复短语第二窗全部标记', res.length === 4 && markedStarts.every((s) => s >= 1.6), JSON.stringify(res));
  assert('5b 第一窗完整保留', res.every((r) => r.start < 0.4 || r.start >= 1.6));
}

// 6. 短语窗口含保护词时不标记
{
  const res = detectRedundancy([
    W('这个', 0, 0.4), W('型号', 0.4, 0.8), W('X100', 0.8, 1.2), W('很好', 1.2, 1.6),
    W('这个', 1.6, 2.0), W('型号', 2.0, 2.4), W('X100', 2.4, 2.8), W('很好', 2.8, 3.2),
  ]);
  assert('6 窗口含型号保护词不触发短语标记', res.length === 0, JSON.stringify(res));
}

// 7. 输出按 start 升序且每词至多一条
{
  const res = detectRedundancy([W('呃', 0, 0.3, true), W('那个', 0.4, 0.7, true), W('那个', 0.8, 1.1, true)]);
  const starts = res.map((r) => r.start);
  assert('7 输出升序', starts.every((s, i) => i === 0 || s > starts[i - 1]), JSON.stringify(starts));
}

// 8. 无词/全保护输入安全返回
{
  assert('8 全保护词输入返回空', detectRedundancy([W('V3', 0, 1, true)]).length === 0);
}

console.log(`\n===== detect 结果：${PASS.length} PASS / ${FAIL.length} FAIL =====`);
process.exit(FAIL.length ? 1 : 0);
