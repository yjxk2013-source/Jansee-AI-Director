// 简兮后端 · siteConfig.mjs —— 站点配置（配置驱动，与 memberTiers.mjs 同构）
// ---------------------------------------------------------------------------
// 数据流：
//   出厂默认（本文件 DEFAULT_SITE）
//     ← 逐字段被 data/site-config.json 覆盖
//     ← 后台「站点设置」页 → PUT /api/admin/site-config → invalidateSite() 即时生效（不重启/不重建）
//     → GET /api/site-config 下发前端，前端按 [data-site="ops.signupPoints"] 占位回填
//
// ⭐ 单一真相原则（本站最重要的一条纪律）：
//   运营参数（赠送/扣费/门槛/手续费）**以本配置为准**，服务端逻辑（userStore / partnerStore /
//   settlementGateway）运行时读取本模块，而不是各自硬编码常量；前端只负责展示同一个值。
//   否则就会出现「用户看到的规则 ≠ 实际执行的规则」——比没有这个功能更糟。
//
// 手删 data/site-config.json ＝ 恢复出厂默认（下次保存自动重建）。

import { dataFile, readJson, writeJsonAtomic } from './dataStore.mjs';
import { DEFAULT_FAQ, DEFAULT_HELP, DEFAULT_LEGAL, DEFAULT_PROMOS, DEFAULT_TESTIMONIALS, DEFAULT_CASES } from './siteDefaults.mjs';

/** 配置文件绝对路径（延迟求值，便于测试用 JX_DATA_DIR 覆盖） */
export function siteConfigFilePath() {
  return dataFile('site-config.json');
}
/** 改动留痕文件（合规争议时自证「谁、何时、改前是什么」） */
function historyFilePath() {
  return dataFile('site-config-history.json');
}
const HISTORY_KEEP = 30;

// ---------------------------------------------------------------------------
// 出厂默认
// ---------------------------------------------------------------------------

/** 品牌与合规：页脚展示的对外信息（严格参照前台脚标对齐） */
export const DEFAULT_BRAND = {
  productName: '简兮 (JANSEE)',
  companyName: '', // 公司主体全称（注册公司并备案后填写）
  icp: '蜀ICP备2026046708号',
  police: '川公网安备51011202001517号', // 全国公安机关互联网站安全管理服务平台备案
  email: 'jansee@jansee.cn', // 客服 / 商务合作邮箱
  copyright: '© 2026 简兮 (JANSEE) · 简于形 · 胜于效 · 版权所有',
  contactTail: '移动端体验：页面底部导航 / 手机浏览器直达',
};

/**
 * 运营参数：**服务端以此为准**（不是只改文案）。
 * 默认值 = 改造前代码里的常量值，保证切换后行为逐字不变。
 */
export const DEFAULT_OPS = {
  signupPoints: 600, // 注册赠送积分（userStore.createUser）
  inviteReward: 200, // 好友注册 → 邀请人奖励（userStore.createUser）
  checkinPoints: 100, // 每日签到奖励（userStore.checkin）
  generateCost: 200, // 每次出片扣费（userStore.chargeGeneration）
  partnerTarget: 5, // 邀请满 N 人可升级城市合伙人（userStore / routes/partner.js）
  withdrawMin: 100, // 起提金额（元）
  withdrawMax: 5000, // 单笔上限（元）
  withdrawDailyMax: 10000, // 单日累计上限（元）
  withdrawDailyCount: 3, // 单日提现次数上限
  withdrawFeeRatePct: 1, // 提现手续费率（%，按提现金额计收）
  withdrawFeeMin: 2, // 单笔最低手续费（元）
  withdrawArrival: 'T1', // 到账时效文案（如 T1 = 下个工作日）
};

/** 法律文本固定章节（与 index.html 的 `<section id="doc-*">` 一一对应，**不允许增删**：
 *  前端按 key 注入弹窗，新增章节需要同时改页面导航） */
export const LEGAL_KEYS = Object.keys(DEFAULT_LEGAL);

/** 帮助页固定栏目（`vip` 一栏由定价接口渲染，不在内容配置内） */
export const HELP_KEYS = Object.keys(DEFAULT_HELP);

export const DEFAULT_HOLIDAY_PROMO = {
  enabled: false, // 是否开启节日活动广告
  displayType: 'banner', // 'banner' (顶部微光通知条) | 'modal' (进站微光弹窗) | 'both' (两者均开启)
  title: '双节同庆 · 会员限时 6.8 折特惠',
  subtitle: '充值任意会员套餐限时加赠 500 点出片算力，更有合伙人双倍返佣',
  ctaText: '立即抢购特惠',
  ctaAction: 'open-plan', // 跳转动作：open-plan | open-boost | open-partner | scroll-create
  endAt: '2026-11-15 23:59:59', // 倒计时截止时刻
};

