import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildApp } from "../apps/api/src/app.js";
import type { AuthStore, AuthUser } from "../apps/api/src/auth.js";
import type { Pool } from "pg";
import { InMemoryBillingStore } from "../apps/api/src/billing.js";

// 真实数据库集成测试的连接串：优先环境变量，其次项目根目录 .env
function loadDatabaseUrl(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
    const line = raw.split(/\r?\n/).find((item) => item.startsWith("DATABASE_URL="));
    return line ? line.slice("DATABASE_URL=".length).trim() : null;
  } catch {
    return null;
  }
}

const testAdminUser: AuthUser = {
  id: "99999999-9999-4999-8999-999999999999",
  email: "admin@jansee.com",
  displayName: "OPC Admin",
  createdAt: new Date().toISOString(),
};

test("admin site analytics exposes only imported V2 human aggregates", async () => {
  const validToken = "t".repeat(43);
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async findUserById(id) { return id === testAdminUser.id ? testAdminUser : null; },
    async verifyPassword() { return null; },
    async createSession() {},
    async findSession() { return { user: testAdminUser, expiresAt: new Date(Date.now() + 3600_000) }; },
    async deleteSession() {},
    async deleteUserSessions() {},
  };
  const pool = {
    async query(sql: string) {
      assert.match(sql, /site_daily_analytics/);
      return { rows: [
        { day: "2026-11-15", pv: 63, uv: 8, source: "v2-real-visitor-aggregate", breakdown: { sources: { "直接访问": 63 }, pages: { "/": 63 }, regions: {}, devices: { "手机": 60 }, browsers: { Safari: 60 } } },
        { day: "2026-11-16", pv: 14, uv: 12, source: "v2-real-visitor-aggregate", breakdown: { sources: { "直接访问": 13, producthunt: 1 }, pages: { "/": 14 }, regions: {}, devices: { "电脑": 8 }, browsers: { Chrome: 9 } } },
      ], rowCount: 2 };
    },
  } as unknown as Pool;
  const app = buildApp({
    allowedOrigins: ["http://localhost:3000"], logLevel: "silent", production: false,
    authStore, adminPool: pool, adminEmails: ["admin@jansee.com"],
  });
  try {
    const denied = await app.inject({ method: "GET", url: "/api/v1/admin/site-analytics", headers: { origin: "http://localhost:3000" } });
    assert.equal(denied.statusCode, 401);
    const response = await app.inject({
      method: "GET", url: "/api/v1/admin/site-analytics?days=30",
      headers: { origin: "http://localhost:3000", cookie: `jansee_session=${validToken}` },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().summary, { pv: 77, uv: 20, days: 2 });
    assert.equal(response.json().dimensions.sources["直接访问"], 76);
    assert.equal(response.json().dimensions.sources.producthunt, 1);
    assert.match(response.json().note, /Nginx 原始请求/);
  } finally { await app.close(); }
});

test("admin server health exposes host resources and service checks only to administrators", async () => {
  const validToken = "h".repeat(43);
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async findUserById(id) { return id === testAdminUser.id ? testAdminUser : null; },
    async verifyPassword() { return null; },
    async createSession() {},
    async findSession() { return { user: testAdminUser, expiresAt: new Date(Date.now() + 3600_000) }; },
    async deleteSession() {},
    async deleteUserSessions() {},
  };
  const app = buildApp({
    allowedOrigins: ["http://localhost:3000"], logLevel: "silent", production: false,
    authStore, adminEmails: ["admin@jansee.com"],
    workerReady: () => false,
    directorConfigured: true,
  });

  const denied = await app.inject({ method: "GET", url: "/api/v1/admin/server-health", headers: { origin: "http://localhost:3000" } });
  assert.equal(denied.statusCode, 401);

  const response = await app.inject({
    method: "GET", url: "/api/v1/admin/server-health",
    headers: { origin: "http://localhost:3000", cookie: `jansee_session=${validToken}` },
  });
  assert.equal(response.statusCode, 200);
  const health = response.json();
  assert.equal(typeof health.sampledAt, "string");
  assert.ok(health.host.cpuCores >= 1);
  assert.ok(health.host.uptimeSeconds >= 0);
  assert.ok(health.memory.totalBytes > 0);
  assert.ok(health.memory.usedPercent >= 0 && health.memory.usedPercent <= 100);
  assert.ok(["healthy", "unavailable"].includes(health.services.api.status));
  assert.equal(health.services.database.status, "not_configured");
  assert.equal(health.services.director.status, "configured");
  assert.equal(health.services.worker.status, "unavailable");
  assert.equal(JSON.stringify(health).includes("DATABASE_URL"), false);
  await app.close();
});

