// 简兮 (JANSEE) · 多版成片（批量赛马）契约测试
// 文件: apps/web/server/tests/creation/test-creation-versions.mjs
// 覆盖：
//   1. versions 参数钳制与不支持类型拒绝（speechcut/slicer/storyboard-provided）
//   2. 积分按版本数线性叠加（beforeCreateHook ×N）
//   3. 批次编排：N 条全部成功 → outputs.versions 交付、renderTaskId 唯一、
//      钩子角度互不相同、版式互不相同（N ≤ 5）
//   4. 部分失败不拖垮整批：≥1 条成功即整批 completed，失败条目标记 failed
//   5. 全部失败 → 整批 failed
//   6. 单版路径零回归：versions 缺省时任务不带批次字段，renderTaskId === taskId
//   7. normalizeOutput 的 versions 白名单透传
//   8. 导演层 variantAngle 注入：设置时含差异化指令，缺省时不含
// 铁律：纯 Stub / Mock，零真实 LLM、零真实 TTS、零付费云调用。

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  createCreationTask,
  getCreationTask,
  beforeCreateHook,
} from '../../creation.mjs';
import { registerMaterial } from '../../storyboard.mjs';
import { normalizeOutput } from '../../delivery.mjs';
import { buildDirectorPrompt } from '../../director.mjs';

// 本文件只验证批次编排契约，不覆盖鉴权路径。服务端已把「无任何身份信息」从
// 「放行且不扣费」改为「401 拒绝」（2026-10-28 资损修复），故在测试进程内显式
// 声明允许匿名创作，避免安全红线误伤纯桩测试。生产进程不设置此变量。
// 鉴权的正反用例见 tests/account/test-account.mjs。
process.env.ALLOW_ANON_CREATION = '1';

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

// 测试临时沙箱与虚拟素材
const TEMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'jansee-versions-test-'));
const STORAGE_UPLOADS = path.join(TEMP_BASE, 'storage', 'uploads');
const STORAGE_OUTPUTS = path.join(TEMP_BASE, 'storage', 'outputs');
fs.mkdirSync(STORAGE_UPLOADS, { recursive: true });
fs.mkdirSync(STORAGE_OUTPUTS, { recursive: true });

const matImage = registerMaterial({
  type: 'upload_image',
  filePath: (() => {
    const fp = path.join(STORAGE_UPLOADS, 'img1.jpg');
    fs.writeFileSync(fp, Buffer.alloc(256));
    return fp;
  })(),
  durationSec: 0,
  text: '',
});
const matVideo = registerMaterial({
  type: 'upload_video',
  filePath: (() => {
    const fp = path.join(STORAGE_UPLOADS, 'vid1.mp4');
    fs.writeFileSync(fp, Buffer.alloc(1024));
    return fp;
  })(),
  durationSec: 6,
  text: '',
});

/** 等待任务到达终态（completed/failed） */
async function waitForSettled(taskId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = getCreationTask(taskId);
    if (t && (t.status === 'completed' || t.status === 'failed')) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`任务 ${taskId} 未在 ${timeoutMs}ms 内到达终态`);
}

function makeCutShots(n) {
  return Array.from({ length: n }, (_, i) => ({
    shotIndex: i + 1,
    line: `第${i + 1}镜台词`,
    sub_theme: `小标${i + 1}`,
    side_typo: '',
  }));
}

