import { readFile, writeFile } from "node:fs/promises";
const p = "F:/Jansee-v4/scripts/patch-auth-password.mjs";
let s = await readFile(p, "utf8");
const old = '  s = s.replace(/  app\\\\.post\\\\("\\/api\\/v1\\/auth\\/login"[\\\\s\\\\S]*?\\\\n  app\\\\.post\\\\("\\/api\\/v1\\/auth\\/sms\\/send"/, login);';
const next = '  const loginStart = s.indexOf(\'  app.post("/api/v1/auth/login"\');\n  const smsSendStart = s.indexOf(\'  app.post("/api/v1/auth/sms/send"\', loginStart);\n  if (loginStart < 0 || smsSendStart < 0) throw new Error("Login route anchors missing");\n  s = s.slice(0, loginStart) + login + s.slice(smsSendStart);';
if (!s.includes(old)) throw new Error("regex patch anchor not found");
s = s.replace(old, next);
const marker = '  app.put("/api/v1/auth/profile",';
const insertion = `  app.put("/api/v1/auth/password", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
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

${marker}`;
if (!s.includes(marker)) throw new Error("profile marker missing in script");
s = s.replace(marker, insertion);
await writeFile(p, s, "utf8");
console.log("fixed patch script");
