// 简兮 · 用户/资产存储（JSON 文件持久化，开发期够用）
// 数据落盘到 server/data/db.json；任务本身仍在内存 store.mjs（重启后需重新登录）。
// 约定：手机号即账号；验证码登录测试态可任意输入；注册后强制设置密码。

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './env.mjs';
import { dataFile, readJson, writeJsonAtomic } from './dataStore.mjs';
// 兜底会员等级配置与支付能力（防遗留文件缺失导致崩溃）
const tierById = (tierId) => ({ monthlyPoints: 0 });
const autoRenewAvailable = () => false;
import { ops } from './siteConfig.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = dataFile('db.json');


// —— 默认头像：每个账户兜底（灰色人形 SVG），未上传自定义头像前展示 ——
const DEFAULT_AVATAR =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#e8eaed"/><circle cx="32" cy="25" r="12" fill="#9aa0a6"/><path d="M12 56c2-12 10-18 20-18s18 6 20 18z" fill="#9aa0a6"/></svg>',
  );

// —— 敏感字段加密（AES-256-GCM）：身份证 / 真实姓名 / 支付宝账号落盘密文、内存明文 ——
// 生产环境必须设置 JX_DATA_KEY（强随机 32+ 字节）。未设置时回落开发密钥并告警（仅限本地）。
const ENC_KEY = (() => {
  const s = process.env.JX_DATA_KEY || 'jx-local-dev-key-do-not-use-in-prod-0123';
  if (!process.env.JX_DATA_KEY) {
    console.warn('[userStore] 警告：未设置 JX_DATA_KEY，敏感字段使用开发密钥。生产环境务必配置！');
  }
  return crypto.createHash('sha256').update(s).digest(); // 派生 32 字节密钥
})();
export function encrypt(plain) {
  if (plain == null || plain === '') return '';
  if (typeof plain === 'string' && plain.startsWith('enc:v1:')) return plain; // 幂等
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}
export function isEnc(s) {
  return typeof s === 'string' && s.startsWith('enc:v1:');
}
export function decrypt(s) {
  if (!isEnc(s)) return s; // 未加密（旧明文）直接返回
  try {
    const [, , iv, tag, data] = s.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch (_) {
    return '';
  } // 密钥不符/数据损坏：返回空，避免崩溃
}

const db = { users: [], tokens: {}, nextId: 1 };

function load() {
  const raw = readJson(DB_FILE, null);
  if (raw && Array.isArray(raw.users)) {
    db.users = raw.users;
    db.tokens = raw.tokens || {};
    db.likes = raw.likes || {};
    db.nextId = Number(raw.nextId) || 1;
  }
  // 存量/旧数据处理：解密敏感字段 + 补默认头像；存在明文敏感字段则触发一次重写入加密
  let changed = false;
  db.users.forEach((u) => {
    if (!u) return;
    if (isEnc(u.identityIdNo)) {
      u.identityIdNo = decrypt(u.identityIdNo);
      changed = true;
    } else if (u.identityIdNo) changed = true; // 明文 → 本次重写即加密
    if (isEnc(u.identityRealName)) {
      u.identityRealName = decrypt(u.identityRealName);
      changed = true;
    } else if (u.identityRealName) changed = true; // 明文 → 本次重写即加密
    if (isEnc(u.alipayAccount)) {
      u.alipayAccount = decrypt(u.alipayAccount);
      changed = true;
    } else if (u.alipayAccount) changed = true; // 明文 → 本次重写即加密
    if (!u.avatar) {
      u.avatar = DEFAULT_AVATAR;
      changed = true;
    }
  });
  if (changed) save();
}
function save() {
  // 仅对写盘副本加密敏感字段，内存对象保持明文（供 mask/校验直用）
  const serialUsers = db.users.map((u) =>
    u
      ? {
        ...u,
        identityIdNo: encrypt(u.identityIdNo),
        identityRealName: encrypt(u.identityRealName),
        alipayAccount: encrypt(u.alipayAccount),
      }
      : u,
  );
  writeJsonAtomic(DB_FILE, { ...db, users: serialUsers });
}
load();

// —— 默认权益：Free 免费等级（注册即享，未充值）——
export const FREE_PLAN = { name: 'Free', expiresAt: null, limitPerMonth: 30 };

// —— 超级账户（测试用）：role === 'super' 时所有功能不扣积分、不受限制 ——
export const SUPER_ROLE = 'super';
export function isSuperUser(user) {
  return !!user && (user.role === SUPER_ROLE || user.isSuper === true);
}

export function newUserId() {
  return `u${db.nextId++}`;
}

export function findUserByPhone(phone) {
  const p = String(phone || '').trim();
  // S8 双表合并查询：s8UsersMap 优先。此前只查 legacy db.users，
  // 导致 S8 用户（全部新注册）在 partnerStore 佣金/提现链路中被判「用户不存在」
  const s8 = Array.from(s8UsersMap.values()).find((u) => u.phone === p);
  if (s8) return s8;
  return db.users.find((u) => u.phone === p) || null;
}
/** 按 ID 查用户（S8 双表合并：userId 优先，legacy id 兜底） */
export function findUserById(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  const s8 = s8UsersMap.get(key);
  if (s8) return s8;
  return db.users.find((u) => u.id === key) || null;
}
/** 全部用户（管理台用，原始记录含 phone/passwordHash 等，仅后端使用） */
export function getAllUsers() {
  return db.users;
}
/** 统计自 ts（毫秒）起新增用户数 */
export function usersSince(ts) {
  return db.users.filter((u) => Number(u.createdAt) >= ts).length;
}
/** 某用户点赞/收藏的作品 id 集合 */
export function likeIds(userId) {
  return new Set(db.likes[String(userId)] || []);
}
/** 切换点赞：返回新点赞状态 */
export function toggleLike(userId, id) {
  const uid = String(userId);
  const set = db.likes[uid] || [];
  const s = new Set(set);
  let liked;
  if (s.has(id)) {
    s.delete(id);
    liked = false;
  } else {
    s.add(id);
    liked = true;
  }
  db.likes[uid] = Array.from(s);
  save();
  return liked;
}
/** 按 ID 查用户（legacy 专用，不查 S8——S8 用 findUserById 双表版） */
export function findLegacyUserById(id) {
  return db.users.find((u) => u.id === id) || null;
}
export function findUserByInviteCode(code) {
  return (
    db.users.find(
      (u) =>
        u.inviteCode ===
        String(code || '')
          .trim()
          .toUpperCase(),
    ) || null
  );
}

function makeInviteCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (findUserByInviteCode(code));
  return code;
}

