import { readFile, writeFile } from "node:fs/promises";
const root = "F:/Jansee-v4/";
async function edit(path, fn) {
  const file = root + path;
  const before = await readFile(file, "utf8");
  const after = fn(before);
  if (after === before) throw new Error("No changes made to " + path);
  await writeFile(file, after, "utf8");
  console.log("PATCHED " + path);
}
await edit("apps/api/src/auth.ts", (s) => {
  s = s.replace('const LoginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(128) }).strict();',
    'const LoginSchema = z.object({ phone: z.string().trim(), password: z.string().min(1).max(128) }).strict();\nconst PasswordSchema = z.object({ password: z.string().min(8).max(128) }).strict();');
  s = s.replace('findUserByPhone?(phone: string): Promise<(AuthUser & { status: string }) | null>;',
    'findUserByPhone?(phone: string): Promise<(AuthUser & { passwordHash?: string; status: string }) | null>;\n  setPassword?(userId: string, passwordHash: string): Promise<AuthUser | null>;');
  const login = `  app.post("/api/v1/auth/login", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!originAllowed(request, options.allowedOrigins)) return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_LOGIN", message: "请输入手机号和密码。" } });
    const phone = parsed.data.phone.replace(/\\D/g, "");
    if (!/^1\\d{10}$/.test(phone)) return reply.code(400).send({ error: { code: "INVALID_PHONE", message: "手机号格式不正确。" } });
    const record = await options.store.findUserByPhone?.(phone);
    const valid = record && record.status === "active" && record.passwordHash ? await verifyPassword(parsed.data.password, record.passwordHash) : false;
    if (!valid || !record) return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS", message: "手机号或密码不正确；忘记密码可使用短信验证码登录。" } });
    const token = randomBytes(32).toString("base64url");
    await options.store.createSession({ userId: record.id, tokenHash: hashToken(token), userAgent: request.headers["user-agent"]?.slice(0, 500) ?? null, ipHash: createHash("sha256").update(request.ip).digest("hex"), expiresAt: new Date(now().getTime() + SESSION_TTL_SECONDS * 1000) });
    reply.header("set-cookie", setSessionCookie(token, options.production));
    return reply.send({ user: { id: record.id, phone: record.phone, displayName: record.displayName, createdAt: record.createdAt } });
  });

  app.post("/api/v1/auth/sms/send"`;
  const loginStart = s.indexOf('  app.post("/api/v1/auth/login"');
  const smsSendStart = s.indexOf('  app.post("/api/v1/auth/sms/send"', loginStart);
  if (loginStart < 0 || smsSendStart < 0) throw new Error("Login route anchors missing");
  s = s.slice(0, loginStart) + login + s.slice(smsSendStart);
  const registration = `  app.post("/api/v1/auth/sms/register", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!originAllowed(request, options.allowedOrigins)) return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    const parsed = SmsLoginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_PARAM", message: "请输入手机号和验证码。" } });
    const phone = parsed.data.phone.replace(/\\D/g, "");
    const code = parsed.data.code.replace(/\\D/g, "");
    if (!/^1\\d{10}$/.test(phone) || !/^\\d{4,8}$/.test(code)) return reply.code(400).send({ error: { code: "INVALID_PARAM", message: "手机号或验证码格式不正确。" } });
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

  app.post("/api/v1/auth/sms/login"`;
  s = s.replace('  app.post("/api/v1/auth/sms/login",', registration);
  const autoCreate = `    // 查找用户，不存在则免密自动注册
    let user: AuthUser | null = null;
    if (options.store.findUserByPhone) {
      const existing = await options.store.findUserByPhone(cleanPhone);
      if (existing) {
        if (existing.status !== "active") return reply.code(403).send({ error: { code: "USER_SUSPENDED", message: "账号已被冻结" } });
        user = existing;
      }
    }
    if (!user) {
      const defaultName = \`用户_\${cleanPhone.slice(-4)}\`;
      const forwardedIp = request.headers["x-real-ip"];
      const registrationIp = typeof forwardedIp === "string" ? forwardedIp.split(",")[0]?.trim() || request.ip : request.ip;
      const region = resolveRegistrationRegion(registrationIp);
      user = await options.store.createUser({
        phone: cleanPhone,
        displayName: defaultName,
        registerProvince: region.province ?? undefined,
        registerCity: region.city ?? undefined,
        registerRegion: region.label,
        ...(parsed.data.inviteCode ? { inviteCode: parsed.data.inviteCode } : {}),
      });
    }`;
  const lookupOnly = `    const existing = await options.store.findUserByPhone?.(cleanPhone);
    if (!existing) return reply.code(404).send({ error: { code: "PHONE_NOT_REGISTERED", message: "该手机号尚未注册，请先注册账户。" } });
    if (existing.status !== "active") return reply.code(403).send({ error: { code: "USER_SUSPENDED", message: "账号已被冻结" } });
    const user: AuthUser = existing;`;
  if (!s.includes(autoCreate)) throw new Error("SMS auto-registration block not found");
  s = s.replace(autoCreate, lookupOnly);
  s = s.replace('return reply.send({ ok: true, user });', 'return reply.send({ ok: true, user, hasPassword: Boolean(existing.passwordHash) });');
  return s;
});
await edit("apps/api/src/auth-store.ts", (s) => {
  const old = `      const row = result.rows[0];
      return row ? { ...mapUser(row), status: row.status ?? "active" } : null;
    },

    async updateDisplayName(userId, displayName) {`;
  const next = `      const row = result.rows[0];
      return row ? { ...mapUser(row), ...(row.password_hash ? { passwordHash: row.password_hash } : {}), status: row.status ?? "active" } : null;
    },

    async setPassword(userId, passwordHash) {
      const result = await pool.query<UserRow>(
        "UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL AND status = 'active' RETURNING id, email, phone, display_name, created_at",
        [userId, passwordHash],
      );
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    },

    async updateDisplayName(userId, displayName) {`;
  if (!s.includes(old)) throw new Error("phone store anchor missing");
  return s.replace(old, next);
});
