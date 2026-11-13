// 简兮 · 城市合伙人佣金/提现存储（JSON 文件持久化）
// 落盘：server/data/partner.json
// 生命周期：订单支付 → grantCommission 生成待结算佣金(pending) → 满 7 天自动转已结算(settled)
//          → 合伙人发起提现(withdraw) → 管理员审核打款。
// 可提现余额 = 已结算佣金 − 已发起的提现金额（含待审），拒绝的提现不占用余额。

import { commissionRates, LEVEL2_RATE as PLAN_LEVEL2_RATE, COMMISSION_PLAN } from './commissionPlan.mjs';
import { dataFile, readJson, writeJsonAtomic } from './dataStore.mjs';
import { isOrderRefunded } from './payStore.mjs';
import { withdrawFee } from './settlementGateway.mjs';
import { ops } from './siteConfig.mjs';
import { decrypt, encrypt, findUserById, findUserByPhone, isEnc } from './userStore.mjs';

const FILE = dataFile('partner.json');

// 返佣比例来自 commissionPlan.mjs（单一事实来源），本文件不再硬编码数字。
// 换档只改环境变量 JX_COMMISSION_PLAN；历史佣金记录里的 rate 已落库，不受改档影响。
// 一级：付费人(payer)的直接邀请人（须为城市合伙人）
// 二级：直接邀请人再往上一级（须同为城市合伙人）
export const COMMISSION_RATES = commissionRates(); // 一级比例（按订单类型映射，同一档）
export const LEVEL2_RATE = PLAN_LEVEL2_RATE; // 二级比例（低于一级；为 0 表示不做二级）
// 提现门槛与限额：**以 siteConfig 运营参数为准**（后台「站点设置」可改，改后即时生效）。
// 不再用代码常量，避免「后台改了门槛、服务端仍按旧值校验」的双源问题。
export function withdrawLimits() {
  const o = ops();
  return {
    min: Number(o.withdrawMin) || 100, // 起提金额（元）
    max: Number(o.withdrawMax) || 5000, // 单笔上限（元）
    dailyMax: Number(o.withdrawDailyMax) || 10000, // 单日累计上限（元）
    dailyCount: Number(o.withdrawDailyCount) || 3, // 单日次数上限（次）
  };
}
// 待结算 → 已结算的账期（毫秒，7 天）
const SETTLE_MS = 7 * 24 * 60 * 60 * 1000;

const db = { seq: 1, commissions: [], withdraws: [], profiles: {} };
function load() {
  const raw = readJson(FILE, null);
  if (raw && Array.isArray(raw.commissions)) {
    db.seq = Number(raw.seq) || 1;
    db.commissions = raw.commissions;
    db.withdraws = raw.withdraws || [];
    db.profiles = raw.profiles || {};
    // 解密提现收款信息（内存明文，写盘加密）
    for (const w of db.withdraws) {
      if (w.account && isEnc(w.account)) w.account = decrypt(w.account);
      if (w.accountName && isEnc(w.accountName)) w.accountName = decrypt(w.accountName);
    }
  }
}
function save() {
  // 仅对写盘副本加密收款敏感字段，内存对象保持明文（供审核打款直用）
  const serial = {
    ...db,
    profiles: db.profiles || {},
    withdraws: db.withdraws.map((w) => ({
      ...w,
      account: encrypt(w.account),
      accountName: encrypt(w.accountName),
    })),
  };
  writeJsonAtomic(FILE, serial);
}
load();

/** 待结算满 7 天自动转已结算（懒结算：读取时调用，无需后台定时器）。
 *  已退款的订单（orderId 关联且状态 refunded）不结算，标记为 cancelled，防多付佣金。 */
export function settleExpired() {
  const now = Date.now();
  let changed = false;
  for (const c of db.commissions) {
    if (c.status === 'pending' && now - c.createdAt >= SETTLE_MS) {
      // 关联订单若已退款 → 该笔佣金作废（退款冲正机制）
      if (c.orderId && isOrderRefunded(c.orderId)) {
        c.status = 'cancelled';
        c.settledAt = now;
        changed = true;
      } else {
        c.status = 'settled';
        c.settledAt = now;
        changed = true;
      }
    }
  }
  if (changed) save();
}

