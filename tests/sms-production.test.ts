import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isMockMode, smsStatus } from "@jansee/sms-kit";

test("production SMS never enters mock mode, even with test flags, mock provider, or missing credentials", () => {
  const original = Object.fromEntries(["NODE_ENV", "JX_AUTH_TEST", "JX_SMS_PROVIDER", "JX_SMS_SECRET_ID", "JX_SMS_SECRET_KEY", "JX_SMS_SIGN_NAME", "JX_SMS_TEMPLATE_CODE"].map((key) => [key, process.env[key]]));
  try {
    process.env.NODE_ENV = "production";
    process.env.JX_AUTH_TEST = "1";
    process.env.JX_SMS_PROVIDER = "mock";
    delete process.env.JX_SMS_SECRET_ID;
    delete process.env.JX_SMS_SECRET_KEY;
    delete process.env.JX_SMS_SIGN_NAME;
    delete process.env.JX_SMS_TEMPLATE_CODE;
    assert.equal(isMockMode(), false);
    assert.equal(smsStatus().mock, false);
    assert.equal(smsStatus().ready, false);

    process.env.JX_SMS_PROVIDER = "aliyun";
    assert.equal(isMockMode(), false);
    assert.equal(smsStatus().ready, false);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("development with a real SMS provider but missing credentials is unavailable, never an implicit mock", () => {
  const original = Object.fromEntries(["NODE_ENV", "JX_AUTH_TEST", "JX_SMS_PROVIDER", "JX_SMS_SECRET_ID", "JX_SMS_SECRET_KEY"].map((key) => [key, process.env[key]]));
  try {
    process.env.NODE_ENV = "development";
    process.env.JX_AUTH_TEST = "0";
    process.env.JX_SMS_PROVIDER = "aliyun";
    delete process.env.JX_SMS_SECRET_ID;
    delete process.env.JX_SMS_SECRET_KEY;
    assert.equal(isMockMode(), false);
    assert.equal(smsStatus().ready, false);
    assert.equal(smsStatus().mock, false);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("production API startup fails closed when SMS is mock or unavailable", () => {
  const original = {
    test: process.env.JX_AUTH_TEST,
    provider: process.env.JX_SMS_PROVIDER,
    id: process.env.JX_SMS_SECRET_ID,
    key: process.env.JX_SMS_SECRET_KEY,
  };
  try {
    process.env.JX_AUTH_TEST = "1";
    process.env.JX_SMS_PROVIDER = "aliyun";
    process.env.JX_SMS_SECRET_ID = "configured";
    process.env.JX_SMS_SECRET_KEY = "configured";
    assert.equal(smsStatus().mock, true, "test override must be recognized as mock mode");
    const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
    assert.match(server, /if \(production && \(!smsConfiguration\.ready \|\| smsConfiguration\.mock\)\)/);
    assert.match(server, /mock\/test SMS mode is forbidden/);
  } finally {
    for (const [key, value] of Object.entries({
      JX_AUTH_TEST: original.test,
      JX_SMS_PROVIDER: original.provider,
      JX_SMS_SECRET_ID: original.id,
      JX_SMS_SECRET_KEY: original.key,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
