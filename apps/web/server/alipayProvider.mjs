// 简兮 · 支付宝网页支付通道适配层（AI 网页应用收款 alipay.trade.page.pay）
// ---------------------------------------------------------------------------
// 配置来源：项目根 .alipay-sandbox.json（沙箱，Windows READY 快速沙箱落盘产物，已被 .gitignore 保护）。
// 生产切换：设置 ALIPAY_CONFIG_PATH 指向生产配置文件（同结构），并把 ALIPAY_GATEWAY
// 显式设为生产网关 https://openapi.alipay.com/gateway.do —— 沙箱联调默认沙箱网关，禁止混用。
//
// SDK 核心纪律（来自官方踩坑指南，勿动）：
//   1. Node.js 使用 PKCS#1 私钥（沙箱字段 appPrivatePkcsKey），不做任何格式转换/不加 PEM 头尾；
//   2. alipay.trade.page.pay 是页面跳转类接口，必须 pageExec(method, 'POST', ...)，严禁 exec()；
//   3. exec() 只用于服务端接口（查询/退款/退款查询/关闭）；
//   4. 沙箱网关 https://openapi-sandbox.dl.alipaydev.com/gateway.do。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlipaySdk } from 'alipay-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SANDBOX_GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';
const PROD_GATEWAY = 'https://openapi.alipay.com/gateway.do';

/** 沙箱配置默认落点：apps/web/server → 项目根 */
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '../../../.alipay-sandbox.json');

let sdk = null;
let configInfo = null; // 对外只暴露非敏感描述字段

/**
 * 加载并校验支付宝配置（进程内单例）。
 * 直接读取已验证配置文件；字段映射错误/缺字段时明确失败，绝不回退示例值或占位密钥。
 * @returns {{ready:boolean, appId?:string, gateway:string, reason?:string}}
 */
export function initAlipay() {
  if (configInfo) return configInfo;
  const cfgPath = process.env.ALIPAY_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  const gateway = process.env.ALIPAY_GATEWAY || SANDBOX_GATEWAY;
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    // 快速沙箱落盘结构：{ appIds: [ { appId, appPrivatePkcsKey(PKCS#1), appPrivateKey(PKCS#8), alipayPublicKey, ... } ] }
    const entry = Array.isArray(raw.appIds) ? raw.appIds.find((a) => a && a.appId) : null;
    if (!entry) {
      configInfo = { ready: false, gateway, reason: '配置文件中缺少可用应用（appIds 为空）' };
      return configInfo;
    }
    // Node.js 必须用 PKCS#1（appPrivatePkcsKey）；没有该字段时明确失败，禁止拿 PKCS#8 字段顶替
    const privateKey = String(entry.appPrivatePkcsKey || '').trim();
    const alipayPublicKey = String(entry.alipayPublicKey || '').trim();
    if (!privateKey || !alipayPublicKey) {
      configInfo = { ready: false, gateway, reason: '配置缺少 appPrivatePkcsKey(Node 用 PKCS#1 私钥) 或 alipayPublicKey' };
      return configInfo;
    }
    sdk = new AlipaySdk({
      appId: String(entry.appId),
      privateKey, // 原始密钥字符串，不加 PEM 头尾，SDK 自行包装
      keyType: 'PKCS1',
      alipayPublicKey,
      gateway,
      signType: 'RSA2',
      timeout: 15000,
    });
    configInfo = { ready: true, appId: String(entry.appId), sellerId: String(entry.pid || ''), gateway, sandbox: gateway === SANDBOX_GATEWAY };
    console.log(`[ALIPAY] 通道就绪 appId=${maskAppId(configInfo.appId)} gateway=${gateway === SANDBOX_GATEWAY ? 'sandbox' : 'production'}`);
  } catch (err) {
    configInfo = { ready: false, gateway, reason: `配置加载失败: ${err.message}` };
  }
  return configInfo;
}

/** 对外状态描述（不含任何密钥材料） */
export function alipayStatus() {
  return initAlipay();
}

function client() {
  const st = initAlipay();
  if (!st.ready || !sdk) throw new Error(`支付宝通道未就绪: ${st.reason || '未知原因'}`);
  return sdk;
}