// —— 密码哈希：scrypt（Node 内置，抗 GPU 暴破）——
// 格式 s2$<N>$<saltHex>$<hashHex>；存量旧格式 <saltHex>:<sha256Hex> 校验通过后透明升级为 scrypt。
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export function hashPassword(pwd) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pwd), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `s2$${SCRYPT.N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export function verifyPassword(user, pwd) {
  const stored = String(user?.passwordHash || '');
  if (!stored) return false;
  if (stored.startsWith('s2$')) {
    const [, nStr, saltHex, hashHex] = stored.split('$');
    const n = Number(nStr) || SCRYPT.N;
    try {
      const calc = crypto.scryptSync(String(pwd), Buffer.from(saltHex, 'hex'), hashHex.length / 2, {
        N: n,
        r: SCRYPT.r,
        p: SCRYPT.p,
      });
      const expect = Buffer.from(hashHex, 'hex');
      return calc.length === expect.length && crypto.timingSafeEqual(calc, expect);
    } catch (_) {
      return false;
    }
  }
  // 旧格式（sha256 单次哈希）：恒定时间比较；命中即透明升级为 scrypt（防存量弱哈希长期裸奔）
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const calc = crypto.createHash('sha256').update(`${salt}:${pwd}`).digest('hex');
  const ok = calc.length === hash.length && crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash));
  if (ok) {
    user.passwordHash = hashPassword(pwd);
    user.updatedAt = Date.now();
    save();
  }
  return ok;
}

/**
 * 读取「含 passwordHash 的内部记录」。
 * 仅供服务端鉴权使用——该对象含密码哈希，禁止直接回传客户端（对外一律走 publicUser）。
 * 兼容两套用户表：s8UsersMap（新）与 legacy db.users（旧，靠 id/phone 命中）。
 */
export function getUserAuthRecord(userId) {
  if (!userId || typeof userId !== 'string') return null;
  const id = userId.trim();
  const u8 = s8UsersMap.get(id);
  if (u8) return u8;
  for (const u of s8UsersMap.values()) {
    if (u && u.phone === id) return u;
  }
  return db.users.find((x) => x && (x.id === id || x.phone === id)) || null;
}

/**
 * 设置 / 重置登录密码（scrypt 哈希落盘，两套用户表都兼容）。
 * 调用方必须已完成身份确认（登录态或短信验证码），本函数不做任何鉴权。
 * @returns {boolean} 记录不存在返回 false
 */
export function setUserPassword(userId, plainPassword) {
  const rec = getUserAuthRecord(userId);
  if (!rec) return false;
  rec.passwordHash = hashPassword(plainPassword);
  rec.passwordUpdatedAt = Date.now();
  rec.updatedAt = Date.now();
  // 按记录归属决定落盘目标：s8 表里的是同一个引用对象，直接持久化即可
  if (rec.userId && s8UsersMap.get(String(rec.userId)) === rec) {
    saveS8Users();
  } else {
    save();
  }
  return true;
}

/** 该账号是否已设置过密码（用于「注册后引导设置」判断） */
export function hasPassword(userId) {
  const rec = getUserAuthRecord(userId);
  return !!(rec && rec.passwordHash);
}

/**
 * 创建用户（旧版持久化）；注册成功即登录。
 * @param {object} p { phone, nickname, inviterPhone?, legalAgreed?, legalAgreedAt? }
 */
export function createLegacyUser({ phone, nickname, inviterPhone, legalAgreed, legalAgreedAt }) {
  // 邀请参数可能是「邀请码」或「手机号」：统一解析为邀请人手机号（防自邀）
  let inviter = null;
  const rawInvite = String(inviterPhone || '').trim();
  if (rawInvite) {
    inviter = findUserByInviteCode(rawInvite) || findUserByPhone(rawInvite);
    if (inviter && inviter.phone === String(phone || '').trim()) inviter = null; // 自邀无效
  }
  const user = {
    id: newUserId(),
    phone: String(phone || '').trim(),
    nickname:
      String(nickname || '简兮用户')
        .trim()
        .slice(0, 20) || '简兮用户',
    bio: '',
    avatar: DEFAULT_AVATAR, // 注册即分配默认头像，未上传自定义头像前展示
    passwordHash: '', // 注册后需强制设置密码
    role: '', // 角色：'' 普通用户；'super' 超级测试账户（不扣积分）
    tier: 'free', // 会员等级：free / lite / pro / plus / ultra（注册即 Free，未充值）
    points: Number(ops().signupPoints) || 0, // 基础积分池（注册赠送/签到/邀请/充值/加油包累积，永不清零）；赠送额以 siteConfig 运营参数为准
    subPoints: 0, // 订阅额度池：会员订阅发放的当月积分（续费时覆盖重发，不累计）
    subExpireAt: 0, // 订阅额度到期时间戳（0 = 无有效订阅额度）
    lastCheckin: '', // 最近一次签到日期（YYYY-MM-DD，同一天只奖一次）
    plan: { ...FREE_PLAN },
    // 连续包月标记：选择「连续包月」购买即为 true，单月购买恒为 false。
    // 它表示用户走的是**签约续费**这条线，与「单月购买（一次性）」是两种不同产品形态；
    // 但能否真的自动扣款取决于支付通道是否具备周期扣款能力
    // （见 paymentProvider.autoRenewAvailable()）——通道未接入时到期仍需手动续费。
    autoRenew: false,
    renewReminderSent: 0, // 到期提醒已发到的提前天数级别（3/1/0；用于避免对同一用户重复发到期提醒）
    // 【已废弃】签约协议曾计划存在此处，实际统一存 user.plan.agreement
    // （读取方见 renewal.mjs agreementOf()）。保留字段仅为兼容旧数据，任何新代码勿写入。
    alipayAgreement: null,
    inviteCode: makeInviteCode(),
    inviterPhone: inviter ? inviter.phone : '',
    province: '', // 所在省份（注册时按 IP 粗定位，用于会员分布地图）
    partnerCity: '', // 城市合伙人所在城市（手动选择，达标后展示）
    partnerAt: null, // 升级为城市合伙人的时间戳（null = 未达标）
    payQrWechat: '', // 【已废弃】微信收款码图片地址（真实打款不可打回收款码，不再使用）
    payQrAlipay: '', // 【已废弃】支付宝收款码图片地址
    identityRealName: '', // 实名：真实姓名（模拟身份证二要素核验后落库）
    identityIdNo: '', // 实名：身份证号（安全存储，仅脱敏对外）
    identityVerifiedAt: null, // 实名核验通过时间戳（null=未实名）
    alipayAccount: '', // 支付宝账号（提现打款收款账户；手机号/邮箱，敏感，落盘加密；可修改）
    alipayName: '', // 支付宝实名姓名（须与支付宝账户实名一致，兼作个税申报姓名；可修改）
    alipayQr: '', // 支付宝收款码图片（提现收款二维码，/uploads/partner/{uid}/...；可替换）
    withdrawProfileReadyAt: null, // 提现资料提交时间戳（null=未提交）
    withdrawProfileLog: [], // 提现资料修改留痕（改前/改后/时间，账号脱敏；供后台审计）
    legalAgreed: legalAgreed || false, // 是否已勾选同意《服务条款》《隐私政策》
    legalAgreedAt: legalAgreedAt || null, // 同意时间戳（null=未确认）
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  db.users.push(user);
  save();

  // 好友注册 → 邀请人 +N 积分（N 以 siteConfig 运营参数为准；城市合伙人不再自动升级，由用户手动点击升级）
  if (inviter) {
    inviter.points = (Number(inviter.points) || 0) + (Number(ops().inviteReward) || 0);
    inviter.updatedAt = Date.now();
    save();
  }
  return user;
}

// —— 城市合伙人：邀请满 N 人，用户手动点击升级（N 以 siteConfig 运营参数为准） ——
export function partnerTarget() {
  return Number(ops().partnerTarget) || 5;
}

/** 某用户的邀请人数（成功注册的好友数，legacy(db.users) + S8(s8UsersMap) 双表合并） */
export function invitedCount(phone) {
  return usersByInviter(phone).length;
}

/** 被该用户邀请注册的用户列表（推广明细用，legacy + S8 双表合并统计） */
export function usersByInviter(phone) {
  const p = String(phone || '').trim();
  if (!p) return [];
  const fromLegacy = db.users.filter((u) => u.inviterPhone === p);
  const fromS8 = Array.from(s8UsersMap.values()).filter((u) => u.inviterPhone === p);
  return [...fromLegacy, ...fromS8];
}

/** 是否已是城市合伙人（partnerAt 已设置即视为达标） */
export function isPartner(user) {
  return !!user && !!user.partnerAt;
}

/** 邀请满 N 人升级为城市合伙人（幂等：已升级或未达标均不动）。由用户手动触发，不再自动调用 */
export function upgradePartnerIfEligible(user) {
  if (!user || user.partnerAt) return user;
  if (invitedCount(user.phone) >= partnerTarget()) {
    user.partnerAt = Date.now();
    user.updatedAt = Date.now();
    save();
  }
  return user;
}

/**
 * 用户主动升级为城市合伙人（前台「升级为城市合伙人」按钮的后端真实实现）：
 * 校验受邀满 partnerTarget 人后，经 updateUser 写入 partnerAt 并持久化（S8 / legacy 双表通用）。
 * 取代前端原本「本地伪造 isPartner=true」的假升级——达标状态现在以服务端为准。
 * @param {string} uid 用户 ID（S8 的 userId 或 legacy 的 id）
 * @returns {{ok?:boolean, partnerAt?:number, count?:number, target?:number, already?:boolean, error?:string}}
 */
export function upgradeToPartner(uid) {
  const id = String(uid || '').trim();
  if (!id) return { error: '缺少用户标识' };
  const u = findUserById(id) || getUser(id);
  if (!u) return { error: '用户不存在' };
  if (u.partnerAt) return { ok: true, partnerAt: u.partnerAt, already: true };
  const target = partnerTarget();
  const count = invitedCount(u.phone);
  if (count < target) {
    return { error: `邀请人数不足：当前 ${count}/${target} 人，需满 ${target} 人才能升级`, count, target };
  }
  // 经 updateUser 修改源对象并持久化（S8 落 s8-users.json / legacy 落 db.json）
  updateUser(u.userId || u.id, { partnerAt: Date.now() });
  const updated = findUserById(u.userId || u.id) || getUser(u.userId || u.id);
  return { ok: true, partnerAt: updated?.partnerAt || Date.now(), count, target };
}

export function updateLegacyUser(id, patch) {
  const u = findUserById(id);
  if (!u) return null;
  Object.assign(u, patch, { updatedAt: Date.now() });
  save();
  return u;
}

/**
 * 更新提现资料（支付宝实名 + 账号 + 收款码，均可修改）：
 * 自动追加修改留痕（改前 / 改后 / 时间 / 操作人），账号脱敏落库，供后台审计追溯。
 * 路由层需先完成登录密码二次验证再调用本函数。
 * @param {object} user 已登录用户对象
 * @param {object} p { alipayName, alipayAccount, alipayQr }
 * @returns 更新后的用户对象
 */
export function updateWithdrawProfile(user, { alipayName, alipayAccount, alipayQr }) {
  const log = Array.isArray(user.withdrawProfileLog) ? user.withdrawProfileLog.slice() : [];
  log.push({
    at: Date.now(),
    by: user.id,
    before: {
      alipayName: user.alipayName || '',
      alipayAccount: maskAlipay(user.alipayAccount), // 脱敏存证，避免明文账号二次落库
    },
    after: {
      alipayName,
      alipayAccount: maskAlipay(alipayAccount),
    },
  });
  if (log.length > 20) log.splice(0, log.length - 20); // 仅保留最近 20 条，防无限增长
  // S8 用户主键是 userId（无 id 字段），legacy 用户是 id——统一兼容，
  // 否则对 S8 用户 updateUser(undefined) 静默失败，withdrawProfileReadyAt 永远写不上
  return updateUser(user.userId || user.id, {
    alipayName,
    alipayAccount,
    alipayQr,
    withdrawProfileReadyAt: Date.now(),
    withdrawProfileLog: log,
  });
}

export function deleteUser(id) {
  const i = db.users.findIndex((u) => u.id === id);
  if (i < 0) return false;
  db.users.splice(i, 1);
  save();
  return true;
}

export function addPoints(id, delta) {
  const u = findUserById(id);
  if (!u) return null;
  u.points = Math.max(0, (Number(u.points) || 0) + Number(delta || 0));
  u.updatedAt = Date.now();
  save();
  return u;
}

// —— 会员订阅额度发放（与会员有效期同步：购买/续费时一次性发放当月额度） ——
// 规则（用户指定）：每月没用完的不累计，下月续费时自动清零并重新发放。
// 实现：直接覆盖 subPoints（旧额度即清零）+ 刷新 subExpireAt；充值/签到积分（points 池）永不清零。
export function grantSubscriptionPoints(id, tierId, expireBaseTs = Date.now()) {
  const u = findUserById(id);
  if (!u) return null;
  const points = Number(tierId && tierById(tierId).monthlyPoints) || 0;
  u.subPoints = points; // 覆盖 = 上月未用完自动清零 + 发放本月额度
  u.subExpireAt = points > 0 ? expireBaseTs : 0;
  u.updatedAt = Date.now();
  save();
  return u;
}

/** 有效订阅额度：未到期才可用 */
export function subPointsOf(u) {
  const p = Number(u?.subPoints || 0);
  const exp = Number(u?.subExpireAt || 0);
  return exp > Date.now() ? Math.max(0, p) : 0;
}

/** 任务失败原路退回订阅额度（幂等由调用方按 refundedAt 保证） */
export function refundSubPoints(id, delta) {
  const u = findUserById(id);
  if (!u) return null;
  u.subPoints = Math.max(0, (Number(u.subPoints) || 0) + Number(delta || 0));
  u.updatedAt = Date.now();
  save();
  return u;
}

// —— 会员到期生命周期巡检 ——
// 本函数只负责「到期提醒 + 到期降级」两件状态正确的事；**自动续费不在这里**——
// 它由 renewal.mjs 在到期前调度（按协议价代扣，成功即顺延到期日，于是本函数看不到这笔到期）。
//   1) 到期前 3/1/0 天：记录提醒标记（短信通道未接，仅落日志，标记避免重复发）。
//   2) 到期后：一律降级为 Free。能走到这里说明这笔会员**没被自动续费续上**，
//      原因按日志分三类：单月购买（本就不自动续）、连续包月但自动续费通道未接入、
//      连续包月且通道可用但扣款未成功（签约失效 / 重试耗尽 / 余额不足）。分清楚才好排查。
// 叠加幂等：降级后 plan.expiresAt 置空，不会二次处理同一用户。
export function processExpiringMembers(now = Date.now()) {
  const DAY = 86400000;
  let downgraded = 0;
  let reminded = 0;
  let changed = false;
  const users = getAllUsers();
  for (const u of users) {
    const tier = u.tier;
    if (!tier || tier === 'free') continue;
    const exp = Number(u.plan?.expiresAt || 0);
    if (!(exp > 0)) continue;
    if (exp <= now) {
      // 到期 → 降级
      if (u.autoRenew) {
        const amt = Number(u.plan?.lockedPrice) > 0 ? `应续 ¥${u.plan.lockedPrice}` : '应按锁定价续费';
        if (autoRenewAvailable()) {
          console.warn(`[memberLifecycle] 用户 ${u.id} (${tier}) 连续包月到期·自动续费未成功(${amt}) → 降级为 Free`);
        } else {
          console.warn(
            `[memberLifecycle] 用户 ${u.id} (${tier}) 连续包月到期，但自动续费通道未接入(${amt}) → 本次需手动续费，降级为 Free`,
          );
        }
      } else {
        console.warn(`[memberLifecycle] 用户 ${u.id} (${tier}) 单月购买到期 → 降级为 Free`);
      }
      u.tier = 'free';
      u.plan = { ...FREE_PLAN };
      u.autoRenew = false;
      u.subPoints = 0;
      u.subExpireAt = 0;
      u.updatedAt = now;
      downgraded += 1;
      changed = true;
      continue;
    }
    // 未到期：提前提醒（短信通道未接入，落日志 + 标记）
    const daysLeft = Math.ceil((exp - now) / DAY);
    for (const d of [3, 1, 0]) {
      if (daysLeft <= d && Number(u.renewReminderSent || 0) < d) {
        u.renewReminderSent = d;
        u.updatedAt = now;
        console.warn(
          `[memberLifecycle] 用户 ${u.id} (${tier}) 到期提醒：${daysLeft === 0 ? '今天到期' : `距到期 ${daysLeft} 天`}（短信通道未接入，待通知）`,
        );
        reminded += 1;
        changed = true;
        break;
      }
    }
  }
  if (changed) save();
  return { downgraded, reminded };
}

// —— 统一出片扣费（创作场景工作台六大版块共用同一口径）——
// 每次出片/生成一条视频扣 N 积分（N 以 siteConfig 运营参数为准）；积分不足拒绝。
// 扣费顺序：优先扣「订阅额度池」(subPoints，有月时效) → 不足再扣「基础积分池」(points)。
export function generatePointCost() {
  return Number(ops().generateCost) || 200;
}

export function chargeGeneration(userId) {
  const user = userId ? findUserById(userId) : null;
  if (!user) return { ok: false, status: 401, message: '请先登录' };
  // 单次调用内只取一次扣费额：保证「余额判定」与「实际扣减」用的是同一个值
  const cost = generatePointCost();
  // 超级测试账户（role=super）也统一扣积分，与普通账户同口径（2026-09 起不再免扣）
  // ① 优先扣订阅额度（未过期）
  const sub = subPointsOf(user);
  if (sub >= cost) {
    user.subPoints = sub - cost;
    user.updatedAt = Date.now();
    save();
    return {
      ok: true,
      exempt: false,
      charged: true,
      pool: 'sub',
      points: Number(user.points) || 0,
      subPoints: user.subPoints,
    };
  }
  // ② 退扣基础积分池（充值/签到/赠送，永不清零）
  const points = Number(user.points) || 0;
  if (points >= cost) {
    const updated = addPoints(user.id, -cost);
    return {
      ok: true,
      exempt: false,
      charged: true,
      pool: 'points',
      points: updated ? Number(updated.points) || 0 : points,
      subPoints: sub,
    };
  }
  return { ok: false, status: 402, message: '积分不足，去签到领积分或充值' };
}

// —— 每日签到：每天奖励 N 积分（N 以 siteConfig 运营参数为准），同一天只签到一次 ——
export function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function checkedInToday(id) {
  const u = findUserById(id);
  return !!u && u.lastCheckin === localDate();
}
/** 签到：未签则 +N 积分并记录日期；已签则不加分。返回 { already, points } */
export function checkin(id) {
  const u = findUserById(id);
  if (!u) return null;
  if (checkedInToday(id)) return { already: true, points: Number(u.points) || 0 };
  u.points = (Number(u.points) || 0) + (Number(ops().checkinPoints) || 0);
  u.lastCheckin = localDate();
  u.updatedAt = Date.now();
  save();
  return { already: false, points: Number(u.points) || 0 };
}

// —— Token 会话（持久化，重启后仍有效；30 天过期，防无限累积与永久会话） ——
// 格式演进：旧值 = "userId" 字符串（无过期）；新值 = { uid, exp }。旧值在首次校验时透明迁移。
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
export function createToken(userId) {
  const token = `tk-${crypto.randomBytes(16).toString('hex')}`;
  db.tokens[token] = { uid: userId, exp: Date.now() + TOKEN_TTL_MS };
  save();
  return token;
}
export function deleteToken(token) {
  if (db.tokens[token]) {
    delete db.tokens[token];
    save();
  }
}
export function userIdByToken(token) {
  const t = String(token || '').trim();
  const rec = db.tokens[t];
  if (!rec) return null;
  if (typeof rec === 'string') {
    // 旧格式迁移：视为新签发，重新起算 30 天
    db.tokens[t] = { uid: rec, exp: Date.now() + TOKEN_TTL_MS };
    save();
    return rec;
  }
  if (!rec?.exp || rec.exp < Date.now()) {
    delete db.tokens[t];
    save();
    return null;
  }
  // 滑动续期：剩余不足一半有效期时续满，活跃用户不再被 30 天硬过期踢下线（2026-10-02）。
  // 只在临近过期才写库，避免每个请求都 save。
  const left = rec.exp - Date.now();
  if (left < TOKEN_TTL_MS / 2) {
    rec.exp = Date.now() + TOKEN_TTL_MS;
    save();
  }
  return rec.uid || null;
}
// 过期 token 定期清扫（防 db.tokens 无限增长）；旧格式不在此处理，由访问时惰性迁移
setInterval(
  () => {
    const now = Date.now();
    let changed = false;
    for (const [t, rec] of Object.entries(db.tokens)) {
      if (rec && typeof rec === 'object' && (!rec.exp || rec.exp < now)) {
        delete db.tokens[t];
        changed = true;
      }
    }
    if (changed) save();
  },
  6 * 3600 * 1000,
).unref?.();

/** 脱敏用户信息（供前端展示，不泄露密码/token） */
export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    phone: user.phone,
    nickname: user.nickname,
    bio: user.bio,
    avatar: user.avatar,
    role: user.role || '',
    tier: user.tier || 'free',
    points: user.points,
    subPoints: user.subPoints || 0, // 订阅额度池（当月有效，续费重发）
    subExpireAt: user.subExpireAt || 0, // 订阅额度到期时间戳
    lastCheckin: user.lastCheckin || '',
    plan: user.plan,
    inviteCode: user.inviteCode,
    inviterPhone: user.inviterPhone,
    partnerCity: user.partnerCity || '',
    partnerAt: user.partnerAt || null,
    identityVerified: !!user.identityVerifiedAt, // 是否已完成实名核验
    identityRealName: maskRealName(user.identityRealName),
    identityIdNo: maskIdNo(user.identityIdNo),
    alipayAccount: maskAlipay(user.alipayAccount), // 支付宝账号（脱敏）
    // 连续包月标记（与「单月购买」相对）：true=走签约续费线，false=一次性。
    // 能否真的自动扣款取决于通道能力位（见 paymentProvider.autoRenewAvailable()）——
    // 前端**不得写死**「会自动续费」也不得写死「不会自动扣款」，一律按
    // GET /api/member/tiers 的 pay.autoRenew 分支。
    autoRenew: !!user.autoRenew,
    needsPassword: !user.passwordHash,
    createdAt: user.createdAt,
  };
}

// —— 脱敏工具（实名信息 / 支付宝账号不外泄完整值） ——
export function maskRealName(name) {
  const v = String(name || '').trim();
  if (!v) return '';
  if (v.length <= 1) return v;
  return v[0] + '*'.repeat(v.length - 1);
}
export function maskIdNo(idNo) {
  const v = String(idNo || '').trim();
  if (v.length < 15) return v ? `${v.slice(0, 3)}****` : '';
  return `${v.slice(0, 3)}***********${v.slice(-4)}`;
}
export function maskAlipay(acc) {
  const v = String(acc || '').trim();
  if (!v) return '';
  // 手机号：前3后4；其余（邮箱/字符串账号）：前2 尾2
  if (/^1\d{10}$/.test(v)) return `${v.slice(0, 3)}****${v.slice(-4)}`;
  if (v.length <= 4) return `${v[0]}***`;
  return `${v.slice(0, 2)}****${v.slice(-2)}`;
}
/** 统一社会信用代码脱敏：前后各 4 */
export function maskCreditCode(code) {
  const v = String(code || '')
    .trim()
    .toUpperCase();
  if (!v) return '';
  if (v.length <= 8) return `${v.slice(0, 2)}****`;
  return `${v.slice(0, 4)}********${v.slice(-4)}`;
}

// =========================================================================
// S8 统一用户账户抽象层 (User Store Abstract Layer)
// 内存 Map 实现，接口契约清晰，预留未来平滑接入 Redis / PostgreSQL
// =========================================================================

export const s8UsersMap = new Map();

// 原先此处硬编码了一个「官方测试商户 13888888888」账号，导致后台合伙人/用户列表
// 永远至少有一条假数据。2026-10-28 清除测试数据时移除；账号改为按真实注册产生。

// —— s8 账户落盘（2026-10-28 补）——
// 历史问题：注册接口只写 s8UsersMap（纯内存），服务一重启全部用户与积分蒸发。
// 现在注册/改资料后写入 data/s8-users.json，进程启动时还原。
const S8_USERS_FILE = dataFile('s8-users.json');

// 测试（node test-*.mjs / --test）默认不落盘，避免把断言用的假账号写进真实用户表。
const S8_PERSIST_ENABLED = (() => {
  if (process.env.JX_NO_PERSIST === '1') return false;
  const entry = String(process.argv[1] || '').replace(/\\/g, '/');
  return !/(^|\/)tests?\//.test(entry);
})();

function saveS8Users() {
  if (!S8_PERSIST_ENABLED) return false;
  const ok = writeJsonAtomic(S8_USERS_FILE, { users: Array.from(s8UsersMap.values()) });
  if (!ok) console.error('[userStore] s8 账户落盘失败，注册数据可能未持久化');
  return ok;
}

(function loadS8Users() {
  if (!S8_PERSIST_ENABLED) return;
  const raw = readJson(S8_USERS_FILE, null);
  const list = raw && Array.isArray(raw.users) ? raw.users : [];
  for (const u of list) {
    if (!u || !u.userId) continue;
    s8UsersMap.set(String(u.userId), { ...u });
  }
})();

/**
 * 创建新用户
 * @param {object} params
 * @param {string} params.phone 手机号
 * @param {string} [params.nickname] 昵称
 * @param {string} [params.status='active'] 状态
 * @returns {object} 用户对象
 */
export function createUser({ phone, nickname, status = 'active', inviterUid, registerIp = '', registerRegion = '', channel = '' } = {}) {
  const cleanPhone = String(phone || '').trim();
  if (!cleanPhone) {
    throw new Error('创建用户失败：手机号不能为空');
  }

  // 检查是否已有同手机号用户
  for (const u of s8UsersMap.values()) {
    if (u.phone === cleanPhone) {
      return { ...u };
    }
  }

  // 解析邀请人：支持 uid / 邀请码 / 手机号，统一存「邀请人手机号」作为受邀链与分润的关联键
  // （grantCommission / usersByInviter 都以 phone 为匹配键，避免引入第二套主键导致两表口径分裂）
  // 注意：注册用户均为 S8 用户（userId 形如 usr_xxx，不在 legacy db.users 表），
  // 必须用 getUser() 双表合并查询；若只查 findUserById() 会漏掉 S8 邀请人，导致受邀计数与分润断裂。
  let inviterPhone = '';
  const rawInv = String(inviterUid || '').trim();
  if (rawInv && rawInv !== cleanPhone) {
    const inv = getUser(rawInv) || findUserByInviteCode(rawInv) || findUserByPhone(rawInv);
    if (inv && inv.phone && inv.phone !== cleanPhone) inviterPhone = inv.phone;
  }

  const userId = `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const now = Date.now();
  const user = {
    userId,
    phone: cleanPhone,
    nickname: String(nickname || `用户_${cleanPhone.slice(-4)}`).trim(),
    status: status || 'active',
    tier: 'free', // 注册即 Free：会员等级默认免费档，只有充值（带 tierId 的订单）才升级
    inviterPhone, // 邀请人手机号（好友注册 → 邀请人积分奖励 + 一级/二级分润的关联键）
    registerIp: String(registerIp || '').trim(),
    registerRegion: String(registerRegion || '').trim(),
    channel: String(channel || '').trim(),
    videoCreatedCount: 0, // 累计生成成片视频条数
    videoDownloadedCount: 0, // 累计下载成片视频条数
    createdAt: now,
    updatedAt: now,
  };

  s8UsersMap.set(userId, user);
  saveS8Users();
  return { ...user };
}

