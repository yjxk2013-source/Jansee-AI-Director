import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../apps/api/src/app.js";
import type { AuthStore, AuthUser } from "../apps/api/src/auth.js";
import { InMemoryBillingStore } from "../apps/api/src/billing.js";
import type { Pool } from "pg";

const adminUser: AuthUser = {
  id: "99999999-9999-4999-8999-999999999999",
  email: "admin@jansee.com",
  phone: "13800008000",
  displayName: "OPC Admin",
  createdAt: new Date(),
};
const token = "m".repeat(43);
const messageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const orderId = "PAY-SUPPORT-001";

function makeAuthStore(): AuthStore {
  return {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async findUserById(id) { return id === adminUser.id ? adminUser : null; },
    async verifyPassword() { return null; },
    async createSession() {},
    async findSession() { return { user: adminUser, expiresAt: new Date(Date.now() + 3600_000) }; },
    async deleteSession() {},
    async deleteUserSessions() {},
  };
}

test("users can send an order-bound refund inquiry as a site message and admins can review and resolve it", async (t) => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      queries.push({ sql, values });
      if (sql.includes("SELECT id FROM billing_orders")) return values[0] === orderId ? { rows: [{ id: orderId }], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO support_messages")) return { rows: [{ id: messageId, created_at: new Date("2026-11-17T00:00:00Z") }], rowCount: 1 };
      if (sql.includes("SELECT m.id, m.user_id")) return {
        rows: [{
          id: messageId, user_id: adminUser.id, order_id: orderId,
          subject: "退款/订单处理申请", message: "误购，希望人工核实",
          status: "unread", created_at: new Date("2026-11-17T00:00:00Z"),
          display_name: adminUser.displayName, phone: adminUser.phone, email: adminUser.email,
        }],
        rowCount: 1,
      };
      if (sql.includes("UPDATE support_messages")) return { rows: [{ id: messageId }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;

  const app = buildApp({
    allowedOrigins: ["http://localhost:3000"],
    logLevel: "silent",
    production: false,
    authStore: makeAuthStore(),
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

  const submitted = await app.inject({
    method: "POST",
    url: "/api/v1/support/messages",
    headers,
    payload: { orderId, subject: "退款/订单处理申请", message: "误购，希望人工核实" },
  });
  assert.equal(submitted.statusCode, 201);
  assert.equal(submitted.json().success, true);
  assert.equal(submitted.json().messageId, messageId);
  const insert = queries.find((entry) => entry.sql.includes("INSERT INTO support_messages"));
  assert.ok(insert);
  assert.deepEqual(insert.values, [adminUser.id, orderId, "退款/订单处理申请", "误购，希望人工核实"]);

  const foreignOrder = await app.inject({
    method: "POST",
    url: "/api/v1/support/messages",
    headers,
    payload: { orderId: "NOT-OWNED", subject: "退款咨询", message: "请核实" },
  });
  assert.equal(foreignOrder.statusCode, 404);

  const listed = await app.inject({
    method: "GET",
    url: "/api/v1/admin/support/messages?limit=100",
    headers,
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().messages[0].id, messageId);
  assert.equal(listed.json().messages[0].status, "unread");

  const resolved = await app.inject({
    method: "POST",
    url: `/api/v1/admin/support/messages/${messageId}/resolve`,
    headers,
    payload: {},
  });
  assert.equal(resolved.statusCode, 200);
  assert.equal(resolved.json().success, true);
  assert.ok(queries.some((entry) => entry.sql.includes("UPDATE support_messages SET status = 'resolved'")));
});

test("support message submission rejects missing auth and untrusted origins", async (t) => {
  const pool = { async query() { return { rows: [], rowCount: 0 }; } } as unknown as Pool;
  const app = buildApp({
    allowedOrigins: ["http://localhost:3000"],
    logLevel: "silent",
    production: false,
    authStore: makeAuthStore(),
    adminPool: pool,
    billingStore: new InMemoryBillingStore(),
  });
  t.after(async () => app.close());

  const deniedOrigin = await app.inject({
    method: "POST",
    url: "/api/v1/support/messages",
    headers: { origin: "https://attacker.example", cookie: `jansee_session=${token}`, "content-type": "application/json" },
    payload: { subject: "退款咨询", message: "请处理" },
  });
  assert.equal(deniedOrigin.statusCode, 403);

  const unauthenticated = await app.inject({
    method: "POST",
    url: "/api/v1/support/messages",
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    payload: { subject: "退款咨询", message: "请处理" },
  });
  assert.equal(unauthenticated.statusCode, 401);
});

test("admins can reply to a support message and publish a private inbox message for its owner", async (t) => {
  const replyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const statements: { sql: string; values: unknown[] }[] = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      statements.push({ sql, values });
      if (sql.includes("WITH original AS")) return { rows: [{ id: replyId }], rowCount: 1 };
      if (sql.includes("FROM site_inbox_messages m")) return { rows: [{ id: replyId, subject: "回复：退款/订单处理申请", body: "已核实，正在处理", category: "notice", published_at: new Date("2026-11-17T00:00:00Z"), read_at: null }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const app = buildApp({ allowedOrigins: ["http://localhost:3000"], logLevel: "silent", production: false, authStore: makeAuthStore(), adminPool: pool, adminEmails: ["admin@jansee.com"], billingStore: new InMemoryBillingStore() });
  t.after(async () => app.close());
  const headers = { origin: "http://localhost:3000", cookie: "jansee_session=" + token, "content-type": "application/json" };
  const sent = await app.inject({ method: "POST", url: "/api/v1/admin/support/messages/" + messageId + "/reply", headers, payload: { message: "已核实，正在处理" } });
  assert.equal(sent.statusCode, 201);
  assert.equal(sent.json().success, true);
  assert.equal(sent.json().replyId, replyId);
  const insert = statements.find((entry) => entry.sql.includes("INSERT INTO site_inbox_messages"));
  assert.ok(insert);
  assert.match(insert.sql, /recipient_user_id/);
  assert.deepEqual(insert.values, [messageId, "已核实，正在处理", adminUser.id]);
  const inbox = await app.inject({ method: "GET", url: "/api/v1/inbox", headers });
  assert.equal(inbox.statusCode, 200);
  assert.equal(inbox.json().messages[0].id, replyId);
  assert.equal(inbox.json().messages[0].body, "已核实，正在处理");
});
