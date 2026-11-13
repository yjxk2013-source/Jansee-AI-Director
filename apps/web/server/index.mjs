/**
 * 简兮 (JANSEE) — 官方门户生产级 API 网关与静态服务 (BFF Gateway)
 * 遵循: 0 Emoji 铁律、严格 9 张图片锁定、RESTful 统一信封格式、纯原生零多余依赖
 */

import './env.mjs'; // 首个 import：装载 .env（SILICONFLOW_API_KEY / 腾讯 TTS 密钥依赖，ESM 提升后置会静默失效，勿删）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp'; // 上传图片归一化（固定 1080P 出片原则：下游只消费 ≤1080P 需求尺寸）
import QRCode from 'qrcode'; // 推广海报二维码（服务端出 PNG，前端 canvas 直接贴，避免引入前端打包链）

process.on('uncaughtException', (err) => {
  console.error('[JANSEE GATEWAY FATAL uncaughtException]', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[JANSEE GATEWAY FATAL unhandledRejection]', reason);
});
import { generateDirectorCut, generateConstitutionScript, generatePublishOnly } from './director.mjs';
import { decideVariantLocal } from './prompt/index.js';
import { videoDurationSec } from '@jansee/video-creator/video/slicer.js';
import { selectBgmByEmotion } from '@jansee/audio-kit/bgm.js';
import { startTtsProbe } from './ttsProbe.mjs';
import { startSpeechAnalyze, startSpeechProduce } from '@jansee/speech-cut';
import {
  startStoryboardDirectAnalyze,
  startStoryboardDirectProduce,
  startExactSliceCut,
  registerMaterial,
  listRegisteredMaterials,
  getRegisteredMaterial,
  cleanExpiredMaterials,
} from './storyboard.mjs';
import { createCreationTask, getCreationTask, listCreationHistory, isCreationTaskExpired } from './creation.mjs';
import { creationStore } from './creationStore.mjs';
import { createUser, getUser, localDate, getUserAuthRecord, setUserPassword, hasPassword, verifyPassword, findUserByPhone, invitedCount, partnerTarget, upgradeToPartner, usersByInviter, updateWithdrawProfile, recordUserVideoCreated, recordUserVideoDownloaded } from './userStore.mjs';
import { creditStore } from './creditStore.mjs';
import { chargeForEntry, chargedAmountOf, settleFailure } from './billing.mjs';
import { createSession, verifySession, destroySession, extractSessionToken } from './auth.mjs';
import { sendVerifyCode, checkVerifyCode, smsStatus } from './smsProvider.mjs';
import { checkRateLimit } from './rateLimit.mjs';
import { interpOps } from './siteConfig.mjs'; // 静态页 {{ops.*}} 服务端注入：后台改参数全站即时生效
import { recordSiteAnalytics, getSiteAnalytics, recordAdminIp, resetSiteAnalytics, parseIpRegion, parseChannelSource } from './siteAnalytics.mjs';
import {
  recordAdminError,
  refundAdminOrder,
  getAdminPricing,
} from './admin.mjs';
import { addFeedback, messagesFor } from './messageStore.mjs';
import {
  savePartnerProfile,
  getPartnerProfile,
  createWithdraw,
  withdrawsOf,
  partnerSummary,
  commissionsOf,
} from './partnerStore.mjs';
import { createOrder, getOrder, ordersOf } from './payStore.mjs';
import { createAlipayRouteHandler, alipayReturnUrl } from './alipayRoutes.mjs';
import { createAdminRouteHandler } from './adminRoutes.mjs';
import { metrics } from './metrics.mjs';
import { initAlipay } from './alipayProvider.mjs';
import { fulfillPaidOrder } from './payFulfillment.mjs';
import { updateUser } from './userStore.mjs';
import { generateLlmsTxt, generateLlmsFullTxt, generateGeoNeedsTxt } from './llmsGenerator.mjs';
import {
  verifyAdmin,
  verifyAdminToken,
  extractAdminToken,
} from './adminStore.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../../');
const clientDir = path.resolve(rootDir, 'apps/web/client');
const adminDir = path.resolve(rootDir, 'apps/admin');
const storageOutputsDir = path.resolve(rootDir, 'storage/outputs');
const storageUploadsDir = path.resolve(rootDir, 'storage/uploads');
const materialsDir = path.resolve(rootDir, 'materials');

// ==========================================
// GEO · AI 爬虫可读快照
// 豆包(Bytespider)/DeepSeek/元宝/KIMI/千问 等爬虫不执行 JS，
// 抓 SPA 首页只能拿到空壳，无法理解站点。这里按 UA 命中时直接返回官方品牌事实正文，
// 真实用户、浏览器与 App 的访问路径完全不受影响。
// ==========================================
const AI_CRAWLER_UA_RE = /bytespider|deepseek|moonshot|kimi|yisou|spider|tencentbot|hunyuan|yuanbao|qwen|tongyi|baiduspider|gptbot|oai-searchbot|chatgpt-user|claudebot|anthropic|perplexitybot|ccbot|amazonbot|applebot-extended|meta-externalagent|youbot|cohere|diffbot/i;
let aiHomeSnapshotCache = null;

function isAiCrawlerUA(ua) {
  return typeof ua === 'string' && ua !== '' && AI_CRAWLER_UA_RE.test(ua);
}

function escapeHtmlText(input) {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 用 generateLlmsFullTxt 的品牌事实生成可读 HTML 快照，结果模块级缓存，避免每次请求重复构建。
function buildAiHomeSnapshotHtml() {
  if (aiHomeSnapshotCache) return aiHomeSnapshotCache;
  const source = generateLlmsFullTxt();
  const parts = [];
  let listBuffer = [];
  const flushList = () => {
    if (listBuffer.length) {
      parts.push('<ul>' + listBuffer.join('') + '</ul>');
      listBuffer = [];
    }
  };
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }
    if (line.startsWith('- ')) {
      listBuffer.push('<li>' + escapeHtmlText(line.slice(2)) + '</li>');
      continue;
    }
    flushList();
    if (line.startsWith('## ')) parts.push('<h3>' + escapeHtmlText(line.slice(3)) + '</h3>');
    else if (line.startsWith('# ')) parts.push('<h2>' + escapeHtmlText(line.slice(2)) + '</h2>');
    else if (line.startsWith('> ')) parts.push('<p><em>' + escapeHtmlText(line.slice(2)) + '</em></p>');
    else parts.push('<p>' + escapeHtmlText(line) + '</p>');
  }
  flushList();
  const head = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>简兮 JANSEE · 全栈 AI 短视频重构工场 | 电商带货与视频生成智能平台</title>'
    + '<meta name="description" content="简兮 JANSEE 是面向商家与内容创作者的 AI 智能导演系统与短视频重构工场。围绕真实素材与创作目标，统筹开场、主体、转场、结尾、BGM、字幕和配音，提供图片成片、视频配音、出镜口播、实拍分镜四大创作入口。">'
    + '<meta name="keywords" content="简兮 JANSEE,简兮JANSEE,简兮AI,AI智能导演,AI短视频,AI视频生成,电商带货视频,AI配音,出镜口播,图片成片,切片分镜,短视频制作">'
    + '<meta name="robots" content="index,follow,max-image-preview:large">'
    + '<link rel="canonical" href="https://jansee.cn/">'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"SoftwareApplication","name":"简兮 (JANSEE)","alternateName":["简兮","JANSEE","简兮AI大导演","简兮AI视频","简兮 AI 大导演","简兮 AI 视频","简兮 AI 智能导演系统"],"url":"https://jansee.cn/","applicationCategory":"MultimediaApplication","applicationSubCategory":"AI Video Generator","operatingSystem":"Web, iOS, Android, Windows","description":"简兮 JANSEE 是面向商家与内容创作者的 AI 智能导演系统，提供图片成片、视频配音、出镜口播、实拍分镜四大创作入口。"},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"简兮 JANSEE 是什么？与其他剪辑工具有什么区别？","acceptedAnswer":{"@type":"Answer","text":"简兮是 AI 智能导演系统，而非传统时间线剪辑工具。核心围绕商家的真实素材和创作目标，由 AI 统筹分镜、镜头节奏、配音、BGM、字幕和片尾收束，实现一键极简出片。"}},{"@type":"Question","name":"没有视频剪辑基础，如何用图片或实拍生成带货视频？","acceptedAnswer":{"@type":"Answer","text":"商家只需上传 1~9 张商品实拍图或一段原片，选择导演风格与主播音色，简兮即可在数十秒内自动完成分镜编排、画质调优与音画合成。"}}]}]}</script>'
    + '</head><body><h1>简兮 JANSEE · 全栈 AI 短视频重构工场</h1>'
    + '<p>网站备案：<a href="https://beian.miit.gov.cn/" rel="noopener">蜀ICP备2026046708号</a> ｜ <a href="http://www.beian.gov.cn/portal/registerSystemInfo?recordcode=51011202001517" rel="noopener">川公网安备51011202001517号</a></p>'
    + '<p>官方站点：https://jansee.cn/ ｜ 产品白皮书：https://jansee.cn/llms.txt ｜ 技术与场景指南：https://jansee.cn/llms-full.txt</p>';
  const tail = '<hr><p>官方页面：<a href="/brand-identity.html">品牌身份</a> ｜ <a href="/about-jansee.html">品牌介绍</a> ｜ <a href="/features.html">产品能力</a> ｜ <a href="/solutions.html">创作场景</a> ｜ <a href="/faq.html">常见问题</a> ｜ <a href="/guides/index.html">专题指南</a></p>'
    + '<p>官方开源技术架构仓库（遵循 Apache-2.0 协议，包含全景 Monorepo 模块架构定义与公共中台接口契约）：<a href="https://github.com/yjxk2013-source/Jansee-AI-Director" rel="me">GitHub</a> ｜ <a href="https://gitee.com/LiuQing404/Jansee-AI-Director" rel="me">Gitee</a></p>'
    + '<p>网站备案：<a href="https://beian.miit.gov.cn/" rel="noopener">蜀ICP备2026046708号</a> ｜ <a href="http://www.beian.gov.cn/portal/registerSystemInfo?recordcode=51011202001517" rel="noopener">川公网安备51011202001517号</a></p></body></html>';
  aiHomeSnapshotCache = head + parts.join('\n') + tail;
  return aiHomeSnapshotCache;
}

/**
 * 服务端权威定价：成交金额与到账积分只以后台价目表（server/data/pricing.json）为准。
 *
 * 修复背景（2026-10-28）：order/create 此前直接采信客户端传入的 amount / points，
 * 任何人可下「0.01 元买 100 万积分」的单。接入真实支付后危害更大 —— 支付通道只能证明
 * 「这 0.01 元真的付了」，验签会顺利通过，服务端照样按客户端自报的积分数入账。
 *
 * 匹配口径（宽松匹配，宁可匹配上也不能误拒正常下单）：
 *   itemKey / tierId / title 任一命中价目表的 id 或名称即可；
 *   会员单取 members[].price，积分取该档 credits 文案里的数字（如「每月 7,600 分」）；
 *   加油包取 boostPacks[].price / points / bonusPoints。
 * 匹配不到一律拒单：不猜、不回落、不放行客户端自报价。
 */