/**
 * 计佣钩子：订单支付成功时调用。
 * 二级返佣（合规 ≤2 级）：
 *   一级：payer 的直接邀请人（须为城市合伙人，且支付发生在升级后）记档位一级比例
 *   二级：直接邀请人的再上一级（须同为城市合伙人，且支付发生在升级后）记档位二级比例
 * 仅基于真实消费触发（非拉人头）；member/renew 下单接入后同一钩子自动生效。
 * @param {object} p { payerId, orderType, amount, orderId?, orderAt? }
 *   orderType ∈ 'points'|'member'|'renew'；orderAt 为订单支付时间（判定「升级后支付」，缺省用当前时间）
 * @returns 佣金记录数组（可能 1 条或 2 条，或无）
 */
export function grantCommission({ payerId, orderType, amount, orderId = '', orderAt = null }) {
  // 分佣铁律总则：仅会员充值金额才产生分润（member/renew），推广一级 15%、二级 5%。加油包（points/boost）不参与分润！
  if (orderType === 'points' || orderType === 'boost') return [];
  const rate = COMMISSION_RATES[orderType];
  const amt = Number(amount) || 0;
  if (!rate || rate <= 0 || amt <= 0) return [];
  const payer = findUserById(payerId);
  if (!payer?.inviterPhone) return [];
  const inviter = findUserByPhone(payer.inviterPhone);
  if (!inviter) return [];
  const paidAt = Number(orderAt) || Date.now();

  const created = [];
  const push = (userId, r, lvl) => {
    const c = Math.round(amt * r * 100) / 100;
    if (c <= 0) return;
    created.push({
      id: `c${db.seq++}`,
      inviterId: userId,
      inviteeId: payer.id,
      orderId: String(orderId || ''), // 关联订单，供退款冲正/不结算判断
      orderType,
      amount: amt,
      rate: r,
      level: lvl,
      commission: c,
      status: 'pending',
      createdAt: paidAt, // 佣金账期按订单支付时间起算
      settledAt: null,
    });
  };

  // 一级：直接邀请人（MED-02 安全加固：防自买自返 — 付费人不能是自己的推荐人）
  if (inviter.partnerAt && paidAt >= inviter.partnerAt && inviter.id !== payerId) {
    push(inviter.id, rate, 1);
  }
  // 二级：直接邀请人的再上一级（同样拦截自买自返环路）
  if (inviter.inviterPhone) {
    const grand = findUserByPhone(inviter.inviterPhone);
    if (grand?.partnerAt && paidAt >= grand.partnerAt && grand.id !== payerId) {
      push(grand.id, LEVEL2_RATE, 2);
    }
  }
  if (!created.length) return [];

  // MED-01 安全加固：单笔订单总返佣硬锁上限校验（COMMISSION_PLAN.totalMax，默认 20%）
  const totalMax = COMMISSION_PLAN.totalMax || 0.20;
  const totalRate = created.reduce((s, c) => s + c.rate, 0);
  if (totalRate > totalMax) {
    const scale = totalMax / totalRate;
    for (const c of created) {
      c.rate = Math.round(c.rate * scale * 10000) / 10000;
      c.commission = Math.round(amt * c.rate * 100) / 100;
    }
    console.warn(`[partnerStore] 单笔返佣超上限(${(totalRate * 100).toFixed(1)}%>${(totalMax * 100).toFixed(1)}%)，已按比例压缩`);
  }

  db.commissions.push(...created);
  save();
  return created;
}

/**
 * 佣金冲正：订单退款时调用，把该订单产生的待结算佣金作废。
 *
 * 分两种情形，处理方式不同（不能一刀切）：
 *   · pending（账期内未结算）→ 直接 cancelled，钱还没发出去，作废即止损；
 *   · settled（账期已满已结算）→ **不能本地扣回**：钱已经在合伙人余额里，可能已被提现。
 *     这里只打 `clawback:true` 标记留给人工/后续对账，绝不静默改动余额，
 *     否则会出现「余额被扣、提现记录对不上」的账实不符。
 * 幂等：已 cancelled 的记录不重复处理。
 * @returns {{cancelled:number, flagged:number}}
 */
