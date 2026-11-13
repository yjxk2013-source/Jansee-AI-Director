import fs from 'node:fs';

const INDEXNOW_KEY = 'a09973087e744f96be3981dae9c4a1c0';
const HOST = 'jansee.cn';
const KEY_LOCATION = `https://${HOST}/${INDEXNOW_KEY}.txt`;

const urlList = [
  `https://${HOST}/`,
  `https://${HOST}/faq.html`,
  `https://${HOST}/download.html`,
  `https://${HOST}/guides/index.html`,
  `https://${HOST}/guides/auto-video-tools.html`,
  `https://${HOST}/guides/turn-materials-into-video.html`,
  `https://${HOST}/guides/product-video-marketing.html`,
  `https://${HOST}/guides/store-short-video-marketing.html`,
  `https://${HOST}/guides/solo-creator-video.html`,
  `https://${HOST}/guides/video-production-efficiency.html`,
  `https://${HOST}/features.html`,
  `https://${HOST}/solutions.html`,
  `https://${HOST}/brand-identity.html`,
  `https://${HOST}/about-jansee.html`
];

const payload = {
  host: HOST,
  key: INDEXNOW_KEY,
  keyLocation: KEY_LOCATION,
  urlList: urlList
};

async function submitIndexNow(endpoint, name) {
  console.log(`[IndexNow] 正在向 ${name} (${endpoint}) 提交 ${urlList.length} 个页面...`);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(payload)
    });

    console.log(`[IndexNow] ${name} 响应 HTTP 状态码: ${res.status}`);
    const text = await res.text();
    if (res.status === 200 || res.status === 202) {
      console.log(`  🎉 ${name} 接收成功！(HTTP ${res.status}) 页面已进入秒级抓取队列！`);
    } else {
      console.log(`  ⚠️ 响应内容: ${text}`);
    }
  } catch (err) {
    console.error(`  ❌ ${name} 请求失败:`, err.message);
  }
}

async function main() {
  // 同时向 Bing IndexNow 官方端点和通用 IndexNow 官方端点双通道提交
  await submitIndexNow('https://www.bing.com/indexnow', '微软必应 (Bing IndexNow)');
  await submitIndexNow('https://api.indexnow.org/indexnow', 'IndexNow 联合中心 (支持多引擎)');
}

main();

