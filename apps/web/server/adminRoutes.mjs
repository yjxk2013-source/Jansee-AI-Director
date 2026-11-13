/**
 * 简兮 (JANSEE) · 管理后台运营控制中心路由处理器 (apps/web/server/adminRoutes.mjs)
 * 职责：
 *   1. 统一接管所有 `/api/v1/admin/*` 运营控制中心 API 路由；
 *   2. 严格执行管理员 Token 鉴权 (requireAdminAuth)，彻底废除任何硬编码后门；
 *   3. 涵盖用户管理、调账流水、订单退款、提现审核、站内信、定价热更、系统监控与经营大盘；
 *   4. 解耦网关巨石架构，实现业务域代码物理隔离。
 */

import { extractAdminToken, verifyAdminToken, verifyAdmin } from './adminStore.mjs';
import { recordAdminIp, getSiteAnalytics, resetSiteAnalytics } from './siteAnalytics.mjs';
import {
  getAdminUsers,
  toggleAdminUserStatus,
  getAdminCreditRecords,
  adjustUserCredits,
  getAdminTasks,
  getAdminErrorStats,
  getAdminOverview,
  getAdminAnalysis,
  getAdminOrders,
  refundAdminOrder,
  getAdminWithdraws,
  reviewAdminWithdraw,
  getAdminPartners,
  getAdminMessages,
  sendAdminMessage,
  deleteAdminMessage,
  getAdminFeedbacks,
  deleteAdminFeedback,
  getAdminPricing,
  saveAdminPricing,
  getAdminSiteConfig,
  saveAdminSiteConfig,
  getAdminMonitor,
  getAdminInsights,
  getAdminAttribution,
  getAdminRenderQueue,
  getAdminModerationLogs,
  getAdminBusinessOverview
} from './admin.mjs';

/**
 * 构造管理后台路由分发处理器
 * @param {{ sendJson: Function, safeReadJson: Function }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string, urlObj: URL) => boolean}
 */