test("admin compensation grants credits once and only for a failed job", async () => {
  const validToken = "z".repeat(43);
  const adminUser: AuthUser = { ...testAdminUser, email: "admin@jansee.com" };
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async findUserById(id) { return id === adminUser.id ? adminUser : null; },
    async verifyPassword() { return null; },
    async createSession() {},
    async findSession() { return { user: adminUser, expiresAt: new Date(Date.now() + 3600_000) }; },
    async deleteSession() {},
    async deleteUserSessions() {},
  };
  const jobId = "11111111-1111-4111-8111-111111111111";
  const pool = {
    async query(sql: string) {
      if (sql.includes("SELECT user_id, status FROM generation_jobs")) {
        return { rows: [{ user_id: adminUser.id, status: "failed" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const billingStore = new InMemoryBillingStore({ initialGrant: 0 });
  const app = buildApp({
    allowedOrigins: ["http://localhost:3000"], logLevel: "silent", production: false,
    authStore, adminPool: pool, billingStore, adminEmails: ["admin@jansee.com"],
  });
  const request = () => app.inject({
    method: "POST", url: `/api/v1/admin/jobs/${jobId}/compensate`,
    headers: { origin: "http://localhost:3000", cookie: `jansee_session=${validToken}`, "content-type": "application/json" },
    payload: { credits: 200, reason: "失败任务补偿" },
  });
  const first = await request();
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().wallet.availableCredits, 200);
  const second = await request();
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().wallet.availableCredits, 200);
  const ledger = await billingStore.getLedger(adminUser.id);
  assert.equal(ledger.filter((entry) => entry.type === "compensation").length, 1);
  await app.close();
});

test("admin credit adjustment endpoint validates input, moves balance, and audits the operator", async () => {
  const validToken = "c".repeat(43);
  const targetUserId = "22222222-2222-4222-8222-222222222222";
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async findUserById(id) { return id === testAdminUser.id ? testAdminUser : null; },
    async verifyPassword() { return null; },
    async createSession() {},
    async findSession() { return { user: testAdminUser, expiresAt: new Date(Date.now() + 3600_000) }; },
    async deleteSession() {},
    async deleteUserSessions() {},
  };
  const pool = {
    async query(sql: string) {
      if (sql.includes("SELECT id FROM users")) return { rows: [{ id: targetUserId }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const billingStore = new InMemoryBillingStore({ initialGrant: 500 });
  const app = buildApp({
    allowedOrigins: ["http://localhost:3000"], logLevel: "silent", production: false,
    authStore, adminPool: pool, billingStore, adminEmails: ["admin@jansee.com"],
  });
  const headers = {
    origin: "http://localhost:3000",
    cookie: `jansee_session=${validToken}`,
    "content-type": "application/json",
  };
  const request = (payload: unknown, cookieHeaders = headers) => app.inject({
    method: "POST", url: `/api/v1/admin/users/${targetUserId}/credits`, headers: cookieHeaders, payload,
  });

  const unauth = await request({ credits: 100, reason: "未登录" }, {
    origin: "http://localhost:3000", "content-type": "application/json",
  });
  assert.equal(unauth.statusCode, 401);

  const zeroAmount = await request({ credits: 0, reason: "零" });
  assert.equal(zeroAmount.statusCode, 400);
  assert.equal(zeroAmount.json().error.code, "INVALID_CREDIT_ADJUSTMENT");

  const blankReason = await request({ credits: 100, reason: "   " });
  assert.equal(blankReason.statusCode, 400);
  assert.equal(blankReason.json().error.code, "INVALID_ADJUSTMENT_REASON");

  const badUser = await app.inject({
    method: "POST", url: "/api/v1/admin/users/not-a-uuid/credits", headers, payload: { credits: 100, reason: "无效用户" },
  });
  assert.equal(badUser.statusCode, 400);

  const added = await request({ credits: 300, reason: "客户投诉补偿" });
  assert.equal(added.statusCode, 200);
  assert.equal(added.json().availableCredits, 800);

  const deducted = await request({ credits: -200, reason: "误扣更正" });
  assert.equal(deducted.statusCode, 200);
  assert.equal(deducted.json().availableCredits, 600);

  const overdraft = await request({ credits: -100_000, reason: "超额扣减" });
  assert.equal(overdraft.statusCode, 400);
  assert.equal(overdraft.json().error.code, "CREDIT_ADJUSTMENT_FAILED");

  const ledger = await billingStore.getLedger(targetUserId);
  const adjustEntries = ledger.filter((entry) => entry.type === "adjust");
  assert.equal(adjustEntries.length, 2);
  assert.ok(adjustEntries.every((entry) => entry.description.includes("管理员调整")));
  await app.close();
});

test("admin API exposes overview stats and director job insights with triad latency metrics", async () => {
  const validToken = "a".repeat(43);
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async findUserById(id) { return id === testAdminUser.id ? testAdminUser : null; },
    async verifyPassword() { return null; },
    async createSession() { throw new Error("not implemented"); },
    async findSession() {
      return {
        user: testAdminUser,
        expiresAt: new Date(Date.now() + 3600_000),
      };
    },
    async deleteSession() { },
    async deleteUserSessions() { },
  };

  const app = buildApp({
    allowedOrigins: ["http://localhost:3000"],
    logLevel: "silent",
    production: false,
    authStore,
    adminEmails: ["admin@jansee.com"],
  });

  // 1. 未授权访问应返回 401
  const unauthRes = await app.inject({
    method: "GET",
    url: "/api/v1/admin/overview",
    headers: { origin: "http://localhost:3000" },
  });
  assert.equal(unauthRes.statusCode, 401);

  // 2. 授权访问经营大盘
  const overviewRes = await app.inject({
    method: "GET",
    url: "/api/v1/admin/overview",
    headers: {
      origin: "http://localhost:3000",
      cookie: `jansee_session=${validToken}`,
    },
  });
  assert.equal(overviewRes.statusCode, 200);
  const overviewData = overviewRes.json();
  assert.ok(overviewData.stats);
  assert.equal(overviewData.stats.todayRevenueYuan, 0);
  assert.equal(overviewData.stats.jobSuccessRate, 0);
  assert.equal(overviewData.stats.revenueDataAvailable, false);
  assert.equal(overviewData.stats.databaseDataAvailable, false);

  // Admin director jobs request
  const jobsRes = await app.inject({
    method: "GET",
    url: "/api/v1/admin/director-jobs",
    headers: {
      origin: "http://localhost:3000",
      cookie: `jansee_session=${validToken}`,
    },
  });
  assert.equal(jobsRes.statusCode, 200);
  const jobsData = jobsRes.json();
  assert.ok(Array.isArray(jobsData.jobs));
  assert.equal(jobsData.jobs.length, 0);
  assert.equal(jobsData.total, 0);

  // Restored test section
  const compRes = await app.inject({
    method: "POST",
    url: "/api/v1/admin/jobs/11111111-1111-4111-8111-111111111111/compensate",
    headers: {
      origin: "http://localhost:3000",
      cookie: `jansee_session=${validToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ credits: 200, reason: "测试人工补单" }),
  });
  assert.equal(compRes.statusCode, 503);
  assert.equal(compRes.json().error.code, "COMPENSATION_NOT_CONFIGURED");

  const ordinaryUser: AuthUser = {
    id: "88888888-8888-4888-8888-888888888888",
    email: "member@jansee.com",
    displayName: "普通用户",
    createdAt: new Date().toISOString(),
  };
  const nonAdminApp = buildApp({
    allowedOrigins: ["http://localhost:3000"],
    logLevel: "silent",
    production: false,
    adminEmails: ["admin@jansee.com"],
    authStore: {
      ...authStore,
      async findSession() {
        return { user: ordinaryUser, expiresAt: new Date(Date.now() + 3600_000) };
      },
    },
  });
  const forbiddenRes = await nonAdminApp.inject({
    method: "GET",
    url: "/api/v1/admin/overview",
    headers: { origin: "http://localhost:3000", cookie: `jansee_session=${validToken}` },
  });
  assert.equal(forbiddenRes.statusCode, 403);
  assert.equal(forbiddenRes.json().error.code, "ADMIN_FORBIDDEN");
  await nonAdminApp.close();

  const noAllowlistApp = buildApp({
    allowedOrigins: ["http://localhost:3000"],
    logLevel: "silent",
    production: false,
    authStore,
  });
  const noAllowlistRes = await noAllowlistApp.inject({
    method: "GET",
    url: "/api/v1/admin/overview",
    headers: { origin: "http://localhost:3000", cookie: `jansee_session=${validToken}` },
  });
  assert.equal(noAllowlistRes.statusCode, 403);
  await noAllowlistApp.close();
  await app.close();
});

test("admin delivery timer stays frozen for failed jobs even when finished_at is missing", async () => {
  const validToken = "f".repeat(43);
  const queuedAt = new Date("2026-11-18T02:00:00.000Z");
  const updatedAt = new Date("2026-11-18T02:01:00.000Z");
  let querySeen = "";
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async findUserById(id) { return id === testAdminUser.id ? testAdminUser : null; },
    async verifyPassword() { return null; },
    async createSession() { throw new Error("not implemented"); },
    async findSession() { return { user: testAdminUser, expiresAt: new Date(Date.now() + 60_000) }; },
    async deleteSession() {},
    async deleteUserSessions() {},
  };
  const pool = {
    async query(sql: string) {
      querySeen = sql;
      return { rows: [{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        status: "failed",
        aspect_ratio: "9:16",
        created_at: queuedAt,
        updated_at: updatedAt,
        queued_at: queuedAt,
        finished_at: null,
        director_plan: null,
        credits_charged: 0,
        error_code: "WORKER_ATTEMPTS_EXHAUSTED",
        error_message: "任务执行租约多次过期",
        total: 1,
      }], rowCount: 1 };
    },
  } as unknown as Pool;
  const app = buildApp({
    allowedOrigins: ["http://localhost:3000"],
    logLevel: "silent",
    production: false,
    authStore,
    adminEmails: ["admin@jansee.com"],
    adminPool: pool,
  });
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/admin/director-jobs?status=failed",
    headers: { origin: "http://localhost:3000", cookie: `jansee_session=${validToken}` },
  });
  assert.equal(response.statusCode, 200);
  assert.match(querySeen, /j\.updated_at/);
  assert.equal(response.json().jobs[0].e2eDurationMs, 60_000);
  await app.close();
});

test("admin delivery timer starts at acceptance (started_at), excluding queue wait", async () => {
  const validToken = "e".repeat(43);
  // 赛马场景：任务 02:00 入队，排队 30s，02:00:30 被 worker 受理，02:00:40 完成。
  // 交付耗时应为受理到完成 = 10s，而不是入队到完成 = 40s。
  const queuedAt = new Date("2026-11-18T02:00:00.000Z");
  const startedAt = new Date("2026-11-18T02:00:30.000Z");
  const finishedAt = new Date("2026-11-18T02:00:40.000Z");
  let querySeen = "";
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async findUserById(id) { return id === testAdminUser.id ? testAdminUser : null; },
    async verifyPassword() { return null; },
    async createSession() { throw new Error("not implemented"); },
    async findSession() { return { user: testAdminUser, expiresAt: new Date(Date.now() + 60_000) }; },
    async deleteSession() {},
    async deleteUserSessions() {},
  };
  const pool = {
    async query(sql: string) {
      querySeen = sql;
      return { rows: [{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        status: "completed",
        aspect_ratio: "9:16",
        created_at: queuedAt,
        updated_at: finishedAt,
        queued_at: queuedAt,
        started_at: startedAt,
        finished_at: finishedAt,
        // 历史任务遥测里写死了旧的偏大耗时（入队→完成 40s）；明细必须忽略它，
        // 只用数据库时间字段算真实制作时间（受理→完成 10s）。
        director_plan: { _telemetry: { e2eDurationMs: 40_000 } },
        credits_charged: 200,
        error_code: null,
        error_message: null,
        total: 1,
      }], rowCount: 1 };
    },
  } as unknown as Pool;
  const app = buildApp({
    allowedOrigins: ["http://localhost:3000"],
    logLevel: "silent",
    production: false,
    authStore,
    adminEmails: ["admin@jansee.com"],
    adminPool: pool,
  });
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/admin/director-jobs?status=completed",
    headers: { origin: "http://localhost:3000", cookie: `jansee_session=${validToken}` },
  });
  assert.equal(response.statusCode, 200);
  assert.match(querySeen, /j\.started_at/);
  // 受理到完成 10s，而非入队到完成 40s——排队等待不计入交付耗时；
  // 且忽略遥测里写死的旧 40s 值，新旧任务明细都只显示真实制作时间。
  assert.equal(response.json().jobs[0].e2eDurationMs, 10_000);
  await app.close();
});

test("admin overview derives revenue, delivery latency and director telemetry from PostgreSQL aggregates", async () => {
  const validToken = "m".repeat(43);
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async findUserById(id) { return id === testAdminUser.id ? testAdminUser : null; },
    async verifyPassword() { return null; },
    async createSession() { throw new Error("not implemented"); },
    async findSession() {
      return { user: testAdminUser, expiresAt: new Date(Date.now() + 3600_000) };
    },
    async deleteSession() {},
    async deleteUserSessions() {},
  };
  let aggregateSql = "";
  const pool = {
    async query(sql: string) {
      aggregateSql = sql;
      return {
        rows: [{
          today_new_users: 3,
          today_revenue_yuan: "100.50",
          today_completed_jobs: 2,
          terminal_jobs: 4,
          completed_jobs: 3,
          total_jobs: 5,
          failed_jobs: 1,
          avg_e2e_ms: "12500",
          p50_e2e_ms: "11000",
          p90_e2e_ms: "22000",
          p99_e2e_ms: "29000",
          avg_llm_ms: "1800",
          avg_tts_ms: "950",
          avg_ffmpeg_ms: "7200",
          avg_renderer_ms: "8100",
          avg_scene_score: null,
          scene_score_records: 0,
          today_cost_estimate_yuan: "20.00",
          today_cost_records: 2,
          variant_hit_rate: "75",
          director_calls: 10,
          primary_model_successes: 7,
          fallback_model_successes: 2,
          heuristic_fallbacks: 1,
          total_tokens_used: 12000,
          token_usage_records: 9,
          total_tts_chars: 2500,
          quality_checked_jobs: 8,
          quality_passed_jobs: 7,
        }],
      };
    },
  } as unknown as Pool;
  const app = buildApp({
    allowedOrigins: ["http://localhost:3000"],
    logLevel: "silent",
    production: false,
    authStore,
    adminEmails: ["admin@jansee.com"],
    adminPool: pool,
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/admin/overview",
    headers: {
      origin: "http://localhost:3000",
      cookie: `jansee_session=${validToken}`,
    },
  });
  assert.equal(response.statusCode, 200);
  const stats = response.json().stats;
  assert.match(aggregateSql, /billing_orders/);
  assert.match(aggregateSql, /provider_payment_status IN \('PAID', 'REFUNDED'\)/);
  assert.match(aggregateSql, /billing_order_refund_records/);
  assert.match(aggregateSql, /generation_jobs/);
  assert.match(aggregateSql, /COALESCE\(started_at, queued_at\)/); // E2E 从受理时间起算，排除排队等待
  assert.match(aggregateSql, /costEstimateYuan/);
  assert.equal(stats.databaseDataAvailable, true);
  assert.equal(stats.todayRevenueYuan, 100.5);
  assert.equal(stats.todayNewUsers, 3);
  assert.equal(stats.todayCompletedJobs, 2);
  assert.equal(stats.avgE2eDurationSec, 12.5);
  assert.equal(stats.p50E2eDurationSec, 11);
  assert.equal(stats.p90E2eDurationSec, 22);
  assert.equal(stats.p99E2eDurationSec, 29);
  assert.equal(stats.avgLlmDurationSec, 1.8);
  assert.equal(stats.avgTtsDurationSec, 0.95);
  assert.equal(stats.avgFfmpegDurationSec, 7.2);
  assert.equal(stats.avgRendererDurationSec, 8.1);
  assert.equal(stats.totalJobs, 5);
  assert.equal(stats.failedJobs, 1);
  assert.equal(stats.directorTelemetryAvailable, true);
  assert.equal(stats.directorCalls, 10);
  assert.equal(stats.primaryModelSuccessRate, 70);
  assert.equal(stats.fallbackModelRate, 20);
  assert.equal(stats.heuristicFallbackRate, 10);
  assert.equal(stats.totalTokensUsed, 12000);
  assert.equal(stats.tokenUsageRecords, 9);
  assert.equal(stats.totalTtsChars, 2500);
  assert.equal(stats.qualityCheckedJobs, 8);
  assert.equal(stats.qualityPassedJobs, 7);
  assert.equal(stats.qualityPassRate, 87.5);
  assert.equal(stats.sceneScoreDataAvailable, false);
  assert.equal(stats.totalCostEstimateYuan, 20);
  assert.equal(stats.costDataAvailable, true);
  await app.close();
});

test("admin partner directory exposes direct and second-level referral and payout balances", async () => {
  const validToken = "p".repeat(43);
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async findUserById(id) { return id === testAdminUser.id ? testAdminUser : null; },
    async verifyPassword() { return null; },
    async createSession() {},
    async findSession() { return { user: testAdminUser, expiresAt: new Date(Date.now() + 60_000) }; },
    async deleteSession() {},
    async deleteUserSessions() {},
  };
  let sqlSeen = "";
  const pool = {
    async query(sql: string) {
      sqlSeen = sql;
      return { rows: [{
        user_id: testAdminUser.id, display_name: "合伙人A", phone: "13800001234", email: null,
        partner_province: "浙江", partner_city: "杭州", partner_activated_at: new Date("2026-11-01T00:00:00.000Z"),
        direct_invites: 8, second_level_invites: 12, pending_commission: "20.00",
        settled_commission: "180.00", reserved_withdrawal: "50.00",
        payout_verification_status: "verified", account_last4: "1234",
      }], rowCount: 1 };
    },
  } as unknown as Pool;
  const app = buildApp({
    allowedOrigins: ["http://localhost:3000"], logLevel: "silent", production: false,
    authStore, adminEmails: ["admin@jansee.com"], adminPool: pool,
  });
  const response = await app.inject({
    method: "GET", url: "/api/v1/admin/partners?limit=300",
    headers: { origin: "http://localhost:3000", cookie: `jansee_session=${validToken}` },
  });
  assert.equal(response.statusCode, 200);
  assert.match(sqlSeen, /partner_commissions/);
  assert.match(sqlSeen, /partner_withdrawals/);
  const partner = response.json().partners[0];
  assert.equal(partner.directInvites, 8);
  assert.equal(partner.secondLevelInvites, 12);
  assert.equal(partner.pendingCommissionYuan, 20);
  assert.equal(partner.withdrawableYuan, 130);
  assert.equal(partner.payoutVerificationStatus, "verified");
  await app.close();
});

test("admin withdrawal review and manual payout are transactional, audited and idempotent by status", async () => {
  const validToken = "w".repeat(43);
  const withdrawalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let status = "pending";
  let externalReference: string | null = null;
  const auditActions: string[] = [];
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async findUserById(id) { return id === testAdminUser.id ? testAdminUser : null; },
    async verifyPassword() { return null; },
    async createSession() {},
    async findSession() { return { user: testAdminUser, expiresAt: new Date(Date.now() + 60_000) }; },
    async deleteSession() {},
    async deleteUserSessions() {},
  };
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [], rowCount: null };
      if (normalized.startsWith("SELECT user_id, status, amount_yuan FROM partner_withdrawals")) {
        return { rows: [{ user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status, amount_yuan: "100.00" }], rowCount: 1 };
      }
      if (normalized.startsWith("SELECT user_id, status, net_amount_yuan FROM partner_withdrawals")) {
        return { rows: [{ user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status, net_amount_yuan: "98.00" }], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE partner_withdrawals SET status = $2")) {
        status = String(values[1]);
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE partner_withdrawals SET status = 'paid'")) {
        status = "paid";
        externalReference = String(values[1]);
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO partner_audit_events")) {
        auditActions.push(normalized);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = {
    async query(sql: string) {
      if (sql.includes("FROM partner_withdrawals w JOIN users")) {
        return { rows: [{
          id: withdrawalId, user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          display_name: "城市合伙人", phone: "13800001234", email: null,
          amount_yuan: "100.00", fee_yuan: "2.00", net_amount_yuan: "98.00",
          status, note: null, external_reference: externalReference, payout_channel: "alipay",
          payout_account_last4: "1234", created_at: new Date("2026-11-16T00:00:00.000Z"),
          processed_at: null, admin_user_id: null,
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() { return client; },
  } as unknown as Pool;
  const app = buildApp({
    allowedOrigins: ["http://localhost:3000"], logLevel: "silent", production: false,
    authStore, adminEmails: ["admin@jansee.com"], adminPool: pool,
  });
  const headers = { origin: "http://localhost:3000", cookie: `jansee_session=${validToken}`, "content-type": "application/json" };
  const list = await app.inject({ method: "GET", url: "/api/v1/admin/partner/withdrawals", headers });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().withdrawals[0].accountLast4, "1234");
  assert.equal("payoutAccount" in list.json().withdrawals[0], false);

  const review = await app.inject({
    method: "POST", url: `/api/v1/admin/partner/withdrawals/${withdrawalId}/review`,
    headers, payload: { status: "approved", note: "资料核验通过" },
  });
  assert.equal(review.statusCode, 200);
  assert.equal(status, "approved");

  const duplicateReview = await app.inject({
    method: "POST", url: `/api/v1/admin/partner/withdrawals/${withdrawalId}/review`,
    headers, payload: { status: "approved", note: "重复审核" },
  });
  assert.equal(duplicateReview.statusCode, 409);

  const paid = await app.inject({
    method: "POST", url: `/api/v1/admin/partner/withdrawals/${withdrawalId}/paid`,
    headers, payload: { externalReference: "ALIPAY-TRANSFER-20261116-001", note: "已核对到账" },
  });
  assert.equal(paid.statusCode, 200);
  assert.equal(status, "paid");
  assert.equal(externalReference, "ALIPAY-TRANSFER-20261116-001");

  const duplicatePaid = await app.inject({
    method: "POST", url: `/api/v1/admin/partner/withdrawals/${withdrawalId}/paid`,
    headers, payload: { externalReference: "ALIPAY-TRANSFER-20261116-001" },
  });
  assert.equal(duplicatePaid.statusCode, 409);
  assert.equal(auditActions.length, 2);
  await app.close();
});

test("admin manual refund registration is receipt-idempotent and never initiates a refund", async (t) => {
  const token = "r".repeat(43);
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); }, async findUserByEmail() { return null; },
    async findUserById(id) { return id === testAdminUser.id ? testAdminUser : null; }, async verifyPassword() { return null; },
    async createSession() {}, async findSession() { return { user: testAdminUser, expiresAt: new Date(Date.now() + 60_000) }; },
    async deleteSession() {}, async deleteUserSessions() {},
  };
  let refunded = 0; let duplicate = false;
  const client = { async query(sql: string, values: unknown[] = []) {
    const q = sql.replace(/\s+/g, " ").trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q)) return { rows: [], rowCount: 0 };
    if (q.startsWith("SELECT id, status, payment_provider")) return { rows: [{ id: "PAY-1730000000000-ABCD1234", status: "paid", payment_provider: "opcpay", provider_payment_status: "PAID", provider_price_yuan: 9.9, amount_yuan: 9.9, refunded_amount_yuan: refunded }], rowCount: 1 };
    if (q.startsWith("SELECT id FROM billing_order_refund_records")) return { rows: duplicate ? [{ id: "refund-1" }] : [], rowCount: duplicate ? 1 : 0 };
    if (q.startsWith("INSERT INTO billing_order_refund_records")) { duplicate = true; return { rows: [{ id: "refund-1" }], rowCount: 1 }; }
    if (q.startsWith("UPDATE billing_orders")) { refunded += Number(values[1]); return { rows: [{ refunded_amount_yuan: refunded, status: refunded >= 9.9 ? "refunded" : "paid" }], rowCount: 1 }; }
    throw new Error("Unexpected refund SQL: " + q);
  }, release() {} };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const app = buildApp({ allowedOrigins: ["http://localhost:5173"], logLevel: "silent", production: false, authStore, adminPool: pool, adminEmails: ["admin@jansee.com"] });
  t.after(async () => app.close());
  const headers = { origin: "http://localhost:5173", cookie: "jansee_session=" + token };
  const url = "/api/v1/admin/billing/orders/PAY-1730000000000-ABCD1234/refunds";
  const first = await app.inject({ method: "POST", url, headers, payload: { amountYuan: 4.9, externalReference: "ALI-REFUND-001", note: "人工退款已完成" } });
  assert.equal(first.statusCode, 200, JSON.stringify(first.json())); assert.equal(first.json().refundedAmountYuan, 4.9); assert.equal(first.json().remainingRevenueYuan, 5);
  const second = await app.inject({ method: "POST", url, headers, payload: { amountYuan: 4.9, externalReference: "ALI-REFUND-001", note: "重复请求" } });
  assert.equal(second.statusCode, 409); assert.equal(second.json().error.code, "REFUND_REFERENCE_DUPLICATE"); assert.equal(refunded, 4.9);
});

test("admin users endpoint aggregates real database records", { skip: !loadDatabaseUrl() }, async (t) => {
  const { Pool } = await import("pg");
  const { createPgAuthStore } = await import("../apps/api/src/auth-store.js");
  const { createHash, randomBytes } = await import("node:crypto");
  const pool = new Pool({ connectionString: loadDatabaseUrl()!, max: 1 });
  try {
    await pool.query("SELECT 1");
  } catch {
    t.skip("local database is not reachable");
    await pool.end();
    return;
  }
  const authStore = createPgAuthStore(pool);
  const app = buildApp({
    allowedOrigins: ["http://localhost:5173"], logLevel: "silent", production: false,
    authStore, adminPool: pool, adminPhones: ["15208316776"],
  });
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const admin = await pool.query(
    "SELECT id FROM users WHERE deleted_at IS NULL AND status = 'active' AND phone = '15208316776' LIMIT 1",
  );
  if (!admin.rows[0]) {
    t.skip("admin test account is not present in the database");
    await pool.end();
    await app.close();
    return;
  }
  await pool.query(
    "INSERT INTO auth_sessions (id, user_id, token_hash, user_agent, ip_hash, expires_at, last_seen_at, created_at) VALUES (gen_random_uuid(), $1, $2, 'test', 'test', now() + interval '10 minutes', now(), now())",
    [admin.rows[0].id, tokenHash],
  );
  try {
    // summary 保留含游客的全量口径（用于看流量）；名单 total 只数注册用户
    const expected = await pool.query(
      "SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS total, count(*) FILTER (WHERE deleted_at IS NULL AND (register_province IS NOT NULL OR register_city IS NOT NULL))::int AS geo_users FROM users",
    );
    const expectedRegistered = await pool.query(
      "SELECT count(*)::int AS total FROM users WHERE deleted_at IS NULL AND (coalesce(phone, '') <> '' OR coalesce(email, '') <> '')",
    );
    const expectedTotal = expected.rows[0].total;
    const expectedGeo = expected.rows[0].geo_users;

    const response = await app.inject({
      method: "GET", url: "/api/v1/admin/users?limit=50",
      headers: { origin: "http://localhost:5173", cookie: `jansee_session=${token}` },
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.summary.totalUsers, expectedTotal, "total users must equal the direct database count");
    assert.equal(data.summary.geoUsers, expectedGeo, "geo users must equal the direct database count");
    assert.equal(data.summary.unknownRegionUsers, expectedTotal - expectedGeo);
    assert.equal(data.trend.length, 30);
    assert.equal(data.total, expectedRegistered.rows[0].total, "directory total must count registered users only");
    assert.ok(Array.isArray(data.regions));
    assert.ok(Array.isArray(data.users) && data.users.length > 0, "user directory must list at least the admin account");
    for (const row of data.users) {
      assert.match(row.contact, /\*/, "admin directory contacts must be masked");
    }
    // 搜索游客默认昵称应当一条也搜不到
    const guestSearch = await app.inject({
      method: "GET", url: `/api/v1/admin/users?limit=50&keyword=${encodeURIComponent("访客体验用户")}`,
      headers: { origin: "http://localhost:5173", cookie: `jansee_session=${token}` },
    });
    assert.equal(guestSearch.statusCode, 200);
    assert.equal(guestSearch.json().total, 0, "guest accounts must be excluded from the member directory");
    assert.equal(guestSearch.json().users.length, 0);
    const denied = await app.inject({ method: "GET", url: "/api/v1/admin/users?limit=50", headers: { origin: "http://localhost:5173" } });
    assert.equal(denied.statusCode, 401);
  } finally {
    await pool.query("DELETE FROM auth_sessions WHERE token_hash = $1", [tokenHash]);
    await pool.end();
    await app.close();
  }
});

test("only the member directory query filters out guests; traffic metrics keep all accounts", async () => {
  const validToken = "g".repeat(43);
  const adminUser: AuthUser = { ...testAdminUser, email: "admin@jansee.com" };
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async findUserById(id) { return id === adminUser.id ? adminUser : null; },
    async verifyPassword() { return null; },
    async createSession() {},
    async findSession() { return { user: adminUser, expiresAt: new Date(Date.now() + 3600_000) }; },
    async deleteSession() {},
    async deleteUserSessions() {},
  };
  const userQueries: string[] = [];
  const pool = {
    async query(sql: string) {
      if (sql.includes("FROM users")) userQueries.push(sql);
      if (sql.includes("variant_hit_rate")) return { rows: [{}], rowCount: 1 }; // overview
      if (sql.includes("generate_series")) return { rows: [], rowCount: 0 };     // trend
      if (sql.includes("AS total_users")) {
        return { rows: [{ total_users: 2, active_users: 2, today_new_users: 1, last_7_days: 2, last_30_days: 2, geo_users: 1 }], rowCount: 1 };
      }
      if (sql.includes("count(*)::text AS total")) return { rows: [{ total: "2" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const app = buildApp({
    allowedOrigins: ["http://localhost:3000"], logLevel: "silent", production: false,
    authStore, adminPool: pool, adminEmails: ["admin@jansee.com"],
  });
  const headers = { origin: "http://localhost:3000", cookie: `jansee_session=${validToken}` };
  try {
    const directory = await app.inject({ method: "GET", url: "/api/v1/admin/users", headers });
    assert.equal(directory.statusCode, 200);
    const overview = await app.inject({ method: "GET", url: "/api/v1/admin/overview", headers });
    assert.equal(overview.statusCode, 200);

    assert.equal(userQueries.length, 6, `expected 6 user queries, got ${userQueries.length}`);
    const guestFilter = /coalesce\((?:u\.)?phone,\s*''\)\s*<>\s*''\s*OR\s*coalesce\((?:u\.)?email,\s*''\)\s*<>\s*''/;
    // 只有 MEMBERS 名单本体（LEFT JOIN wallets）和它的分页计数要排除游客
    const filtered = userQueries.filter((sql) => guestFilter.test(sql));
    assert.equal(filtered.length, 2, `only directory list and its count should filter guests, got ${filtered.length}`);
    assert.ok(filtered.some((sql) => sql.includes("LEFT JOIN wallets")));
    assert.ok(filtered.some((sql) => sql.includes("count(*)::text AS total")));
    // 统计卡片 / 增长曲线 / 地区分布 / 总览保持含游客口径
    const unfiltered = userQueries.filter((sql) => !guestFilter.test(sql));
    assert.ok(unfiltered.some((sql) => sql.includes("AS total_users")));
    assert.ok(unfiltered.some((sql) => sql.includes("generate_series")));
    assert.ok(unfiltered.some((sql) => sql.includes("json_agg")));
    assert.ok(unfiltered.some((sql) => sql.includes("variant_hit_rate")));
  } finally { await app.close(); }
});
