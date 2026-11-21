import type { Pool } from "pg";

function numeric(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function maskAdminContact(phone: unknown, email: unknown): string {
  const cleanPhone = String(phone ?? "").trim();
  if (cleanPhone) return cleanPhone.length >= 7 ? `${cleanPhone.slice(0, 3)}****${cleanPhone.slice(-4)}` : cleanPhone;
  const cleanEmail = String(email ?? "").trim();
  if (!cleanEmail.includes("@")) return "";
  const [local, domain] = cleanEmail.split("@");
  return `${(local ?? "").slice(0, 2)}***@${domain ?? ""}`;
}

export async function fetchSupportMessages(pool: Pool, limit: number, status: string | null) {
  const result = await pool.query(
    "SELECT m.id, m.user_id, m.order_id, m.subject, m.message, m.status, m.created_at, u.display_name, u.phone, u.email FROM support_messages m JOIN users u ON u.id = m.user_id WHERE ($2::text IS NULL OR m.status = $2) ORDER BY CASE m.status WHEN 'unread' THEN 0 WHEN 'read' THEN 1 ELSE 2 END, m.created_at DESC LIMIT $1",
    [limit, status],
  );
  return result.rows.map((row: any) => ({
    id: row.id,
    userId: row.user_id,
    orderId: row.order_id,
    displayName: row.display_name ?? "简兮用户",
    contact: maskAdminContact(row.phone, row.email),
    subject: row.subject,
    message: row.message,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function replySupportMessage(pool: Pool, messageId: string, content: string, operatorId: string) {
  const result = await pool.query(
    `WITH original AS (
       UPDATE support_messages
       SET status = CASE WHEN status = 'unread' THEN 'read' ELSE status END,
           read_at = COALESCE(read_at, now())
       WHERE id = $1
       RETURNING user_id, subject
     ),
     inserted AS (
       INSERT INTO site_inbox_messages
         (recipient_user_id, subject, body, category, status, created_by, published_at)
       SELECT user_id, left('回复：' || subject, 120), $2, 'notice', 'published', $3, now()
       FROM original
       RETURNING id
     )
     SELECT inserted.id FROM inserted`,
    [messageId, content, operatorId],
  );
  return result.rows[0]?.id ?? null;
}

export async function resolveSupportMessage(pool: Pool, messageId: string) {
  const result = await pool.query(
    "UPDATE support_messages SET status = 'resolved', read_at = COALESCE(read_at, now()), resolved_at = now() WHERE id = $1 AND status <> 'resolved' RETURNING id",
    [messageId],
  );
  return Boolean(result.rows[0]);
}

export async function fetchInboxMessages(pool: Pool) {
  const result = await pool.query(
    "SELECT id, subject, body, category, status, created_at, updated_at, published_at FROM site_inbox_messages WHERE recipient_user_id IS NULL ORDER BY updated_at DESC LIMIT 300",
  );
  return result.rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    body: row.body,
    category: row.category,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    publishedAt: row.published_at?.toISOString?.() ?? null,
  }));
}

export async function createInboxMessage(pool: Pool, subject: string, content: string, category: string, status: string, operatorId: string) {
  const result = await pool.query(
    `INSERT INTO site_inbox_messages (subject, body, category, status, created_by, published_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = 'published' THEN now() ELSE NULL END)
     RETURNING id, subject, body, category, status, created_at, updated_at, published_at`,
    [subject, content, category, status, operatorId],
  );
  return result.rows[0];
}

export async function updateInboxMessage(pool: Pool, messageId: string, subject: string, content: string, category: string, status: string) {
  const result = await pool.query(
    `UPDATE site_inbox_messages SET subject = $2, body = $3, category = $4, status = $5,
       updated_at = now(), published_at = CASE WHEN $5 = 'published' THEN COALESCE(published_at, now()) ELSE NULL END
     WHERE id = $1 RETURNING id, subject, body, category, status, created_at, updated_at, published_at`,
    [messageId, subject, content, category, status],
  );
  return result.rows[0] ?? null;
}

export async function deleteInboxMessage(pool: Pool, messageId: string) {
  const result = await pool.query("DELETE FROM site_inbox_messages WHERE id = $1 RETURNING id", [messageId]);
  return Boolean(result.rows[0]);
}

export type RefundResult =
  | { code: "OK"; refundRecordId: string; refundedAmountYuan: number; remainingRevenueYuan: number; orderStatus: string }
  | { code: "ORDER_NOT_FOUND" }
  | { code: "ORDER_NOT_CONFIRMED_PAID" }
  | { code: "EXCEEDS_REMAINING"; remaining: number }
  | { code: "REFERENCE_DUPLICATE" }
  | { code: "FAILED" };

export async function registerManualRefund(
  pool: Pool,
  orderId: string,
  amountYuan: number,
  externalReference: string,
  note: string,
  operatorId: string,
): Promise<RefundResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ id: string; status: string; payment_provider: string | null; provider_payment_status: string; provider_price_yuan: string | number | null; amount_yuan: string | number; refunded_amount_yuan: string | number }>(
      "SELECT id, status, payment_provider, provider_payment_status, provider_price_yuan, amount_yuan, refunded_amount_yuan FROM billing_orders WHERE id = $1 FOR UPDATE", [orderId],
    );
    const order = result.rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return { code: "ORDER_NOT_FOUND" };
    }
    if (order.payment_provider !== "opcpay" || !["PAID", "REFUNDED"].includes(order.provider_payment_status) || !["paid", "refunded"].includes(order.status)) {
      await client.query("ROLLBACK");
      return { code: "ORDER_NOT_CONFIRMED_PAID" };
    }
    const gross = Number(order.provider_price_yuan ?? order.amount_yuan);
    const alreadyRefunded = Number(order.refunded_amount_yuan ?? 0);
    const remaining = Math.max(0, Number((gross - alreadyRefunded).toFixed(2)));
    if (amountYuan > remaining) {
      await client.query("ROLLBACK");
      return { code: "EXCEEDS_REMAINING", remaining };
    }
    const duplicate = await client.query(
      "SELECT id FROM billing_order_refund_records WHERE source = 'manual' AND external_reference = $1 LIMIT 1",
      [externalReference],
    );
    if (duplicate.rowCount) {
      await client.query("ROLLBACK");
      return { code: "REFERENCE_DUPLICATE" };
    }
    const inserted = await client.query<{ id: string }>(
      "INSERT INTO billing_order_refund_records (order_id, amount_yuan, source, external_reference, note, recorded_by) VALUES ($1, $2, 'manual', $3, $4, $5) RETURNING id",
      [orderId, amountYuan, externalReference, note, operatorId],
    );
    const updated = await client.query<{ refunded_amount_yuan: string | number; status: string }>(
      "UPDATE billing_orders SET refunded_amount_yuan = refunded_amount_yuan + $2, refunded_at = now(), status = CASE WHEN refunded_amount_yuan + $2 >= COALESCE(provider_price_yuan, amount_yuan) THEN 'refunded' ELSE status END WHERE id = $1 RETURNING refunded_amount_yuan, status",
      [orderId, amountYuan],
    );
    await client.query("COMMIT");
    const refundedAmountYuan = numeric(updated.rows[0]?.refunded_amount_yuan);
    return {
      code: "OK",
      refundRecordId: inserted.rows[0]?.id ?? "",
      refundedAmountYuan,
      remainingRevenueYuan: Math.max(0, Number((gross - refundedAmountYuan).toFixed(2))),
      orderStatus: updated.rows[0]?.status ?? "",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505") {
      return { code: "REFERENCE_DUPLICATE" };
    }
    return { code: "FAILED" };
  } finally {
    client.release();
  }
}
