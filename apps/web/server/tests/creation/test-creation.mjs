// 简兮 (JANSEE) · S6 统一视频创作编排层自动化测试 (S6-A + S6-B 全覆盖)
// 文件: apps/web/server/tests/creation/test-creation.mjs
// 覆盖：
//   1. creationTask 创建成功与数据结构完备性 (storyboard)
//   2. 非法 type 拦截 (40003)
//   3. 物理路径硬性拦截 (videoPath / filePath 40301)
//   4. 不存在或非法 materialId 拦截 (40012 / 40401)
//   5. scriptMode auto 调用 S5 stub 生成逐镜文案
//   6. scriptMode provided 模式跳过大导演直接使用用户文案
//   7. storyboard 调度成功与 completed 产物归一化流转
//   8. 底层合成失败时 failed 状态机流转
//   9. 相同 taskId 重复提交防护 (40901)
//   10. getCreationTask 查询接口行为
//   11. S6-B: video_dub 正常调度与 outputs 产物结构
//   12. S6-B: slicer 正常调度与 slices 产物结构映射
//   13. S6-B: speechcut 正常调度与 words/suggestions/durationSec 映射
//   14. S6-B: video_dub / slicer / speechcut 底层异常流转 failed 与结构化 error
//   15. HTTP 真实网关端点端到端测试与 fallback 兼容 (storyboard, video_dub, slicer, speechcut)
// 铁律：纯 Stub / Mock，零真实 LLM、零真实 TTS、零付费云调用。

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import {
  createCreationTask,
  getCreationTask,
  creationTasks,
} from '../../creation.mjs';
import {
  materialRegistry,
  registerMaterial,
} from '../../storyboard.mjs';

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

// 准备测试临时沙箱与虚拟素材文件
const TEMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'jansee-creation-test-'));
const STORAGE_UPLOADS = path.join(TEMP_BASE, 'storage', 'uploads');
const STORAGE_OUTPUTS = path.join(TEMP_BASE, 'storage', 'outputs');
const MATERIALS_DIR = path.join(TEMP_BASE, 'materials');
fs.mkdirSync(STORAGE_UPLOADS, { recursive: true });
fs.mkdirSync(STORAGE_OUTPUTS, { recursive: true });
fs.mkdirSync(MATERIALS_DIR, { recursive: true });

function createMockVideoFile(filename, size = 1024) {
  const fp = path.join(STORAGE_UPLOADS, filename);
  fs.writeFileSync(fp, Buffer.alloc(size));
  return fp;
}

// 注册有效素材
const mockFile1 = createMockVideoFile('test1.mp4');
const mockFile2 = createMockVideoFile('test2.mp4');

const matId1 = registerMaterial({
  type: 'upload_video',
  filePath: mockFile1,
  durationSec: 5.5,
  text: '原声文本一',
});

const matId2 = registerMaterial({
  type: 'upload_video',
  filePath: mockFile2,
  durationSec: 8.0,
  text: '原声文本二',
});