function maskAppId(id) {
  const s = String(id || '');
  return s.length <= 6 ? s : `${s.slice(0, 4)}****${s.slice(-2)}`;
}

/** 时间戳 → 支付宝要求格式 yyyy-MM-dd HH:mm:ss（禁 ISO） */
function alipayTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 金额规整为「元」两位小数字符串（定点语义，不走浮点运算） */
export function yuan(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`金额非法: ${amount}`);
  return n.toFixed(2);
}

/**
 * 生成网站支付表单（页面跳转类接口，POST）。
 * qr_pay_mode=4：官方「可定义宽度的嵌入式二维码」——支付宝返回专用于内嵌 iframe 的
 * 收银台页面，前端把表单以 iframe 为 target 提交即可把支付宝二维码映射进自有卡片，
 * 无需跳转、无需当面付签约。qrcode_width 取值 100~1000。
 * @param {{outTradeNo:string, totalAmount:number|string, subject:string, returnUrl?:string, notifyUrl?:string}} p
 * @returns {string} HTML form 字符串，前端必须渲染并自动提交，禁止当 URL 跳转
 */
export function createPagePayForm(p) {
  const opts = {
    bizContent: {
      out_trade_no: p.outTradeNo,
      total_amount: yuan(p.totalAmount),
      subject: String(p.subject || '简兮订单').slice(0, 120),
      product_code: 'FAST_INSTANT_TRADE_PAY', // 网站支付固定值
      qr_pay_mode: '4', // 嵌入式二维码：支付宝二维码内嵌到商户页面
      qrcode_width: 280, // 嵌入二维码宽度（px）
    },
  };
  // 同步回跳：默认传入且必须对应项目内真实 GET 路由（/alipay/return）
  if (p.returnUrl) opts.returnUrl = p.returnUrl;
  // 异步通知：仅真实生产/公网联调传入；本地无公网地址时省略（不得传 undefined/空串/占位 URL）
  if (p.notifyUrl) opts.notifyUrl = p.notifyUrl;
  return client().pageExec('alipay.trade.page.pay', 'POST', opts);
}

/** 统一取业务字段：SDK 默认 camelcase=true（trade_status → tradeStatus），兼容两种形态 */
function pick(result, snake, camel) {
  if (result == null) return undefined;
  return result[snake] !== undefined ? result[snake] : result[camel !== undefined ? camel : snake];
}

/** 交易状态 → 本地业务状态映射（显式映射，未知不判成功） */
export function mapTradeState(tradeStatus) {
  switch (tradeStatus) {
    case 'TRADE_SUCCESS':
    case 'TRADE_FINISHED':
      return 'PAID';
    case 'WAIT_BUYER_PAY':
      return 'PENDING_PAYMENT';
    case 'TRADE_CLOSED':
      return 'CLOSED';
    default:
      return 'UNKNOWN';
  }
}

/** 交易查询：alipay.trade.query（outTradeNo / tradeNo 二选一，同时存在优先 tradeNo） */
export async function queryTrade({ outTradeNo, tradeNo } = {}) {
  const bizContent = {};
  if (tradeNo) bizContent.trade_no = tradeNo;
  else if (outTradeNo) bizContent.out_trade_no = outTradeNo;
  else throw new Error('queryTrade 需要 outTradeNo 或 tradeNo');
  const result = await client().exec('alipay.trade.query', { bizContent });
  const code = pick(result, 'code');
  if (code !== '10000') {
    // ACQ.TRADE_NOT_EXIST 等：查询成功但交易不存在，业务上按 UNKNOWN 处理，不算接口故障
    return { ok: false, code, subCode: pick(result, 'sub_code', 'subCode'), tradeState: 'UNKNOWN' };
  }
  const tradeStatus = pick(result, 'trade_status', 'tradeStatus');
  return {
    ok: true,
    code,
    tradeNo: pick(result, 'trade_no', 'tradeNo'),
    outTradeNo: pick(result, 'out_trade_no', 'outTradeNo'),
    tradeStatus,
    tradeState: mapTradeState(tradeStatus),
    totalAmount: pick(result, 'total_amount', 'totalAmount'),
  };
}

/**
 * 交易退款：alipay.trade.refund。
 * 新退款必须用新 outRequestNo；同一次退款重试必须复用原编号与原参数（防重复退款）。
 * code=10000 仅代表受理成功；fund_change=Y 才是资金已退，否则必须用退款查询确认。
 */
