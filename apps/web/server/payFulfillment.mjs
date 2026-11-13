// 简兮 · 支付入账履约层（唯一入口）
// ---------------------------------------------------------------------------
// 支付成功后的权益发放（积分/会员/分佣）只有这一份实现：
//   - 模拟入账（PAY_SIMULATE=1 联调）与真实支付宝回调（验签通过）都走 fulfillPaidOrder；
//   - markPaid 幂等（已支付直接返回原单），重复通知/重复查询不会重复入账；
//   - 生产红线：入账只允许由「验签通过的异步通知」或「主动查单结果」驱动。

import { markPaid, getOrder } from './payStore.mjs';
import { creditStore } from './creditStore.mjs';
import { updateUser } from './userStore.mjs';
import { grantCommission } from './partnerStore.mjs';

/**
 * 订单支付成功入账（幂等）。
 * @param {string} orderId 订单号
 * @param {{via?:string}} [opts] via: 'alipay-notify' | 'alipay-query' | 'simulate'（仅审计留痕）
 * @returns {{ok:boolean, order?:object, addedPoints?:number, newBalance?:number, alreadyPaid?:boolean, message?:string}}
 */
export function fulfillPaidOrder(orderId, { via = 'unknown' } = {}) {
  const order = getOrder(orderId);
  if (!order) return { ok: false, message: '订单不存在' };
  if (order.status === 'paid') {
    return { ok: true, order, alreadyPaid: true, addedPoints: 0 };
  }
  // 先校验订单归属再改状态：没有 userId 的订单不允许入账
  const uid = String(order.userId || '').trim();
  if (!uid) return { ok: false, message: '订单缺少用户归属，无法入账' };

  const paidOrder = markPaid(orderId);
  const totalPoints = (Number(paidOrder.points) || 0) + (Number(paidOrder.bonus) || 0);

  // 充值积分到商户账本
  if (totalPoints > 0) {
    creditStore.chargeCredits(uid, totalPoints, `购买【${paidOrder.pkg || '点数套餐'}】到账`);
  }

  // 会员订阅：开通会员身份
  if (paidOrder.tierId) {
    try {
      updateUser(uid, {
        tier: paidOrder.tierId,
        memberUntil: Date.now() + 30 * 86400 * 1000,
      });
    } catch (_) {}
  }

  // 合伙人双轨分佣（会员充值分佣，加油包不分润）
  try {
    grantCommission({
      payerId: uid,
      orderType: paidOrder.kind || 'points',
      amount: paidOrder.amount,
      orderId: paidOrder.id,
      orderAt: paidOrder.paidAt || Date.now(),
    });
  } catch (_) {}

  console.log(`[PAY-FULFILL] 订单 ${paidOrder.id} 已入账 via=${via} points=${totalPoints} amount=${paidOrder.amount}`);
  return {
    ok: true,
    order: paidOrder,
    addedPoints: totalPoints,
    newBalance: creditStore.getBalance(uid),
  };
}
