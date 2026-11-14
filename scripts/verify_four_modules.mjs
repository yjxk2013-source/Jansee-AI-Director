/**
 * 简兮 (JANSEE) · 生产环境全链路回归与四大版块深度测试套件
 * 运行目标: https://jansee.cn (线上真机真实网络调用)
 */

import fs from 'fs';
import path from 'path';

const BASE_URL = 'https://jansee.cn';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(method, endpoint, body = null, headers = {}) {
  await sleep(300); // 间隔 300ms，严格契合服务端滑动窗口安全限频
  const url = `${BASE_URL}${endpoint}`;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 JanseeAuditAgent/3.0',
      ...headers,
    },
  };
  if (body) {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  try {
    const res = await fetch(url, opts);
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await res.json().catch(() => null);
    } else {
      data = await res.text().catch(() => null);
    }
    return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers.entries()), data };
  } catch (err) {
    return { status: 0, ok: false, error: err.message };
  }
}

async function testHead(endpoint) {
  await sleep(200);
  const url = `${BASE_URL}${endpoint}`;
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers.entries()) };
  } catch (err) {
    return { status: 0, ok: false, error: err.message };
  }
}

console.log('================================================================');
console.log('  简兮 (JANSEE) · 生产环境四大版块与全链路深度质量检验');
console.log(`  实测目标: ${BASE_URL}`);
console.log('================================================================\n');

const results = {
  passed: 0,
  failed: 0,
  details: [],
};

function record(module, testName, passed, info) {
  if (passed) {
    results.passed++;
    console.log(`[PASS] [${module}] ${testName}: ${info}`);
  } else {
    results.failed++;
    console.log(`[FAIL] [${module}] ${testName}: ${info}`);
  }
  results.details.push({ module, testName, passed, info });
}

async function run() {
  // 1. 基准站点与客户端交付
  const pcPage = await fetchJson('GET', '/');
  record('门户基准', 'PC端门户入口 (/)', pcPage.status === 200, `HTTP ${pcPage.status}`);

  const mobilePage = await fetchJson('GET', '/mobile/index.html');
  record('门户基准', '移动端门户入口 (/mobile/index.html)', mobilePage.status === 200, `HTTP ${mobilePage.status}`);

  const apkHead = await testHead('/assets/app/jansee.apk');
  const apkLen = apkHead.headers['content-length'] ? (Number(apkHead.headers['content-length']) / 1024 / 1024).toFixed(2) + ' MB' : 'unknown';
  record('客户端交付', 'Android APK 真实文件存在性', apkHead.status === 200, `HTTP ${apkHead.status}, 大小: ${apkLen}`);

  // 2. 版块一：图片成片 (Image Film)
  const imgUpEmpty = await fetchJson('POST', '/api/v1/upload/images', {});
  record('版块1:图片成片', '图片批量上传防空校验', imgUpEmpty.status === 400, `HTTP ${imgUpEmpty.status}, msg: ${imgUpEmpty.data?.msg}`);

  const dummyImages = Array.from({ length: 10 }, () => `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==`);
  const imgUpOver9 = await fetchJson('POST', '/api/v1/upload/images', { images: dummyImages });
  record('版块1:图片成片', '9张实拍图上限硬拦截防御', imgUpOver9.status === 400, `HTTP ${imgUpOver9.status}, msg: ${imgUpOver9.data?.msg}`);

  const imgCreateNoAuth = await fetchJson('POST', '/api/v1/creation/create', { mode: 'product_video', title: '测试' });
  record('版块1:图片成片', '成片发起接口鉴权守门人 (未登录拦截)', imgCreateNoAuth.status === 401, `HTTP ${imgCreateNoAuth.status}`);

  const imgPoll = await fetchJson('GET', '/api/v1/creation/task/dummy-999');
  record('版块1:图片成片', '成片任务轮询通道规范性', imgPoll.status === 404, `HTTP ${imgPoll.status}`);

  // 3. 版块二：视频配音 (Video Dub)
  const vidUpEmpty = await fetchJson('POST', '/api/v1/upload/video', '');
  record('版块2:视频配音', '视频流上传空请求防御', vidUpEmpty.status === 400 || vidUpEmpty.status === 413, `HTTP ${vidUpEmpty.status}`);

  const vidCreateNoAuth = await fetchJson('POST', '/api/v1/creation/create', { mode: 'video_dub', prompt: '配音' });
  record('版块2:视频配音', '配音创作发起鉴权守门人', vidCreateNoAuth.status === 401, `HTTP ${vidCreateNoAuth.status}`);

  // 4. 版块三：出镜口播 (Speech Cut)
  const speechAnalyze = await fetchJson('POST', '/api/v1/speech/analyze', {});
  record('版块3:出镜口播', '口播视频语音分析入参防御', speechAnalyze.status === 400, `HTTP ${speechAnalyze.status}, msg: ${speechAnalyze.data?.msg}`);

  const speechProduceNoTask = await fetchJson('POST', '/api/v1/speech/produce', { taskId: 'dummy', videoUrl: 'test' });
  record('版块3:出镜口播', '口播合成任务有效性校验', speechProduceNoTask.status === 404, `HTTP ${speechProduceNoTask.status}, msg: ${speechProduceNoTask.data?.msg}`);

  const speechPoll = await fetchJson('GET', '/api/v1/video/task/dummy-999');
  record('版块3:出镜口播', '口播 ASR 轮询通道响应规范', speechPoll.status === 404, `HTTP ${speechPoll.status}`);

  // 5. 版块四：切片分镜 (Storyboard)
  const sbAnalyze = await fetchJson('POST', '/api/v1/storyboard/direct/analyze', {});
  record('版块4:切片分镜', '分镜直出分析入参防御', sbAnalyze.status === 400, `HTTP ${sbAnalyze.status}, msg: ${sbAnalyze.data?.msg}`);

  const sbProduce = await fetchJson('POST', '/api/v1/storyboard/direct/produce', { taskId: 'dummy' });
  record('版块4:切片分镜', '分镜直出合成入参校验', sbProduce.status === 400 || sbProduce.status === 404, `HTTP ${sbProduce.status}`);

  const sbAiCreate = await fetchJson('POST', '/api/v1/creation/create', { mode: 'storyboard_creator', prompt: '分镜' });
  record('版块4:切片分镜', '分镜AI配音创作鉴权守门人', sbAiCreate.status === 401, `HTTP ${sbAiCreate.status}`);

  // 6. 会员与加油包定价、支付与订单
  const pricingRes = await fetchJson('GET', '/api/v1/pricing');
  let pricingValid = false;
  let memberCount = 0;
  let packCount = 0;
  if (pricingRes.ok && pricingRes.data && pricingRes.data.data) {
    const data = pricingRes.data.data;
    memberCount = Array.isArray(data.members) ? data.members.length : 0;
    packCount = Array.isArray(data.boostPacks) ? data.boostPacks.length : 0;
    pricingValid = memberCount === 4 && packCount === 1;
  }
  record('会员定价联动', '后台定价动态生效接口 (/api/v1/pricing)', pricingValid, `HTTP ${pricingRes.status}, 会员套餐 ${memberCount} 档 (Lite/Plus/Pro/Ultra) + 加油包 ${packCount} 个`);

  const orderCreate = await fetchJson('POST', '/api/v1/order/create', { planId: 'pro' });
  record('支付收银链路', '订单创建鉴权守门人', orderCreate.status === 401, `HTTP ${orderCreate.status}`);

  const checkout = await fetchJson('POST', '/api/v1/order/jsapi/checkout', { orderId: 'dummy' });
  record('支付收银链路', 'JSAPI/WAP收银台拉起鉴权守门人', checkout.status === 401, `HTTP ${checkout.status}`);

  const status = await fetchJson('GET', '/api/v1/order/jsapi/status?orderId=dummy');
  record('支付收银链路', '订单状态轮询鉴权守门人', status.status === 401, `HTTP ${status.status}`);

  // 7. 静态代码审计与孤儿排查
  auditCodebase();

  console.log('\n================================================================');
  console.log(`  全链路质检总结: 成功 ${results.passed} 项, 失败 ${results.failed} 项`);
  console.log('================================================================');
}

