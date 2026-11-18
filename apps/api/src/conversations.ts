import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { authenticatedUser } from "./assets.js";
import type { AuthStore } from "./auth.js";
import { withDatabaseRetry } from "./database.js";

export interface ConversationRoutesOptions {
  authStore: AuthStore;
  pool: Pool;
  allowedOrigins: string[];
}

type StoredMessage = {
  id: string;
  role: "user" | "director";
  text: string;
  [key: string]: unknown;
};

function isStoredMessage(value: unknown): value is StoredMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return typeof message.id === "string"
    && message.id.length > 0 && message.id.length <= 120
    && (message.role === "user" || message.role === "director")
    && typeof message.text === "string"
    && message.text.length <= 12_000;
}

export function registerConversationRoutes(app: FastifyInstance, options: ConversationRoutesOptions): void {
  app.get("/api/v1/conversations", async (request, reply) => {
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
    try {
      const result = await options.pool.query<{
        id: string;
        title: string;
        updated_at: Date;
        messages: unknown;
      }>(`
        SELECT c.id, c.title, c.updated_at,
          coalesce((
            SELECT jsonb_agg(m.content ORDER BY m.sequence_no ASC)
            FROM (
              SELECT content, sequence_no
              FROM conversation_messages
              WHERE conversation_id = c.id AND user_id = c.user_id
              ORDER BY sequence_no DESC
              LIMIT 100
            ) m
          ), '[]'::jsonb) AS messages
        FROM conversations c
        WHERE c.user_id = $1
        ORDER BY c.updated_at DESC
        LIMIT 30
      `, [user.id]);
      return reply.header("cache-control", "no-store").send({
        conversations: result.rows.map((row) => ({
          id: row.id,
          title: row.title,
          updatedAt: row.updated_at instanceof Date ? row.updated_at.getTime() : new Date(row.updated_at).getTime(),
          messages: Array.isArray(row.messages) ? row.messages : [],
        })),
      });
    } catch {
      return reply.code(503).send({ error: { code: "CONVERSATIONS_UNAVAILABLE", message: "历史对话暂时无法读取，请稍后重试", requestId: request.id } });
    }
  });

  app.put("/api/v1/conversations/:id", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (typeof request.headers.origin !== "string" || !options.allowedOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    }
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });

    const { id } = request.params as { id: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return reply.code(400).send({ error: { code: "INVALID_CONVERSATION_ID", message: "对话标识无效" } });
    }
    const body = (request.body ?? {}) as { title?: unknown; messages?: unknown };
    if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 160
      || !Array.isArray(body.messages) || body.messages.length > 100
      || !body.messages.every(isStoredMessage)) {
      return reply.code(400).send({ error: { code: "INVALID_CONVERSATION", message: "对话内容格式无效" } });
    }
    const messages = body.messages as StoredMessage[];
    const serialized = messages.map((message) => JSON.stringify(message));
    if (serialized.some((message) => message.length > 100_000)
      || serialized.reduce((total, message) => total + message.length, 0) > 1_500_000) {
      return reply.code(413).send({ error: { code: "CONVERSATION_TOO_LARGE", message: "单个对话内容过大，请减少历史内容后重试" } });
    }

    const client = await withDatabaseRetry(() => options.pool.connect());
    try {
      await client.query("BEGIN");
      const saved = await client.query(
        `INSERT INTO conversations (id, user_id, title)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE
           SET title = EXCLUDED.title, updated_at = now()
           WHERE conversations.user_id = EXCLUDED.user_id
         RETURNING id`,
        [id, user.id, body.title.trim()],
      );
      if (!saved.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "CONVERSATION_CONFLICT", message: "对话不存在或不属于当前账号" } });
      }
      await client.query("DELETE FROM conversation_messages WHERE conversation_id = $1 AND user_id = $2", [id, user.id]);
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]!;
        await client.query(
          "INSERT INTO conversation_messages (conversation_id, user_id, sequence_no, role, content) VALUES ($1, $2, $3, $4, $5::jsonb)",
          [id, user.id, index + 1, message.role, serialized[index]],
        );
      }
      await client.query("COMMIT");
      return reply.header("cache-control", "no-store").send({ saved: true, conversationId: id, messageCount: messages.length });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error, conversationId: id, userId: user.id }, "conversation save failed");
      return reply.code(503).send({ error: { code: "CONVERSATION_SAVE_FAILED", message: "对话保存失败，请稍后重试", requestId: request.id } });
      } finally {
        client.release();
    }
  });
}
