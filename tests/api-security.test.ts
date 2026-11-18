import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../apps/api/src/app.ts";

test("API emits security headers and a live health response", async (t) => {
  const app = buildApp({
    allowedOrigins: ["http://localhost:5173"],
    logLevel: "silent",
    production: false,
  });
  t.after(async () => app.close());
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/health/live" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, "alive");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["referrer-policy"], "strict-origin-when-cross-origin");
});

test("readiness stays closed until persistence and workers are configured", async (t) => {
  const app = buildApp({
    allowedOrigins: [],
    logLevel: "silent",
    production: false,
  });
  t.after(async () => app.close());
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().status, "not-ready");
});

test("untrusted origins receive no CORS permission", async (t) => {
  const app = buildApp({
    allowedOrigins: ["https://app.jansee.cn"],
    logLevel: "silent",
    production: false,
  });
  t.after(async () => app.close());
  await app.ready();

  const response = await app.inject({
    method: "GET",
    url: "/health/live",
    headers: { origin: "https://untrusted.example" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
});

test("production refuses to boot with an empty CORS allowlist", () => {
  assert.throws(
    () => buildApp({ allowedOrigins: [], logLevel: "silent", production: true }),
    /WEB_ORIGINS must be configured/,
  );
});

test("one trusted reverse-proxy hop preserves the real client IP for rate limits", async (t) => {
  const app = buildApp({
    allowedOrigins: ["https://app.jansee.cn"],
    logLevel: "silent",
    production: true,
    trustProxy: "172.30.250.2",
  });
  app.get("/test/client-ip", async (request) => ({ ip: request.ip }));
  t.after(async () => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/test/client-ip",
    remoteAddress: "172.30.250.2",
    headers: { "x-forwarded-for": "198.51.100.66, 203.0.113.10" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ip, "203.0.113.10", "trust only the nearest Nginx hop, not client-supplied earlier XFF entries");

  const untrustedPeer = await app.inject({
    method: "GET",
    url: "/test/client-ip",
    remoteAddress: "172.30.250.9",
    headers: { "x-forwarded-for": "203.0.113.99" },
  });
  assert.equal(untrustedPeer.json().ip, "172.30.250.9", "other containers and direct clients cannot spoof their IP with X-Forwarded-For");
});


test("readiness reports database connectivity separately from worker readiness", async (t) => {
  const app = buildApp({
    allowedOrigins: [], logLevel: "silent", production: false,
    database: { async isHealthy() { return true; }, async close() {} },
    workerReady: false,
  });
  t.after(async () => app.close());
  const response = await app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json().checks, { database: true, worker: false });
});


test("production readiness remains closed until a real payment provider is configured", async (t) => {
  const app = buildApp({
    allowedOrigins: ["https://app.jansee.cn"],
    logLevel: "silent",
    production: true,
    database: { async isHealthy() { return true; }, async close() {} },
    workerReady: true,
    paymentProviderReady: false,
  });
  t.after(async () => app.close());
  const response = await app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json().checks, { database: true, worker: true, payment: false });
});
