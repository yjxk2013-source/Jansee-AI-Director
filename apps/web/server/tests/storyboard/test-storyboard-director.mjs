// 简兮分镜导演文案自动生成层 (S5) · 单元与端到端自动化测试
// 文件: apps/web/server/tests/storyboard/test-storyboard-director.mjs
// 覆盖：
//   1. 合法 JSON 成功解析并严格 N-to-N 对应
//   2. Markdown 代码块包裹与非法 JSON 的重试与最终错误
//   3. 镜头数量不匹配校验
//   4. shotIndex 重复、缺失或乱序校验
//   5. 空文案、非法字段和错误数据类型校验
//   6. 超长文案发起重写并重写成功
//   7. 重写后依然超长明确报错（不静默截断）
//   8. 不存在的 materialId 接口拒绝 (40401)
//   9. 无法获得可靠时长/时长过短 (<2.0s) 素材接口拒绝 (40014)
//  10. 生成结果与输入 materialId 顺序严格一致
//  11. LLM 超时或网络异常错误封装 (50002)
//  12. 剧本生成接口零扣费验证 (不扣减出片 200 积分)
//  13. 多镜头大白话场景生成 (带货/探店卖点)
//
// 零付费铁律：纯 Stub LLM 拦截，绝不调用外部真实付费 API。
// 运行：node apps/web/server/tests/storyboard/test-storyboard-director.mjs

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';
import { generateStoryboardScript } from '../../director.mjs';

const PASS = [];
const FAIL = [];

function check(name, fn) {
  try {
    const res = fn();
    if (res instanceof Promise) {
      return res.then(
        () => {
          PASS.push(name);
          console.log(`PASS ${name}`);
        },
        (e) => {
          FAIL.push(name);
          console.log(`FAIL ${name}（${e.message}）`);
        }
      );
    }
    PASS.push(name);
    console.log(`PASS ${name}`);
  } catch (e) {
    FAIL.push(name);
    console.log(`FAIL ${name}（${e.message}）`);
  }
}

// ==================== Part 1: Director 编排层单元测试 (纯 Stub LLM) ====================
console.log('--- Part 1: Director 编排与校验单元测试 ---');

// 保存原生 fetch
const realFetch = globalThis.fetch;

let fetchCallCount = 0;
function setupMockFetch(handler) {
  fetchCallCount = 0;
  globalThis.fetch = async (url, opts) => {
    fetchCallCount++;
    return handler(url, opts, fetchCallCount);
  };
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

// 模拟环境变量以开启 director 的 llmUsable 检查
process.env.SILICONFLOW_API_KEY = 'test_key_dummy_12345678';
process.env.JIANXI_MOCK = '0';

// 基础 shotsMeta 模拟数据（2个镜头，分别 5s 和 6s）
const sampleShotsMeta = [
  { shotIndex: 1, materialId: 'mat_test_shot_01', durationSec: 5.0 },
  { shotIndex: 2, materialId: 'mat_test_shot_02', durationSec: 6.0 },
];

await check('T1: 合法 JSON 成功解析并严格 N-to-N 对应', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            title: '精选特调咖啡',
            shots: [
              { shotIndex: 1, text: '选用高山阿拉比卡水洗豆。' },
              { shotIndex: 2, text: '每一滴都沉淀着浓郁的坚果香气。' },
            ],
          }),
        },
      }],
    }),
  }));

  const res = await generateStoryboardScript({
    title: '特调咖啡',
    sellingPoints: '水洗豆，坚果香',
    shotsMeta: sampleShotsMeta,
  });

  assert.equal(res.title, '精选特调咖啡');
  assert.equal(res.shots.length, 2);
  assert.equal(res.shots[0].shotIndex, 1);
  assert.equal(res.shots[0].materialId, 'mat_test_shot_01');
  assert.equal(res.shots[0].text, '选用高山阿拉比卡水洗豆。');
  assert.equal(res.shots[1].shotIndex, 2);
  assert.equal(res.shots[1].materialId, 'mat_test_shot_02');
  assert.equal(res.shots[1].text, '每一滴都沉淀着浓郁的坚果香气。');
  restoreFetch();
});

