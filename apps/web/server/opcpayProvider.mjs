// 简兮 · 一人付（opcpay）支付通道（会员档 + 加油包）
// ---------------------------------------------------------------------------
// 定位：会员档（41~599 元）超支付宝单笔限额；小加油包（¥9.9）由用户配置进入 opcpay。
// 凡在 opcpay 侧配了对应档位的订单一律分流本通道（支付宝收款，商家自己授权的支付宝
// 账户收款，碳基圈为服务商）；平台侧没配的档位回落支付宝官方直连。
//
// 业务模型（平台侧 QUANTITY 次数包；1 次 = 200 站内积分，与 pricing.json 口径一致）：
//   1. 用户下单 → 本地创建订单 → purchase() 拿支付宝付款入口（幂等号 = 订单号）；
//   2. 客户端收银台遮罩展示二维码并轮询 status；
//   3. 确认口径（页面回跳/扫码/购买入口存在均不算付款成功）：
//      实测 purchaseQuery 是「记录」而非支付状态（无 confirmed，payment_status=NOT_AVAILABLE，
//      交易查询能力未开放）→ 付款确认 = access() 权益余额覆盖待核销数量
//      → 整包核销 consume()（幂等号 = 订单号 + ':c'）→ 仅 SUCCEEDED 且 confirmed 才入账；
//   4. 入账复用统一履约层 fulfillPaidOrder（积分 + 会员身份 + 分佣，markPaid 幂等）；
//   5. UNKNOWN/PROCESSING 一律不交付；核销恢复永远用原业务号，不换号重扣。
//
// 安全红线：
//   - API Key 只存服务端环境变量 opcpay_api_key，不进前端/Git/日志；
//   - 价格与到账积分只认服务端价目表与 opcpay product()，不采信客户端报数；
//   - 双侧价目漂移（本地订单价 ≠ 平台 SKU 价）一律拦截。

import { opcpay as OpcpayClient } from 'opcpay';
import { ordersOf, getOrder } from './payStore.mjs';
import { fulfillPaidOrder } from './payFulfillment.mjs';
import { dataFile, readJson, writeJsonAtomic } from './dataStore.mjs';

let client = null;
let clientInitFailed = '';

function getClient() {
  if (client) return client;
  const key = String(process.env.opcpay_api_key || process.env.OPCPAY_API_KEY || '').trim();
  if (!key) {
    clientInitFailed = '未配置 opcpay_api_key';
    return null;
  }
  try {
    client = new OpcpayClient({ apiKey: key });
    clientInitFailed = '';
  } catch (err) {
    clientInitFailed = err.message || 'opcpay 初始化失败';
  }
  return client;
}

/** 通道就绪状态（供路由 503 判断） */
export function opcpayStatus() {
  const c = getClient();
  return { ready: !!c, reason: c ? '' : (clientInitFailed || 'opcpay 未初始化') };
}

// —— 套餐缓存：product() 结果缓存 5 分钟 ——
let productCache = { at: 0, data: null };

async function getProduct(force = false) {
  const c = getClient();
  if (!c) throw new Error('opcpay 未就绪');
  const now = Date.now();
  if (!force && productCache.data && now - productCache.at < 5 * 60 * 1000) {
    return productCache.data;
  }
  const data = await c.product();
  if (!data || data.capability_status !== 'ENABLED') {
    throw new Error('一人付商品未启用（capability_status=' + (data && data.capability_status) + '）');
  }
  productCache = { at: now, data };
  return data;
}

// —— 购买意图落盘（通道判定 + 恢复 + 履约审计的依据） ——
const INTENT_FILE = dataFile('opcpay-purchases.json');
let intents = readJson(INTENT_FILE, {}) || {};
function saveIntents() {
  writeJsonAtomic(INTENT_FILE, intents);
}

/** 该订单是否已登记为一入付通道订单 */
export function isOpcpayOrder(orderId) {
  return !!intents[String(orderId)];
}

/**
 * 站内档位 → opcpay SKU 映射。
 * 优先按档位 id / 商品名匹配 display_name（lite/plus/pro/ultra/小加油包），其次按价格精确匹配。
 * 匹配不到抛错 —— 调用方据此回落支付宝官方直连。
 */
