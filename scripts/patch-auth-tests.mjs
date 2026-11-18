import { readFile, writeFile } from "node:fs/promises";
const p = "F:/Jansee-v4/tests/auth.test.ts";
let s = await readFile(p, "utf8");
s = s.replace('const phoneUsers = new Map<string, AuthUser & { status: string }>();', 'const phoneUsers = new Map<string, AuthUser & { passwordHash?: string; status: string }>();');
s = s.replace('if (input.phone) phoneUsers.set(input.phone, { ...user, status: "active" });', 'if (input.phone) phoneUsers.set(input.phone, { ...user, passwordHash: input.passwordHash, status: "active" });');
s = s.replace('    async findUserByPhone(phone) { return phoneUsers.get(phone) ?? null; },', `    async findUserByPhone(phone) { return phoneUsers.get(phone) ?? null; },
    async setPassword(userId, passwordHash) {
      const entry = [...phoneUsers.entries()].find(([, candidate]) => candidate.id === userId);
      if (!entry) return null;
      const [phone, candidate] = entry;
      phoneUsers.set(phone, { ...candidate, passwordHash });
      return candidate;
    },`);
const start = s.indexOf('test("login rejects invalid credentials and logout revokes the session"');
const end = s.indexOf('test("auth endpoints reject untrusted origins', start);
if (start < 0 || end < 0) throw new Error("login test anchors missing");
const testBlock = `test("phone and password login works after SMS registration and password setup", async () => {
  const app = Fastify();
  const store = makeStore();
  registerAuthRoutes(app, { store, allowedOrigins: [origin], production: false });
  try {
    const phone = "13800138000";
    const register = await app.inject({
      method: "POST", url: "/api/v1/auth/sms/register", headers: { origin },
      payload: { phone, code: "123456" },
    });
    assert.equal(register.statusCode, 201);
    assert.equal(register.json().needsPasswordSetup, true);
    const cookie = (register.headers["set-cookie"] as string).split(";")[0]!;

    const invalidBeforeSetup = await app.inject({
      method: "POST", url: "/api/v1/auth/login", headers: { origin },
      payload: { phone, password: "password-123" },
    });
    assert.equal(invalidBeforeSetup.statusCode, 401);

    const setPassword = await app.inject({
      method: "PUT", url: "/api/v1/auth/password", headers: { origin, cookie },
      payload: { password: "password-123" },
    });
    assert.equal(setPassword.statusCode, 200);
    assert.equal(setPassword.json().user.phone, phone);

    const badLogin = await app.inject({
      method: "POST", url: "/api/v1/auth/login", headers: { origin },
      payload: { phone, password: "wrong-password" },
    });
    assert.equal(badLogin.statusCode, 401);

    const login = await app.inject({
      method: "POST", url: "/api/v1/auth/login", headers: { origin },
      payload: { phone, password: "password-123" },
    });
    assert.equal(login.statusCode, 200);
    assert.equal(login.json().user.phone, phone);
    const loginCookie = (login.headers["set-cookie"] as string).split(";")[0]!;
    const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { origin, cookie: loginCookie } });
    assert.equal(logout.statusCode, 204);
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: loginCookie } });
    assert.equal(me.statusCode, 401);
  } finally { await app.close(); }
});

`;
s = s.slice(0, start) + testBlock + s.slice(end);
const smsStart = s.indexOf('test("sms auth: sends verify code');
if (smsStart < 0) throw new Error("sms test anchor missing");
const smsEnd = s.indexOf('\n});', smsStart) + 4;
const smsTest = `test("SMS login only accepts registered phones; SMS registration is explicit and existing users can recover access", async () => {
  const app = Fastify();
  registerAuthRoutes(app, { store: makeStore(), allowedOrigins: [origin], production: false });
  try {
    const testPhone = "13800138000";
    const badPhone = await app.inject({ method: "POST", url: "/api/v1/auth/sms/send", headers: { origin }, payload: { phone: "12345" } });
    assert.equal(badPhone.statusCode, 400);

    const sendRes = await app.inject({ method: "POST", url: "/api/v1/auth/sms/send", headers: { origin }, payload: { phone: testPhone } });
    assert.equal(sendRes.statusCode, 200);

    const unregisteredLogin = await app.inject({
      method: "POST", url: "/api/v1/auth/sms/login", headers: { origin },
      payload: { phone: testPhone, code: "123456" },
    });
    assert.equal(unregisteredLogin.statusCode, 404);

    const register = await app.inject({
      method: "POST", url: "/api/v1/auth/sms/register", headers: { origin },
      payload: { phone: testPhone, code: "123456" },
    });
    assert.equal(register.statusCode, 201);
    const user = register.json().user;
    assert.ok(user.id);
    assert.equal(user.phone, testPhone);
    assert.equal(user.displayName, "用户_8000");
    const cookie = (register.headers["set-cookie"] as string).split(";")[0]!;

    const duplicateRegister = await app.inject({
      method: "POST", url: "/api/v1/auth/sms/register", headers: { origin },
      payload: { phone: testPhone, code: "123456" },
    });
    assert.equal(duplicateRegister.statusCode, 409);

    const smsLogin = await app.inject({
      method: "POST", url: "/api/v1/auth/sms/login", headers: { origin },
      payload: { phone: testPhone, code: "123456" },
    });
    assert.equal(smsLogin.statusCode, 200);
    assert.equal(smsLogin.json().hasPassword, false);

    const setPassword = await app.inject({
      method: "PUT", url: "/api/v1/auth/password", headers: { origin, cookie },
      payload: { password: "recovered-password-123" },
    });
    assert.equal(setPassword.statusCode, 200);

    const passwordLogin = await app.inject({
      method: "POST", url: "/api/v1/auth/login", headers: { origin },
      payload: { phone: testPhone, password: "recovered-password-123" },
    });
    assert.equal(passwordLogin.statusCode, 200);

    const sessionCookie = (smsLogin.headers["set-cookie"] as string).split(";")[0]!;
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: sessionCookie } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.id, user.id);
    assert.equal(me.json().user.phone, testPhone);
  } finally { await app.close(); }
});`;
s = s.slice(0, smsStart) + smsTest + s.slice(smsEnd);
await writeFile(p, s, "utf8");
console.log("Updated auth tests");
