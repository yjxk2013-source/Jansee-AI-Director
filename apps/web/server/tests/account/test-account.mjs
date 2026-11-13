// 简兮 (JANSEE) · S8 用户体系与商业化闭环自动化测试
// 文件: apps/web/server/tests/account/test-account.mjs
// 覆盖：
//   1. 用户账户创建与详情检索 (userStore)
//   2. 会话状态管理与 Session 验证/过期销毁 (auth)
//   3. 积分账户初始化与流水记录 (creditStore)
//   4. 创作任务积分正常扣减 (storyboard/dub/slicer/speechcut/image_creator)
//   5. 算力余额不足硬性拦截 (40201)
//   6. 同 taskId 重复消费幂等防护（严禁重复扣费）
//   7. 多租户用户创作历史物理隔离（A 用户绝不可见 B 用户任务）
//   8. 非法或过期 sessionToken 鉴权拒绝 (40101)
//   9. HTTP 网关端到端集成测试（注册 -> 查积分 -> 带 Token 创作出片 -> 隔离查询）
// 铁律：纯 Stub / Mock，零真实短信，零真实支付 API。

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import {
  createUser,
  getUser,
  updateUser,
  listUsers,
} from '../../userStore.mjs';
import {
  CreditStore,
  creditStore,
} from '../../creditStore.mjs';
import {
  AuthManager,
  authManager,
  createSession,
  verifySession,
  destroySession,
  extractSessionToken,
} from '../../auth.mjs';
import {
  createCreationTask,
  getCreationTask,
  listCreationHistory,
  beforeCreateHook,
} from '../../creation.mjs';
import { creationStore } from '../../creationStore.mjs';
import { registerMaterial } from '../../storyboard.mjs';

const PASS = [];
const FAIL = [];

async function check(name, fn) {
  try {
    await fn();
    PASS.push(name);
    console.log(`PASS ${name}`);
  } catch (e) {
    FAIL.push(name);
    console.log(`FAIL ${name}（${e.message}）`);
  }
}

// 准备测试沙箱与测试素材
const TEMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'jansee-s8-account-'));
const STORAGE_UPLOADS = path.join(TEMP_BASE, 'storage', 'uploads');
const STORAGE_OUTPUTS = path.join(TEMP_BASE, 'storage', 'outputs');
const MATERIALS_DIR = path.join(TEMP_BASE, 'materials');
fs.mkdirSync(STORAGE_UPLOADS, { recursive: true });
fs.mkdirSync(STORAGE_OUTPUTS, { recursive: true });
fs.mkdirSync(MATERIALS_DIR, { recursive: true });

function createMockFile(filename) {
  const fp = path.join(STORAGE_UPLOADS, filename);
  fs.writeFileSync(fp, Buffer.from('mock_account_media'));
  return fp;
}

const mockMedia = createMockFile('account_test.mp4');
const matId1 = registerMaterial({
  type: 'upload_video',
  filePath: mockMedia,
  durationSec: 10.0,
});

