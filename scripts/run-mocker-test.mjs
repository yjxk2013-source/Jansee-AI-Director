/**
 * 简兮 (JANSEE) · 全链路创作场景工作台 Mocker 自动化验收测试套件
 * 涵盖：三大场景 × 四大专版、导演剧本加载、TTS配音、FFmpeg混流、积分扣减、断点续传、风控边界
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../');

const BASE_URL = 'http://localhost:3000';

function postJson(url, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const bodyStr = JSON.stringify(data);
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw });
        }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'GET',
      headers
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function pollTaskUntilDone(taskId, maxPolls = 120, intervalMs = 800) {
  const timeline = [];
  let finalTask = null;


  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    const res = await getJson(`${BASE_URL}/api/v1/video/task/${taskId}`);
    const task = res.data?.data;
    if (task) {
      timeline.push({
        pollIndex: i + 1,
        progress: task.progress,
        stage: task.stage,
        stageText: task.stageText
      });
      if (task.status === 'completed' || task.progress >= 100) {
        finalTask = task;
        break;
      }
      if (task.status === 'failed') {
        finalTask = task;
        break;
      }
    }
  }
  return { finalTask, timeline };
}

async function runMockerSuite() {
  console.log('===============================================================');
  console.log('  简兮 (JANSEE) · 全链路创作场景工作台 Mocker 自动化验收套件');
  console.log('===============================================================');

  const report = {
    suiteStartTime: new Date().toISOString(),
    cases: [],
    summary: {
      total: 0,
      passed: 0,
      failed: 0
    }
  };

  // 1. 获取初始资产积分
  console.log('\n[准备阶段] 探测初始用户资产与算力配额...');
  const initialProfileRes = await getJson(`${BASE_URL}/api/v1/user/profile`);
  let prevCredits = initialProfileRes.data?.data?.credits || 0;
  console.log(`- 初始用户: ${initialProfileRes.data?.data?.userName} (${initialProfileRes.data?.data?.userId})`);
  console.log(`- 初始积分: ${prevCredits} 点`);

  // =========================================================================
  // 用例 1: 线上商家 · 图片成片 (sell + product)
  // =========================================================================
  {
    console.log('\n[CASE 1] 线上商家 · 图片成片 (sell + product)...');
    report.summary.total++;
    const caseResult = {
      id: 'CASE-01',
      name: '线上商家 · 图片成片出片全流程',
      scene: 'sell',
      mode: 'product',
      title: '瑞士机械镂空腕表'
    };

    const startTime = Date.now();
    const produceRes = await postJson(`${BASE_URL}/api/v1/video/produce`, {
      scene: 'sell',
      mode: 'product',
      title: '瑞士机械镂空腕表',
      description: '航空级钛合金机身，双弧面蓝宝石防刮镜面，50米深度防水，大厂精工品质限时特惠',
      imageCount: 3,
      voice: 'female'
    });

    const taskId = produceRes.data?.data?.taskId;
    const postCredits = produceRes.data?.data?.remainingCredits;
    console.log(`- 任务ID: ${taskId}`);
    console.log(`- 积分变动: ${prevCredits} -> ${postCredits} (扣除 200 积分: ${prevCredits - postCredits === 200})`);

    const { finalTask, timeline } = await pollTaskUntilDone(taskId);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`- 流水线耗时: ${duration}s, 最终状态: ${finalTask?.status}, 成片: ${finalTask?.videoUrl}`);

    // 验证剧本文件
    const taskDir = path.join(rootDir, 'storage/outputs', taskId);
    const scriptPath = path.join(taskDir, 'script.json');
    const hasScript = fs.existsSync(scriptPath);
    let scriptData = null;
    if (hasScript) {
      scriptData = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
    }

    const passed = produceRes.status === 200 &&
                   finalTask?.status === 'completed' &&
                   finalTask?.videoUrl &&
                   (prevCredits - postCredits === 200) &&
                   hasScript &&
                   scriptData?.shots?.length === 4;

    caseResult.passed = passed;
    caseResult.taskId = taskId;
    caseResult.duration = duration;
    caseResult.videoUrl = finalTask?.videoUrl;
    caseResult.creditBefore = prevCredits;
    caseResult.creditAfter = postCredits;
    caseResult.directorTitle = scriptData?.title;
    caseResult.directorEmotion = scriptData?.emotion;
    caseResult.shotsCount = scriptData?.shots?.length;
    caseResult.timeline = timeline;
    report.cases.push(caseResult);

    if (passed) report.summary.passed++; else report.summary.failed++;
    prevCredits = postCredits;
  }

  // =========================================================================
  // 用例 3: 线下门店 · 视频配音 (local + dub)
  // =========================================================================
  {
    console.log('\n[CASE 3] 线下门店 · 视频配音 (local + dub)...');
    report.summary.total++;
    const caseResult = {
      id: 'CASE-03',
      name: '线下门店 · 同城探店声学配音',
      scene: 'local',
      mode: 'dub',
      title: '原麦手作烘焙'
    };

    const startTime = Date.now();
    const produceRes = await postJson(`${BASE_URL}/api/v1/video/produce`, {
      scene: 'local',
      mode: 'dub',
      title: '原麦手作烘焙',
      description: '清晨第一炉现烤法式牛角包，麦香浓郁，本地朋友到店专享限时第二件半价福利',
      imageCount: 2,
      voice: 'male'
    });

    const taskId = produceRes.data?.data?.taskId;
    const postCredits = produceRes.data?.data?.remainingCredits;
    console.log(`- 任务ID: ${taskId}, 扣除积分: ${prevCredits - postCredits === 200}`);

    const { finalTask, timeline } = await pollTaskUntilDone(taskId);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`- 流水线耗时: ${duration}s, 最终状态: ${finalTask?.status}, 成片: ${finalTask?.videoUrl}`);

    const taskDir = path.join(rootDir, 'storage/outputs', taskId);
    const scriptPath = path.join(taskDir, 'script.json');
    let scriptData = null;
    if (fs.existsSync(scriptPath)) {
      scriptData = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
    }

    const validEmotions = ['本地推荐', '欢快', 'relax', 'happy', 'tech', 'hype', 'warm', 'rhythm'];
    const passed = produceRes.status === 200 &&
                   finalTask?.status === 'completed' &&
                   validEmotions.includes(scriptData?.emotion) &&
                   scriptData?.title.includes('同城探店');

    caseResult.passed = passed;
    caseResult.taskId = taskId;
    caseResult.duration = duration;
    caseResult.videoUrl = finalTask?.videoUrl;
    caseResult.directorTitle = scriptData?.title;
    caseResult.directorEmotion = scriptData?.emotion;
    caseResult.timeline = timeline;
    report.cases.push(caseResult);

    if (passed) report.summary.passed++; else report.summary.failed++;
    prevCredits = postCredits;
  }

  // =========================================================================
  // 用例 4: 个人创作 · 出镜口播 (personal + host)
  // =========================================================================
  {
    console.log('\n[CASE 4] 个人创作 · 出镜口播 (personal + host)...');
    report.summary.total++;
    const caseResult = {
      id: 'CASE-04',
      name: '个人创作 · 治愈生活口播大片',
      scene: 'personal',
      mode: 'host',
      title: '独居生活手记'
    };

    const startTime = Date.now();
    const produceRes = await postJson(`${BASE_URL}/api/v1/video/produce`, {
      scene: 'personal',
      mode: 'host',
      title: '独居生活手记',
      description: '下班后的自留地，煮一杯暖胃热红茶，在文字与胶片中重拾内心的宁静与笃定',
      imageCount: 1,
      voice: 'female'
    });

    const taskId = produceRes.data?.data?.taskId;
    const postCredits = produceRes.data?.data?.remainingCredits;
    console.log(`- 任务ID: ${taskId}, 扣除积分: ${prevCredits - postCredits === 200}`);

    const { finalTask, timeline } = await pollTaskUntilDone(taskId);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`- 流水线耗时: ${duration}s, 最终状态: ${finalTask?.status}, 成片: ${finalTask?.videoUrl}`);

    const taskDir = path.join(rootDir, 'storage/outputs', taskId);
    const scriptPath = path.join(taskDir, 'script.json');
    let scriptData = null;
    if (fs.existsSync(scriptPath)) {
      scriptData = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
    }

    const validLifeEmotions = ['平静叙事', '温馨', 'relax', 'warm', 'calm_narrative'];
    const passed = produceRes.status === 200 &&
                   finalTask?.status === 'completed' &&
                   validLifeEmotions.includes(scriptData?.emotion) &&
                   (scriptData?.title.includes('创意分享') || scriptData?.title.includes('创意生活') || scriptData?.title.includes('创意'));

    caseResult.passed = passed;
    caseResult.taskId = taskId;
    caseResult.duration = duration;
    caseResult.videoUrl = finalTask?.videoUrl;
    caseResult.directorTitle = scriptData?.title;
    caseResult.directorEmotion = scriptData?.emotion;
    caseResult.timeline = timeline;
    report.cases.push(caseResult);

    if (passed) report.summary.passed++; else report.summary.failed++;
    prevCredits = postCredits;
  }

  // =========================================================================
  // 用例 5: 线上商家 · 切片分镜 (sell + slice)
  // =========================================================================
  {
    console.log('\n[CASE 5] 线上商家 · 切片分镜 (sell + slice)...');
    report.summary.total++;
    const caseResult = {
      id: 'CASE-05',
      name: '线上商家 · 高转化切片分镜',
      scene: 'sell',
      mode: 'slice',
      title: '数码旗舰跑分实测'
    };

    const startTime = Date.now();
    const produceRes = await postJson(`${BASE_URL}/api/v1/video/produce`, {
      scene: 'sell',
      mode: 'slice',
      title: '数码旗舰跑分实测',
      description: '全核满载高帧率实测，温控表现出众，大厂精工品质保证，点击抢先出片',
      imageCount: 4,
      voice: 'male'
    });

    const taskId = produceRes.data?.data?.taskId;
    const postCredits = produceRes.data?.data?.remainingCredits;
    console.log(`- 任务ID: ${taskId}, 扣除积分: ${prevCredits - postCredits === 200}`);

    const { finalTask, timeline } = await pollTaskUntilDone(taskId);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`- 流水线耗时: ${duration}s, 最终状态: ${finalTask?.status}, 成片: ${finalTask?.videoUrl}`);

    const taskDir = path.join(rootDir, 'storage/outputs', taskId);
    const hasScript = fs.existsSync(path.join(taskDir, 'script.json'));

    const passed = produceRes.status === 200 && finalTask?.status === 'completed' && hasScript;
    caseResult.passed = passed;
    caseResult.taskId = taskId;
    caseResult.duration = duration;
    caseResult.videoUrl = finalTask?.videoUrl;
    caseResult.timeline = timeline;
    report.cases.push(caseResult);

    if (passed) report.summary.passed++; else report.summary.failed++;
    prevCredits = postCredits;
  }

  // =========================================================================
  // 用例 6: 风控边界与硬拦截验证 (Max 9 Images & Empty Fallback)
  // =========================================================================
  {
    console.log('\n[CASE 6] 风控边界与安全拦截...');
    report.summary.total += 2;

    // 6.1 超出 9 张图片硬拦截
    const overLimitRes = await postJson(`${BASE_URL}/api/v1/video/produce`, {
      scene: 'sell',
      mode: 'product',
      title: '超额测试',
      description: '测试上传 12 张图片是否触发风控',
      imageCount: 12
    });
    const testOverPassed = overLimitRes.status === 400 && overLimitRes.data?.code === 40001;
    console.log(`- 6.1 超出 9 张图片拦截: HTTP ${overLimitRes.status}, code=${overLimitRes.data?.code} (通过: ${testOverPassed})`);
    report.cases.push({
      id: 'CASE-06A',
      name: '商品实拍图 9 张上限风控硬拦截',
      status: overLimitRes.status,
      code: overLimitRes.data?.code,
      passed: testOverPassed
    });
    if (testOverPassed) report.summary.passed++; else report.summary.failed++;

    // 6.2 空描述保底测试
    const emptyDescRes = await postJson(`${BASE_URL}/api/v1/video/produce`, {
      scene: 'sell',
      mode: 'product',
      title: '',
      description: '',
      imageCount: 1
    });
    const taskIdEmpty = emptyDescRes.data?.data?.taskId;
    const { finalTask: emptyFinal } = await pollTaskUntilDone(taskIdEmpty);
    const testEmptyPassed = emptyDescRes.status === 200 && emptyFinal?.status === 'completed';
    console.log(`- 6.2 空描述自适应保底出片: status=${emptyFinal?.status} (通过: ${testEmptyPassed})`);
    report.cases.push({
      id: 'CASE-06B',
      name: '空文案/缺省参数大厂高转化保底出片',
      passed: testEmptyPassed,
      taskId: taskIdEmpty,
      videoUrl: emptyFinal?.videoUrl
    });
    if (testEmptyPassed) report.summary.passed++; else report.summary.failed++;
  }

  // =========================================================================
  // 用例 7: HTTP 206 Partial Content (Range) 断点续传与秒开
  // =========================================================================
  {
    console.log('\n[CASE 7] 视频流 HTTP 206 Partial Content Range 断点续传验证...');
    report.summary.total++;
    const testVideoCase = report.cases.find(c => c.videoUrl);
    let streamPassed = false;
    let rangeHeader = '';
    let contentType = '';

    if (testVideoCase && testVideoCase.videoUrl) {
      const res = await getJson(`${BASE_URL}${testVideoCase.videoUrl}`, {
        'Range': 'bytes=0-2048'
      });
      streamPassed = res.status === 206 && res.headers['content-range']?.startsWith('bytes 0-2048/');
      rangeHeader = res.headers['content-range'];
      contentType = res.headers['content-type'];
      console.log(`- HTTP 状态: ${res.status}`);
      console.log(`- Content-Range: ${rangeHeader}`);
      console.log(`- Content-Type: ${contentType}`);
      console.log(`- 206 续传断言通过: ${streamPassed}`);
    }

    report.cases.push({
      id: 'CASE-07',
      name: '1080P 成片视频 HTTP 206 断点续传与秒开流式分发',
      status: streamPassed ? 206 : 500,
      rangeHeader,
      contentType,
      passed: streamPassed
    });
    if (streamPassed) report.summary.passed++; else report.summary.failed++;
  }

  // =========================================================================
  // 用例 8: 静态代码与 0 Emoji / 幽灵边框规范扫描
  // =========================================================================
  {
    console.log('\n[CASE 8] 前台静态合规与 0 Emoji 静态审计...');
    report.summary.total++;
    const htmlPath = path.join(rootDir, 'apps/web/client/index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    const emojiRegex = /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F1E0}-\u{1F1FF}]/u;
    const hasEmoji = emojiRegex.test(htmlContent);

    const hasWorkbench = htmlContent.includes('id="matrix-workbench"');
    const hasTriggerRender = htmlContent.includes('async function triggerMatrixRender');
    const hasUserWorksDynamic = htmlContent.includes('window.renderUserWorksUI');
    const hasDeductPoints = htmlContent.includes('window.__deductPoints');

    const compliancePassed = !hasEmoji && hasWorkbench && hasTriggerRender && hasUserWorksDynamic && hasDeductPoints;
    console.log(`- 0 Emoji 铁律检测: ${!hasEmoji ? '无违规系统 Emoji' : '发现 Emoji'}`);
    console.log(`- 工作台与出片调度器完整性: ${compliancePassed}`);

    report.cases.push({
      id: 'CASE-08',
      name: '全站 0 Emoji 绝杀令与工作台动态闭环架构扫描',
      hasEmoji,
      hasWorkbench,
      hasTriggerRender,
      hasUserWorksDynamic,
      hasDeductPoints,
      passed: compliancePassed
    });
    if (compliancePassed) report.summary.passed++; else report.summary.failed++;
  }

  report.suiteEndTime = new Date().toISOString();

  console.log('\n===============================================================');
  console.log(`  MOCKER 测试完成: 总计 ${report.summary.total} 项, 通过: ${report.summary.passed}, 失败: ${report.summary.failed}`);
  console.log('===============================================================');

  const outJsonPath = path.join(rootDir, 'storage/mocker_test_results.json');
  fs.writeFileSync(outJsonPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`详细结构化测试日志已存盘: ${outJsonPath}`);
}

runMockerSuite().catch(err => {
  console.error('Mocker 测试运行失败:', err);
  process.exit(1);
});
