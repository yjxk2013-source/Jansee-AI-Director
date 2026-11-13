// 简兮 (JANSEE) · S7 生产可用架构自动化测试
// 文件: apps/web/server/tests/production/test-production-ready.mjs
// 覆盖：
//   1. creationStore CRUD（创建、读取、增量更新、按条件降序列表）
//   2. 统一产物 Delivery 层安全清洗与路径脱敏 (normalizeOutput)
//   3. S7 统一错误码体系 (ERROR_CODES & createAppError)
//   4. 积分与鉴权 Hook 调用 (beforeCreateHook / afterCreateHook)
//   5. HTTP 网关创作历史接口 (GET /api/v1/creation/history)
//   6. 旧接口 GET /api/v1/video/task/:taskId 透明 fallback 兼容
// 铁律：纯 Stub / Mock，零真实付费调用，零物理路径泄露。

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import {
  createCreationTask,
  getCreationTask,
  listCreationHistory,
  isCreationTaskExpired,
  beforeCreateHook,
  afterCreateHook,
} from '../../creation.mjs';
import { CreationStore, creationStore } from '../../creationStore.mjs';
import { normalizeOutput, sanitizeToSafeUrl } from '../../delivery.mjs';
import { ERROR_CODES, createAppError } from '../../errors.mjs';
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
const TEMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'jansee-s7-test-'));
const STORAGE_UPLOADS = path.join(TEMP_BASE, 'storage', 'uploads');
const STORAGE_OUTPUTS = path.join(TEMP_BASE, 'storage', 'outputs');
const MATERIALS_DIR = path.join(TEMP_BASE, 'materials');
fs.mkdirSync(STORAGE_UPLOADS, { recursive: true });
fs.mkdirSync(STORAGE_OUTPUTS, { recursive: true });
fs.mkdirSync(MATERIALS_DIR, { recursive: true });

function createMockFile(filename) {
  const fp = path.join(STORAGE_UPLOADS, filename);
  fs.writeFileSync(fp, Buffer.from('mock_media_data'));
  return fp;
}

const mockMedia1 = createMockFile('video_s7_1.mp4');
const matId1 = registerMaterial({
  type: 'upload_video',
  filePath: mockMedia1,
  durationSec: 8.5,
  text: 'S7 原声素材',
});

