import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { InMemoryBillingStore } from "../apps/api/src/billing.js";
import { OpcpayService, type OpcpayServiceOptions } from "../apps/api/src/opcpay.js";

type FakeClient = NonNullable<OpcpayServiceOptions["client"]>;

function createFakeClient(options: {
  displayName?: string;
  skuId?: string;
  price?: number;
  quotaAmount?: number;
  quotaUnit?: "COUNT" | "POINT";
  remaining?: number;
  baseline?: number;
  transactionStatus?: "PAID" | "PENDING" | "REFUNDED" | "UNKNOWN";
  transactionSource?: string;
  transactionTradeNo?: string | null;
  transactionCheckedAt?: string | null;
  purchaseSkuId?: string;
  consumeStatus?: "SUCCEEDED" | "PROCESSING" | "UNKNOWN" | "FAILED";
  consumeConfirmed?: boolean;
  consumeAmount?: number;
  consumeUnit?: "COUNT" | "POINT";
  consumeIdempotencyKey?: string;
  previousConsumption?: {
    status: "SUCCEEDED";
    confirmed: boolean;
    idempotency_key: string;
    consumed?: number;
    quota_unit?: "COUNT" | "POINT";
  };
} = {}) {
  let consumeCalls = 0;
  let accessCalls = 0;
  const baseline = options.baseline ?? 0;
  const quotaUnit = options.quotaUnit ?? "COUNT";
  const quotaAmount = options.quotaAmount ?? 5;
  const skuId = options.skuId ?? "sku-boost";
  const client = {
    async capabilities() {
      return {
        api_version: "1.0",
        provider_configured: true,
        capabilities: {
          purchase_entry: true,
          entitlement_query: true,
          consumption: true,
          purchase_request_query: true,
          transaction_query: true,
          refund: false,
        },
        webhook_events: ["entitlement.updated"],
        limitations: [],
      };
    },
    async product() {
      return {
        product_id: "jansee-v4",
        product_name: "简兮 JANSEE",
        capability_status: "ENABLED",
        pricing_model: "QUANTITY",
        charging_options: [
          { id: "lite", sku_id: "sku-lite", display_name: "Lite", price: "41.00", quota_amount: 38 },
          { id: "plus", sku_id: "sku-plus", display_name: "Plus", price: "119.00", quota_amount: 124 },
          { id: "pro", sku_id: "sku-pro", display_name: "Pro", price: "299.00", quota_amount: 333 },
          { id: "ultra", sku_id: "sku-ultra", display_name: "Ultra", price: "599.00", quota_amount: 769 },
          { id: "boost_small", sku_id: "sku-boost", display_name: "小加油包", price: "9.90", quota_amount: 5 },
        ].map((item) => {
          const targetId = (options.displayName ?? "boost_small").toLowerCase().includes("lite") ? "lite" : "boost_small";
          const isTarget = item.id === targetId;
          return {
            sku_id: isTarget ? skuId : item.sku_id,
            plan_id: "plan-" + (isTarget ? skuId : item.sku_id),
            display_name: isTarget ? (options.displayName ?? item.display_name) : item.display_name,
            billing_mode: "QUANTITY" as const,
            price: isTarget ? String(options.price ?? Number(item.price)) : item.price,
            currency: "CNY",
            price_version: 1,
            entitlement_rule: "QUOTA" as const,
            quota_unit: isTarget ? quotaUnit : "COUNT" as const,
            quota_amount: isTarget ? quotaAmount : item.quota_amount,
          };
        }),
      };
    },
    async purchase({ userId, idempotencyKey, skuId: requestedSku }: { userId: string; idempotencyKey: string; skuId: string }) {
      return {
        status: "READY",
        user_id: userId,
        idempotency_key: idempotencyKey,
        sku_id: requestedSku,
        purchase_url: "https://ai6666.com/pay/jansee-test",
        purchase_qr_code: "https://mobilecodec.alipay.com/show.htm?code=jansee-test",
        expire_time: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      };
    },
    async purchaseQuery(userId: string, idempotencyKey: string) {
      return {
        user_id: userId,
        idempotency_key: idempotencyKey,
        sku_id: options.purchaseSkuId ?? skuId,
        response: {
          purchase_url: "https://ai6666.com/pay/jansee-test",
          purchase_qr_code: "https://mobilecodec.alipay.com/show.htm?code=jansee-test",
        },
      };
    },
    async transactionQuery(input: { user_id: string; idempotency_key: string }) {
      return {
        user_id: input.user_id,
        idempotency_key: input.idempotency_key,
        status: options.transactionStatus ?? "PAID",
        trade_no: options.transactionTradeNo === undefined ? (options.transactionStatus === "PENDING" || options.transactionStatus === "UNKNOWN" ? null : "202611180000000000000001") : options.transactionTradeNo,
        checked_at: options.transactionCheckedAt === undefined ? (options.transactionStatus === "UNKNOWN" ? null : new Date().toISOString()) : options.transactionCheckedAt,
        status_source: options.transactionSource ?? "ALIPAY_PURCHASE_QUERY_V3",
      };
    },
    async access() {
      accessCalls += 1;
      return {
        access_granted: true,
        quota_unit: quotaUnit,
        remaining: accessCalls === 1 ? baseline : (options.remaining ?? baseline + quotaAmount),
      };
    },
    async consumption() {
      if (options.previousConsumption) return options.previousConsumption;
      throw new Error("consumption not found");
    },
    async consume(input: { idempotencyKey: string }) {
      consumeCalls += 1;
      return {
        status: options.consumeStatus ?? "SUCCEEDED",
        confirmed: options.consumeConfirmed ?? true,
        idempotency_key: options.consumeIdempotencyKey ?? input.idempotencyKey,
        consumed: options.consumeAmount ?? quotaAmount,
        quota_unit: options.consumeUnit ?? quotaUnit,
      };
    },
  } as unknown as FakeClient;
  return { client, getConsumeCalls: () => consumeCalls };
}

