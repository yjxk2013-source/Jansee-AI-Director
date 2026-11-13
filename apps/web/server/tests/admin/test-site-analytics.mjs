import assert from 'node:assert/strict';
import {
  recordSiteAnalytics,
  getSiteAnalytics,
  recordAdminIp,
  resetSiteAnalytics,
  isBotUserAgent
} from '../../siteAnalytics.mjs';

console.log('=== 开始执行 siteAnalytics 真人统计防护自动化测试 ===');

// 1. 爬虫 UA 拦截测试
assert.equal(isBotUserAgent('Sogou web spider/4.0'), true, '搜狗蜘蛛应被识别');
assert.equal(isBotUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true, 'Googlebot 应被识别');
assert.equal(isBotUserAgent('Mozilla/5.0 (Linux; Android 10; HD1900) ... aweme_230400 ...'), true, '抖音内嵌预览应被识别');
assert.equal(isBotUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36'), false, '桌面浏览器格式通过初筛');
console.log('✓ 1. 爬虫与平台内嵌抓取器 UA 识别测试通过');

// 2. 清空并重置测试基准
resetSiteAnalytics();
const emptyStats = getSiteAnalytics(7);
assert.equal(emptyStats.today.uv, 0, '重置后今日 UV 应为 0');
assert.equal(emptyStats.today.pv, 0, '重置后今日 PV 应为 0');
console.log('✓ 2. 统计数据原子重置与清零通过');

// 3. 仿冒浏览器但无真人交互行为（无 verifiedBy 或裸发）
const fakeBotHeaders = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  'x-real-ip': '221.237.156.99' // 四川电信公网 IP
};
const resNoVerify = recordSiteAnalytics({
  visitorId: 'test_fake_visitor_001',
  event: 'pageview',
  path: '/brand-identity.html'
}, fakeBotHeaders);
assert.equal(resNoVerify.accepted, false, '缺少真人交互凭据必须拒绝');
assert.equal(resNoVerify.reason, 'unverified_human_action');
console.log('✓ 3. 无交互爬虫直接被拦截（unverified_human_action）通过');

// 4. 伪造 dwell 停留但时间不足 3.5 秒
const resQuickDwell = recordSiteAnalytics({
  visitorId: 'test_fake_visitor_002',
  event: 'pageview',
  path: '/',
  verifiedBy: 'dwell_4s',
  dwellMs: 500
}, fakeBotHeaders);
assert.equal(resQuickDwell.accepted, false, '停留时间不足必须拒绝');
assert.equal(resQuickDwell.reason, 'insufficient_dwell_time');
console.log('✓ 4. 虚假停留时间拦截（insufficient_dwell_time）通过');

// 5. 真实人类访问（通过真实滑动 scroll 触发）
const resRealHuman1 = recordSiteAnalytics({
  visitorId: 'real_human_visitor_001',
  event: 'pageview',
  path: '/',
  verifiedBy: 'scroll',
  dwellMs: 1200
}, fakeBotHeaders);
assert.equal(resRealHuman1.accepted, true, '真实用户滑动应当被接收');

// 6. 真实人类访问（通过专注阅读 4 秒触发）
const resRealHuman2 = recordSiteAnalytics({
  visitorId: 'real_human_visitor_002',
  event: 'pageview',
  path: '/features.html',
  verifiedBy: 'dwell_4s',
  dwellMs: 4120
}, {
  'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  'x-real-ip': '112.224.65.88' // 山东联通公网 IP
});
assert.equal(resRealHuman2.accepted, true, '真实用户专注阅读 4 秒应当被接收');

const statsAfterTwoHumans = getSiteAnalytics(7);
assert.equal(statsAfterTwoHumans.today.uv, 2, '两名真人访客 UV 应为 2');
assert.equal(statsAfterTwoHumans.today.pv, 2, '两名真人访客 PV 应为 2');
console.log('✓ 5 & 6. 真实人类访客（滑动与阅读）正常计入测试通过');

// 7. 管理员动态 IP 免疫测试
const adminIp = '218.89.233.111';
recordAdminIp(adminIp);
const resAdminVisit = recordSiteAnalytics({
  visitorId: 'admin_test_session_999',
  event: 'pageview',
  path: '/',
  verifiedBy: 'click',
  dwellMs: 2500
}, {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
  'x-real-ip': adminIp
});
assert.equal(resAdminVisit.accepted, false, '管理员 IP 访问前台必须被豁免');
assert.equal(resAdminVisit.reason, 'network_ignored');
console.log('✓ 7. 管理员动态出口 IP 自动免疫豁免测试通过');

// 8. 海外真实访客准入测试（不设国界阻断，海外跨境卖家通过交互正常计入）
const resOverseasHuman = recordSiteAnalytics({
  visitorId: 'real_human_overseas_001',
  event: 'pageview',
  path: '/solutions.html',
  verifiedBy: 'mousemove',
  dwellMs: 2300
}, {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'x-real-ip': '8.8.8.8' // 美国 IP
});
assert.equal(resOverseasHuman.accepted, true, '海外真实人类通过交互验证必须正常计入统计');
console.log('✓ 8. 海外真实访客准入测试通过（全球无地域歧视，仅看真人交互）');

// 清理测试数据，恢复干净状态
resetSiteAnalytics();
console.log('====================================================');
console.log('🎉 所有真人访问防护测试 100% 验证通过！');
console.log('====================================================');
process.exit(0);