export async function resolveSkuForTier(tierId, amount, pkgName = '') {
  const product = await getProduct();
  const options = Array.isArray(product.charging_options) ? product.charging_options : [];
  if (!options.length) throw new Error('一人付商品未配置收费档位');
  const norm = (v) => String(v || '').trim().toLowerCase();
  const id = norm(tierId);
  const pkg = norm(pkgName);
  let hit = (id || pkg) && options.find((o) => {
    const dn = norm(o.display_name);
    return (id && dn === id) || (pkg && dn && (dn === pkg || dn.includes(pkg) || pkg.includes(dn)));
  });
  if (!hit && amount > 0) {
    hit = options.find((o) => Math.abs(Number(o.price) - amount) < 0.005);
  }
  if (!hit) throw new Error(`档位[${tierId || pkgName || amount}]在一人付侧无对应档位`);
  return hit;
}

/**
 * 创建付款入口（幂等：幂等号 = 本地订单号，重试/复查还原同一入口）。
 * @returns {{purchaseUrl?:string, qrPayload?:string, expireTime?:string, sku:object}}
 */
export async function createOpcpayPurchase(order) {
  const c = getClient();
  if (!c) throw new Error('opcpay 未就绪');
  const sku = await resolveSkuForTier(order.tierId, order.amount, order.pkg);
  // 校验金额一致：本地订单价必须等于平台 SKU 价，防止两侧价目漂移
  if (Math.abs(Number(sku.price) - Number(order.amount)) >= 0.005) {
    throw new Error(`档位价格不一致（本地 ¥${order.amount} / 平台 ¥${sku.price}），已拦截`);
  }
  const entry = await c.purchase({
    userId: String(order.userId),
    idempotencyKey: String(order.id),
    skuId: sku.sku_id,
  });
  if (!entry || entry.status === 'FAILED') {
    throw new Error((entry && entry.message) || '创建购买入口失败');
  }
  let out = entry;
  if (entry.status === 'UNKNOWN') {
    // UNKNOWN 不当作失败：purchaseQuery 按原号恢复（记录结构：原购买响应嵌在 response 中）
    out = (await c.purchaseQuery(String(order.userId), String(order.id)))?.response || null;
    if (!out || !out.purchase_url) throw new Error('购买入口状态未知，请稍后重试');
  }
  // 登记购买意图（先落盘再返回，崩溃恢复有据可查）
  intents[String(order.id)] = {
    skuId: sku.sku_id,
    quotaAmount: Number(sku.quota_amount) || 0,
    quotaUnit: sku.quota_unit || 'COUNT',
    kind: order.kind || 'points',
    tierId: order.tierId || null,
    createdAt: order.createdAt || Date.now(),
  };
  saveIntents();
  return { purchaseUrl: out.purchase_url, qrPayload: out.purchase_qr_code, expireTime: out.expire_time, sku };
}

/** 查询核销结果（恢复用）：同原业务号 */
async function consumptionOf(orderId, uid) {
  const c = getClient();
  try {
    return await c.consumption(String(uid), String(orderId) + ':c');
  } catch (_) {
    return null;
  }
}

/**
 * 确认并履约一笔一人付订单（幂等，可在轮询/补扫中重复调用）。
 * 返回：{pending:true} | {paid:true, order, addedPoints, newBalance} | {error}
 */
export async function confirmOpcpayOrder(order) {
  const c = getClient();
  if (!c) return { pending: true };
  const uid = String(order.userId);
  const orderId = String(order.id);

  // 0) 已支付订单直接幂等返回
  if (order.status === 'paid') {
    return { paid: true, order, addedPoints: 0, alreadyPaid: true };
  }

  // 1) 购买入口记录必须存在（付款确认口径见文件头注释，不依赖入口存在本身）
  let entry = null;
  try {
    entry = await c.purchaseQuery(uid, orderId);
  } catch (err) {
    return { pending: true, note: 'purchaseQuery 异常: ' + err.message };
  }
  if (!entry) return { pending: true };
  const resp = entry.response || entry;
  if (!resp || !resp.purchase_url) return { pending: true };

  // 2) 待核销数量：优先取下单时落盘的意图，其次取记录里的档位信息
  const intent = intents[orderId] || {};
  const sku = resp.charging_option || null;
  const quotaAmount = Number(intent.quotaAmount)
    || Number(sku && sku.quota_amount)
    || 0;
  if (!quotaAmount) return { error: '无法确定档位数量，履约中止' };

  // 3) 之前核销已成功但履约中断 → 恢复履约（不重复核销）
  const prev = await consumptionOf(orderId, uid);
  if (prev && prev.status === 'SUCCEEDED' && prev.confirmed) {
    return fulfill(order, 'opcpay-recover');
  }
  if (prev && (prev.status === 'PROCESSING' || prev.status === 'UNKNOWN')) {
    return { pending: true }; // 核销结果未明：不交付、不重扣
  }

  // 4) 权益余额足够才核销（余额不足说明到账有延迟，等下一轮）。
  //    平台约定：次数包 access() 的 amount 必须为 1（仅为查询动作），余额覆盖判断在本地做。
  let access = null;
  try {
    access = await c.access(uid, 1);
  } catch (err) {
    return { pending: true, note: 'access 异常: ' + err.message };
  }
  const remaining = Number(access && access.remaining);
  if (!access || !(remaining >= quotaAmount)) {
    return { pending: true }; // 到账延迟：继续轮询
  }

  // 5) 正式核销（幂等号 = 订单号 + ':c'，失败恢复永远同号）
  let consume;
  try {
    consume = await c.consume({
      userId: uid,
      idempotencyKey: orderId + ':c',
      amount: quotaAmount,
      reason: `权益转积分 订单${orderId} 档位${(sku && sku.display_name) || intent.tierId || order.tierId || order.pkg || ''}`,
    });
  } catch (err) {
    return { pending: true, note: 'consume 异常: ' + err.message };
  }
  if (consume && consume.status === 'SUCCEEDED' && consume.confirmed) {
    return fulfill(order, 'opcpay-query');
  }
  if (consume && consume.status === 'FAILED') {
    return { error: '核销失败: ' + (consume.message || consume.reason_code || '未知原因') };
  }
  return { pending: true }; // PROCESSING/UNKNOWN：不交付
}

