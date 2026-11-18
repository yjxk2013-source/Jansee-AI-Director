import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBatchVersions,
  deriveBatchIdempotencyKey,
  assignBatchVariants,
  BATCH_VERSION_LIMIT,
} from "../apps/api/src/batch-versions.ts";

test("parseBatchVersions reads arabic numerals with batch units", () => {
  assert.deepEqual(parseBatchVersions("帮我出3版赛马"), { total: 3, matched: true });
  assert.deepEqual(parseBatchVersions("出 5 条视频"), { total: 5, matched: true });
  assert.deepEqual(parseBatchVersions("生成4个版本"), { total: 4, matched: true });
  assert.deepEqual(parseBatchVersions("给我来2轮"), { total: 2, matched: true });
});

test("parseBatchVersions reads chinese numerals with batch units", () => {
  assert.deepEqual(parseBatchVersions("做两版对比一下"), { total: 2, matched: true });
  assert.deepEqual(parseBatchVersions("生成三条不同风格版本"), { total: 3, matched: true });
  assert.deepEqual(parseBatchVersions("出十版赛马"), { total: 10, matched: true });
});

test("parseBatchVersions defaults keyword-only requests to three versions", () => {
  assert.deepEqual(parseBatchVersions("帮我赛马一下"), { total: 3, matched: true });
  assert.deepEqual(parseBatchVersions("做多版本对比"), { total: 3, matched: true });
});

test("parseBatchVersions clamps to the batch limit", () => {
  assert.equal(parseBatchVersions("出15版").total, BATCH_VERSION_LIMIT);
  assert.equal(parseBatchVersions("出100版").total, BATCH_VERSION_LIMIT);
});

test("parseBatchVersions returns one when no batch intent is present", () => {
  assert.deepEqual(parseBatchVersions("做一个产品宣传片"), { total: 1, matched: false });
  assert.deepEqual(parseBatchVersions(""), { total: 1, matched: false });
});

test("parseBatchVersions forces single version for personal creation scene", () => {
  const text = "[User-selected creation scene: personal-creation.]\n拍一支口播，帮我出3版";
  assert.deepEqual(parseBatchVersions(text), { total: 1, matched: false });
});

test("deriveBatchIdempotencyKey is deterministic, uuid-formatted, and index-unique", () => {
  const clientKey = "33333333-3333-4333-8333-333333333333";
  const v2a = deriveBatchIdempotencyKey(clientKey, 2);
  const v2b = deriveBatchIdempotencyKey(clientKey, 2);
  assert.equal(v2a, v2b);
  assert.notEqual(v2a, deriveBatchIdempotencyKey(clientKey, 3));
  assert.notEqual(v2a, deriveBatchIdempotencyKey("44444444-4444-4444-8444-444444444444", 2));
  assert.match(v2a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("assignBatchVariants rotates the variant pool without repeats", () => {
  const prompt = "做一支带货解说视频";
  const assignments = assignBatchVariants(prompt, "sell", 10);
  assert.equal(assignments.length, 10);
  assert.equal(new Set(assignments).size, 10, "sell pool has 14 variants; 10 versions must stay distinct");

  const localAssignments = assignBatchVariants(prompt, "local", 10);
  // local 池只有 8 个变体：前 8 版互不重复，第 9 版开始允许轮转复用
  assert.equal(new Set(localAssignments.slice(0, 8)).size, 8);
  assert.equal(localAssignments[8], localAssignments[0]);
});

test("assignBatchVariants honors strong signal hits with dedup rotation", () => {
  // “收纳”命中 A-痛点直击型强信号；v2 排重后轮换到下一个未用类型
  const assignments = assignBatchVariants("收纳神器带货", "sell", 3);
  assert.equal(assignments[0], "A-痛点直击型");
  assert.notEqual(assignments[1], "A-痛点直击型");
  assert.notEqual(assignments[1], assignments[2]);
});