function resolveOrderQuote(payload = {}) {
  const pricing = getAdminPricing() || {};
  const members = Array.isArray(pricing.members) ? pricing.members : [];
  const boostPacks = Array.isArray(pricing.boostPacks) ? pricing.boostPacks : [];

  const lower = (v) => String(v || '').trim().toLowerCase();
  const itemKey = lower(payload.itemKey);
  const tierRaw = lower(payload.tierId);
  const orderType = lower(payload.orderType || payload.kind);
  const titleRaw = lower(payload.title || payload.pkg || payload.name);

  const tokens = [itemKey, tierRaw].filter(Boolean);
  const wantMember = ['membership', 'member', 'renew'].includes(orderType) || !!tierRaw;

  const hitByToken = (row) => {
    const id = lower(row.id);
    const name = lower(row.name);
    return tokens.some((t) => t === id || t === name || (id && id.includes(t)) || (name && name.includes(t)));
  };
  const hitByTitle = (row) => {
    if (!titleRaw) return false;
    const id = lower(row.id);
    const name = lower(row.name);
    return (name && (titleRaw === name || titleRaw.includes(name) || name.includes(titleRaw)))
      || (id && titleRaw.includes(id));
  };

  if (wantMember) {
    const hit = members.find((m) => hitByToken(m)) || members.find((m) => hitByTitle(m));
    if (!hit) return null;
    const pts = String(hit.credits || '').match(/([\d,]+)\s*分/);
    return {
      kind: 'member',
      tierId: hit.id,
      pkg: hit.name || hit.id,
      amount: Number(hit.price) || 0,
      points: pts ? Number(String(pts[1]).replace(/,/g, '')) || 0 : 0,
      bonus: 0,
    };
  }

  const pack = boostPacks.find((p) => hitByToken(p)) || boostPacks.find((p) => hitByTitle(p));
  if (!pack) return null;
  return {
    kind: 'points',
    tierId: null,
    pkg: pack.name || pack.id,
    amount: Number(pack.price) || 0,
    points: Number(pack.points) || 0,
    bonus: Number(pack.bonusPoints) || 0,
  };
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// ── 短信验证码登录 ──
// 历史问题：前端「登录」曾经完全本地伪造——任意手机号 + 任意 4 位码即登录。
// 现在链路是：前端请求验证码 → 本服务调阿里云号码认证下发（验证码由阿里云生成托管）
// → 登录时由阿里云校验，通过才发 sessionToken。本进程不持有明文验证码。
// JX_AUTH_TEST=1 或 JX_SMS_PROVIDER=mock 时走本地 mock，便于离线开发。
const SMS_TTL_MS = 5 * 60 * 1000;   // mock 模式验证码有效期
const SMS_RESEND_MS = 60 * 1000;    // 同号 60 秒内不可重复下发（与阿里云 Interval 对齐）
const SMS_MAX_TRIES = 5;            // 同一手机号连续输错 5 次即要求重新获取
const smsCodes = new Map();         // phone -> { code?, expireAt?, sentAt, fails }（真实通道只记频控）
const normPhone = (v) => String(v || '').replace(/\D/g, '').trim();

// ── 密码登录防撞库（账号级，非 IP 级）──
// IP 限频挡不住分布式撞库，密码这种「可离线无限次猜测」的凭证必须按账号计数。
const PWD_MAX_TRIES = 5;              // 连续错 5 次锁定
const PWD_LOCK_MS = 10 * 60 * 1000;   // 锁 10 分钟
const pwdFails = new Map();           // phone -> { count, lockUntil }

// 密码强度规则（单一实现）：长度 8-32，必须字母 + 数字混合。
// 不要求特殊字符——商家用户记不住，会转而去写便利贴，实际安全性反而下降。
function passwordIssue(pwd) {
  const s = String(pwd || '');
  if (s.length < 8 || s.length > 32) return '密码长度需为 8-32 位';
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return '密码需同时包含字母和数字';
  if (/\s/.test(s)) return '密码不能包含空格';
  return '';
}

// 短信是花钱的外部调用，只按手机号频控挡不住「换着号码刷」的攻击：
// 全局 API 限流是每 IP 10 秒 50 次，等于 10 秒能发 50 条短信。这里再叠一层 IP 配额，
// 真人一天收几次码完全够用，攻击者的成本被压到可接受范围。
const SMS_IP_HOURLY_MAX = Number(process.env.SMS_IP_HOURLY_MAX) || 10;
const SMS_IP_DAILY_MAX = Number(process.env.SMS_IP_DAILY_MAX) || 50;
const smsIpBuckets = new Map();     // ip -> { hour:{count,resetAt}, day:{count,resetAt} }

function clientIpOf(req) {
  if (process.env.TRUST_PROXY === '1') {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** @returns {number} 0 = 放行；>0 = 需要等待的秒数 */
function consumeSmsIpQuota(ip) {
  const now = Date.now();
  let bucket = smsIpBuckets.get(ip);
  if (!bucket) { bucket = {}; smsIpBuckets.set(ip, bucket); }
  const take = (slot, windowMs, max) => {
    let s = bucket[slot];
    if (!s || now > s.resetAt) { s = { count: 0, resetAt: now + windowMs }; bucket[slot] = s; }
    if (s.count >= max) return Math.ceil((s.resetAt - now) / 1000);
    s.count += 1;
    return 0;
  };
  const hourWait = take('hour', 3600 * 1000, SMS_IP_HOURLY_MAX);
  if (hourWait) return hourWait;
  return take('day', 86400 * 1000, SMS_IP_DAILY_MAX);
}

// ── 上传图片归一化（固定 1080P 出片原则）──
// 成片画布恒为 1080×1920：用户原图无论多大，下游（背景分析 / 视觉引擎 / 合成）只消费
// 「cover 1080×1920 所需的最小尺寸」副本，避免逐帧从 4000×6000 甚至 5464×8192 重采样。
// 规则：缩放系数 = max(1080/w, 1920/h)，封顶 1（绝不放大）；EXIF 方向烘焙成正立像素；
// 原图保留不动（预览/追溯），副本落 norm/ 子目录（避免目录扫描误读为额外素材）。
async function normalizeImageForPipeline(buffer, outDir, outName) {
  // 像素炸弹硬防御 (Pixel Flood 防御)：限制单张最大 4000 万像素（约 6300×6300），杜绝 40000×40000 畸形图解压打满 4GB 内存
  const meta = await sharp(buffer, { limitInputPixels: 40000000 }).metadata();
  const w = Number(meta.width) || 0;
  const h = Number(meta.height) || 0;
  if (!w || !h || (w * h > 40000000)) {
    throw new Error(`图片分辨率异常过大 (${w}x${h})，超出 4000 万像素安全上限`);
  }
  const orientation = Number(meta.orientation) || 1;
  const swapped = orientation >= 5 && orientation <= 8; // 90°/270° 旋转后宽高互换
  const ow = swapped ? h : w;
  const oh = swapped ? w : h;
  const scale = Math.min(1, Math.max(1080 / ow, 1920 / oh));
  if (scale >= 0.999) return ''; // 原图本就不大于出片需求，直接复用原图
  const tw = Math.max(2, Math.round((ow * scale) / 2) * 2);
  const th = Math.max(2, Math.round((oh * scale) / 2) * 2);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, meta.hasAlpha ? outName.replace(/\.jpg$/i, '.png') : outName);
  const pipe = sharp(buffer, { limitInputPixels: 40000000 }).rotate().resize({ width: tw, height: th, fit: 'fill' });
  await (meta.hasAlpha ? pipe.png() : pipe.jpeg({ quality: 95, chromaSubsampling: '4:4:4' })).toFile(outPath);
  return outPath;
}

// 启动自检：env.mjs 是否成功装载（仅打印长度不泄露密钥）
console.log(`[JANSEE GATEWAY] env 自检: SILICONFLOW_KEY=${(process.env.SILICONFLOW_API_KEY || '').length >= 8 ? '已配置' : '未配置'} JIANXI_MOCK=${process.env.JIANXI_MOCK ?? '未设置'} 腾讯TTS=${process.env.JX_TTS_TENCENT_SECRET_ID ? '已配置' : '未配置'}`);

// 运行时内存任务状态管理
const inMemoryTasks = new Map();
let currentMockCredits = 2850;

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.srt': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.apk': 'application/vnd.android.package-archive'
};

// 统一响应辅助函数
function sendJson(res, statusCode, code, msg, data = {}) {
  metrics.recordRequest(res?.req?.method || 'HTTP', '', statusCode);
  if (statusCode >= 400) {
    recordAdminError(statusCode, code, msg);
  }
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-session-token, x-admin-token',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  res.end(JSON.stringify({
    code,
    msg,
    data,
    timestamp: Date.now()
  }));
}

/**
 * 长期登录 Cookie（兜底通道）
 * 背景：iOS Safari 的 ITP 会在站点 7 天未访问时清除 localStorage，
 * 前端本地令牌一旦被清就只能重新登录。Cookie 独立存储且不受该清理影响，
 * 服务端 extractSessionToken 已支持从 Cookie 读取，故此处只负责下发与清除。
 * HttpOnly：前端无需读取，全部由服务端鉴权；SameSite=Lax 防跨站伪造。
 */
const SESSION_COOKIE_MAX_AGE_SEC = 365 * 24 * 60 * 60;

function setSessionCookie(res, sessionToken) {
  if (!sessionToken) return;
  res.setHeader(
    'Set-Cookie',
    `sessionToken=${encodeURIComponent(sessionToken)}; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE_SEC}; SameSite=Lax; HttpOnly`,
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sessionToken=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly');
}

// —— 支付宝网页支付路由（下单表单/查单/关单/异步通知/同步回跳页）——
// 依赖注入避免循环引用：sendJson/safeReadJson 为模块级函数，会话校验直接用 auth 层。
const handleAlipayRoutes = createAlipayRouteHandler({
  sendJson,
  safeReadJson,
  sessionUidOf: (req) => {
    const session = verifySession(extractSessionToken(req));
    return session && session.userId ? String(session.userId) : '';
  },
  rejectNoUid: (res) => sendJson(res, 401, 40101, '未登录或登录已失效，请重新登录'),
});

// —— S9 管理后台运营控制中心路由 ——
const handleAdminRoutes = createAdminRouteHandler({ sendJson, safeReadJson });

/**
 * 全局安全 JSON 请求体读取器（全站通用防 OOM DoS 门禁）
 * 严格卡死普通 JSON 接口的 Body 上限（缺省 2MB），超限瞬间掐断连接并返回 413
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {number} [maxBytes=2097152] 默认 2MB
 * @returns {Promise<object>}
 */
function safeReadJson(req, res, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let len = 0;
    let aborted = false;

    // 弱网超时保护：15 秒无新数据传输自动切断
    req.setTimeout(15000, () => {
      if (!aborted) {
        aborted = true;
        req.destroy();
        sendJson(res, 408, 40009, '请求接收超时');
        reject(new Error('Request Timeout'));
      }
    });

    req.on('data', (chunk) => {
      if (aborted) return;
      len += chunk.length;
      if (len > maxBytes) {
        aborted = true;
        req.destroy();
        sendJson(res, 413, 40010, `请求体超出 ${Math.round(maxBytes / 1024 / 1024)}MB 大小上限`);
        reject(new Error('Payload Too Large'));
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (aborted) return;
      try {
        const payload = JSON.parse(body || '{}');
        resolve(payload);
      } catch (err) {
        sendJson(res, 400, 40000, 'JSON 请求格式不合法');
        reject(err);
      }
    });

    req.on('error', (err) => {
      if (!aborted) {
        aborted = true;
        sendJson(res, 500, 50004, '请求接收异常');
        reject(err);
      }
    });
  });
}

// 静态文件安全子路径校验（防范路径穿越逃逸出指定基准目录）
function isSafeSubPath(baseDir, targetPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget.startsWith(resolvedBase + path.sep);
}

