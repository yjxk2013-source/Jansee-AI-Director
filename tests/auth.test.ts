import test from "node:test";
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import Fastify from "fastify";
import type { Pool } from "pg";
import { createPgAuthStore } from "../apps/api/src/auth-store.js";
import { registerAuthRoutes, type AuthStore, type AuthUser } from "../apps/api/src/auth.js";

// These tests use the local fixed-code SMS provider; never call the real SMS vendor.
const previousAuthTestMode = process.env.JX_AUTH_TEST;
process.env.JX_AUTH_TEST = "1";
test.after(() => {
  if (previousAuthTestMode === undefined) delete process.env.JX_AUTH_TEST;
  else process.env.JX_AUTH_TEST = previousAuthTestMode;
});

function makeStore(): AuthStore {
  const users = new Map<string, AuthUser & { passwordHash?: string; status: string }>();
  const phoneUsers = new Map<string, AuthUser & { passwordHash?: string; status: string }>();
  const sessions = new Map<string, { user: AuthUser; expiresAt: Date; revoked: boolean }>();
  return {
    async createUser(input) {
      if (input.email && users.has(input.email)) throw Object.assign(new Error("duplicate"), { code: "23505" });
      const user: AuthUser = {
        id: `user-${users.size + phoneUsers.size + 1}`,
        ...(input.email ? { email: input.email } : {}),
        ...(input.phone ? { phone: input.phone } : {}),
        displayName: input.displayName,
        createdAt: new Date(),
      };
      if (input.email) users.set(input.email, { ...user, passwordHash: input.passwordHash, status: "active" });
      if (input.phone) phoneUsers.set(input.phone, { ...user, passwordHash: input.passwordHash, status: "active" });
      return user;
    },
    async findUserByEmail(email) { return users.get(email) ?? null; },
    async findUserByPhone(phone) { return phoneUsers.get(phone) ?? null; },
    async setPassword(userId, passwordHash) {
      const entry = [...phoneUsers.entries()].find(([, candidate]) => candidate.id === userId);
      if (!entry) return null;
      const [phone, candidate] = entry;
      phoneUsers.set(phone, { ...candidate, passwordHash });
      return candidate;
    },
    async createSession(input) {
      const all = [...users.values(), ...phoneUsers.values()];
      const user = all.find((candidate) => candidate.id === input.userId)!;
      sessions.set(input.tokenHash, { user, expiresAt: input.expiresAt, revoked: false });
    },
    async findSession(tokenHash) {
      const session = sessions.get(tokenHash);
      return session && !session.revoked ? { user: { id: session.user.id, email: session.user.email, phone: session.user.phone, displayName: session.user.displayName, createdAt: session.user.createdAt }, expiresAt: session.expiresAt } : null;
    },
    async revokeSession(tokenHash) { const session = sessions.get(tokenHash); if (session) session.revoked = true; },
  };
}

const origin = "https://jansee.example";

test("registration creates a user and an HttpOnly session cookie; me returns the authenticated user", async () => {
  const app = Fastify();
  registerAuthRoutes(app, { store: makeStore(), allowedOrigins: [origin], production: true });
  try {
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/register", headers: { origin }, payload: { email: "Creator@Example.com", password: "a-very-long-password-123", displayName: "Creator" } });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().user.email, "creator@example.com");
    assert.equal(response.json().user.passwordHash, undefined);
    const cookie = response.headers["set-cookie"] as string;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: cookie.split(";")[0]! } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.id, response.json().user.id);
    assert.equal(me.headers["cache-control"], "no-store");
  } finally { await app.close(); }
});

test("phone and password login works after SMS registration and password setup", async () => {
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

test("V2 32-byte scrypt password hashes remain valid and upgrade after the first V4 login", async () => {
  const app = Fastify();
  const store = makeStore();
  const phone = "13900139000";
  const salt = Buffer.alloc(16, 7);
  const legacyHash = scryptSync("legacy-password-123", salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex");
  await store.createUser({
    phone,
    passwordHash: `scrypt$16384$8$1$${salt.toString("hex")}$${legacyHash}`,
    displayName: "V2 用户",
  });
  registerAuthRoutes(app, { store, allowedOrigins: [origin], production: false });
  try {
    const login = await app.inject({
      method: "POST", url: "/api/v1/auth/login", headers: { origin },
      payload: { phone, password: "legacy-password-123" },
    });
    assert.equal(login.statusCode, 200);
    const upgraded = await store.findUserByPhone!(phone);
    assert.ok(upgraded?.passwordHash?.startsWith("scrypt$16384$8$1$"));
    assert.equal(upgraded?.passwordHash?.split("$")[5]?.length, 128);
  } finally { await app.close(); }
});

test("auth endpoints reject untrusted origins and weak registration passwords", async () => {
  const app = Fastify();
  registerAuthRoutes(app, { store: makeStore(), allowedOrigins: [origin], production: false });
  try {
    const untrusted = await app.inject({ method: "POST", url: "/api/v1/auth/register", headers: { origin: "https://evil.example" }, payload: { email: "a@example.com", password: "a-very-long-password" } });
    assert.equal(untrusted.statusCode, 403);
    const weak = await app.inject({ method: "POST", url: "/api/v1/auth/register", headers: { origin }, payload: { email: "a@example.com", password: "short" } });
    assert.equal(weak.statusCode, 400);
    const noOrigin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "a@example.com", password: "password" } });
    assert.equal(noOrigin.statusCode, 403);
  } finally { await app.close(); }
});

