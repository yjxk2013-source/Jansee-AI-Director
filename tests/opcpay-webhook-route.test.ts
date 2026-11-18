import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { InMemoryBillingStore } from "../apps/api/src/billing.js";
import { buildApp } from "../apps/api/src/app.js";
import { OpcpayService, type OpcpayServiceOptions } from "../apps/api/src/opcpay.js";

type FakeClient = NonNullable<OpcpayServiceOptions["client"]>;

function fakeClient(): FakeClient {
  return {
    async capabilities() {
      return {
        api_version: "1.0",
        provider_configured: true,
        capabilities: { purchase_entry: true, entitlement_query: true, consumption: true, purchase_request_query: true, transaction_query: false, refund: false },
        webhook_events: ["entitlement.updated"],
        limitations: [],
      };
    },
    async product() {
      return { product_id: "jansee", product_name: "简兮", capability_status: "ENABLED", pricing_model: "QUANTITY", charging_options: [] };
    },
    async purchase() { throw new Error("not used"); },
    async purchaseQuery() { throw new Error("not used"); },
    async access() { throw new Error("not used"); },
    async consumption() { throw new Error("not used"); },
    async consume() { throw new Error("not used"); },
  } as unknown as FakeClient;
}

function signedEvent(secret: string, id: string) {
  const raw = Buffer.from(JSON.stringify({
    id,
    type: "entitlement.updated",
    user_id: "user-test",
    data: { user_id: "user-test" },
  }));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = "v1=" + createHmac("sha256", secret).update(timestamp + ".").update(raw).digest("hex");
  return {
    raw,
    headers: {
      "content-type": "application/json",
      "yirenfu-timestamp": timestamp,
      "yirenfu-signature": signature,
      "yirenfu-event-id": id,
    },
  };
}

test("OPCPAY webhook route verifies the exact raw JSON body and durably deduplicates event IDs", async (t) => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const service = new OpcpayService({ client: fakeClient(), webhookSecret: "route-secret", billingStore: store });
  const app = buildApp({
    allowedOrigins: ["http://localhost:5173"],
    logLevel: "silent",
    production: false,
    paymentProvider: service,
  });
  t.after(async () => app.close());
  await app.ready();

  const signed = signedEvent("route-secret", "evt-route-001");
  const first = await app.inject({
    method: "POST",
    url: "/api/v1/billing/opcpay/webhook",
    headers: signed.headers,
    payload: signed.raw,
  });
  const duplicate = await app.inject({
    method: "POST",
    url: "/api/v1/billing/opcpay/webhook",
    headers: signed.headers,
    payload: signed.raw,
  });

  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.body, "ok");
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.equal(duplicate.body, "ok");
});

test("OPCPAY webhook route rejects a modified body with an invalid signature", async (t) => {
  const store = new InMemoryBillingStore({ initialGrant: 0 });
  const service = new OpcpayService({ client: fakeClient(), webhookSecret: "route-secret", billingStore: store });
  const app = buildApp({
    allowedOrigins: ["http://localhost:5173"],
    logLevel: "silent",
    production: false,
    paymentProvider: service,
  });
  t.after(async () => app.close());
  await app.ready();

  const signed = signedEvent("route-secret", "evt-route-002");
  const modified = Buffer.from(signed.raw.toString("utf8").replace("entitlement.updated", "entitlement.deleted"));
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/billing/opcpay/webhook",
    headers: signed.headers,
    payload: modified,
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body, "bad signature");
});
