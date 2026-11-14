// 简兮 · JSAPI 支付路由（全站统一聚合支付通道）
// ---------------------------------------------------------------------------
// 覆盖接口：
//   - POST /api/v1/order/jsapi/checkout (及兼容别名 /api/v1/order/alipay/checkout)
//   - GET  /api/v1/order/jsapi/status   (及兼容别名 /api/v1/order/alipay/status)
//   - POST /api/v1/order/jsapi/close    (及兼容别名 /api/v1/order/alipay/close)
//   - POST /api/v1/order/jsapi/webhook  (及兼容别名 /api/v1/opcpay/webhook, /api/v1/alipay/notify)
//   - GET  /pay/return                  (及兼容别名 /alipay/return)
//
// 业务红线：
//   - 全站唯一锁定 JSAPI 聚合支付通道，彻底废弃并移除官方 alipay-sdk 直连；
//   - 四档会员（Lite, Plus, Pro, Ultra）与小加油包全量统一对接 JSAPI 支付；
//   - 会员均为单月订阅，不自动续费；
//   - 0 Emoji，遵循黑曜石设计语言与 2px 幽灵微光规范。

import { getOrder, attachPayUrl, closeOrder } from './payStore.mjs';
import { dataFile, readJson, writeJsonAtomic } from './dataStore.mjs';
import QRCode from 'qrcode';
import {
  opcpayStatus,
  createOpcpayPurchase,
  confirmOpcpayOrder,
  sweepUserMemberOrders,
  isOpcpayOrder,
} from './opcpayProvider.mjs';
import { verifyWebhook as verifyOpcpayWebhook } from 'opcpay';

/** 同步回跳结果页（服务端渲染的极简壳，0 Emoji，黑曜石暗色微光基调） */
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

/** 同步回跳地址 */
export function jsapiReturnUrl() {
  if (process.env.JSAPI_RETURN_URL) return String(process.env.JSAPI_RETURN_URL).trim();
  if (process.env.ALIPAY_RETURN_URL) return String(process.env.ALIPAY_RETURN_URL).trim();
  const port = process.env.PORT || '3000';
  return `http://localhost:${port}/pay/return`;
}
export const alipayReturnUrl = jsapiReturnUrl;

/** 通道退款入口（JSAPI 聚合通道模式：通知管理后台人工在网关处理，本地做跳过兼容） */
export async function channelRefund(order, reason) {
  return { ok: false, skipped: true, message: 'JSAPI 支付退款请前往商户后台处理' };
}

/** 退款结果补偿确认（兼容导出） */
export function scheduleRefundConfirm(orderId, outRequestNo, delayMs = 10 * 1000) {
  // JSAPI 通道暂无需延迟调度
}

/** 读取原始请求体（webhook 验签用） */
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

// —— JSAPI webhook 事件持久化去重 ——
const WEBHOOK_EVENT_FILE = dataFile('opcpay-webhook-events.json');
let webhookEvents = readJson(WEBHOOK_EVENT_FILE, {}) || {};
function saveWebhookEvents() {
  writeJsonAtomic(WEBHOOK_EVENT_FILE, webhookEvents);
}

/**
 * 注册统一 JSAPI 支付路由。
 * deps 由 index.mjs 注入：{ sendJson, sessionUidOf, rejectNoUid, safeReadJson }
 */