export function cancelCommissionByOrder(orderId) {
  const oid = String(orderId || '');
  if (!oid) return { cancelled: 0, flagged: 0 };
  let cancelled = 0;
  let flagged = 0;
  let changed = false;
  for (const c of db.commissions) {
    if (String(c.orderId || '') !== oid) continue;
    if (c.status === 'pending') {
      c.status = 'cancelled';
      c.settledAt = Date.now();
      c.cancelReason = '订单退款冲正';
      cancelled++;
      changed = true;
    } else if (c.status === 'settled' && !c.clawback) {
      c.clawback = true; // 已结算：仅标记待人工追偿，不动余额
      c.clawbackAt = Date.now();
      flagged++;
      changed = true;
    }
  }
  if (changed) save();
  return { cancelled, flagged };
}

/** 某用户（作为邀请人）的佣金明细，倒序 */
export function commissionsOf(userId) {
  settleExpired();
  return db.commissions.filter((c) => c.inviterId === userId).sort((a, b) => b.createdAt - a.createdAt);
}

/** 合伙人收益汇总（支持一级直推与二级裂变详细统计） */
export function partnerSummary(userId) {
  settleExpired();
  const list = db.commissions.filter((c) => c.inviterId === userId);

  const level1Ids = new Set();
  const level2Ids = new Set();
  let level1Comm = 0;
  let level2Comm = 0;

  for (const c of list) {
    // HIGH-04 安全加固：已冲正作废的佣金不计入收益展示，防止财务报表虚高
    if (c.status === 'cancelled') continue;
    if (c.level === 2) {
      level2Ids.add(c.inviteeId);
      level2Comm += Number(c.commission || 0);
    } else {
      level1Ids.add(c.inviteeId);
      level1Comm += Number(c.commission || 0);
    }
  }

  const pending = list.reduce((s, c) => s + (c.status === 'pending' ? Number(c.commission || 0) : 0), 0);
  const settled = list.reduce((s, c) => s + (c.status === 'settled' ? Number(c.commission || 0) : 0), 0);
  const withdrawn = db.withdraws
    .filter((w) => w.userId === userId && w.status !== 'rejected' && w.status !== 'failed') // 拒绝/打款失败不占用可提现
    .reduce((s, w) => s + Number(w.amount || 0), 0);

  return {
    invitedCount: level1Ids.size + level2Ids.size, // 累计下线总数
    level1Count: level1Ids.size, // 一级直推人数
    level2Count: level2Ids.size, // 二级裂变人数
    level1Commission: Math.round(level1Comm * 100) / 100, // 一级分佣收益
    level2Commission: Math.round(level2Comm * 100) / 100, // 二级分佣收益
    totalCommission: Math.round((pending + settled) * 100) / 100,
    pending: Math.round(pending * 100) / 100,
    settled: Math.round(settled * 100) / 100,
    withdrawn: Math.round(withdrawn * 100) / 100,
    withdrawable: Math.round((settled - withdrawn) * 100) / 100,
  };
}

/** 某用户当天已发起且未拒绝的提现金额（含待审/打款中/已打款），用于单日限额 */
function dayWithdrawn(userId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const ts = start.getTime();
  return db.withdraws
    .filter((w) => w.userId === userId && w.status !== 'rejected' && w.status !== 'failed' && (w.createdAt || 0) >= ts)
    .reduce((s, w) => s + Number(w.amount || 0), 0);
}

/** 某用户当天已发起的提现次数（含待审/打款中/已打款，不含被拒绝/打款失败），用于单日次数限额 */
function dayWithdrawCountOf(userId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const ts = start.getTime();
  return db.withdraws.filter(
    (w) => w.userId === userId && w.status !== 'rejected' && w.status !== 'failed' && (w.createdAt || 0) >= ts,
  ).length;
}

/**
 * 发起提现（二次校验 + 限额 + 幂等 + 可提现余额 + 手续费）
 * passwordVerified：提现发起前需通过登录密码二次验证（由路由层校验后置 true，
 * 存储层不再重复校验，避免与 userStore 耦合）。
 */
