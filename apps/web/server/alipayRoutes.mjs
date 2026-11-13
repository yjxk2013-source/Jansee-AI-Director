// 简兮 · 支付宝网页支付路由（AI 网页应用收款）
// ---------------------------------------------------------------------------
// 覆盖接口：下单表单 / 交易查询（查单兜底）/ 退款（走 admin 通道退款）/ 退款查询 /
//           关闭交易 / 异步通知处理（验签+幂等）/ 同步回跳结果页（验签后服务端查单定结果）。
//
// 本地无公网 HTTPS notify_url：下单不传 notify_url，支付结果以「主动查单」兜底；
// 通知处理代码始终存在，生产上线前只需配置公网地址并在下单时传入。
//
// 安全红线：
//   - 异步通知按 x-www-form-urlencoded 表单解析（不是 JSON），验签前不丢字段不改字段；
//   - 验签失败返回纯文本 fail；业务成功返回纯文本 success；
//   - 同步回跳参数不是支付成功依据：验签通过也只用于定位订单，最终结果以服务端查单为准；
//   - 金额比较使用「元」两位小数字符串，不走浮点。

import { getOrder, attachPayUrl, markRefunded, touchNotify, closeOrder } from './payStore.mjs';
import { dataFile, readJson, writeJsonAtomic } from './dataStore.mjs';
import { cancelCommissionByOrder } from './partnerStore.mjs';
import { fulfillPaidOrder } from './payFulfillment.mjs';
import {
  alipayStatus,
  createPagePayForm,
  queryTrade,
  refundTrade,
  refundQueryTrade,
  closeTrade,
  verifyNotifySign,
  verifyReturnSign,
} from './alipayProvider.mjs';
import QRCode from 'qrcode';
import {
  opcpayStatus, resolveSkuForTier, createOpcpayPurchase, confirmOpcpayOrder,
  sweepUserMemberOrders, isOpcpayOrder,
} from './opcpayProvider.mjs';
import { verifyWebhook as verifyOpcpayWebhook } from 'opcpay';

// —— 通知事件持久化（幂等防重）：生产必须持久化，内存 Map 仅限非生产 demo ——
const NOTIFY_FILE = dataFile('alipay-notify-events.json');
let notifyEvents = readJson(NOTIFY_FILE, {}) || {};
function saveNotifyEvents() {
  writeJsonAtomic(NOTIFY_FILE, notifyEvents);
}

/** 金额规整为「元」两位小数字符串（BigInt 定点语义，不做浮点比较） */
function normalizeAmountText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  const match = text.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  return `${BigInt(match[1]).toString()}.${(match[2] || '').padEnd(2, '0')}`;
}

function amountEquals(expected, actual) {
  const a = normalizeAmountText(expected);
  const b = normalizeAmountText(actual);
  return a !== null && a === b;
}

/** 付款成功通知判定：付款成功状态 且 不是退款/关单/分账等事件 */
function isPaidTradeNotification(params) {
  const paidStatus = params.trade_status === 'TRADE_SUCCESS' || params.trade_status === 'TRADE_FINISHED';
  return paidStatus && !params.out_biz_no && !params.gmt_refund && !params.refund_fee;
}

/** 退款事件判定：退款通知通常带 out_biz_no / gmt_refund / refund_fee */
function isRefundNotification(params) {
  return Boolean(params.out_biz_no || params.gmt_refund || params.refund_fee);
}

function sanitizeNotifyParams(params) {
  const { sign, ...safeParams } = params;
  return safeParams;
}