function createService(store: InMemoryBillingStore, client: FakeClient) {
  return new OpcpayService({
    client,
    webhookSecret: "test-webhook-secret",
    billingStore: store,
  });
}

test("OPCPAY checkout persists the provider SKU, quota mapping, pay URL and QR payload", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const order = await store.createOrder("user-test", "boost_small");
  const fake = createFakeClient();
  const service = createService(store, fake.client);

  assert.equal(await service.initialize(), true);
  const checkout = await service.createCheckout("user-test", order);

  assert.equal(checkout.order.paymentProvider, "opcpay");
  assert.equal(checkout.order.providerSkuId, "sku-boost");
  assert.equal(checkout.order.providerQuotaAmount, 5);
  assert.equal(checkout.order.providerQuotaUnit, "COUNT");
  assert.equal(checkout.order.providerQuotaBaseline, 0);
  assert.equal(checkout.payUrl, "https://ai6666.com/pay/jansee-test");
  assert.equal(checkout.qrImageUrl, "https://mobilecodec.alipay.com/show.htm?code=jansee-test");
  const stored = await store.findOrderById(order.id);
  assert.equal(stored?.payUrl, checkout.payUrl);
  assert.equal(stored?.qrPayload, checkout.qrImageUrl, "the original Alipay QR image URL must be persisted");
});

test("OPCPAY recovers the direct Alipay QR for legacy pending orders that stored the hosted payment URL", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const order = await store.createOrder("user-test", "boost_small");
  const service = createService(store, createFakeClient().client);
  await service.initialize();
  const firstCheckout = await service.createCheckout("user-test", order);

  const findOrderById = store.findOrderById.bind(store);
  store.findOrderById = async (orderId) => {
    const current = await findOrderById(orderId);
    return current?.id === order.id ? { ...current, qrPayload: current.payUrl } : current;
  };

  const resumed = await service.createCheckout("user-test", order);
  assert.equal(resumed.payUrl, firstCheckout.payUrl);
  assert.equal(resumed.qrImageUrl, "https://mobilecodec.alipay.com/show.htm?code=jansee-test");
});

test("OPCPAY payment is fulfilled only after idempotent quota consumption is confirmed", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const order = await store.createOrder("user-test", "boost_small");
  const fake = createFakeClient();
  const service = createService(store, fake.client);
  await service.initialize();
  await service.createCheckout("user-test", order);

  const result = await service.reconcileOrder("user-test", order.id);
  const wallet = await store.getWallet("user-test");

  assert.equal(result.paid, true);
  assert.equal(wallet.availableCredits, 1000);
  assert.equal(fake.getConsumeCalls(), 1);
  assert.equal((await store.findOrderById(order.id))?.status, "paid");
});

