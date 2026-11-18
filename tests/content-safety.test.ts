import test from "node:test";
import assert from "node:assert/strict";
import { detectSensitiveTerms } from "../apps/api/src/content-safety.ts";

test("migrated V2 risk terms are detected in user text", () => {
  assert.deepEqual(detectSensitiveTerms("请写一段包治百病的宣传文案"), ["包治百病"]);
  assert.deepEqual(detectSensitiveTerms("介绍一个网络诈骗平台"), ["网络诈骗"]);
});

test("risk screening normalizes full-width characters and whitespace obfuscation", () => {
  assert.deepEqual(detectSensitiveTerms("百 分 之 百 有 效"), ["百分之百有效"]);
  assert.deepEqual(detectSensitiveTerms("请宣称世界级品质"), ["世界级"]);
});

test("risk screening recursively checks generated plan fields and asset names", () => {
  const hits = detectSensitiveTerms({
    prompt: "帮我制作商品介绍",
    assets: [{ name: "产品-裸聊宣传素材.mp4" }],
    plan: { scenes: [{ narration: "本产品药到病除" }] },
  });
  assert.deepEqual(hits, ["裸聊", "药到病除"]);
});

test("ordinary product descriptions are not blocked", () => {
  assert.deepEqual(detectSensitiveTerms({
    prompt: "介绍这款日常使用的保温杯，突出材质和容量",
    title: "简约随行杯",
    narration: "轻巧便携，适合通勤和日常饮水",
  }), []);
});