/** 同步回跳结果页（服务端渲染的极简壳，0 Emoji，随全站暗色基调） */
function renderReturnPage({ state, title, detail }) {
  const ok = state === 'success';
  const color = ok ? '#4ade80' : '#fbbf24';
  const backHref = '/index.html';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>支付结果 - 简兮</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0a0a0e; color:#e4e4e7; font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  .card { max-width:420px; width:88%; text-align:center; padding:48px 32px;
          background:rgba(255,255,255,0.025); border:1px solid rgba(255,255,255,0.2); border-radius:2px; }
  .state { font-size:22px; font-weight:600; color:${color}; margin:0 0 12px; letter-spacing:0.05em; }
  .detail { font-size:14px; color:#a1a1aa; line-height:1.8; margin:0 0 32px; word-break:break-all; }
  .back { display:inline-block; padding:10px 28px; font-size:14px; color:#e4e4e7; text-decoration:none;
          background:rgba(255,255,255,0.025); border:1px solid rgba(255,255,255,0.2); border-radius:2px; }
  .back:hover { border-color:rgba(255,255,255,0.55); }
</style>
</head>
<body>
  <div class="card">
    <p class="state">${title}</p>
    <p class="detail">${detail}</p>
    <a class="back" href="${backHref}">返回简兮</a>
  </div>
</body>
</html>`;
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  res.end(html);
}

/** 同步回跳地址：默认本地网关 /alipay/return；部署时可用 ALIPAY_RETURN_URL 覆盖为公网地址 */
export function alipayReturnUrl() {
  if (process.env.ALIPAY_RETURN_URL) return String(process.env.ALIPAY_RETURN_URL).trim();
  const port = process.env.PORT || '3000';
  return `http://localhost:${port}/alipay/return`;
}

/**
 * 读取 urlencoded 表单体（对齐 safeReadJson 的 2MB/15s 门禁，但按表单解析）。
 * 支付宝异步通知是 application/x-www-form-urlencoded，不能用 JSON parser。
 */
