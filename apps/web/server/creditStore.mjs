// 简兮 (JANSEE) · 积分账户与商业化流水管理层 (apps/web/server/creditStore.mjs)
// 职责：
//   1. 统一管理用户算力积分账户余额与出入账；
//   2. 双资产池架构：严格隔离【付费充值积分 paid】与【运营赠送/签到积分 free】；
//   3. 出片消费优先扣减 free 积分，最大化保障用户权益；
//   4. 72小时自主退款强制门禁：仅允许从 paid 积分池核销，严防免费签到积分套现与超额退款；
//   5. 维护不可篡改的积分变动交易流水与 taskId 消费幂等防重机制。
//   6. 余额与流水落盘到 server/data/credit-accounts.json —— 重启不丢账（2026-10-28 补）。

import { ERROR_CODES, createAppError } from './errors.mjs';
import { dataFile, readJson, writeJsonAtomic } from './dataStore.mjs';

const CREDIT_FILE = dataFile('credit-accounts.json');

// 测试（node test-*.mjs / --test）默认不落盘，避免把断言用的假账号写进真实账本。
const PERSIST_ENABLED = (() => {
  if (process.env.JX_NO_PERSIST === '1') return false;
  const entry = String(process.argv[1] || '').replace(/\\/g, '/');
  return !/(^|\/)tests?\//.test(entry);
})();

export class CreditStore {
  constructor() {
    this.accounts = new Map();     // userId -> { paid: number, free: number }
    // 原先此处硬编码给 13888888888 预置 10000 积分（官方测试专员账户）。
    // 2026-10-28 清除测试数据时移除，账户改为按真实注册/充值产生。
    this.transactions = [];        // Array<Transaction>
    this.taskTxMap = new Map();    // taskId -> transactionId (幂等索引用)
    this.seq = 0;                  // 单调递增序号，保证同毫秒倒序确定性
    // HIGH-01 安全加固：用户级操作互斥锁，防止同一用户并发请求竞态条件（TOCTOU）
    this._pendingOps = new Set();  // 正在执行扣减/退款的 userId 集合
    this._load();
  }

  /**
   * 内部方法：从磁盘还原账户与流水（文件缺失/损坏时静默跳过）
   * @private
   */
  _load() {
    if (!PERSIST_ENABLED) return false;
    const raw = readJson(CREDIT_FILE, null);
    if (!raw || typeof raw !== 'object') return false;
    const accounts = raw.accounts && typeof raw.accounts === 'object' ? raw.accounts : {};
    for (const [uid, acc] of Object.entries(accounts)) {
      const id = String(uid || '').trim();
      if (!id) continue;
      if (typeof acc === 'number') this.accounts.set(id, { paid: Number(acc) || 0, free: 0 });
      else if (acc && typeof acc === 'object') {
        this.accounts.set(id, { paid: Number(acc.paid) || 0, free: Number(acc.free) || 0 });
      }
    }
    if (Array.isArray(raw.transactions)) {
      this.transactions = raw.transactions.filter((t) => t && t.transactionId);
    }
    this.seq = Number(raw.seq) || this.transactions.reduce((m, t) => Math.max(m, Number(t.seq) || 0), 0);
    for (const t of this.transactions) {
      // 只索引 consume：该映射是扣费幂等判据，被退款/补偿流水覆盖会导致同一 task 二次扣费
      if (t.taskId && t.type === 'consume') this.taskTxMap.set(String(t.taskId), t.transactionId);
    }
    return true;
  }

  /**
   * 内部方法：把账户与流水整体写回磁盘（原子写，失败保留旧文件）
   * @private
   */
  _persist() {
    if (!PERSIST_ENABLED) return false;
    const accounts = {};
    for (const [uid, acc] of this.accounts.entries()) {
      accounts[uid] = { paid: Number(acc?.paid) || 0, free: Number(acc?.free) || 0 };
    }
    const ok = writeJsonAtomic(CREDIT_FILE, { accounts, transactions: this.transactions, seq: this.seq });
    if (!ok) console.error('[creditStore] 积分账本落盘失败，余额可能未持久化');
    return ok;
  }

