// 简兮 · 结算网关与手续费/个税代扣计算 (apps/web/server/settlementGateway.mjs)
// 遵循：依法代扣个税、1% 手续费（最低 2 元）

import { ops } from './siteConfig.mjs';

/**
 * 计算提现手续费
 * @param {number} amount 提现金额 (元)
 * @returns {number} 手续费金额
 */
export function withdrawFee(amount) {
  const o = ops();
  const amt = Number(amount) || 0;
  const ratePct = Number(o.withdrawFeeRatePct) || 1;
  const minFee = Number(o.withdrawFeeMin) || 2;
  const calculated = (amt * ratePct) / 100;
  // 取整到分，防浮点精度漂移；返回结构体与 createWithdraw 调用方约定一致
  const fee = Math.round(Math.max(calculated, minFee) * 100) / 100;
  return { ok: true, fee };
}

/**
 * 劳务报酬个税预扣计算 (当月累计合并套档)
 * @param {number} currentMonthTotal 当月累计提现总额
 * @returns {number} 预扣个税
 */
export function calculateTax(currentMonthTotal) {
  const m = Number(currentMonthTotal) || 0;
  if (m <= 800) return 0;
  if (m <= 4000) return (m - 800) * 0.2;
  if (m <= 20000) return m * 0.8 * 0.2;
  if (m <= 50000) return m * 0.8 * 0.3 - 2000;
  return m * 0.8 * 0.4 - 7000;
}