function readFormUrlencoded(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let len = 0;
    let done = false;
    req.setTimeout(15000, () => {
      if (!done) { done = true; req.destroy(); reject(new Error('notify body timeout')); }
    });
    req.on('data', (chunk) => {
      if (done) return;
      len += chunk.length;
      if (len > 2 * 1024 * 1024) { done = true; req.destroy(); reject(new Error('notify body too large')); return; }
      body += chunk;
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const params = {};
      for (const pair of String(body || '').split('&')) {
        if (!pair) continue;
        const idx = pair.indexOf('=');
        const k = idx < 0 ? pair : pair.slice(0, idx);
        const v = idx < 0 ? '' : pair.slice(idx + 1);
        params[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(v.replace(/\+/g, ' '));
      }
      resolve(params);
    });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

/** 通道退款统一入口（admin 退款流程消费）：同一笔退款重试复用同一 outRequestNo */
export async function channelRefund(order, reason) {
  const st = alipayStatus();
  if (!st.ready) return { ok: false, skipped: true, message: '支付宝通道未就绪' };
  if (String(order.channel || '') !== 'alipay') return { ok: false, skipped: true, message: '订单非支付宝通道' };
  const outRequestNo = `${order.id}-r1`; // 同一订单首笔退款固定请求号：失败重试必须复用
  const r = await refundTrade({
    outTradeNo: order.id,
    refundAmount: order.amount,
    outRequestNo,
    refundReason: reason || '商户退款',
  });
  if (!r.ok) return { ok: false, message: `${r.msg || '通道退款失败'}${r.subCode ? `(${r.subCode})` : ''}` };
  return { ok: true, fundChange: r.fundChange, outRequestNo, refundFee: r.refundFee, tradeNo: r.tradeNo };
}

/** 退款结果补偿确认（受理成功但 fund_change 未确认时，10s 后查单落终态） */
export function scheduleRefundConfirm(orderId, outRequestNo, delayMs = 10 * 1000) {
  setTimeout(async () => {
    try {
      const order = getOrder(orderId);
      if (!order || order.status !== 'refunding') return;
      const r = await refundQueryTrade({ outTradeNo: orderId, outRequestNo });
      if (r.ok && r.refundSuccess) {
        markRefunded(orderId, { refundAmt: order.amount, channelRefundSeqId: outRequestNo });
        try { cancelCommissionByOrder(orderId); } catch (_) {}
        console.log(`[ALIPAY] 退款查询确认成功 订单=${orderId}`);
      } else {
        // 仍未知：保持 refunding，等待异步通知；多次失败由人工后台核查
        console.warn(`[ALIPAY] 退款查询未确认 订单=${orderId} code=${r.code || '-'} sub=${r.subCode || '-'}`);
      }
    } catch (err) {
      console.warn(`[ALIPAY] 退款查询异常 订单=${orderId}: ${err.message}`);
    }
  }, delayMs).unref();
}

/** 读取原始请求体（webhook HMAC 验签必须在解析 JSON 前拿到原始 Buffer） */
function readRawBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    let done = false;
    req.setTimeout(15000, () => {
      if (!done) { done = true; req.destroy(); reject(new Error('webhook body timeout')); }
    });
    req.on('data', (chunk) => {
      if (done) return;
      len += chunk.length;
      if (len > limit) { done = true; req.destroy(); reject(new Error('webhook body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

/** 一人付 webhook 事件持久化去重（生产口径，与支付宝通知事件同等级） */
const OPCPAY_EVENT_FILE = dataFile('opcpay-webhook-events.json');
let opcpayEvents = readJson(OPCPAY_EVENT_FILE, {}) || {};
function saveOpcpayEvents() {
  writeJsonAtomic(OPCPAY_EVENT_FILE, opcpayEvents);
}

/**
 * 注册支付宝路由。返回 (req, res, pathname) => boolean（true = 已处理）。
 * deps 由 index.mjs 注入：{ sendJson, sessionUidOf, rejectNoUid, safeReadJson }
 */
export function createAlipayRouteHandler(deps) {
  const { sendJson, sessionUidOf, rejectNoUid, safeReadJson } = deps;

  // 同步分发（返回 boolean 命中与否），分支内部的异步流程用 async IIFE 承接：
  // 主网关请求处理器是同步函数，这里不能返回 Promise，否则会出现「先跑主路由再跑支付宝路由」的双路由竞态。
  return function handleAlipayRoutes(req, res, pathname) {
    // ---------- 1. 下单并生成支付表单：POST /api/v1/order/alipay/checkout ----------
    if (pathname === '/api/v1/order/alipay/checkout' && req.method === 'POST') {
      const uid = sessionUidOf(req);
      if (!uid) { rejectNoUid(res); return true; }
      safeReadJson(req, res).then(async (payload) => {
        const orderId = String(payload.orderId || payload.id || '').trim();
        const order = getOrder(orderId);
        if (!order || order.userId !== uid) {
          sendJson(res, 404, 40401, '订单不存在或无权访问');
          return;
        }
        if (order.status !== 'pending') {
          sendJson(res, 400, 40002, `订单当前状态为[${order.status}]，不可发起支付`);
          return;
        }
        if (!(order.amount > 0)) {
          sendJson(res, 400, 40003, '订单金额异常，已拦截');
          return;
        }
        // ---------- 一人付分流：平台侧配了对应档位的订单（会员档 + 小加油包） ----------
        // 能匹配到 opcpay SKU 即走本通道；匹配不到（或通道未就绪）回落支付宝官方直连。
        let opcpaySku = null;
        if (opcpayStatus().ready) {
          try { opcpaySku = await resolveSkuForTier(order.tierId, order.amount, order.pkg); } catch (_) { opcpaySku = null; }
        }
        if (opcpaySku) {
          try {
            const entry = await createOpcpayPurchase(order);
            // 编码优先级：alipays:// 深链（支付宝扫一扫原生识别，扫码直达付款页）
            // > qrPayload（注意：purchase_qr_code 实测是 mobilecodec.alipay.com/show.htm 二维码展示页，
            //   编码它会出现「扫码后又出一张码」的码中码，只作兜底） > purchaseUrl
            const deep = String(entry.purchaseUrl || '');
            const qrRaw = String(entry.qrPayload || '');
            const raw = /^(alipays?:|alipayqr:)/i.test(deep) ? deep
              : /^(data:|https?:)/i.test(qrRaw) ? qrRaw
              : deep;
            if (!raw) throw new Error('未获取到付款入口');
            const qrDataUrl = /^data:/i.test(String(raw)) ? raw : await QRCode.toDataURL(raw, { width: 400, margin: 2 });
            attachPayUrl(order.id, entry.purchaseUrl || alipayReturnUrl());
            sendJson(res, 200, 0, '支付二维码已生成', { orderId: order.id, mode: 'qr', qrDataUrl, payUrl: entry.purchaseUrl, channel: 'opcpay' });
          } catch (err) {
            console.warn(`[OPCPAY] 购买入口创建失败 订单=${order.id}: ${err.message}`);
            sendJson(res, 502, 50204, '支付发起失败：' + err.message);
          }
          return;
        }
        // ---------- 支付宝官方直连 ----------
        const st = alipayStatus();
        if (!st.ready) {
          sendJson(res, 503, 50301, `支付宝通道未就绪: ${st.reason || '未配置'}`);
          return;
        }
        try {
          // 网页支付 + qr_pay_mode=4 嵌入式二维码：
          // 服务端把签名表单提交给支付宝网关，从返回的收银台页提取 qr.alipay.com 付款码链接，
          // 生成二维码图片回给前端，直接渲染进自有卡片（不跳转、不依赖当面付签约）。
          // 提取失败时降级为 paymentHtml，由前端以 iframe 为 target 提交嵌入。
          const paymentHtml = createPagePayForm({
            outTradeNo: order.id, // 商户订单号 = 本地订单 id（channelReqSeqId 同源）
            totalAmount: order.amount,
            subject: order.pkg || '简兮订单',
            returnUrl: alipayReturnUrl(),
            // notify_url：本地无公网 HTTPS 地址时不传，支付结果由查单兜底；生产上线时配置 ALIPAY_NOTIFY_URL
            notifyUrl: (process.env.ALIPAY_NOTIFY_URL || '').trim() || undefined,
          });
          attachPayUrl(order.id, alipayReturnUrl());
          try {
            const action = paymentHtml.match(/action="([^"]+)"/)?.[1];
            const fields = [...paymentHtml.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)]
              .map((x) => [x[1], x[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')]);
            if (!action || !fields.length) throw new Error('支付表单解析失败');
            const r = await fetch(action, {
              method: 'POST',
              body: new URLSearchParams(fields),
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              signal: AbortSignal.timeout(15000),
            });
            const page = await r.text();
            const qrLink = page.match(/https?:\/\/qr\.alipay\.com\/[A-Za-z0-9]+/)?.[0];
            if (!qrLink) throw new Error('收银台页面未提取到付款码链接');
            const qrDataUrl = await QRCode.toDataURL(qrLink, { width: 400, margin: 2 });
            sendJson(res, 200, 0, '支付二维码已生成', { orderId: order.id, mode: 'qr', qrDataUrl, payUrl: qrLink });
          } catch (err) {
            // 单一支付形态：只出本页二维码，绝不降级为页面跳转（跳转会让支付宝收银台页面脱离站点）
            console.warn(`[ALIPAY] 付款码提取失败 订单=${order.id}: ${err.message}`);
            sendJson(res, 502, 50202, '支付发起失败，请稍后重试');
          }
        } catch (err) {
          sendJson(res, 500, 50001, '生成支付表单失败: ' + err.message);
        }
      }).catch(() => {});
      return true;
    }

    // ---------- 2. 支付结果主动查单：GET /api/v1/order/alipay/status?orderId= ----------
    if (pathname === '/api/v1/order/alipay/status' && req.method === 'GET') {
      const uid = sessionUidOf(req);
      if (!uid) { rejectNoUid(res); return true; }
      const url = new URL(req.url, 'http://local');
      const orderId = String(url.searchParams.get('orderId') || '').trim();
      const order = getOrder(orderId);
      if (!order || order.userId !== uid) {
        sendJson(res, 404, 40401, '订单不存在或无权访问');
        return true;
      }
      if (order.status === 'paid') {
        sendJson(res, 200, 0, '查询成功', { orderStatus: 'paid', tradeState: 'PAID', order });
        return true;
      }
      // ---------- 一人付订单：确认（权益余额覆盖 → 核销 → 履约） ----------
      // 同时补扫同用户其它待付一人付订单：用户付完款直接关掉收银台时，下次轮询兜底恢复。
      if (isOpcpayOrder(order.id) && order.status === 'pending') {
        (async () => {
          try {
            sweepUserMemberOrders(uid, order.id).catch(() => {});
            const r = await confirmOpcpayOrder(order);
            if (r.paid) {
              sendJson(res, 200, 0, '查询成功', {
                orderStatus: 'paid', tradeState: 'PAID',
                order: r.order, addedPoints: r.addedPoints || 0, newBalance: r.newBalance,
              });
              return;
            }
            if (r.error) {
              sendJson(res, 200, 0, '查询成功', { orderStatus: order.status, tradeState: 'FAILED', message: r.error, order });
              return;
            }
            sendJson(res, 200, 0, '查询成功', { orderStatus: order.status, tradeState: 'WAIT_BUYER_PAY', order });
          } catch (err) {
            console.warn(`[OPCPAY] 确认异常 订单=${order.id}: ${err.message}`);
            sendJson(res, 200, 0, '查询成功', { orderStatus: order.status, tradeState: 'UNKNOWN', order });
          }
        })();
        return true;
      }
      if (alipayStatus().ready && order.status === 'pending') {
        (async () => {
          try {
            const r = await queryTrade({ outTradeNo: order.id });
            if (r.ok && r.tradeState === 'PAID') {
              const f = fulfillPaidOrder(order.id, { via: 'alipay-query' });
              sendJson(res, 200, 0, '查询成功', {
                orderStatus: 'paid', tradeState: r.tradeState, tradeStatus: r.tradeStatus,
                order: f.order, addedPoints: f.addedPoints, newBalance: f.newBalance,
              });
              return;
            }
            if (r.ok) {
              sendJson(res, 200, 0, '查询成功', { orderStatus: order.status, tradeState: r.tradeState, tradeStatus: r.tradeStatus, order });
              return;
            }
            // 查询失败（如交易不存在）：回落到本地状态，不算支付成功
            sendJson(res, 200, 0, '查询成功', { orderStatus: order.status, tradeState: 'UNKNOWN', order });
          } catch (err) {
            console.warn(`[ALIPAY] 查单异常 订单=${order.id}: ${err.message}`);
            sendJson(res, 200, 0, '查询成功', { orderStatus: order.status, tradeState: 'UNKNOWN', order });
          }
        })();
        return true;
      }
      sendJson(res, 200, 0, '查询成功', { orderStatus: order.status, tradeState: 'UNKNOWN', order });
      return true;
    }

    // ---------- 3. 关闭交易：POST /api/v1/order/alipay/close ----------
    if (pathname === '/api/v1/order/alipay/close' && req.method === 'POST') {
      const uid = sessionUidOf(req);
      if (!uid) { rejectNoUid(res); return true; }
      safeReadJson(req, res).then(async (payload) => {
        const orderId = String(payload.orderId || payload.id || '').trim();
        const order = getOrder(orderId);
        if (!order || order.userId !== uid) {
          sendJson(res, 404, 40401, '订单不存在或无权访问');
          return;
        }
        if (order.status !== 'pending') {
          sendJson(res, 400, 40002, `订单当前状态为[${order.status}]，仅待支付订单可关闭`);
          return;
        }
        if (alipayStatus().ready) {
          try {
            const r = await closeTrade({ outTradeNo: order.id });
            if (!r.ok && r.subCode !== 'ACQ.TRADE_NOT_EXIST' && r.subCode !== 'ACQ.TRADE_STATUS_ERROR') {
              // 交易不存在允许本地关单；状态异常（如已支付）不放行
              sendJson(res, 400, 40003, `通道关单失败: ${r.msg || r.subCode || '未知错误'}`);
              return;
            }
          } catch (err) {
            sendJson(res, 500, 50001, '通道关单异常: ' + err.message);
            return;
          }
        }
        closeOrder(orderId, 'user');
        sendJson(res, 200, 0, '订单已关闭', { orderId });
      }).catch(() => {});
      return true;
    }

    // ---------- 3.5 一人付异步通知：POST /api/v1/opcpay/webhook ----------
    // 通知是「权益/核销事件」而非逐笔支付成功通知：验签通过后只触发补扫（confirmMemberOrder
    // 内部仍以 purchaseQuery.confirmed + access 余额 + consume 幂等核销为准），不直接入账。
    if (pathname === '/api/v1/opcpay/webhook' && req.method === 'POST') {
      const secret = String(process.env.OPCPAY_WEBHOOK_SECRET || '').trim();
      if (!secret) {
        // 未配置验签密钥：拒绝处理（不暴露细节），要求先在控制台/rotateWebhook 获取密钥
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('forbidden');
        return true;
      }
      readRawBody(req).then((raw) => {
        let event = null;
        try {
          event = verifyOpcpayWebhook(raw, req.headers, secret);
        } catch (err) {
          console.warn('[OPCPAY] webhook 验签失败:', err.message);
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('bad signature');
          return;
        }
        // 事件去重（持久化）：容忍乱序，重复事件直接确认
        if (event && event.id) {
          if (opcpayEvents[event.id]) {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('ok');
            return;
          }
          opcpayEvents[event.id] = { type: event.type || '', at: Date.now() };
          // 只保留最近 500 条，防文件无限膨胀
          const ids = Object.keys(opcpayEvents);
          if (ids.length > 500) {
            ids.sort((a, b) => (opcpayEvents[a].at || 0) - (opcpayEvents[b].at || 0));
            for (const old of ids.slice(0, ids.length - 500)) delete opcpayEvents[old];
          }
          saveOpcpayEvents();
        }
        const uid = event && (event.user_id || (event.data && event.data.user_id)) || '';
        if (uid) {
          sweepUserMemberOrders(String(uid)).catch((err) => {
            console.warn('[OPCPAY] webhook 补扫异常:', err.message);
          });
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok');
      }).catch(() => {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('bad request');
      });
      return true;
    }

    // ---------- 4. 异步通知（公网生产用）：POST /api/v1/alipay/notify ----------
    if (pathname === '/api/v1/alipay/notify' && req.method === 'POST') {
      readFormUrlencoded(req).then((params) => {
        try {
          if (!params || !params.app_id || !params.out_trade_no || !params.sign) {
            res.type && res.type('text/plain');
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('fail');
            return;
          }
          // 1) 验签：失败只记脱敏日志并回 fail
          let signOk = false;
          try { signOk = verifyNotifySign(params); } catch (err) {
            console.warn('[ALIPAY] 通知验签异常:', err.message);
          }
          if (!signOk) {
            console.warn('[ALIPAY] 通知验签失败:', JSON.stringify(sanitizeNotifyParams(params)));
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('fail');
            return;
          }
          // 2) 本地配置匹配：app_id 必须等于运行时支付配置
          const st = alipayStatus();
          if (!st.ready || params.app_id !== st.appId) {
            console.warn('[ALIPAY] 通知 app_id 与本地支付配置不符:', params.app_id);
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('fail');
            return;
          }
          // 3) 订单匹配与关键字段校验
          const order = getOrder(String(params.out_trade_no));
          if (!order) {
            console.warn('[ALIPAY] 通知订单不存在:', params.out_trade_no);
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('fail');
            return;
          }
          if (!amountEquals(order.amount, params.total_amount)) {
            console.warn(`[ALIPAY] 通知金额不一致 订单=${order.id} 本地=${order.amount} 通知=${params.total_amount}`);
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('fail');
            return;
          }
          // seller_id 校验（沙箱/生产配置中的 pid 即 seller_id；未配置时跳过该断言）
          if (st.sellerId && params.seller_id && params.seller_id !== st.sellerId) {
            console.warn('[ALIPAY] 通知 seller_id 不符:', params.seller_id);
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('fail');
            return;
          }
          // 4) 幂等：notify_id 持久化去重（重复通知直接回 success，不再入账）
          const notifyId = String(params.notify_id || '');
          if (notifyId) {
            if (notifyEvents[notifyId]) {
              res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end('success');
              return;
            }
            notifyEvents[notifyId] = {
              ts: Date.now(),
              outTradeNo: params.out_trade_no,
              tradeStatus: params.trade_status || '',
              type: isRefundNotification(params) ? 'refund' : 'trade',
            };
            // 通知事件只保留最近 5000 条，防无限膨胀
            const keys = Object.keys(notifyEvents);
            if (keys.length > 5000) {
              keys.sort((a, b) => (notifyEvents[a].ts || 0) - (notifyEvents[b].ts || 0));
              for (let i = 0; i < keys.length - 5000; i++) delete notifyEvents[keys[i]];
            }
            saveNotifyEvents();
          }
          touchNotify(order.id, String(params.trade_no || ''));
          // 5) 事件分流：付款成功 / 退款事件 / 其他状态
          if (isPaidTradeNotification(params)) {
            fulfillPaidOrder(order.id, { via: 'alipay-notify' });
          } else if (isRefundNotification(params)) {
            // 退款通知：验签和归属校验已通过，落退款终态（金额以通知 refund_fee 为准）
            markRefunded(order.id, {
              refundAmt: Number(params.refund_fee) > 0 ? Number(params.refund_fee) : order.amount,
              channelRefundSeqId: String(params.out_request_no || ''),
            });
            try { cancelCommissionByOrder(order.id); } catch (_) {}
          }
          // WAIT_BUYER_PAY / TRADE_CLOSED：不认定付款成功，仅记录
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('success');
        } catch (err) {
          console.error('[ALIPAY] 通知处理异常:', err && err.message);
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('fail');
        }
      }).catch(() => {
        try { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('fail'); } catch (_) {}
      });
      return true;
    }

    // ---------- 5. 同步回跳结果页：GET /alipay/return ----------
    if (pathname === '/alipay/return' && req.method === 'GET') {
      // 保留原始编码值验签（GET 回跳参数解码后验签会失败）
      const rawQuery = req.url.slice(req.url.indexOf('?') + 1);
      const rawParams = {};
      for (const pair of String(rawQuery || '').split('&')) {
        if (!pair) continue;
        const idx = pair.indexOf('=');
        const k = idx < 0 ? pair : pair.slice(0, idx);
        rawParams[decodeURIComponent(k)] = idx < 0 ? '' : pair.slice(idx + 1);
      }
      // 无支付上下文的直接访问：展示安全的中性状态（不放宽真实回跳的验签）
      if (!rawParams.out_trade_no && !rawParams.sign) {
        sendHtml(res, renderReturnPage({ state: 'neutral', title: '支付结果确认', detail: '未识别到支付回跳参数。如已完成支付，请在「订单记录」中查看最新状态。' }));
        return true;
      }
      let signOk = false;
      try { signOk = verifyReturnSign(rawParams); } catch (err) {
        console.warn('[ALIPAY] 回跳验签异常:', err.message);
      }
      if (!signOk) {
        console.warn('[ALIPAY] 回跳验签失败，展示中性结果页');
        sendHtml(res, renderReturnPage({ state: 'neutral', title: '正在确认支付结果', detail: '回跳校验未通过。如已完成支付，请在「订单记录」中查看最新状态，支付结果以查单确认为准。' }));
        return true;
      }
      // 验签通过：out_trade_no 可用于定位订单；最终结果仍以服务端查单为准
      const outTradeNo = decodeURIComponent(String(rawParams.out_trade_no || ''));
      const order = getOrder(outTradeNo);
      if (!order) {
        sendHtml(res, renderReturnPage({ state: 'neutral', title: '正在确认支付结果', detail: '未找到对应订单，请在「订单记录」中查看最新状态。' }));
        return true;
      }
      (async () => {
        let finalState = 'processing';
        let detail = '支付结果正在确认，稍后可在「订单记录」中查看。';
        try {
          const r = await queryTrade({ outTradeNo: order.id });
          if (r.ok && r.tradeState === 'PAID') {
            const f = fulfillPaidOrder(order.id, { via: 'alipay-return-query' });
            finalState = 'success';
            const pts = Number(f.addedPoints) || 0;
            detail = pts > 0 ? `订单 ${order.id} 已确认支付成功，${pts} 积分已到账。` : `订单 ${order.id} 已确认支付成功。`;
          } else if (r.ok && r.tradeState === 'CLOSED') {
            finalState = 'closed';
            detail = `订单 ${order.id} 已关闭，未完成支付。如已扣款请联系客服核实。`;
          } else {
            detail = `订单 ${order.id} 正在确认支付结果，请在「订单记录」中查看最新状态。`;
          }
        } catch (err) {
          console.warn(`[ALIPAY] 回跳查单异常 订单=${order.id}: ${err.message}`);
        }
        sendHtml(res, renderReturnPage({
          state: finalState,
          title: finalState === 'success' ? '支付成功' : '正在确认支付结果',
          detail,
        }));
      })();
      return true;
    }

    return false; // 非支付宝路由，交回主路由
  };
}