/**
 * 查询用户详情
 * @param {string} userId
 * @returns {object|null}
 */
export function getUser(userId) {
  if (!userId || typeof userId !== 'string') return null;
  const cleanId = userId.trim();
  const user = s8UsersMap.get(cleanId);
  if (user) return { ...user };
  for (const u of s8UsersMap.values()) {
    if (u.phone === cleanId || u.userId === cleanId) return { ...u };
  }
  const legacy = findUserById(cleanId);
  return legacy ? { ...legacy, userId: legacy.id } : null;
}

/**
 * 局部更新用户信息
 * @param {string} userId
 * @param {object} patch 增量字段
 * @returns {object|null}
 */
export function updateUser(userId, patch = {}) {
  if (!userId || typeof userId !== 'string') return null;
  const user = s8UsersMap.get(userId.trim());
  if (user) {
    const updated = {
      ...user,
      ...patch,
      userId: user.userId, // 禁止篡改 userId
      phone: patch.phone ? String(patch.phone).trim() : user.phone,
      updatedAt: Date.now(),
    };
    s8UsersMap.set(userId.trim(), updated);
    saveS8Users();
    return { ...updated };
  }
  return updateLegacyUser(userId.trim(), patch);
}

/**
 * 查询用户列表
 * @param {object} [filter]
 * @returns {Array<object>}
 */
