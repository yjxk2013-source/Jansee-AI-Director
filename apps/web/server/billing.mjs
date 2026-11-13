// 简兮 · 统一计费服务 (Billing Service)
// 职责：所有产出成片的入口，统一经由本服务完成「定价 → 幂等扣费 → 失败退款」闭环。
// 分层定位：BFF 领域服务（apps/web/server），归属业务侧，不下沉 packages 技术能力层。
// 机制护栏：出片入口必须在 BILLABLE_ENTRIES 登记，由 tests/billing/test-entry-guard.mjs 双向对账。

import { createAppError } from './errors.mjs';
import { creditStore as defaultCreditStore } from './creditStore.mjs';

// 多版成片上限（与 creation 批量编排保持同源）
export const BATCH_VERSION_LIMIT = 10;

// 创作类型积分消耗对照表（唯一真相源）
// 业务定版 2026-10-29：除切片工具免费外，所有成片版块统一 200 积分，不分版块。
export const CREATION_TYPE_COSTS = {
  image_creator: 200,
  storyboard: 200,
  video_dub: 200,
  speechcut: 200,
  storyboard_direct: 200,
  slicer: 50,
};

// 成片统一单价（旁路任务在模块内只落布尔标记，结算时按此还原金额）
export const UNIFIED_MOVIE_COST = 200;

// ==========================================================================
// 出片入口登记表 —— 唯一真相源
// kind 语义：
//   creation —— 走统一创作编排，按 payload.type 查 CREATION_TYPE_COSTS（支持多版叠加）
//   entry    —— 版块自有旁路入口，固定按 type 单价扣费
//   free     —— 产品定版明确免费（不扣费，但不代表无成本，仍受限频约束）
//   retired  —— 已下线路由，仅占位，不参与计费
// ==========================================================================
export const BILLABLE_ENTRIES = [
  { path: '/api/v1/creation/create', kind: 'creation', note: '统一创作编排：图片成片 / 视频配音 / 分镜 AI 配音' },
  { path: '/api/v1/speech/produce', kind: 'entry', type: 'speechcut', note: '出镜口播成片' },
  { path: '/api/v1/storyboard/direct/produce', kind: 'entry', type: 'storyboard_direct', note: '分镜直出成片' },
  { path: '/api/v1/slice/cut', kind: 'free', type: 'slicer', note: '切片工具：产品定版第一版免费' },
  { path: '/api/v1/video/produce', kind: 'retired', note: '旧版出片接口，已统一返回 410' },
];

// 单用户扣费互斥锁：防止同一用户在同一毫秒并发发起多个出片请求透支积分
const userCreditLocks = new Set();
// 锁释放延迟：覆盖 consumeCredits 内部落盘耗时，避免紧随其后的第二个请求读到旧余额
const LOCK_RELEASE_DELAY_MS = 300;

/** 按路径查登记项，未登记返回 null */
export function getBillingEntry(pathname) {
  const clean = String(pathname || '').trim();
  return BILLABLE_ENTRIES.find((e) => e.path === clean) || null;
}

/** 取创作类型单价，未登记类型按成片统一价兜底 */
export function costOf(type) {
  return Number(CREATION_TYPE_COSTS[type]) || UNIFIED_MOVIE_COST;
}

/**
 * 统一创作编排扣费（原 creation.mjs beforeCreateHook 内的扣费实现迁入至此）
 * @param {object} params
 * @param {string} params.userId 服务端解析出的可信用户 ID
 * @param {string} params.type 创作类型
 * @param {number} [params.versions] 多版条数，积分按条数线性叠加
 * @param {string} params.taskId 任务 ID（幂等键）
 * @param {object} [params.store] 账本注入（单测使用）
 * @returns {object} { ok, userId, cost, remainingCredits, idempotent }
 */