// 静态文件流式传输（支持视频 Range 断点续传、CORS 及强制文件下载）
function serveStaticFile(req, res, filePath) {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_MAP[ext] || 'application/octet-stream';
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const isDownload = urlObj.searchParams.get('download') === '1' || urlObj.searchParams.has('download');
    const filename = urlObj.searchParams.get('filename') || `jansee-${path.basename(filePath)}`;

    const baseHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    };
    // HTML 强制回源校验：安卓 WebView 壳与 iOS 主屏幕图标均直接加载本页，
    // 若被启发式缓存会长期停留在旧界面（新增版块/卡片后用户看不到）。
    // 仅对 html 生效，图片/字体/视频保留浏览器缓存以维持性能。
    if (ext === '.html') {
      baseHeaders['Cache-Control'] = 'no-cache, must-revalidate';
    }
    if (isDownload) {
      baseHeaders['Content-Disposition'] = `attachment; filename="${encodeURIComponent(filename)}"`;
    }

    // 视频流 Range 处理 (针对 1080P 成片秒开)
    const range = req.headers.range;
    if (range && (ext === '.mp4' || ext === '.webm')) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      const chunkSize = (end - start) + 1;

      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    // HTML 走服务端占位符注入：{{ops.xxx}} 换成当前生效运营参数（后台改参数即全站生效，避免静态页写死过期数字）
    if (ext === '.html') {
      let html = '';
      try {
        html = fs.readFileSync(filePath, 'utf8');
      } catch (_) {
        html = '';
      }
      // 仅对官网公开静态页注入轻量统计脚本；管理后台 apps/admin 不在 clientDir 内，不受影响。
      const isPublicClientHtml = path.resolve(filePath).startsWith(`${clientDir}${path.sep}`);
      if (isPublicClientHtml && !html.includes('src="/analytics.js"')) {
        const bodyClose = html.toLowerCase().lastIndexOf('</body>');
        if (bodyClose >= 0) {
          html = html.slice(0, bodyClose) + '<script src="/analytics.js" defer></script>' + html.slice(bodyClose);
        }
      }
      const buf = Buffer.from(interpOps(html), 'utf8');
      // gzip 压缩（index.html 0.48MB → 约 0.1MB，移动端首屏字节立减 80%）
      const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      if (acceptsGzip && buf.length >= 1024) {
        const gz = zlib.gzipSync(buf);
        res.writeHead(200, {
          ...baseHeaders,
          'Content-Type': contentType,
          'Content-Encoding': 'gzip',
          'Vary': 'Accept-Encoding',
          'Content-Length': gz.length,
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        res.end(gz);
        return;
      }
      res.writeHead(200, {
        ...baseHeaders,
        'Content-Type': contentType,
        'Content-Length': buf.length,
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(buf);
      return;
    }

    const headers = {
      ...baseHeaders,
      'Content-Length': stats.size,
      'Content-Type': contentType,
    };
    if (ext === '.html' || ext === '.js' || ext === '.mjs') {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    } else if (ext === '.css' || ext === '.webmanifest') {
      // CSS / PWA manifest are not content-hashed; revalidate so web updates reach installed shells promptly.
      headers['Cache-Control'] = 'no-cache, must-revalidate, max-age=0';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    } else if (ext === '.xml') {
      // sitemap 等爬虫索引文件：缩短缓存，让内容更新及时被搜索引擎看到
      headers['Cache-Control'] = 'public, max-age=3600';
    } else {
      headers['Cache-Control'] = 'public, max-age=86400';
    }
    // 文本类静态资源 gzip（css/js/json/svg/webmanifest 等，≥1KB 才值得压）
    const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.webmanifest', '.txt', '.xml', '.map']);
    const acceptsGzip2 = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (acceptsGzip2 && stats.size >= 1024 && COMPRESSIBLE.has(ext)) {
      delete headers['Content-Length'];
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(zlib.createGzip()).pipe(res);
      return;
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // CORS 跨域预检全局拦截
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-session-token, x-admin-token',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  // ==========================================
  // 全局 API IP 滑动频控门禁（健康探针豁免，静态资源豁免，单 IP 1s≤10次、10s≤50次）
  // ==========================================
  if (pathname.startsWith('/api/') && checkRateLimit(req, res, pathname)) {
    return;
  }

  // ==========================================
  // API 路由分发
  // ==========================================

  // 0. 大模型 SEO / GEO 索引通道 (LLMs TXT · 权威事实源直通)
  if (pathname === '/llms.txt' || pathname === '/llms-full.txt' || pathname === '/geo-needs.txt') {
    const text = pathname === '/llms-full.txt'
      ? generateLlmsFullTxt()
      : pathname === '/geo-needs.txt'
        ? generateGeoNeedsTxt()
        : generateLlmsTxt();
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(text);
    return;
  }

  // 0.1 爬虫规则索引通道 (robots.txt 明确放行各大 AI 爬虫)
  if (pathname === '/robots.txt' || pathname === '/sitemap.xml') {
    const indexFile = path.join(clientDir, pathname.slice(1));
    serveStaticFile(req, res, indexFile);
    return;
  }

  // 0.2 GEO · AI 爬虫可读快照通道
  // 不执行 JS 的爬虫（豆包/DeepSeek/元宝/KIMI/千问 等）请求首页时拿到的是空壳，
  // 命中 UA 时直接返回官方品牌事实 HTML；普通用户与浏览器不受影响。
  if ((pathname === '/' || pathname === '/index.html') && isAiCrawlerUA(req.headers['user-agent'])) {
    const snapshot = buildAiHomeSnapshotHtml();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(snapshot);
    return;
  }

  // 1. 健康探针接口
  if (pathname === '/api/v1/health' || pathname === '/api/health' || pathname === '/health') {
    const snap = metrics.getSnapshot();
    sendJson(res, 200, 0, '系统健康运行中', { status: 'healthy', uptime: process.uptime(), metrics: snap });
    return;
  }

  // 1.0 生产级可观测性度量指标快照
  if (pathname === '/api/v1/metrics' && req.method === 'GET') {
    sendJson(res, 200, 0, '度量指标采集成功', metrics.getSnapshot());
    return;
  }

  // 官网匿名访问统计：仅接收匿名访客 ID、页面路径和来源分类所需信息，不保存原始 IP。
  if (pathname === '/api/v1/analytics/collect' && req.method === 'POST') {
    const origin = String(req.headers.origin || '');
    if (origin) {
      let originHost = '';
      try { originHost = new URL(origin).hostname.toLowerCase(); } catch (_) { }
      if (!['jansee.cn', 'www.jansee.cn'].includes(originHost)) {
        sendJson(res, 403, 40321, '来源不允许');
        return;
      }
    }
    safeReadJson(req, res).then((payload) => {
      try {
        // X-Real-IP 由 Nginx 根据 TCP 对端地址覆盖注入；不采信浏览器可自行提交的地理位置请求头。
        const result = recordSiteAnalytics(payload, req.headers);
        sendJson(res, result.accepted ? 200 : 400, result.accepted ? 0 : 40021, result.accepted ? '统计已接收' : '统计参数无效', result);
      } catch (error) {
        console.warn('[JANSEE ANALYTICS] 统计写入失败:', error.message);
        sendJson(res, 500, 50021, '统计暂不可用');
      }
    }).catch(() => { });
    return;
  }

  // 统一取用户标识：只认登录会话（Authorization: Bearer / x-session-token / Cookie sessionToken）。
  // 2026-10-28 安全收口：彻底废除 x-user-id、?userId=、body.userId 三条「客户端说自己是谁就是谁」的通道。
  // 之前的实现只要改一个请求头就能读写任意账号的订单、积分、合伙人资料，等于没有鉴权。
  const sessionUidOf = (req) => {
    const session = verifySession(extractSessionToken(req));
    return session && session.userId ? String(session.userId) : '';
  };

  const rejectNoUid = (res) => sendJson(res, 401, 40101, '未登录或登录已失效，请重新登录');

  // 2.-1 支付宝网页支付路由（checkout / status / close / notify / return）：命中即短路返回
  if (handleAlipayRoutes(req, res, pathname)) {
    return;
  }


  // 2.0 更新用户昵称等基础档案：POST /api/v1/user/profile
  if (pathname === '/api/v1/user/profile' && req.method === 'POST') {
    safeReadJson(req, res).then((payload) => {
      const uid = sessionUidOf(req);
      if (!uid) { rejectNoUid(res); return; }
      const nickname = (payload && payload.nickname ? String(payload.nickname) : '').trim();
      if (!nickname) {
        sendJson(res, 200, 40001, '昵称不能为空');
        return;
      }
      if (nickname.length > 20) {
        sendJson(res, 200, 40002, '昵称过长（最多 20 个字符）');
        return;
      }
      const existing = getUser(uid);
      if (!existing) {
        // 默认 / 演示账号可能尚未落库，先以 uid 为手机号建记录再写昵称
        createUser({ phone: uid, nickname });
      } else {
        updateUser(existing.userId || uid, { nickname });
      }
      sendJson(res, 200, 0, '昵称更新成功', { nickname });
    }).catch(() => { });
    return;
  }

  // 2. 获取用户真实资产与画像：GET /api/v1/user/profile
  if (pathname === '/api/v1/user/profile') {
    const uid = sessionUidOf(req);
    if (!uid) { rejectNoUid(res); return; }
    // 每次成功读取都续发 Cookie：覆盖「本地存储被清后靠 Cookie 恢复」的场景
    setSessionCookie(res, extractSessionToken(req));
    const u = getUser(uid);
    const balance = creditStore.getBalance(uid);
    const paidPoints = creditStore.getPaidBalance(uid);
    const freePoints = creditStore.getFreeBalance(uid);
    sendJson(res, 200, 0, '获取成功', {
      userId: uid,
      phone: u?.phone || uid,
      nickname: u?.nickname || `用户_${String(uid).slice(-4)}`,
      userName: u?.nickname || `用户_${String(uid).slice(-4)}`,
      points: balance,
      credits: balance,
      balance: balance,
      paidPoints,
      freePoints,
      tier: u?.tier || 'Free',
      status: u?.status || 'active',
      isFrozen: u?.status === 'blocked' || u?.status === 'frozen',
      maxImagesLimit: 9,
    });
    return;
  }

  // 2.05 商户每日签到领积分：POST /api/v1/user/checkin (仅增加 free 赠送池，不可折抵退款)
  if (pathname === '/api/v1/user/checkin' && req.method === 'POST') {
    safeReadJson(req, res).then((payload) => {
      const uid = sessionUidOf(req);
      if (!uid) { rejectNoUid(res); return; }
      // 服务端必须自己记住「今天签过了」：此前只靠前端 localStorage 判断，
      // 循环调这个接口就能无限领积分（每次 100），等于给算力开了免费水龙头。
      const today = localDate();
      const user = getUser(uid);
      if (user && user.lastCheckin === today) {
        sendJson(res, 200, 40002, '今日已签到，明天再来', {
          reward: 0,
          alreadyCheckin: true,
          totalPoints: creditStore.getBalance(uid),
          paidPoints: creditStore.getPaidBalance(uid),
          freePoints: creditStore.getFreeBalance(uid),
        });
        return;
      }
      const checkinReward = Number(getAdminSiteConfig()?.ops?.checkinPoints) || 100;
      const resData = creditStore.grantFreeCredits(uid, checkinReward, '商户每日签到入账 (运营补贴/不可退款)');
      try { updateUser(uid, { lastCheckin: today }); } catch (_) { }
      sendJson(res, 200, 0, `签到成功，已入账 ${checkinReward} 算力积分`, {
        reward: checkinReward,
        alreadyCheckin: false,
        totalPoints: resData.balance,
        paidPoints: creditStore.getPaidBalance(uid),
        freePoints: creditStore.getFreeBalance(uid),
      });
    }).catch(() => { });
    return;
  }

  // 2.1 获取全站公开配置（含商业样片案例、FAQ、法律条款）
  if (pathname === '/api/v1/site-config' || pathname === '/api/site-config') {
    const config = getAdminSiteConfig();
    sendJson(res, 200, 0, '获取站点配置成功', config);
    return;
  }

  // 3. 金牌音色列表
  if (pathname === '/api/v1/voices') {
    sendJson(res, 200, 0, '获取音色列表成功', {
      voices: [
        { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 · 亲切带货女声', gender: 'female', desc: '温柔生动，适合美妆、服饰与美食' },
        { id: 'zh-CN-YunyangNeural', name: '云扬 · 沉稳商业男声', gender: 'male', desc: '大气磁性，适合科技、汽车与高端好物' },
        { id: 'zh-CN-YunxiNeural', name: '云希 · 活力阳光男声', gender: 'male', desc: '青春热情，适合潮流好物与探店推荐' }
      ]
    });
    return;
  }

  // 3.2 已登记素材安全列表与详情（支持租户 Session 隔离，杜绝跨商户偷窥素材）
  if (pathname === '/api/v1/materials' && req.method === 'GET') {
    const typeFilter = urlObj.searchParams.get('type') || '';
    const reqSessionId = String(req.headers['x-session-id'] || '').trim();
    const materials = listRegisteredMaterials(typeFilter, reqSessionId);
    sendJson(res, 200, 0, '获取素材列表成功', { materials, count: materials.length });
    return;
  }
  if (pathname.startsWith('/api/v1/materials/') && req.method === 'GET') {
    const materialId = pathname.replace('/api/v1/materials/', '').trim();
    const reqSessionId = String(req.headers['x-session-id'] || '').trim();
    const material = getRegisteredMaterial(materialId, reqSessionId);
    if (!material) {
      sendJson(res, 404, 40401, '素材不存在或已过期');
      return;
    }
    sendJson(res, 200, 0, '获取素材详情成功', material);
    return;
  }

  // 3.5 商品实拍图上传 (前端压缩后以 dataURL 提交，1~9 张，落盘 storage/uploads 供引擎直接消费)
  if (pathname === '/api/v1/upload/images' && req.method === 'POST') {
    const MAX_IMAGES_BODY_BYTES = 30 * 1024 * 1024; // 30MB 硬门禁：杜绝超大 Base64 打爆 Node.js 内存 (OOM DoS 防御)
    let body = '';
    let bodyLen = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      bodyLen += chunk.length;
      if (bodyLen > MAX_IMAGES_BODY_BYTES) {
        aborted = true;
        req.destroy();
        sendJson(res, 413, 40010, '上传图片数据超出 30MB 大小限制');
        return;
      }
      body += chunk;
    });

    req.on('end', async () => {
      if (aborted) return;
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (e) { }

      const images = Array.isArray(payload.images) ? payload.images : [];
      const sessionId = String(req.headers['x-session-id'] || payload.sessionId || '').trim();

      // 严格锁定 1~9 张，超出即硬拦截
      if (images.length < 1 || images.length > 9) {
        sendJson(res, 400, 40001, images.length > 9 ? '商品实拍图锁定最多 9 张，已超出限制' : '请至少上传 1 张商品实拍图');
        return;
      }

      // dataURL 格式校验：仅允许 jpeg / jpg / png / webp，并解码为 Buffer
      const dataUrlRegex = /^data:image\/(jpeg|jpg|png|webp);base64,/;
      const decodedImages = [];
      for (let i = 0; i < images.length; i++) {
        const item = typeof images[i] === 'string' ? images[i].trim() : '';
        const match = item.match(dataUrlRegex);
        if (!match) {
          sendJson(res, 400, 40002, `第 ${i + 1} 张图片格式不合法，仅支持 JPG / PNG / WebP`);
          return;
        }
        const rawExt = match[1].toLowerCase();
        const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
        let buffer;
        try {
          buffer = Buffer.from(item.slice(match[0].length), 'base64');
        } catch (e) {
          buffer = null;
        }
        if (!buffer || buffer.length === 0) {
          sendJson(res, 400, 40003, `第 ${i + 1} 张图片解码失败或内容为空`);
          return;
        }
        decodedImages.push({ ext, buffer });
      }

      // 落盘：storage/uploads/upload_{时间戳}/img_{序号}.{原扩展名}
      const uploadDir = path.join(storageUploadsDir, `upload_${Date.now()}`);
      try {
        fs.mkdirSync(uploadDir, { recursive: true });
      } catch (e) {
        sendJson(res, 500, 50001, '上传目录创建失败，请检查 storage 目录权限');
        return;
      }

      const imagePaths = [];      // 归一化副本（下游背景分析/视觉引擎/合成统一消费）
      const originalPaths = [];   // 原始上传文件（保留追溯与高清预览）
      const materialIds = [];
      try {
        const normDir = path.join(uploadDir, 'norm');
        const results = await Promise.all(
          decodedImages.map(async (item, i) => {
            const filePath = path.join(uploadDir, `img_${i + 1}.${item.ext}`);
            fs.writeFileSync(filePath, item.buffer);
            // 归一化：按 cover 1080×1920 的最小尺寸生成副本；失败静默回退原图，绝不阻断上传
            let servedPath = filePath;
            try {
              const normPath = await normalizeImageForPipeline(
                item.buffer,
                normDir,
                `img_${i + 1}.jpg`,
              );
              if (normPath) servedPath = normPath;
            } catch (normErr) {
              console.warn('[JANSEE GATEWAY] 图片归一化失败(回退原图):', normErr.message);
            }
            let matId = '';
            try {
              matId = registerMaterial({
                type: 'image',
                filePath: servedPath,
                durationSec: 5.0,
                sessionId,
              }, sessionId);
            } catch (matErr) {
              console.warn('[JANSEE GATEWAY] 图片素材登记警告:', matErr.message);
            }
            return { filePath, servedPath, matId };
          })
        );
        for (const r of results) {
          originalPaths.push(r.filePath);
          imagePaths.push(r.servedPath);
          if (r.matId) materialIds.push(r.matId);
        }
      } catch (e) {
        sendJson(res, 500, 50002, '图片落盘失败，请稍后重试');
        return;
      }

      console.log(`[JANSEE GATEWAY] 商品实拍图上传落盘成功 ${imagePaths.length} 张: ${uploadDir} (Session: ${sessionId || 'anon'})`);
      sendJson(res, 200, 0, '上传成功', { imagePaths, materialIds, uploadDir, originalPaths });
    });
    return;
  }

  // 3.6 视频配音素材上传 (binary 直传流式落盘，落盘即探测真实媒体时长，探测失败一律拒绝并清理，不伪造时长)
  if (pathname === '/api/v1/upload/video' && req.method === 'POST') {
    const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200MB 上限（4核4G 内存约束下的保守值，流式落盘不占内存）
    const rawName = String(req.headers['x-file-name'] || '').trim();
    const ext = path.extname(rawName).toLowerCase();
    if (ext !== '.mp4' && ext !== '.mov') {
      sendJson(res, 400, 40004, '视频格式不合法，仅支持 MP4 / MOV');
      req.resume(); // 丢弃残余请求体，保持连接干净关闭
      return;
    }
    const contentLength = Number(req.headers['content-length'] || 0);
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      sendJson(res, 400, 40005, '请求缺少视频文件内容');
      return;
    }
    if (contentLength > MAX_VIDEO_BYTES) {
      sendJson(res, 413, 40006, '视频文件超出 200MB 大小上限');
      req.resume();
      return;
    }

    const uploadDir = path.join(storageUploadsDir, `upload_${Date.now()}`);
    try {
      fs.mkdirSync(uploadDir, { recursive: true });
    } catch (e) {
      sendJson(res, 500, 50003, '上传目录创建失败，请检查 storage 目录权限');
      return;
    }
    const filePath = path.join(uploadDir, `video${ext}`);
    const ws = fs.createWriteStream(filePath);
    let received = 0;
    let settled = false;
    let magicChecked = false;
    let headBuf = Buffer.alloc(0);
    const cleanup = () => { try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch (e) { } };

    // 弱网断流防护：30 秒未传输数据自动掐断并回收文件句柄
    req.setTimeout(30000, () => {
      if (!settled) {
        settled = true;
        req.destroy();
        ws.destroy();
        cleanup();
        sendJson(res, 408, 40009, '视频上传网络连接超时，已自动清理');
      }
    });

    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_VIDEO_BYTES) {
        settled = true;
        req.destroy();
        ws.destroy();
        cleanup();
        sendJson(res, 413, 40006, '视频文件超出 200MB 大小上限');
        return;
      }

      // 文件头魔数嗅探 (Magic Bytes)：前 16 字节验真，杜绝木马/伪装文件落盘
      if (!magicChecked) {
        headBuf = Buffer.concat([headBuf, chunk]);
        if (headBuf.length >= 16) {
          magicChecked = true;
          const magicStr = headBuf.slice(4, 12).toString('latin1');
          const isRealVideo = magicStr.includes('ftyp') || magicStr.includes('moov') || magicStr.includes('mdat') || magicStr.includes('wide');
          if (!isRealVideo) {
            settled = true;
            req.destroy();
            ws.destroy();
            cleanup();
            sendJson(res, 400, 40011, '文件格式与扩展名不匹配：检测到非合法 MP4 / MOV 媒体内容');
            return;
          }
        }
      }
    });
    req.on('error', () => {
      if (settled) return;
      settled = true;
      ws.destroy();
      cleanup();
      sendJson(res, 500, 50004, '视频接收中断，请重试');
    });
    ws.on('error', () => {
      if (settled) return;
      settled = true;
      req.destroy();
      cleanup();
      sendJson(res, 500, 50005, '视频落盘失败，请检查磁盘空间');
    });
    req.on('end', () => {
      if (settled) return;
      ws.end(() => {
        if (settled) return;
        settled = true;
        // 落盘即探测真实媒体时长：容器 Duration 解析失败或零值一律拒绝，绝不让异常时长流入导演层
        let durationSec = 0;
        try { durationSec = videoDurationSec(filePath); } catch (e) { durationSec = 0; }
        if (!Number.isFinite(durationSec) || durationSec <= 0) {
          cleanup();
          sendJson(res, 400, 40007, '无法解析视频真实时长：文件可能已损坏或编码格式不受支持');
          return;
        }

        // 时长硬门禁：双向闭环 2.0 秒 ≤ 时长 ≤ 180 秒，杜绝超短畸形视频导致转码负数公式崩溃
        const MIN_VIDEO_DURATION_SEC = 2.0;
        const MAX_VIDEO_DURATION_SEC = 180.0;
        if (durationSec < MIN_VIDEO_DURATION_SEC) {
          cleanup();
          sendJson(res, 400, 40012, `视频时长过短（至少需要 ${MIN_VIDEO_DURATION_SEC.toFixed(1)} 秒，当前 ${durationSec.toFixed(1)} 秒），请重新录制`);
          return;
        }
        if (durationSec > MAX_VIDEO_DURATION_SEC) {
          cleanup();
          sendJson(res, 400, 40008, `视频时长超出 3 分钟限制（当前 ${durationSec.toFixed(1)} 秒），请剪辑后再上传`);
          return;
        }

        const sessionId = String(req.headers['x-session-id'] || '').trim();
        let materialId = '';
        try {
          materialId = registerMaterial({
            type: 'upload_video',
            filePath,
            durationSec,
            sessionId,
          }, sessionId);
        } catch (e) {
          console.warn('[JANSEE GATEWAY] 素材登记警告:', e.message);
        }
        console.log(`[JANSEE GATEWAY] 视频素材上传落盘成功: ${filePath} (${durationSec.toFixed(2)}s, mat: ${materialId}, Session: ${sessionId || 'anon'})`);
        sendJson(res, 200, 0, '上传成功', { videoPath: filePath, uploadDir, durationSec, materialId });
      });
    });
    req.pipe(ws);
    return;
  }

  // 4. 旧链路出片端点彻底下线（已全面升级为 /api/v1/creation/create 统一模块化创作任务中心）
  if ((pathname === '/api/v1/video/produce' || pathname === '/api/v1/video/produce/product') && req.method === 'POST') {
    sendJson(res, 410, 41001, '旧版出片接口已彻底下线，请升级至 /api/v1/creation/create 统一创作编排模块');
    return;
  }

  // 4.5 口播视频模块：两段式 analyze（本地 ASR + 冗余标记）→ 用户确认 → produce（音画同步剪切合成）
  //     任务态复用 inMemoryTasks（kind='speechcut'），进度轮询走同一 GET /api/v1/video/task/:taskId 端点
  if (pathname === '/api/v1/speech/analyze' && req.method === 'POST') {
    safeReadJson(req, res).then((payload) => {
      try {
        const r = startSpeechAnalyze({ payload, inMemoryTasks, storageUploadsDir, storageOutputsDir });
        sendJson(res, 200, 0, '口播分析任务已创建', r);
      } catch (e) {
        sendJson(res, e.code === 40401 ? 404 : e.code === 40901 || e.code === 40902 ? 409 : 400, e.code || 40000, e.message || '口播分析任务创建失败');
      }
    }).catch(() => { });
    return;
  }
  if (pathname === '/api/v1/speech/produce' && req.method === 'POST') {
    safeReadJson(req, res).then((payload) => {
      try {
        // 计费：与 /api/v1/creation/create 同口径（每次出片 200 积分，统一价不分版块），
        // 真实扣减用户 creditStore 账本（taskId 幂等防重扣），余额不足抛 402 阻断受理；
        // failed 重试/409 重复提交由任务级 creditsCharged 拦截，不重扣
        const uid = sessionUidOf(req);
        const r = startSpeechProduce({
          taskId: payload.taskId,
          deletedStarts: payload.deletedStarts,
          wordEdits: payload.wordEdits,
          introTitle: payload.introTitle,
          inMemoryTasks,
          storageOutputsDir,
          userId: uid,
          chargeMockCredits: () => {
            chargeForEntry({ pathname: '/api/v1/speech/produce', userId: uid, taskId: payload.taskId, store: creditStore });
          },
        });
        sendJson(res, 200, 0, '口播生成任务已受理', r);
      } catch (e) {
        sendJson(res, e.code === 40201 ? 402 : e.code === 40401 ? 404 : e.code === 40901 || e.code === 40902 ? 409 : 400, e.code || 40000, e.message || '口播生成任务创建失败');
      }
    }).catch(() => { });
    return;
  }

  // 4.6.1 极简时间起止点切片：仅限用户输入起止时间精准截取并直出 MP4
  if (pathname === '/api/v1/slice/cut' && req.method === 'POST') {
    safeReadJson(req, res).then((payload) => {
      try {
        const r = startExactSliceCut({
          payload,
          inMemoryTasks,
          storageUploadsDir,
          storageOutputsDir,
        });
        sendJson(res, 200, 0, '切片截取任务已创建', r);
      } catch (e) {
        sendJson(res, e.code === 40301 ? 403 : e.code === 40401 ? 404 : 400, e.code || 40000, e.message || '切片任务创建失败');
      }
    }).catch(() => { });
    return;
  }

  // 4.85 分镜成片 · 原片直出两段式：逐段 ASR 冗余/停顿标记 → 用户按段确认 → 逐段剪除 + 叠化拼接
  //      任务态 kind='storyboard_direct'，轮询走同一 GET /api/v1/video/task/:taskId 端点
  if (pathname === '/api/v1/storyboard/direct/analyze' && req.method === 'POST') {
    safeReadJson(req, res).then((payload) => {
      try {
        const r = startStoryboardDirectAnalyze({ payload, inMemoryTasks, storageUploadsDir, storageOutputsDir });
        sendJson(res, 200, 0, '分镜直出分析任务已创建', r);
      } catch (e) {
        sendJson(res, e.code === 40301 ? 403 : e.code === 40401 ? 404 : 400, e.code || 40000, e.message || '分镜直出分析任务创建失败');
      }
    }).catch(() => { });
    return;
  }
  if (pathname === '/api/v1/storyboard/direct/produce' && req.method === 'POST') {
    safeReadJson(req, res).then((payload) => {
      try {
        // 计费：与 /api/v1/creation/create 同口径（每次出片 200 积分，统一价不分版块），
        // 真实扣减用户 creditStore 账本（taskId 幂等防重扣），余额不足抛 402 阻断受理
        const uid = sessionUidOf(req);
        const r = startStoryboardDirectProduce({
          taskId: payload.taskId,
          title: payload.title,
          selections: payload.selections,
          inMemoryTasks,
          storageOutputsDir,
          userId: uid,
          chargeMockCredits: () => {
            chargeForEntry({ pathname: '/api/v1/storyboard/direct/produce', userId: uid, taskId: payload.taskId, store: creditStore });
          },
        });
        sendJson(res, 200, 0, '分镜直出生成任务已受理', r);
      } catch (e) {
        sendJson(res, e.code === 40201 ? 402 : e.code === 40401 ? 404 : e.code === 40901 || e.code === 40902 ? 409 : 400, e.code || 40000, e.message || '分镜直出生成任务创建失败');
      }
    }).catch(() => { });
    return;
  }

  // =========================================================================
  // [非当前阶段内容说明] 用户体系 / 商业化闭环 / 管理后台相关端点
  // 遵循当前阶段范围控制：只保留既有实现，停止扩展，不影响核心视频生产链路
  // =========================================================================

  // 4.8.9 推广二维码（服务端直出 PNG）
  // 为什么放服务端：客户端画真二维码需要引入编码库（~20KB）或走 CDN，前者要加打包链、
  // 后者在国内不可靠。服务端生成只需一个 HTTP 请求，且缓存后可复用。
  // 安全约束：这是「公开可访问的图片接口」，绝不能变成任意文本二维码生成器
  // （可被拿去批量生成钓鱼码），因此只接受白名单域名下的 http(s) 链接。
  if (pathname === '/api/v1/invite/qrcode' && req.method === 'GET') {
    const raw = String(urlObj.searchParams.get('link') || '').slice(0, 512);
    let parsed = null;
    try {
      parsed = new URL(raw);
    } catch (_) { }
    const qrHost = parsed ? parsed.hostname.toLowerCase() : '';
    const hostOk =
      /^(.*\.)?jansee\.cn$/.test(qrHost) || qrHost === 'localhost' || qrHost === '127.0.0.1' || qrHost === '0.0.0.0';
    if (!parsed || !/^https?:$/.test(parsed.protocol) || !hostOk) {
      sendJson(res, 400, 40001, '二维码链接不合法');
      return;
    }
    QRCode.toBuffer(raw, {
      type: 'png',
      width: 640,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000ff', light: '#ffffffff' },
    })
      .then((png) => {
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': png.length,
          // 同一链接的码永远一样，长缓存省掉重复生成
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(png);
      })
      .catch((err) => {
        console.error('[QR] 生成失败：' + (err && err.message));
        sendJson(res, 500, 50001, '二维码生成失败');
      });
    return;
  }

  // 4.9 用户注册：已下线（2026-10-28）
  // 这个接口原先只要给一个手机号就建号 + 发注册积分 + 签发会话，**不校验任何验证码**，
  // 等于「随便报 11 位数字就能无限领 600 积分白刷算力」。登录接口（/auth/login）
  // 本身就会在验证码通过后自动建号并赠送注册积分，功能完全重合，因此这里直接拒绝。
  if (pathname === '/api/v1/user/register' && req.method === 'POST') {
    sendJson(res, 403, 40301, '注册已并入验证码登录：请先获取短信验证码，再调用 /api/v1/auth/login 完成注册登录');
    return;
  }

  // —— 短信验证码消费（唯一实现）：验证码登录与「忘记密码重置」共用同一份校验 ——
  // 抽成函数的原因：两份校验一旦分叉，最容易漏掉的是 fails 计数与次数上限，
  // 那正好是防爆破的唯一闸门。这里保持与原登录内联逻辑逐条等价。
  async function consumeSmsCode(phone, code) {
    const rec = smsCodes.get(phone);
    const status = smsStatus();

    if (status.mock) {
      // 本地联调：验证码存在本进程内
      if (!rec || !rec.expireAt || Date.now() > rec.expireAt) {
        smsCodes.delete(phone);
        return { ok: false, status: 401, code: 40102, msg: '验证码已过期，请重新获取' };
      }
      if ((rec.fails || 0) >= SMS_MAX_TRIES) {
        smsCodes.delete(phone);
        return { ok: false, status: 429, code: 42902, msg: '验证码错误次数过多，请重新获取' };
      }
      if (code.length !== 6 || code !== rec.code) {
        rec.fails = (rec.fails || 0) + 1;
        return { ok: false, status: 401, code: 40103, msg: '验证码不正确' };
      }
      smsCodes.delete(phone);
      return { ok: true };
    }

    // 真实通道：验证码由阿里云托管，本服务只转发校验结果
    if (!status.ready) {
      return { ok: false, status: 503, code: 50301, msg: status.reason || '短信通道未就绪，请联系管理员' };
    }
    if (!rec) {
      return { ok: false, status: 401, code: 40102, msg: '验证码已过期，请重新获取' };
    }
    if ((rec.fails || 0) >= SMS_MAX_TRIES) {
      smsCodes.delete(phone);
      return { ok: false, status: 429, code: 42902, msg: '验证码错误次数过多，请重新获取' };
    }
    if (code.length !== 6) {
      rec.fails = (rec.fails || 0) + 1;
      return { ok: false, status: 401, code: 40103, msg: '验证码不正确' };
    }
    let checked;
    try {
      checked = await checkVerifyCode(phone, code);
    } catch (e) {
      console.error('[SMS] 校验异常：' + (e && e.message));
      return { ok: false, status: 502, code: 50202, msg: '短信服务暂时不可用，请稍后重试' };
    }
    if (!checked.ok) {
      return { ok: false, status: 502, code: 50202, msg: checked.message || '验证码校验失败，请稍后重试' };
    }
    if (!checked.passed) {
      rec.fails = (rec.fails || 0) + 1;
      return { ok: false, status: 401, code: 40103, msg: '验证码不正确' };
    }
    smsCodes.delete(phone);
    return { ok: true };
  }

  // 4.9.1 下发登录验证码（阿里云号码认证托管 · 同号 60 秒频控）
  if (pathname === '/api/v1/auth/send-code' && req.method === 'POST') {
    safeReadJson(req, res).then(async (payload) => {
      const phone = normPhone(payload && payload.phone);
      if (!/^1\d{10}$/.test(phone)) {
        sendJson(res, 400, 40001, '手机号格式不正确，请输入 11 位大陆手机号');
        return;
      }
      const now = Date.now();
      const prev = smsCodes.get(phone);
      if (prev && now - prev.sentAt < SMS_RESEND_MS) {
        const wait = Math.ceil((SMS_RESEND_MS - (now - prev.sentAt)) / 1000);
        sendJson(res, 429, 42901, `请求过于频繁，请 ${wait} 秒后重试`, { retryAfter: wait });
        return;
      }

      const status = smsStatus();
      if (!status.ready) {
        // 通道没配好时宁可报错，也不能提示"已发送"骗用户
        console.error('[SMS] 通道不可用：' + (status.reason || '未知原因'));
        sendJson(res, 503, 50301, status.reason || '短信通道未就绪，请联系管理员');
        return;
      }

      // IP 级配额（真实通道才消耗；mock 不发短信，不浪费额度）
      if (!status.mock) {
        const wait = consumeSmsIpQuota(clientIpOf(req));
        if (wait > 0) {
          sendJson(res, 429, 42901, `当前网络请求短信过于频繁，请 ${wait} 秒后重试`, { retryAfter: wait });
          return;
        }
      }

      if (status.mock) {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        smsCodes.set(phone, { code, expireAt: now + SMS_TTL_MS, sentAt: now, fails: 0 });
        console.log(`[SMS-MOCK] ${phone} 验证码 ${code}（JX_AUTH_TEST=1，仅本地联调）`);
        sendJson(res, 200, 0, '验证码已下发（mock）', {
          channel: 'mock',
          devCode: code,
          ttl: Math.floor(SMS_TTL_MS / 1000),
        });
        return;
      }

      try {
        const sent = await sendVerifyCode(phone);
        if (!sent.ok) {
          sendJson(res, 502, 50201, sent.message || '短信下发失败，请稍后重试');
          return;
        }
        // 真实通道下本地只记频控时间，验证码由阿里云托管，本进程不持有明文
        smsCodes.set(phone, { sentAt: now, fails: 0 });
        const validMin = Math.max(1, Number(process.env.JX_SMS_VALID_MIN) || 10);
        sendJson(res, 200, 0, '验证码已发送至手机', {
          channel: sent.provider,
          ttl: validMin * 60,
          requestId: sent.requestId || '',
        });
      } catch (e) {
        console.error('[SMS] 下发异常：' + (e && e.message));
        sendJson(res, 502, 50201, '短信服务暂时不可用，请稍后重试');
      }
    }).catch(() => { });
    return;
  }

  // 4.9.2 验证码登录（未注册手机号验证通过后自动建号并赠送注册积分）
  if (pathname === '/api/v1/auth/login' && req.method === 'POST') {
    safeReadJson(req, res).then(async (payload) => {
      const phone = normPhone(payload && payload.phone);
      const code = String((payload && payload.code) || '').replace(/\D/g, '');
      if (!/^1\d{10}$/.test(phone)) {
        sendJson(res, 400, 40001, '手机号格式不正确，请输入 11 位大陆手机号');
        return;
      }

      const sms = await consumeSmsCode(phone, code);
      if (!sms.ok) {
        sendJson(res, sms.status, sms.code, sms.msg);
        return;
      }

      try {
        const existed = getUser(phone);
        if (existed && existed.status && existed.status !== 'active') {
          sendJson(res, 403, 40301, '账号已被停用，请联系客服');
          return;
        }
        // 邀请人：来自前端海报链接携带的 invite 参数（?invite=uid），仅在新建用户时绑定
        const inviterRaw = String(payload && payload.inviter || '').trim();
        let user = existed;
        if (!user) {
          const clientIp = clientIpOf(req);
          const registerRegion = parseIpRegion(clientIp);
          const rawChannel = String((payload && (payload.channel || payload.utmSource)) || '').trim();
          const rawReferrer = String((payload && payload.referrer) || req.headers.referer || '').trim();
          let resolvedChannel = parseChannelSource(rawReferrer, rawChannel);
          if (inviterRaw && (!rawChannel || rawChannel === '直接访问')) {
            resolvedChannel = `好友邀请 (${inviterRaw})`;
          }
          user = createUser({
            phone,
            inviterUid: inviterRaw,
            registerIp: clientIp,
            registerRegion,
            channel: resolvedChannel,
          });
        }
        if (!existed) {
          const signupPoints = Math.max(0, Number(getAdminSiteConfig()?.ops?.signupPoints) || 0);
          creditStore.createCreditAccount(user.userId, 0);
          if (signupPoints > 0) {
            creditStore.grantFreeCredits(user.userId, signupPoints, '新用户注册赠送积分');
          }
          // 邀请人积分奖励：好友真实注册后，邀请人 +inviteReward（creditStore 自动开户，与 createLegacyUser 口径一致）
          const inviterPhone = user.inviterPhone;
          if (inviterPhone) {
            // 注册用户均为 S8 用户（s8UsersMap），findUserByPhone 只查 legacy db.users 会漏掉，
            // 必须用 getUser() 双表合并查询，否则邀请奖励积分发不出去。
            const inviter = getUser(inviterPhone) || findUserByPhone(inviterPhone);
            if (inviter) {
              const inviterUid = inviter.userId || inviter.id;
              const inviteReward = Math.max(0, Number(getAdminSiteConfig()?.ops?.inviteReward) || 0);
              if (inviteReward > 0) {
                creditStore.grantFreeCredits(inviterUid, inviteReward, '邀请好友注册奖励积分');
              }
            }
          }
        }
        const sessionToken = createSession(user.userId);
        setSessionCookie(res, sessionToken);
        const balance = creditStore.getBalance(user.userId);
        sendJson(res, 200, 0, existed ? '登录成功' : '注册并登录成功', {
          userId: user.userId,
          sessionToken,
          phone: user.phone,
          nickname: user.nickname,
          points: balance,
          isNewUser: !existed,
          // 让前端决定是否弹出「设置密码」引导：已设过密码就不再打扰
          needsPassword: !hasPassword(user.userId),
        });
      } catch (err) {
        sendJson(res, 500, 50001, err.message || '登录失败');
      }
    }).catch(() => { });
    return;
  }

  // 4.9.3.1 密码登录（手机号 + 密码）
  // 定位：验证码登录是主链路，密码登录是便捷通道。安全性依赖三点——
  //   ① scrypt 哈希比对（verifyPassword 内部恒定时间比较）
  //   ② 账号级失败锁定（5 次错 → 锁 10 分钟）。IP 限频挡不住换 IP 的撞库，
  //      必须按账号计数；成功登录即清零，避免正常用户被历史失败拖累。
  //   ③ 错误文案不区分「手机号未注册 / 密码错误」，避免被当成注册用户枚举接口。
  if (pathname === '/api/v1/auth/login-password' && req.method === 'POST') {
    safeReadJson(req, res).then(async (payload) => {
      const phone = normPhone(payload && payload.phone);
      const password = String((payload && payload.password) || '');
      if (!/^1\d{10}$/.test(phone)) {
        sendJson(res, 400, 40001, '手机号格式不正确，请输入 11 位大陆手机号');
        return;
      }
      if (!password) {
        sendJson(res, 400, 40002, '请输入密码');
        return;
      }

      const lock = pwdFails.get(phone);
      if (lock && lock.lockUntil > Date.now()) {
        const mins = Math.ceil((lock.lockUntil - Date.now()) / 60000);
        sendJson(res, 429, 42903, `密码错误次数过多，请 ${mins} 分钟后再试，或改用短信验证码登录`);
        return;
      }

      const rec = getUserAuthRecord(phone) || getUserAuthRecord(getUser(phone)?.userId || '');
      if (!rec || !rec.passwordHash) {
        // 与密码错误同一条文案（见上 ③）
        sendJson(res, 401, 40104, '手机号或密码不正确');
        return;
      }
      if (!verifyPassword(rec, password)) {
        const prev = pwdFails.get(phone) || { count: 0, lockUntil: 0 };
        const count = prev.count + 1;
        pwdFails.set(phone, {
          count,
          lockUntil: count >= PWD_MAX_TRIES ? Date.now() + PWD_LOCK_MS : 0,
        });
        const left = PWD_MAX_TRIES - count;
        sendJson(
          res,
          401,
          40104,
          left > 0 ? `手机号或密码不正确，还可尝试 ${left} 次` : '密码错误次数过多，账号已锁定 10 分钟',
        );
        return;
      }

      pwdFails.delete(phone);

      try {
        const existed = getUser(phone);
        if (existed && existed.status && existed.status !== 'active') {
          sendJson(res, 403, 40301, '账号已被停用，请联系客服');
          return;
        }
        const user = existed || rec;
        const userId = user.userId || user.id;
        const sessionToken = createSession(userId);
        setSessionCookie(res, sessionToken);
        const balance = creditStore.getBalance(userId);
        sendJson(res, 200, 0, '登录成功', {
          userId,
          sessionToken,
          phone: user.phone,
          nickname: user.nickname,
          points: balance,
          isNewUser: false,
          needsPassword: false,
        });
      } catch (err) {
        sendJson(res, 500, 50001, err.message || '登录失败');
      }
    }).catch(() => { });
    return;
  }

  // 4.9.3.2 设置 / 修改密码（需登录态）
  // 首次设置：任何已登录用户可直接设置（刚用验证码证明过手机号归属）。
  // 已设过密码再改：必须提供旧密码，避免会话被劫持后直接改密锁死账号。
  if (pathname === '/api/v1/auth/password' && req.method === 'POST') {
    const session = verifySession(extractSessionToken(req));
    if (!session) {
      sendJson(res, 401, 40101, '请先登录');
      return;
    }
    safeReadJson(req, res).then(async (payload) => {
      const password = String((payload && payload.password) || '');
      const oldPassword = String((payload && payload.oldPassword) || '');
      const issue = passwordIssue(password);
      if (issue) {
        sendJson(res, 400, 40002, issue);
        return;
      }
      const rec = getUserAuthRecord(session.userId);
      if (!rec) {
        sendJson(res, 404, 40401, '账号不存在');
        return;
      }
      const wasSet = !!rec.passwordHash;
      if (wasSet) {
        if (!oldPassword) {
          sendJson(res, 400, 40003, '请输入当前密码');
          return;
        }
        if (!verifyPassword(rec, oldPassword)) {
          sendJson(res, 401, 40105, '当前密码不正确');
          return;
        }
        if (oldPassword === password) {
          sendJson(res, 400, 40004, '新密码不能与当前密码相同');
          return;
        }
      }
      const ok = setUserPassword(session.userId, password);
      if (!ok) {
        sendJson(res, 500, 50001, '密码保存失败，请重试');
        return;
      }
      sendJson(res, 200, 0, wasSet ? '密码已更新' : '密码设置成功', { needsPassword: false });
    }).catch(() => { });
    return;
  }

  // 4.9.3.3 忘记密码：短信验证码验证身份后重置（无需登录态）
  // 没有这条通道，密码就是单向陷阱——忘记即永久锁死。与登录共用 consumeSmsCode，
  // 因此同样受「60 秒频控 / 5 次错误上限 / 验证码一次性消费」约束。
  if (pathname === '/api/v1/auth/password/reset' && req.method === 'POST') {
    safeReadJson(req, res).then(async (payload) => {
      const phone = normPhone(payload && payload.phone);
      const code = String((payload && payload.code) || '').replace(/\D/g, '');
      const password = String((payload && payload.password) || '');
      if (!/^1\d{10}$/.test(phone)) {
        sendJson(res, 400, 40001, '手机号格式不正确，请输入 11 位大陆手机号');
        return;
      }
      const issue = passwordIssue(password);
      if (issue) {
        sendJson(res, 400, 40002, issue);
        return;
      }
      const sms = await consumeSmsCode(phone, code);
      if (!sms.ok) {
        sendJson(res, sms.status, sms.code, sms.msg);
        return;
      }
      const user = getUser(phone);
      const userId = user?.userId || '';
      if (!userId || !getUserAuthRecord(userId)) {
        sendJson(res, 404, 40401, '该手机号尚未注册，请先注册');
        return;
      }
      const ok = setUserPassword(userId, password);
      if (!ok) {
        sendJson(res, 500, 50001, '密码重置失败，请重试');
        return;
      }
      pwdFails.delete(phone);
      sendJson(res, 200, 0, '密码已重置，请用新密码登录', { needsPassword: false });
    }).catch(() => { });
    return;
  }

  // 4.9.3 退出登录：服务端销毁会话
  // 只清浏览器 localStorage 是不够的——token 在 24 小时有效期内仍可被重放，
  // 尤其是在公共设备上退出后。这里把会话从服务端注销。
  if (pathname === '/api/v1/auth/logout' && req.method === 'POST') {
    const token = extractSessionToken(req);
    const ok = token ? destroySession(token) : false;
    clearSessionCookie(res);
    sendJson(res, 200, 0, '已退出登录', { ok });
    return;
  }

  // 4.10 S8 用户体系与商业化闭环：查询用户积分余额与流水
  if (pathname === '/api/v1/user/credits' && req.method === 'GET') {
    const token = extractSessionToken(req);
    const session = verifySession(token);
    if (!session) {
      sendJson(res, 401, 40101, '未登录或登录已失效，请重新登录');
      return;
    }

    const balance = creditStore.getBalance(session.userId);
    const transactions = creditStore.listTransactions(session.userId);
    sendJson(res, 200, 0, '查询成功', { balance, transactions });
    return;
  }

  // 4.11 S6/S7/S8 统一视频创作编排层：POST /api/v1/creation/create 与 GET /api/v1/creation/task/:taskId
  if (pathname === '/api/v1/creation/create' && req.method === 'POST') {
    safeReadJson(req, res).then((payload) => {
      // 安全注入：身份只认登录会话。客户端提交的 userId / uid / user 一律丢弃后覆盖，
      // 否则换个 payload.userId 就能用别人的余额扣费、把任务记到别人名下。
      const token = extractSessionToken(req) || payload.sessionToken;
      const session = verifySession(token);
      if (!session) {
        sendJson(res, 401, 40101, '未登录或登录已失效，请重新登录');
        return;
      }
      payload.sessionToken = token;
      payload.user = { userId: session.userId };
      delete payload.userId;
      delete payload.uid;

      try {
        const r = createCreationTask({
          payload,
          inMemoryTasks,
          storageOutputsDir,
          storageUploadsDir,
          materialsDir,
          chargeMockCredits: () => {
            if (currentMockCredits >= 200) {
              currentMockCredits -= 200;
            }
          },
        });
        sendJson(res, 200, 0, '创作任务已创建并启动编排调度', r);
      } catch (e) {
        const statusCode = e.code === 40201 ? 402 : e.code === 40301 ? 403 : e.code === 40401 ? 404 : e.code === 40901 || e.code === 40902 ? 409 : e.code === 40101 ? 401 : 400;
        sendJson(
          res,
          statusCode,
          e.code || 40000,
          e.message || '创作任务创建失败'
        );
      }
    }).catch(() => { });
    return;
  }

  if (pathname.startsWith('/api/v1/creation/task/') && req.method === 'GET') {
    const taskId = pathname.replace('/api/v1/creation/task/', '').trim();
    const memoryTask = inMemoryTasks.get(taskId);
    const task = isCreationTaskExpired(memoryTask) ? null : (memoryTask || getCreationTask(taskId));
    if (!task) {
      if (isCreationTaskExpired(memoryTask)) inMemoryTasks.delete(taskId);
      sendJson(res, 404, 40400, '创作任务不存在或已过期');
      return;
    }
    sendJson(res, 200, 0, '查询成功', task);
    return;
  }

  // S7/S8 创作历史 API：GET /api/v1/creation/history (带用户隔离)
  if (pathname === '/api/v1/creation/history' && req.method === 'GET') {
    // 必须登录：空 userId 传给 listCreationHistory 会退化成「返回全站任务」，等于作品库公开
    const currentUserId = sessionUidOf(req);
    if (!currentUserId) { rejectNoUid(res); return; }

    const typeFilter = urlObj.searchParams.get('type') || '';
    const statusFilter = urlObj.searchParams.get('status') || '';
    const limit = parseInt(urlObj.searchParams.get('limit') || '50', 10);
    const historyList = listCreationHistory({
      userId: currentUserId || undefined,
      type: typeFilter,
      status: statusFilter,
      limit,
    });
    sendJson(res, 200, 0, '查询成功', { tasks: historyList });
    return;
  }

  // 4.9.9 成片视频下载打标上报：POST /api/v1/creation/download
  if (pathname === '/api/v1/creation/download' && req.method === 'POST') {
    safeReadJson(req, res).then((payload) => {
      const taskId = String(payload?.taskId || '').trim();
      const uid = sessionUidOf(req) || String(payload?.userId || '').trim();
      if (taskId) {
        const existing = creationStore.getTask(taskId);
        if (existing) {
          const count = (Number(existing.downloadCount) || 0) + 1;
          creationStore.updateTask(taskId, {
            downloaded: true,
            downloadCount: count,
            downloadedAt: Date.now(),
          });
          const targetUid = existing.userId || uid;
          if (targetUid) recordUserVideoDownloaded(targetUid);
        }
      } else if (uid) {
        recordUserVideoDownloaded(uid);
      }
      sendJson(res, 200, 0, '成片下载记录已更新', { ok: true });
    }).catch(() => { });
    return;
  }

  // 5. 轮询任务进度（合并 creationTask 与输出扁平化的 videoUrl）
  if (pathname.startsWith('/api/v1/video/task/') && req.method === 'GET') {
    const taskId = pathname.replace('/api/v1/video/task/', '').trim();
    // 读取优先级：内存任务是唯一真相源，磁盘档仅作沉淀与重启兜底。
    // 若磁盘档优先，任务首次轮询沉淀的 processing 快照将永久遮蔽内存中后续写入的 analyzed（whisper 完成后轮询死锁，前端永远等不到台词核对）。
    const memoryTask = inMemoryTasks.get(taskId);
    const task = isCreationTaskExpired(memoryTask) ? null : (memoryTask || getCreationTask(taskId));
    if (!task) {
      if (isCreationTaskExpired(memoryTask)) inMemoryTasks.delete(taskId);
      sendJson(res, 404, 40400, '任务不存在或已过期');
      return;
    }

    // 旁路版块失败结算：口播 / 分镜直出由本端点在任务终态翻转时立即退还，不再等 10 分钟僵尸收割。
    // creation 统一链路在 creation.mjs 内部已有独立退款，两处由 creditStore 的 taskId 幂等去重。
    if (task.status === 'failed' && !task.creditsRefunded) {
      const amt = chargedAmountOf(task);
      if (amt > 0 && task.userId) {
        const r = settleFailure({ userId: task.userId, taskId, amount: amt, store: creditStore });
        if (r.ok) {
          task.creditsRefunded = true;
          console.log(`[JANSEE GATEWAY] 任务 ${taskId} 失败，已自动退还用户 ${task.userId} 积分 ${amt}`);
        } else if (r.error) {
          console.warn(`[JANSEE GATEWAY] 任务 ${taskId} 自动退还失败:`, r.error);
        }
      }
    }

    // 实时将内存任务状态同步沉淀到 creationStore，确保经营总览 100% 统计四大专版真实出片
    try {
      const existing = creationStore.getTask(taskId);
      if (existing) {
        if (existing.status !== task.status || task.status === 'completed' || task.status === 'failed') {
          const isJustCompleted = existing.status !== 'completed' && task.status === 'completed';
          creationStore.updateTask(taskId, {
            status: task.status,
            outputs: task.outputs || { video: task.videoUrl, cover: task.coverUrl },
            error: task.error,
            creditsCharged: task.creditsCharged || false,
            creditsRefunded: task.creditsRefunded || false
          });
          if (isJustCompleted && task.userId) {
            recordUserVideoCreated(task.userId);
          }
          // 任务总耗时监控：仅在状态真实翻转时打点（创建 → 翻转后状态），覆盖全部四大专版
          if (existing.status !== task.status) {
            const bornAt = Number(task.createdAt) || Number(existing.createdAt);
            if (Number.isFinite(bornAt) && bornAt > 0) {
              console.log(`[JANSEE GATEWAY] 任务耗时 ${taskId}: ${existing.status} -> ${task.status} 总耗时=${((Date.now() - bornAt) / 1000).toFixed(1)}s`);
            }
          }
        }
      } else {
        creationStore.createTask({
          taskId,
          type: task.kind || task.type || 'video_creator',
          status: task.status || 'producing',
          userId: task.userId || '',
          creditsCharged: task.creditsCharged || false,
          creditsRefunded: task.creditsRefunded || false,
          createdAt: task.createdAt || Date.now(),
          outputs: task.outputs || { video: task.videoUrl, cover: task.coverUrl },
          error: task.error
        });
      }
    } catch (_) { }

    const videoUrl = task.outputs?.video || task.outputs?.videoUrl || task.videoUrl || '';
    const coverUrl = task.outputs?.cover || task.outputs?.coverUrl || task.coverUrl || '';
    sendJson(res, 200, 0, '查询成功', {
      ...task,
      videoUrl,
      coverUrl,
    });
    return;
  }

  // ==========================================
  // S9 管理后台运营控制中心 API (/api/v1/admin/*)
  // ==========================================
  if (handleAdminRoutes(req, res, pathname, urlObj)) {
    return;
  }

  // 13.1 前台商户保存支付宝收款资料：POST /api/v1/partner/profile
  // 双写缺一不可：savePartnerProfile（partnerStore.profiles，后台展示/审核用）+
  // updateWithdrawProfile（用户表存证，置 withdrawProfileReadyAt）。此前漏写用户表，
  // createWithdraw 的 withdrawPayInfo 门禁恒拒「请先完善提现资料」。
  if (pathname === '/api/v1/partner/profile' && req.method === 'POST') {
    safeReadJson(req, res).then((payload) => {
      const uid = sessionUidOf(req);
      if (!uid) { rejectNoUid(res); return; }
      const saved = savePartnerProfile(uid, payload);
      const u = getUser(uid);
      if (u && payload && payload.alipayName && payload.alipayAccount) {
        updateWithdrawProfile(u, {
          alipayName: String(payload.alipayName),
          alipayAccount: String(payload.alipayAccount),
          alipayQr: String(payload.alipayQr || ''),
        });
      }
      sendJson(res, 200, 0, '收款资料已存证保存', saved);
    }).catch(() => { });
    return;
  }

  // 13.2 前台商户获取支付宝收款资料：GET /api/v1/partner/profile
  if (pathname === '/api/v1/partner/profile' && req.method === 'GET') {
    const uid = sessionUidOf(req);
    if (!uid) { rejectNoUid(res); return; }
    const profile = getPartnerProfile(uid);
    sendJson(res, 200, 0, '获取收款资料成功', profile || {});
    return;
  }

  // 13.3 前台商户发起提现申请：POST /api/v1/partner/withdraw
  // CRITICAL-01/04 安全修复：统一走 createWithdraw 正式安全通道（含余额/限额/次数/密码 6 重门禁）
  if (pathname === '/api/v1/partner/withdraw' && req.method === 'POST') {
    // CRITICAL-04 安全修复：强制 session 鉴权，禁止伪造 x-user-id
    const token = extractSessionToken(req);
    const session = verifySession(token);
    if (!session) {
      sendJson(res, 401, 40101, '未登录或登录已失效，请重新登录');
      return;
    }
    safeReadJson(req, res).then((payload) => {
      const uid = session.userId;
      // 密码门禁在路由层真实校验登录密码（此前只信前端传的 passwordVerified 标志，
      // 而前端发的是 pwd 字段，passwordVerified 恒 false → 恒拒「请先完成身份验证」）
      const u = getUser(uid);
      if (!u) { sendJson(res, 401, 40101, '用户不存在'); return; }
      if (!verifyPassword(u, String((payload && payload.pwd) || ''))) {
        sendJson(res, 400, 40001, '身份验证失败：请输入正确的登录密码（未设置密码请先在账号设置中创建）');
        return;
      }
      const resData = createWithdraw({
        userId: uid,
        amount: payload.amount,
        requestId: payload.requestId || '',
        passwordVerified: true,
      });
      if (resData.record) {
        sendJson(res, 200, 0, '提现申请已提交，等待审核打款', resData.record);
      } else {
        sendJson(res, 400, 40001, resData.error || '提现申请未通过');
      }
    }).catch(() => { });
    return;
  }

  // 15.1 前台商户读取站内信列表：GET /api/v1/user/messages
  if (pathname === '/api/v1/user/messages' && req.method === 'GET') {
    // 身份仅取登录会话：未登录（空 uid）只看全站广播信，绝不接受 ?userId= / x-user-id 指定身份
    const uid = sessionUidOf(req);
    const list = messagesFor(uid);
    sendJson(res, 200, 0, '查询成功', { list, count: list.length });
    return;
  }

  // 16.1 商户前台提交反馈：POST /api/v1/user/feedback
  if (pathname === '/api/v1/user/feedback' && req.method === 'POST') {
    safeReadJson(req, res).then((payload) => {
      const fb = addFeedback({
        userId: sessionUidOf(req), // 仅取登录会话；未登录提交则为匿名反馈
        contact: payload.contact || '',
        content: payload.content || '',
        type: payload.type || '意见与改进',
      });
      sendJson(res, 200, 0, '反馈提交成功，感谢您的真实声音', fb);
    }).catch(() => { });
    return;
  }

  // 17. 会员与加油包定价列表 (前台商户读取官方套餐)：GET /api/v1/pricing
  if (pathname === '/api/v1/pricing' && req.method === 'GET') {
    const data = getAdminPricing();
    sendJson(res, 200, 0, '查询成功', data);
    return;
  }

  // 18.1 前台商户创建充值/购买订单：POST /api/v1/order/create
  if (pathname === '/api/v1/order/create' && req.method === 'POST') {
    const uid = sessionUidOf(req);
    if (!uid) { rejectNoUid(res); return; }
    safeReadJson(req, res).then((payload) => {
      // 金额/积分/赠送只认服务端价目表，客户端提交的 amount、points、bonus 全部忽略。
      // kind 也由服务端裁定（'member' | 'points'）：历史上直接把前端 orderType
      // （'membership' / 'boost'）透传给分佣层，而佣金表的键是 'member' / 'points'，
      // 导致会员订单 rate 取不到值、佣金静默不发 —— 本次一并纠正。
      const quote = resolveOrderQuote(payload);
      if (!quote) {
        sendJson(res, 400, 40001, '无法识别的商品：请从官方套餐列表选择，不接受自定义金额或积分数');
        return;
      }
      if (!(quote.amount > 0)) {
        sendJson(res, 400, 40002, '该商品定价异常（金额为 0），已拒绝下单，请管理员核对价目表');
        return;
      }

      const order = createOrder({
        userId: uid,
        pkg: quote.pkg,
        amount: quote.amount,
        points: quote.points,
        bonus: quote.bonus,
        kind: quote.kind,
        tierId: quote.tierId,
        billingMode: payload.billingMode || 'single',
        channel: payload.channel || payload.payChannel || 'alipay',
      });
      sendJson(res, 200, 0, '订单创建成功', { ...order, orderId: order.id });
    }).catch(() => { });
    return;
  }

  // 18.2 商户订单完成支付（收银台确认）：POST /api/v1/order/pay-confirm
  if (pathname === '/api/v1/order/pay-confirm' && req.method === 'POST') {
    safeReadJson(req, res).then((payload) => {
      try {
        // 资金红线：真实支付通道尚未接入，本接口是「收到 orderId 就标记已支付」的模拟入账通道，
        // 不验签、不查单、不校验订单归属，任何人对任意 orderId 调一次即可凭空获得积分/会员/佣金。
        // 默认硬关闭，仅本地联调或自动化测试显式设置 PAY_SIMULATE=1 时放行。
        // 接入真实通道后，入账只允许由「验签通过的异步通知」或「主动查单结果」驱动，本接口应删除。
        if (process.env.PAY_SIMULATE !== '1') {
          sendJson(res, 403, 40301, '支付确认通道未开放：真实支付尚未接入，禁止模拟入账');
          return;
        }
        const orderId = payload.orderId || payload.id;
        const order = getOrder(orderId);
        if (!order) {
          sendJson(res, 404, 40401, '订单不存在');
          return;
        }
        // 先校验订单归属再改状态：没有 userId 的订单不允许入账，也不能被标记为已支付
        const orderUid = String(order.userId || '').trim();
        if (!orderUid) {
          sendJson(res, 400, 40001, '订单缺少用户归属，无法入账');
          return;
        }
        // 入账统一走履约层（与支付宝验签回调/查单兜底同一份实现，防双路径漂移）
        const f = fulfillPaidOrder(orderId, { via: 'simulate' });
        if (!f.ok) {
          sendJson(res, 400, 40001, f.message || '入账失败');
          return;
        }
        const paidOrder = f.order;
        const uid = orderUid;
        const totalPoints = Number(f.addedPoints) || 0;

        const newBalance = creditStore.getBalance(uid);
        sendJson(res, 200, 0, '支付成功，权益与积分已即时到账', {
          order: { ...paidOrder, orderId: paidOrder.id },
          newBalance,
          addedPoints: totalPoints,
        });
      } catch (err) {
        sendJson(res, 500, 50001, '支付确认处理异常: ' + err.message);
      }
    }).catch((err) => {
      sendJson(res, 400, 40001, '请求解析失败: ' + err.message);
    });
    return;
  }

  // 18.3 查询商户订单列表：GET /api/v1/user/orders
  if (pathname === '/api/v1/user/orders' && req.method === 'GET') {
    const uid = sessionUidOf(req);
    if (!uid) { rejectNoUid(res); return; }
    const list = ordersOf(uid);
    sendJson(res, 200, 0, '查询成功', { list, orders: list });
    return;
  }

  // 18.4 前台商户 72 小时自主申请退款：POST /api/v1/order/refund
  // CRITICAL-03 安全修复：强制 session 鉴权 + 订单归属校验
  if (pathname === '/api/v1/order/refund' && req.method === 'POST') {
    const token = extractSessionToken(req);
    const session = verifySession(token);
    if (!session) {
      sendJson(res, 401, 40101, '未登录或登录已失效，请重新登录');
      return;
    }
    safeReadJson(req, res).then(async (payload) => {
      const orderId = payload.orderId || payload.id;
      if (!orderId) {
        sendJson(res, 400, 40001, '缺少退款 orderId');
        return;
      }
      // 权限门禁：订单必须属于当前登录用户
      const order = getOrder(orderId);
      if (!order || order.userId !== session.userId) {
        sendJson(res, 403, 40301, '无权操作此订单');
        return;
      }
      const resData = await refundAdminOrder(orderId, payload.reason || '商户前台 72 小时内自主申请退款');
      if (resData.ok) {
        sendJson(res, 200, 0, '退款处理成功，款项已原路退回，积分已同步核销', resData);
      } else {
        sendJson(res, 400, 40001, resData.message || '退款申请失败');
      }
    }).catch(() => { });
    return;
  }

  // HIGH-05 安全加固：以下重复路由已清理（18.5~18.9 与前面 12~14 / 13.1~13.3 完全重复，属死代码）
  // 原路由 18.5 GET /api/v1/admin/withdraws → 已在 L1133 处理
  // 原路由 18.6 POST /api/v1/admin/withdraws/review → 已在 L1140 处理
  // 原路由 18.7 GET /api/v1/admin/partners → 已在 L1196 处理
  // 原路由 18.8 POST /api/v1/partner/profile → 已在 L1156 处理
  // 原路由 18.81 GET /api/v1/partner/profile → 已在 L1166 处理
  // 原路由 18.9 POST /api/v1/partner/withdraw → 已在 L1173 处理（统一走 createWithdraw）

  // 18.91 前台查询合伙人历史提现单据：GET /api/v1/partner/withdraws
  if (pathname === '/api/v1/partner/withdraws' && req.method === 'GET') {
    const uid = sessionUidOf(req);
    if (!uid) { rejectNoUid(res); return; }
    const list = withdrawsOf(uid);
    sendJson(res, 200, 0, '查询成功', { list, total: list.length });
    return;
  }

  // 18.92 前台查询合伙人佣金收益汇总：GET /api/v1/partner/summary
  if (pathname === '/api/v1/partner/summary' && req.method === 'GET') {
    const uid = sessionUidOf(req);
    if (!uid) { rejectNoUid(res); return; }
    const summ = partnerSummary(uid);
    // 叠加真实资格考核数据：受邀数 / 目标 / 是否达标（partnerAt）/ 已签约城市，
    // 取代前端 localStorage 里的脏数据，保证「资格考核邀请5人」与后端一致。
    const u = getUser(uid);
    const target = partnerTarget();
    const invited = u ? invitedCount(u.phone) : 0;
    sendJson(res, 200, 0, '查询成功', {
      ...summ,
      target,
      invitedCount: invited,
      isPartner: !!(u && u.partnerAt),
      partnerCity: (u && (u.partnerCity || '')) || '',
    });
    return;
  }

  // 18.93 前台用户主动升级为城市合伙人：POST /api/v1/partner/upgrade
  // 校验受邀满 partnerTarget 人后，由服务端真实写入 partnerAt（取代前端伪造 isPartner=true）
  if (pathname === '/api/v1/partner/upgrade' && req.method === 'POST') {
    const uid = sessionUidOf(req);
    if (!uid) { rejectNoUid(res); return; }
    const result = upgradeToPartner(uid);
    if (result.error) {
      sendJson(res, 400, 40001, result.error);
      return;
    }
    sendJson(res, 200, 0, '恭喜升级为城市合伙人', result);
    return;
  }

  // 18.94 前台推广分销名册：GET /api/v1/partner/invitees
  // 真实邀请关系（inviterPhone）逐层生成：一级=直推，二级=一级的受邀（去重）；手机号脱敏。
  // 填补前台「推广分销名册」无数据来源的空壳（此前名单与人数从未被填充）。
  if (pathname === '/api/v1/partner/invitees' && req.method === 'GET') {
    const uid = sessionUidOf(req);
    if (!uid) { rejectNoUid(res); return; }
    const u = getUser(uid);
    if (!u) { sendJson(res, 404, 40401, '用户不存在'); return; }
    const maskPhone = (ph) => {
      const s = String(ph || '');
      return /^\d{11}$/.test(s) ? `${s.slice(0, 3)}****${s.slice(-4)}` : (s || '-');
    };
    const row = (x) => ({ phone: maskPhone(x.phone), name: x.name || x.nickname || '', joinedAt: x.createdAt || 0 });
    const l1Users = usersByInviter(u.phone);
    const seenIds = new Set([u.userId || u.id]);
    const l2Rows = [];
    for (const d1 of l1Users) {
      seenIds.add(d1.userId || d1.id);
      for (const d2 of usersByInviter(d1.phone)) {
        const key = d2.userId || d2.id;
        if (!seenIds.has(key)) { seenIds.add(key); l2Rows.push(row(d2)); }
      }
    }
    sendJson(res, 200, 0, '查询成功', { level1: l1Users.map(row), level2: l2Rows });
    return;
  }

  // 18.95 前台佣金流水明细：GET /api/v1/partner/commissions
  // 填补前台「佣金流水明细」空壳：结算金额怎么来的（哪位下线、什么消费、几级、几折）、什么状态，逐笔可溯。
  // 手机号脱敏，金额/状态如实展示（cancelled=已冲正不计入收益）。
  if (pathname === '/api/v1/partner/commissions' && req.method === 'GET') {
    const uid = sessionUidOf(req);
    if (!uid) { rejectNoUid(res); return; }
    const u = getUser(uid);
    if (!u) { sendJson(res, 404, 40401, '用户不存在'); return; }
    const maskPhone2 = (ph) => {
      const s = String(ph || '');
      return /^\d{11}$/.test(s) ? `${s.slice(0, 3)}****${s.slice(-4)}` : (s || '-');
    };
    const list = commissionsOf(uid).map((c) => {
      const invitee = getUser(c.inviteeId);
      return {
        id: c.id,
        level: c.level === 2 ? 2 : 1, // 1=一级直推 15%，2=二级裂变 5%
        orderType: c.orderType || '', // member=会员充值（参与分润），其他类型如实透出
        amount: Number(c.amount) || 0, // 下线消费金额（元）——结算基数
        rate: Number(c.rate) || 0, // 分佣比例（0.15/0.05）——结算依据
        commission: Number(c.commission) || 0, // 结算佣金（元）
        status: c.status || 'pending', // pending=账期中 / settled=已结算 / cancelled=已冲正
        createdAt: c.createdAt || 0, // 佣金产生时间（消费发生）
        settledAt: c.settledAt || 0, // 结算到账时间
        inviteePhone: invitee ? maskPhone2(invitee.phone) : (c.inviteeId || '-'),
        inviteeName: invitee ? (invitee.nickname || invitee.name || '') : '',
        orderId: c.orderId || '',
      };
    });
    sendJson(res, 200, 0, '查询成功', { list });
    return;
  }

  // ==========================================
  // 静态页面与资源分发
  // ==========================================
  let reqPath = pathname === '/' ? '/index.html' : pathname;

  // 优先处理 /admin 管理后台静态访问
  if (reqPath === '/admin' || reqPath.startsWith('/admin/')) {
    let sub = reqPath.replace(/^\/admin\/?/, '');
    if (!sub || sub === '') sub = 'index.html';
    const adminTarget = path.join(adminDir, sub);
    if (isSafeSubPath(adminDir, adminTarget) && fs.existsSync(adminTarget) && fs.statSync(adminTarget).isFile()) {
      serveStaticFile(req, res, adminTarget);
      return;
    }
    const adminIndex = path.join(adminDir, 'index.html');
    if (fs.existsSync(adminIndex)) {
      serveStaticFile(req, res, adminIndex);
      return;
    }
  }

  // 优先处理 /storage/outputs/ 静态成片视频访问
  if (reqPath.startsWith('/storage/outputs/')) {
    const relPart = reqPath.replace('/storage/outputs/', '');
    const isDownloadReq = urlObj.searchParams.get('download') === '1' || urlObj.searchParams.has('download');
    if (isDownloadReq) {
      const parts = relPart.split(/[\/\\]/);
      const taskId = parts[0];
      if (taskId) {
        const existing = creationStore.getTask(taskId);
        if (existing) {
          const count = (Number(existing.downloadCount) || 0) + 1;
          creationStore.updateTask(taskId, {
            downloaded: true,
            downloadCount: count,
            downloadedAt: Date.now(),
          });
          if (existing.userId) recordUserVideoDownloaded(existing.userId);
        }
      }
    }
    const outTarget = path.join(storageOutputsDir, relPart);
    if (isSafeSubPath(storageOutputsDir, outTarget) && fs.existsSync(outTarget) && fs.statSync(outTarget).isFile()) {
      serveStaticFile(req, res, outTarget);
      return;
    }
  }

  // 优先从 clientDir 寻找
  let targetFile = path.join(clientDir, reqPath.startsWith('/') ? reqPath.slice(1) : reqPath);
  if (isSafeSubPath(clientDir, targetFile) && fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
    serveStaticFile(req, res, targetFile);
    return;
  }

  // 安全加固：严禁外网访问根目录敏感文件（绝对封死 .env, .git, package.json, storage 私有目录）
  // 仅在严格白名单路径 (materials, assets) 内放行静态资源，并执行 path.normalize 防范路径穿越
  if (reqPath.startsWith('/materials/') || reqPath.startsWith('/assets/')) {
    const safeTarget = path.normalize(
      reqPath.startsWith('/materials/')
        ? path.join(materialsDir, reqPath.slice('/materials/'.length))
        : path.join(rootDir, 'assets', reqPath.slice('/assets/'.length))
    );
    const isMaterials = safeTarget.startsWith(materialsDir);
    const isAssets = safeTarget.startsWith(path.join(rootDir, 'assets'));
    if ((isMaterials || isAssets) && !path.basename(safeTarget).startsWith('.') && fs.existsSync(safeTarget) && fs.statSync(safeTarget).isFile()) {
      serveStaticFile(req, res, safeTarget);
      return;
    }
  }

  // 未知路径一律返回 404：此前无差别回退到 index.html，任意拼错或垃圾 URL 都会以 200 返回首页内容，
  // 搜索引擎会当作重复页抓取（软 404），既浪费抓取预算，也让无效链接无法通过 404 下架
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  });
  res.end('404 Not Found');
});