export function createWithdraw({ userId, amount, requestId, passwordVerified = false }) {
  if (!passwordVerified) {
    return { error: '请先完成身份验证（输入登录密码）' };
  }
  // 门槛与限额按当前生效配置取值（一次取齐，避免校验过程中配置被改导致判断不一致）
  const lim = withdrawLimits();
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < lim.min) {
    return { error: `提现金额不能低于 ${lim.min} 元` };
  }
  if (amt > lim.max) {
    return { error: `单笔提现不能超过 ${lim.max} 元` };
  }
  const rid = String(requestId || '').trim();
  if (rid) {
    // 幂等：同一 clientRequestId 重复提交 → 直接返回已创建的记录，不重复扣减
    const existed = db.withdraws.find((w) => w.userId === userId && w.requestId === rid);
    if (existed) return { record: existed };
  }
  // 收款信息以用户已锁定存证的支付宝资料为准（不信任前端传入），完整账号落库（写盘加密）
  const u = findUserById(userId);
  if (!u) return { error: '用户不存在' };
  const pay = withdrawPayInfo(u);
  if (!pay.ok) return { error: pay.error };
  const countLeft = lim.dailyCount - dayWithdrawCountOf(userId);
  if (countLeft <= 0) {
    return { error: `今日提现次数已达上限（每日最多 ${lim.dailyCount} 次）` };
  }
  const sum = partnerSummary(userId);
  const rounded = Math.round(amt * 100) / 100;
  if (rounded > sum.withdrawable) {
    return { error: '可提现余额不足' };
  }
  const dailyLeft = lim.dailyMax - dayWithdrawn(userId);
  if (rounded > dailyLeft) {
    return { error: `今日累计提现已达上限，还可提 ${Math.max(0, Math.round(dailyLeft * 100) / 100)} 元` };
  }
  // 提现手续费：按 siteConfig 配置（与打款时 payOut 口径一致）
  const feeInfo = withdrawFee(rounded);
  if (!feeInfo.ok) {
    return { error: '手续计算失败，请稍后重试' };
  }
  const fee = feeInfo.fee;
  const rec = {
    id: `w${db.seq++}`,
    userId,
    amount: rounded,
    fee, // 提现手续费（元，与打款实扣一致）
    arrival: String(ops().withdrawArrival || 'T1'), // 到账时效（siteConfig 运营参数，下单时快照留档）
    payChannel: 'alipay', // 打款通道：支付宝（平台企业支付宝 → 收款人支付宝）
    accountName: pay.accountName, // 收款人（支付宝实名姓名）
    account: pay.account, // 支付宝账号（落盘加密，仅审核/打款可见）
    qr: pay.qr, // 支付宝收款码（/uploads/partner/{uid}/...，审核确认用）
    docs: pay.docs, // 收款码快照（/uploads/partner/{uid}/...）
    requestId: rid || `w${db.seq}`,
    status: 'pending', // pending → approved(打款中) → paid(已打款) / rejected(已拒绝) / failed(打款失败已退回)
    note: '',
    createdAt: Date.now(),
    processedAt: null,
  };
  db.withdraws.push(rec);
  save();
  return { record: rec };
}

/**
 * 从用户已存证的提现资料提取打款收款信息（支付宝单通道）。
 * 仅当用户已提交提现资料（实名 + 支付宝账号 + 收款码）才返回不外传。
 * 资金方向：平台企业支付宝 → 收款人支付宝。
 */
export function withdrawPayInfo(u) {
  if (!u?.withdrawProfileReadyAt) {
    return { ok: false, error: '请先完善提现资料（实名 + 支付宝账号 + 收款码）' };
  }
  if (!u.alipayAccount || !u.alipayName) {
    return { ok: false, error: '请完善支付宝收款信息后再提现' };
  }
  return {
    ok: true,
    accountName: u.alipayName, // 支付宝实名姓名（转账核验用）
    account: String(u.alipayAccount || '').trim(), // 支付宝账号（手机号/邮箱）
    qr: u.alipayQr || '', // 支付宝收款码（审核确认用）
    docs: [u.alipayQr].filter(Boolean),
  };
}