  /**
   * 内部方法：获取或标准化账户对象
   * @private
   */
  _ensureAccount(userId, initialBalance = 0) {
    const cleanId = String(userId || '').trim();
    if (!cleanId) {
      throw createAppError(ERROR_CODES.PARAM_INVALID, '缺少合法 userId');
    }
    let acc = this.accounts.get(cleanId);
    if (!acc) {
      acc = { paid: Math.max(0, Number(initialBalance) || 0), free: 0 };
      this.accounts.set(cleanId, acc);
    } else if (typeof acc === 'number') {
      // 兼容存量单数值形式
      acc = { paid: acc, free: 0 };
      this.accounts.set(cleanId, acc);
    }
    return acc;
  }

  /**
   * 初始化/创建用户积分账户
   * @param {string} userId
   * @param {number} [initialBalance=0] 初始积分
   * @returns {number} 当前总余额
   */
  createCreditAccount(userId, initialBalance = 0) {
    const acc = this._ensureAccount(userId, initialBalance);
    this._persist();
    return acc.paid + acc.free;
  }

  /**
   * 获取用户当前总积分余额 (paid + free)
   * @param {string} userId
   * @returns {number}
   */
  getBalance(userId) {
    if (!userId || typeof userId !== 'string') return 0;
    const acc = this.accounts.get(userId.trim());
    if (!acc) return 0;
    if (typeof acc === 'number') return acc;
    return (Number(acc.paid) || 0) + (Number(acc.free) || 0);
  }

  /**
   * 获取付费充值积分余额 (真金白银购买，退款唯一合法核销源)
   * @param {string} userId
   * @returns {number}
   */
  getPaidBalance(userId) {
    if (!userId || typeof userId !== 'string') return 0;
    const acc = this.accounts.get(userId.trim());
    if (!acc) return 0;
    if (typeof acc === 'number') return acc;
    return Number(acc.paid) || 0;
  }

  /**
   * 获取免费赠送/签到积分余额 (活动补贴，不可变现)
   * @param {string} userId
   * @returns {number}
   */
  getFreeBalance(userId) {
    if (!userId || typeof userId !== 'string') return 0;
    const acc = this.accounts.get(userId.trim());
    if (!acc) return 0;
    if (typeof acc === 'number') return 0;
    return Number(acc.free) || 0;
  }

  /**
   * 获取用户双资产池结构明细
   * @param {string} userId
   * @returns {{ total: number, paid: number, free: number }}
   */
  getBreakdown(userId) {
    return {
      total: this.getBalance(userId),
      paid: this.getPaidBalance(userId),
      free: this.getFreeBalance(userId),
    };
  }

