import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../apps/api/src/app.js";
import type { AuthStore, AuthUser } from "../apps/api/src/auth.js";
import { InMemoryBillingStore } from "../apps/api/src/billing.js";
import type { Pool } from "pg";

const user: AuthUser = {
  id: "99999999-9999-4999-8999-999999999999",
  email: "admin@jansee.com",
  phone: "13800008000",
  displayName: "JANSEE Admin",
  createdAt: new Date(),
};
const token = "i".repeat(43);
const messageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function authStore(): AuthStore {
  return {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async findUserById(id) { return id === user.id ? user : null; },
    async verifyPassword() { return null; },
    async createSession() {},
    async findSession() { return { user, expiresAt: new Date(Date.now() + 3600_000) }; },
    async deleteSession() {},
    async deleteUserSessions() {},
  };
}

test("user inbox read and admin inbox management are connected to persistent routes", async (t) => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("FROM site_inbox_messages m")) {
        return { rows: [{ id: messageId, subject: "欢迎加入简兮 JANSEE", body: "欢迎使用简兮。", category: "welcome", published_at: new Date("2026-11-17T00:00:00Z"), read_at: null }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO site_inbox_reads")) return { rows: [{ message_id: messageId }], rowCount: 1 };
      if (sql.includes("FROM site_inbox_messages WHERE recipient_user_id IS NULL")) {
        return { rows: [{ id: messageId, subject: "欢迎加入简兮 JANSEE", body: "欢迎使用简兮。", category: "welcome", status: "published", created_at: new Date(), updated_at: new Date(), published_at: new Date() }], rowCount: 1 };
      }
      if (sql.includes("WITH original AS")) return { rows: [{ id: messageId }], rowCount: 1 };
      if (sql.includes("INSERT INTO site_inbox_messages")) {
        return { rows: [{ id: messageId, subject: "新通知", body: "通知正文", category: "notice", status: "published", created_at: new Date(), updated_at: new Date(), published_at: new Date() }], rowCount: 1 };
      }
      if (sql.includes("UPDATE site_inbox_messages")) {
        return { rows: [{ id: messageId, subject: "更新通知", body: "更新正文", category: "notice", status: "draft", created_at: new Date(), updated_at: new Date(), published_at: null }], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM site_inbox_messages")) return { rows: [{ id: messageId }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;

  const app = buildApp({
    allowedOrigins: ["http://localhost:3000"],
    logLevel: "silent",
    production: false,
    authStore: authStore(),
    adminPool: pool,
    adminEmails: ["admin@jansee.com"],
    billingStore: new InMemoryBillingStore(),
  });
  t.after(async () => app.close());

  const headers = {
    origin: "http://localhost:3000",
    cookie: `jansee_session=${token}`,
    "content-type": "application/json",
  };

  const inbox = await app.inject({ method: "GET", url: "/api/v1/inbox", headers });
  assert.equal(inbox.statusCode, 200);
  assert.equal(inbox.json().messages[0].subject, "欢迎加入简兮 JANSEE");

  const read = await app.inject({ method: "POST", url: `/api/v1/inbox/${messageId}/read`, headers, payload: {} });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().success, true);

  const adminList = await app.inject({ method: "GET", url: "/api/v1/admin/inbox/messages", headers });
  assert.equal(adminList.statusCode, 200);
  assert.equal(adminList.json().messages[0].id, messageId);

  const adminReply = await app.inject({
    method: "POST", url: `/api/v1/admin/support/messages/${messageId}/reply`, headers,
    payload: { message: "你好，已收到你的反馈，我们会尽快处理。" },
  });
  assert.equal(adminReply.statusCode, 201);
  assert.equal(adminReply.json().success, true);
  assert.ok(queries.some((sql) => sql.includes("recipient_user_id") && sql.includes("WITH original AS")));
  assert.ok(queries.some((sql) => sql.includes("recipient_user_id IS NULL OR m.recipient_user_id = $1")));

  const created = await app.inject({
    method: "POST", url: "/api/v1/admin/inbox/messages", headers,
    payload: { subject: "新通知", body: "通知正文", category: "notice", status: "published" },
  });
  assert.equal(created.statusCode, 201);

  const updated = await app.inject({
    method: "PUT", url: `/api/v1/admin/inbox/messages/${messageId}`, headers,
    payload: { subject: "更新通知", body: "更新正文", category: "notice", status: "draft" },
  });
  assert.equal(updated.statusCode, 200);

  const deleted = await app.inject({ method: "DELETE", url: `/api/v1/admin/inbox/messages/${messageId}`, headers, payload: {} });
  assert.equal(deleted.statusCode, 200, JSON.stringify(deleted.json()));
  assert.ok(queries.some((sql) => sql.includes("INSERT INTO site_inbox_reads")));
});