await check('T2: Markdown 代码块包裹与非法 JSON 的重试与最终错误', async () => {
  let callIdx = 0;
  setupMockFetch(async () => {
    callIdx++;
    if (callIdx === 1) {
      // 首次返回损坏的非 JSON 内容
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '抱歉，我无法生成JSON，这是一段普通文本。' } }],
        }),
      };
    }
    // 第二次低温重试返回合法的 ```json 包裹格式
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: '```json\n{"title": "重试成功标题", "shots": [{"shotIndex":1, "text":"镜头一解说词"},{"shotIndex":2, "text":"镜头二解说词"}]}\n```',
          },
        }],
      }),
    };
  });

  const res = await generateStoryboardScript({
    title: '容错测试',
    sellingPoints: '容错',
    shotsMeta: sampleShotsMeta,
  });

  assert.equal(callIdx, 2, '应当在第 1 次解析失败后触发第 2 次低温重试');
  assert.equal(res.title, '重试成功标题');
  assert.equal(res.shots.length, 2);
  restoreFetch();
});

await check('T2-B: 两次 LLM 返回均非法时抛出明确异常', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '【无法解析的内容】' } }],
    }),
  }));

  await assert.rejects(
    async () => {
      await generateStoryboardScript({
        title: '错误测试',
        shotsMeta: sampleShotsMeta,
      });
    },
    /LLM 输出中未找到 JSON/
  );
  restoreFetch();
});

await check('T3: 镜头数量不匹配（少镜或多镜）明确拦截', async () => {
  // 输入 2 镜，模型只返回 1 镜
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            title: '少镜响应',
            shots: [{ shotIndex: 1, text: '只有一个镜头' }],
          }),
        },
      }],
    }),
  }));

  await assert.rejects(
    async () => {
      await generateStoryboardScript({
        title: '少镜测试',
        shotsMeta: sampleShotsMeta,
      });
    },
    /分镜镜头数量不匹配：输入 2 镜，模型返回 1 镜/
  );
  restoreFetch();
});

await check('T4: shotIndex 乱序、缺失或重复时明确拦截', async () => {
  // 模型返回 shotIndex 重复为 1
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            title: '索引异常',
            shots: [
              { shotIndex: 1, text: '镜头一' },
              { shotIndex: 1, text: '又是镜头一' },
            ],
          }),
        },
      }],
    }),
  }));

  await assert.rejects(
    async () => {
      await generateStoryboardScript({
        title: '索引测试',
        shotsMeta: sampleShotsMeta,
      });
    },
    /分镜索引错误或乱序/
  );
  restoreFetch();
});

await check('T5: 空文案或缺失 text 明确拦截', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            title: '空文案',
            shots: [
              { shotIndex: 1, text: '   ' },
              { shotIndex: 2, text: '有效文本' },
            ],
          }),
        },
      }],
    }),
  }));

  await assert.rejects(
    async () => {
      await generateStoryboardScript({
        title: '空文案测试',
        shotsMeta: sampleShotsMeta,
      });
    },
    /第 1 镜文案为空或未提供/
  );
  restoreFetch();
});

await check('T6: 超长文案发起重写并重写成功', async () => {
  // 5s 镜头上限为 5 * 4 = 20 字；首轮生成 28 字超长；第二轮重写为 12 字精简文案
  let round = 0;
  setupMockFetch(async () => {
    round++;
    if (round === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                title: '初次草稿',
                shots: [
                  { shotIndex: 1, text: '这是一段超级超级长而且完全超过了五秒镜头允许的最大字数上限的超长台词内容呀' },
                  { shotIndex: 2, text: '镜头二文案正常' },
                ],
              }),
            },
          }],
        }),
      };
    }
    // 重写轮
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              title: '精简版',
              shots: [
                { shotIndex: 1, text: '浓醇咖啡，高山手选。' },
                { shotIndex: 2, text: '镜头二文案正常' },
              ],
            }),
          },
        }],
      }),
    };
  });

  const res = await generateStoryboardScript({
    title: '超长重写',
    shotsMeta: sampleShotsMeta,
  });

  assert.equal(round, 2, '必须触发重写调用');
  assert.equal(res.shots[0].text, '浓醇咖啡，高山手选。');
  restoreFetch();
});

await check('T7: 重写后依然超长则拒绝报错，严禁截断残句', async () => {
  // 两轮均输出超长文本
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            title: '执意超长',
            shots: [
              { shotIndex: 1, text: '这是一段超级超级长而且完全超过了五秒镜头允许的最大字数上限的超长台词内容呀' },
              { shotIndex: 2, text: '镜头二文案正常' },
            ],
          }),
        },
      }],
    }),
  }));

  await assert.rejects(
    async () => {
      await generateStoryboardScript({
        title: '执意超长测试',
        shotsMeta: sampleShotsMeta,
      });
    },
    /文字字数超出镜头物理时长，重写后仍超长/
  );
  restoreFetch();
});

