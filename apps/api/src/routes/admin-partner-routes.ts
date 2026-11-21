import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  fetchPartnerDirectory,
  fetchWithdrawals,
  fetchWithdrawalPayoutDetail,
  fetchPendingPartnerProfiles,
  fetchPartnerProfileDetail,
  reviewPartnerProfile,
  reviewWithdrawal,
  markWithdrawalPaid,
  markWithdrawalFailed,
} from "../services/admin-partner-service.js";

const validUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export interface AdminPartnerRoutesOptions {
  pool?: Pool | undefined;
  verifyAdminAuth: (request: any, reply: any) => Promise<any>;
  requireAdminOrigin: (request: any, reply: any) => boolean;
}

export function registerAdminPartnerRoutes(app: FastifyInstance, options: AdminPartnerRoutesOptions): void {
  const { pool, verifyAdminAuth, requireAdminOrigin } = options;

  app.get("/api/v1/admin/partners", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const query = (request.query as { limit?: string }) ?? {};
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 300);
    const partners = await fetchPartnerDirectory(pool, limit);
    return reply.send({ partners });
  });

  app.get("/api/v1/admin/partner/withdrawals", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const query = (request.query as { status?: string; limit?: string }) ?? {};
    const statuses = new Set(["pending", "approved", "paid", "rejected", "failed"]);
    const status = query.status && statuses.has(query.status) ? query.status : null;
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
    const withdrawals = await fetchWithdrawals(pool, status, limit);
    return reply.send({ withdrawals });
  });

  app.get("/api/v1/admin/partner/withdrawals/:withdrawalId/payout", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const { withdrawalId } = request.params as { withdrawalId: string };
    if (!validUuid(withdrawalId)) return reply.code(400).send({ error: { code: "INVALID_WITHDRAWAL_ID" } });
    try {
      const payout = await fetchWithdrawalPayoutDetail(pool, withdrawalId, operator.id);
      if (!payout) return reply.code(404).send({ error: { code: "WITHDRAWAL_NOT_FOUND" } });
      return reply.send({ payout });
    } catch {
      return reply.code(503).send({ error: { code: "PAYOUT_DECRYPTION_FAILED", message: "无法安全解密收款资料，请检查服务端密钥" } });
    }
  });

  app.get("/api/v1/admin/partner/profiles", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const profiles = await fetchPendingPartnerProfiles(pool);
    return reply.send({ profiles });
  });

  app.get("/api/v1/admin/partner/profiles/:userId", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const { userId } = request.params as { userId: string };
    if (!validUuid(userId)) return reply.code(400).send({ error: { code: "INVALID_USER_ID" } });
    try {
      const profile = await fetchPartnerProfileDetail(pool, userId, operator.id);
      if (!profile) return reply.code(404).send({ error: { code: "PAYOUT_PROFILE_NOT_FOUND" } });
      return reply.send({ profile });
    } catch {
      return reply.code(503).send({ error: { code: "PAYOUT_DECRYPTION_FAILED", message: "无法安全解密收款资料，请检查服务端密钥" } });
    }
  });

  app.post("/api/v1/admin/partner/profiles/:userId/verify", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const { userId } = request.params as { userId: string };
    const body = (request.body as { status?: string; note?: string } | undefined) ?? {};
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
    if (!validUuid(userId) || !["verified", "rejected"].includes(body.status ?? "") || (body.status === "rejected" && !note)) {
      return reply.code(400).send({ error: { code: "INVALID_PROFILE_REVIEW", message: "审核状态或驳回原因无效" } });
    }
    try {
      const res = await reviewPartnerProfile(pool, userId, body.status as "verified" | "rejected", note, operator.id);
      if (res.code === "NOT_FOUND") return reply.code(404).send({ error: { code: "PAYOUT_PROFILE_NOT_FOUND" } });
      if (res.code === "ALREADY_REVIEWED") return reply.code(409).send({ error: { code: "PROFILE_ALREADY_REVIEWED" } });
      return reply.send({ success: true, userId, status: body.status });
    } catch {
      return reply.code(503).send({ error: { code: "PROFILE_REVIEW_FAILED" } });
    }
  });

  app.post("/api/v1/admin/partner/withdrawals/:withdrawalId/review", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const { withdrawalId } = request.params as { withdrawalId: string };
    const body = (request.body as { status?: string; note?: string } | undefined) ?? {};
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
    if (!validUuid(withdrawalId) || !["approved", "rejected"].includes(body.status ?? "") || (body.status === "rejected" && !note)) {
      return reply.code(400).send({ error: { code: "INVALID_WITHDRAWAL_REVIEW", message: "审核状态或驳回原因无效" } });
    }
    try {
      const res = await reviewWithdrawal(pool, withdrawalId, body.status as "approved" | "rejected", note, operator.id);
      if (res.code === "NOT_FOUND") return reply.code(404).send({ error: { code: "WITHDRAWAL_NOT_FOUND" } });
      if (res.code === "NOT_PENDING") return reply.code(409).send({ error: { code: "WITHDRAWAL_NOT_PENDING" } });
      return reply.send({ success: true, withdrawalId, status: body.status });
    } catch {
      return reply.code(503).send({ error: { code: "WITHDRAWAL_REVIEW_FAILED" } });
    }
  });

  app.post("/api/v1/admin/partner/withdrawals/:withdrawalId/paid", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const { withdrawalId } = request.params as { withdrawalId: string };
    const body = (request.body as { externalReference?: string; note?: string } | undefined) ?? {};
    const reference = typeof body.externalReference === "string" ? body.externalReference.trim().slice(0, 160) : "";
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
    if (!validUuid(withdrawalId) || reference.length < 4) {
      return reply.code(400).send({ error: { code: "INVALID_PAYMENT_REFERENCE", message: "请填写有效的企业支付宝转账流水号或凭证编号" } });
    }
    try {
      const res = await markWithdrawalPaid(pool, withdrawalId, reference, note, operator.id);
      if (res.code === "NOT_FOUND") return reply.code(404).send({ error: { code: "WITHDRAWAL_NOT_FOUND" } });
      if (res.code === "NOT_APPROVED") return reply.code(409).send({ error: { code: "WITHDRAWAL_NOT_APPROVED" } });
      if (res.code === "REFERENCE_DUPLICATE") {
        return reply.code(409).send({ error: { code: "PAYMENT_REFERENCE_ALREADY_USED", message: "该转账凭证已登记在其他提现记录中" } });
      }
      return reply.send({ success: true, withdrawalId, status: "paid" });
    } catch {
      return reply.code(503).send({ error: { code: "WITHDRAWAL_PAYMENT_RECORD_FAILED" } });
    }
  });

  app.post("/api/v1/admin/partner/withdrawals/:withdrawalId/failed", async (request, reply) => {
    const operator = await verifyAdminAuth(request, reply);
    if (!operator) return;
    if (!requireAdminOrigin(request, reply)) return;
    if (!pool) return reply.code(503).send({ error: { code: "PARTNER_FINANCE_UNAVAILABLE" } });
    const { withdrawalId } = request.params as { withdrawalId: string };
    const body = (request.body as { note?: string } | undefined) ?? {};
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
    if (!validUuid(withdrawalId) || !note) {
      return reply.code(400).send({ error: { code: "INVALID_FAILURE_NOTE", message: "请填写打款失败原因" } });
    }
    try {
      const res = await markWithdrawalFailed(pool, withdrawalId, note, operator.id);
      if (res.code === "NOT_FOUND") return reply.code(404).send({ error: { code: "WITHDRAWAL_NOT_FOUND" } });
      if (res.code === "NOT_APPROVED") return reply.code(409).send({ error: { code: "WITHDRAWAL_NOT_APPROVED" } });
      return reply.send({ success: true, withdrawalId, status: "failed" });
    } catch {
      return reply.code(503).send({ error: { code: "WITHDRAWAL_FAILURE_RECORD_FAILED" } });
    }
  });
}