/** 某用户的提现记录，倒序 */
export function withdrawsOf(userId) {
  return db.withdraws.filter((w) => w.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
}

/** 全部提现记录（管理端），倒序 */
export function listAllWithdraws() {
  return [...db.withdraws].sort((a, b) => b.createdAt - a.createdAt);
}

/** 管理员审核提现：action ∈ 'approved'|'paid'|'rejected'；拒绝/通过需重置到合理状态 */
export function reviewWithdraw(id, action, note = '', opt = {}) {
  const w = db.withdraws.find((x) => x.id === id);
  if (!w) return null;
  if (action === 'approved' && w.status === 'pending') w.status = 'approved';
  else if (action === 'paid' && (w.status === 'approved' || w.status === 'pending')) {
    w.status = 'paid';
    if (typeof opt.net === 'number') w.net = opt.net; // 实发到账（提现额 − 手续费 − 个税）
    if (typeof opt.tax === 'number') w.tax = opt.tax; // 代扣个税
    if (typeof opt.fee === 'number') w.fee = opt.fee; // 提现手续费
  } else if (action === 'rejected' && w.status !== 'paid') w.status = 'rejected';
  else if (action === 'failed' && w.status !== 'paid')
    w.status = 'failed'; // 打款失败 → 自动退回（不再占用可提现）
  else return { error: '当前状态不允许该操作' };
  w.note = String(note || '')
    .trim()
    .slice(0, 200);
  w.processedAt = Date.now();
  save();
  return w;
}

/** 打款失败回滚：把处于打款中(pending/approved)的提现标记为 failed，金额自动退回可提现余额 */
export function markWithdrawFailed(id, note = '打款失败，金额已自动退回') {
  const w = db.withdraws.find((x) => x.id === id);
  if (!w) return null;
  if (w.status === 'paid') return { error: '已打款不可回滚' };
  w.status = 'failed';
  w.note = w.note ? `${w.note}；${note}` : note;
  w.processedAt = Date.now();
  save();
  return w;
}

/**
 * 打款凭证：管理员打款后上传的转账截图/回单，随提现记录永久保存并展示。
 * 文件本身存 uploads/withdraw-proof/{id}/，本函数仅落库 proofUrl 引用。
 * @param {string} id 提现单号
 * @param {string} proofUrl 相对地址 withdraw-proof/{id}/{file}
 * @param {string} byUserId 上传管理员 userId
 */
export function attachWithdrawProof(id, proofUrl, byUserId = '') {
  const w = db.withdraws.find((x) => x.id === id);
  if (!w) return null;
  w.proofUrl = String(proofUrl || '').trim();
  w.proofAt = Date.now();
  w.proofBy = String(byUserId || '');
  save();
  return w;
}

/** 全部佣金记录（管理端），倒序 */
export function listAllCommissions() {
  settleExpired();
  return [...db.commissions].sort((a, b) => b.createdAt - a.createdAt);
}

/** 保存/更新合伙人支付宝提现资料 */
export function savePartnerProfile(userId, { alipayName, alipayAccount, alipayQr }) {
  if (!db.profiles) db.profiles = {};
  const uid = String(userId || 'default');
  db.profiles[uid] = {
    alipayName: String(alipayName || '').trim(),
    alipayAccount: String(alipayAccount || '').trim(),
    alipayQr: String(alipayQr || ''),
    updatedAt: Date.now(),
  };
  save();
  return db.profiles[uid];
}

/** 获取合伙人支付宝提现资料 */
export function getPartnerProfile(userId) {
  if (!db.profiles) db.profiles = {};
  const uid = String(userId || 'default');
  return db.profiles[uid] || null;
}

/**
 * @deprecated CRITICAL-01 安全修复：此函数已永久废弃。
 * 原函数完全绕过可提现余额校验、单日限额/次数限制与密码二次验证，
 * 存在被恶意无限提现掏空平台资金的致命漏洞。
 * 前台提现统一走 createWithdraw()（含 6 重安全门禁）。
 */
export function submitDirectWithdraw() {
  return { error: '该提现接口已因安全审计永久停用，请使用正式提现通道（createWithdraw）' };
}