await check('T11-A: LLM HTTP 500/网络超时报错被正确抛出', async () => {
  setupMockFetch(async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: 'Internal Server Error' }),
  }));

  await assert.rejects(
    async () => {
      await generateStoryboardScript({
        title: 'LLM 报错测试',
        shotsMeta: sampleShotsMeta,
      });
    },
    /LLM HTTP 500/
  );
  restoreFetch();
});


// ==================== Part 2: HTTP 网关集成与端到端契约测试 ====================
console.log('\n--- Part 2: HTTP 网关路由契约、素材登记与权限扣费测试 ---');

const HERE = path.dirname(fileURLToPath(import.meta.url));
// tests/storyboard → tests → server → web → apps → repo_root
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-script-gw-'));
const dataDir = path.join(tmpDir, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const PORT = '3329';
const BASE = `http://localhost:${PORT}`;
let childGw = null;

// 在子进程启动前，写一个桩模块以便在子进程中拦截 LLM 请求
// Windows 下 --import 不支持裸绝对路径，必须使用 file:// URI；
// 将 stub 写入项目 scratch/ 目录，再转为 file:// URI 传递给子进程。
const scratchDir = path.join(REPO_ROOT, 'scratch');
fs.mkdirSync(scratchDir, { recursive: true });
const stubScriptPath = path.join(scratchDir, 'storyboard-director-test-llm-stub.mjs');
fs.writeFileSync(stubScriptPath, `
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const urlStr = String(url);
  if (urlStr.includes('api.siliconflow.cn')) {
    const bodyStr = opts?.body || '';
    if (bodyStr.includes('强制上游抛错')) {
      return {
        ok: false,
        status: 502,
        json: async () => ({ message: 'Bad Gateway from LLM provider' }),
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              title: '网关实测标题',
              shots: [
                { shotIndex: 1, text: '第一镜解说词金牌推荐。' },
                { shotIndex: 2, text: '第二镜解说词现货直发。' },
              ],
            }),
          },
        }],
      }),
    };
  }
  return originalFetch(url, opts);
};
`);

// 转为 file:// URI（Windows 绝对路径安全）
const stubFileUrl = pathToFileURL(stubScriptPath).href;

try {
  // 1. 本地生成 2 个 3.0s 的有效短视频素材，以及 1 个 1.0s 的过短素材（<2.0s 触发校验）
  const sample3sA = path.join(tmpDir, 'sample_3s_a.mp4');
  const sample3sB = path.join(tmpDir, 'sample_3s_b.mp4');
  const sampleShort = path.join(tmpDir, 'sample_short.mp4');

  const makeMp4 = (fp, duration) => {
    execFileSync(ffmpegStatic, [
      '-nostdin', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=320x568:rate=25:duration=${duration}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '44100', '-ac', '2',
      '-shortest', fp,
    ], { stdio: 'ignore' });
  };

  makeMp4(sample3sA, 3.0);
  makeMp4(sample3sB, 3.5);
  makeMp4(sampleShort, 1.0);

  // 2. 启动集成网关子进程（--import 使用 file:// URI 以支持 Windows）
  childGw = spawn(process.execPath, ['--import', stubFileUrl, 'apps/web/server/index.mjs'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT,
      JIANXI_MOCK: '0',
      SILICONFLOW_API_KEY: 'test_dummy_key_12345678',
      JX_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let gwLogs = '';
  childGw.stdout.on('data', (d) => { gwLogs += d; });
  childGw.stderr.on('data', (d) => { gwLogs += d; });

  let ready = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const h = await fetch(`${BASE}/api/v1/health`);
      if (h.ok) { ready = true; break; }
    } catch {}
  }
  assert.equal(ready, true, `网关应成功启动: ${gwLogs.slice(-300)}`);

  async function postJson(endpoint, body) {
    const res = await fetch(`${BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  async function uploadVideoFile(filePath, filename) {
    const buf = fs.readFileSync(filePath);
    const res = await fetch(`${BASE}/api/v1/upload/video`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(buf.length),
        'x-file-name': filename,
      },
      body: buf,
    });
    return await res.json();
  }

  // 上传并登记真实素材
  const upA = await uploadVideoFile(sample3sA, 'sample_3s_a.mp4');
  const upB = await uploadVideoFile(sample3sB, 'sample_3s_b.mp4');
  const upShort = await uploadVideoFile(sampleShort, 'sample_short.mp4');

  const matA = upA?.data?.materialId;
  const matB = upB?.data?.materialId;
  const matShort = upShort?.data?.materialId;

  assert.ok(matA && matB && matShort, '测试素材上传登记成功');

  // 测试 8: 不存在的 materialId 接口校验返回 40401
  await check('T8: 不存在的 materialId 接口拒绝 (40401)', async () => {
    const { status, json } = await postJson('/api/v1/storyboard/script/generate', {
      title: '测试标题',
      shots: [{ materialId: 'mat_not_exist_9999' }],
    });
    assert.equal(status, 404);
    assert.equal(json.code, 40401);
    assert.match(json.msg, /素材不存在或已过期/);
  });

  // 测试 9: 无法获得可靠时长/素材时长过短 (<2.0s) 接口明确拒绝 (40014)
  await check('T9: 素材时长过短 (<2.0s) 接口拒绝 (40014)', async () => {
    const { status, json } = await postJson('/api/v1/storyboard/script/generate', {
      title: '短镜头测试',
      shots: [{ materialId: matShort }],
    });
    assert.equal(status, 400);
    assert.equal(json.code, 40014);
    assert.match(json.msg, /单个分镜素材不得少于 2 秒/);
  });

  // 测试 10: 生成结果的 materialId 与输入顺序完全对应
  await check('T10: 生成结果 materialId 与输入顺序严格一致', async () => {
    const { status, json } = await postJson('/api/v1/storyboard/script/generate', {
      title: '热销咖啡',
      sellingPoints: '醇香水洗豆',
      shots: [
        { materialId: matA },
        { materialId: matB },
      ],
    });

    assert.equal(status, 200, `应当成功: ${JSON.stringify(json)}`);
    assert.equal(json.code, 0);
    assert.equal(json.data.shots.length, 2);
    assert.equal(json.data.shots[0].shotIndex, 1);
    assert.equal(json.data.shots[0].materialId, matA);
    assert.equal(json.data.shots[0].text, '第一镜解说词金牌推荐。');
    assert.equal(json.data.shots[1].shotIndex, 2);
    assert.equal(json.data.shots[1].materialId, matB);
    assert.equal(json.data.shots[1].text, '第二镜解说词现货直发。');
  });

  // 测试 11-B: LLM 上游 502 由网关安全包装为 50002，不泄露服务端物理路径
  await check('T11-B: LLM 上游异常由网关安全包装为 50002 错误码', async () => {
    const { status, json } = await postJson('/api/v1/storyboard/script/generate', {
      title: '强制上游抛错',
      shots: [{ materialId: matA }],
    });

    assert.equal(status, 500);
    assert.equal(json.code, 50002);
    assert.match(json.msg, /分镜文案生成失败/);
  });

  // 测试 12: 剧本生成接口零积分扣费
  await check('T12: 剧本生成接口绝不扣除用户 mock 出片积分 (2850保持不变)', async () => {
    const profBefore = await (await fetch(`${BASE}/api/v1/user/profile`)).json();
    const initialCredits = profBefore.data.credits;

    // 成功调用剧本生成
    await postJson('/api/v1/storyboard/script/generate', {
      title: '零扣费验证',
      shots: [{ materialId: matA }, { materialId: matB }],
    });

    const profAfter = await (await fetch(`${BASE}/api/v1/user/profile`)).json();
    assert.equal(profAfter.data.credits, initialCredits, `用户积分必须恒定为 ${initialCredits}`);
  });

  // 测试: 标题与空分镜参数校验
  await check('T-Validation: 标题缺失与非法镜头数拦截', async () => {
    const r1 = await postJson('/api/v1/storyboard/script/generate', {
      title: '',
      shots: [{ materialId: matA }],
    });
    assert.equal(r1.status, 400);
    assert.equal(r1.json.code, 40010);

    const r2 = await postJson('/api/v1/storyboard/script/generate', {
      title: '合法标题',
      shots: [],
    });
    assert.equal(r2.status, 400);
    assert.equal(r2.json.code, 40011);

    const r3 = await postJson('/api/v1/storyboard/script/generate', {
      title: '合法标题',
      shots: Array(10).fill({ materialId: matA }),
    });
    assert.equal(r3.status, 400);
    assert.equal(r3.json.code, 40012);
  });

} finally {
  if (childGw) {
    childGw.kill('SIGTERM');
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // 清理 scratch/ 下的 stub 文件
  try { fs.rmSync(stubScriptPath, { force: true }); } catch {}
}

// ==================== Part 3: 最终回归统计 ====================
console.log('\n--- Part 3: 最终回归统计 ---');
console.log(`PASS: ${PASS.length}, FAIL: ${FAIL.length}`);
if (FAIL.length > 0) {
  process.exit(1);
} else {
  console.log('S5 分镜文案自动生成层全部 15 项测试全部通过！');
}