export function listUsers(filter = {}) {
  const { status, limit = 50, offset = 0 } = filter;
  let all = Array.from(s8UsersMap.values());

  if (db.users && Array.isArray(db.users)) {
    const existingIds = new Set(all.map((u) => u.userId || u.id));
    for (const du of db.users) {
      if (!du) continue;
      const uid = String(du.id || du.userId);
      if (!existingIds.has(uid)) {
        all.push({
          userId: uid,
          id: du.id,
          phone: du.phone,
          nickname: du.nickname || `商户_${String(du.phone || '').slice(-4)}`,
          status: du.isFrozen ? 'frozen' : (du.status || 'active'),
          points: du.points || 0,
          totalPaid: du.totalPaid || 0,
          partnerCity: du.partnerCity || '',
          partnerAt: du.partnerAt || null,
          alipayAccount: du.alipayAccount || '',
          identityRealName: du.identityRealName || '',
          registerIp: du.registerIp || '',
          registerRegion: du.registerRegion || du.province || '',
          channel: du.channel || '',
          videoCreatedCount: Number(du.videoCreatedCount) || 0,
          videoDownloadedCount: Number(du.videoDownloadedCount) || 0,
          createdAt: du.createdAt || Date.now(),
        });
      }
    }
  }

  if (status) {
    all = all.filter((u) => u.status === status);
  }

  all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return all.slice(offset, offset + limit).map((u) => ({ ...u }));
}

/** 累加用户生成视频数 */
export function recordUserVideoCreated(userId) {
  if (!userId) return;
  const u = getUser(userId);
  if (!u) return;
  const next = (Number(u.videoCreatedCount) || 0) + 1;
  updateUser(u.userId || u.id, { videoCreatedCount: next });
}

/** 累加用户下载视频数 */
export function recordUserVideoDownloaded(userId) {
  if (!userId) return;
  const u = getUser(userId);
  if (!u) return;
  const next = (Number(u.videoDownloadedCount) || 0) + 1;
  updateUser(u.userId || u.id, { videoDownloadedCount: next });
}


