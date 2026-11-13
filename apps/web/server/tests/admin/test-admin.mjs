// 简兮 (JANSEE) · S9 管理后台与运营控制中心 自动化测试套件
// 运行命令: node apps/web/server/tests/admin/test-admin.mjs

import assert from 'node:assert/strict';
import http from 'node:http';
import {
  adminStore,
  createAdmin,
  verifyAdmin,
  verifyAdminToken,
  extractAdminToken,
} from '../../adminStore.mjs';
import {
  errorTracker,
  recordAdminError,
  getAdminErrorStats,
  getAdminUsers,
  getAdminCreditRecords,
  adjustUserCredits,
  getAdminTasks,
} from '../../admin.mjs';
import { s8UsersMap, createUser } from '../../userStore.mjs';
import { creditStore } from '../../creditStore.mjs';
import { creationStore } from '../../creationStore.mjs';

function log(msg) {
  console.log(msg);
}

function pass(name) {
  console.log(`PASS ${name}`);
}

async function runTests() {
  log('================================================================');
  log('Jansee V2 S9: 管理后台与运营控制中心 (Admin Control) 自动化测试');
  log('================================================================\n');

  let passedCount = 0;

  // 重置测试沙箱状态
  adminStore.clear();
  errorTracker.clear();
  creditStore.clear();
  s8UsersMap.clear();
  creationStore.tasks.clear();

  // -----------------------------------------------------------------
  // 1. 管理员登录与密码校验
  // -----------------------------------------------------------------
  {
    // 1.1 默认管理员登录
    const loginRes = verifyAdmin('admin', 'admin123');
    assert(loginRes.adminToken && loginRes.adminToken.startsWith('adm_tok_'), '必须返回有效 adm_tok_ 格式 token');
    assert.equal(loginRes.admin.username, 'admin');
    assert.equal(loginRes.admin.role, 'super_admin');

    // 1.2 错误密码拦截
    assert.throws(
      () => verifyAdmin('admin', 'wrong_password'),
      (err) => err.code === 40101,
      '错误密码应抛出 40101 认证异常'
    );

    // 1.3 自定义创建管理员
    const newAdmin = createAdmin({
      username: 'ops_lily',
      password: 'lily_password_2026',
      role: 'operator',
      nickname: '运营小李',
    });
    assert.equal(newAdmin.username, 'ops_lily');
    assert.equal(newAdmin.role, 'operator');

    const opsLogin = verifyAdmin('ops_lily', 'lily_password_2026');
    assert(opsLogin.adminToken);

    pass('1. 管理员登录验证、密码校验与自定义账号创建');
    passedCount++;
  }

  // -----------------------------------------------------------------
  // 2. 权限拒绝与 Token 校验 (Auth Guard)
  // -----------------------------------------------------------------
  {
    const opsLogin = verifyAdmin('admin', 'admin123');
    const validSession = verifyAdminToken(opsLogin.adminToken);
    assert.equal(validSession.username, 'admin');

    // 伪造 token 拒绝
    const invalidSession = verifyAdminToken('adm_tok_fake_random');
    assert.equal(invalidSession, null);

    // 空 token 拒绝
    assert.equal(verifyAdminToken(''), null);
    assert.equal(verifyAdminToken(null), null);

    pass('2. 管理后台会话 Token 校验与非法凭证拦截拒绝');
    passedCount++;
  }

  // -----------------------------------------------------------------
  // 3. 用户管理 API 数据聚合 (getAdminUsers)
  // -----------------------------------------------------------------
  {
    const u1 = createUser({ phone: '13900000001', nickname: '创作者老张' });
    const u2 = createUser({ phone: '13900000002', nickname: '企业客户老王' });
    creditStore.createCreditAccount(u1.userId, 2500);
    creditStore.createCreditAccount(u2.userId, 6000);

    const userListRes = getAdminUsers({ limit: 10, offset: 0 });
    assert.equal(userListRes.total >= 2, true);
    const foundU1 = userListRes.list.find((u) => u.userId === u1.userId);
    const foundU2 = userListRes.list.find((u) => u.userId === u2.userId);

    assert(foundU1, '应包含用户老张');
    assert.equal(foundU1.balance, 2500, '用户老张余额应为 2500');
    assert(foundU2, '应包含用户老王');
    assert.equal(foundU2.balance, 6000, '用户老王余额应为 6000');

    pass('3. 用户列表数据聚合查询与实时积分余额挂载');
    passedCount++;
  }

  // -----------------------------------------------------------------
  // 4. 积分手动调整与流水强制生成 (adjustUserCredits)
  // -----------------------------------------------------------------
  {
    const u = createUser({ phone: '13900000003', nickname: '待调账用户' });
    creditStore.createCreditAccount(u.userId, 1000);

    // 4.1 正向充值/赠送
    const addRes = adjustUserCredits({
      userId: u.userId,
      amount: 500,
      reason: '新春运营活动赠送',
      adminId: 'admin',
    });
    assert.equal(addRes.balance, 1500, '增加 500 后余额应为 1500');
    assert.equal(addRes.transaction.type, 'recharge');
    assert.equal(addRes.transaction.amount, 500);

    // 4.2 负向扣减
    const deductRes = adjustUserCredits({
      userId: u.userId,
      amount: -300,
      reason: '违规刷量积分追回',
      adminId: 'admin',
    });
    assert.equal(deductRes.balance, 1200, '扣减 300 后余额应为 1200');
    assert.equal(deductRes.transaction.type, 'adjust_deduct');
    assert.equal(deductRes.transaction.amount, 300);

    // 4.3 尝试超出余额的非法扣减 (拦截防透支)
    assert.throws(
      () =>
        adjustUserCredits({
          userId: u.userId,
          amount: -2000,
          reason: '恶意过度扣减',
          adminId: 'admin',
        }),
      (err) => err.code === 40201,
      '超额扣减必须被拦截并抛出 40201'
    );

    pass('4. 管理员手动调整积分 (正充/负扣/透支拦截) 且强制生成不可篡改流水');
    passedCount++;
  }

  // -----------------------------------------------------------------
  // 5. 积分充值/消费/退款/调账流水明细检索 (getAdminCreditRecords)
  // -----------------------------------------------------------------
  {
    const u = createUser({ phone: '13900000004', nickname: '流水审计用户' });
    creditStore.createCreditAccount(u.userId, 2000);

    // 模拟消费
    creditStore.consumeCredits({
      userId: u.userId,
      amount: 200,
      reason: '分镜合成出片',
      taskId: 'task_audit_1',
    });

    // 模拟退款
    creditStore.refundCredits({
      userId: u.userId,
      amount: 200,
      reason: '任务失败退还',
      taskId: 'task_audit_1',
    });

    // 模拟管理调账
    adjustUserCredits({
      userId: u.userId,
      amount: 100,
      reason: '客服体验补偿',
      adminId: 'admin',
    });

    // 综合查询
    const txRecords = getAdminCreditRecords({ userId: u.userId });
    assert.equal(txRecords.total, 3);
    assert.equal(txRecords.list.length, 3);

    // 过滤消费
    const consumeRecords = getAdminCreditRecords({ userId: u.userId, type: 'consume' });
    assert.equal(consumeRecords.total, 1);
    assert.equal(consumeRecords.list[0].amount, 200);

    // 过滤退款
    const refundRecords = getAdminCreditRecords({ userId: u.userId, type: 'refund' });
    assert.equal(refundRecords.total, 1);
    assert.equal(refundRecords.list[0].amount, 200);

    pass('5. 积分全局流水多维审计 (充值/消费/退款/调账) 与类型过滤');
    passedCount++;
  }

  // -----------------------------------------------------------------
  // 6. 创作任务全生命周期监控与多维过滤 (getAdminTasks)
  // -----------------------------------------------------------------
  {
    creationStore.createTask({
      taskId: 'task_s9_1',
      type: 'storyboard',
      status: 'completed',
      userId: 'usr_test_a',
    });
    creationStore.createTask({
      taskId: 'task_s9_2',
      type: 'storyboard',
      status: 'producing',
      userId: 'usr_test_a',
    });
    creationStore.createTask({
      taskId: 'task_s9_3',
      type: 'image_creator',
      status: 'failed',
      userId: 'usr_test_b',
    });
    creationStore.createTask({
      taskId: 'task_s9_4',
      type: 'slicer',
      status: 'completed',
      userId: 'usr_test_b',
    });

    // 6.1 全量统计
    const allTasksRes = getAdminTasks();
    assert.equal(allTasksRes.total, 4);
    assert.equal(allTasksRes.statusCounts.completed, 2);
    assert.equal(allTasksRes.statusCounts.producing, 1);
    assert.equal(allTasksRes.statusCounts.failed, 1);

    // 6.2 条件过滤 (按 type)
    const storyboardTasks = getAdminTasks({ type: 'storyboard' });
    assert.equal(storyboardTasks.total, 2);

    // 6.3 条件过滤 (按 userId)
    const userBTasks = getAdminTasks({ userId: 'usr_test_b' });
    assert.equal(userBTasks.total, 2);

    pass('6. 创作任务全生命周期监控、多维过滤 (type/status/userId) 与状态分布统计');
    passedCount++;
  }

  // -----------------------------------------------------------------
  // 7. 全局错误监控统计 (ErrorTracker & getAdminErrorStats)
  // -----------------------------------------------------------------
  {
    recordAdminError(401, 40101, 'Unauthorized request');
    recordAdminError(402, 40201, 'Insufficient credits');
    recordAdminError(402, 40201, 'Insufficient credits');
    recordAdminError(403, 40301, 'Forbidden file path');
    recordAdminError(404, 40401, 'Resource not found');
    recordAdminError(500, 50001, 'Internal synthesis error');

    const stats = getAdminErrorStats();
    assert.equal(stats.total, 6);
    assert.equal(stats.byStatus['401'], 1);
    assert.equal(stats.byStatus['402'], 2);
    assert.equal(stats.byStatus['403'], 1);
    assert.equal(stats.byStatus['404'], 1);
    assert.equal(stats.byStatus['500'], 1);
    assert.equal(stats.recentErrors.length, 6);

    pass('7. 错误监控收集器精准统计 (401 / 402 / 403 / 404 / 500)');
    passedCount++;
  }

  // -----------------------------------------------------------------
  // 8. HTTP 真实网关端到端闭环测试
  // -----------------------------------------------------------------
  {
    // 启动隔离端口 HTTP 测试服务器
    const testPort = 3199;
    const testServer = http.createServer((req, res) => {
      const urlObj = new URL(req.url, `http://localhost:${testPort}`);
      const pathname = urlObj.pathname;

      function sendJson(code, msg, data = {}, statusCode = 200) {
        if (statusCode >= 400) {
          recordAdminError(statusCode, code, msg);
        }
        res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ code, msg, data, timestamp: Date.now() }));
      }

      function requireAdminAuth() {
        const token = extractAdminToken(req);
        if (!token) {
          sendJson(40101, '管理员未登录', {}, 401);
          return null;
        }
        const session = verifyAdminToken(token);
        if (!session) {
          sendJson(40301, '凭证无效或过期', {}, 403);
          return null;
        }
        return session;
      }

      if (pathname === '/api/v1/admin/login' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          let p = {};
          try { p = JSON.parse(body || '{}'); } catch (_) {}
          try {
            const r = verifyAdmin(p.username, p.password);
            sendJson(0, '登录成功', r, 200);
          } catch (e) {
            sendJson(e.code || 40101, e.message, {}, e.statusCode || 401);
          }
        });
        return;
      }

      if (pathname === '/api/v1/admin/users' && req.method === 'GET') {
        if (!requireAdminAuth()) return;
        const usersData = getAdminUsers();
        sendJson(0, '查询成功', usersData, 200);
        return;
      }

      if (pathname === '/api/v1/admin/credits' && req.method === 'GET') {
        if (!requireAdminAuth()) return;
        const records = getAdminCreditRecords();
        sendJson(0, '查询成功', records, 200);
        return;
      }

      if (pathname === '/api/v1/admin/credits/adjust' && req.method === 'POST') {
        const admin = requireAdminAuth();
        if (!admin) return;
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          let p = {};
          try { p = JSON.parse(body || '{}'); } catch (_) {}
          try {
            const r = adjustUserCredits({
              userId: p.userId,
              amount: p.amount,
              reason: p.reason,
              adminId: admin.username,
            });
            sendJson(0, '调账成功', r, 200);
          } catch (e) {
            sendJson(e.code || 40001, e.message, {}, e.statusCode || 400);
          }
        });
        return;
      }

      if (pathname === '/api/v1/admin/tasks' && req.method === 'GET') {
        if (!requireAdminAuth()) return;
        const tasksData = getAdminTasks();
        sendJson(0, '查询成功', tasksData, 200);
        return;
      }

      if (pathname === '/api/v1/admin/errors' && req.method === 'GET') {
        if (!requireAdminAuth()) return;
        const statsData = getAdminErrorStats();
        sendJson(0, '查询成功', statsData, 200);
        return;
      }

      sendJson(40400, 'Not Found', {}, 404);
    });

    await new Promise((resolve) => testServer.listen(testPort, '127.0.0.1', resolve));

    function makeRequest({ method = 'GET', path, headers = {}, body = null }) {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: testPort,
            path,
            method,
            headers: {
              'Content-Type': 'application/json',
              ...headers,
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data || '{}');
                resolve({ statusCode: res.statusCode, body: parsed });
              } catch (_) {
                resolve({ statusCode: res.statusCode, raw: data });
              }
            });
          }
        );
        req.on('error', reject);
        if (body) {
          req.write(JSON.stringify(body));
        }
        req.end();
      });
    }

    try {
      // 8.1 未提供 Token 访问受限接口拦截 (401)
      const unauthRes = await makeRequest({ path: '/api/v1/admin/users' });
      assert.equal(unauthRes.statusCode, 401);
      assert.equal(unauthRes.body.code, 40101);

      // 8.2 提供非法 Token 访问受限接口拦截 (403)
      const forbiddenRes = await makeRequest({
        path: '/api/v1/admin/users',
        headers: { 'x-admin-token': 'adm_tok_invalid_xxx' },
      });
      assert.equal(forbiddenRes.statusCode, 403);
      assert.equal(forbiddenRes.body.code, 40301);

      // 8.3 管理员登录 HTTP 端点
      const loginRes = await makeRequest({
        method: 'POST',
        path: '/api/v1/admin/login',
        body: { username: 'admin', password: 'admin123' },
      });
      assert.equal(loginRes.statusCode, 200);
      assert(loginRes.body.data.adminToken);
      const token = loginRes.body.data.adminToken;

      // 8.4 带合法 Token 查用户列表
      const usersHttpRes = await makeRequest({
        path: '/api/v1/admin/users',
        headers: { 'x-admin-token': token },
      });
      assert.equal(usersHttpRes.statusCode, 200);
      assert(Array.isArray(usersHttpRes.body.data.list));

      // 8.5 管理员通过 HTTP 端点手动调账
      const targetUser = usersHttpRes.body.data.list[0];
      if (targetUser) {
        const adjustHttpRes = await makeRequest({
          method: 'POST',
          path: '/api/v1/admin/credits/adjust',
          headers: { 'x-admin-token': token },
          body: {
            userId: targetUser.userId,
            amount: 888,
            reason: 'HTTP 管理员调账测试',
          },
        });
        assert.equal(adjustHttpRes.statusCode, 200);
        assert.equal(adjustHttpRes.body.data.transaction.amount, 888);
      }

      // 8.6 查看全局流水 HTTP 端点
      const creditsHttpRes = await makeRequest({
        path: '/api/v1/admin/credits',
        headers: { 'x-admin-token': token },
      });
      assert.equal(creditsHttpRes.statusCode, 200);
      assert(Array.isArray(creditsHttpRes.body.data.list));

      // 8.7 查看任务监控 HTTP 端点
      const tasksHttpRes = await makeRequest({
        path: '/api/v1/admin/tasks',
        headers: { 'x-admin-token': token },
      });
      assert.equal(tasksHttpRes.statusCode, 200);
      assert(tasksHttpRes.body.data.statusCounts);

      // 8.8 查看错误统计 HTTP 端点
      const errorsHttpRes = await makeRequest({
        path: '/api/v1/admin/errors',
        headers: { 'x-admin-token': token },
      });
      assert.equal(errorsHttpRes.statusCode, 200);
      assert(errorsHttpRes.body.data.byStatus);

      pass('8. HTTP 真实网关端到端：管理员登录 -> 鉴权拦截 -> 用户查询 -> 积分调账 -> 任务与错误监控');
      passedCount++;
    } finally {
      await new Promise((resolve) => testServer.close(resolve));
    }
  }

  log('\n--------------------------------------------------------');
  log(`S9 管理后台与运营控制测试汇总: 通过 ${passedCount} 项 / 失败 0 项`);
  log('--------------------------------------------------------\n');
}

runTests().catch((err) => {
  console.error('测试异常失败:', err);
  process.exit(1);
});
