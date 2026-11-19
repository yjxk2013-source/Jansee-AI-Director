import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { resolveRegistrationRegion } from "./geo.js";
// @ts-ignore
import { sendVerifyCode, checkVerifyCode } from "@jansee/sms-kit";

function scrypt(password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCallback(password, salt, length, options, (error, derived) => error ? reject(error) : resolve(derived as Buffer)));
}
const SESSION_COOKIE = "jansee_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const RegisterSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(128),
  displayName: z.string().trim().min(1).max(80).optional(),
  inviteCode: z.string().trim().min(4).max(16).optional(),
}).strict();
const LoginSchema = z.object({ phone: z.string().trim(), password: z.string().min(1).max(128) }).strict();
const PasswordSchema = z.object({ password: z.string().min(8).max(128) }).strict();

const SmsSendSchema = z.object({
  phone: z.string().trim(),
}).strict();

const SmsLoginSchema = z.object({
  phone: z.string().trim(),
  code: z.string().trim(),
  inviteCode: z.string().trim().min(4).max(16).optional(),
}).strict();

export interface AuthUser {
  id: string;
  email?: string;
  phone?: string;
  displayName: string | null;
  createdAt: Date;
  isGuest?: boolean;
}
export interface AuthStore {
  createUser(input: { email?: string; phone?: string; passwordHash?: string; displayName: string | null; inviteCode?: string | undefined; registerProvince?: string | undefined; registerCity?: string | undefined; registerRegion?: string | undefined }): Promise<AuthUser>;
  findUserByEmail(email: string): Promise<(AuthUser & { passwordHash?: string; status: string }) | null>;
  findUserByPhone?(phone: string): Promise<(AuthUser & { passwordHash?: string; status: string }) | null>;
  setPassword?(userId: string, passwordHash: string): Promise<AuthUser | null>;
  updateDisplayName?(userId: string, displayName: string): Promise<AuthUser | null>;
  createSession(input: { userId: string; tokenHash: string; userAgent: string | null; ipHash: string; expiresAt: Date }): Promise<void>;
  findSession(tokenHash: string): Promise<{ user: AuthUser; expiresAt: Date } | null>;
  revokeSession(tokenHash: string): Promise<void>;
}
export interface AuthOptions {
  store: AuthStore;
  allowedOrigins: string[];
  production: boolean;
  now?: () => Date;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function parseCookie(request: FastifyRequest): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return /^[A-Za-z0-9_-]{40,100}$/.test(value) ? value : null;
  }
  return null;
}