export async function refundTrade({ outTradeNo, tradeNo, refundAmount, outRequestNo, refundReason = '' } = {}) {
  if (!outRequestNo) throw new Error('refundTrade 需要 outRequestNo');
  const bizContent = {
    refund_amount: yuan(refundAmount),
    out_request_no: outRequestNo,
  };
  if (tradeNo) bizContent.trade_no = tradeNo;
  else if (outTradeNo) bizContent.out_trade_no = outTradeNo;
  else throw new Error('refundTrade 需要 outTradeNo 或 tradeNo');
  if (refundReason) bizContent.refund_reason = String(refundReason).slice(0, 200);
  const result = await client().exec('alipay.trade.refund', { bizContent });
  const code = pick(result, 'code');
  if (code !== '10000') {
    return { ok: false, code, subCode: pick(result, 'sub_code', 'subCode'), msg: pick(result, 'sub_msg', 'subMsg') || pick(result, 'msg') };
  }
  return {
    ok: true,
    code,
    fundChange: pick(result, 'fund_change', 'fundChange'), // 'Y' 资金已退；'N'/缺失 → 退款查询确认
    refundFee: pick(result, 'refund_fee', 'refundFee'),
    tradeNo: pick(result, 'trade_no', 'tradeNo'),
    outTradeNo: pick(result, 'out_trade_no', 'outTradeNo'),
  };
}

/** 退款查询：alipay.trade.fastpay.refund.query（仅 REFUND_SUCCESS 为退款成功；发起别离退款请求太近） */
export async function refundQueryTrade({ outTradeNo, tradeNo, outRequestNo } = {}) {
  if (!outRequestNo) throw new Error('refundQueryTrade 需要 outRequestNo');
  const bizContent = { out_request_no: outRequestNo };
  if (tradeNo) bizContent.trade_no = tradeNo;
  else if (outTradeNo) bizContent.out_trade_no = outTradeNo;
  else throw new Error('refundQueryTrade 需要 outTradeNo 或 tradeNo');
  const result = await client().exec('alipay.trade.fastpay.refund.query', { bizContent });
  const code = pick(result, 'code');
  if (code !== '10000') {
    return { ok: false, code, subCode: pick(result, 'sub_code', 'subCode') };
  }
  const refundStatus = pick(result, 'refund_status', 'refundStatus');
  return {
    ok: true,
    code,
    refundStatus,
    refundSuccess: refundStatus === 'REFUND_SUCCESS',
    refundAmount: pick(result, 'refund_amount', 'refundAmount'),
    outRequestNo: pick(result, 'out_request_no', 'outRequestNo'),
  };
}

/** 关闭交易：alipay.trade.close（仅未付款交易；关闭后不可继续支付） */
export async function closeTrade({ outTradeNo, tradeNo } = {}) {
  const bizContent = {};
  if (tradeNo) bizContent.trade_no = tradeNo;
  else if (outTradeNo) bizContent.out_trade_no = outTradeNo;
  else throw new Error('closeTrade 需要 outTradeNo 或 tradeNo');
  const result = await client().exec('alipay.trade.close', { bizContent });
  const code = pick(result, 'code');
  if (code !== '10000') {
    return { ok: false, code, subCode: pick(result, 'sub_code', 'subCode'), msg: pick(result, 'sub_msg', 'subMsg') || pick(result, 'msg') };
  }
  return { ok: true, code, tradeNo: pick(result, 'trade_no', 'tradeNo'), outTradeNo: pick(result, 'out_trade_no', 'outTradeNo') };
}

/**
 * 验证异步/同步回跳签名。
 * - 异步通知（POST 表单，值为已解码）：checkNotifySignV2(params)
 * - 同步回跳（GET query，须保留原始编码值）：checkNotifySign(rawParams, true)
 * 调用方保证传入当前 SDK 实例对应的参数；验签失败一律不信内容。
 */
export function verifyNotifySign(params) {
  return client().checkNotifySignV2(params);
}

export function verifyReturnSign(rawParams) {
  return client().checkNotifySign(rawParams, true); // raw=true：使用未解码的原始值验签
}

export { alipayTimestamp };
