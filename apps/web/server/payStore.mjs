// 简兮 · 充值订单存储（JSON 文件持久化，供支付下单/回调核对）
// 落盘：server/data/pay-orders.json；订单状态 pending(待支付) → paid(已到账)
// 与具体支付通道无关：通道适配层见 paymentProvider.mjs。

import crypto from 'node:crypto';
import { dataFile, readJson, writeJsonAtomic } from './dataStore.mjs';

const FILE = dataFile('pay-orders.json');

/** 时间戳 → yyyyMMdd（下单日期，通道查单/退款需按原交易日反查原交易） */
function ymd(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

let orders = [];
function load() {
  const raw = readJson(FILE, null);
  if (Array.isArray(raw)) orders = raw;
}
function save() {
  writeJsonAtomic(FILE, orders);
}
load();

// 退款通道关闭时长：支付成功 72 小时后不再允许退款（佣金 7 天账期 > 72h，防多付佣）
export const REFUND_HOURS = 72;

// 未支付订单自动关闭：pending 超过 10 分钟 → expired（终态，仅留档审计，用户列表不再展示）。
// 大厂通行做法：未支付单短超时自动关（支付宝/淘宝 15 分钟左右），已支付单按《电子商务法》
// 第 31 条要求交易信息自交易完成之日起留存不少于 3 年 —— 所以这里只关单、绝不物理删除。
// 通道侧同步在下单时传 timeout_express='10m'（见 paymentProvider），让支付宝二维码同时失效；
// 若用户仍凭旧码在关单后完成支付，markPaid 会把 expired 复活为 paid 并正常入账 —— 钱到了就入账。
export const PENDING_TTL_MS = 10 * 60 * 1000;

/** 关闭超时未支付订单（幂等：已关的不重复处理）。返回本次关闭的数量（0 = 无变化不落盘）。 */
export function sweepExpiredOrders(now = Date.now()) {
  let n = 0;
  for (const o of orders) {
    if (o.status === 'pending' && now - (o.createdAt || 0) > PENDING_TTL_MS) {
      o.status = 'expired';
      o.expiredAt = now;
      n++;
    }
  }
  if (n) save();
  return n;
}

// 每分钟扫一次（模块级常驻，随进程存活）；ordersOf / getAllOrders 读取前也会先扫一遍兜底，
// 保证「用户刚打开订单页」时看到的一定是刚关过单的新鲜状态。
setInterval(() => sweepExpiredOrders(), 60 * 1000).unref();

/** 创建待支付订单（积分在支付成功回调里到账，不在下单时加）
 *  kind ∈ 'points' | 'member' | 'renew'（会员购买/续费），用于计佣路由
 *  tierId：会员订单记录目标等级，支付回调（notify）据此开通/续期等级
 *  billingMode：'sub' 连续包月 | 'single' 单月购买；lockedPrice 连续包月续订锁定价（次月自动扣费用） */
export function createOrder({
  userId,
  pkg,
  amount,
  points,
  bonus,
  kind = 'points',
  tierId = null,
  billingMode = null,
  lockedPrice = null,
  channel = null,
  channelReqSeqId = null,
  channelSeqId = null,
  trackingSource = null,
  promoCode = null,
}) {
  const now = Date.now();
  const order = {
    id: `po-${crypto.randomBytes(8).toString('hex')}`,
    userId,
    kind: kind || 'points',
    pkg: pkg || null,
    tierId: tierId || null,
    amount: Number(amount) || 0,
    points: Number(points) || 0,
    bonus: Number(bonus) || 0,
    billingMode: billingMode || null,
    lockedPrice: Number(lockedPrice) > 0 ? Number(lockedPrice) : null,
    channel: channel || null,
    channelReqSeqId: channelReqSeqId || null, // 通道请求流水号（默认 = order.id）
    channelSeqId: channelSeqId || null, // 通道交易流水号（下单后回填）
    trackingSource: trackingSource || 'direct', // 渠道来源: zhihu / baijiahao / toutiao / xhs / dy / direct
    promoCode: promoCode || null, // 专属渠道口令/特惠码
    // 下单当日的日期（yyyyMMdd），原样留档：通道查单/退款的「原交易日期」必须与它严格一致，
    // 若在查询时用 createdAt 现算，跨零点的订单会因日期漂移而「查无此单」。
    reqDate: ymd(now),
    notifyCount: 0, // 异步通知到达次数（幂等/审计）
    status: 'pending',
    createdAt: now,
    paidAt: null,
  };
  orders.push(order);
  save();
  return order;
}

export function getOrder(id) {
  return orders.find((o) => o.id === id) || null;
}

/** 回填收银台链接（扫码短链 302 中转用）：仅 pending 态写入，终态订单防改写 */
export function attachPayUrl(id, url) {
  const o = getOrder(id);
  if (!o || !url || o.status !== 'pending') return o;
  o.payUrl = String(url);
  save();
  return o;
}

/** 由通道请求流水号还原订单 */
export function getOrderByChannelReqSeq(reqSeq) {
  if (!reqSeq) return null;
  return orders.find((o) => o.id === reqSeq || o.channelReqSeqId === reqSeq) || null;
}

/** 标记订单已支付（幂等：已支付直接返回原单，不重复入账） */
export function markPaid(id) {
  const o = getOrder(id);
  if (!o) return null;
  if (o.status === 'paid') return o;
  o.status = 'paid';
  o.paidAt = Date.now();
  save();
  return o;
}

/** 异步通知落账：回填通道交易流水号并累计通知次数（不改变状态，供审计/幂等） */
export function touchNotify(orderId, channelSeqId) {
  const o = getOrder(orderId);
  if (!o) return null;
  o.notifyCount = (o.notifyCount || 0) + 1;
  if (channelSeqId) o.channelSeqId = channelSeqId;
  save();
  return o;
}

/** 用户主动关闭待支付订单（幂等：仅 pending → expired；已支付/已退款单不动） */
export function closeOrder(id, closedBy = 'user') {
  const o = getOrder(id);
  if (!o || o.status !== 'pending') return o || null;
  o.status = 'expired';
  o.expiredAt = Date.now();
  o.closedBy = String(closedBy || 'user');
  save();
  return o;
}

export function ordersOf(userId) {
  sweepExpiredOrders(); // 展示前先关掉超时单，用户永远看不到陈年 pending
  return orders.filter((o) => o.userId === userId);
}

/** 全部订单（管理端，按创建时间倒序）。expired（已关闭）保留在列，后台可审计。 */
export function getAllOrders() {
  sweepExpiredOrders();
  return [...orders].sort((a, b) => b.createdAt - a.createdAt);
}

/** 退款（幂等：已退款直接返回；仅 pending/paid → refunded）。
 *  受 REFUND_HOURS 限制：支付成功超过 72 小时后拒绝退款（关闭退款通道）。
 *  返回 { ok } 或 { ok:false, message }。 */
export function refundOrder(id, { reason = '', refundedBy = '' } = {}) {
  const o = getOrder(id);
  if (!o) return { ok: false, message: '订单不存在' };
  if (o.status === 'refunded') return { ok: true, refunded: o };
  const baseTs = o.paidAt || o.createdAt;
  if (baseTs && Date.now() - baseTs > REFUND_HOURS * 3600 * 1000) {
    return { ok: false, message: `支付成功超过 ${REFUND_HOURS} 小时后已关闭退款通道` };
  }
  if (o.status === 'pending' || o.status === 'paid') {
    o.status = 'refunded';
    o.refundedAt = Date.now();
    o.reason = String(reason || '');
    o.refundedBy = String(refundedBy || '');
    save();
  }
  return { ok: true, refunded: o };
}

/** 该订单是否已退款（佣金结算判断用；未找到订单按未退款处理）
 *  「退款中(refunding)」一并视为不可结算：退款已发起、资金去向未定，此时结算佣金会造成多付。 */
export function isOrderRefunded(id) {
  const o = getOrder(String(id || ''));
  return !!o && (o.status === 'refunded' || o.status === 'refunding');
}

/**
 * 退款受理中：已向通道成功发起退款，等待异步通知确认终态。
 * 通道退款「同步返回仅代表受理成功」，故此处不能直接置 refunded，否则会出现
 * 「后台显示已退款、用户实际未收到钱」的账实不符。
 */
export function markRefunding(id, { reason = '', refundedBy = '', refundSeqId = '' } = {}) {
  const o = getOrder(id);
  if (!o) return null;
  if (o.status === 'refunded') return o; // 已终态，不降级
  o.status = 'refunding';
  o.refundSeqId = String(refundSeqId || '');
  o.reason = String(reason || '');
  o.refundedBy = String(refundedBy || '');
  o.refundingAt = Date.now();
  save();
  return o;
}

/** 退款成功终态：由退款异步通知 / 退款查单确认后落账（幂等，可重复调用） */
export function markRefunded(id, { refundAmt = 0, channelRefundSeqId = '' } = {}) {
  const o = getOrder(id);
  if (!o) return null;
  if (o.status === 'refunded') return o;
  o.status = 'refunded';
  o.refundedAt = Date.now();
  if (Number(refundAmt) > 0) o.refundAmt = Number(refundAmt);
  if (channelRefundSeqId) o.channelRefundSeqId = String(channelRefundSeqId);
  save();
  return o;
}

/**
 * 退款失败回滚：通道退款失败时资金并未退出商户账户，
 * 因此本地必须回到「已支付」而不是停在「退款中」或误置「已退款」，
 * 后台可据此重新发起退款。
 */
export function markRefundFailed(id, reason = '') {
  const o = getOrder(id);
  if (!o) return null;
  if (o.status === 'refunded') return o; // 已终态成功，不覆盖
  o.status = 'paid';
  o.refundError = String(reason || '');
  o.refundFailedAt = Date.now();
  save();
  return o;
}

/**
 * 权益冲正标记：与状态机分开记一笔，表示「该订单发放的积分/会员/佣金已经回收」。
 *
 * 为什么不复用 status：状态描述的是**资金**去向（钱退没退），revokedAt 描述的是
 * **权益**去向（发放的东西收没收）。通道退款是异步的 —— 可能出现「已发起退款、资金未到账，
 * 但权益已回收」的中间态；两者混在一个字段里必然出现「显示已退款、积分还在」。
 * 幂等由 revokedAt 自身保证：重复调用不重复扣减。
 */
export function markRevoked(id, { reason = '' } = {}) {
  const o = getOrder(id);
  if (!o) return null;
  if (o.revokedAt) return o;
  o.revokedAt = Date.now();
  o.revokeReason = String(reason || '');
  save();
  return o;
}

/** 该订单的权益是否已冲正（退款链路幂等判据） */
export function isOrderRevoked(id) {
  const o = getOrder(String(id || ''));
  return !!o && !!o.revokedAt;
}
