import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryBillingStore, GENERATION_COST_CREDITS } from "../apps/api/src/billing.js";
import { buildApp } from "../apps/api/src/app.js";
import type { AuthStore, AuthUser } from "../apps/api/src/auth.js";
import type { AssetStore, AssetRecord } from "../apps/api/src/assets.js";
import type { JobStore, GenerationJobRecord } from "../apps/api/src/jobs.js";
import type { OutputStore } from "../apps/api/src/outputs.js";
import { processJob } from "../apps/api/src/worker.js";
import type { MediaRenderer } from "../apps/api/src/renderer.js";

const testUser: AuthUser = {
  id: "44444444-4444-4444-8444-444444444444",
  email: "billing-tester@example.com",
  displayName: "Billing Tester",
  createdAt: new Date().toISOString(),
};

test("manual job compensation is idempotent for a given job", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  await store.grantCredits(testUser.id, 200, "人工补偿", "job-compensate-once");
  await store.grantCredits(testUser.id, 200, "人工补偿重复请求", "job-compensate-once");
  const wallet = await store.getWallet(testUser.id);
  assert.equal(wallet.availableCredits, 200);
  const compensationEntries = (await store.getLedger(testUser.id)).filter((entry) => entry.type === "compensation");
  assert.equal(compensationEntries.length, 1);
});

test("credit adjustment moves the wallet in both directions and writes audit ledger entries", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 1000 });
  const topped = await store.adjustCredits!(testUser.id, 500, "管理员手工充值");
  assert.equal(topped.availableCredits, 1500);
  const deducted = await store.adjustCredits!(testUser.id, -300, "管理员误扣更正");
  assert.equal(deducted.availableCredits, 1200);

  const adjustEntries = (await store.getLedger(testUser.id)).filter((entry) => entry.type === "adjust");
  assert.deepEqual(adjustEntries.map((entry) => entry.amount), [500, -300]);
  assert.ok(adjustEntries.every((entry) => entry.description.includes("管理员")));

  await assert.rejects(() => store.adjustCredits!(testUser.id, -999_999, "超额扣减"), /积分不足/);
  await assert.rejects(() => store.adjustCredits!(testUser.id, 0, "无效数量"), /不为 0 的整数/);
  await assert.rejects(() => store.adjustCredits!(testUser.id, 1.5, "非整数"), /不为 0 的整数/);
});

test("billing store initializes wallet with default grant and tracks two-phase credit lifecycle", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 1000 });
  const wallet = await store.getWallet(testUser.id);
  assert.equal(wallet.availableCredits, 1000);
  assert.equal(wallet.frozenCredits, 0);

  // 1. 冻结 200 积分
  const held = await store.holdCredits(testUser.id, "job-1", GENERATION_COST_CREDITS);
  assert.equal(held.availableCredits, 800);
  assert.equal(held.frozenCredits, 200);

  // 2. 成片成功结转扣款
  const settled = await store.settleCredits(testUser.id, "job-1");
  assert.equal(settled.availableCredits, 800);
  assert.equal(settled.frozenCredits, 0);
  assert.equal(settled.totalSpentCredits, 200);

  // 3. 失败时自动退回
  await store.holdCredits(testUser.id, "job-2", GENERATION_COST_CREDITS);
  const refunded = await store.refundCredits(testUser.id, "job-2");
  assert.equal(refunded.availableCredits, 800);
  assert.equal(refunded.frozenCredits, 0);

  const ledgers = await store.getLedger(testUser.id);
  assert.ok(ledgers.length >= 4);
});