/** 核销成功 → 复用统一履约层入账（积分 + 会员身份 + 分佣，markPaid 幂等） */
function fulfill(order, via) {
  const f = fulfillPaidOrder(order.id, { via });
  if (!f.ok) return { error: f.message || '履约失败' };
  return { paid: true, order: f.order, addedPoints: f.addedPoints, newBalance: f.newBalance, alreadyPaid: !!f.alreadyPaid };
}

/**
 * 补扫：确认某用户所有待支付的一人付订单（用户付完款关掉收银台时的兜底恢复）。
 * 供轮询接口顺带触发 / webhook 权益事件触发。excludeOrderId 跳过当前轮询中的订单避免重复确认。
 * 同一用户多笔待付单按下单时间先后核销，保证外部余额归属正确（先买先得）。
 */
export async function sweepUserMemberOrders(uid, excludeOrderId = null) {
  const c = getClient();
  if (!c) return [];
  const results = [];
  // 待确认范围：pending 单 + 35 分钟内过期单（本地 10 分钟关单但二维码仍有效 30 分钟，
  // 用户晚付款的场景由 markPaid 复活 expired 单正常入账 —— 「钱到了就入账」原则）。
  const inSweepWindow = (o) =>
    o.status === 'pending' ||
    (o.status === 'expired' && Date.now() - (o.createdAt || 0) < 35 * 60 * 1000);
  const pendingOrders = ordersOf(String(uid))
    .filter((o) => isOpcpayOrder(o.id) && inSweepWindow(o) && !(excludeOrderId && String(o.id) === String(excludeOrderId)))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  for (const o of pendingOrders) {
    try {
      const r = await confirmOpcpayOrder(o);
      results.push({ orderId: o.id, outcome: r.error ? 'error' : r.paid ? 'paid' : 'pending' });
    } catch (_) {
      results.push({ orderId: o.id, outcome: 'pending' });
    }
  }
  return results;
}

// —— 周期兜底扫描：用户付完款直接关掉收银台/离线时的最终恢复手段 ——
// 每 60s 扫一遍购买意图，凡窗口内（35 分钟）未终态的订单按用户分组补扫。
// 未配置 webhook 时它是唯一的全量恢复通道；配置后与 webhook 互为冗余。
const SWEEP_INTERVAL_MS = 60 * 1000;
const SWEEP_WINDOW_MS = 35 * 60 * 1000;
setInterval(() => {
  const c = getClient();
  if (!c) return;
  const now = Date.now();
  const uids = new Set();
  for (const [orderId, meta] of Object.entries(intents)) {
    if (now - (meta.createdAt || 0) > SWEEP_WINDOW_MS) continue;
    const o = getOrder(orderId);
    if (!o || o.status === 'paid' || o.status === 'refunding' || o.status === 'refunded') continue;
    if (o.userId) uids.add(String(o.userId));
  }
  for (const uid of uids) {
    sweepUserMemberOrders(uid).catch(() => {});
  }
}, SWEEP_INTERVAL_MS).unref();
