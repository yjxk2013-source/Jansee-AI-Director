import fs from 'node:fs';

// 自动计算当前日期的 Nginx 日志格式 (如 "08/Nov/2026")
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const defaultTodayStr = `${pad(now.getDate())}/${months[now.getMonth()]}/${now.getFullYear()}`;

// 支持命令行参数：node analyze-spiders.mjs [日期(例如 06/Nov/2026)] [日志路径]
const targetDateStr = process.argv[2] || defaultTodayStr;
const defaultLogPath = fs.existsSync('/var/log/nginx/access.log')
  ? '/var/log/nginx/access.log'
  : (process.env.NGINX_LOG_PATH || './access.log');
const logPath = process.argv[3] || defaultLogPath;

if (!fs.existsSync(logPath)) {
  console.log(`未找到日志文件: ${logPath}`);
  console.log('用法: node analyze-spiders.mjs [日期(默认当天, 如 08/Nov/2026)] [日志路径]');
  process.exit(1);
}

const lines = fs.readFileSync(logPath, 'utf8').split('\n');

// 爬虫识别规则与分类
const spiders = [
  { name: '百度蜘蛛 (Baiduspider)', pattern: /baiduspider/i },
  { name: '谷歌蜘蛛 (Googlebot)', pattern: /googlebot/i },
  { name: '微软必应 (Bingbot / BingPreview)', pattern: /bingbot|bingpreview|msnbot/i },
  { name: '字节跳动 (Bytespider)', pattern: /bytespider/i },
  { name: 'Meta / Facebook (externalhit)', pattern: /facebookexternalhit/i },
  { name: '搜狗蜘蛛 (Sogou spider)', pattern: /sogou/i },
  { name: '360蜘蛛 (360Spider)', pattern: /360spider/i },
  { name: '神马/宜搜 (YisouSpider)', pattern: /yisouspider/i },
  { name: 'OpenAI (GPTBot / ChatGPT-User)', pattern: /gptbot|chatgpt-user|oai-searchbot/i },
  { name: 'Anthropic (ClaudeBot)', pattern: /claudebot|anthropic/i },
  { name: 'Perplexity (PerplexityBot)', pattern: /perplexitybot/i },
  { name: '国内大模型 (DeepSeek/Kimi/腾讯/阿里)', pattern: /deepseek|moonshot|kimi|tencentbot|yuanbao|qwen/i },
  { name: '海外SEO工具爬虫 (Ahrefs/Semrush/DotBot)', pattern: /ahrefsbot|semrushbot|dotbot|petalbot/i }
];

const stats = {};
for (const s of spiders) {
  stats[s.name] = { count: 0, pages: {}, statusCodes: {}, firstTime: null, lastTime: null };
}

let totalSpiderHits = 0;
let todayTotalLines = 0;

// 动态构建匹配时间的正则
const escapedDateStr = targetDateStr.replace(/([.*+?^=!:${}()|[\]/\\])/g, '\\$1');
const timeRegex = new RegExp(`\\[${escapedDateStr}:(\\d{2}:\\d{2}:\\d{2})`);

for (const line of lines) {
  if (!line.includes(targetDateStr)) continue;
  todayTotalLines++;

  const timeMatch = line.match(timeRegex);
  const time = timeMatch ? timeMatch[1] : '';

  const statusMatch = line.match(/"\s+(\d{3})\s+/);
  const status = statusMatch ? statusMatch[1] : 'other';

  const reqMatch = line.match(/"(?:GET|POST|HEAD)\s+([^\s?]+)/);
  const uri = reqMatch ? reqMatch[1] : '-';

  for (const s of spiders) {
    if (s.pattern.test(line)) {
      const item = stats[s.name];
      item.count++;
      totalSpiderHits++;
      item.pages[uri] = (item.pages[uri] || 0) + 1;
      item.statusCodes[status] = (item.statusCodes[status] || 0) + 1;
      if (!item.firstTime) item.firstTime = time;
      item.lastTime = time;
      break;
    }
  }
}

console.log(`统计日期: ${targetDateStr}`);
console.log(`日志文件: ${logPath}`);
console.log(`该日 0点至今日志总请求行数: ${todayTotalLines}`);
console.log(`该日各大爬虫累计抓取次数: ${totalSpiderHits}`);
console.log('\n================ 各大爬虫详细来访统计 ================');

for (const [name, data] of Object.entries(stats)) {
  if (data.count > 0) {
    console.log(`\n【${name}】`);
    console.log(`- 抓取总频次: ${data.count} 次`);
    console.log(`- 来访时间跨度: ${data.firstTime} ~ ${data.lastTime}`);
    console.log(`- HTTP状态分布:`, JSON.stringify(data.statusCodes));
    console.log(`- 重点抓取路径:`, JSON.stringify(data.pages));
  }
}
