// 简兮 (JANSEE) · 用户身份验证抽象层 (apps/web/server/auth.mjs)
// 职责：
//   1. 统一管理用户登录会话与 Session 状态；
//   2. 第一阶段提供标准 Mock Token 机制，解耦真实短信与验证码通道；
//   3. 支撑请求级身份鉴权与多租户用户数据隔离。

import crypto from 'node:crypto';
import { dataFile, readJson, writeJsonAtomic } from './dataStore.mjs';

// 会话落盘（2026-10-28）：登录态原本只存在内存 Map 里，服务一重启/热更新，
// 所有已登录用户集体掉线。上线后这意味着「每次发版全员重新登录」。
// 现在签发/销毁会话时写入 data/s8-sessions.json，进程启动时还原（过期的自动丢弃）。
// 测试与 JX_NO_PERSIST=1 时不落盘，避免污染真实数据。
const SESSIONS_FILE = dataFile('s8-sessions.json');

const PERSIST_ENABLED = (() => {
  if (process.env.JX_NO_PERSIST === '1') return false;
  const entry = String(process.argv[1] || '').replace(/\\/g, '/');
  return !/(^|\/)tests?\//.test(entry);
})();

export class AuthManager {
  constructor() {
    this.sessions = new Map(); // sessionToken -> { userId, sessionToken, createdAt, expireAt, ttlMs }
    // 默认 365 天有效（2026-10-29）：移动端 App / 主屏幕图标要求「登录一次长期记住」，
    // 原 24 小时会让用户几乎每天重新登录。配合下方滑动续期，活跃用户不会掉线。
    this.DEFAULT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
    // 滑动续期阈值上限：剩余有效期低于该值即自动延长一个完整周期
    this.RENEW_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
    this.persistEnabled = PERSIST_ENABLED;
    if (this.persistEnabled) this.restore();
  }

  /** 启动时还原未过期会话 */
  restore() {
    const raw = readJson(SESSIONS_FILE, null);
    const list = raw && Array.isArray(raw.sessions) ? raw.sessions : [];
    const now = Date.now();
    let n = 0;
    for (const s of list) {
      if (!s || !s.sessionToken || !s.userId || !(Number(s.expireAt) > now)) continue;
      const storedTtl = Number(s.ttlMs) || (Number(s.expireAt) - Number(s.createdAt)) || this.DEFAULT_TTL_MS;
      // 存量短会话升级：旧版签发的是 24 小时会话，重启后直接升为长期会话，
      // 已登录用户无需重新登录一次，即可获得「登录一次长期记住」的体验。
      const isShort = storedTtl < this.RENEW_THRESHOLD_MS;
      const ttlMs = isShort ? this.DEFAULT_TTL_MS : storedTtl;
      const expireAt = isShort ? now + ttlMs : Number(s.expireAt);
      this.sessions.set(String(s.sessionToken), {
        sessionToken: String(s.sessionToken),
        userId: String(s.userId),
        createdAt: Number(s.createdAt) || now,
        expireAt,
        ttlMs,
      });
      n++;
    }
    if (n > 0) {
      console.log(`[AUTH] 已恢复 ${n} 个有效登录会话`);
      this.persist();
    }
  }

  /** 全量落盘（顺手清理过期会话，避免文件无限膨胀） */
  persist() {
    if (!this.persistEnabled) return;
    const now = Date.now();
    const list = [];
    for (const [token, s] of this.sessions) {
      if (s.expireAt > now) list.push(s);
      else this.sessions.delete(token);
    }
    writeJsonAtomic(SESSIONS_FILE, { sessions: list });
  }

  /**
   * 为指定用户创建会话
   * @param {string} userId
   * @param {number} [ttlMs] 有效期毫秒数
   * @returns {string} sessionToken
   */
  createSession(userId, ttlMs) {
    if (!userId || typeof userId !== 'string') {
      throw new Error('创建会话失败：缺少合法 userId');
    }
    const cleanUid = userId.trim();
    // 会话令牌必须取自 CSPRNG。Math.random 是可预测的伪随机序列（V8 xorshift128+，
    // 观测若干输出即可还原内部状态），用它签发 session 等于给登录态留了伪造后门。
    // 保留 sess_<毫秒>_<随机> 的外形，避免影响任何按前缀解析的调用方。
    const token = `sess_${Date.now()}_${crypto.randomBytes(24).toString('hex')}`;
    const now = Date.now();
    const ttl = Number(ttlMs) || this.DEFAULT_TTL_MS;

    const session = {
      sessionToken: token,
      userId: cleanUid,
      createdAt: now,
      expireAt: now + ttl,
      ttlMs: ttl,
    };

    this.sessions.set(token, session);
    this.persist();
    return token;
  }

  /**
   * 校验并获取有效会话
   * @param {string} sessionToken
   * @returns {object|null} 包含 userId 的 session 对象，无效或过期返回 null
   */
  verifySession(sessionToken) {
    if (!sessionToken || typeof sessionToken !== 'string') return null;
    const token = sessionToken.trim();
    const session = this.sessions.get(token);
    if (!session) return null;

    const now = Date.now();
    if (now > session.expireAt) {
      this.sessions.delete(token);
      return null;
    }

    // 滑动续期：剩余有效期不足阈值时自动延长一个完整周期，活跃用户永不过期。
    // 阈值取「30 天」与「周期 1/4」的较小值，短周期会话（如测试/临时令牌）不受影响。
    const ttl = Number(session.ttlMs) || this.DEFAULT_TTL_MS;
    const renewThreshold = Math.min(this.RENEW_THRESHOLD_MS, Math.floor(ttl / 4));
    if (session.expireAt - now < renewThreshold) {
      session.expireAt = now + ttl;
      session.ttlMs = ttl;
      this.persist();
    }

    return { ...session };
  }

  /**
   * 销毁会话 (登出)
   * @param {string} sessionToken
   * @returns {boolean}
   */
  destroySession(sessionToken) {
    if (!sessionToken || typeof sessionToken !== 'string') return false;
    const ok = this.sessions.delete(sessionToken.trim());
    if (ok) this.persist();
    return ok;
  }

  /**
   * 从 HTTP 请求中提取会话凭据
   * 优先级：Header Authorization (Bearer) > Header x-session-token > Cookie sessionToken
   * @param {object} req
   * @returns {string}
   */
  extractToken(req) {
    if (!req || !req.headers) return '';
    const authHeader = req.headers.authorization || req.headers.Authorization || '';
    if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
      return authHeader.substring(7).trim();
    }
    const customHeader = req.headers['x-session-token'] || req.headers['X-Session-Token'] || '';
    if (typeof customHeader === 'string' && customHeader.trim()) {
      return customHeader.trim();
    }
    const cookieHeader = req.headers.cookie || '';
    if (cookieHeader) {
      const match = cookieHeader.match(/(?:^|;\s*)sessionToken=([^;]+)/);
      if (match) return decodeURIComponent(match[1]).trim();
    }
    return '';
  }

  /**
   * 清理全部会话（测试重置用）
   */
  clear() {
    this.sessions.clear();
  }
}

// 导出全局鉴权管理器单例
export const authManager = new AuthManager();
export const createSession = (uid, ttl) => authManager.createSession(uid, ttl);
export const verifySession = (token) => authManager.verifySession(token);
export const destroySession = (token) => authManager.destroySession(token);
export const extractSessionToken = (req) => authManager.extractToken(req);
