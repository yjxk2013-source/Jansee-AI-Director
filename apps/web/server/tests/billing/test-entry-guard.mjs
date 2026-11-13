// 计费护栏测试：出片入口必须全部登记，未登记即失败。
// 目的：防止「新加入口忘记接计费」重演白跑出片（2026-10-29 已发生一次真实资损）。
// 双向对账：源码里的出片路由 ⊆ 登记表，登记表 ⊆ 源码（不存在僵尸登记项）。

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { BILLABLE_ENTRIES, getBillingEntry, chargeForEntry, chargeForCreation, chargedAmountOf, settleFailure, costOf } from '../../billing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '../..');
const INDEX_SRC = fs.readFileSync(path.join(SERVER_DIR, 'index.mjs'), 'utf8');

let pass = 0;
let fail = 0;
// 计费服务内有 300ms 单用户互斥锁（防并发透支），测试用不同 userId 规避误触；
// 需验证「同一用户连续调用」的用例显式等待锁释放。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function check(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); } catch (e) { fail++; console.log(`FAIL ${name}  ->  ${e.message}`); }
}

/** 从 index.mjs 提取所有 POST 路由路径 */
function extractPostRoutes(src) {
  const out = new Set();
  for (const line of src.split('\n')) {
    if (!line.includes("req.method === 'POST'")) continue;
    for (const m of line.matchAll(/'(\/api\/v1\/[^']+)'/g)) out.add(m[1]);
  }
  return [...out];
}

/** 出片特征：路径以 /produce 结尾，或为统一创作编排/切片入口 */
function isMovieProducingRoute(p) {
  return /\/produce$/.test(p) || p === '/api/v1/creation/create' || p === '/api/v1/slice/cut';
}

const postRoutes = extractPostRoutes(INDEX_SRC);
const movieRoutes = postRoutes.filter(isMovieProducingRoute);
const registeredPaths = new Set(BILLABLE_ENTRIES.map((e) => e.path));

console.log(`\n--- 1. 入口登记双向对账 ---`);
await check('1.1 源码出片路由全部已在登记表登记', () => {
  const missing = movieRoutes.filter((p) => !registeredPaths.has(p));
  assert.equal(missing.length, 0, `未登记的出片入口: ${missing.join(', ') || '无'}`);
});
await check('1.2 登记表无僵尸项（每条路径在源码中真实存在）', () => {
  const ghosts = [...registeredPaths].filter((p) => !postRoutes.includes(p));
  assert.equal(ghosts.length, 0, `登记表僵尸项: ${ghosts.join(', ') || '无'}`);
});
await check('1.3 四个出片版块全部覆盖', () => {
  for (const p of ['/api/v1/creation/create', '/api/v1/speech/produce', '/api/v1/storyboard/direct/produce', '/api/v1/slice/cut']) {
    assert.ok(registeredPaths.has(p), `缺少登记: ${p}`);
  }
});
await check('1.4 已下线路由标记为 retired，不参与扣费', () => {
  const retired = getBillingEntry('/api/v1/video/produce');
  assert.ok(retired, '已下线路由应有登记项');
  assert.equal(retired.kind, 'retired');
});

console.log(`\n--- 2. 定价统一 ---`);
await check('2.1 四个成片版块单价统一为 200', () => {
  assert.equal(costOf('image_creator'), 200);
  assert.equal(costOf('video_dub'), 200);
  assert.equal(costOf('speechcut'), 200);
  assert.equal(costOf('storyboard_direct'), 200);
});
await check('2.2 切片工具定为免费（登记为 free）', () => {
  assert.equal(getBillingEntry('/api/v1/slice/cut').kind, 'free');
});

console.log(`\n--- 3. 扣费行为 ---`);
function makeStubStore(initial) {
  const state = { balance: initial, txs: [] };
  return {
    state,
    getBalance: () => state.balance,
    consumeCredits: ({ userId, amount, taskId }) => {
      const dup = state.txs.find((t) => t.type === 'consume' && t.taskId === taskId);
      if (dup) return { balance: state.balance, idempotent: true };
      state.balance -= amount;
      state.txs.push({ type: 'consume', userId, amount, taskId });
      return { balance: state.balance, idempotent: false };
    },
    refundCredits: ({ userId, amount, taskId }) => {
      const dup = state.txs.find((t) => t.type === 'refund' && t.taskId === taskId);
      if (dup) return { balance: state.balance, idempotent: true };
      state.balance += amount;
      state.txs.push({ type: 'refund', userId, amount, taskId });
      return { balance: state.balance, idempotent: false };
    },
  };
}