export const DEFAULT_SITE = {
  brand: { ...DEFAULT_BRAND },
  ops: { ...DEFAULT_OPS },
  legal: DEFAULT_LEGAL,
  faq: DEFAULT_FAQ,
  testimonials: DEFAULT_TESTIMONIALS,
  help: DEFAULT_HELP,
  promos: DEFAULT_PROMOS,
  cases: DEFAULT_CASES,
  holidayPromo: { ...DEFAULT_HOLIDAY_PROMO },
};

/** 数值约束：服务端校验与后台表单上下限**共用这一份**，避免两处各写一套 */
export const SITE_LIMITS = {
  signupPoints: { min: 0, max: 1000000, step: 10 },
  inviteReward: { min: 0, max: 1000000, step: 10 },
  checkinPoints: { min: 0, max: 1000000, step: 10 },
  generateCost: { min: 1, max: 1000000, step: 10 },
  partnerTarget: { min: 1, max: 1000, step: 1 },
  withdrawMin: { min: 1, max: 1000000, step: 10 },
  withdrawMax: { min: 1, max: 100000000, step: 100 },
  withdrawDailyMax: { min: 1, max: 100000000, step: 100 },
  withdrawDailyCount: { min: 1, max: 50, step: 1 },
  withdrawFeeRatePct: { min: 0, max: 50, step: 0.1 },
  withdrawFeeMin: { min: 0, max: 10000, step: 1 },
};

/** 运营参数的中文字段名（校验报错与后台表单 label 共用，保证提示一致） */
export const OPS_LABELS = {
  signupPoints: '注册赠送积分',
  inviteReward: '邀请好友奖励积分',
  checkinPoints: '每日签到积分',
  generateCost: '每次出片扣费积分',
  partnerTarget: '升级合伙人所需邀请人数',
  withdrawMin: '起提金额（元）',
  withdrawMax: '单笔提现上限（元）',
  withdrawDailyMax: '单日累计提现上限（元）',
  withdrawDailyCount: '单日提现次数上限',
  withdrawFeeRatePct: '提现手续费率（%）',
  withdrawFeeMin: '单笔最低手续费（元）',
  withdrawArrival: '到账时效文案',
};

// ---------------------------------------------------------------------------
// 广告位（运营位）：位在代码、内容在后台
// ---------------------------------------------------------------------------
// ⭐ 分层原则：
//   「位」（PROMO_SLOTS）由代码固定 —— 位置、版式、响应式断点在 index.html / style.css。
//      后台**不能**新增或删除位：让运营随意加位会把页面结构玩崩；新增一个位属于设计改动，本就该走代码。
//   「内容」（promos 数组）完全由后台管理 —— 一位可挂多条，可停用、可排期，
//      于是「活动结束撤掉广告」「换一期新广告」都不用发版。
//
// ⭐ 安全边界：CTA 动作走白名单（PROMO_ACTIONS）。**不开放自由填链接** ——
//   一个 javascript: 或钓鱼地址就能借首页的信任进去，属 XSS 与合规事故入口。

/** 可用广告位（key 必须与 index.html 里的 data-promo-slot 一致） */
export const PROMO_SLOTS = [
  {
    key: 'hero',
    label: '首屏 Hero 位',
    hint: '桌面端（≥768px）首屏横幅。副标题可选填 3 套，分别对应上方「线上商家 / 线下商家 / 个人」三个场景，只填一套时三场景通用。',
    fields: ['eyebrow', 'title', 'subSell', 'subLocal', 'subPersonal', 'ctaText', 'ctaAction', 'metaText'],
  },
  {
    key: 'partner',
    label: '城市合伙人招募横幅位',
    hint: '首屏下方的招募横幅（≥768px）。右侧数据面板属对外宣传口径，需填写数据说明。',
    fields: [
      'eyebrow',
      'title',
      'sub',
      'metaText',
      'ctaText',
      'ctaAction',
      'moreText',
      'moreDoc',
      'panelTitle',
      'panelTotal',
      'stats',
      'footText',
    ],
  },
  {
    key: 'promo',
    label: '首页促销位（带倒计时）',
    hint: '城市合伙人横幅下方，全端显示（含手机）。填「排期结束时间」即为倒计时归零点：到期前台倒计时自动消失，服务端同时停止下发（下架），两者同一口径。',
    fields: ['eyebrow', 'title', 'sub'],
  },
];

/** 预设主题：不做自由配色（会把版式调坏），样式在 style.css 的 .promo-theme-*
 *  ⚠️ 只提供**深色系**三套：浅色主题需要连带重配数据面板、按钮、边框的整套配色，
 *     半成品比没有更糟，等真正需要时再整块设计。 */