async function runTests() {
  console.log('================================================================');
  console.log('Jansee V2 S8: 用户体系与商业化闭环 自动化测试');
  console.log('================================================================\n');

  // 1. 用户账户创建与详情检索
  await check('1. userStore 用户账户创建、查询与信息更新', () => {
    const user1 = createUser({ phone: '13800000001', nickname: '创作者老李' });
    assert.ok(user1.userId.startsWith('usr_'));
    assert.equal(user1.phone, '13800000001');
    assert.equal(user1.nickname, '创作者老李');
    assert.equal(user1.status, 'active');

    // 重复注册相同手机号返回已有用户
    const user1Repeat = createUser({ phone: '13800000001' });
    assert.equal(user1Repeat.userId, user1.userId);

    // 查询用户
    const found = getUser(user1.userId);
    assert.equal(found.phone, '13800000001');

    // 局部更新用户
    const updated = updateUser(user1.userId, { nickname: '金牌剪辑师' });
    assert.equal(updated.nickname, '金牌剪辑师');
    assert.equal(updated.phone, '13800000001');
  });

  // 2. 会话状态管理与 Session 验证
  await check('2. auth 模块 Session 创建、鉴权验证与销毁', () => {
    const testUid = 'usr_test_auth_01';
    const token = createSession(testUid, 3600 * 1000);
    assert.ok(token.startsWith('sess_'));

    // 正常验证
    const sess = verifySession(token);
    assert.ok(sess);
    assert.equal(sess.userId, testUid);

    // 未知或非法 token
    assert.equal(verifySession('sess_fake_not_exist'), null);
    assert.equal(verifySession(''), null);

    // 销毁 session (登出)
    const destroyed = destroySession(token);
    assert.equal(destroyed, true);
    assert.equal(verifySession(token), null);
  });

  // 3. 积分账户初始化与流水记录
  await check('3. creditStore 积分初始化、流水记录与查询', () => {
    const store = new CreditStore();
    const uid = 'usr_credit_001';

    // 初始积分 800
    const b0 = store.createCreditAccount(uid, 800);
    assert.equal(b0, 800);
    assert.equal(store.getBalance(uid), 800);

    // 记录充值流水
    store.recordTransaction({
      userId: uid,
      type: 'grant',
      amount: 200,
      reason: '新用户首充赠送',
    });

    const txList = store.listTransactions(uid);
    assert.equal(txList.length, 1);
    assert.equal(txList[0].amount, 200);
    assert.equal(txList[0].type, 'grant');
  });

  // 4. 创作任务积分正常扣减
  await check('4. 创作任务扣减积分流程 (扣减与余额同步)', () => {
    const store = new CreditStore();
    const uid = 'usr_credit_consume_01';
    store.createCreditAccount(uid, 1000);

    // 扣减 200 积分
    const r1 = store.consumeCredits({
      userId: uid,
      amount: 200,
      reason: 'storyboard 出片消费',
      taskId: 'crt_task_mock_1',
    });
    assert.equal(r1.balance, 800);
    assert.equal(r1.idempotent, false);
    assert.equal(r1.transaction.amount, 200);

    // 再次扣减 100 积分
    const r2 = store.consumeCredits({
      userId: uid,
      amount: 100,
      reason: 'video_dub 配音消费',
      taskId: 'crt_task_mock_2',
    });
    assert.equal(r2.balance, 700);
  });

  // 5. 算力余额不足硬性拦截 (40201)
  await check('5. 余额不足时抛出 40201 业务错误', () => {
    const store = new CreditStore();
    const poorUid = 'usr_poor_user';
    store.createCreditAccount(poorUid, 50);

    // 试图扣除 200 积分
    assert.throws(
      () => {
        store.consumeCredits({
          userId: poorUid,
          amount: 200,
          reason: '出片',
          taskId: 'crt_task_poor_1',
        });
      },
      (err) => err.code === 40201 && err.message.includes('算力积分不足')
    );

    // 余额必须保持不变
    assert.equal(store.getBalance(poorUid), 50);
  });

  // 6. 同 taskId 重复消费幂等防护
  await check('6. taskId 幂等保护：同一任务绝不重复扣减积分', () => {
    const store = new CreditStore();
    const uid = 'usr_idempotent_test';
    store.createCreditAccount(uid, 500);

    const fixedTaskId = 'crt_fixed_task_idempotent';

    // 第一次消费 200
    const first = store.consumeCredits({
      userId: uid,
      amount: 200,
      reason: '首次扣费',
      taskId: fixedTaskId,
    });
    assert.equal(first.balance, 300);
    assert.equal(first.idempotent, false);

    // 第二次传入相同 taskId 请求消费
    const second = store.consumeCredits({
      userId: uid,
      amount: 200,
      reason: '重复重试扣费',
      taskId: fixedTaskId,
    });
    assert.equal(second.balance, 300, '余额不应发生第二次扣减');
    assert.equal(second.idempotent, true, '标记为幂等返回');
    assert.equal(second.transaction.transactionId, first.transaction.transactionId);
  });

  // 7. 多租户用户创作历史物理隔离
  await check('7. 用户创作历史严格隔离 (A 用户无法看见 B 用户的任务)', () => {
    const uA = 'usr_tenant_A';
    const uB = 'usr_tenant_B';

    // 为 A 用户存入任务
    creationStore.createTask({
      taskId: 'crt_tenant_A_task',
      userId: uA,
      type: 'storyboard',
      status: 'completed',
      input: { title: '用户A的独家视频' },
      createdAt: Date.now() - 1000,
    });

    // 为 B 用户存入任务
    creationStore.createTask({
      taskId: 'crt_tenant_B_task',
      userId: uB,
      type: 'video_dub',
      status: 'completed',
      input: { title: '用户B的商业私密视频' },
      createdAt: Date.now() - 2000,
    });

    // 查询 A 用户的历史
    const historyA = listCreationHistory({ userId: uA });
    assert.equal(historyA.length, 1);
    assert.equal(historyA[0].taskId, 'crt_tenant_A_task');
    assert.equal(historyA[0].title, '用户A的独家视频');

    // 查询 B 用户的历史
    const historyB = listCreationHistory({ userId: uB });
    assert.equal(historyB.length, 1);
    assert.equal(historyB[0].taskId, 'crt_tenant_B_task');
    assert.equal(historyB[0].title, '用户B的商业私密视频');
  });

  // 8. 非法或过期 sessionToken 鉴权拒绝 (40101)
  await check('8. 非法 sessionToken 触发 40101 认证拒绝', () => {
    assert.throws(
      () => {
        beforeCreateHook({
          payload: {
            type: 'storyboard',
            sessionToken: 'sess_invalid_token_xyz',
          },
        });
      },
      (err) => err.code === 40101 && err.status === 401
    );
  });

  // 9. HTTP 网关级端到端商业化闭环集成测试
  await check('9. HTTP 真实网关端到端：注册 -> 查积分 -> 扣点出片 -> 查历史隔离', async () => {
    const inMemoryTasks = new Map();
    const server = http.createServer((req, res) => {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = urlObj.pathname;

      function sendJson(code, msg, data = {}, status = 200) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ code, msg, data, timestamp: Date.now() }));
      }

      // 用户注册接口
      if (pathname === '/api/v1/user/register' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          let payload = {};
          try { payload = JSON.parse(body || '{}'); } catch (e) {}
          const user = createUser({ phone: payload.phone, nickname: payload.nickname });
          creditStore.createCreditAccount(user.userId, 800);
          const sessionToken = createSession(user.userId);
          sendJson(0, '注册成功', { userId: user.userId, sessionToken }, 200);
        });
        return;
      }

      // 查询积分接口
      if (pathname === '/api/v1/user/credits' && req.method === 'GET') {
        const token = extractSessionToken(req);
        const session = verifySession(token);
        if (!session) {
          sendJson(40101, '未登录', {}, 401);
          return;
        }
        const balance = creditStore.getBalance(session.userId);
        sendJson(0, '查询成功', { balance }, 200);
        return;
      }

      // 创作任务创建接口 (挂接鉴权与扣费)
      if (pathname === '/api/v1/creation/create' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          let payload = {};
          try { payload = JSON.parse(body || '{}'); } catch (e) {}
          const token = extractSessionToken(req) || payload.sessionToken;
          if (token) payload.sessionToken = token;

          try {
            const r = createCreationTask({
              payload,
              inMemoryTasks,
              storageOutputsDir: STORAGE_OUTPUTS,
              storageUploadsDir: STORAGE_UPLOADS,
              materialsDir: MATERIALS_DIR,
              deps: {
                startStoryboardProduce: async () => ({ taskId: 'sb_e2e_1' }),
                syncSubTaskProgress: async () => {},
              },
            });
            sendJson(0, '创作任务已创建', r, 200);
          } catch (e) {
            const statusCode = e.code === 40201 ? 402 : e.code === 40101 ? 401 : e.code === 40301 ? 403 : 400;
            sendJson(e.code || 40000, e.message, {}, statusCode);
          }
        });
        return;
      }

      // 创作历史查询 (带隔离)
      if (pathname === '/api/v1/creation/history' && req.method === 'GET') {
        const token = extractSessionToken(req);
        const session = verifySession(token);
        const currentUserId = session ? session.userId : undefined;
        const tasks = listCreationHistory({ userId: currentUserId });
        sendJson(0, '查询成功', { tasks }, 200);
        return;
      }

      sendJson(40400, 'Not Found', {}, 404);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. 注册两名用户 Alice 和 Bob
      const regAlice = await (await fetch(`${baseUrl}/api/v1/user/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '13911112222', nickname: 'Alice' }),
      })).json();
      const tokenAlice = regAlice.data.sessionToken;

      const regBob = await (await fetch(`${baseUrl}/api/v1/user/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '13933334444', nickname: 'Bob' }),
      })).json();
      const tokenBob = regBob.data.sessionToken;

      // 2. 验证 Alice 初始积分 800
      const credAlice = await (await fetch(`${baseUrl}/api/v1/user/credits`, {
        headers: { Authorization: `Bearer ${tokenAlice}` },
      })).json();
      assert.equal(credAlice.data.balance, 800);

      // 3. Alice 提交创作任务 (storyboard 消耗 200 积分)
      const createRes = await (await fetch(`${baseUrl}/api/v1/creation/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenAlice}`,
        },
        body: JSON.stringify({
          type: 'storyboard',
          title: 'Alice 的第一部微电影',
          materialIds: [matId1],
          scriptMode: 'provided',
        }),
      })).json();
      assert.equal(createRes.code, 0);

      // 4. 再次查询 Alice 积分 (800 - 200 = 600)
      const credAliceAfter = await (await fetch(`${baseUrl}/api/v1/user/credits`, {
        headers: { Authorization: `Bearer ${tokenAlice}` },
      })).json();
      assert.equal(credAliceAfter.data.balance, 600);

      // 5. 验证 Bob 的历史中绝对没有 Alice 的任务
      const bobHistory = await (await fetch(`${baseUrl}/api/v1/creation/history`, {
        headers: { Authorization: `Bearer ${tokenBob}` },
      })).json();
      assert.equal(bobHistory.data.tasks.length, 0);

      // 6. 验证 Alice 查自己的历史，能看到自己的任务
      const aliceHistory = await (await fetch(`${baseUrl}/api/v1/creation/history`, {
        headers: { Authorization: `Bearer ${tokenAlice}` },
      })).json();
      assert.equal(aliceHistory.data.tasks.length, 1);
      assert.equal(aliceHistory.data.tasks[0].title, 'Alice 的第一部微电影');
    } finally {
      server.close();
    }
  });

  console.log('\n--------------------------------------------------------');
  console.log(`S8 账户与商业化闭环测试汇总: 通过 ${PASS.length} 项 / 失败 ${FAIL.length} 项`);
  console.log('--------------------------------------------------------');

  if (FAIL.length > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('测试异常终止:', err);
  process.exit(1);
});
