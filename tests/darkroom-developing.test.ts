import test from "node:test";
import assert from "node:assert/strict";
import { calculateDarkroomDeveloping } from "../apps/web/src/filmstrip-logic.js";

test("暗房平滑显影: 0秒初始状态显影微光", () => {
  const result = calculateDarkroomDeveloping(0, 0, false, "rendering");
  assert.equal(result.progress, 5);
  assert.ok(result.opacity >= 0.05 && result.opacity <= 0.08);
  assert.match(result.label, /暗房多轨显影中/);
});

test("暗房平滑显影: 前5秒轮廓显影至约25%", () => {
  const result = calculateDarkroomDeveloping(5000, 0, false, "rendering");
  assert.equal(result.progress, 25);
  assert.ok(result.opacity >= 0.24 && result.opacity <= 0.26);
});

test("暗房平滑显影: 28秒细节显影至约88%", () => {
  const result = calculateDarkroomDeveloping(28000, 0, false, "rendering");
  assert.equal(result.progress, 88);
  assert.ok(result.opacity >= 0.87 && result.opacity <= 0.89);
});

test("暗房平滑显影: 35秒渐近至95%饱和定影态", () => {
  const result = calculateDarkroomDeveloping(35000, 0, false, "rendering");
  assert.equal(result.progress, 95);
  assert.ok(result.opacity >= 0.94 && result.opacity <= 0.96);
  assert.match(result.label, /底片显影完成 · 画质质检定影中/);
});

test("暗房平滑显影: 超过35秒平稳软着陆等待成片", () => {
  const result = calculateDarkroomDeveloping(45000, 0, false, "rendering");
  assert.equal(result.progress, 95);
  assert.ok(result.opacity >= 0.94 && result.opacity <= 0.96);
  assert.match(result.label, /底片显影完成 · 画质质检定影中/);
});

test("暗房平滑显影: 真实进度超前时自动加速", () => {
  // 5秒时真实进度已经达到80%
  const result = calculateDarkroomDeveloping(5000, 80, false, "rendering");
  assert.equal(result.progress, 80);
  assert.ok(result.opacity >= 0.79 && result.opacity <= 0.81);
});

test("暗房平滑显影: 成片一旦就位立即瞬时拉满至100%", () => {
  const result = calculateDarkroomDeveloping(12000, 40, true, "completed");
  assert.equal(result.progress, 100);
  assert.equal(result.opacity, 1.0);
  assert.match(result.label, /成片已定影交付/);
});

