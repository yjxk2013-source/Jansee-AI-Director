import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveRendererScene } from "../apps/api/src/renderer.ts";
import type { GenerationJobRecord } from "../apps/api/src/jobs.ts";

// 通用 renderer 画质参数对齐 V2 基线（CRF 20 / AAC 160k）。
// FFmpeg 参数以内联数组常量形式存在于 renderer.ts，此处以源码断言固化契约，防止回归。
const rendererSource = readFileSync(new URL("../apps/api/src/renderer.ts", import.meta.url), "utf8");

test("generic renderer encodes with V2-aligned quality parameters", () => {
  assert.match(rendererSource, /"-crf", "20"/);
  assert.match(rendererSource, /"-b:a", "160k"/);
});

test("generic renderer no longer uses the drifted quality parameters", () => {
  assert.doesNotMatch(rendererSource, /"-crf", "23"/);
  assert.doesNotMatch(rendererSource, /"-b:a", "128k"/);
});

test("renderer obeys the persisted creation scene instead of reclassifying prompt keywords", () => {
  const makeJob = (creationScene: string, prompt: string) => ({ mode: "image-film", prompt, requestPayload: { creationScene } }) as unknown as GenerationJobRecord;
  assert.equal(resolveRendererScene(makeJob("online-ecommerce", "个人 Vlog，门店探店")), "sell");
  assert.equal(resolveRendererScene(makeJob("physical-store", "带货商品宣传")), "local");
  assert.equal(resolveRendererScene(makeJob("personal-creation", "商品、门店宣传")), "personal");
});
