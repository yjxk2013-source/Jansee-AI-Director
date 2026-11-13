// 简兮 (JANSEE) · 管理后台管理员认证与存储层 (apps/web/server/adminStore.mjs)
// 职责：
//   1. 统一管理管理员账户 (Admin Accounts)；
//   2. 提供管理员登录密码校验与 Token 会话管理；
//   3. 第一阶段采用 Mock 管理员体系，接口清晰，未来平滑替换 RBAC/SSO。

import crypto from 'node:crypto';
import { ERROR_CODES, createAppError } from './errors.mjs';

/**
 * 管理员口令哈希（scrypt + 随机盐）。
 * 修复背景：此前 password 直接明文存在记录里，任何能把内存/日志/后台管理列表翻出来的人
 * 都能直接读到凭证；一旦未来接 RBAC 或落盘，就是全量凭证泄露。
 * 格式：scrypt$<salt-hex>$<hash-hex>，自带算法标识便于日后平滑升级。
 */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

/** 校验口令；对历史明文记录保持向后兼容（仅比较，不做自动迁移，避免启动期写操作） */
function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored) return false;
  if (!stored.startsWith('scrypt$')) return stored === password;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const salt = parts[1];
  const expected = parts[2];
  if (!salt || !expected) return false;
  const calc = crypto.scryptSync(String(password), salt, 64).toString('hex');
  // 等长定长比较，避免按字节短路造成时序侧信道
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class AdminStore {
  constructor() {
    this.admins = new Map();   // username -> adminRecord
    this.sessions = new Map(); // token -> sessionRecord
    this.failedAttempts = new Map(); // username -> { count, lockUntil } 防暴力破解锁定
    this.initDefaultAdmin();
  }

  /**
   * 初始化默认 Mock 管理员
   */
  initDefaultAdmin() {
    const envPassword = process.env.JANSEE_ADMIN_PASSWORD?.trim();
    if (!envPassword && process.env.NODE_ENV === 'production') {
      throw new Error('[FATAL adminStore] 生产环境安全拦截：未配置 JANSEE_ADMIN_PASSWORD 环境变量，禁止以默认弱口令启动！');
    }
    this.createAdmin({
      username: 'admin',
      password: envPassword || 'admin123',
      role: 'super_admin',
      nickname: '系统超级管理员',
    });
    if (!envPassword) {
      console.warn(
        '[adminStore] 安全警告：管理员 admin 正在使用默认弱口令，且源码中公开可见。'
        + '上线前必须在 .env 设置 JANSEE_ADMIN_PASSWORD（建议 16 位以上随机串）。',
      );
    }
  }

  /**
   * 创建管理员账号
   * @param {object} params
   * @param {string} params.username 用户名
   * @param {string} params.password 密码
   * @param {string} [params.role='admin'] 角色 (super_admin / admin / operator)
   * @param {string} [params.nickname] 昵称
   * @returns {object}
   */
  createAdmin({ username, password, role = 'admin', nickname } = {}) {
    const cleanUser = String(username || '').trim();
    if (!cleanUser) {
      throw createAppError(ERROR_CODES.PARAM_INVALID, '创建管理员失败：用户名不能为空');
    }
    const cleanPwd = String(password || '').trim();
    if (!cleanPwd) {
      throw createAppError(ERROR_CODES.PARAM_INVALID, '创建管理员失败：密码不能为空');
    }

    if (this.admins.has(cleanUser)) {
      throw createAppError(ERROR_CODES.CREATION_FAILED, `管理员 [${cleanUser}] 已存在`);
    }

    const adminId = `adm_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const record = {
      adminId,
      username: cleanUser,
      password: hashPassword(cleanPwd), // scrypt$salt$hash，绝不存明文
      role,
      nickname: nickname || `管理员_${cleanUser}`,
      createdAt: Date.now(),
    };

    this.admins.set(cleanUser, record);
    return {
      adminId: record.adminId,
      username: record.username,
      role: record.role,
      nickname: record.nickname,
      createdAt: record.createdAt,
    };
  }

  /**
   * 管理员登录验证
   * @param {string} username
   * @param {string} password
   * @returns {{ admin: object, adminToken: string }}
   */
  verifyAdmin(username, password) {
    const cleanUser = String(username || '').trim();
    const cleanPwd = String(password || '').trim();

    const now = Date.now();
    const attempt = this.failedAttempts.get(cleanUser);
    if (attempt && attempt.lockUntil > now) {
      const waitMin = Math.ceil((attempt.lockUntil - now) / 60000);
      throw createAppError(40301, `登录失败次数过多，账号已临时锁定，请在 ${waitMin} 分钟后再试`, { status: 403 });
    }

    const record = this.admins.get(cleanUser);
    if (!record || !verifyPassword(cleanPwd, record.password)) {
      const currentCount = (attempt ? attempt.count : 0) + 1;
      const lockUntil = currentCount >= 5 ? now + 5 * 60 * 1000 : 0;
      this.failedAttempts.set(cleanUser, { count: currentCount, lockUntil });
      if (lockUntil > 0) {
        throw createAppError(40301, '连续 5 次密码错误，账号已临时锁定 5 分钟', { status: 403 });
      }
      throw createAppError(40101, `管理员账号或密码错误（连续失败 ${currentCount}/5 次后将锁定）`, { status: 401 });
    }

    // 登录成功，重置失败计数
    this.failedAttempts.delete(cleanUser);

    // 生成 adminToken
    const token = `adm_tok_${crypto.randomBytes(16).toString('hex')}`;
    const session = {
      token,
      adminId: record.adminId,
      username: record.username,
      role: record.role,
      nickname: record.nickname,
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24小时有效
    };

    this.sessions.set(token, session);

    return {
      admin: {
        adminId: record.adminId,
        username: record.username,
        role: record.role,
        nickname: record.nickname,
      },
      adminToken: token,
      expiresAt: session.expiresAt,
    };
  }

  /**
   * 校验管理员会话 Token
   * @param {string} token
   * @returns {object|null}
   */
  verifyAdminToken(token) {
    if (!token || typeof token !== 'string') return null;
    const cleanToken = token.trim();
    const session = this.sessions.get(cleanToken);
    if (!session) return null;

    if (Date.now() > session.expiresAt) {
      this.sessions.delete(cleanToken);
      return null;
    }

    return { ...session };
  }

  /**
   * 销毁管理员会话
   * @param {string} token
   * @returns {boolean}
   */
  destroyAdminSession(token) {
    if (!token || typeof token !== 'string') return false;
    return this.sessions.delete(token.trim());
  }

  /**
   * 获取所有管理员列表
   * @returns {Array<object>}
   */
  listAdmins() {
    return Array.from(this.admins.values()).map((a) => ({
      adminId: a.adminId,
      username: a.username,
      role: a.role,
      nickname: a.nickname,
      createdAt: a.createdAt,
    }));
  }

  /**
   * 重置（沙箱测试用）
   */
  clear() {
    this.admins.clear();
    this.sessions.clear();
    this.initDefaultAdmin();
  }
}

// 导出全局单例与快捷方法
export const adminStore = new AdminStore();

export function createAdmin(params) {
  return adminStore.createAdmin(params);
}

export function verifyAdmin(username, password) {
  return adminStore.verifyAdmin(username, password);
}

export function verifyAdminToken(token) {
  return adminStore.verifyAdminToken(token);
}

export function extractAdminToken(req) {
  if (!req || !req.headers) return null;
  const custom = req.headers['x-admin-token'];
  if (custom && typeof custom === 'string' && custom.trim()) {
    return custom.trim();
  }
  const auth = req.headers['authorization'];
  if (auth && typeof auth === 'string') {
    const parts = auth.trim().split(' ');
    if (parts.length === 2 && /^bearer$/i.test(parts[0])) {
      return parts[1].trim();
    }
  }
  return null;
}