async function runTests() {
  console.log('================================================================');
  console.log('Jansee V2 S7: 生产可用架构升级 (Production Readiness) 自动化测试');
  console.log('================================================================\n');

  // 1. creationStore CRUD 完整生命周期
  await check('1. creationStore CRUD (增删改查、patch、过滤排序)', () => {
    const store = new CreationStore();

    // 1.1 创建任务
    const t1 = store.createTask({
      taskId: 'crt_store_001',
      type: 'storyboard',
      status: 'pending',
      title: '任务一',
      createdAt: 1000,
    });
    assert.equal(t1.taskId, 'crt_store_001');
    assert.equal(t1.status, 'pending');

    const t2 = store.createTask({
      taskId: 'crt_store_002',
      type: 'video_dub',
      status: 'completed',
      title: '任务二',
      createdAt: 2000,
    });

    // 1.2 查询任务
    const readT1 = store.getTask('crt_store_001');
    assert.ok(readT1);
    assert.equal(readT1.title, '任务一');
    assert.equal(store.getTask('crt_non_exist'), null);

    // 1.3 局部更新 patch
    const updatedT1 = store.updateTask('crt_store_001', {
      status: 'completed',
      stage: 'done',
      progress: 100,
      outputs: { video: '/storage/outputs/1.mp4' },
    });
    assert.equal(updatedT1.status, 'completed');
    assert.equal(updatedT1.progress, 100);
    assert.equal(updatedT1.outputs.video, '/storage/outputs/1.mp4');
    assert.ok(updatedT1.updatedAt >= 1000);

    // 1.4 条件过滤与降序列表
    const allDesc = store.listTasks();
    assert.equal(allDesc.length, 2);
    assert.equal(allDesc[0].taskId, 'crt_store_002', '较晚创建的排在前面');

    const filtered = store.listTasks({ type: 'video_dub' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].taskId, 'crt_store_002');
  });

  // 2. 统一产物 Delivery 层安全清洗与路径脱敏
  await check('2. delivery 统一输出结构与服务器物理绝对路径脱敏', () => {
    // 2.1 物理路径安全转换为静态网络路径
    const safeUrl1 = sanitizeToSafeUrl('C:\\jansee\\storage\\outputs\\crt_100\\final.mp4');
    assert.equal(safeUrl1, '/storage/outputs/crt_100/final.mp4');

    const safeUrl2 = sanitizeToSafeUrl('/var/data/storage/outputs/crt_200/cover.jpg');
    assert.equal(safeUrl2, '/storage/outputs/crt_200/cover.jpg');

    // 2.2 恶意或不可识别的敏感服务器路径安全屏蔽
    const dangerousPath = sanitizeToSafeUrl('C:\\Windows\\system32\\cmd.exe');
    assert.equal(dangerousPath, '', '系统绝对路径必须被屏蔽为空');

    // 2.3 normalizeOutput 规范输出
    const norm = normalizeOutput({
      videoUrl: 'f:\\project\\storage\\outputs\\crt_300\\final.mp4',
      cover: 'f:\\project\\storage\\outputs\\crt_300\\cover.jpg',
      duration: 15.678,
      variantType: 'sell_fashion',
      slices: [
        { file: 'f:\\project\\storage\\outputs\\crt_300\\slices\\p1.mp4', durationSec: 5 },
      ],
    }, 'crt_300');

    assert.equal(norm.video, '/storage/outputs/crt_300/final.mp4');
    assert.equal(norm.cover, '/storage/outputs/crt_300/cover.jpg');
    assert.equal(norm.duration, 15.68);
    assert.equal(norm.variantType, 'sell_fashion');
    assert.equal(norm.slices[0].videoUrl, '/storage/outputs/crt_300/slices/p1.mp4');
    assert.ok(!JSON.stringify(norm).includes('f:\\project'), '输出绝不包含物理盘符');

    // 2.4 发布方案（增值交付物）白名单透传：四件套齐全、调试字段 _banned_hits 不外泄、超长钳制
    const normPub = normalizeOutput({
      videoUrl: '/storage/outputs/crt_301/final.mp4',
      publish: {
        caption: 'x'.repeat(400),
        cover_title: '封面大字超长被钳',
        pinned_comment: '欢迎到店体验',
        post_time: '工作日 12:00-13:00',
        _banned_hits: ['最好'],
      },
    }, 'crt_301');
    assert.equal(normPub.publish.caption.length, 300, 'caption 钳制到 300 字');
    assert.equal(normPub.publish.cover_title.length, 8, 'cover_title 钳制到 8 字');
    assert.equal(normPub.publish.pinned_comment, '欢迎到店体验');
    assert.equal(normPub.publish.post_time, '工作日 12:00-13:00');
    assert.ok(!('_banned_hits' in normPub.publish), '调试字段 _banned_hits 不外泄');
    assert.equal(normalizeOutput({ videoUrl: '/x.mp4' }).publish, undefined, '无 publish 时不造空对象');
  });

  // 3. S7 统一错误码体系
  await check('3. 统一错误码体系分层与 createAppError 结构化验证', () => {
    assert.equal(ERROR_CODES.PARAM_INVALID, 40001);
    assert.equal(ERROR_CODES.SECURITY_PATH_FORBIDDEN, 40301);
    assert.equal(ERROR_CODES.RESOURCE_NOT_FOUND, 40400);
    assert.equal(ERROR_CODES.TASK_DUPLICATED, 40901);
    assert.equal(ERROR_CODES.SYNTHESIS_FAILED, 50001);

    const err = createAppError(ERROR_CODES.SECURITY_PATH_FORBIDDEN, '禁止提交物理路径');
    assert.equal(err.name, 'AppError');
    assert.equal(err.code, 40301);
    assert.equal(err.status, 403);
    assert.ok(err.includes('禁止提交物理路径'));
  });

  // 4. 积分扣费与鉴权 Hook 流程
  await check('4. 创作任务 beforeCreateHook / afterCreateHook 预留钩子', async () => {
    let beforeCalled = false;
    let afterCalled = false;
    const inMemoryTasks = new Map();

    const res = createCreationTask({
      payload: {
        type: 'storyboard',
        materialIds: [matId1],
        scriptMode: 'provided',
      },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
      deps: {
        beforeCreateHook: async ({ payload }) => {
          beforeCalled = true;
          return { ok: true, remainingCredits: 2850 };
        },
        afterCreateHook: async ({ task }) => {
          afterCalled = true;
          return { ok: true, chargedCredits: 200 };
        },
        startStoryboardProduce: async () => ({ taskId: 'sb_hook_1' }),
        syncSubTaskProgress: async () => {},
      },
    });

    assert.ok(beforeCalled, '必须触发 beforeCreateHook');
    assert.ok(afterCalled, '必须触发 afterCreateHook');
    assert.ok(res.taskId.startsWith('crt_'));
  });

  // 5. 创作历史查询 API 与脱敏安全性 (GET /api/v1/creation/history)
  await check('5. 创作历史 API (GET /api/v1/creation/history) 格式与安全脱敏', async () => {
    const inMemoryTasks = new Map();
    inMemoryTasks.set('crt_memory_expired', {
      taskId: 'crt_memory_expired',
      status: 'completed',
      title: '内存中的过期作品',
      expireAt: Date.now() - 1000,
    });

    // 预置两个任务至全局 creationStore
    creationStore.createTask({
      taskId: 'crt_hist_001',
      type: 'storyboard',
      status: 'completed',
      input: { title: '历史任务一' },
      outputs: { cover: '/storage/outputs/crt_hist_001/cover.jpg', duration: 10 },
      createdAt: Date.now() - 5000,
    });

    creationStore.createTask({
      taskId: 'crt_hist_002',
      type: 'video_dub',
      status: 'completed',
      input: { title: '历史任务二' },
      outputs: { cover: '/storage/outputs/crt_hist_002/cover.jpg', duration: 25 },
      createdAt: Date.now(),
    });

    // 5.1 模块级 listCreationHistory 查询
    const historyList = listCreationHistory();
    assert.ok(historyList.length >= 2);
    assert.equal(historyList[0].taskId, 'crt_hist_002', '按时间降序');
    assert.equal(historyList[0].title, '历史任务二');
    assert.equal(historyList[0].duration, 25);
    assert.ok(!historyList[0].filePath, '绝不泄露 filePath');

    // 5.1.1 24 小时到期后，作品列表与任务详情必须立即不可见，不等待定时清理。
    creationStore.createTask({
      taskId: 'crt_hist_expired',
      type: 'storyboard',
      status: 'completed',
      title: '不应继续展示的过期作品',
      expireAt: Date.now() - 1000,
      createdAt: Date.now() - 25 * 3600 * 1000,
    });
    assert.equal(getCreationTask('crt_hist_expired'), null, '过期作品详情应立即失效');
    assert.equal(isCreationTaskExpired({ createdAt: Date.now() - 25 * 3600 * 1000 }), true, '旧任务缺少 expireAt 时也必须按创建时间执行 24 小时到期');
    assert.ok(!listCreationHistory().some((item) => item.taskId === 'crt_hist_expired'), '过期作品标题不得继续出现在我的作品');
    assert.ok(creationStore.getTask('crt_hist_expired'), '列表隐藏不应提前丢失定时清理所需的到期信息');
    creationStore.cleanExpiredTasks();
    assert.equal(creationStore.getTask('crt_hist_expired'), null, '定时清理应最终删除过期作品记录');

    // 5.2 HTTP 级端到端测试
    const server = http.createServer((req, res) => {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = urlObj.pathname;

      function sendJson(code, msg, data = {}, status = 200) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ code, msg, data, timestamp: Date.now() }));
      }

      if (pathname === '/api/v1/creation/history' && req.method === 'GET') {
        const tasks = listCreationHistory();
        sendJson(0, '查询成功', { tasks }, 200);
        return;
      }

      if (pathname.startsWith('/api/v1/video/task/') && req.method === 'GET') {
        const taskId = pathname.replace('/api/v1/video/task/', '').trim();
        const memoryTask = inMemoryTasks.get(taskId);
        const task = (isCreationTaskExpired(memoryTask) ? null : memoryTask) || getCreationTask(taskId);
        if (!task) {
          if (isCreationTaskExpired(memoryTask)) inMemoryTasks.delete(taskId);
          return sendJson(40400, '任务不存在或已过期', {}, 404);
        }
        return sendJson(0, '查询成功', task, 200);
      }

      sendJson(40400, 'Not Found', {}, 404);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // (1) 历史列表请求
      const histRes = await fetch(`${baseUrl}/api/v1/creation/history`);
      const histJson = await histRes.json();
      assert.equal(histRes.status, 200);
      assert.equal(histJson.code, 0);
      assert.ok(Array.isArray(histJson.data.tasks));
      const first = histJson.data.tasks[0];
      assert.ok(first.taskId);
      assert.ok(first.type);
      assert.ok(first.status);

      // 严格安全断言：JSON 字符串内绝无系统敏感路径
      const bodyStr = JSON.stringify(histJson);
      assert.ok(!bodyStr.includes('C:\\'));
      assert.ok(!bodyStr.includes('/var/'));
      assert.ok(!bodyStr.includes('filePath'));

      // (2) 旧接口 GET /api/v1/video/task/:taskId fallback 兼容测试
      const fbRes = await fetch(`${baseUrl}/api/v1/video/task/crt_hist_001`);
      const fbJson = await fbRes.json();
      assert.equal(fbRes.status, 200);
      assert.equal(fbJson.code, 0);
      assert.equal(fbJson.data.taskId, 'crt_hist_001');

      // 内存任务表不得绕过 24 小时到期规则。
      const expiredMemoryRes = await fetch(`${baseUrl}/api/v1/video/task/crt_memory_expired`);
      assert.equal(expiredMemoryRes.status, 404, '内存中的过期作品详情必须返回 404');
      assert.equal(inMemoryTasks.has('crt_memory_expired'), false, '读取到期任务时应顺手清除内存残留');
    } finally {
      server.close();
    }
  });

  console.log('\n--------------------------------------------------------');
  console.log(`S7 生产可用架构测试汇总: 通过 ${PASS.length} 项 / 失败 ${FAIL.length} 项`);
  console.log('--------------------------------------------------------');

  if (FAIL.length > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('测试异常终止:', err);
  process.exit(1);
});
