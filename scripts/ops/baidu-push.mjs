import fs from 'node:fs';

const BAIDU_API_URL = process.env.BAIDU_PUSH_API || 'http://data.zz.baidu.com/urls?site=https://jansee.cn&token=b1kB6iKtGZs7fM9X';

// 按重要性优先级排列全站页面
const allCandidateUrls = [
  'https://jansee.cn/',
  'https://jansee.cn/faq.html',
  'https://jansee.cn/guides/index.html',
  'https://jansee.cn/guides/auto-video-tools.html',
  'https://jansee.cn/guides/turn-materials-into-video.html',
  'https://jansee.cn/guides/product-video-marketing.html',
  'https://jansee.cn/guides/store-short-video-marketing.html',
  'https://jansee.cn/guides/solo-creator-video.html',
  'https://jansee.cn/guides/video-production-efficiency.html',
  'https://jansee.cn/features.html',
  'https://jansee.cn/solutions.html',
  'https://jansee.cn/brand-identity.html',
  'https://jansee.cn/about-jansee.html'
];

async function pushUrlList(urls) {
  const res = await fetch(BAIDU_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'User-Agent': 'curl/7.68.0' },
    body: urls.join('\n')
  });
  return res.json();
}

async function smartPush() {
  console.log('[百度直推] 开始智能配额推送...');

  // 先逐条推送优先级最高但尚未推送的页面，自动适应百度配额
  let successCount = 0;
  let remainingQuota = 0;

  for (let i = 0; i < allCandidateUrls.length; i++) {
    const url = allCandidateUrls[i];
    try {
      const result = await pushUrlList([url]);
      if (result.success) {
        successCount += result.success;
        remainingQuota = result.remain;
        console.log(`  ✅ [${i + 1}/${allCandidateUrls.length}] 成功直推: ${url} (剩余配额: ${remainingQuota})`);
        if (remainingQuota <= 0) {
          console.log('\n⚠️ 当日百度 API 配额已全部用满（已成功推送当天允许的最大数量）。');
          break;
        }
      } else if (result.error === 400 && result.message === 'over quota') {
        console.log(`\n⚠️ 当日配额已耗尽，已停止后续推送。`);
        break;
      } else {
        console.warn(`  ⚠️ 推送提示: ${JSON.stringify(result)}`);
      }
    } catch (e) {
      console.error(`  ❌ 网络错误: ${url}`, e.message);
    }
  }

  console.log(`\n🎉 本轮直推完成！今日累计直推成功 ${successCount} 个核心页面，剩余可用配额: ${remainingQuota}`);
}

smartPush();