export function createAdminRouteHandler({ sendJson, safeReadJson }) {
  // 管理员鉴权辅助函数
  function requireAdminAuth(req, res) {
    const token = extractAdminToken(req);
    if (!token) {
      sendJson(res, 401, 40101, '管理员未登录或缺少管理凭证');
      return null;
    }
    const session = verifyAdminToken(token);
    if (!session) {
      sendJson(res, 403, 40301, '管理凭证无效或已过期，拒绝访问');
      return null;
    }
    const adminIp = req.headers['x-real-ip'] || req.socket?.remoteAddress;
    if (adminIp) recordAdminIp(adminIp);
    return session;
  }

  return function handleAdminRoutes(req, res, pathname, urlObj) {
    if (!pathname.startsWith('/api/v1/admin/')) {
      return false;
    }

    // 0. 官网流量分析：仅允许已登录管理员读取聚合数据
    if (pathname === '/api/v1/admin/site-analytics' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const days = Number(urlObj.searchParams.get('days') || 7);
      sendJson(res, 200, 0, '查询成功', getSiteAnalytics(days));
      return true;
    }

    // 0.1 官网流量分析：一键清零重置
    if (pathname === '/api/v1/admin/site-analytics/reset' && req.method === 'POST') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const db = resetSiteAnalytics();
      sendJson(res, 200, 0, '访问统计已重置清零', db);
      return true;
    }

    // 1. 管理员登录：POST /api/v1/admin/login
    if (pathname === '/api/v1/admin/login' && req.method === 'POST') {
      safeReadJson(req, res).then((payload) => {
        try {
          const result = verifyAdmin(payload.username, payload.password);
          const adminIp = req.headers['x-real-ip'] || req.socket?.remoteAddress;
          if (adminIp) recordAdminIp(adminIp);
          sendJson(res, 200, 0, '管理员登录成功', result);
        } catch (e) {
          sendJson(res, e.statusCode || 401, e.code || 40101, e.message || '登录失败');
        }
      }).catch(() => { });
      return true;
    }

    // 2. 用户管理列表：GET /api/v1/admin/users
    if (pathname === '/api/v1/admin/users' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const status = urlObj.searchParams.get('status') || undefined;
      const limit = parseInt(urlObj.searchParams.get('limit') || '50', 10);
      const offset = parseInt(urlObj.searchParams.get('offset') || '0', 10);
      const usersData = getAdminUsers({ status, limit, offset });
      sendJson(res, 200, 0, '查询成功', usersData);
      return true;
    }

    // 3. 积分流水查询：GET /api/v1/admin/credits
    if (pathname === '/api/v1/admin/credits' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const userId = urlObj.searchParams.get('userId') || undefined;
      const type = urlObj.searchParams.get('type') || undefined;
      const limit = parseInt(urlObj.searchParams.get('limit') || '50', 10);
      const offset = parseInt(urlObj.searchParams.get('offset') || '0', 10);
      const records = getAdminCreditRecords({ userId, type, limit, offset });
      sendJson(res, 200, 0, '查询成功', records);
      return true;
    }

    // 4. 管理员手动调整积分：POST /api/v1/admin/credits/adjust
    if (pathname === '/api/v1/admin/credits/adjust' && req.method === 'POST') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      safeReadJson(req, res).then((payload) => {
        try {
          const delta = payload.amount !== undefined ? payload.amount : payload.delta;
          const result = adjustUserCredits({
            userId: payload.userId,
            amount: delta,
            reason: payload.reason || '客服后台手动调账',
            adminId: admin.username,
          });
          sendJson(res, 200, 0, '积分调整成功', result);
        } catch (e) {
          sendJson(res, e.statusCode || 400, e.code || 40001, e.message || '积分调整失败');
        }
      }).catch(() => { });
      return true;
    }

    // 5. 任务监控查询：GET /api/v1/admin/tasks
    if (pathname === '/api/v1/admin/tasks' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const type = urlObj.searchParams.get('type') || undefined;
      const status = urlObj.searchParams.get('status') || undefined;
      const userId = urlObj.searchParams.get('userId') || undefined;
      const limit = parseInt(urlObj.searchParams.get('limit') || '50', 10);
      const offset = parseInt(urlObj.searchParams.get('offset') || '0', 10);
      const tasksData = getAdminTasks({ type, status, userId, limit, offset });
      sendJson(res, 200, 0, '查询成功', tasksData);
      return true;
    }

    // 6. 错误监控统计：GET /api/v1/admin/errors
    if (pathname === '/api/v1/admin/errors' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const errorStats = getAdminErrorStats();
      sendJson(res, 200, 0, '查询成功', errorStats);
      return true;
    }

    // 7. 仪表盘真实大盘数据：GET /api/v1/admin/overview
    if (pathname === '/api/v1/admin/overview' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const data = getAdminOverview();
      sendJson(res, 200, 0, '查询成功', data);
      return true;
    }

    // 8. 分析页真实业务指标：GET /api/v1/admin/analysis
    if (pathname === '/api/v1/admin/analysis' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const data = getAdminAnalysis();
      sendJson(res, 200, 0, '查询成功', data);
      return true;
    }

    // 9. 用户状态切换（冻结/解冻）：POST /api/v1/admin/users/status
    if (pathname === '/api/v1/admin/users/status' && req.method === 'POST') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      safeReadJson(req, res).then((payload) => {
        try {
          const targetStatus = payload.isFrozen !== undefined ? payload.isFrozen : payload.status;
          const result = toggleAdminUserStatus(payload.userId, targetStatus);
          sendJson(res, 200, 0, '用户状态更新成功', result);
        } catch (e) {
          sendJson(res, e.statusCode || 400, e.code || 40001, e.message || '操作失败');
        }
      }).catch(() => { });
      return true;
    }

    // 10. 订单管理列表：GET /api/v1/admin/orders
    if (pathname === '/api/v1/admin/orders' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const status = urlObj.searchParams.get('status') || undefined;
      const limit = parseInt(urlObj.searchParams.get('limit') || '50', 10);
      const offset = parseInt(urlObj.searchParams.get('offset') || '0', 10);
      const data = getAdminOrders({ status, limit, offset });
      sendJson(res, 200, 0, '查询成功', data);
      return true;
    }

    // 11. 订单退款操作：POST /api/v1/admin/orders/refund
    if (pathname === '/api/v1/admin/orders/refund' && req.method === 'POST') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      safeReadJson(req, res).then(async (payload) => {
        const resData = await refundAdminOrder(payload.orderId, payload.reason);
        if (resData.ok) {
          sendJson(res, 200, 0, '退款处理成功', resData);
        } else {
          sendJson(res, 400, 40001, resData.message || '退款失败');
        }
      }).catch(() => { });
      return true;
    }

    // 12. 提现审核列表：GET /api/v1/admin/withdraws
    if (pathname === '/api/v1/admin/withdraws' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const data = getAdminWithdraws();
      sendJson(res, 200, 0, '查询成功', data);
      return true;
    }

    // 13. 提现审核处理：POST /api/v1/admin/withdraws/review
    if (pathname === '/api/v1/admin/withdraws/review' && req.method === 'POST') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      safeReadJson(req, res).then((payload) => {
        const id = payload.withdrawId || payload.id;
        const action = payload.status || payload.action || 'approved';
        const note = payload.note || '';
        const result = reviewAdminWithdraw(id, action, note);
        if (result && !result.error) {
          sendJson(res, 200, 0, '提现审核已更新', result);
        } else {
          sendJson(res, 400, 40001, result?.error || '审核失败');
        }
      }).catch(() => { });
      return true;
    }

    // 14. 城市合伙人列表：GET /api/v1/admin/partners
    if (pathname === '/api/v1/admin/partners' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const data = getAdminPartners();
      sendJson(res, 200, 0, '查询成功', data);
      return true;
    }

    // 15. 站内信历史：GET /api/v1/admin/messages
    if (pathname === '/api/v1/admin/messages' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const data = getAdminMessages();
      sendJson(res, 200, 0, '查询成功', data);
      return true;
    }

    // 16. 发送站内信：POST /api/v1/admin/messages/send
    if (pathname === '/api/v1/admin/messages/send' && req.method === 'POST') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      safeReadJson(req, res).then((payload) => {
        const msg = sendAdminMessage(payload);
        sendJson(res, 200, 0, '站内信已成功下发', msg);
      }).catch(() => { });
      return true;
    }

    // 16.0 撤回/删除站内信：POST /api/v1/admin/messages/delete
    if (pathname === '/api/v1/admin/messages/delete' && req.method === 'POST') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      safeReadJson(req, res).then((payload) => {
        const ok = deleteAdminMessage(payload.id);
        sendJson(res, 200, 0, ok ? '站内信已成功撤回' : '未找到指定站内信', { ok });
      }).catch(() => { });
      return true;
    }

    // 16.2 后台查询商户反馈列表：GET /api/v1/admin/feedbacks
    if (pathname === '/api/v1/admin/feedbacks' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const data = getAdminFeedbacks();
      sendJson(res, 200, 0, '查询成功', data);
      return true;
    }

    // 16.3 后台处理/删除商户反馈：POST /api/v1/admin/feedbacks/delete
    if (pathname === '/api/v1/admin/feedbacks/delete' && req.method === 'POST') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      safeReadJson(req, res).then((payload) => {
        deleteAdminFeedback(payload.id);
        sendJson(res, 200, 0, '反馈记录已删除');
      }).catch(() => { });
      return true;
    }

    // 17. 会员与加油包定价配置读取：GET /api/v1/admin/pricing
    if (pathname === '/api/v1/admin/pricing' && req.method === 'GET') {
      const data = getAdminPricing();
      sendJson(res, 200, 0, '查询成功', data);
      return true;
    }

    // 18. 更新会员与加油包定价配置：POST /api/v1/admin/pricing/update
    if (pathname === '/api/v1/admin/pricing/update' && req.method === 'POST') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      safeReadJson(req, res).then((payload) => {
        try {
          const saved = saveAdminPricing(payload);
          sendJson(res, 200, 0, '定价策略已原子落盘并热生效', saved);
        } catch (e) {
          sendJson(res, 400, 40001, e.message || '定价更新失败');
        }
      }).catch(() => { });
      return true;
    }

    // 19. 站点设置读取：GET /api/v1/admin/site-config
    if (pathname === '/api/v1/admin/site-config' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const data = getAdminSiteConfig();
      sendJson(res, 200, 0, '查询成功', data);
      return true;
    }

    // 20. 更新站点设置：POST /api/v1/admin/site-config/update
    if (pathname === '/api/v1/admin/site-config/update' && req.method === 'POST') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      safeReadJson(req, res).then((payload) => {
        const patchData = (payload && typeof payload === 'object' && payload.siteConfig) ? payload.siteConfig : payload;
        const result = saveAdminSiteConfig(patchData);
        if (result.ok) {
          sendJson(res, 200, 0, '站点设置保存成功', result.config);
        } else {
          sendJson(res, 400, 40001, result.errors ? result.errors.join('；') : '保存失败');
        }
      }).catch(() => { });
      return true;
    }

    // 21. 系统监控：GET /api/v1/admin/monitor
    if (pathname === '/api/v1/admin/monitor' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const data = getAdminMonitor();
      sendJson(res, 200, 0, '查询成功', data);
      return true;
    }

    // 22. 数据洞察：GET /api/v1/admin/insights
    if (pathname === '/api/v1/admin/insights' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const data = getAdminInsights();
      sendJson(res, 200, 0, '查询成功', data);
      return true;
    }

    // 23. 渠道获客归因：GET /api/v1/admin/attribution
    if (pathname === '/api/v1/admin/attribution' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const data = getAdminAttribution();
      sendJson(res, 200, 0, '查询成功', data);
      return true;
    }

    // 24. 成片队列与健康度：GET /api/v1/admin/render-queue
    if (pathname === '/api/v1/admin/render-queue' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const data = getAdminRenderQueue();
      sendJson(res, 200, 0, '查询成功', data);
      return true;
    }

    // 25. 内容风控拦截日志：GET /api/v1/admin/moderation-logs
    if (pathname === '/api/v1/admin/moderation-logs' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const data = getAdminModerationLogs();
      sendJson(res, 200, 0, '查询成功', data);
      return true;
    }

    // 26. 商业经营大盘：GET /api/v1/admin/business-overview
    if (pathname === '/api/v1/admin/business-overview' && req.method === 'GET') {
      const admin = requireAdminAuth(req, res);
      if (!admin) return true;
      const data = getAdminBusinessOverview();
      sendJson(res, 200, 0, '查询成功', data);
      return true;
    }

    // 未知管理端接口兜底
    sendJson(res, 404, 40401, '未知的管理接口');
    return true;
  };
}