await check('3.1 口播入口扣 200 且余额正确', () => {
  const store = makeStubStore(1000);
  const r = chargeForEntry({ pathname: '/api/v1/speech/produce', userId: 'u1', taskId: 'spk_1', store });
  assert.equal(r.cost, 200);
  assert.equal(store.state.balance, 800);
});
await check('3.2 分镜直出入口扣 200', () => {
  const store = makeStubStore(1000);
  const r = chargeForEntry({ pathname: '/api/v1/storyboard/direct/produce', userId: 'u2', taskId: 'sb_1', store });
  assert.equal(r.cost, 200);
});
await check('3.3 切片入口免费不扣费', () => {
  const store = makeStubStore(1000);
  const r = chargeForEntry({ pathname: '/api/v1/slice/cut', userId: 'u3', taskId: 'sl_1', store });
  assert.equal(r.cost, 0);
  assert.equal(r.free, true);
  assert.equal(store.state.balance, 1000);
});
await check('3.4 未登记入口拒绝受理（防静默免费出片）', () => {
  const store = makeStubStore(1000);
  assert.throws(
    () => chargeForEntry({ pathname: '/api/v1/ghost/produce', userId: 'u4', taskId: 'g_1', store }),
    (e) => e.code === 50001,
  );
});
await check('3.5 同一 taskId 重复扣费幂等（只扣一次）', async () => {
  const store = makeStubStore(1000);
  chargeForEntry({ pathname: '/api/v1/speech/produce', userId: 'u5', taskId: 'spk_x', store });
  await sleep(350); // 等单用户互斥锁释放
  const second = chargeForEntry({ pathname: '/api/v1/speech/produce', userId: 'u5', taskId: 'spk_x', store });
  assert.equal(second.idempotent, true);
  assert.equal(store.state.balance, 800);
});
await check('3.6 余额不足抛 402 且不扣费', () => {
  const store = makeStubStore(150);
  assert.throws(
    () => chargeForEntry({ pathname: '/api/v1/speech/produce', userId: 'u6', taskId: 'spk_low', store }),
    (e) => e.code === 40201,
  );
  assert.equal(store.state.balance, 150);
});
await check('3.7 多版成片按条数线性叠加（3 版 = 600）', () => {
  const store = makeStubStore(2000);
  const r = chargeForCreation({ userId: 'u7', type: 'image_creator', versions: 3, taskId: 'ic_3', store });
  assert.equal(r.cost, 600);
});
await check('3.8 无登录态默认拒绝（401）', () => {
  const store = makeStubStore(2000);
  const prev = process.env.ALLOW_ANON_CREATION;
  delete process.env.ALLOW_ANON_CREATION;
  try {
    assert.throws(() => chargeForCreation({ userId: '', type: 'image_creator', taskId: 'anon', store }), (e) => e.code === 40101);
  } finally {
    if (prev !== undefined) process.env.ALLOW_ANON_CREATION = prev;
  }
});

console.log(`\n--- 4. 金额还原与失败退款 ---`);
await check('4.1 旁路布尔标记还原为 200（旧实现会退成 1 分）', () => {
  assert.equal(chargedAmountOf({ creditsCharged: true, kind: 'speechcut' }), 200);
  assert.equal(chargedAmountOf({ creditsCharged: true, kind: 'storyboard_direct' }), 200);
});
await check('4.2 creation 数值金额原样返回', () => {
  assert.equal(chargedAmountOf({ creditsCharged: 400 }), 400);
});
await check('4.3 未扣费任务金额为 0，不触发退款', () => {
  assert.equal(chargedAmountOf({ creditsCharged: false }), 0);
  assert.equal(chargedAmountOf({}), 0);
});
await check('4.4 失败退款全额返还且幂等', async () => {
  const store = makeStubStore(1000);
  chargeForEntry({ pathname: '/api/v1/speech/produce', userId: 'u8', taskId: 'spk_f', store });
  assert.equal(store.state.balance, 800);
  settleFailure({ userId: 'u8', taskId: 'spk_f', amount: chargedAmountOf({ creditsCharged: true, kind: 'speechcut' }), store });
  assert.equal(store.state.balance, 1000);
  const again = settleFailure({ userId: 'u8', taskId: 'spk_f', amount: 200, store });
  assert.equal(again.idempotent, true);
  assert.equal(store.state.balance, 1000);
});
await check('4.5 缺 userId / taskId 时安全跳过', () => {
  const store = makeStubStore(1000);
  const r = settleFailure({ userId: '', taskId: 'x', amount: 200, store });
  assert.equal(r.ok, false);
  assert.equal(store.state.balance, 1000);
});

console.log(`\n===== 计费护栏测试结果：${pass} PASS / ${fail} FAIL =====`);
process.exit(fail > 0 ? 1 : 0);