test("OPCPAY PAID status is not persisted when the exact purchase record SKU does not match", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const order = await store.createOrder("user-test", "boost_small");
  const fake = createFakeClient({ transactionStatus: "PAID", purchaseSkuId: "sku-another-product" });
  const service = createService(store, fake.client);
  await service.initialize(); await service.createCheckout("user-test", order);
  const result = await service.reconcileOrder("user-test", order.id);
  const saved = await store.findOrderById(order.id);
  assert.equal(result.paid, false); assert.equal(saved?.providerPaymentStatus, undefined, "mismatched SKU must not persist a paid status");
  assert.equal(saved?.status, "pending"); assert.equal(fake.getConsumeCalls(), 0);
  assert.equal((await store.getWallet("user-test")).availableCredits, 0);
});

test("OPCPAY PAID status without a trusted source, trade number or checked timestamp is not counted", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const order = await store.createOrder("user-test", "boost_small");
  const fake = createFakeClient({ transactionStatus: "PAID", transactionSource: "UNVERIFIED_SOURCE" });
  const service = createService(store, fake.client);
  await service.initialize(); await service.createCheckout("user-test", order);
  const result = await service.reconcileOrder("user-test", order.id);
  assert.equal(result.paid, false); assert.equal((await store.findOrderById(order.id))?.providerPaymentStatus, "UNKNOWN");
  assert.equal(fake.getConsumeCalls(), 0);
});

test("a late OPCPAY-confirmed payment can still fulfill an order after local expiry closed it", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const order = await store.createOrder("user-test", "boost_small");
  const fake = createFakeClient(); const service = createService(store, fake.client);
  await service.initialize(); await service.createCheckout("user-test", order);
  await store.closeExpiredProviderOrders("user-test", new Date(Date.now() + 31 * 60 * 1000));
  assert.equal((await store.findOrderById(order.id))?.status, "closed");
  const result = await service.reconcileOrder("user-test", order.id);
  assert.equal(result.paid, true); assert.equal((await store.findOrderById(order.id))?.status, "paid");
  assert.equal((await store.getWallet("user-test")).availableCredits, 1000);
});

test("OPCPAY quota increases and confirmed consumption cannot fulfill an order while the transaction is PENDING", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const order = await store.createOrder("user-test", "boost_small");
  const fake = createFakeClient({ transactionStatus: "PENDING" });
  const service = createService(store, fake.client);
  await service.initialize();
  await service.createCheckout("user-test", order);

  const result = await service.reconcileOrder("user-test", order.id);

  assert.equal(result.paid, false);
  assert.equal((await store.findOrderById(order.id))?.status, "pending");
  assert.equal((await store.getWallet("user-test")).availableCredits, 0);
  assert.equal(fake.getConsumeCalls(), 0);
});

test("OPCPAY REFUNDED transaction never grants credits", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const order = await store.createOrder("user-test", "boost_small");
  const fake = createFakeClient({ transactionStatus: "REFUNDED" });
  const service = createService(store, fake.client);
  await service.initialize();
  await service.createCheckout("user-test", order);

  const result = await service.reconcileOrder("user-test", order.id);

  assert.equal(result.paid, false);
  assert.equal((await store.findOrderById(order.id))?.status, "refunded");
  assert.equal((await store.findOrderById(order.id))?.refundedAmountYuan, 9.9);
  assert.equal((await store.getWallet("user-test")).availableCredits, 0);
  assert.equal(fake.getConsumeCalls(), 0);
});

test("unknown or unconfirmed OPCPAY consumption never grants credits", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const order = await store.createOrder("user-test", "boost_small");
  const fake = createFakeClient({ consumeStatus: "UNKNOWN", consumeConfirmed: false });
  const service = createService(store, fake.client);
  await service.initialize();
  await service.createCheckout("user-test", order);

  const result = await service.reconcileOrder("user-test", order.id);

  assert.equal(result.paid, false);
  assert.equal((await store.findOrderById(order.id))?.status, "pending");
  assert.equal((await store.getWallet("user-test")).availableCredits, 0);
});

