// 简兮官网访问统计：只保存匿名访客哈希与聚合指标，不保存原始 IP、完整 UA 或完整来源 URL。
import { createHash } from 'node:crypto';
import { IP2Region } from 'ip2region/node';
import { dataFile, readJson, writeJsonAtomic } from './dataStore.mjs';

const FILE = dataFile('site-analytics.json');
const RETENTION_DAYS = 90;
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

// 离线双栈数据库只在进程启动时加载一次；查询仅在内存中处理 IP，不写入统计文件。
let regionDb = null;
try {
  regionDb = new IP2Region({ families: [4, 6], mappedIPv6: 'ipv4' });
  console.log('[JANSEE ANALYTICS] 离线 IP 地理数据库已加载（IPv4 + IPv6）');
} catch (error) {
  console.warn('[JANSEE ANALYTICS] 离线 IP 地理数据库加载失败，地域统计暂不可用:', error.message);
}

// 内存中维护已识别的管理员动态出口 IP（有效期 24 小时，无持久化侵入）
const ADMIN_IPS = new Map();

/** 记录管理员当前公网出口 IP，动态豁免前台统计 */
export function recordAdminIp(ip) {
  const value = String(ip || '').trim();
  if (!value) return;
  ADMIN_IPS.set(value, Date.now() + 24 * 60 * 60 * 1000);
}