function auditCodebase() {
  const mobilePath = path.resolve('apps/web/client/mobile/index.html');
  const pcPath = path.resolve('apps/web/client/index.html');

  // 移动端审计
  const mContent = fs.readFileSync(mobilePath, 'utf-8');
  const emojiRegex = /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
  const mEmoji = mContent.match(emojiRegex);
  record('移动端静态审计', '0 Emoji 绝杀令合规', !mEmoji, mEmoji ? `违规字符: ${mEmoji[0]}` : '100% 纯发丝细线与微型矢量SVG');

  // 移动端孤儿 DOM
  const mIdRegex = /document\.getElementById\(['"]([a-zA-Z0-9_\-]+)['"]\)/g;
  let mm;
  const mQueried = new Set();
  while ((mm = mIdRegex.exec(mContent)) !== null) {
    mQueried.add(mm[1]);
  }
  const mExisting = new Set();
  const mHtmlIdRegex = /id=['"]([a-zA-Z0-9_\-]+)['"]/g;
  while ((mm = mHtmlIdRegex.exec(mContent)) !== null) {
    mExisting.add(mm[1]);
  }
  const mMissing = [...mQueried].filter(id => !mExisting.has(id));
  record('移动端静态审计', '孤儿 DOM 引用排查', mMissing.length === 0, mMissing.length === 0 ? `共查验 ${mQueried.size} 个 DOM ID，0 孤儿` : `缺失: ${mMissing.join(',')}`);

  // 移动端支付拉起 (绝无 PC 扫码二维码)
  const mHasDirectPay = mContent.includes('window.location.href = payUrl');
  record('移动端静态审计', '移动端原生拉起支付宝支付 (非二维码)', mHasDirectPay, mHasDirectPay ? '100% window.location.href 物理拉起' : '缺失直跳逻辑');

  // 移动端客户端下载指引 (iOS 添加到主屏幕 / Android 下载 APK)
  const mHasIos = mContent.includes('install-view-ios') && mContent.includes('handleDownloadAppClick');
  const mHasApk = mContent.includes('/assets/app/jansee.apk');
  record('移动端静态审计', '客户端自适应下载引导 (iOS/Android)', mHasIos && mHasApk, `iOS引导DOM与逻辑: ${mHasIos}, APK物理包链接: ${mHasApk}`);

  // PC 端审计
  const pcContent = fs.readFileSync(pcPath, 'utf-8');
  const pcEmoji = pcContent.match(emojiRegex);
  record('PC端静态审计', '0 Emoji 绝杀令合规', !pcEmoji, pcEmoji ? `违规字符: ${pcEmoji[0]}` : '100% 纯发丝细线与微型矢量SVG');

  const pcHasQrPay = pcContent.includes('renderCashierQr') || pcContent.includes('cashier-qr') || pcContent.includes('openCashierModal');
  record('PC端静态审计', 'PC端聚合扫码收银台', pcHasQrPay, pcHasQrPay ? '具备 PC 专属二维码扫码收银模态框' : '缺失');
}

run();