test("OPCPAY reconciliation is serialized per user and cannot double-consume concurrent status checks", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const order = await store.createOrder("user-test", "boost_small");
  const fake = createFakeClient();
  const service = createService(store, fake.client);
  await service.initialize();
  await service.createCheckout("user-test", order);

  const [first, second] = await Promise.all([
    service.reconcileUser("user-test"),
    service.reconcileUser("user-test"),
  ]);

  assert.equal(fake.getConsumeCalls(), 1);
  assert.equal((await store.getWallet("user-test")).availableCredits, 1000);
  assert.equal(first.filter((item) => item.paid).length + second.filter((item) => item.paid).length, 1);
});

test("membership package fulfillment activates and extends a persistent membership entitlement", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const order = await store.createOrder("user-test", "lite");
  const fake = createFakeClient({
    displayName: "lite",
    skuId: "sku-lite",
    price: 41,
    quotaAmount: 38,
    remaining: 38,
  });
  const service = createService(store, fake.client);
  await service.initialize();
  await service.createCheckout("user-test", order);
  const result = await service.reconcileOrder("user-test", order.id);
  const membership = await store.getMembership("user-test");

  assert.equal(result.paid, true);
  assert.equal(membership?.tierId, "lite");
  assert.equal(membership?.active, true);
  assert.ok(new Date(membership!.expiresAt).getTime() > Date.now());
  assert.equal((await store.getWallet("user-test")).availableCredits, 7600);
});

test("OPCPAY refuses a SKU whose amount or quota does not match the local plan", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const order = await store.createOrder("user-test", "boost_small");
  let purchaseCalls = 0;
  const fake = createFakeClient({ price: 1, quotaAmount: 999 });
  const client = {
    ...fake.client,
    async purchase() {
      purchaseCalls += 1;
      throw new Error("must not purchase mismatched SKU");
    },
  } as unknown as FakeClient;
  const service = createService(store, client);
  await service.initialize();

  await assert.rejects(() => service.createCheckout("user-test", order), /价格与一人付 SKU 价格不一致|权益数量与简兮套餐积分不匹配/);
  assert.equal(purchaseCalls, 0);
});

test("OPCPAY webhook verification persists and deduplicates signed event IDs", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const fake = createFakeClient();
  const service = createService(store, fake.client);
  const event = {
    id: "evt-jansee-001",
    type: "entitlement.updated",
    user_id: "user-test",
    data: { user_id: "user-test" },
  };
  const raw = Buffer.from(JSON.stringify(event));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = "v1=" + createHmac("sha256", "test-webhook-secret")
    .update(timestamp + ".")
    .update(raw)
    .digest("hex");
  const headers = {
    "yirenfu-timestamp": timestamp,
    "yirenfu-signature": signature,
    "yirenfu-event-id": event.id,
  };

  const first = await service.acceptWebhook(raw, headers);
  const second = await service.acceptWebhook(raw, headers);

  assert.deepEqual(first, { duplicate: false, userId: "user-test" });
  assert.deepEqual(second, { duplicate: true, userId: "user-test" });
});

test("OPCPAY rejects webhook requests with an invalid signature", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const service = createService(store, createFakeClient().client);
  const raw = Buffer.from(JSON.stringify({ id: "evt-bad", type: "entitlement.updated", user_id: "user-test" }));

  await assert.rejects(
    () => service.acceptWebhook(raw, {
      "yirenfu-timestamp": String(Math.floor(Date.now() / 1000)),
      "yirenfu-signature": "v1=" + "0".repeat(64),
      "yirenfu-event-id": "evt-bad",
    }),
    /OPCPAY_WEBHOOK_INVALID_SIGNATURE/,
  );
});

test("OPCPAY remains ready without an optional webhook secret and reconciles through the periodic query path", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const order = await store.createOrder("user-test", "boost_small");
  const fake = createFakeClient();
  const service = new OpcpayService({ client: fake.client, billingStore: store });

  assert.equal(await service.initialize(), true);
  assert.equal(service.isReady, true);
  assert.equal(service.statusReason, "");
  assert.equal(service.webhookConfigured, false);

  await service.createCheckout("user-test", order);
  const result = await service.reconcileOrder("user-test", order.id);

  assert.equal(result.paid, true);
  assert.equal((await store.getWallet("user-test")).availableCredits, 1000);
  await assert.rejects(
    () => service.acceptWebhook(Buffer.from("{}"), {}),
    /OPCPAY_WEBHOOK_SECRET 未配置/,
  );
});

