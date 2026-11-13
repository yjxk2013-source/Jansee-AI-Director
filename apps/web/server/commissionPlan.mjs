// 简兮 · 城市合伙人分佣计划与比例定义 (apps/web/server/commissionPlan.mjs)
// 铁律总则：会员充值金额才产生分润，推广一级 15%、二级 5%。加油包不参与分润。

export const LEVEL1_RATE = 0.15; // 推广一级 15%
export const LEVEL2_RATE = 0.05; // 推广二级 5%

export function commissionRates() {
  return {
    member: LEVEL1_RATE, // 会员购买充值：15%
    renew: LEVEL1_RATE,  // 会员续费充值：15%
    points: 0,           // 铁律：加油包不参与分润 (分润率为 0)
    boost: 0,            // 铁律：加油包不参与分润 (分润率为 0)
  };
}

export const COMMISSION_PLAN = {
  level1: LEVEL1_RATE,
  level2: LEVEL2_RATE,
  totalMax: 0.20,
};