test("job creation rejects requests when available credits are insufficient", async () => {
  const billingStore = new InMemoryBillingStore({ initialGrant: 100 }); // 少于 200 积分
  const validToken = "c".repeat(43);
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async createSession() { },
    async findSession() {
      return { user: testUser, expiresAt: new Date(Date.now() + 60_000) };
    },
    async revokeSession() { },
  };
  const assetRecord: AssetRecord = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    userId: testUser.id,
    mediaType: "image",
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    sha256Hex: "abcd",
    storageKey: "users/u1/assets/a1.jpg",
    status: "ready",
    originalName: "test.jpg",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  };
  const assetStore: AssetStore = {
    async createAsset() { return assetRecord; },
    async findAssetById() { return assetRecord; },
    async findUserAssets() { return [assetRecord, { ...assetRecord, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }]; },
    async markAssetDeleted() { return true; },
  };
  const jobStore: JobStore = {
    async createJob() { throw new Error("Should not be called"); },
    async findJobById() { return null; },
  };

  const app = buildApp({
    allowedOrigins: ["http://localhost:5173"],
    logLevel: "silent",
    production: false,
    authStore,
    assetStore,
    jobStore,
    billingStore,
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/jobs",
    headers: {
      origin: "http://localhost:5173",
      cookie: `jansee_session=${validToken}`,
    },
    payload: {
      mode: "image-film",
      prompt: "短视频带货",
      aspectRatio: "9:16",
      assetIds: [assetRecord.id, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    },
  });

  assert.equal(res.statusCode, 402);
  const data = res.json();
  assert.equal(data.error?.code, "INSUFFICIENT_CREDITS");
});

test("worker pipeline settles credits on completion and refunds on failure", async () => {
  const billingStore = new InMemoryBillingStore({ initialGrant: 1000 });
  await billingStore.holdCredits(testUser.id, "job-success", GENERATION_COST_CREDITS);
  await billingStore.holdCredits(testUser.id, "job-fail", GENERATION_COST_CREDITS);

  let statusHistory: string[] = [];
  const jobStore: JobStore = {
    async createJob() { throw new Error("not implemented"); },
    async findJobById() { return null; },
    async updateJobStatus(_userId, _jobId, toStatus) {
      statusHistory.push(toStatus);
      return null;
    },
  };
  const assetStore: AssetStore = {
    async createAsset() { throw new Error("not implemented"); },
    async findAssetById() { return null; },
    async findUserAssets() {
      return [{
        id: "a1", userId: testUser.id, mediaType: "image", mimeType: "image/jpeg",
        sizeBytes: 100, sha256Hex: "1", storageKey: "k", status: "ready", originalName: "o",
        createdAt: new Date(), expiresAt: new Date(),
      }];
    },
    async markAssetDeleted() { return true; },
  };
  const outputStore: OutputStore = {
    async createOutput() { return {} as any; },
    async findOutputsByUserId() { return []; },
    async findOutputById() { return null; },
  };

  const successRenderer: MediaRenderer = {
    async render() {
      return {
        storageKey: "out.mp4", mimeType: "video/mp4", sizeBytes: 1024, durationMs: 10000, width: 1080, height: 1920,
      };
    },
  };

  const jobRecord: GenerationJobRecord = {
    id: "job-success",
    userId: testUser.id,
    mode: "image-film",
    status: "queued",
    prompt: "测试带货",
    aspectRatio: "9:16",
    idempotencyKey: "k1",
    requestPayload: {},
    directorPlan: { bgm_emotion: "warm" },
    progress: 0,
    errorCode: null,
    errorMessage: null,
    queuedAt: new Date(),
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    assetIds: ["a1"],
  };

  // 执行成功用例
  const ok = await processJob(jobRecord, {
    storage: {} as any,
    renderer: successRenderer,
    jobStore,
    assetStore,
    outputStore,
    billingStore,
  });
  assert.equal(ok, true);
  const w1 = await billingStore.getWallet(testUser.id);
  assert.equal(w1.frozenCredits, 200); // job-fail 还在冻结
  assert.equal(w1.totalSpentCredits, 200); // job-success 已实扣

  // 执行失败用例
  const failRenderer: MediaRenderer = {
    async render() {
      throw new Error("FFmpeg timeout error");
    },
  };
  const ok2 = await processJob({ ...jobRecord, id: "job-fail" }, {
    storage: {} as any,
    renderer: failRenderer,
    jobStore,
    assetStore,
    outputStore,
    billingStore,
  });
  assert.equal(ok2, false);
  const w2 = await billingStore.getWallet(testUser.id);
  assert.equal(w2.frozenCredits, 0); // 失败已解冻返还
  assert.equal(w2.availableCredits, 800); // 1000 - 200(实扣) + (200冻结返还) = 800
});