// ========================================================================
// 僵尸任务收割与自愈机制 (Zombie Reaper)
// 防止服务器重启更新后，遗留的任务永远停留在 processing 卡死用户
// ========================================================================
async function reapZombieTasks() {
  try {
    const { creationStore } = await import('./creationStore.mjs');
    const now = Date.now();
    let reapedCount = 0;
    for (const [taskId, task] of creationStore.tasks.entries()) {
      if ((task.status === 'processing' || task.status === 'pending') && (now - (task.updatedAt || task.createdAt || now) > 10 * 60 * 1000)) {
        task.status = 'failed';
        task.stage = 'failed';
        task.error = { name: 'ZombieTaskRecovered', code: 50099, message: '系统维护重启，已自动终止并全额退还积分' };
        // 金额统一由 chargedAmountOf 还原：旁路版块内部只落布尔标记，直接当数值用会退成 1 分（历史缺陷）
        const amt = chargedAmountOf(task);
        if (amt > 0 && task.userId && !task.creditsRefunded) {
          const r = settleFailure({ userId: task.userId, taskId, amount: amt, store: creditStore, reason: '系统重启自动退还' });
          if (r.ok) task.creditsRefunded = true;
        }
        creationStore.updateTask(taskId, task);
        reapedCount++;
      }
    }
    if (reapedCount > 0) {
      console.log(`[JANSEE GATEWAY] 僵尸任务自愈收割器：成功收割并退还积分 ${reapedCount} 个遗留任务`);
    }
  } catch (err) {
    console.warn('[JANSEE GATEWAY] 僵尸任务收割告警:', err.message);
  }
}