test("OPCPAY serializes checkout creation and allows a second outstanding user payment", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const firstOrder = await store.createOrder("user-test", "boost_small");
  const secondOrder = await store.createOrder("user-test", "lite");
  const service = createService(store, createFakeClient().client);
  await service.initialize();

  const firstCheckout = await service.createCheckout("user-test", firstOrder);
  const secondCheckout = await service.createCheckout("user-test", secondOrder);
  const resumedCheckout = await service.createCheckout("user-test", firstOrder);

  assert.equal(resumedCheckout.payUrl, firstCheckout.payUrl);
  assert.ok(secondCheckout.payUrl);
  assert.notEqual(secondCheckout.order.id, firstCheckout.order.id);
  assert.equal((await store.findOrderById(secondOrder.id))?.paymentProvider, "opcpay");
});

test("OPCPAY never grants local credits from a pre-existing provider quota balance", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const order = await store.createOrder("user-test", "boost_small");
  const fake = createFakeClient({ baseline: 50, remaining: 50 });
  const service = createService(store, fake.client);
  await service.initialize();
  await service.createCheckout("user-test", order);

  const result = await service.reconcileOrder("user-test", order.id);

  assert.equal(result.paid, false);
  assert.match(result.message ?? "", /购买增量/);
  assert.equal((await store.getWallet("user-test")).availableCredits, 0);
  assert.equal((await store.findOrderById(order.id))?.status, "pending");
  assert.equal(fake.getConsumeCalls(), 0);
});

test("OPCPAY refuses to resume legacy pending orders that have no trustworthy pre-purchase quota snapshot", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const original = await store.createOrder("user-test", "boost_small");
  const legacyOrder = {
    ...original,
    paymentProvider: "opcpay" as const,
    providerSkuId: "sku-boost",
    providerQuotaAmount: 5,
    providerQuotaUnit: "COUNT" as const,
    payUrl: "https://ai6666.com/pay/legacy",
  };
  store.findOrderById = async () => legacyOrder;
  store.findPendingProviderOrders = async () => [legacyOrder];
  const service = createService(store, createFakeClient().client);
  await service.initialize();

  await assert.rejects(
    () => service.createCheckout("user-test", legacyOrder),
    /历史订单缺少下单前权益快照/,
  );
});

test("OPCPAY only fulfills when the confirmed consumption receipt matches request ID, amount and quota unit", async () => {
  const mismatches = [
    { consumeAmount: 4 },
    { consumeUnit: "POINT" as const },
    { consumeIdempotencyKey: "another-order:c" },
  ];
  for (const mismatch of mismatches) {
    const store = new InMemoryBillingStore({ initialGrant: 0 });
    const order = await store.createOrder("user-test", "boost_small");
    const fake = createFakeClient(mismatch);
    const service = createService(store, fake.client);
    await service.initialize();
    await service.createCheckout("user-test", order);

    const result = await service.reconcileOrder("user-test", order.id);

    assert.equal(result.paid, false);
    assert.match(result.message ?? "", /请求号、数量或权益单位不匹配/);
    assert.equal((await store.getWallet("user-test")).availableCredits, 0);
    assert.equal((await store.findOrderById(order.id))?.status, "pending");
    assert.equal(fake.getConsumeCalls(), 1);
  }
});

test("OPCPAY does not fulfill from a previously successful consumption with mismatched receipt fields", async () => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const order = await store.createOrder("user-test", "boost_small");
  const fake = createFakeClient({
    previousConsumption: {
      status: "SUCCEEDED",
      confirmed: true,
      idempotency_key: "other-order:c",
      consumed: 5,
      quota_unit: "COUNT",
    },
  });
  const service = createService(store, fake.client);
  await service.initialize();
  await service.createCheckout("user-test", order);

  const result = await service.reconcileOrder("user-test", order.id);

  assert.equal(result.paid, false);
  assert.match(result.message ?? "", /历史核销回执/);
  assert.equal((await store.getWallet("user-test")).availableCredits, 0);
  assert.equal(fake.getConsumeCalls(), 0);
});