export async function authenticatedSession(request: FastifyRequest, store: AuthStore) {
  const token = parseCookie(request);
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = await store.findSession(tokenHash);
  if (!session || session.expiresAt <= new Date()) return null;
  return { ...session, tokenHash };
}
function setSessionCookie(token: string, production: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${production ? "; Secure" : ""}`;
}
function clearSessionCookie(production: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${production ? "; Secure" : ""}`;
}
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) as Buffer;
  return `scrypt$16384$8$1$${salt.toString("hex")}$${derived.toString("hex")}`;
}
async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, n, r, p, saltHex, hashHex] = encoded.split("$");
  const legacyV2Hash = /^[a-f0-9]{64}$/i.test(hashHex ?? "");
  const currentHash = /^[a-f0-9]{128}$/i.test(hashHex ?? "");
  if (algorithm !== "scrypt" || n !== "16384" || r !== "8" || p !== "1" ||
      !/^[a-f0-9]{32}$/i.test(saltHex ?? "") || (!legacyV2Hash && !currentHash)) return false;
  const expected = Buffer.from(hashHex!, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex!, "hex"), expected.length, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  }) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function originAllowed(request: FastifyRequest, origins: string[]): boolean {
  const origin = request.headers.origin;
  return typeof origin === "string" && origins.includes(origin);
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthOptions): void {
  const now = options.now ?? (() => new Date());
  app.post("/api/v1/auth/register", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!originAllowed(request, options.allowedOrigins)) return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    const parsed = RegisterSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REGISTRATION", message: "请检查邮箱和密码格式；密码至少 12 位。" } });
    const email = parsed.data.email.toLowerCase();
    try {
      const passwordHash = await hashPassword(parsed.data.password);
      const forwardedIp = request.headers["x-real-ip"];
      const registrationIp = typeof forwardedIp === "string" ? forwardedIp.split(",")[0]?.trim() || request.ip : request.ip;
      const region = resolveRegistrationRegion(registrationIp);
      const user = await options.store.createUser({ email, passwordHash, displayName: parsed.data.displayName ?? null, registerProvince: region.province ?? undefined, registerCity: region.city ?? undefined, registerRegion: region.label, ...(parsed.data.inviteCode ? { inviteCode: parsed.data.inviteCode } : {}) });
      const token = randomBytes(32).toString("base64url");
      await options.store.createSession({ userId: user.id, tokenHash: hashToken(token), userAgent: request.headers["user-agent"]?.slice(0, 500) ?? null, ipHash: createHash("sha256").update(request.ip).digest("hex"), expiresAt: new Date(now().getTime() + SESSION_TTL_SECONDS * 1000) });
      reply.header("set-cookie", setSessionCookie(token, options.production));
      return reply.code(201).send({ user });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") return reply.code(409).send({ error: { code: "EMAIL_ALREADY_REGISTERED", message: "该邮箱已注册。" } });
      throw error;
    }
  });

  app.post("/api/v1/auth/login", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!originAllowed(request, options.allowedOrigins)) return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_LOGIN", message: "请输入手机号和密码" } });
    const phone = parsed.data.phone.replace(/\D/g, "");
    if (!/^1\d{10}$/.test(phone)) return reply.code(400).send({ error: { code: "INVALID_PHONE", message: "手机号格式不正确，请输入 11 位登录手机号" } });
    const record = await options.store.findUserByPhone?.(phone);
    const valid = record && record.status === "active" && record.passwordHash ? await verifyPassword(parsed.data.password, record.passwordHash) : false;
    if (!valid || !record) return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS", message: "手机号或密码不正确；忘记密码可使用短信验证码登录" } });
    // Upgrade V2's 32-byte scrypt hash to the current 64-byte format after a successful login.
    if (record.passwordHash?.startsWith("scrypt$16384$8$1$") && record.passwordHash.split("$")[5]?.length === 64 && options.store.setPassword) {
      await options.store.setPassword(record.id, await hashPassword(parsed.data.password));
    }
    const token = randomBytes(32).toString("base64url");
    await options.store.createSession({ userId: record.id, tokenHash: hashToken(token), userAgent: request.headers["user-agent"]?.slice(0, 500) ?? null, ipHash: createHash("sha256").update(request.ip).digest("hex"), expiresAt: new Date(now().getTime() + SESSION_TTL_SECONDS * 1000) });
    reply.header("set-cookie", setSessionCookie(token, options.production));
    return reply.send({ user: { id: record.id, phone: record.phone, displayName: record.displayName, createdAt: record.createdAt } });
  });

  app.post("/api/v1/auth/sms/send", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!originAllowed(request, options.allowedOrigins)) return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    const parsed = SmsSendSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_PARAM", message: "请输入有效的手机号" } });
    const cleanPhone = parsed.data.phone.replace(/\D/g, "");
    if (!/^1\d{10}$/.test(cleanPhone)) return reply.code(400).send({ error: { code: "INVALID_PHONE", message: "手机号格式不正确，请输入 11 位大陆手机号" } });

    const result = await sendVerifyCode(cleanPhone);
    if (!result.ok) {
      return reply.code(400).send({ error: { code: "SMS_SEND_FAILED", message: result.message || "短信发送失败，请稍后重试" } });
    }
    if (result.requestId?.startsWith("mock-req-")) {
      if (!options.production) {
        return reply.send({ ok: true, message: "本地测试模式，固定验证码为 123456" });
      }
      return reply.code(503).send({ error: { code: "SMS_MOCK_MODE", message: "本地短信服务处于模拟模式，无法向手机发送真实验证码。配置真实短信服务后才能使用短信登录或重置密码。" } });
    }
    return reply.send({ ok: true, message: "验证码已发送" });
  });

  app.post("/api/v1/auth/sms/register", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!originAllowed(request, options.allowedOrigins)) return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    const parsed = SmsLoginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_PARAM", message: "请输入手机号和验证码。" } });
    const phone = parsed.data.phone.replace(/\D/g, "");
    const code = parsed.data.code.replace(/\D/g, "");
    if (!/^1\d{10}$/.test(phone) || !/^\d{4,8}$/.test(code)) return reply.code(400).send({ error: { code: "INVALID_PARAM", message: "手机号或验证码格式不正确。" } });
    const existing = await options.store.findUserByPhone?.(phone);
    if (existing) return reply.code(409).send({ error: { code: "PHONE_ALREADY_REGISTERED", message: "该手机号已经注册，请直接登录。" } });
    const check = await checkVerifyCode(phone, code);
    if (!check.ok || !check.passed) return reply.code(401).send({ error: { code: "INVALID_CODE", message: check.message || "验证码不正确或已失效。" } });
    try {
      const forwardedIp = request.headers["x-real-ip"];
      const registrationIp = typeof forwardedIp === "string" ? forwardedIp.split(",")[0]?.trim() || request.ip : request.ip;
      const region = resolveRegistrationRegion(registrationIp);
      const user = await options.store.createUser({
        phone, displayName: "用户_" + phone.slice(-4),
        registerProvince: region.province ?? undefined,
        registerCity: region.city ?? undefined,
        registerRegion: region.label,
        ...(parsed.data.inviteCode ? { inviteCode: parsed.data.inviteCode } : {}),
      });
      const token = randomBytes(32).toString("base64url");
      await options.store.createSession({ userId: user.id, tokenHash: hashToken(token), userAgent: request.headers["user-agent"]?.slice(0, 500) ?? null, ipHash: createHash("sha256").update(request.ip).digest("hex"), expiresAt: new Date(now().getTime() + SESSION_TTL_SECONDS * 1000) });
      reply.header("set-cookie", setSessionCookie(token, options.production));
      return reply.code(201).send({ user, needsPasswordSetup: true });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") return reply.code(409).send({ error: { code: "PHONE_ALREADY_REGISTERED", message: "该手机号已经注册，请直接登录。" } });
      throw error;
    }
  });

  app.post("/api/v1/auth/password", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!originAllowed(request, options.allowedOrigins)) return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    const session = await authenticatedSession(request, options.store);
    if (!session) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先通过短信验证码登录。" } });
    const parsed = PasswordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_PASSWORD", message: "密码至少 8 位，最多 128 位。" } });
    if (!options.store.setPassword) return reply.code(503).send({ error: { code: "PASSWORD_UPDATE_UNAVAILABLE", message: "密码设置服务暂不可用。" } });
    const user = await options.store.setPassword(session.user.id, await hashPassword(parsed.data.password));
    if (!user) return reply.code(404).send({ error: { code: "USER_NOT_FOUND" } });
    return reply.send({ user });
  });

  app.post("/api/v1/auth/sms/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!originAllowed(request, options.allowedOrigins)) return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    const parsed = SmsLoginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_PARAM", message: "请输入手机号和验证码" } });
    const cleanPhone = parsed.data.phone.replace(/\D/g, "");
    const cleanCode = parsed.data.code.replace(/\D/g, "");

    const check = await checkVerifyCode(cleanPhone, cleanCode);
    if (!check.ok || !check.passed) {
      return reply.code(401).send({ error: { code: "INVALID_CODE", message: check.message || "验证码不正确或已失效" } });
    }

    const existing = await options.store.findUserByPhone?.(cleanPhone);
    if (!existing) return reply.code(404).send({ error: { code: "PHONE_NOT_REGISTERED", message: "该手机号尚未注册，请先注册账户。" } });
    if (existing.status !== "active") return reply.code(403).send({ error: { code: "USER_SUSPENDED", message: "账号已被冻结" } });
    const user: AuthUser = existing;

    const token = randomBytes(32).toString("base64url");
    await options.store.createSession({
      userId: user.id,
      tokenHash: hashToken(token),
      userAgent: request.headers["user-agent"]?.slice(0, 500) ?? null,
      ipHash: createHash("sha256").update(request.ip).digest("hex"),
      expiresAt: new Date(now().getTime() + SESSION_TTL_SECONDS * 1000),
    });
    reply.header("set-cookie", setSessionCookie(token, options.production));
    return reply.send({ ok: true, user, hasPassword: Boolean(existing.passwordHash) });
  });

  app.get("/api/v1/auth/me", async (request, reply) => {
    const token = parseCookie(request);
    if (!token) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    const session = await options.store.findSession(hashToken(token));
    if (!session || session.expiresAt <= now()) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    return reply.header("cache-control", "no-store").send({
      user: {
        ...session.user,
        isGuest: !session.user.phone && !session.user.email,
      },
    });
  });

  app.post("/api/v1/auth/guest", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!originAllowed(request, options.allowedOrigins)) return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    const currentSession = await authenticatedSession(request, options.store);
    if (currentSession) {
      return reply.send({
        user: {
          ...currentSession.user,
          isGuest: !currentSession.user.phone && !currentSession.user.email,
        },
      });
    }
    const forwardedIp = request.headers["x-real-ip"];
    const registrationIp = typeof forwardedIp === "string" ? forwardedIp.split(",")[0]?.trim() || request.ip : request.ip;
    const region = resolveRegistrationRegion(registrationIp);
    const guestUser = await options.store.createUser({
      displayName: "访客体验用户",
      registerProvince: region.province ?? undefined,
      registerCity: region.city ?? undefined,
      registerRegion: region.label,
    });
    const token = randomBytes(32).toString("base64url");
    await options.store.createSession({
      userId: guestUser.id,
      tokenHash: hashToken(token),
      userAgent: request.headers["user-agent"]?.slice(0, 500) ?? null,
      ipHash: createHash("sha256").update(request.ip).digest("hex"),
      expiresAt: new Date(now().getTime() + SESSION_TTL_SECONDS * 1000),
    });
    reply.header("set-cookie", setSessionCookie(token, options.production));
    return reply.code(201).send({
      user: {
        ...guestUser,
        isGuest: true,
      },
    });
  });

  app.put("/api/v1/auth/password", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!originAllowed(request, options.allowedOrigins)) return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    const session = await authenticatedSession(request, options.store);
    if (!session) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先通过短信验证码登录。" } });
    const parsed = PasswordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_PASSWORD", message: "密码至少 8 位，最多 128 位。" } });
    if (!options.store.setPassword) return reply.code(503).send({ error: { code: "PASSWORD_UPDATE_UNAVAILABLE", message: "密码设置服务暂不可用。" } });
    const user = await options.store.setPassword(session.user.id, await hashPassword(parsed.data.password));
    if (!user) return reply.code(404).send({ error: { code: "USER_NOT_FOUND" } });
    return reply.send({ user });
  });
  app.put("/api/v1/auth/profile", async (request, reply) => {
    if (!originAllowed(request, options.allowedOrigins)) return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    const session = await authenticatedSession(request, options.store);
    if (!session) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    const parsed = z.object({ displayName: z.string().trim().min(1).max(24) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_DISPLAY_NAME", message: "\u6635\u79f0\u9700\u4e3a 1\u201324 \u4e2a\u5b57\u7b26" } });
    if (!options.store.updateDisplayName) return reply.code(503).send({ error: { code: "PROFILE_UPDATE_UNAVAILABLE" } });
    const user = await options.store.updateDisplayName(session.user.id, parsed.data.displayName);
    if (!user) return reply.code(404).send({ error: { code: "USER_NOT_FOUND" } });
    return reply.send({ user });
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    if (!originAllowed(request, options.allowedOrigins)) return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    const token = parseCookie(request);
    if (token) await options.store.revokeSession(hashToken(token));
    reply.header("set-cookie", clearSessionCookie(options.production));
    return reply.code(204).send();
  });
}


