// 简兮 · 内容前置审核：本地敏感信息检测 + 待审列表存储
// 说明：采用本地词库对上传的文件名/文本做「涉黄/涉暴/涉政/赌博/诈骗」粗筛，
//      仅命中的素材进入内容审核待审列表，未命中直接可用、不出现在待审列表。
// 待审记录落盘：server/data/review-pending.json
import path from 'node:path';
import { dataFile, readJson, writeJsonAtomic } from './dataStore.mjs';

const PENDING_FILE = dataFile('review-pending.json');

// —— 敏感词库（涉黄/涉暴/涉政/涉诈/新广告法绝对化高危禁用词，0 成本本地匹配）——
const WORDS = [
  // 涉黄
  '色情', '裸聊', '约炮', '卖淫', '嫖娼', '援交', '一夜情', '成人影视', '黄色网站', '黄片',
  '三级片', '淫荡', '骚货', 'AV视频', '桃色', '情色交易', '催情水', '迷药',
  // 涉暴 / 违禁
  '暴力', '砍人', '杀人', '血腥', '爆炸', '恐怖袭击', '枪击', '绑架', '殴打', '群殴',
  '枪支弹药', '军用手枪', '管制刀具', '毒品', '大麻', '冰毒', '海洛因', 'K粉',
  // 涉政 / 违规翻墙
  '颠覆国家', '造反', '暴动', '游行示威', '法轮功', '反动言论', '翻墙梯子', '科学上网', '内幕爆料',
  // 赌博 / 诈骗 / 黑灰产
  '赌博平台', '博彩网站', '澳门赌场', '六合彩特码', '网络彩票', '网络诈骗', '洗钱水钱', '传销模式',
  '资金盘', '刷单返利', '高返兼职', '跑分兼职', '裸聊敲诈',
  // 电商 / 广告法绝对化高危禁用词（防虚假宣传与全网举报）
  '国家级', '世界级', '最高级', '顶级工艺', '第一品牌', '全网首创绝无仅有', '包治百病', '药到病除',
  '专治绝症', '百分之百有效', '假一赔万'
];

/** 检测文本中的敏感词；返回命中词列表（未命中返回 []） */
export function detectSensitive(text) {
  const s = String(text || '');
  if (!s) return [];
  const hit = [];
  for (const w of WORDS) {
    if (s.includes(w)) hit.push(w);
  }
  return hit;
}

/** 拦截日志落盘 */
const BLOCKED_FILE = dataFile('review-blocked.json');
let blockedLogs = [];
function loadBlocked() {
  const raw = readJson(BLOCKED_FILE, null);
  if (Array.isArray(raw)) blockedLogs = raw;
}
function saveBlocked() {
  writeJsonAtomic(BLOCKED_FILE, blockedLogs);
}
loadBlocked();

/** 记录一次被拦截的违规出片请求 */
export function recordBlockedContent({ text, hits, userId = '', scene = '', clientIp = '' }) {
  const item = {
    id: 'blk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    text: String(text || '').slice(0, 300),
    hits: Array.isArray(hits) ? hits : [],
    userId: userId || 'anonymous',
    scene: scene || 'default',
    clientIp: clientIp || '',
    blockedAt: Date.now(),
  };
  blockedLogs.unshift(item);
  if (blockedLogs.length > 500) blockedLogs.pop();
  saveBlocked();
  return item;
}

/** 获取违规拦截日志列表 */
export function listBlockedLogs() {
  return [...blockedLogs];
}

// —— 待审列表存储 ——
let pending = [];
function load() {
  const raw = readJson(PENDING_FILE, null);
  if (Array.isArray(raw)) pending = raw;
}
function save() {
  writeJsonAtomic(PENDING_FILE, pending);
}
load();

/** 记录一条待审（命中敏感词的素材） */
export function addPendingReview({ url, type, title, user, reason }) {
  const it = {
    id: 'rp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    url,
    type: type || 'image',
    title: String(title || path.basename(String(url || ''))),
    user: user || '',
    reason: String(reason || '命中敏感词'),
    createdAt: Date.now(),
    status: 'pending', // pending → approved / rejected
    processedAt: null,
  };
  // 幂等：同一素材已存在则不重复上报
  if (!pending.some((p) => p.url === it.url)) pending.unshift(it);
  save();
  return it;
}

/** 全部待审记录（管理端，最新在前） */
export function listPendingReviews() {
  return [...pending].sort((a, b) => b.createdAt - a.createdAt);
}

/** 按 id 查找待审记录 */
export function findPendingReview(id) {
  return pending.find((p) => String(p.id) === String(id)) || null;
}

/** 审核：标记为 approved / rejected */
export function reviewPendingItem(id, status, adminId) {
  const it = findPendingReview(id);
  if (!it) return null;
  it.status = status;
  it.processedAt = Date.now();
  it.handlerId = adminId || '';
  save();
  return it;
}

/** 清空全部待审（含历史已审记录），管理端手动使用 */
export function clearPendingReviews() {
  pending = [];
  save();
}
