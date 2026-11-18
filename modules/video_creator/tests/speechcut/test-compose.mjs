// 简兮口播模块 · 测试：切点规划 planCutRanges + 时间轴映射 buildShiftFn（纯函数，零依赖零付费）
// 运行：在仓库根执行 node modules/video_creator/tests/speechcut/test-compose.mjs
import { planCutRanges, buildShiftFn } from '../../speechcut/compose.js';

const PASS = [];
const FAIL = [];
function assert(name, cond, detail = '') {
  (cond ? PASS : FAIL).push(name);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : `（实际 ${detail}）`}`);
}
const W = (word, start, end) => ({ word, start, end });
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// 用例基座：三句话 0-2s / 5-7s / 9-12s，中间词间有自然停顿
const WORDS = [
  W('第一句话', 0.2, 1.8),
  W('呃', 4.6, 4.9),        // 句间停顿里的填充词
  W('第二句话', 5.2, 6.9),
  W('第三句话', 9.1, 11.8),
];

// 1. 空删除集：整片保留
{
  const p = planCutRanges({ words: WORDS, deletedStarts: new Set(), durationSec: 12 });
  assert('1 空删除集整片保留', p.keepRanges.length === 1 && near(p.keepRanges[0][0], 0) && near(p.keepRanges[0][1], 12) && near(p.keepTotal, 12), JSON.stringify(p.keepRanges));
}

// 2. 单删中间词：切点取间隙中点（呃[4.6,4.9] 前间隙 4.6-1.8=2.8 → 左切点=1.8+1.4=3.2；后间隙 5.2-4.9=0.3 → 右切点=4.9+0.15=5.05）
{
  const p = planCutRanges({ words: WORDS, deletedStarts: new Set([4.6]), durationSec: 12 });
  const c = p.cutRanges[0];
  assert('2a 单删块边界正确', p.cutRanges.length === 1, JSON.stringify(p.cutRanges));
  assert('2b 左切点=间隙中点 3.2', near(c.start, 3.2), String(c.start));
  assert('2c 右切点=间隙中点 5.05', near(c.end, 5.05), String(c.end));
  assert('2d 保留两段且片头完整', p.keepRanges.length === 2 && near(p.keepRanges[0][0], 0), JSON.stringify(p.keepRanges));
  assert('2e 删除时长=1.85', near(p.cutTotal, 1.85), String(p.cutTotal));
}

// 3. 词紧连无间隙：不外扩越界，切点=词边界（宁留残音不吞字）
{
  const words = [W('前词', 1.0, 2.0), W('那个', 2.0, 2.5), W('后词', 2.5, 3.5)];
  const p = planCutRanges({ words, deletedStarts: new Set([2.0]), durationSec: 4 });
  const c = p.cutRanges[0];
  assert('3a 紧连时切点不越前词尾', c.start >= 2.0 - 1e-9 && c.start <= 2.0, `start=${c.start}`);
  assert('3b 紧连时切点不越后词头', c.end <= 2.5 && c.end >= 2.5 - 1e-9, `end=${c.end}`);
}

// 4. 相邻删除词合并为单块；间隙小走固定外扩 0.06
{
  const words = [
    W('前词', 0, 1.0),
    W('那个', 3.0, 3.4), W('就是', 3.4, 3.8), // 两删除词相邻 → 合并
    W('后词', 5.0, 6.0),
  ];
  const p = planCutRanges({ words, deletedStarts: new Set([3.0, 3.4]), durationSec: 7 });
  assert('4a 相邻删除词合并为一块', p.cutRanges.length === 1, JSON.stringify(p.cutRanges));
  const c = p.cutRanges[0];
  // 左间隙 3.0-1.0=2.0>0.16 → 中点 2.0；右间隙 5.0-3.8=1.2>0.16 → 中点 4.4
  assert('4b 合并块切点正确', near(c.start, 2.0) && near(c.end, 4.4), `${c.start}-${c.end}`);
}

// 5. 删首词：从片头删；删尾词：删到片尾
{
  const p1 = planCutRanges({ words: WORDS, deletedStarts: new Set([0.2]), durationSec: 12 });
  assert('5a 删首词从片头删', near(p1.cutRanges[0].start, 0) && p1.keepRanges[0][0] > 0, JSON.stringify(p1));
  const p2 = planCutRanges({ words: WORDS, deletedStarts: new Set([9.1]), durationSec: 12 });
  const c2 = p2.cutRanges[p2.cutRanges.length - 1];
  assert('5b 删尾词删到片尾', near(c2.end, 12), JSON.stringify(c2));
}

// 6. 全删安全拦截 TOO_SHORT
{
  const words = [W('那个', 0.5, 1.0)];
  const p = planCutRanges({ words, deletedStarts: new Set([0.5]), durationSec: 6 });
  assert('6 全删拦截 TOO_SHORT', p.error?.code === 'TOO_SHORT', JSON.stringify(p));
}

// 7. 保留过短拦截（删大块后仅剩 <1s）
{
  const words = [W('开头', 0.2, 0.4), W('超长废话', 0.5, 5.9), W('尾', 5.95, 6.2)];
  const p = planCutRanges({ words, deletedStarts: new Set([0.5]), durationSec: 6.3 });
  assert('7 保留 <1s 拦截', p.error?.code === 'TOO_SHORT', JSON.stringify(p));
}

// 8. 未知 start（前端伪造/越界）被忽略，不产生任何删除
{
  const p = planCutRanges({ words: WORDS, deletedStarts: new Set([99, 4.6]), durationSec: 12 });
  assert('8 未知 start 忽略、有效 start 生效', p.cutRanges.length === 1 && near(p.cutTotal, 1.85), JSON.stringify(p));
}

// 9. 无词输入 NO_WORDS
{
  const p = planCutRanges({ words: [], deletedStarts: new Set([1]), durationSec: 5 });
  assert('9 无词返回 NO_WORDS', p.error?.code === 'NO_WORDS');
}

// 10. 时间轴映射：删除 3.2-5.05 后，5.2 → 5.2-1.85=3.35；0.2 → 0.2 不变
{
  const p = planCutRanges({ words: WORDS, deletedStarts: new Set([4.6]), durationSec: 12 });
  const shift = buildShiftFn(p.keepRanges);
  assert('10a 保留段前词不偏移', near(shift(0.2), 0.2), String(shift(0.2)));
  assert('10b 删除段后词前移 cutTotal', near(shift(5.2), 3.35), String(shift(5.2)));
  assert('10c 片尾词前移量一致', near(shift(11.8), 9.95), String(shift(11.8)));
}

// 11. 空删除集的映射为恒等
{
  const shift = buildShiftFn([[0, 12]]);
  assert('11 恒等映射', near(shift(3.7), 3.7));
}

console.log(`\n===== compose 结果：${PASS.length} PASS / ${FAIL.length} FAIL =====`);
process.exit(FAIL.length ? 1 : 0);
