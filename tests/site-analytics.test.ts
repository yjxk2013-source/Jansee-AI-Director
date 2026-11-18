import assert from "node:assert/strict";
import Fastify from "fastify";
import type { Pool } from "pg";
import test from "node:test";
import {
  isBotAnalyticsUserAgent,
  isExcludedAnalyticsNetwork,
  recordAdminAnalyticsIp,
  registerSiteAnalyticsRoutes,
} from "../apps/api/src/site-analytics.js";

const chromeUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

test("V2-compatible analytics gate rejects crawlers and malformed browser agents", () => {
  assert.equal(isBotAnalyticsUserAgent("Googlebot/2.1 (+http://www.google.com/bot.html)"), true);
  assert.equal(isBotAnalyticsUserAgent("curl/8.4.0"), true);
  assert.equal(isBotAnalyticsUserAgent("Mozilla/5.0"), true);
  assert.equal(isBotAnalyticsUserAgent(chromeUa), false);
  assert.equal(isBotAnalyticsUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"), false);
});

test("analytics excludes localhost, configured self-test ranges and learned administrator IPs", () => {
  assert.equal(isExcludedAnalyticsNetwork("127.0.0.1"), true);
  assert.equal(isExcludedAnalyticsNetwork("117.174.10.20"), true);
  assert.equal(isExcludedAnalyticsNetwork("8.8.8.8"), false);
  recordAdminAnalyticsIp("8.8.4.4");
  assert.equal(isExcludedAnalyticsNetwork("8.8.4.4"), true);
});

test("site analytics requires human interaction and stores only hashed visitor identity and aggregates", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let connects = 0;
  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("INSERT INTO site_daily_analytics_visitors")) {
        return { rows: [{ visitor_hash: params[1] }], rowCount: 1 };
      }
      if (sql.includes("SELECT breakdown FROM site_daily_analytics")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = {
    async connect() { connects++; return client; },
  } as unknown as Pool;
  const app = Fastify({ trustProxy: true });
  registerSiteAnalyticsRoutes(app, pool);
  try {
    const base = {
      method: "POST" as const,
      url: "/api/v1/site-analytics/visit",
      headers: { "user-agent": chromeUa, "x-forwarded-for": "8.8.8.8" },
    };
    const unverified = await app.inject({ ...base, payload: { visitorId: "visitor-test-id-123456", path: "/", verifiedBy: "hover" } });
    assert.equal(unverified.statusCode, 202);
    assert.equal(unverified.json().accepted, false);
    assert.equal(connects, 0);

    const tooShort = await app.inject({ ...base, payload: { visitorId: "visitor-test-id-123456", path: "/", verifiedBy: "dwell_4s", dwellMs: 1200 } });
    assert.equal(tooShort.json().accepted, false);
    assert.equal(connects, 0);

    const bot = await app.inject({
      ...base,
      headers: { "user-agent": "Googlebot/2.1", "x-forwarded-for": "8.8.8.8" },
      payload: { visitorId: "visitor-test-id-123456", path: "/", verifiedBy: "click" },
    });
    assert.equal(bot.json().reason, "bot_ignored");
    assert.equal(connects, 0);

    const accepted = await app.inject({
      ...base,
      payload: {
        visitorId: "visitor-test-id-123456",
        path: "/features",
        referrer: "https://www.google.com/search?q=jansee",
        utmSource: "",
        verifiedBy: "click",
        event: "pageview",
      },
    });
    assert.equal(accepted.statusCode, 202);
    assert.equal(accepted.json().accepted, true);
    assert.equal(connects, 1);
    const visitorInsert = calls.find((call) => call.sql.includes("INSERT INTO site_daily_analytics_visitors"));
    assert.ok(visitorInsert);
    assert.notEqual(visitorInsert.params[1], "visitor-test-id-123456");
    assert.equal(visitorInsert.params[1], visitorInsert.params[1]?.toString());
    const aggregateInsert = calls.find((call) => call.sql.includes("INSERT INTO site_daily_analytics (day,pv,uv,breakdown,source)"));
    assert.ok(aggregateInsert);
    assert.equal(aggregateInsert.params[1], 1);
    const breakdown = JSON.parse(String(aggregateInsert.params[2]));
    assert.equal(breakdown.pages["/features"], 1);
    assert.equal(breakdown.sources.Google, 1);
    assert.equal(breakdown.devices["电脑"], 1);
    assert.equal(breakdown.browsers.Chrome, 1);
    assert.ok(!calls.some((call) => call.params.some((value) => value === "8.8.8.8" || value === "visitor-test-id-123456")));
  } finally {
    await app.close();
  }
});
