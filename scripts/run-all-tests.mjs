#!/usr/bin/env node
/**
 * 简兮 (JANSEE) · 全栈单元与集成测试自动化调度器 (scripts/run-all-tests.mjs)
 * 职责：
 *   1. 统一调度底层 packages、渲染 modules 与 BFF 网关的核心测试套件；
 *   2. 统计测试通过率、断言状态与耗时；
 *   3. 供根目录 `npm test` 一键调用，提供大厂级 CI 门禁验证入口。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

// 核心测试套件注册清单（覆盖中台基建、渲染引擎与网关业务核心）
const testSuites = [
  // 1. 底层共享与基建测试
  { name: 'composeGate 并发闸门限流与幂等防爆', path: 'packages/ffmpeg-kit/tests/composeGate.test.mjs' },
  { name: 'taskQueue 分布式任务队列引擎与并发调度', path: 'packages/ffmpeg-kit/tests/taskQueue.test.mjs' },
  { name: 'mp4Finalization udta 国标元数据注入与封装', path: 'packages/ffmpeg-kit/tests/mp4-finalization.test.mjs' },
  { name: 'autoQc 成片轻量级自动质检与防损坏守门员', path: 'packages/ffmpeg-kit/tests/autoQc.test.mjs' },
  { name: 'ending-kit 15款定稿片尾骨架与确定性种子', path: 'packages/ending-kit/tests/ending-kit.test.mjs' },
  { name: 'ending-tail 时间轴与国标尾标', path: 'packages/ending-kit/tests/ending-tail.test.mjs' },
  { name: 'intro-kit 电影级开场纯黑遮罩', path: 'packages/intro-kit/tests/intro.test.mjs' },
  { name: 'cover-kit 纯净宣发封面海报合成', path: 'packages/intro-kit/tests/cover.test.mjs' },
  { name: 'speech-cut 停顿气口消除与微距字幕', path: 'packages/speech-cut/tests/pause-cut.test.mjs' },
  { name: 'subtitle-kit 发丝级微距双行字幕渲染', path: 'packages/subtitle-kit/test-subtitle.test.mjs' },

  // 2. 视频与独立渲染引擎测试
  { name: 'visual_engine_v4 视觉资产与收束卡实物渲染', path: 'modules/visual_engine_v4/tests/ending-assets.test.mjs' },
  { name: 'video_creator 分镜成片核心调度', path: 'modules/video_creator/tests/storyboard/test-storyboard-core.mjs' },
  { name: 'video_creator 口播智能检测分析', path: 'modules/video_creator/tests/speechcut/test-detect.mjs' },

  // 3. BFF 网关业务与安全门禁测试
  { name: 'gateway/metrics 可观测性度量探针与延迟分位数', path: 'apps/web/server/tests/metrics/test-metrics.mjs' },
  { name: 'gateway/admin 后台防暴力破解与会话安全', path: 'apps/web/server/tests/admin/test-admin.mjs' },
  { name: 'gateway/billing 业务门禁与积分安全', path: 'apps/web/server/tests/billing/test-entry-guard.mjs' },
  { name: 'gateway/anchor 主播 DNA 与表达神经库', path: 'apps/web/server/tests/anchor/test-anchor-kit.mjs' },
  { name: 'gateway/creation 出片版本与历史记录流转', path: 'apps/web/server/tests/creation/test-creation-versions.mjs' },
  { name: 'gateway/storyboard 分镜导演极简调度', path: 'apps/web/server/tests/storyboard/test-slice-storyboard-simplify.mjs' },
];

console.log('='.repeat(70));
console.log('  简兮 (JANSEE) · 全工程核心测试套件门禁回归验证');
console.log(`  待跑套件数量: ${testSuites.length} 组核心业务与引擎测试`);
console.log('='.repeat(70));

const results = [];
const startTime = Date.now();

async function runTest(suite) {
  const fullPath = path.join(root, suite.path);
  const suiteStart = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fullPath], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      const duration = ((Date.now() - suiteStart) / 1000).toFixed(2);
      if (code === 0) {
        console.log(`  [ PASS ] (${duration}s) ${suite.name} -> ${suite.path}`);
        results.push({ name: suite.name, path: suite.path, pass: true, duration, stdout });
      } else {
        console.error(`  [ FAIL ] (${duration}s) ${suite.name} (退出码 ${code})`);
        if (stderr.trim()) console.error(`    错误输出:\n${stderr.trim().split('\n').map(l => '      ' + l).join('\n')}`);
        results.push({ name: suite.name, path: suite.path, pass: false, duration, stderr, stdout });
      }
      resolve();
    });
  });
}

async function main() {
  for (const suite of testSuites) {
    await runTest(suite);
  }

  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
  const passedCount = results.filter((r) => r.pass).length;
  const failedCount = results.filter((r) => !r.pass).length;

  console.log('='.repeat(70));
  console.log(`  测试回归汇总: 总数 ${testSuites.length} | 通过: ${passedCount} | 失败: ${failedCount} | 总耗时: ${totalDuration}s`);
  console.log('='.repeat(70));

  if (failedCount > 0) {
    console.error('\n❌ 存在失败测试套件，门禁拦截！');
    process.exit(1);
  } else {
    console.log('\n✅ 全量核心测试套件 100% 通过！工程健壮性符合企业级发布标准。');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('[FATAL] 测试运行器异常:', err);
  process.exit(1);
});