export const PROMO_THEMES = [
  { key: 'brand', label: '品牌红（默认）' },
  { key: 'dark', label: '纯深色（去掉红色光晕）' },
  { key: 'gold', label: '金色促销' },
];

/** CTA 动作白名单（前端 window.jxRunPromoAction 里一一对应；不在表内的动作会被后端拒绝） */
export const PROMO_ACTIONS = [
  { key: 'scroll-create', label: '滚动到创作区' },
  { key: 'open-partner', label: '打开「城市合伙人」' },
  { key: 'open-plan', label: '打开「会员定价」' },
  { key: 'open-boost', label: '打开「积分加油包」' },
  { key: 'open-auth', label: '打开「登录 / 注册」' },
  { key: 'open-profile', label: '打开「个人中心」' },
  { key: 'open-material', label: '打开「素材库」' },
];

/** 广告位字段的中文名（校验报错与后台表单 label 共用） */
export const PROMO_FIELD_LABELS = {
  eyebrow: '小字（标题上方）',
  title: '主标题',
  subSell: '副标题 · 线上商家',
  subLocal: '副标题 · 线下商家',
  subPersonal: '副标题 · 个人',
  sub: '副标题',
  metaText: '按钮旁说明',
  ctaText: '主按钮文字',
  ctaAction: '主按钮动作',
  moreText: '次按钮文字',
  moreDoc: '次按钮打开的法律文本',
  panelTitle: '数据面板标题',
  panelTotal: '数据面板右上角说明',
  stats: '数据面板条目',
  footText: '数据面板底部一行',
};

/** 各字段长度上限（超长会在后台被拒，而不是悄悄截断）。
 *  ⚠️ 这张表同时决定「哪些字段会被规整保留」—— 漏写一个键，该字段就会被静默丢弃
 *     （ctaAction / moreDoc 就曾因此存不下来），新增字段务必同时加到这里。 */
const PROMO_FIELD_MAX = {
  eyebrow: 60,
  title: 120,
  subSell: 300,
  subLocal: 300,
  subPersonal: 300,
  sub: 300,
  metaText: 300,
  ctaText: 30,
  ctaAction: 40, // 白名单 key（不是链接）
  moreText: 30,
  moreDoc: 40, // 法律文本章节 key
  panelTitle: 60,
  panelTotal: 40,
  footText: 300,
};

/** 某位的必填字段：缺了会渲染出空标题，所以直接拒绝 */
const PROMO_REQUIRED = {
  hero: ['title', 'ctaText'],
  partner: ['title', 'ctaText'],
  promo: ['title'], // 促销位无按钮：标题必填，子标题/小字可选，倒计时由排期 endAt 驱动
};

const PROMO_MAX_ITEMS = 20;
const PROMO_MAX_STATS = 4;

// ---------------------------------------------------------------------------
// 构建（出厂默认 ← 文件覆盖，逐字段兜底）
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 数值字段：合法则取文件值，否则回退出厂值（文件被手改坏也不会让服务算出 NaN） */
function num(raw, def, key) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  const lim = SITE_LIMITS[key];
  if (lim && (n < lim.min || n > lim.max)) return def;
  return n;
}

function text(raw, def, maxLen = 500) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return def;
  return s.slice(0, maxLen);
}

/** FAQ 规整：非数组/空数组 → 出厂默认；逐条裁剪长度并丢弃空项（上限 50 条） */
function normFaq(list) {
  if (!Array.isArray(list) || !list.length) return DEFAULT_FAQ;
  const out = list
    .map((it) => {
      const o = {
        q: String(it?.q || '')
          .trim()
          .slice(0, 200),
        a: String(it?.a || '')
          .trim()
          .slice(0, 4000),
      };
      // id：给定价模块留的锚点（如 faqBillDiff），渲染后会写进 <p id="…">
      const id = String(it?.id || '')
        .trim()
        .slice(0, 40);
      if (/^[A-Za-z][\w-]*$/.test(id)) o.id = id;
      return o;
    })
    .filter((it) => it.q && it.a)
    .slice(0, 50);
  return out.length ? out : DEFAULT_FAQ;
}

/** 好评规整：同上，上限 20 条 */
function normTestimonials(list) {
  if (!Array.isArray(list) || !list.length) return DEFAULT_TESTIMONIALS;
  const out = list
    .map((it) => ({
      quote: String(it?.quote || '')
        .trim()
        .slice(0, 500),
      avatar: String(it?.avatar || '')
        .trim()
        .slice(0, 4),
      name: String(it?.name || '')
        .trim()
        .slice(0, 40),
    }))
    .filter((it) => it.quote && it.name)
    .slice(0, 20);
  return out.length ? out : DEFAULT_TESTIMONIALS;
}