export function createJsapiRouteHandler(deps) {
  const { sendJson, sessionUidOf, rejectNoUid, safeReadJson } = deps;

  return function handleJsapiRoutes(req, res, pathname) {
    // ---------- 1. 下单并获取 JSAPI 支付入口 ----------
    if ((pathname === '/api/v1/order/jsapi/checkout' || pathname === '/api/v1/order/alipay/checkout') && req.method === 'POST') {
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

        const st = opcpayStatus();
        if (!st.ready) {
          sendJson(res, 503, 50301, `JSAPI 支付通道未就绪: ${st.reason || '通道维护中'}`);
          return;
        }

        try {
          const entry = await createOpcpayPurchase(order);
          const deep = String(entry.purchaseUrl || '');
          const qrRaw = String(entry.qrPayload || '');
          const raw = /^(alipays?:|alipayqr:|weixin:|wxp:)/i.test(deep) ? deep
            : /^(data:|https?:)/i.test(qrRaw) ? qrRaw
            : deep;
          if (!raw) throw new Error('未获取到付款入口');
          const qrDataUrl = /^data:/i.test(String(raw)) ? raw : await QRCode.toDataURL(raw, { width: 400, margin: 2 });
          attachPayUrl(order.id, entry.purchaseUrl || jsapiReturnUrl());
          sendJson(res, 200, 0, '支付二维码已生成', {
            orderId: order.id,
            mode: 'qr',
            qrDataUrl,
            payUrl: entry.purchaseUrl,
            channel: 'jsapi',
          });
        } catch (err) {
          console.warn(`[JSAPI PAY] 购买入口创建失败 订单=${order.id}: ${err.message}`);
          sendJson(res, 502, 50204, '支付发起失败：' + err.message);
        }
      }).catch(() => {});
      return true;
    }

    // ---------- 2. 支付结果主动查单：GET /api/v1/order/jsapi/status?orderId= ----------
    if ((pathname === '/api/v1/order/jsapi/status' || pathname === '/api/v1/order/alipay/status') && req.method === 'GET') {
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

      (async () => {
        try {
          sweepUserMemberOrders(uid, order.id).catch(() => {});
          const r = await confirmOpcpayOrder(order);
          if (r.paid) {
            sendJson(res, 200, 0, '查询成功', {
              orderStatus: 'paid',
              tradeState: 'PAID',
              order: r.order,
              addedPoints: r.addedPoints || 0,
              newBalance: r.newBalance,
            });
            return;
          }
          if (r.error) {
            sendJson(res, 200, 0, '查询成功', { orderStatus: order.status, tradeState: 'FAILED', message: r.error, order });
            return;
          }
          sendJson(res, 200, 0, '查询成功', { orderStatus: order.status, tradeState: 'WAIT_BUYER_PAY', order });
        } catch (err) {
          console.warn(`[JSAPI PAY] 确认异常 订单=${order.id}: ${err.message}`);
          sendJson(res, 200, 0, '查询成功', { orderStatus: order.status, tradeState: 'UNKNOWN', order });
        }
      })();
      return true;
    }

    // ---------- 3. 关闭交易：POST /api/v1/order/jsapi/close ----------
    if ((pathname === '/api/v1/order/jsapi/close' || pathname === '/api/v1/order/alipay/close') && req.method === 'POST') {
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
        closeOrder(orderId, 'user');
        sendJson(res, 200, 0, '订单已关闭', { orderId });
      }).catch(() => {});
      return true;
    }

    // ---------- 4. 异步 Webhook：POST /api/v1/order/jsapi/webhook 或 /api/v1/opcpay/webhook ----------
    if ((pathname === '/api/v1/order/jsapi/webhook' || pathname === '/api/v1/opcpay/webhook') && req.method === 'POST') {
      const secret = String(process.env.OPCPAY_WEBHOOK_SECRET || '').trim();
      if (!secret) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('forbidden');
        return true;
      }
      readRawBody(req).then((raw) => {
        let event = null;
        try {
          event = verifyOpcpayWebhook(raw, req.headers, secret);
        } catch (err) {
          console.warn('[JSAPI PAY] webhook 验签失败:', err.message);
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('bad signature');
          return;
        }
        if (event && event.id) {
          if (webhookEvents[event.id]) {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('ok');
            return;
          }
          webhookEvents[event.id] = { type: event.type || '', at: Date.now() };
          const ids = Object.keys(webhookEvents);
          if (ids.length > 500) {
            ids.sort((a, b) => (webhookEvents[a].at || 0) - (webhookEvents[b].at || 0));
            for (const old of ids.slice(0, ids.length - 500)) delete webhookEvents[old];
          }
          saveWebhookEvents();
        }
        const uid = event && (event.user_id || (event.data && event.data.user_id)) || '';
        if (uid) {
          sweepUserMemberOrders(String(uid)).catch((err) => {
            console.warn('[JSAPI PAY] webhook 补扫异常:', err.message);
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

    // ---------- 4.1 兼容旧版支付宝通知打入 ----------
    if (pathname === '/api/v1/alipay/notify' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('success');
      return true;
    }

    // ---------- 5. 同步回跳结果页：GET /pay/return (及 /alipay/return) ----------
    if ((pathname === '/pay/return' || pathname === '/alipay/return') && req.method === 'GET') {
      sendHtml(res, renderReturnPage({
        state: 'neutral',
        title: '支付结果确认',
        detail: '如已完成支付，系统将在数秒内自动入账；您可返回工作台或在「订单记录」中查看最新状态。',
      }));
      return true;
    }

    return false;
  };
}

export const createAlipayRouteHandler = createJsapiRouteHandler;