function dayKey(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const pick = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function readDb() {
  const db = readJson(FILE, { version: 1, days: {}, active: {} });
  if (!db || typeof db !== 'object' || !db.days || !db.active) {
    return { version: 1, days: {}, active: {} };
  }
  return db;
}

function hashVisitorId(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function safePath(value) {
  try {
    const pathname = new URL(String(value || '/'), 'https://jansee.cn').pathname;
    if (!pathname.startsWith('/') || pathname.startsWith('/api/') || pathname.startsWith('/admin')) return '/';
    return pathname.slice(0, 180);
  } catch (_) {
    return '/';
  }
}

function sourceName(referrer, utmSource) {
  const raw = String(utmSource || '').trim().toLowerCase();
  const host = (() => {
    try { return new URL(referrer).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return ''; }
  })();
  const value = raw || host;
  if (!value) return '直接访问';
  if (value.includes('baidu')) return '百度';
  if (value.includes('google')) return 'Google';
  if (value.includes('bing')) return 'Bing';
  if (value.includes('sogou')) return '搜狗';
  if (value.includes('so.com')) return '360 搜索';
  if (value.includes('chatgpt') || value.includes('openai')) return 'ChatGPT';
  if (value.includes('deepseek')) return 'DeepSeek';
  if (value.includes('doubao')) return '豆包';
  if (value.includes('yuanbao')) return '腾讯元宝';
  if (value.includes('kimi')) return 'Kimi';
  if (value.includes('qwen') || value.includes('tongyi')) return '通义千问';
  if (value.includes('gemini')) return 'Gemini';
  if (value.includes('claude')) return 'Claude';
  if (value.includes('perplexity') || value.includes('poe')) return '其他 AI 平台';
  if (value.includes('zhihu')) return '知乎';
  if (value.includes('toutiao')) return '今日头条';
  if (value.includes('weixin') || value.includes('wechat')) return '微信/公众号';
  if (value.includes('douyin')) return '抖音';
  if (value.includes('xiaohongshu') || value.includes('xhslink')) return '小红书';
  if (value.includes('weibo')) return '微博';
  if (value.includes('qq.com')) return 'QQ';
  if (/jansee\.cn/.test(value)) return '站内访问';
  return host || raw.slice(0, 48);
}

function deviceName(ua) {
  const value = String(ua || '');
  if (/iPad|Tablet|PlayBook|Silk/i.test(value)) return '平板';
  if (/Mobile|Android|iPhone|iPod/i.test(value)) return '手机';
  return value ? '电脑' : '未知设备';
}

function browserName(ua) {
  const value = String(ua || '');
  if (/Edg\//i.test(value)) return 'Edge';
  if (/Chrome\//i.test(value) && !/Edg\//i.test(value)) return 'Chrome';
  if (/Safari\//i.test(value) && !/Chrome\//i.test(value)) return 'Safari';
  if (/Firefox\//i.test(value)) return 'Firefox';
  return value ? '其他浏览器' : '未知浏览器';
}

/** 离线库查询（内存内完成，不落盘原始 IP）；查询失败或库未加载返回 null */
function regionOf(ip) {
  if (!regionDb) return null;
  const value = String(ip || '').trim();
  if (!value) return null;
  try {
    return regionDb.lookup(value) || null;
  } catch (_) {
    return null;
  }
}

function regionLabel(result) {
  if (!result) return '地区待识别';
  const country = result.country?.name;
  const province = result.subdivisions?.[0]?.name;
  const city = result.city?.name;
  const usable = (part) => part && part !== '0' && part !== '未知' && part !== 'N/A';
  const parts = [country, province, city].filter(usable);
  return parts.length ? parts.join(' / ').slice(0, 80) : '地区待识别';
}

/** 解析 IP 对应的省份/城市（供注册和后台审计统一调用） */
export function parseIpRegion(ip) {
  if (!ip) return '未知地区';
  const clean = String(ip).trim();
  if (clean === '127.0.0.1' || clean === '::1' || clean.startsWith('192.168.') || clean.startsWith('10.') || clean.startsWith('172.16.') || clean.startsWith('172.17.') || clean.startsWith('172.18.') || clean.startsWith('172.19.') || clean.startsWith('172.20.') || clean.startsWith('172.21.') || clean.startsWith('172.22.') || clean.startsWith('172.23.') || clean.startsWith('172.24.') || clean.startsWith('172.25.') || clean.startsWith('172.26.') || clean.startsWith('172.27.') || clean.startsWith('172.28.') || clean.startsWith('172.29.') || clean.startsWith('172.30.') || clean.startsWith('172.31.')) {
    return '本地测试/内网';
  }
  const r = regionOf(clean);
  if (!r) return '未知地区';
  return regionLabel(r);
}

/** 解析来源渠道（供注册和后台审计统一调用） */
export function parseChannelSource(referrer, utmSource) {
  return sourceName(referrer, utmSource);
}

function increment(map, key) {
  const label = String(key || '未知').slice(0, 80);
  map[label] = (Number(map[label]) || 0) + 1;
}

function prune(db, now) {
  const cutoff = new Date(now - RETENTION_DAYS * 86400000);
  const minDay = dayKey(cutoff.getTime());
  for (const key of Object.keys(db.days)) {
    if (key < minDay) delete db.days[key];
  }
  for (const [visitor, seenAt] of Object.entries(db.active)) {
    if (!Number.isFinite(seenAt) || now - seenAt > 10 * 60 * 1000) delete db.active[visitor];
  }
}

export function isBotUserAgent(ua = '') {
  const value = String(ua || '').toLowerCase();
  if (!value) return true;
  const botTokens = [
    'bot', 'spider', 'crawl', 'headless', 'python', 'curl', 'wget', 'bytespider',
    'yisouspider', 'semrush', 'ahrefs', 'censys', 'shodan', 'zoomeye', 'zgrab',
    'netcraft', 'scanner', 'nmap', 'masscan', 'nuclei', 'acunetix', 'nikto',
    'sqlmap', 'paloalto', 'expanse', 'l9explore', 'cyberconvoy', 'pentest',
    'go-http-client', 'httpclient', 'scrapy',
    'slurp', 'seek', 'mediapartners', 'lighthouse', 'preview', 'scraper',
    'bingpreview', 'feed', 'feedfetcher', 'apache-httpclient',
    'aweme', 'bytedance', 'toutiao', 'internetmeasurement', 'indexnow'
  ];
  if (botTokens.some((token) => value.includes(token))) return true;
  // 结构校验：真实浏览器 UA 必然带平台标识；裸 Mozilla/5.0 或无平台标识的都是脚本
  if (/^mozilla\/5\.0$/.test(value.trim())) return true;
  if (!/(windows nt|macintosh|iphone|ipad|android|cros|linux|x11)/i.test(ua)) return true;
  return false;
}

// —— 自测与管理员网络过滤 ——
// 统计面向全球所有真实人类访客（国内、海外均正常记录）；
// 仅排除管理员动态 IP 与配置的自测出口 IP 前缀，杜绝自测流量污染。
const SELF_IP_PREFIXES = String(process.env.JX_ANALYTICS_SELF_IPS || '117.174.,117.176.,117.136.')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * 该 IP 是否为管理员自测 IP：
 * 1) 动态管理员 IP（登录后台或调管理接口时自动学习并生效 24 小时）
 * 2) 自测出口 IP 前缀（默认覆盖四川移动常见网段，可用 JX_ANALYTICS_SELF_IPS 覆盖）
 */
function isExcludedNetwork(ip) {
  const value = String(ip || '').trim();
  if (!value) return false;
  if (ADMIN_IPS.has(value)) {
    if (ADMIN_IPS.get(value) > Date.now()) return true;
    ADMIN_IPS.delete(value);
  }
  if (SELF_IP_PREFIXES.some((prefix) => value.startsWith(prefix))) return true;
  return false;
}

export { isExcludedNetwork, regionOf, regionLabel };

export function recordSiteAnalytics(payload = {}, headers = {}) {
  const ua = headers['user-agent'] || '';
  if (isBotUserAgent(ua)) return { accepted: false, reason: 'bot_ignored' };

  // 真人交互门禁强校验：无交互或无合规停留凭证一律拒收
  const verifiedBy = String(payload.verifiedBy || '').trim();
  const validTriggers = ['mousemove', 'scroll', 'touch', 'click', 'keydown', 'dwell_4s', 'interval'];
  if (!validTriggers.includes(verifiedBy)) {
    return { accepted: false, reason: 'unverified_human_action' };
  }
  if (verifiedBy === 'dwell_4s') {
    const dwellMs = Number(payload.dwellMs) || 0;
    if (dwellMs < 3500) {
      return { accepted: false, reason: 'insufficient_dwell_time' };
    }
  }

  // 网络层过滤：仅排除内部管理员与自测 IP，不设国界阻断，国内海外真实访客均正常统计
  const clientIp = headers['x-real-ip'];
  if (isExcludedNetwork(clientIp)) return { accepted: false, reason: 'network_ignored' };
  const region = regionOf(clientIp);
  const visitorId = String(payload.visitorId || '').trim();
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(visitorId)) return { accepted: false };
  const event = payload.event === 'heartbeat' ? 'heartbeat' : 'pageview';
  const visitor = hashVisitorId(visitorId);
  const now = Date.now();
  const key = dayKey(now);
  const db = readDb();
  const bucket = db.days[key] || (db.days[key] = {
    pv: 0, visitors: [], pages: {}, sources: {}, regions: {}, devices: {}, browsers: {},
  });

  db.active[visitor] = now;
  if (event === 'pageview') {
    bucket.pv += 1;
    const isNewVisitor = !bucket.visitors.includes(visitor);
    if (isNewVisitor) bucket.visitors.push(visitor);
    if (!bucket.visitorRegions || typeof bucket.visitorRegions !== 'object') bucket.visitorRegions = {};
    // 新功能上线前已计入 UV 的访客，在下一次访问时补记地域；每位访客每天仍只计一次。
    if (!Object.prototype.hasOwnProperty.call(bucket.visitorRegions, visitor)) {
      bucket.visitorRegions[visitor] = regionLabel(region);
    }
    increment(bucket.pages, safePath(payload.path));
    increment(bucket.sources, sourceName(payload.referrer, payload.utmSource));
    increment(bucket.devices, deviceName(headers['user-agent']));
    increment(bucket.browsers, browserName(headers['user-agent']));
  }
  prune(db, now);
  if (!writeJsonAtomic(FILE, db, { pretty: false })) throw new Error('统计数据写入失败');
  return { accepted: true };
}

function ranked(map, limit = 8) {
  return Object.entries(map || {})
    .map(([name, count]) => ({ name, count: Number(count) || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function getSiteAnalytics(days = 7) {
  const period = [7, 30].includes(Number(days)) ? Number(days) : 7;
  const db = readDb();
  const today = dayKey();
  const start = new Date(Date.now() - (period - 1) * 86400000);
  const startKey = dayKey(start.getTime());
  const keys = Object.keys(db.days).filter((key) => key >= startKey && key <= today).sort();
  const totals = { pv: 0, visitors: new Set(), regionVisitors: new Set(), pages: {}, sources: {}, regions: {}, devices: {}, browsers: {} };
  const trend = [];
  for (const key of keys) {
    const bucket = db.days[key];
    totals.pv += Number(bucket.pv) || 0;
    for (const visitor of bucket.visitors || []) totals.visitors.add(visitor);
    for (const [visitor, region] of Object.entries(bucket.visitorRegions || {})) {
      if (totals.regionVisitors.has(visitor)) continue;
      totals.regionVisitors.add(visitor);
      increment(totals.regions, region);
    }
    for (const field of ['pages', 'sources', 'devices', 'browsers']) {
      for (const [name, count] of Object.entries(bucket[field] || {})) {
        totals[field][name] = (totals[field][name] || 0) + (Number(count) || 0);
      }
    }
    trend.push({ date: key.slice(5), pv: Number(bucket.pv) || 0, uv: (bucket.visitors || []).length });
  }
  const todayBucket = db.days[today] || {};
  const activeVisitors = Object.values(db.active).filter((seenAt) => Date.now() - seenAt <= ACTIVE_WINDOW_MS).length;
  const regions = ranked(totals.regions, 30);
  const regionReady = Boolean(regionDb);
  return {
    periodDays: period,
    today: { pv: Number(todayBucket.pv) || 0, uv: (todayBucket.visitors || []).length },
    period: { pv: totals.pv, uv: totals.visitors.size },
    activeVisitors,
    trend,
    pages: ranked(totals.pages),
    sources: ranked(totals.sources),
    regions: regionReady ? regions : [],
    regionStatus: regionReady ? 'available' : 'pending',
    regionMetric: 'uv',
    devices: ranked(totals.devices),
    browsers: ranked(totals.browsers),
    updatedAt: Date.now(),
    retentionDays: RETENTION_DAYS,
  };
}

/**
 * 重置并清零访问统计数据（仅供已鉴权管理员在后台执行）
 */
export function resetSiteAnalytics() {
  const db = { version: 1, days: {}, active: {} };
  if (!writeJsonAtomic(FILE, db, { pretty: false })) throw new Error('统计数据重置写入失败');
  return db;
}
