// 简兮口播模块 · 测试：BFF 编排层同步校验与状态机（不触发真实 ASR/合成，零付费零 ffmpeg）
// 运行：在仓库根执行 node apps/web/server/tests/speechcut/test-bff.mjs
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startSpeechProduce } from '@jansee/speech-cut';

const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'speechcut-bff-')); // 受理后的异步段产物目录（本测试不等待其结果）

const PASS = [];
const FAIL = [];
function check(name, fn) {
  try { fn(); PASS.push(name); console.log(`PASS ${name}`); }
  catch (e) { FAIL.push(name); console.log(`FAIL ${name}（${e.message}）`); }
}

const inMemoryTasks = new Map();
const mk = (id, rec) => inMemoryTasks.set(id, { kind: 'speechcut', phase: 'analyze', ...rec });

// 1. 任务不存在
check('1 任务不存在 → 40401', () => {
  assert.throws(() => startSpeechProduce({ taskId: 'spk_none', deletedStarts: [], inMemoryTasks }),
    (e) => e.code === 40401);
});

// 2. kind 不符（图片/配音任务混入）
check('2 kind 非 speechcut → 40401', () => {
  inMemoryTasks.set('task_img', { kind: undefined, status: 'completed' });
  assert.throws(() => startSpeechProduce({ taskId: 'task_img', deletedStarts: [], inMemoryTasks }),
    (e) => e.code === 40401);
});

// 3. 重复提交：producing / completed 状态一律拒绝
check('3a producing 重复提交 → 40901', () => {
  mk('spk_a', { status: 'producing', words: [{ word: '词', start: 0, end: 1 }] });
  assert.throws(() => startSpeechProduce({ taskId: 'spk_a', deletedStarts: [], inMemoryTasks }),
    (e) => e.code === 40901);
});
check('3b completed 重复提交 → 40901', () => {
  mk('spk_b', { status: 'completed', words: [{ word: '词', start: 0, end: 1 }] });
  assert.throws(() => startSpeechProduce({ taskId: 'spk_b', deletedStarts: [], inMemoryTasks }),
    (e) => e.code === 40901);
});

// 4. analyze 未完成（processing/failed）→ 40902
check('4a processing（识别中）→ 40902', () => {
  mk('spk_c', { status: 'processing', words: [] });
  assert.throws(() => startSpeechProduce({ taskId: 'spk_c', deletedStarts: [], inMemoryTasks }),
    (e) => e.code === 40902);
});
check('4b failed 且词表为空（analyze 失败）→ 40902 需重新分析', () => {
  mk('spk_d', { status: 'failed', words: [] });
  assert.throws(() => startSpeechProduce({ taskId: 'spk_d', deletedStarts: [], inMemoryTasks, storageOutputsDir: OUT_DIR }),
    (e) => e.code === 40902);
});

// 5. 全删拦截
check('5 全部删除 → 40005', () => {
  mk('spk_e', { status: 'analyzed', words: [{ word: '词', start: 0.5, end: 1 }, { word: '句', start: 2, end: 3 }] });
  assert.throws(() => startSpeechProduce({ taskId: 'spk_e', deletedStarts: [0.5, 2], inMemoryTasks }),
    (e) => e.code === 40005);
});

// 6. 计费：与现有出片路由同口径（每次任务 200 积分由 index.mjs 注入闭包，此处验证扣费与防重语义）
const chargeLog = [];
const chargeOnce = () => { chargeLog.push(1); };
check('6a 首次受理扣费恰好一次并置 creditsCharged', () => {
  mk('spk_g', { status: 'analyzed', words: [{ word: '词', start: 0.5, end: 1 }, { word: '句', start: 2, end: 3 }] });
  const before = chargeLog.length;
  startSpeechProduce({ taskId: 'spk_g', deletedStarts: [], inMemoryTasks, storageOutputsDir: OUT_DIR, chargeMockCredits: chargeOnce });
  assert.equal(chargeLog.length - before, 1);
  assert.equal(inMemoryTasks.get('spk_g').creditsCharged, true);
});
check('6b failed 重试（已扣过）不重复扣费', () => {
  mk('spk_h', {
    status: 'failed',
    words: [{ word: '词', start: 0.5, end: 1 }, { word: '句', start: 2, end: 3 }],
    videoFile: 'N/A',
    durationSec: 5,
    creditsCharged: true,
  });
  const before = chargeLog.length;
  const r = startSpeechProduce({ taskId: 'spk_h', deletedStarts: [0.5], inMemoryTasks, storageOutputsDir: OUT_DIR, chargeMockCredits: chargeOnce });
  assert.equal(r.taskId, 'spk_h');
  assert.equal(chargeLog.length - before, 0);
  assert.equal(inMemoryTasks.get('spk_h').status, 'producing');
});
check('6c producing 重复提交 409 拦截先于扣费，不产生扣费', () => {
  mk('spk_i', { status: 'producing', words: [{ word: '词', start: 0, end: 1 }] });
  const before = chargeLog.length;
  assert.throws(() => startSpeechProduce({ taskId: 'spk_i', deletedStarts: [], inMemoryTasks, chargeMockCredits: chargeOnce }),
    (e) => e.code === 40901);
  assert.equal(chargeLog.length - before, 0);
});

// 7. failed 状态允许携删除集重新提交（重试路径）——受受理后进入 producing
check('7 failed 后携新删除集重试 → 受理并置 producing', () => {
  mk('spk_f', {
    status: 'failed',
    words: [{ word: '词', start: 0.5, end: 1 }, { word: '句', start: 2, end: 3 }],
    videoFile: 'N/A', // 状态机层面验证；真实合成在 P4 端到端用真素材验证，此处异步段失败不影响受理断言
    durationSec: 5,
  });
  const r = startSpeechProduce({ taskId: 'spk_f', deletedStarts: [0.5], inMemoryTasks, storageOutputsDir: OUT_DIR, chargeMockCredits: chargeOnce });
  assert.equal(r.taskId, 'spk_f');
  assert.equal(inMemoryTasks.get('spk_f').status, 'producing');
});

console.log(`\n===== bff 结果：${PASS.length} PASS / ${FAIL.length} FAIL =====`);
fs.rmSync(OUT_DIR, { recursive: true, force: true });
process.exit(FAIL.length ? 1 : 0);