test("billing endpoints support packages listing, checkout, simulate-pay and pricing", async () => {
  const billingStore = new InMemoryBillingStore({ initialGrant: 1000 });
  const validToken = "c".repeat(43);
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async createSession() { },
    async findSession() {
      return { user: testUser, expiresAt: new Date(Date.now() + 60_000) };
    },
    async revokeSession() { },
  };

  const app = buildApp({
    allowedOrigins: ["http://localhost:5173"],
    logLevel: "silent",
    production: false,
    authStore,
    billingStore,
    allowPaymentSimulation: true,
  });

  // 1. 获取套餐列表
  const pkgRes = await app.inject({ method: "GET", url: "/api/v1/billing/packages" });
  assert.equal(pkgRes.statusCode, 200);
  const pkgs = pkgRes.json().packages;
  assert.equal(pkgs.length, 5);

  // 2. 下单购买加油包
  const orderRes = await app.inject({
    method: "POST",
    url: "/api/v1/billing/orders",
    headers: { origin: "http://localhost:5173", cookie: `jansee_session=${validToken}` },
    payload: { packageId: "boost_small" },
  });
  assert.equal(orderRes.statusCode, 201);
  const orderId = orderRes.json().order.id;
  assert.ok(orderId);

  // 3. 模拟支付完成
  const payRes = await app.inject({
    method: "POST",
    url: `/api/v1/billing/orders/${orderId}/simulate`,
    headers: { origin: "http://localhost:5173", cookie: `jansee_session=${validToken}` },
  });
  assert.equal(payRes.statusCode, 200);
  assert.equal(payRes.json().wallet.availableCredits, 2000); // 1000 + 1000 = 2000
  // 4. 订单与积分流水必须来自当前登录用户的持久化账本
  const ordersRes = await app.inject({ method: "GET", url: "/api/v1/billing/orders", headers: { cookie: `jansee_session=${validToken}` } });
  assert.equal(ordersRes.statusCode, 200);
  assert.equal(ordersRes.json().orders.length, 1);
  assert.equal(ordersRes.json().orders[0].id, orderId);
  const ledgerRes = await app.inject({ method: "GET", url: "/api/v1/billing/ledger", headers: { cookie: `jansee_session=${validToken}` } });
  assert.equal(ledgerRes.statusCode, 200);
  assert.ok(ledgerRes.json().entries.some((entry: { orderId?: string; type: string }) => entry.orderId === orderId && entry.type === "recharge"));
  const unauthOrders = await app.inject({ method: "GET", url: "/api/v1/billing/orders" });
  const unauthLedger = await app.inject({ method: "GET", url: "/api/v1/billing/ledger" });
  assert.equal(unauthOrders.statusCode, 401);
  assert.equal(unauthLedger.statusCode, 401);

  // 4. 验证 /api/v1/pricing 包含 4 档会员与 1 个加油包
  const pricingRes = await app.inject({ method: "GET", url: "/api/v1/pricing" });
  assert.equal(pricingRes.statusCode, 200);
  const pricingData = pricingRes.json();
  assert.equal(pricingData.members.length, 4);
  assert.equal(pricingData.boostPacks.length, 1);
  assert.deepEqual(
    pricingData.members.map((m: { id: string }) => m.id),
    ["lite", "plus", "pro", "ultra"]
  );
  assert.equal(pricingData.boostPacks[0].id, "boost_small");
  assert.equal(pricingData.boostPacks[0].priceYuan, 9.9);
  await app.close();

  const productionApp = buildApp({
    allowedOrigins: ["http://localhost:5173"],
    logLevel: "silent",
    production: true,
    authStore,
    billingStore,
  });
  const blockedSimulation = await productionApp.inject({
    method: "POST",
    url: `/api/v1/billing/orders/${orderId}/simulate`,
    headers: { origin: "http://localhost:5173", cookie: `jansee_session=${validToken}` },
  });
  assert.equal(blockedSimulation.statusCode, 404);
  const blockedProductionOrder = await productionApp.inject({
    method: "POST",
    url: "/api/v1/billing/orders",
    headers: { origin: "http://localhost:5173", cookie: `jansee_session=${validToken}` },
    payload: { packageId: "boost_small" },
  });
  assert.equal(blockedProductionOrder.statusCode, 503);
  assert.equal(blockedProductionOrder.json().error.code, "PAYMENT_PROVIDER_NOT_CONFIGURED");
  await productionApp.close();
});


