import type { FastifyInstance } from "fastify";
import { type AuthStore } from "./auth.js";
import { authenticatedUser } from "./assets.js";
import QRCode from "qrcode";
import type { GrowthStore } from "./growth-store.js";
export interface GrowthRoutesOptions {
  authStore: AuthStore;
  growthStore: GrowthStore;
  allowedOrigins: string[];
}

export function registerGrowthRoutes(app: FastifyInstance, options: GrowthRoutesOptions): void {
  async function requireUser(request: any, reply: any) {
    if (typeof request.headers.origin === "string" && !options.allowedOrigins.includes(request.headers.origin)) {
      reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
      return null;
    }
    const user = await authenticatedUser(request, options.authStore);
    if (!user) {
      reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
      return null;
    }
    return user;
  }

  app.get("/api/v1/growth/qr/:code", async (request, reply) => {
    const { code } = request.params as { code: string };
    const cleanCode = (code || "").trim();
    if (!cleanCode || cleanCode.length > 32) return reply.code(400).send({ error: { code: "INVALID_INVITE_CODE" } });
    const inviteUrl = `https://jansee.cn/?ref=${encodeURIComponent(cleanCode.toUpperCase())}`;
    const png = await QRCode.toBuffer(inviteUrl, { type: "png", width: 480, margin: 2, errorCorrectionLevel: "H" });
    return reply.type("image/png").header("cache-control", "private, max-age=300").send(png);
  });

  app.get("/api/v1/growth/overview", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const query = request.query as { timeZone?: string };
    try {
      const overview = await options.growthStore.getOverview(user.id, query.timeZone || "Asia/Shanghai");
      return reply.header("cache-control", "no-store").send({ overview });
    } catch {
      return reply.code(503).send({ error: { code: "GROWTH_UNAVAILABLE", message: "推广与合作数据暂时不可用", requestId: request.id } });
    }
  });

  app.get("/api/v1/growth/invitees", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    try {
      const invitees = await options.growthStore.listInvitees(user.id);
      return reply.header("cache-control", "no-store").send({ invitees });
    } catch {
      return reply.code(503).send({ error: { code: "GROWTH_INVITEES_UNAVAILABLE", message: "邀请记录暂时不可用", requestId: request.id } });
    }
  });

  app.get("/api/v1/growth/commissions", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    try {
      const commissions = await options.growthStore.listCommissions(user.id);
      return reply.header("cache-control", "no-store").send({ commissions });
    } catch {
      return reply.code(503).send({ error: { code: "GROWTH_COMMISSIONS_UNAVAILABLE", message: "佣金明细暂时不可用", requestId: request.id } });
    }
  });

  app.get("/api/v1/growth/payout-profile", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    try { return reply.header("cache-control", "no-store").send({ profile: await options.growthStore.getPayoutProfile(user.id) }); }
    catch { return reply.code(503).send({ error: { code: "PAYOUT_PROFILE_UNAVAILABLE", message: "收款资料暂时不可用", requestId: request.id } }); }
  });

  app.put("/api/v1/growth/payout-profile", { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } }, async (request, reply) => {
    if (typeof request.headers.origin !== "string" || !options.allowedOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    }

    const user = await requireUser(request, reply);
    if (!user) return;
    const body = (request.body ?? {}) as { accountName?: string; account?: string };
    if (typeof body.accountName !== "string" || typeof body.account !== "string") {
      return reply.code(400).send({ error: { code: "INVALID_PAYOUT_PROFILE", message: "请填写支付宝实名姓名和账号" } });
    }
    try {
      const profile = await options.growthStore.savePayoutProfile(user.id, body.accountName, body.account);
      return reply.send({ profile });
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存收款资料失败";
      if (message.includes("请输入") || message.includes("仅城市合伙人")) return reply.code(400).send({ error: { code: "INVALID_PAYOUT_PROFILE", message } });
      if (message.includes("加密密钥")) return reply.code(503).send({ error: { code: "PAYOUT_ENCRYPTION_NOT_CONFIGURED", message: "提现资料加密尚未配置，请联系管理员" } });
      return reply.code(503).send({ error: { code: "PAYOUT_PROFILE_SAVE_FAILED", message: "收款资料保存失败，请稍后重试", requestId: request.id } });
    }
  });

  app.get("/api/v1/growth/withdrawals", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    try { return reply.header("cache-control", "no-store").send({ withdrawals: await options.growthStore.listWithdrawals(user.id) }); }
    catch { return reply.code(503).send({ error: { code: "WITHDRAWALS_UNAVAILABLE", message: "提现记录暂时不可用", requestId: request.id } }); }
  });

  app.post("/api/v1/growth/withdrawals", { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } }, async (request, reply) => {
    if (typeof request.headers.origin !== "string" || !options.allowedOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    }
    const user = await requireUser(request, reply);
    if (!user) return;
    const body = (request.body ?? {}) as { amountYuan?: number; idempotencyKey?: string };
    if (typeof body.amountYuan !== "number" || typeof body.idempotencyKey !== "string") {
      return reply.code(400).send({ error: { code: "INVALID_WITHDRAWAL", message: "提现金额或请求标识无效" } });
    }
    try {
      const withdrawal = await options.growthStore.createWithdrawal(user.id, body.amountYuan, body.idempotencyKey);
      return reply.code(withdrawal.replayed ? 200 : 201).send({ withdrawal });
    } catch (error) {
      const message = error instanceof Error ? error.message : "提现申请失败";
      if (message.includes("无效") || message.includes("须为") || message.includes("不足") || message.includes("仅已开通") || message.includes("请先") || message.includes("尚未通过管理员核验") || message.includes("今日提现次数") || message.includes("今日累计提现")) {
        return reply.code(400).send({ error: { code: "WITHDRAWAL_NOT_ALLOWED", message } });
      }
      return reply.code(503).send({ error: { code: "WITHDRAWAL_FAILED", message: "提现申请暂时失败，请稍后重试", requestId: request.id } });
    }
  });

  app.post("/api/v1/growth/checkin", async (request, reply) => {
    if (typeof request.headers.origin !== "string" || !options.allowedOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    }
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
    const body = (request.body ?? {}) as { timeZone?: string };
    try {
      const result = await options.growthStore.checkin(user.id, body.timeZone || "Asia/Shanghai", 100);
      return reply.send(result);
    } catch {
      return reply.code(503).send({ error: { code: "CHECKIN_UNAVAILABLE", message: "签到暂时失败，请稍后重试", requestId: request.id } });
    }
  });

  app.post("/api/v1/growth/partner/activate", async (request, reply) => {
    if (typeof request.headers.origin !== "string" || !options.allowedOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    }
    const user = await authenticatedUser(request, options.authStore);
    if (!user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
    const body = (request.body ?? {}) as { province?: string; city?: string };
    if (typeof body.province !== "string" || typeof body.city !== "string") {
      return reply.code(400).send({ error: { code: "INVALID_PARAM", message: "请选择合伙人负责省份和城市" } });
    }
    try {
      const result = await options.growthStore.activatePartner(user.id, body.province, body.city, 5);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "合伙人申请失败";
      if ((error as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: { code: "PARTNER_CITY_TAKEN", message: "该城市已有合伙人，请选择其他城市" } });
      }
      if (message.includes("邀请人数不足") || message.includes("请选择")) {
        return reply.code(400).send({ error: { code: "PARTNER_NOT_ELIGIBLE", message } });
      }
      return reply.code(503).send({ error: { code: "PARTNER_UNAVAILABLE", message: "合伙人申请暂时不可用", requestId: request.id } });
    }
  });

}