/** 广告位 id：非法或重复则按「位 + 序号」重命名，保证稳定且唯一 */
function normPromoId(raw, slot, i, used) {
  let id = String(raw || '')
    .trim()
    .slice(0, 40);
  if (!/^[A-Za-z0-9_-]+$/.test(id) || used.has(id)) id = `${slot}-${i + 1}`;
  const base = id;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

/** 时间戳：0 或非法一律归 0（＝不限时间） */
function ts(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 广告位内容规整：把配置里的数据收拾成「结构一定正确」的数组。
 *
 * ⚠️ 空数组是**合法**的（＝所有广告位都不展示）——那正是「活动全部撤掉」的正常业务状态，
 *    所以这里**不像 FAQ 那样「空了就回退出厂默认」**：那样会让运营永远撤不掉广告。
 *    误删的兜底手段是后台的「本页填回出厂默认」按钮。
 */
function normPromos(list) {
  if (!Array.isArray(list)) return [];
  const used = new Set();
  return list
    .filter((it) => isPlainObject(it))
    .slice(0, PROMO_MAX_ITEMS)
    .map((it, i) => {
      const slot = PROMO_SLOTS.some((s) => s.key === it.slot) ? String(it.slot) : PROMO_SLOTS[0].key;
      const c = isPlainObject(it.content) ? it.content : {};
      const content = {};
      for (const [k, max] of Object.entries(PROMO_FIELD_MAX)) {
        const v = c[k];
        if (typeof v === 'string' && v.trim()) content[k] = v.trim().slice(0, max);
      }
      // 数据面板条目：num 与 label 都齐才保留（半条会渲染出断掉的排版）
      if (Array.isArray(c.stats)) {
        const stats = c.stats
          .map((s) => ({
            num: String(s?.num || '')
              .trim()
              .slice(0, 20),
            label: String(s?.label || '')
              .trim()
              .slice(0, 20),
          }))
          .filter((s) => s.num && s.label)
          .slice(0, PROMO_MAX_STATS);
        if (stats.length) content.stats = stats;
      }
      const out = {
        id: normPromoId(it.id, slot, i, used),
        slot,
        name:
          String(it.name || '')
            .trim()
            .slice(0, 40) || `${slot} 广告 ${i + 1}`,
        enabled: it.enabled !== false,
        theme: PROMO_THEMES.some((t) => t.key === it.theme) ? String(it.theme) : 'brand',
        startAt: ts(it.startAt),
        endAt: ts(it.endAt),
        order: Number.isFinite(Number(it.order)) ? Number(it.order) : i,
        note: String(it.note || '')
          .trim()
          .slice(0, 200),
        content,
      };
      const dataNote = String(it.dataNote || '')
        .trim()
        .slice(0, 200);
      if (dataNote) out.dataNote = dataNote;
      return out;
    });
}

/** 某条内容此刻是否该展示（启用 + 在排期内）。前端不需要判断时间，服务端只下发「生效中」的。 */
function promoActive(p, now) {
  if (!p.enabled) return false;
  if (p.startAt && now < p.startAt) return false;
  if (p.endAt && now >= p.endAt) return false;
  return true;
}

/** 每个位取「当前生效」的第一条（按 order，再按数组顺序） */
function activePromoBySlot(promos, now = Date.now()) {
  const out = {};
  const sorted = [...promos].sort((a, b) => a.order - b.order);
  for (const p of sorted) {
    if (out[p.slot]) continue;
    if (promoActive(p, now)) out[p.slot] = p;
  }
  return out;
}

function buildSite() {
  const raw = readJson(siteConfigFilePath(), null);
  const src = isPlainObject(raw) ? raw : {};
  const b = isPlainObject(src.brand) ? src.brand : {};
  const o = isPlainObject(src.ops) ? src.ops : {};

  const ops = {};
  for (const key of Object.keys(DEFAULT_OPS)) {
    if (key === 'withdrawArrival') ops[key] = text(o[key], DEFAULT_OPS[key], 20);
    else ops[key] = num(o[key], DEFAULT_OPS[key], key);
  }

  // —— 内容型配置：整体以配置为准，缺失/为空则回退出厂默认 ——
  const legalSrc = isPlainObject(src.legal) ? src.legal : {};
  const legal = {};
  for (const k of LEGAL_KEYS) legal[k] = text(legalSrc[k], DEFAULT_LEGAL[k], 20000);

  const helpSrc = isPlainObject(src.help) ? src.help : {};
  const help = {};
  for (const k of HELP_KEYS) help[k] = text(helpSrc[k], DEFAULT_HELP[k], 20000);

  const faq = normFaq(src.faq);
  const testimonials = normTestimonials(src.testimonials);
  // 广告位：文件里**有** promos 字段（哪怕是空数组）就以文件为准；
  // 完全没有该字段（老配置 / 首次部署）才用出厂默认。
  // ⚠️ 空数组＝运营有意撤掉全部广告，必须尊重，绝不能「空了就回退默认」。
  const promos = Array.isArray(src.promos) ? normPromos(src.promos) : normPromos(DEFAULT_PROMOS);

  // 备案模式：个人备案审核期间隐藏全部付费入口与广告横幅（只有显式 true 才开，误传其他值一律视为关）
  const icpMode = src.icpMode === true;

  // 商业样片展台：文件有则取文件，缺失取出厂默认
  const cases = Array.isArray(src.cases) ? src.cases : DEFAULT_CASES;

  // 逢年过节活动与促销广告配置
  const holidayPromo = isPlainObject(src.holidayPromo) ? { ...DEFAULT_HOLIDAY_PROMO, ...src.holidayPromo } : { ...DEFAULT_HOLIDAY_PROMO };

  return {
    brand: {
      productName: text(b.productName, DEFAULT_BRAND.productName, 30),
      companyName: typeof b.companyName === 'string' ? b.companyName.trim().slice(0, 60) : DEFAULT_BRAND.companyName,
      icp: typeof b.icp === 'string' && b.icp.trim() ? b.icp.trim().slice(0, 60) : DEFAULT_BRAND.icp,
      police: typeof b.police === 'string' && b.police.trim() ? b.police.trim().slice(0, 60) : DEFAULT_BRAND.police,
      email: typeof b.email === 'string' && b.email.trim() ? b.email.trim().slice(0, 80) : DEFAULT_BRAND.email,
      copyright: text(b.copyright, DEFAULT_BRAND.copyright, 200),
      contactTail: text(b.contactTail, DEFAULT_BRAND.contactTail, 120),
    },
    ops,
    legal,
    faq,
    testimonials,
    help,
    promos,
    cases,
    icpMode,
    holidayPromo,
  };
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

let cache = null;

/** 失效缓存：保存配置后调用，下次读取即新值（业务模块无需重启） */
export function invalidateSite() {
  cache = null;
}

/** 当前生效配置（带内存缓存） */
export function getSite() {
  if (!cache) cache = buildSite();
  return cache;
}

/** 运营参数（业务模块的唯一读取入口） */
export function ops() {
  return getSite().ops;
}

/**
 * 服务端占位符注入：把静态文件里的 {{ops.KEY}} 换成当前生效的运营参数。
 * 用途：index.html 的静态正文与 JSON-LD 不再硬编码数字——后台改参数，全站即时生效。
 * 未识别的占位符原样保留（客户端还有一层 {{ops.*}} 渲染兜底）。
 */
export function interpOps(text) {
  if (typeof text !== 'string' || text.indexOf('{{ops.') === -1) return text;
  const o = ops();
  // 衍生值：由运营参数实时算出，避免"注册送 600 = 3 条成片"这类乘法被写死
  const derived = {
    freeClips: Math.max(0, Math.floor((Number(o.signupPoints) || 0) / (Number(o.generateCost) || 1)))
  };
  return text.replace(/\{\{ops\.([a-zA-Z0-9_]+)\}\}/g, (m, key) => {
    if (o[key] === undefined || o[key] === null) {
      return derived[key] === undefined ? m : String(derived[key]);
    }
    return String(o[key]);
  });
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/** 公开视图：下发给用户站的字段（不含审计信息） */
export function sitePublicView() {
  const s = getSite();
  return {
    brand: s.brand,
    ops: s.ops,
    legal: s.legal,
    faq: s.faq,
    testimonials: s.testimonials,
    help: s.help,
    icpMode: s.icpMode,
    // 广告位只下发**此刻生效**的那一条（含排期判断）：
    // 未到期 / 已过期 / 已停用的内容不下发 —— 既省流量，也不会把未上线活动提前泄露出去。
    // ⚠️ 只给 slot / theme / endAt / content：name（内部备注）、note、startAt、dataNote 属后台信息。
    //    endAt 例外：促销位的倒计时指向它（倒计时归零 = 排期结束 = 服务端停止下发，同一口径）。
    // 备案模式下「城市合伙人招募横幅」整块不下发（服务端强控，前端无需信任）：招募/返佣属经营性内容。
    promos: Object.fromEntries(
      Object.entries(activePromoBySlot(s.promos))
        .filter(([k]) => !(s.icpMode && k === 'partner'))
        .map(([k, p]) => [k, { slot: p.slot, theme: p.theme, endAt: p.endAt || 0, content: p.content }]),
    ),
  };
}

/** 后台视图：附加出厂默认值与审计信息（便于「填回出厂默认」与排查） */
export function siteAdminView() {
  const s = getSite();
  // 最近一次改动留痕（来自 site-config-history.json），供后台显示「最后修改」
  const hist = readJson(historyFilePath(), []);
  const last = Array.isArray(hist) && hist.length ? hist[hist.length - 1] : null;
  return {
    ...s,
    updatedAt: last && Number(last.at) ? Number(last.at) : 0,
    updatedBy: last ? String(last.updatedBy || '') : '',
    defaults: {
      brand: DEFAULT_BRAND,
      ops: DEFAULT_OPS,
      legal: DEFAULT_LEGAL,
      faq: DEFAULT_FAQ,
      testimonials: DEFAULT_TESTIMONIALS,
      help: DEFAULT_HELP,
      promos: DEFAULT_PROMOS,
    },
    legalKeys: LEGAL_KEYS,
    helpKeys: HELP_KEYS,
    limits: SITE_LIMITS,
    labels: OPS_LABELS,
    // 广告位：位与主题、CTA 动作都是**代码固定**的枚举，随后台视图一起下发，
    // 保证后台下拉选项与服务端校验用的是同一份（不会出现「后台能选、后端不认」）
    promoSlots: PROMO_SLOTS,
    promoThemes: PROMO_THEMES,
    promoActions: PROMO_ACTIONS,
    promoFieldLabels: PROMO_FIELD_LABELS,
    promoMaxStats: PROMO_MAX_STATS,
    file: siteConfigFilePath(),
  };
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
}

/**
 * 校验完整配置，返回错误消息数组（空数组＝通过）。
 * 消息面向运营，直接指出「哪一项、为什么、允许范围」。
 *
 * @param next 已规整的配置（数组项已被过滤）
 * @param raw  本次**原始提交**的数组（faq/testimonials）。数组项在规整阶段会被静默丢弃，
 *             若直接校验规整结果，「第 N 条缺答案」这类错误永远触发不到（死分支）——
 *             所以逐条校验必须针对原始提交，才能告诉运营「是第几条写漏了」。
 */
export function validateSite(next, raw = {}) {
  const errors = [];
  const b = isPlainObject(next.brand) ? next.brand : {};
  const o = isPlainObject(next.ops) ? next.ops : {};

  for (const [key, lim] of Object.entries(SITE_LIMITS)) {
    const v = Number(o[key]);
    if (!Number.isFinite(v)) {
      errors.push(`${OPS_LABELS[key]} 必须是数字`);
      continue;
    }
    if (!Number.isInteger(v)) {
      errors.push(`${OPS_LABELS[key]} 必须是整数`);
      continue;
    }
    if (v < lim.min || v > lim.max) {
      errors.push(`${OPS_LABELS[key]} 须在 ${lim.min} ~ ${lim.max} 之间`);
    }
  }

  const wMin = Number(o.withdrawMin);
  const wMax = Number(o.withdrawMax);
  const wDaily = Number(o.withdrawDailyMax);
  if (Number.isFinite(wMin) && Number.isFinite(wMax) && wMax <= wMin) {
    errors.push('单笔提现上限必须大于起提金额');
  }
  if (Number.isFinite(wMax) && Number.isFinite(wDaily) && wDaily < wMax) {
    errors.push('单日累计上限不能小于单笔上限');
  }

  const arrival = String(o.withdrawArrival || '').trim();
  if (!arrival) errors.push('到账时效文案不能为空');
  else if (arrival.length > 20) errors.push('到账时效文案不超过 20 个字符');

  if (typeof b.icp !== 'string' || b.icp.trim().length > 60) errors.push('ICP 备案号不超过 60 个字符');
  if (typeof b.police !== 'string' || b.police.trim().length > 60) errors.push('公安备案号不超过 60 个字符');
  if (typeof b.companyName !== 'string' || b.companyName.trim().length > 60)
    errors.push('公司主体名称不超过 60 个字符');
  if (b.email && !isEmail(b.email)) errors.push('客服邮箱格式不正确');
  if (typeof b.copyright !== 'string' || b.copyright.trim().length > 200) errors.push('版权行不超过 200 个字符');
  if (typeof b.contactTail !== 'string' || b.contactTail.trim().length > 120)
    errors.push('页脚联系方式说明不超过 120 个字符');

  // —— 内容型：只做结构性校验（必填、条数、长度），不评判文案风格 ——
  const legal = isPlainObject(next.legal) ? next.legal : {};
  for (const k of LEGAL_KEYS) {
    const v = legal[k];
    if (typeof v !== 'string' || !v.trim()) errors.push(`法律文本「${k}」不能为空`);
    else if (v.length > 20000) errors.push(`法律文本「${k}」超过 20000 字符上限`);
  }

  // —— 数组型：逐条校验「原始提交」（规整后才知道哪几条被丢了，那样报错就说不清是第几条）——
  const faqList = Array.isArray(raw.faq) ? raw.faq : next.faq;
  if (!Array.isArray(faqList) || !faqList.length) errors.push('FAQ 至少保留 1 条');
  else if (faqList.length > 50) errors.push('FAQ 最多 50 条');
  else {
    faqList.forEach((it, i) => {
      if (!String(it?.q || '').trim()) errors.push(`FAQ 第 ${i + 1} 条缺少问题`);
      if (!String(it?.a || '').trim()) errors.push(`FAQ 第 ${i + 1} 条缺少答案`);
    });
  }

  const quoteList = Array.isArray(raw.testimonials) ? raw.testimonials : next.testimonials;
  if (!Array.isArray(quoteList) || !quoteList.length) errors.push('用户好评至少保留 1 条');
  else if (quoteList.length > 20) errors.push('用户好评最多 20 条');
  else {
    quoteList.forEach((it, i) => {
      if (!String(it?.quote || '').trim()) errors.push(`用户好评第 ${i + 1} 条缺少评价内容`);
      if (!String(it?.name || '').trim()) errors.push(`用户好评第 ${i + 1} 条缺少署名`);
    });
  }

  const help = isPlainObject(next.help) ? next.help : {};
  for (const k of HELP_KEYS) {
    const v = help[k];
    if (typeof v !== 'string' || !v.trim()) errors.push(`帮助页「${k}」栏目内容不能为空`);
    else if (v.length > 20000) errors.push(`帮助页「${k}」栏目超过 20000 字符上限`);
  }

  // —— 广告位：位、主题、按钮动作都是白名单枚举，越界直接拒绝 ——
  // 只校验**本次提交**的数组：没提交＝沿用当前值，不必重校验一遍。
  // 空数组合法（＝把所有广告撤掉），这是运营的正常操作。
  const promoList = Array.isArray(raw.promos) ? raw.promos : null;
  if (promoList) {
    const slotKeys = PROMO_SLOTS.map((s) => s.key);
    const themeKeys = PROMO_THEMES.map((t) => t.key);
    const actionKeys = PROMO_ACTIONS.map((a) => a.key);
    if (promoList.length > PROMO_MAX_ITEMS) errors.push(`广告位内容最多 ${PROMO_MAX_ITEMS} 条`);
    promoList.forEach((it, i) => {
      const no = `广告位第 ${i + 1} 条`;
      if (!isPlainObject(it)) {
        errors.push(`${no}格式不正确`);
        return;
      }
      const slot = String(it.slot || '');
      if (!slotKeys.includes(slot)) {
        errors.push(`${no}的「所属广告位」无效`);
        return;
      }
      const slotLabel = PROMO_SLOTS.find((s) => s.key === slot)?.label || slot;
      const name = String(it.name || '').trim();
      if (!name) errors.push(`「${slotLabel}」第 ${i + 1} 条缺少名称（用于后台辨认是哪一期内容）`);
      else if (name.length > 40) errors.push(`${no}的名称不超过 40 个字符`);
      if (it.theme !== undefined && !themeKeys.includes(String(it.theme))) errors.push(`${no}的主题不在预设范围内`);

      const c = isPlainObject(it.content) ? it.content : {};
      for (const f of PROMO_REQUIRED[slot] || []) {
        if (!String(c[f] || '').trim()) errors.push(`「${slotLabel}」的「${PROMO_FIELD_LABELS[f] || f}」不能为空`);
      }
      for (const [f, max] of Object.entries(PROMO_FIELD_MAX)) {
        const v = c[f];
        if (v === undefined || v === null || v === '') continue;
        if (typeof v !== 'string') errors.push(`${no}的「${PROMO_FIELD_LABELS[f] || f}」必须是文本`);
        else if (v.length > max) errors.push(`${no}的「${PROMO_FIELD_LABELS[f] || f}」不超过 ${max} 个字符`);
      }
      // ⭐ 按钮动作白名单：开放自由链接＝XSS / 钓鱼入口，必须挡住
      if (c.ctaAction !== undefined && !actionKeys.includes(String(c.ctaAction)))
        errors.push(`${no}的「主按钮动作」不在允许范围内`);
      if (c.moreDoc !== undefined && !LEGAL_KEYS.includes(String(c.moreDoc)))
        errors.push(`${no}的「次按钮打开的文本」不是有效的法律文本章节`);

      if (c.stats !== undefined) {
        if (!Array.isArray(c.stats)) errors.push(`${no}的「数据面板条目」格式不正确`);
        else if (c.stats.length > PROMO_MAX_STATS) errors.push(`${no}的数据面板最多 ${PROMO_MAX_STATS} 条`);
        else
          c.stats.forEach((s, j) => {
            if (!String(s?.num || '').trim()) errors.push(`${no}的数据面板第 ${j + 1} 条缺少数值`);
            if (!String(s?.label || '').trim()) errors.push(`${no}的数据面板第 ${j + 1} 条缺少说明`);
          });
      }

      const st = ts(it.startAt);
      const et = ts(it.endAt);
      if (et && st && et <= st) errors.push(`${no}的结束时间必须晚于开始时间`);
      // 促销位（slot=promo）：「排期结束时间」就是倒计时归零点 + 自动下架时刻，必填。
      // 不强制的话前台既没有倒计时可显示、广告也不会到期自动撤下（promoActive 对空 endAt 视为永不结束）。
      if (slot === 'promo' && !et) errors.push(`${no}必须填写「排期结束时间」——它同时是前台倒计时的归零点`);

      // ⭐ 合规闸门：展示业绩类数字必须写清口径，谁填的数字谁负责
      if (Array.isArray(c.stats) && c.stats.length && !String(it.dataNote || '').trim())
        errors.push(`${no}展示了业绩数字，必须填写「数据说明」（如：示例数据／统计口径与时间范围）`);
    });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// 保存（校验 → 留痕 → 落盘 → 失效缓存）
// ---------------------------------------------------------------------------

/** 部分提交：未提交的字段沿用「当前生效值」（不是回退出厂值），避免只改一项就把其余清零 */
function pick(next, current, key, sub) {
  const n = isPlainObject(next[sub]) ? next[sub] : {};
  return key in n ? n[key] : current[sub][key];
}

/** 追加一条改动留痕（保留最近 HISTORY_KEEP 条） */
function pushHistory(before, updatedBy, after) {
  const file = historyFilePath();
  const list = readJson(file, []);
  const arr = Array.isArray(list) ? list : [];
  arr.push({ at: Date.now(), updatedBy: String(updatedBy || ''), before, after });
  writeJsonAtomic(file, arr.slice(-HISTORY_KEEP));
}

/**
 * 保存站点配置（支持部分提交）。
 * @param {object} patch 形如 { brand:{...}, ops:{...} }，只提交要改的字段即可
 * @param {{updatedBy?:string}} [meta]
 * @returns {{ok:true, config:object} | {ok:false, errors:string[]}}
 */
export function saveSite(patch, { updatedBy = '' } = {}) {
  const cur = getSite();
  const p = isPlainObject(patch) ? patch : {};

  const brand = {};
  for (const key of Object.keys(DEFAULT_BRAND)) brand[key] = pick(p, cur, key, 'brand');

  const opsNext = {};
  for (const key of Object.keys(DEFAULT_OPS)) opsNext[key] = pick(p, cur, key, 'ops');

  const legal = {};
  for (const key of LEGAL_KEYS) legal[key] = pick(p, cur, key, 'legal');

  const help = {};
  for (const key of HELP_KEYS) help[key] = pick(p, cur, key, 'help');

  const next = {
    brand,
    ops: opsNext,
    legal,
    // FAQ / 好评是数组：提交了才整体替换（数组无法逐项继承，逐项合并反而容易产生夹缝数据）
    faq: Array.isArray(p.faq) ? normFaq(p.faq) : cur.faq,
    testimonials: Array.isArray(p.testimonials) ? normTestimonials(p.testimonials) : cur.testimonials,
    help,
    // 广告位同数组语义：提交了才整体替换；**提交空数组＝撤掉全部广告**（这是合法且有意的操作）
    promos: Array.isArray(p.promos) ? normPromos(p.promos) : cur.promos,
    // 商业样片展台案例
    cases: Array.isArray(p.cases) ? p.cases : (cur.cases || DEFAULT_CASES),
    // 备案模式：只接受布尔，未提交沿用当前值
    icpMode: typeof p.icpMode === 'boolean' ? p.icpMode : cur.icpMode,
    // 逢年过节活动与促销广告配置
    holidayPromo: isPlainObject(p.holidayPromo) ? { ...DEFAULT_HOLIDAY_PROMO, ...p.holidayPromo } : (cur.holidayPromo || DEFAULT_HOLIDAY_PROMO),
  };
  const errors = validateSite(next, { faq: p.faq, testimonials: p.testimonials, promos: p.promos });
  if (errors.length) return { ok: false, errors };

  pushHistory(cur, updatedBy, next);
  if (!writeJsonAtomic(siteConfigFilePath(), next)) {
    return { ok: false, errors: ['配置写入失败（磁盘不可写），已保留原值'] };
  }
  invalidateSite();
  return { ok: true, config: getSite() };
}