test("local JX_AUTH_TEST SMS mock returns the fixed code hint without sending a real SMS", async () => {
  const previous = process.env.JX_AUTH_TEST ?? "0";
  process.env.JX_AUTH_TEST = "1";
  const app = Fastify();
  registerAuthRoutes(app, { store: makeStore(), allowedOrigins: [origin], production: false });
  try {
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/sms/send", headers: { origin }, payload: { phone: "13800138000" } });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /123456/);
  } finally {
    await app.close();
    process.env.JX_AUTH_TEST = previous;
  }
});

test("SMS login only accepts registered phones; SMS registration is explicit and existing users can recover access", async () => {
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
});

test("new registration creates the 600-credit wallet and ledger entry in the same transaction", async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      statements.push({ sql: normalized, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [], rowCount: null };
      if (normalized.startsWith("INSERT INTO users")) return { rows: [{ id: "new-user", email: "new@example.com", phone: null, display_name: "New", created_at: new Date("2026-11-18T00:00:00Z") }], rowCount: 1 };
      if (normalized.startsWith("INSERT INTO wallets")) return { rows: [{ user_id: "new-user" }], rowCount: 1 };
      if (normalized.startsWith("INSERT INTO billing_ledger")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected registration SQL: ${normalized}`);
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const store = createPgAuthStore(pool);
  const created = await store.createUser({ email: "new@example.com", displayName: "New" });
  assert.equal(created.id, "new-user");
  const walletInsert = statements.find((entry) => entry.sql.startsWith("INSERT INTO wallets"));
  assert.match(walletInsert?.sql ?? "", /VALUES \(\$1, 600, 600\)/);
  assert.equal(walletInsert?.values[0], "new-user");
  const grant = statements.find((entry) => entry.sql.startsWith("INSERT INTO billing_ledger"));
  assert.equal(grant?.values[0], "new-user");
  assert.match(grant?.sql ?? "", /VALUES \(\$1, 'grant', 600, 600, \$2\)/);
  assert.ok(statements.findIndex((entry) => entry.sql === "BEGIN") < statements.findIndex((entry) => entry.sql.startsWith("INSERT INTO wallets")));
  assert.equal(statements.at(-1)?.sql, "COMMIT");
});

test("invite registration credits the inviter 200 once and records the reward", async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      statements.push({ sql: normalized, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [], rowCount: null };
      if (normalized.startsWith("INSERT INTO users")) return { rows: [{ id: "invitee", email: "invitee@example.com", phone: null, display_name: "Invitee", created_at: new Date("2026-11-18T00:00:00Z") }], rowCount: 1 };
      if (normalized.startsWith("INSERT INTO wallets")) return values[0] === "invitee" ? { rows: [{ user_id: "invitee" }], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (normalized.startsWith("SELECT id FROM users")) return { rows: [{ id: "inviter" }], rowCount: 1 };
      if (normalized.startsWith("INSERT INTO referral_rewards")) return { rows: [{ id: "reward-1" }], rowCount: 1 };
      if (normalized.startsWith("UPDATE users SET inviter_user_id")) return { rows: [], rowCount: 1 };
      if (normalized.startsWith("UPDATE wallets SET available_credits = available_credits + 200")) return { rows: [{ user_id: "inviter" }], rowCount: 1 };
      if (normalized.startsWith("INSERT INTO billing_ledger")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected referral SQL: ${normalized}`);
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const store = createPgAuthStore(pool);
  await store.createUser({ email: "invitee@example.com", displayName: "Invitee", inviteCode: "INVITER" });
  const reward = statements.find((entry) => entry.sql.startsWith("INSERT INTO referral_rewards"));
  assert.match(reward?.sql ?? "", /ON CONFLICT \(invitee_user_id\) DO NOTHING RETURNING id/);
  const credit = statements.find((entry) => entry.sql.startsWith("UPDATE wallets SET available_credits = available_credits + 200"));
  assert.equal(credit?.values[0], "inviter");
  const grants = statements.filter((entry) => entry.sql.startsWith("INSERT INTO billing_ledger"));
  assert.match(grants[0]?.sql ?? "", /VALUES \(\$1, 'grant', 600, 600, \$2\)/);
  assert.match(grants[1]?.sql ?? "", /VALUES \(\$1, 'grant', 200, 200, \$2\)/);
});