// ========================================================================
// 极简存储生命周期守护器 (TTL Janitor)
// 1. 每 10 分钟清理 storage/uploads 中超过 2 小时的临时孤儿素材目录
// 2. 每小时清理 storage/outputs 中超过 26 小时的过期成片 final.mp4
// 3. 滑动淘汰 inMemoryTasks 中超过 24 小时的历史任务
// ========================================================================
function startStorageJanitor() {
  const runCleanup = () => {
    const now = Date.now();
    // 1. 清理临时上传孤儿素材（超过 2 小时）
    try {
      if (fs.existsSync(storageUploadsDir)) {
        const dirs = fs.readdirSync(storageUploadsDir);
        for (const d of dirs) {
          if (!d.startsWith('upload_')) continue;
          const fullPath = path.join(storageUploadsDir, d);
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > 2 * 3600 * 1000) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          }
        }
      }
    } catch (_) { }

    // 2. 成片生命周期治理：以任务 expireAt 为唯一到期时间，默认 24 小时。
    // 不能只依赖目录 mtime（文件写入时间可能晚于任务创建时间），避免作品记录与成片文件错位。
    try {
      if (fs.existsSync(storageOutputsDir)) {
        const taskDirs = fs.readdirSync(storageOutputsDir);
        for (const td of taskDirs) {
          const taskDir = path.join(storageOutputsDir, td);
          try {
            const stat = fs.statSync(taskDir);
            if (!stat.isDirectory()) continue;
            const task = creationStore.getTask(td);
            const expireAt = Number(task?.expireAt) || ((Number(task?.createdAt) || stat.mtimeMs) + 24 * 3600 * 1000);
            if (now >= expireAt) {
              fs.rmSync(taskDir, { recursive: true, force: true });
              // 文件到期时同步移除作品记录；即使记录已被查询接口清理，也保持幂等。
              creationStore.tasks.delete(td);
              inMemoryTasks.delete(td);
            }
          } catch (_) { }
        }
      }
    } catch (_) { }

    // 3. 内存 Map 滑动淘汰（24 小时出片历史，2 小时素材索引）
    try {
      for (const [tid, task] of inMemoryTasks.entries()) {
        const cTime = task.createdAt || 0;
        if (cTime && now - cTime > 24 * 3600 * 1000) {
          inMemoryTasks.delete(tid);
        }
      }
      creationStore.cleanExpiredTasks(24 * 3600 * 1000);
      cleanExpiredMaterials(2 * 3600 * 1000);
    } catch (_) { }
  };

  setInterval(runCleanup, 10 * 60 * 1000);
  runCleanup();
}

