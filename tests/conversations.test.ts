import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { buildApp } from "../apps/api/src/app.js";
import type { AuthStore, AuthUser } from "../apps/api/src/auth.js";

const user: AuthUser = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  phone: "13800000000",
  displayName: "测试用户",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};
const token = "g".repeat(43);
const origin = "http://localhost:5173";
const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeAuthStore(authenticatedUser: AuthUser = user): AuthStore {
  return {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async findUserByPhone() { return null; },
    async createSession() {},
    async findSession() { return { user: authenticatedUser, expiresAt: new Date(Date.now() + 60_000) }; },
    async revokeSession() {},
  };
}

function makeConversationPool() {
  const rows = new Map<string, { id: string; user_id: string; title: string; updated_at: Date; messages: Array<Record<string, unknown>> }>();
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [], rowCount: null };
      if (normalized.startsWith("INSERT INTO conversations")) {
        const id = String(values[0]);
        const owner = String(values[1]);
        const current = rows.get(id);
        if (current && current.user_id !== owner) return { rows: [], rowCount: 0 };
        rows.set(id, { id, user_id: owner, title: String(values[2]), updated_at: new Date(), messages: current?.messages ?? [] });
        return { rows: [{ id }], rowCount: 1 };
      }
      if (normalized.startsWith("DELETE FROM conversation_messages")) {
        const current = rows.get(String(values[0]));
        if (current && current.user_id === String(values[1])) current.messages = [];
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("INSERT INTO conversation_messages")) {
        const current = rows.get(String(values[0]));
        if (current && current.user_id === String(values[1])) current.messages.push(JSON.parse(String(values[4])));
        return { rows: [], rowCount: 1 };
      }
      throw new Error("Unexpected SQL: " + normalized);
    },
    release() {},
  };
  const pool = {
    async connect() { return client; },
    async query(_sql: string, values: unknown[] = []) {
      const owned = [...rows.values()].filter((row) => row.user_id === String(values[0]));
      return {
        rows: owned.sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime()).map((row) => ({
          id: row.id, title: row.title, updated_at: row.updated_at, messages: row.messages,
        })),
        rowCount: owned.length,
      };
    },
  };
  return pool as unknown as Pool;
}

test("authenticated conversations are written to and restored from account-scoped persistence", async (t) => {
  const pool = makeConversationPool();
  const app = buildApp({ allowedOrigins: [origin], logLevel: "silent", production: false, authStore: makeAuthStore(), adminPool: pool });
  t.after(async () => app.close());
  await app.ready();

  const headers = { origin, cookie: `jansee_session=${token}`, "content-type": "application/json" };
  const messages = [
    { id: "m1", role: "user", text: "请把这段素材做成带货视频", attachments: [{ name: "商品.jpg", kind: "image", size: 1234 }] },
    { id: "m2", role: "director", text: "导演方案已生成", plan: ["开场", "主体", "结尾"], jobPayload: { mode: "image-film", prompt: "带货视频", assetIds: ["asset-1"], plan: { title: "商品短片" } } },
  ];
  const save = await app.inject({
    method: "PUT",
    url: `/api/v1/conversations/${conversationId}`,
    headers,
    payload: { title: "商品短片", messages },
  });
  assert.equal(save.statusCode, 200);
  assert.equal(save.json().saved, true);
  assert.equal(save.json().messageCount, 2);

  const load = await app.inject({ method: "GET", url: "/api/v1/conversations", headers: { cookie: `jansee_session=${token}` } });
  assert.equal(load.statusCode, 200);
  assert.equal(load.json().conversations.length, 1);
  assert.equal(load.json().conversations[0].id, conversationId);
  assert.deepEqual(load.json().conversations[0].messages, messages);

  const otherUser: AuthUser = {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    phone: "13900000000",
    displayName: "另一个用户",
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
  };
  const otherApp = buildApp({ allowedOrigins: [origin], logLevel: "silent", production: false, authStore: makeAuthStore(otherUser), adminPool: pool });
  t.after(async () => otherApp.close());
  await otherApp.ready();
  const foreignWrite = await otherApp.inject({
    method: "PUT",
    url: `/api/v1/conversations/${conversationId}`,
    headers: { origin, cookie: `jansee_session=${token}`, "content-type": "application/json" },
    payload: { title: "越权覆盖", messages: [{ id: "foreign", role: "user", text: "不应覆盖" }] },
  });
  assert.equal(foreignWrite.statusCode, 409, "one account cannot overwrite another account's conversation ID");
  const foreignRead = await otherApp.inject({ method: "GET", url: "/api/v1/conversations", headers: { cookie: `jansee_session=${token}` } });
  assert.equal(foreignRead.json().conversations.length, 0, "one account cannot read another account's history");
});

test("conversation persistence rejects unauthenticated, malformed and cross-origin writes", async (t) => {
  const app = buildApp({ allowedOrigins: [origin], logLevel: "silent", production: false, authStore: makeAuthStore(), adminPool: makeConversationPool() });
  t.after(async () => app.close());
  await app.ready();

  const unauthorized = await app.inject({ method: "GET", url: "/api/v1/conversations" });
  assert.equal(unauthorized.statusCode, 401);

  const headers = { origin, cookie: `jansee_session=${token}`, "content-type": "application/json" };
  const malformed = await app.inject({
    method: "PUT",
    url: `/api/v1/conversations/${conversationId}`,
    headers,
    payload: { title: "错误消息", messages: [{ id: "m1", role: "admin", text: "not allowed" }] },
  });
  assert.equal(malformed.statusCode, 400);

  const crossOrigin = await app.inject({
    method: "PUT",
    url: `/api/v1/conversations/${conversationId}`,
    headers: { ...headers, origin: "https://attacker.example" },
    payload: { title: "拒绝", messages: [] },
  });
  assert.equal(crossOrigin.statusCode, 403);
});