  /**
   * 记录积分流水
   * @param {object} params
   * @returns {object} 交易记录
   */
  recordTransaction({ userId, type, amount, reason, taskId }) {
    const txId = taskId ? `tx_${taskId}` : `tx_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const tx = {
      transactionId: txId,
      seq: ++this.seq,
      userId: String(userId || '').trim(),
      type: type || 'consume',
      amount: Number(amount) || 0,
      reason: String(reason || '').trim(),
      taskId: taskId ? String(taskId).trim() : null,
      createdAt: Date.now(),
    };
    this.transactions.push(tx);
    if (taskId) {
      // 只允许 consume 写入且不被覆盖：taskId→tx 索引是扣费幂等判据，
      // 若被退款/补偿流水改写，重复提交同一 task 会绕过幂等造成二次扣费。
      const key = String(taskId).trim();
      if (tx.type === 'consume' && !this.taskTxMap.has(key)) {
        this.taskTxMap.set(key, txId);
      }
    }
    // 所有余额变动（充值/消费/赠送/退款/调账）都经此写流水，统一在此落盘
    this._persist();
    return { ...tx };
  }

  /**
   * 消费扣减积分 (优先消耗 free 免费赠送积分，不足部分再扣除 paid 付费积分)
   * @param {object} params
   * @param {string} params.userId 用户 ID
   * @param {number} params.amount 消费数量
   * @param {string} [params.reason] 消费说明
   * @param {string} [params.taskId] 关联创作任务 ID (防重核心)
   * @returns {object} 交易记录与最新余额 { transaction, balance }
   */
  consumeCredits({ userId, amount, reason = '创作任务出片消费', taskId } = {}) {
    const cleanUid = String(userId || '').trim();
    if (!cleanUid) {
      throw createAppError(ERROR_CODES.PARAM_INVALID, '扣减积分失败：缺少合法 userId');
    }

    // HIGH-01 安全加固：用户级互斥守卫，防止同一用户并发扣减竞态
    if (this._pendingOps.has(cleanUid)) {
      throw createAppError(40902, '操作过于频繁，请稍后重试', { status: 409 });
    }
    this._pendingOps.add(cleanUid);
    try {
      return this._doConsume({ cleanUid, amount, reason, taskId });
    } finally {
      this._pendingOps.delete(cleanUid);
    }
  }

  /** @private 实际扣减逻辑（由 consumeCredits 互斥守卫后调用） */
  _doConsume({ cleanUid, amount, reason, taskId }) {

    const cost = Math.max(0, Number(amount) || 0);

    // 1. 幂等防护：若同一个 taskId 已发生过成功扣费交易，直接返回已有记录，严禁重复扣费
    if (taskId) {
      const cleanTid = String(taskId).trim();
      const existingTxId = this.taskTxMap.get(cleanTid);
      if (existingTxId) {
        const found = this.transactions.find((t) => t.transactionId === existingTxId && t.type === 'consume');
        if (found) {
          return {
            transaction: { ...found },
            balance: this.getBalance(cleanUid),
            idempotent: true,
          };
        }
      }
    }

    const acc = this._ensureAccount(cleanUid);
    const total = acc.paid + acc.free;
    if (total < cost) {
      throw createAppError(40201, `算力积分不足（当前余额 ${total}，需消耗 ${cost}），请先充值`, { status: 402 });
    }

    // 2. 双资产池扣除策略：优先扣除免费/签到积分 free，不足再扣除付费积分 paid
    let deductFromFree = 0;
    let deductFromPaid = 0;

    if (acc.free >= cost) {
      deductFromFree = cost;
      acc.free -= cost;
    } else {
      deductFromFree = acc.free;
      deductFromPaid = cost - acc.free;
      acc.free = 0;
      acc.paid -= deductFromPaid;
    }

    const newBalance = acc.paid + acc.free;
    const detailReason = `${reason} (扣除赠送:${deductFromFree}, 扣除充值:${deductFromPaid})`;

    const tx = this.recordTransaction({
      userId: cleanUid,
      type: 'consume',
      amount: cost,
      reason: detailReason,
      taskId,
    });

    return {
      transaction: tx,
      balance: newBalance,
      idempotent: false,
    };
  }

  /**
   * 商户充值积分到账 (购买加油包/会员充值) -> 计入 paid 付费资产池
   * @param {string} userId
   * @param {number} amount
   * @param {string} [reason]
   * @returns {object} { transaction, balance }
   */
  chargeCredits(userId, amount, reason = '商户购买算力到账') {
    const cleanUid = String(userId || '').trim();
    const pts = Math.max(0, Number(amount) || 0);
    const acc = this._ensureAccount(cleanUid);
    acc.paid += pts;
    const newBalance = acc.paid + acc.free;

    const tx = this.recordTransaction({
      userId: cleanUid,
      type: 'recharge',
      amount: pts,
      reason,
      taskId: null,
    });

    return {
      transaction: tx,
      balance: newBalance,
    };
  }

  /**
   * 运营活动/签到/新用户赠送积分 -> 计入 free 赠送资产池
   * @param {string} userId
   * @param {number} amount
   * @param {string} [reason]
   * @returns {object} { transaction, balance }
   */
  grantFreeCredits(userId, amount, reason = '每日签到奖励') {
    const cleanUid = String(userId || '').trim();
    const pts = Math.max(0, Number(amount) || 0);
    const acc = this._ensureAccount(cleanUid);
    acc.free += pts;
    const newBalance = acc.paid + acc.free;

    const tx = this.recordTransaction({
      userId: cleanUid,
      type: 'grant_free',
      amount: pts,
      reason,
      taskId: null,
    });

    return {
      transaction: tx,
      balance: newBalance,
    };
  }

  /**
   * 72小时自主退款原子核销专属方法 (核心防线)
   * 铁律：
   * 1. 严格检查用户可用付费充值积分 paid，绝不允许用户拿签到/赠送积分充抵退款保证金；
   * 2. 积分不足直接抛错阻断退款，严禁超额退款或白嫖算力；
   * 3. 扣减只扣 paid 账户，free 账户一分不扣，彻底阻断签到积分变现洗钱漏洞。
   *
   * @param {string} userId 用户 ID
   * @param {number} requiredPaidPoints 该订单实付入账需回收的付费积分
   * @param {string} orderId 订单 ID
   * @returns {{ balance: number, paid: number, free: number }}
   */
  recyclePaidCreditsForRefund(userId, requiredPaidPoints, orderId) {
    const cleanUid = String(userId || '').trim();
    const needPts = Math.max(0, Number(requiredPaidPoints) || 0);

    // HIGH-01 安全加固：用户级互斥守卫，防止并发退款竞态
    if (this._pendingOps.has(cleanUid)) {
      throw createAppError(40902, '操作过于频繁，请稍后重试', { status: 409 });
    }
    this._pendingOps.add(cleanUid);
    try {

    const acc = this._ensureAccount(cleanUid);

    // 门禁 1：账户总余额硬校验
    const total = acc.paid + acc.free;
    if (total < needPts) {
      throw createAppError(
        40003,
        `退款申请驳回：账户当前可用总积分(${total})不足(${needPts})，已消费使用的出片服务不支持退款`,
        { status: 400 }
      );
    }

    // 门禁 2：付费充值积分池硬校验 (彻底封死签到套现)
    if (acc.paid < needPts) {
      throw createAppError(
        40003,
        `退款申请驳回：该订单充值积分已被消费出片（当前可用付费积分仅余 ${acc.paid} 点，拟退款需回收 ${needPts} 点）。签到与活动赠送积分仅限出片抵扣，不可折算充抵退款本金`,
        { status: 400 }
      );
    }

    // 门禁 3：原子扣减付费积分 (签到/赠送积分 free 毫发无损)
    acc.paid -= needPts;
    const newBalance = acc.paid + acc.free;

    this.recordTransaction({
      userId: cleanUid,
      type: 'refund_recycle',
      amount: needPts,
      reason: `订单[${orderId || ''}]72小时自主退款核销 (回收实付积分:${needPts}, 保留赠送积分:${acc.free})`,
      taskId: null,
    });

    return {
      balance: newBalance,
      paid: acc.paid,
      free: acc.free,
    };
    } finally {
      this._pendingOps.delete(cleanUid);
    }
  }

  /**
   * 积分退款/补偿 (系统出片失败等技术故障补偿)
   *
   * 两条硬规则（2026-10-28 修复）：
   *  1. 原路退回：扣费时「先扣 free 再扣 paid」，若退款一律补 paid，等于把不可变现的
   *     赠送积分洗成可退款/可提现的付费积分 —— 出片失败一次即完成一次套利闭环。
   *     故必须回溯原 consume 流水的扣除明细，按原资产池等额退回。
   *  2. 幂等：同一 taskId 只允许退一次；回溯不到原流水时保守补 free，
   *     宁可多给赠送额度（只影响成本），也绝不凭空增加可提现的付费积分。
   */
  refundCredits({ userId, amount, reason = '创作失败退款', taskId } = {}) {
    const cleanUid = String(userId || '').trim();
    if (!cleanUid) {
      throw createAppError(ERROR_CODES.PARAM_INVALID, '退款失败：缺少合法 userId');
    }

    const refundAmount = Math.max(0, Number(amount) || 0);
    const cleanTid = taskId ? String(taskId).trim() : '';

    // 幂等：同一 task 已退过款则直接返回原流水，不重复加积分
    if (cleanTid) {
      const dup = this.transactions.find(
        (t) => t.type === 'refund' && t.taskId === cleanTid && t.userId === cleanUid,
      );
      if (dup) {
        return {
          transaction: { ...dup },
          balance: this.getBalance(cleanUid),
          idempotent: true,
        };
      }
    }

    // 回溯原扣费的资产池构成，默认全部退到 free（安全侧）
    let toFree = refundAmount;
    let toPaid = 0;

    if (cleanTid) {
      const srcTxId = this.taskTxMap.get(cleanTid);
      const src = srcTxId
        ? this.transactions.find(
          (t) => t.transactionId === srcTxId && t.type === 'consume' && t.userId === cleanUid,
        )
        : null;

      if (src) {
        // consume 流水 reason 形如：「xxx (扣除赠送:800, 扣除充值:200)」
        const m = String(src.reason || '').match(/扣除赠送[:：]\s*(\d+)\s*[,，]\s*扣除充值[:：]\s*(\d+)/);
        if (m) {
          const srcFree = Number(m[1]) || 0;
          const srcPaid = Number(m[2]) || 0;
          const srcTotal = srcFree + srcPaid;
          if (srcTotal > 0) {
            // 部分退款按原比例分摊；舍入余量补到 free，避免出现「多退付费」的洗钱空间
            const ratio = Math.min(1, refundAmount / srcTotal);
            toFree = Math.floor(srcFree * ratio);
            toPaid = Math.floor(srcPaid * ratio);
            const rest = refundAmount - toFree - toPaid;
            if (rest > 0) toFree += rest;
          }
        }
      }
    }

    const acc = this._ensureAccount(cleanUid);
    acc.free += toFree;
    acc.paid += toPaid;
    const newBalance = acc.paid + acc.free;

    const tx = this.recordTransaction({
      userId: cleanUid,
      type: 'refund',
      amount: refundAmount,
      reason: `${reason} (退回赠送:${toFree}, 退回充值:${toPaid})`,
      taskId: cleanTid || null,
    });

    return {
      transaction: tx,
      balance: newBalance,
      refundedToFree: toFree,
      refundedToPaid: toPaid,
    };
  }

  /**
   * 管理员手动调整积分
   */
  adjustCredits({ userId, amount, reason = '管理员手动调整', adminId = 'admin' } = {}) {
    const cleanUid = String(userId || '').trim();
    if (!cleanUid) {
      throw createAppError(ERROR_CODES.PARAM_INVALID, '调整积分失败：缺少合法 userId');
    }

    const delta = Number(amount);
    if (!Number.isFinite(delta) || delta === 0) {
      throw createAppError(ERROR_CODES.PARAM_INVALID, '调整积分失败：调整数量必须为非零数值');
    }

    const acc = this._ensureAccount(cleanUid);
    const current = acc.paid + acc.free;
    const newBalance = current + delta;
    if (newBalance < 0) {
      throw createAppError(40201, `调整失败：扣减额度超出用户当前余额（当前余额 ${current}，拟扣减 ${Math.abs(delta)}）`, { status: 400 });
    }

    if (delta > 0) {
      acc.paid += delta;
    } else {
      // 扣减先扣 free 再扣 paid
      const deduct = Math.abs(delta);
      if (acc.free >= deduct) {
        acc.free -= deduct;
      } else {
        const rem = deduct - acc.free;
        acc.free = 0;
        acc.paid = Math.max(0, acc.paid - rem);
      }
    }

    const txType = delta > 0 ? 'recharge' : 'adjust_deduct';
    const tx = this.recordTransaction({
      userId: cleanUid,
      type: txType,
      amount: Math.abs(delta),
      reason: `${String(reason || '').trim() || '运营调账'} (操作管理员: ${adminId})`,
      taskId: null,
    });

    return {
      transaction: tx,
      balance: acc.paid + acc.free,
    };
  }

  /**
   * 查询全局积分流水明细 (运营审计用)
   */
  listAllTransactions(filter = {}) {
    const { userId, type, limit = 50, offset = 0 } = filter;
    let list = this.transactions.slice();

    if (userId) {
      const cleanUid = String(userId).trim();
      list = list.filter((t) => t.userId === cleanUid);
    }
    if (type) {
      list = list.filter((t) => t.type === type);
    }

    const total = list.length;
    list.sort((a, b) => ((b.createdAt || 0) - (a.createdAt || 0)) || ((b.seq || 0) - (a.seq || 0)));
    const paged = list.slice(offset, offset + limit).map((t) => ({ ...t }));

    return {
      total,
      list: paged,
    };
  }

  /**
   * 查询指定用户的积分流水
   */
  listTransactions(userId, limit = 50) {
    if (!userId) return [];
    const cleanUid = String(userId).trim();
    return this.transactions
      .filter((t) => t.userId === cleanUid)
      .slice(-limit)
      .reverse()
      .map((t) => ({ ...t }));
  }

  /**
   * 清理所有数据（测试沙箱重置用）
   */
  clear() {
    this.accounts.clear();
    this.transactions = [];
    this.taskTxMap.clear();
    this.seq = 0;
    this._persist();
  }
}

// 导出全局积分存储单例
export const creditStore = new CreditStore();
