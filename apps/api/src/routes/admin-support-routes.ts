import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  fetchSupportMessages,
  replySupportMessage,
  resolveSupportMessage,
  fetchInboxMessages,
  createInboxMessage,
  updateInboxMessage,
  deleteInboxMessage,
} from "../services/admin-support-service.js";

const validUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export interface AdminSupportRoutesOptions {
  pool?: Pool | undefined;
  verifyAdminAuth: (request: any, reply: any) => Promise<any>;
  requireAdminOrigin: (request: any, reply: any) => boolean;
}

export function registerAdminSupportRoutes(app: FastifyInstance, options: AdminSupportRoutesOptions): void {
  const { pool, verifyAdminAuth, requireAdminOrigin } = options;

  app.get("/api/v1/admin/support/messages", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!pool) return reply.code(503).send({ error: { code: "SUPPORT_STORAGE_UNAVAILABLE", message: "站内信数据库暂不可用" } });
    const query = (request.query as { limit?: string; status?: string }) ?? {};
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 300);
    const status = ["unread", "read", "resolved"].includes(query.status ?? "") ? (query.status ?? null) : null;
    const messages = await fetchSupportMessages(pool, limit, status);
    return reply.send({ messages });
  });

  app.post("/api/v1/admin/support/messages/:messageId/reply", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!pool) return reply.code(503).send({ error: { code: "SUPPORT_STORAGE_UNAVAILABLE", message: "站内信数据库暂不可用" } });
    const { messageId } = request.params as { messageId: string };
    if (!validUuid(messageId)) return reply.code(400).send({ error: { code: "INVALID_MESSAGE_ID", message: "来信编号无效" } });
    const body = (request.body ?? {}) as { message?: unknown };
    const content = typeof body.message === "string" ? body.message.trim() : "";
    if (!content || content.length > 4000) return reply.code(400).send({ error: { code: "INVALID_REPLY", message: "回复内容限 1–4000 字" } });
    const replyId = await replySupportMessage(pool, messageId, content, operator.id);
    if (!replyId) return reply.code(404).send({ error: { code: "SUPPORT_MESSAGE_NOT_FOUND", message: "用户来信不存在" } });
    return reply.code(201).send({ success: true, replyId, messageId });
  });

  app.post("/api/v1/admin/support/messages/:messageId/resolve", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!pool) return reply.code(503).send({ error: { code: "SUPPORT_STORAGE_UNAVAILABLE", message: "站内信数据库暂不可用" } });
    const { messageId } = request.params as { messageId: string };
    const ok = await resolveSupportMessage(pool, messageId);
    if (!ok) return reply.code(404).send({ error: { code: "SUPPORT_MESSAGE_NOT_FOUND", message: "站内信不存在或已处理" } });
    return reply.send({ success: true, messageId, operatorId: operator.id });
  });

  app.get("/api/v1/admin/inbox/messages", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!pool) return reply.code(503).send({ error: { code: "INBOX_STORAGE_UNAVAILABLE" } });
    const messages = await fetchInboxMessages(pool);
    return reply.send({ messages });
  });

  app.post("/api/v1/admin/inbox/messages", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!pool) return reply.code(503).send({ error: { code: "INBOX_STORAGE_UNAVAILABLE" } });
    const body = (request.body ?? {}) as { subject?: unknown; body?: unknown; category?: unknown; status?: unknown };
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const content = typeof body.body === "string" ? body.body.trim() : "";
    const category = ["welcome", "features", "notice"].includes(String(body.category)) ? String(body.category) : "notice";
    const status = ["draft", "published"].includes(String(body.status)) ? String(body.status) : "draft";
    if (!subject || subject.length > 120 || !content || content.length > 4000) {
      return reply.code(400).send({ error: { code: "INVALID_INBOX_MESSAGE", message: "标题限 1–120 字，正文限 1–4000 字" } });
    }
    const message = await createInboxMessage(pool, subject, content, category, status, operator.id);
    return reply.code(201).send({ message });
  });

  app.put("/api/v1/admin/inbox/messages/:messageId", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!pool) return reply.code(503).send({ error: { code: "INBOX_STORAGE_UNAVAILABLE" } });
    const { messageId } = request.params as { messageId: string };
    const body = (request.body ?? {}) as { subject?: unknown; body?: unknown; category?: unknown; status?: unknown };
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const content = typeof body.body === "string" ? body.body.trim() : "";
    const category = ["welcome", "features", "notice"].includes(String(body.category)) ? String(body.category) : "notice";
    const status = ["draft", "published"].includes(String(body.status)) ? String(body.status) : "draft";
    if (!validUuid(messageId) || !subject || subject.length > 120 || !content || content.length > 4000) {
      return reply.code(400).send({ error: { code: "INVALID_INBOX_MESSAGE", message: "站内信内容或编号无效" } });
    }
    const message = await updateInboxMessage(pool, messageId, subject, content, category, status);
    if (!message) return reply.code(404).send({ error: { code: "MESSAGE_NOT_FOUND" } });
    return reply.send({ message, operatorId: operator.id });
  });

  app.delete("/api/v1/admin/inbox/messages/:messageId", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!pool) return reply.code(503).send({ error: { code: "INBOX_STORAGE_UNAVAILABLE" } });
    const { messageId } = request.params as { messageId: string };
    if (!validUuid(messageId)) return reply.code(400).send({ error: { code: "INVALID_MESSAGE_ID" } });
    const ok = await deleteInboxMessage(pool, messageId);
    if (!ok) return reply.code(404).send({ error: { code: "MESSAGE_NOT_FOUND" } });
    return reply.send({ success: true, messageId, operatorId: operator.id });
  });
}