test("development payment simulation cannot fulfill another user's order", async (t) => {
  const billingStore = new InMemoryBillingStore({ initialGrant: 1000 });
  const owner: AuthUser = {
    id: "55555555-5555-4555-8555-555555555555",
    email: "order-owner@example.com",
    displayName: "Order Owner",
    createdAt: new Date().toISOString(),
  };
  const attackerToken = "x".repeat(43);
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async createSession() {},
    async findSession(hash) {
      return hash === createHash("sha256").update(attackerToken).digest("hex")
        ? { user: testUser, expiresAt: new Date(Date.now() + 60_000) }
        : null;
    },
    async revokeSession() {},
  };
  const order = await billingStore.createOrder(owner.id, "boost_small");
  const before = await billingStore.getWallet(owner.id);
  const app = buildApp({
    allowedOrigins: ["http://localhost:5173"],
    logLevel: "silent",
    production: false,
    authStore,
    billingStore,
    allowPaymentSimulation: true,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: `/api/v1/billing/orders/${order.id}/simulate`,
    headers: { origin: "http://localhost:5173", cookie: `jansee_session=${attackerToken}` },
  });

  assert.equal(response.statusCode, 404);
  assert.equal((await billingStore.findOrderById(order.id))?.status, "pending");
  assert.deepEqual(await billingStore.getWallet(owner.id), before);
});

test("billing history endpoints isolate orders and ledger entries by authenticated user", async () => {
  const billingStore = new InMemoryBillingStore({ initialGrant: 0 });
  const secondUser: AuthUser = { ...testUser, id: "55555555-5555-4555-8555-555555555555" };
  const tokenA = "c".repeat(43);
  const tokenB = "d".repeat(43);
  const hashA = createHash("sha256").update(tokenA).digest("hex");
  const hashB = createHash("sha256").update(tokenB).digest("hex");
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async createSession() {},
    async findSession(tokenHash) {
      const user = tokenHash === hashA ? testUser : tokenHash === hashB ? secondUser : null;
      return user ? { user, expiresAt: new Date(Date.now() + 60_000) } : null;
    },
    async revokeSession() {},
  };

  const orderA = await billingStore.createOrder(testUser.id, "boost_small");
  const orderB = await billingStore.createOrder(secondUser.id, "boost_small");
  await billingStore.grantCredits(testUser.id, 31, "用户 A 的测试流水");
  await billingStore.grantCredits(secondUser.id, 47, "用户 B 的测试流水");

  const app = buildApp({
    allowedOrigins: ["http://localhost:5173"],
    logLevel: "silent",
    production: false,
    authStore,
    billingStore,
  });

  const ordersA = await app.inject({ method: "GET", url: "/api/v1/billing/orders", headers: { cookie: `jansee_session=${tokenA}` } });
  const ordersB = await app.inject({ method: "GET", url: "/api/v1/billing/orders", headers: { cookie: `jansee_session=${tokenB}` } });
  assert.deepEqual(ordersA.json().orders.map((order: { id: string }) => order.id), [orderA.id]);
  assert.deepEqual(ordersB.json().orders.map((order: { id: string }) => order.id), [orderB.id]);

  const ledgerA = await app.inject({ method: "GET", url: "/api/v1/billing/ledger", headers: { cookie: `jansee_session=${tokenA}` } });
  const ledgerB = await app.inject({ method: "GET", url: "/api/v1/billing/ledger", headers: { cookie: `jansee_session=${tokenB}` } });
  assert.ok(ledgerA.json().entries.some((entry: { description: string }) => entry.description === "用户 A 的测试流水"));
  assert.ok(!ledgerA.json().entries.some((entry: { description: string }) => entry.description === "用户 B 的测试流水"));
  assert.ok(ledgerB.json().entries.some((entry: { description: string }) => entry.description === "用户 B 的测试流水"));
  assert.ok(!ledgerB.json().entries.some((entry: { description: string }) => entry.description === "用户 A 的测试流水"));

  await app.close();
});