server.listen(PORT, HOST, async () => {
  console.log(`[JANSEE GATEWAY] 商业级网关与前端服务已启动: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`[JANSEE GATEWAY] 客户端目录: ${clientDir}`);
  // 短信通道自检：上线后登录全靠它，启动即暴露配置缺失，避免"用户收不到码"才发现
  const sms = smsStatus();
  if (sms.mock) {
    console.warn('[JANSEE GATEWAY] 短信通道: MOCK（JX_AUTH_TEST=1，验证码只打日志/回传前端，切勿用于线上）');
  } else if (sms.ready) {
    console.log(`[JANSEE GATEWAY] 短信通道: ${sms.provider} 就绪（签名 ${process.env.JX_SMS_SIGN_NAME || '-'} / 模板 ${process.env.JX_SMS_TEMPLATE_CODE || '-'}）`);
  } else {
    console.error(`[JANSEE GATEWAY] 短信通道未就绪: ${sms.reason || '未知原因'} → 登录接口将返回 503`);
  }
  startTtsProbe(); // 腾讯云 TTS 账号级探活：启动 30s 后首探，此后每日 04:00 错峰自检
  // 支付宝通道启动自检：配置缺失只降级（通道接口报 503），不影响网关其他功能
  try {
    const st = initAlipay();
    if (st.ready) {
      console.log(`[JANSEE GATEWAY] 支付宝通道: 就绪（${st.sandbox ? '沙箱' : '生产'}，appId=${st.appId.slice(0, 4)}****）回跳地址 ${alipayReturnUrl()}`);
    } else {
      console.warn(`[JANSEE GATEWAY] 支付宝通道未就绪: ${st.reason || '未配置'} → 收银台支付宝支付不可用`);
    }
  } catch (err) {
    console.warn(`[JANSEE GATEWAY] 支付宝通道初始化异常: ${err.message}`);
  }
  await reapZombieTasks(); // 开机收割僵尸任务
  startStorageJanitor(); // 启动存储生命周期定时守护器
});