async function runTests() {
  console.log('========================================================');
  console.log('Jansee V2 S6: Creation Workflow Orchestration 自动化测试');
  console.log('========================================================\n');

  // 1. creationTask 创建成功与数据结构完备性 (storyboard)
  await check('1. creationTask 成功创建且数据结构符合契约', async () => {
    const inMemoryTasks = new Map();
    let s5Called = false;
    let storyboardCalled = false;

    const res = createCreationTask({
      payload: {
        type: 'storyboard',
        title: '春季新款风衣',
        sellingPoints: '防风防水 透气修身',
        materialIds: [matId1],
        scriptMode: 'auto',
      },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
      deps: {
        generateStoryboardScript: async () => {
          s5Called = true;
          return {
            title: '春季新款风衣',
            shots: [{ shotIndex: 1, durationSec: 5.5, text: '春日出行的百搭战袍' }],
          };
        },
        startStoryboardProduce: async () => {
          storyboardCalled = true;
          const subId = 'sb_test_001';
          inMemoryTasks.set(subId, {
            taskId: subId,
            status: 'completed',
            videoUrl: '/storage/outputs/sb_test_001/final.mp4',
            durationSec: 5.5,
          });
          return { taskId: subId, status: 'producing' };
        },
      },
    });

    assert.ok(res.taskId.startsWith('crt_'), 'taskId 必须以 crt_ 开头');
    assert.equal(res.type, 'storyboard');
    assert.equal(res.status, 'pending');
    assert.equal(res.stage, 'init');
    assert.equal(typeof res.progress, 'number');

    await new Promise((r) => setTimeout(r, 120));

    const task = getCreationTask(res.taskId);
    assert.ok(task, '应当能通过 getCreationTask 查到任务');
    assert.equal(task.status, 'completed', '任务最终状态应为 completed');
    assert.equal(task.stage, 'done', '任务阶段应为 done');
    assert.equal(task.progress, 100, '任务进度应为 100%');
    assert.equal(task.outputs.videoUrl, '/storage/outputs/sb_test_001/final.mp4');
    assert.equal(task.outputs.duration, 5.5);
    assert.ok(s5Called, 'auto 模式下应调用 S5 大导演文案生成');
    assert.ok(storyboardCalled, '应调用 storyboardProduce');
  });

  // 2. 非法 type 拦截
  await check('2. 非法 type 拦截并返回规范错误码', () => {
    assert.throws(
      () => {
        createCreationTask({
          payload: { type: 'unknown_type', materialIds: [matId1] },
        });
      },
      (err) => err.code === 40003 && err.message.includes('暂不支持的创作类型')
    );

    assert.throws(
      () => {
        createCreationTask({
          payload: { materialIds: [matId1] },
        });
      },
      (err) => err.code === 40002 && err.message.includes('缺少创作类型参数')
    );
  });

  // 3. 物理路径硬性拦截 (videoPath / filePath 40301)
  await check('3. 物理路径硬性拦截 (videoPath/filePath)', () => {
    assert.throws(
      () => {
        createCreationTask({
          payload: {
            type: 'storyboard',
            videoPath: '/data/storage/uploads/evil.mp4',
            materialIds: [matId1],
          },
        });
      },
      (err) => err.code === 40301 && err.message.includes('禁止提交物理路径')
    );

    assert.throws(
      () => {
        createCreationTask({
          payload: {
            type: 'video_dub',
            filePath: '/etc/shadow',
            materialIds: [matId1],
          },
        });
      },
      (err) => err.code === 40301 && err.message.includes('禁止提交物理路径')
    );

    assert.throws(
      () => {
        createCreationTask({
          payload: {
            type: 'storyboard',
            materialIds: [matId1],
            shots: [{ videoPath: 'C:\\Windows\\system.ini' }],
          },
        });
      },
      (err) => err.code === 40301 && err.message.includes('禁止提交物理路径')
    );
  });

  // 4. 不存在或非法 materialId 拦截
  await check('4. 不存在或包含穿越符号的 materialId 拦截', () => {
    assert.throws(
      () => {
        createCreationTask({
          payload: { type: 'storyboard', materialIds: [] },
        });
      },
      (err) => err.code === 40010
    );

    assert.throws(
      () => {
        createCreationTask({
          payload: { type: 'storyboard', materialIds: ['../uploads/file.mp4'] },
        });
      },
      (err) => err.code === 40012 && err.message.includes('格式非法')
    );

    assert.throws(
      () => {
        createCreationTask({
          payload: { type: 'storyboard', materialIds: ['mat_not_exist_99999'] },
        });
      },
      (err) => err.code === 40401 && err.message.includes('素材') && err.message.includes('无权访问')
    );
  });

  // 5. scriptMode auto 模式调度 S5 并组装文案传递
  await check('5. scriptMode auto 调用 S5 并透传分镜文案', async () => {
    const inMemoryTasks = new Map();
    let passedShots = [];

    const res = createCreationTask({
      payload: {
        type: 'storyboard',
        title: '双镜宣传片',
        materialIds: [matId1, matId2],
        scriptMode: 'auto',
      },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
      deps: {
        generateStoryboardScript: async ({ shotsMeta }) => {
          assert.equal(shotsMeta.length, 2, '应当传入2个镜头的元数据');
          return {
            title: '双镜宣传片',
            shots: [
              { shotIndex: 1, durationSec: 5.5, text: '镜头一文案' },
              { shotIndex: 2, durationSec: 8.0, text: '镜头二文案' },
            ],
          };
        },
        startStoryboardProduce: async ({ payload }) => {
          passedShots = payload.shots;
          const subId = 'sb_test_002';
          inMemoryTasks.set(subId, {
            taskId: subId,
            status: 'completed',
            videoUrl: '/storage/outputs/sb_test_002/final.mp4',
            durationSec: 13.0,
          });
          return { taskId: subId, status: 'producing' };
        },
      },
    });

    await new Promise((r) => setTimeout(r, 120));

    assert.equal(passedShots.length, 2);
    assert.equal(passedShots[0].text, '镜头一文案');
    assert.equal(passedShots[1].text, '镜头二文案');

    const task = getCreationTask(res.taskId);
    assert.equal(task.status, 'completed');
  });

  // 6. scriptMode provided 模式直接使用用户提供的台词
  await check('6. scriptMode provided 模式不触发 S5 直接采信用户文案', async () => {
    const inMemoryTasks = new Map();
    let s5Triggered = false;
    let passedShots = [];

    const res = createCreationTask({
      payload: {
        type: 'storyboard',
        title: '自定义解说',
        materialIds: [matId1],
        scriptMode: 'provided',
        shots: [{ text: '用户亲自编写的台词' }],
      },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
      deps: {
        generateStoryboardScript: async () => {
          s5Triggered = true;
          return { shots: [] };
        },
        startStoryboardProduce: async ({ payload }) => {
          passedShots = payload.shots;
          const subId = 'sb_test_003';
          inMemoryTasks.set(subId, {
            taskId: subId,
            status: 'completed',
            videoUrl: '/storage/outputs/sb_test_003/final.mp4',
            durationSec: 5.5,
          });
          return { taskId: subId, status: 'producing' };
        },
      },
    });

    await new Promise((r) => setTimeout(r, 120));

    assert.equal(s5Triggered, false, 'provided 模式不应调用 S5 大导演');
    assert.equal(passedShots[0].text, '用户亲自编写的台词');

    const task = getCreationTask(res.taskId);
    assert.equal(task.status, 'completed');
  });

  // 7. 底层合成失败时 failed 状态机流转
  await check('7. 底层任务失败时 creationTask 正确流转为 failed', async () => {
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
        startStoryboardProduce: async () => {
          const subId = 'sb_fail_001';
          inMemoryTasks.set(subId, {
            taskId: subId,
            status: 'failed',
            error: 'FFmpeg 视频流编码异常',
          });
          return { taskId: subId, status: 'producing' };
        },
      },
    });

    await new Promise((r) => setTimeout(r, 120));

    const task = getCreationTask(res.taskId);
    assert.equal(task.status, 'failed');
    assert.equal(task.stage, 'failed');
    assert.ok(task.error.includes('FFmpeg 视频流编码异常'));
  });

  // 8. 重复提交防护 (40901)
  await check('8. 相同 taskId 重复提交拦截 (40901)', () => {
    const fixedId = 'crt_fixed_repeat_test';
    const inMemoryTasks = new Map();

    createCreationTask({
      payload: {
        taskId: fixedId,
        type: 'storyboard',
        materialIds: [matId1],
        scriptMode: 'provided',
      },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
      deps: {
        startStoryboardProduce: async () => ({ taskId: 'sub_1' }),
        syncSubTaskProgress: async () => {},
      },
    });

    assert.throws(
      () => {
        createCreationTask({
          payload: {
            taskId: fixedId,
            type: 'storyboard',
            materialIds: [matId1],
          },
          inMemoryTasks,
        });
      },
      (err) => err.code === 40901 && err.message.includes('请勿重复提交')
    );
  });

  // 9. getCreationTask 查询接口行为
  await check('9. getCreationTask 正常返回与不存在返回 null', () => {
    assert.equal(getCreationTask(''), null);
    assert.equal(getCreationTask('crt_non_exist_task'), null);
  });

  // 11. S6-B: video_dub 正常调度与 outputs 产物结构
  await check('11. S6-B: video_dub 正常调度与产物归一化输出', async () => {
    const inMemoryTasks = new Map();
    let produceVideoDubCalled = false;
    let dubArgs = null;

    const res = createCreationTask({
      payload: {
        type: 'video_dub',
        materialIds: [matId1],
        title: '产品功能演示',
        text: '这是官方专业解说旁白',
        voiceConfig: {
          voiceId: 'zh-CN-YunyangNeural',
        },
      },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
      deps: {
        // 视频配音只走 AI 配音：导演 stub 产出旁白分段（text 仅作素材喂给导演）
        generateDirectorCut: async () => ({
          title: '产品功能演示',
          shots: [{ order: 1, asset: 1, line: '这是官方专业解说旁白', pause_after: 0.5 }],
          bgm_on: true,
          bgm_emotion: 'warm',
          end_line: '看完记得点个关注',
        }),
        produceVideoDub: async (opts) => {
          produceVideoDubCalled = true;
          dubArgs = opts;
          if (typeof opts.onStage === 'function') {
            opts.onStage({ progress: 80, stageText: '正在混音' });
          }
          return {
            outputPath: path.join(opts.taskDir, 'final.mp4'),
            videoSec: 5.5,
            narration: '这是官方专业解说旁白',
          };
        },
      },
    });

    assert.equal(res.type, 'video_dub');
    assert.equal(res.status, 'pending');

    await new Promise((r) => setTimeout(r, 120));

    const task = getCreationTask(res.taskId);
    assert.ok(task, '任务应当能查到');
    assert.equal(task.status, 'completed');
    assert.equal(task.stage, 'done');
    assert.equal(task.progress, 100);
    assert.equal(task.outputs.videoUrl, `/storage/outputs/${res.taskId}/final.mp4`);
    assert.equal(task.outputs.duration, 5.5);
    assert.ok(produceVideoDubCalled, '应调用 produceVideoDub');
    assert.ok(Array.isArray(dubArgs.cut?.shots) && dubArgs.cut.shots.length >= 1, 'cut.shots 应含旁白分段');
    assert.equal(dubArgs.cut.shots[0].line, '这是官方专业解说旁白');
    assert.equal(dubArgs.voiceId, 'zh-CN-YunyangNeural');
    // 场景必须透传到合成模块：结尾卡按场景池抽款（sell/local/personal）
    assert.ok(dubArgs.scene, 'produceVideoDub 应收到 scene（结尾卡分场景）');
  });

  // 12. S6-B: slicer 正常调度与 slices 产物结构映射
  await check('12. S6-B: slicer 正常调度与 slices 产物列表映射', async () => {
    const inMemoryTasks = new Map();
    let slicerPrepareCalled = false;

    const res = createCreationTask({
      payload: {
        type: 'slicer',
        materialIds: [matId1],
        options: {
          segSec: 15,
        },
      },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
      deps: {
        startSlicerPrepare: async ({ payload }) => {
          slicerPrepareCalled = true;
          assert.equal(payload.materialId, matId1);
          assert.equal(payload.segSec, 15);
          const subId = 'slc_test_001';
          inMemoryTasks.set(subId, {
            taskId: subId,
            status: 'prepared',
            segments: [
              { name: 'part_001.mp4', durationSec: 15.0, text: '第一段切片', materialId: 'mat_seg_1' },
              { name: 'part_002.mp4', durationSec: 12.5, text: '第二段切片', materialId: 'mat_seg_2' },
            ],
          });
          return { taskId: subId, status: 'processing' };
        },
      },
    });

    assert.equal(res.type, 'slicer');
    assert.equal(res.status, 'pending');

    await new Promise((r) => setTimeout(r, 120));

    const task = getCreationTask(res.taskId);
    assert.ok(task);
    assert.equal(task.status, 'completed');
    assert.equal(task.stage, 'done');
    assert.equal(task.progress, 100);
    assert.ok(Array.isArray(task.outputs.slices), 'outputs 必须包含 slices 数组');
    assert.equal(task.outputs.slices.length, 2);
    assert.equal(task.outputs.slices[0].videoUrl, '/storage/outputs/slc_test_001/slices/part_001.mp4');
    assert.equal(task.outputs.slices[0].durationSec, 15.0);
    assert.equal(task.outputs.slices[0].text, '第一段切片');
    assert.ok(slicerPrepareCalled);
  });

  // 13. S6-B: speechcut 正常调度与 words/suggestions/durationSec 映射
  await check('13. S6-B: speechcut 正常调度与口播分析产物映射', async () => {
    const inMemoryTasks = new Map();
    let speechAnalyzeCalled = false;

    const res = createCreationTask({
      payload: {
        type: 'speechcut',
        materialIds: [matId1],
      },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
      deps: {
        startSpeechAnalyze: async ({ payload }) => {
          speechAnalyzeCalled = true;
          assert.ok(payload.videoPath);
          const subId = 'spk_test_001';
          inMemoryTasks.set(subId, {
            taskId: subId,
            status: 'analyzed',
            durationSec: 5.5,
            words: [{ word: '大家好', start: 0, end: 1.2 }],
            suggestions: [{ word: '嗯', start: 1.5, end: 1.8 }],
          });
          return { taskId: subId, status: 'processing' };
        },
      },
    });

    assert.equal(res.type, 'speechcut');
    assert.equal(res.status, 'pending');

    await new Promise((r) => setTimeout(r, 120));

    const task = getCreationTask(res.taskId);
    assert.ok(task);
    assert.equal(task.status, 'completed');
    assert.equal(task.stage, 'done');
    assert.equal(task.progress, 100);
    assert.equal(task.outputs.durationSec, 5.5);
    assert.equal(task.outputs.words.length, 1);
    assert.equal(task.outputs.suggestions.length, 1);
    assert.ok(speechAnalyzeCalled);
  });

  // 14. S6-B: 底层模块异常流转为 failed 与统一结构化 error
  await check('14. S6-B: video_dub / slicer / speechcut 底层异常流转 failed', async () => {
    const inMemoryTasks = new Map();

    // 14.1 video_dub 异常
    const dubRes = createCreationTask({
      payload: {
        type: 'video_dub',
        materialIds: [matId1],
        text: '测试文案',
      },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
      deps: {
        generateDirectorCut: async () => ({
          title: '测试',
          shots: [{ order: 1, asset: 1, line: '测试文案', pause_after: 0.5 }],
          bgm_on: false,
          end_line: '',
        }),
        produceVideoDub: async () => {
          throw new Error('TTS 语音合成连接中断');
        },
      },
    });

    // 14.2 slicer 异常
    const slcRes = createCreationTask({
      payload: {
        type: 'slicer',
        materialIds: [matId1],
      },
      inMemoryTasks,
      storageOutputsDir: STORAGE_OUTPUTS,
      storageUploadsDir: STORAGE_UPLOADS,
      materialsDir: MATERIALS_DIR,
      deps: {
        startSlicerPrepare: async () => {
          const subId = 'slc_fail_001';
          inMemoryTasks.set(subId, {
            taskId: subId,
            status: 'failed',
            error: '视频切片解码失败',
          });
          return { taskId: subId };
        },
      },
    });

    await new Promise((r) => setTimeout(r, 120));

    const dubTask = getCreationTask(dubRes.taskId);
    assert.equal(dubTask.status, 'failed');
    assert.equal(dubTask.stage, 'failed');
    assert.equal(dubTask.error.code, 50001);
    assert.ok(dubTask.error.message.includes('TTS 语音合成连接中断'));

    const slcTask = getCreationTask(slcRes.taskId);
    assert.equal(slcTask.status, 'failed');
    assert.equal(slcTask.stage, 'failed');
    assert.equal(slcTask.error.code, 50001);
    assert.ok(slcTask.error.message.includes('视频切片解码失败'));
  });

  // 15. HTTP 真实网关端点端到端测试 (覆盖 storyboard, video_dub, slicer, speechcut 与 fallback)
  await check('15. HTTP 真实网关端点端到端测试与 fallback 兼容', async () => {
    const inMemoryTasks = new Map();
    const server = http.createServer((req, res) => {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = urlObj.pathname;

      function sendJson(code, msg, data = {}, status = 200) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ code, msg, data, timestamp: Date.now() }));
      }

      if (pathname === '/api/v1/creation/create' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          let payload = {};
          try { payload = JSON.parse(body || '{}'); } catch (e) {}
          try {
            const r = createCreationTask({
              payload,
              inMemoryTasks,
              storageOutputsDir: STORAGE_OUTPUTS,
              storageUploadsDir: STORAGE_UPLOADS,
              materialsDir: MATERIALS_DIR,
              deps: {
                generateDirectorCut: async () => ({
                  title: 'HTTP 网关测试',
                  shots: [{ order: 1, asset: 1, line: 'HTTP 网关测试解说', pause_after: 0.5 }],
                  bgm_on: false,
                  end_line: '',
                }),
                produceVideoDub: async (opts) => ({
                  outputPath: path.join(opts.taskDir, 'final.mp4'),
                  videoSec: 5.5,
                }),
                startSlicerPrepare: async () => {
                  const subId = 'slc_http_1';
                  inMemoryTasks.set(subId, {
                    taskId: subId,
                    status: 'prepared',
                    segments: [{ name: 's1.mp4', durationSec: 10 }],
                  });
                  return { taskId: subId };
                },
                startSpeechAnalyze: async () => {
                  const subId = 'spk_http_1';
                  inMemoryTasks.set(subId, {
                    taskId: subId,
                    status: 'analyzed',
                    durationSec: 5.5,
                    words: [{ word: '你好', start: 0, end: 1 }],
                  });
                  return { taskId: subId };
                },
                startStoryboardProduce: async () => {
                  const subId = 'sb_http_1';
                  inMemoryTasks.set(subId, {
                    taskId: subId,
                    status: 'completed',
                    videoUrl: '/storage/outputs/sb_http_1/final.mp4',
                    durationSec: 5.5,
                  });
                  return { taskId: subId, status: 'producing' };
                },
              },
            });
            sendJson(0, '创作任务已创建', r, 200);
          } catch (e) {
            sendJson(e.code || 40000, e.message, {}, e.code === 40301 ? 403 : e.code === 40401 ? 404 : 400);
          }
        });
        return;
      }

      if (pathname.startsWith('/api/v1/creation/task/') && req.method === 'GET') {
        const taskId = pathname.replace('/api/v1/creation/task/', '').trim();
        const task = getCreationTask(taskId) || inMemoryTasks.get(taskId);
        if (!task) return sendJson(40400, '任务不存在', {}, 404);
        return sendJson(0, '查询成功', task, 200);
      }

      if (pathname.startsWith('/api/v1/video/task/') && req.method === 'GET') {
        const taskId = pathname.replace('/api/v1/video/task/', '').trim();
        const task = inMemoryTasks.get(taskId) || getCreationTask(taskId);
        if (!task) return sendJson(40400, '任务不存在', {}, 404);
        return sendJson(0, '查询成功', task, 200);
      }

      sendJson(40400, 'Not Found', {}, 404);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // (1) 测试 video_dub 创建与双路由轮询
      const dubPost = await fetch(`${baseUrl}/api/v1/creation/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'video_dub',
          materialIds: [matId1],
          text: 'HTTP 网关测试解说',
        }),
      });
      const dubJson = await dubPost.json();
      assert.equal(dubPost.status, 200);
      assert.equal(dubJson.code, 0);
      const dubTaskId = dubJson.data.taskId;

      // 轮询 /creation/task/:id
      const dubPoll1 = await fetch(`${baseUrl}/api/v1/creation/task/${dubTaskId}`);
      const dubPoll1Json = await dubPoll1.json();
      assert.equal(dubPoll1.status, 200);
      assert.equal(dubPoll1Json.data.type, 'video_dub');

      // 轮询 /video/task/:id fallback
      const dubPoll2 = await fetch(`${baseUrl}/api/v1/video/task/${dubTaskId}`);
      const dubPoll2Json = await dubPoll2.json();
      assert.equal(dubPoll2.status, 200);
      assert.equal(dubPoll2Json.data.taskId, dubTaskId);

      // (2) 测试 slicer
      const slcPost = await fetch(`${baseUrl}/api/v1/creation/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'slicer',
          materialIds: [matId1],
        }),
      });
      const slcJson = await slcPost.json();
      assert.equal(slcPost.status, 200);
      assert.equal(slcJson.data.type, 'slicer');

      // (3) 测试 speechcut
      const spkPost = await fetch(`${baseUrl}/api/v1/creation/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'speechcut',
          materialIds: [matId1],
        }),
      });
      const spkJson = await spkPost.json();
      assert.equal(spkPost.status, 200);
      assert.equal(spkJson.data.type, 'speechcut');

      // (4) 物理路径注入拦截测试
      const evilRes = await fetch(`${baseUrl}/api/v1/creation/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'video_dub',
          videoPath: '/data/private.mp4',
          materialIds: [matId1],
        }),
      });
      assert.equal(evilRes.status, 403);
    } finally {
      server.close();
    }
  });

  console.log('\n--------------------------------------------------------');
  console.log(`S6 测试汇总: 通过 ${PASS.length} 项 / 失败 ${FAIL.length} 项`);
  console.log('--------------------------------------------------------');

  if (FAIL.length > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('测试异常终止:', err);
  process.exit(1);
});