test("billing history endpoints return a controlled service error when the store fails", async () => {
  const token = "e".repeat(43);
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async createSession() {},
    async findSession(hash) { return hash === tokenHash ? { user: testUser, expiresAt: new Date(Date.now() + 60_000) } : null; },
    async revokeSession() {},
  };
  const baseStore = new InMemoryBillingStore({ initialGrant: 0 });
  const failingStore = new Proxy(baseStore, {
    get(target, property) {
      if (property === "listUserOrders" || property === "getLedger") return async () => { throw new Error("database unavailable"); };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const app = buildApp({ allowedOrigins: [], logLevel: "silent", production: false, authStore, billingStore: failingStore });

  const orders = await app.inject({ method: "GET", url: "/api/v1/billing/orders", headers: { cookie: `jansee_session=${token}` } });
  const ledger = await app.inject({ method: "GET", url: "/api/v1/billing/ledger", headers: { cookie: `jansee_session=${token}` } });
  assert.equal(orders.statusCode, 503);
  assert.equal(orders.json().error.code, "BILLING_HISTORY_UNAVAILABLE");
  assert.equal(ledger.statusCode, 503);
  assert.equal(ledger.json().error.code, "BILLING_HISTORY_UNAVAILABLE");
  await app.close();
});


test("public package catalogs work without auth or a database", async () => {
  const app = buildApp({
    allowedOrigins: [],
    logLevel: "silent",
    production: false,
    billingStore: new InMemoryBillingStore(),
  });
  const packages = await app.inject({ method: "GET", url: "/api/v1/billing/packages" });
  assert.equal(packages.statusCode, 200);
  assert.ok(Array.isArray(packages.json().packages));
  assert.ok(packages.json().packages.length > 0);
  const pricing = await app.inject({ method: "GET", url: "/api/v1/pricing" });
  assert.equal(pricing.statusCode, 200);
  assert.ok(Array.isArray(pricing.json().members));
  await app.close();
});


test("payment status GET is read-only; provider reconciliation requires same-origin POST", async (t) => {
  const billingStore = new InMemoryBillingStore({ initialGrant: 0 });
  const token = "p".repeat(43);
  const order = await billingStore.createOrder(testUser.id, "boost_small");
  let reconcileCalls = 0;
  const authStore: AuthStore = {
    async createUser() { throw new Error("not implemented"); },
    async findUserByEmail() { return null; },
    async createSession() {},
    async findSession() { return { user: testUser, expiresAt: new Date(Date.now() + 60_000) }; },
    async revokeSession() {},
  };
  const paymentProvider = {
    isReady: true,
    async reconcileOrder() { reconcileCalls += 1; return { paid: false, pending: true }; },
  } as any;
  const app = buildApp({
    allowedOrigins: ["http://localhost:5173"],
    logLevel: "silent",
    production: false,
    authStore,
    billingStore,
    paymentProvider,
  });
  t.after(async () => app.close());
  const headers = { cookie: `jansee_session=${token}` };

  const readOnly = await app.inject({ method: "GET", url: `/api/v1/billing/orders/${order.id}/status`, headers });
  assert.equal(readOnly.statusCode, 200);
  assert.equal(readOnly.json().order.status, "pending");
  assert.equal(reconcileCalls, 0, "GET must never consume provider entitlements or fulfill orders");

  const foreignOrigin = await app.inject({
    method: "POST",
    url: `/api/v1/billing/orders/${order.id}/reconcile`,
    headers: { ...headers, origin: "https://attacker.example" },
    payload: {},
  });
  assert.equal(foreignOrigin.statusCode, 403);
  assert.equal(reconcileCalls, 0);

  const noOrigin = await app.inject({
    method: "POST",
    url: `/api/v1/billing/orders/${order.id}/reconcile`,
    headers,
    payload: {},
  });
  assert.equal(noOrigin.statusCode, 403);
  assert.equal(reconcileCalls, 0);

  const accepted = await app.inject({
    method: "POST",
    url: `/api/v1/billing/orders/${order.id}/reconcile`,
    headers: { ...headers, origin: "http://localhost:5173" },
    payload: {},
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(reconcileCalls, 1);
});
