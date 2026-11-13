// IP 频控中间件：对 /api/* 做按 IP 的简易滑动限频，防脚本高频轰接口拖垮服务器。
// 只作用于 API 层，不触碰 /outputs /uploads /media /bgm 等静态资源，避免误伤视频预览/下载。
// 固定窗口 + 惰性清理：窗口过期即重置，Map 只保留活跃 IP，内存占用可控。
const SEC = 1000;

// 中等阈值：每 IP 每秒 ≤10 次、每 10 秒 ≤50 次
const LIMITS = [
  { windowMs: 1 * SEC, max: 10, key: 's1' },
  { windowMs: 10 * SEC, max: 50, key: 's10' },
];

// 豁免清单（前缀匹配）：确定性公开资源不占频控配额。
// ⚠️ 本中间件挂载在 app.use('/api', ...) 下，req.path **不含** /api 前缀
// （曾误写成 '/api/install-qr' 导致豁免永不命中、429 照旧）。
// 背景：进首页时 site-config/价目/案例等约 10 个 API 并发，紧接着的安装二维码
// （install-qr / apk-qr 两个 <img>）被 1s/10 次窗口挤爆 → 429 破图，表现为
// 「iOS/安卓二维码随机看不到，刷新多次才齐全」。二维码内容固定且无鉴权，
// 性质等同静态文件，故豁免（并配合 Cache-Control 让浏览器不再重复请求）。
const SKIP_PREFIXES = ['/install-qr', '/apk-qr'];

function isSkipped(pathname) {
  return SKIP_PREFIXES.some((p) => pathname.startsWith(p));
}

// ip -> { [key]: { count, resetAt } }
const buckets = new Map();

// 取真实客户端 IP。
// 安全要点：X-Forwarded-For 是客户端可任意伪造的请求头。无条件采信它，攻击者每个请求
// 换一个伪造值就能落进全新的桶，限频等于没有。故只有显式声明「前面确实存在可信反代」
// （TRUST_PROXY=1）时才采信该头，否则一律以 TCP 连接对端地址为准。
// 部署提示：若日后挂到 nginx/SLB 后面，需同时设置 TRUST_PROXY=1，否则所有请求会被
// 识别成同一个反代 IP 而共享额度，造成误伤。
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      const first = xff.split(',')[0].trim();
      if (first) return first;
    }
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function isOverLimit(ip) {
  const now = Date.now();
  let entry = buckets.get(ip);
  if (!entry) {
    entry = {};
    buckets.set(ip, entry);
  }
  for (const { windowMs, max, key } of LIMITS) {
    let slot = entry[key];
    if (!slot || now - slot.resetAt > 0) {
      slot = { count: 0, resetAt: now + windowMs };
      entry[key] = slot;
    }
    slot.count += 1;
    if (slot.count > max) return { limited: true, key };
  }
  return { limited: false };
}

// 低频全局清理：清掉早已过期的空闲 IP，防止长期运行内存无界增长
function sweep() {
  const now = Date.now();
  const alive = (entry) =>
    LIMITS.some(({ windowMs, key }) => {
      const slot = entry[key];
      return slot && now - slot.resetAt < windowMs;
    });
  for (const [ip, entry] of buckets) {
    if (!alive(entry)) buckets.delete(ip);
  }
}
// 每 5 分钟清一次
setInterval(sweep, 5 * 60 * SEC).unref?.();

/**
 * 原生 HTTP 频控检查函数（直接服务于原生 http.createServer 网关）
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @returns {boolean} true 表示已触发限频并返回 429，上层应阻断；false 表示放行
 */
export function checkRateLimit(req, res, pathname) {
  if (pathname === '/health' || pathname === '/api/health' || pathname === '/api/v1/health') {
    return false;
  }
  // 后台专有路径豁免限频，保证控制台运维与自动化巡检通畅。
  // 注意：此前额外以 x-admin-key === 'jansee-admin' 作为豁免条件，该硬编码后门已于
  // 2026-10-28 移除，豁免只按路径判定，避免任意客户端伪造请求头绕过全站频控。
  if (pathname.startsWith('/api/v1/admin')) {
    return false;
  }
  if (isSkipped(pathname)) return false;
  const ip = clientIp(req);
  const { limited } = isOverLimit(ip);
  if (limited) {
    console.warn(`[rate-limit] ${ip} 触发频控 ${req.method} ${pathname}`);
    res.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Retry-After': '5',
    });
    res.end(JSON.stringify({
      code: 42901,
      msg: '请求过于频繁，请稍候再试',
      data: { retryAfterSec: 5 },
      timestamp: Date.now(),
    }));
    return true;
  }
  return false;
}

export default function rateLimit() {
  return (req, res, next) => {
    // 健康检查放行，避免监控探针误触发限频
    if (req.path === '/health') return next();
    // 公开确定性资源放行（见 SKIP_PREFIXES 注释）
    if (isSkipped(req.path)) return next();
    const ip = clientIp(req);
    const { limited } = isOverLimit(ip);
    if (limited) {
      console.warn(`[rate-limit] ${ip} 触发频控 ${req.method} ${req.originalUrl}`);
      return res.status(429).json({ ok: false, code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' });
    }
    return next();
  };
}