export function chargeForCreation({ userId, type, versions = 1, taskId, store = defaultCreditStore } = {}) {
  const cleanUid = String(userId || '').trim();

  // 无有效登录态：默认拒绝。仅本地联调/自动化测试显式设置 ALLOW_ANON_CREATION=1 时放行且不扣费。
  if (!cleanUid) {
    if (process.env.ALLOW_ANON_CREATION === '1') {
      return { ok: true, userId: null, cost: 0, remainingCredits: 2850, idempotent: false };
    }
    throw createAppError(40101, '请先登录后再发起创作（未检测到有效登录态）', { status: 401 });
  }

  const batchN = Math.max(1, Math.min(BATCH_VERSION_LIMIT, Math.floor(Number(versions) || 1)));
  const cost = costOf(type) * batchN;

  if (userCreditLocks.has(cleanUid)) {
    throw createAppError(40902, '您的账户正在结算上一笔出片扣费，请稍候 1 秒后再试', { status: 409 });
  }
  userCreditLocks.add(cleanUid);

  try {
    // 余额预检：给出「当前可用 / 本次需消耗」的明确提示，而不是只抛一句"余额不足"。
    // 账本未实现 getBalance 时不做预检（交由 consumeCredits 自身兜底），与原实现行为一致。
    const currentBalance = typeof store.getBalance === 'function' ? store.getBalance(cleanUid) : 99999;
    if (currentBalance < cost) {
      throw createAppError(40201, `算力积分不足（当前可用 ${currentBalance} 分，本次需消耗 ${cost} 分），请先充值后再出片`, { status: 402 });
    }

    const result = store.consumeCredits({
      userId: cleanUid,
      amount: cost,
      reason: `${type || 'creation'} 创作任务出片消费${batchN > 1 ? `（批量 ${batchN} 条）` : ''}`,
      taskId,
    });
    return {
      ok: true,
      userId: cleanUid,
      cost,
      remainingCredits: result.balance,
      idempotent: Boolean(result.idempotent),
    };
  } finally {
    setTimeout(() => userCreditLocks.delete(cleanUid), LOCK_RELEASE_DELAY_MS);
  }
}

/**
 * 旁路版块入口扣费：查登记表决定收不收、收多少，调用方无需硬编码金额
 * @param {object} params
 * @param {string} params.pathname 请求路径（必须是已登记的出片入口）
 * @param {string} params.userId 服务端解析出的可信用户 ID
 * @param {string} params.taskId 任务 ID（幂等键）
 * @param {object} [params.store] 账本注入
 */
export function chargeForEntry({ pathname, userId, taskId, store = defaultCreditStore } = {}) {
  const entry = getBillingEntry(pathname);
  if (!entry) {
    // 未登记即编程错误：新入口必须先登记，否则一律拒付（防止静默免费出片）
    throw createAppError(50001, `出片入口 ${pathname} 未在计费登记表登记，已拒绝受理`, { status: 500 });
  }
  // 免费与已下线入口不扣费
  if (entry.kind === 'free' || entry.kind === 'retired') {
    return { ok: true, cost: 0, free: true, remainingCredits: null };
  }
  return chargeForCreation({ userId, type: entry.type, versions: 1, taskId, store });
}

/**
 * 从任务对象还原「实际已扣金额」
 * creation 链路存数值金额，旁路版块（冻结模块内部）只存 true，故按统一价还原
 * @returns {number} 已扣金额，未扣费返回 0
 */
export function chargedAmountOf(task) {
  const raw = task && task.creditsCharged;
  if (typeof raw === 'number' && raw > 0) return raw;
  if (raw === true) {
    const kind = String(task?.kind || task?.type || '');
    return costOf(kind);
  }
  return 0;
}

/**
 * 失败结算：全路径自动退还（幂等由 creditStore 按 taskId 保证，原路按资产池退回）
 * 调用方：creation 统一链路的 catch 段、旁路任务轮询端点、Zombie Reaper 收割器
 */
export function settleFailure({ userId, taskId, amount, reason = '出片失败自动退还', store = defaultCreditStore } = {}) {
  const cleanUid = String(userId || '').trim();
  const amt = Number(amount) || 0;
  if (!cleanUid || amt <= 0 || !taskId) {
    return { ok: false, skipped: true };
  }
  try {
    const r = store.refundCredits({
      userId: cleanUid,
      amount: amt,
      reason: `${reason} (任务: ${taskId})`,
      taskId,
    });
    return { ok: true, refunded: amt, balance: r.balance, idempotent: Boolean(r.idempotent) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