async function runTests() {
  console.log('========================================================');
  console.log('Jansee V2: 多版成片（批量赛马）契约测试');
  console.log('========================================================\n');

  // 1a. 不支持多版的类型直接拒绝
  await check('1a. speechcut / slicer 传 versions>1 直接 PARAM_INVALID 拒绝', async () => {
    for (const type of ['speechcut', 'slicer']) {
      let threw = null;
      try {
        createCreationTask({
          payload: { type, versions: 3, materialIds: [matVideo] },
          inMemoryTasks: new Map(),
          storageOutputsDir: STORAGE_OUTPUTS,
          storageUploadsDir: STORAGE_UPLOADS,
          materialsDir: TEMP_BASE,
        });
      } catch (e) {
        threw = e;
      }
      assert.ok(threw, `${type} 未拒绝多版请求`);
      assert.equal(threw.code, 40001, `${type} 应报 PARAM_INVALID(40001)，实际 ${threw.code}`);
    }
  });

  // 1b. storyboard provided 模式拒绝多版（用户自备台词无版本概念）
  await check('1b. storyboard provided 模式传 versions>1 拒绝', async () => {
    let threw = null;
    try {
      createCreationTask({
        payload: { type: 'storyboard', scriptMode: 'provided', versions: 2, materialIds: [matVideo] },
        inMemoryTasks: new Map(),
        storageOutputsDir: STORAGE_OUTPUTS,
        storageUploadsDir: STORAGE_UPLOADS,
        materialsDir: TEMP_BASE,
      });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, 'provided 模式未拒绝多版请求');
    assert.equal(threw.code, 40001);
  });

  // 2. 积分按版本数线性叠加
  await check('2. beforeCreateHook 积分 = 单价 × 版本数（image_creator ×3 = 600）', async () => {
    const captured = [];
    const hookResult = beforeCreateHook({
      payload: { type: 'image_creator', versions: 3 },
      user: { userId: 'u_batch' },
      taskId: 'crt_credit_test',
      deps: {
        creditStore: {
          consumeCredits: (args) => {
            captured.push(args);
            return { balance: 2850 - Number(args.amount), idempotent: false };
          },
        },
      },
    });
    assert.equal(hookResult.cost, 600);
    assert.equal(captured[0].amount, 600);
    assert.ok(String(captured[0].reason).includes('批量 3 条'), '扣费理由应注明批量条数');

    // 缺省 versions → 原价 200（单版零回归）
    const single = beforeCreateHook({
      payload: { type: 'image_creator' },
      user: { userId: 'u_single' },
      taskId: 'crt_credit_single',
      deps: {
        creditStore: { consumeCredits: (args) => ({ balance: 2850 - Number(args.amount), idempotent: false }) },
      },
    });
    assert.equal(single.cost, 200);
  });

  // 3. 批次编排：3 条全部成功
  await check('3. 批次 3 条全部成功：outputs.versions 交付 + renderTaskId/角度/版式互异', async () => {
    const inMemoryTasks = new Map();
    const produceCalls = [];
    const anglesSeen = [];

    const res = createCreationTask({
      payload: {
        type: 'image_creator',
        title: '多版测试商品',
        sellingPoints: '卖点',
        materialIds: [matImage],
        versions: 3,
      },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: TEMP_BASE,
      deps: {
        generateDirectorCut: async ({ variantAngle }) => {
          anglesSeen.push(variantAngle || '');
          return {
            shots: makeCutShots(2),
            bgm_emotion: 'warm',
            publish: { caption: 'cap', cover_title: '封面', pinned_comment: 'pin', post_time: 'time' },
          };
        },
        produceImageFilm: async ({ taskId: renderTaskId }) => {
          produceCalls.push(renderTaskId);
          return { videoSec: 12.5 };
        },
      },
    });

    assert.ok(res.taskId, '应返回 taskId');
    const task = await waitForSettled(res.taskId);

    assert.equal(task.status, 'completed', `批次应整批完成，实际 ${task.status} ${task.error?.message || ''}`);
    assert.equal(task.versions.length, 3);
    assert.equal(new Set(task.versions.map((v) => v.angle)).size, 3, '批次内钩子角度应互不相同');
    assert.equal(new Set(task.versions.map((v) => v.layoutId)).size, 3, '批次内版式应互不相同（N≤5）');
    assert.equal(new Set(produceCalls).size, 3, 'renderTaskId 应互不相同（seed 派生差异）');
    for (let i = 0; i < 3; i++) {
      assert.equal(produceCalls[i], `${res.taskId}_v${i + 1}`, `第 ${i + 1} 条 renderTaskId 应为 taskId_vN`);
    }
    // 批量路径必须注入差异化角度；单版路径不注入
    assert.ok(anglesSeen.every((a) => a && a.length > 0), '批次每条都应携带差异化角度');
    assert.equal(task.progress, 100);

    const versions = task.outputs?.versions;
    assert.ok(Array.isArray(versions) && versions.length === 3, 'outputs.versions 应交付 3 条');
    for (let i = 0; i < 3; i++) {
      assert.equal(versions[i].videoUrl, `/storage/outputs/${res.taskId}_v${i + 1}/final.mp4`);
      assert.equal(versions[i].duration, 12.5);
      assert.equal(versions[i].publish?.caption, 'cap', '每条版本应带独立发布四件套');
    }
    // 批量模式顶层不产单版 videoUrl（避免歧义双交付）
    assert.equal(task.outputs?.videoUrl || '', '', '批量模式顶层不应有单版 videoUrl');
  });

  // 4. 部分失败不拖垮整批
  await check('4. 批次 3 条中第 2 条失败：整批 completed，交付成功 2 条', async () => {
    const inMemoryTasks = new Map();
    const res = createCreationTask({
      payload: {
        type: 'image_creator',
        title: '部分失败',
        sellingPoints: '卖点',
        materialIds: [matImage],
        versions: 3,
      },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: TEMP_BASE,
      deps: {
        generateDirectorCut: async () => ({ shots: makeCutShots(1), publish: null }),
        produceImageFilm: async ({ taskId: renderTaskId }) => {
          if (renderTaskId.endsWith('_v2')) throw new Error('渲染炸了（模拟）');
          return { videoSec: 8 };
        },
      },
    });

    const task = await waitForSettled(res.taskId);
    assert.equal(task.status, 'completed', '≥1 条成功即整批 completed');
    assert.equal(task.versions.filter((v) => v.status === 'completed').length, 2);
    assert.equal(task.versions[1].status, 'failed');
    assert.ok(String(task.versions[1].error).includes('渲染炸了'), '失败条目应带错误信息');
    assert.equal(task.outputs.versions.length, 2, '只交付成功版本');
    assert.equal(task.outputs.versions.some((v) => v.videoUrl.includes('_v2')), false, '失败版本不得进交付物');
    assert.ok(String(task.stageText).includes('成功 2/3'), `stageText 应汇总批次结果，实际「${task.stageText}」`);
  });

  // 5. 全部失败 → 整批 failed
  await check('5. 批次 2 条全部失败：整批 failed 且带首条错误', async () => {
    const inMemoryTasks = new Map();
    const res = createCreationTask({
      payload: {
        type: 'image_creator',
        title: '全败',
        sellingPoints: '卖点',
        materialIds: [matImage],
        versions: 2,
      },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: TEMP_BASE,
      deps: {
        generateDirectorCut: async () => ({ shots: makeCutShots(1), publish: null }),
        produceImageFilm: async () => { throw new Error('全线崩溃（模拟）'); },
      },
    });

    const task = await waitForSettled(res.taskId);
    assert.equal(task.status, 'failed');
    assert.ok(String(task.error?.message || task.error || '').includes('全线崩溃'), '应透出首条失败原因');
  });

  // 6. 单版路径零回归
  await check('6. versions 缺省：任务不带批次字段，renderTaskId === taskId，prompt 无差异化注入', async () => {
    const inMemoryTasks = new Map();
    let passedTaskId = '';
    let seenAngle;
    const res = createCreationTask({
      payload: {
        type: 'image_creator',
        title: '单版回归',
        sellingPoints: '卖点',
        materialIds: [matImage],
      },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: TEMP_BASE,
      deps: {
        generateDirectorCut: async ({ variantAngle }) => {
          seenAngle = variantAngle;
          return { shots: makeCutShots(1), publish: null };
        },
        produceImageFilm: async ({ taskId: renderTaskId }) => {
          passedTaskId = renderTaskId;
          return { videoSec: 5 };
        },
      },
    });

    const task = await waitForSettled(res.taskId);
    assert.equal(task.status, 'completed');
    assert.equal(task.batch, undefined, '单版任务不应携带 batch 字段');
    assert.equal(task.versions, undefined, '单版任务不应携带 versions 字段');
    assert.equal(passedTaskId, res.taskId, '单版 renderTaskId 必须等于 taskId（seed/目录契约不变）');
    assert.equal(seenAngle, '', '单版路径角度必须为空串（不注入差异化指令，prompt 基线零变化）');
    assert.equal(task.outputs.videoUrl, `/storage/outputs/${res.taskId}/final.mp4`);
  });

  // 7. normalizeOutput 的 versions 白名单透传
  await check('7. normalizeOutput：versions 白名单透传 videoUrl/duration/publish', async () => {
    const out = normalizeOutput({
      versions: [
        { videoUrl: '/storage/outputs/t_v1/final.mp4', duration: 9.5, publish: { caption: 'c', _banned_hits: ['x'] } },
        { videoUrl: '/storage/outputs/t_v2/final.mp4', duration: 8, junk: '应被剥离' },
      ],
    }, 't');
    assert.equal(out.versions.length, 2);
    assert.equal(out.versions[0].videoUrl, '/storage/outputs/t_v1/final.mp4');
    assert.equal(out.versions[0].publish.caption, 'c');
    assert.equal(out.versions[0].publish._banned_hits, undefined, '_banned_hits 不得外泄');
    assert.equal(out.versions[1].junk, undefined, '非白名单字段不得透传');
    assert.equal(normalizeOutput({}).versions, undefined, '无版本时不造空数组');
  });

  // 8. 导演层 variantAngle 注入
  await check('8. buildDirectorPrompt：设 variantAngle 注入差异化指令，缺省不含', async () => {
    const withAngle = buildDirectorPrompt({
      scene: 'sell', title: 'T', sellingPoints: 'S', imageCount: 2, voice: 'female',
      variantAngle: '价格钩子（用价格/性价比反差直接开场）', variantIndex: 2, variantTotal: 3,
    });
    assert.ok(withAngle.includes('批量赛马差异化指令'), '应注入差异化指令块');
    assert.ok(withAngle.includes('价格钩子'), '应包含具体角度');
    assert.ok(withAngle.includes('2 条 / 共 3 条'), '应注明批次序号');

    const withoutAngle = buildDirectorPrompt({
      scene: 'sell', title: 'T', sellingPoints: 'S', imageCount: 2, voice: 'female',
    });
    assert.equal(withoutAngle.includes('批量赛马差异化指令'), false, '缺省时不得注入（基线零变化）');
  });

  // 汇总
  console.log('\n========================================================');
  console.log(`测试完成: ${PASS.length} PASS, ${FAIL.length} FAIL`);
  if (FAIL.length) {
    console.log('失败项:', FAIL.join(' | '));
    process.exit(1);
  }
}

runTests().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
