import test from "node:test";
import assert from "node:assert/strict";
import { createProductionEngineRegistry, engineIdForMode } from "../apps/api/src/engine-registry.ts";
import { createDefaultProductionEngineRegistry, explicitlyDisabled, packagingEnabled } from "../apps/api/src/engine-adapters.ts";

test("production engine registry resolves each registered production mode", () => {
  const storyboard = {
    id: "storyboard" as const,
    async execute() {
      return { outputPath: "unused.mp4", durationMs: 1 };
    },
  };
  const registry = createProductionEngineRegistry([storyboard]);
  assert.equal(registry.resolve("storyboard").id, "storyboard");
  assert.deepEqual(registry.list(), ["storyboard"]);
  assert.equal(engineIdForMode("image-film"), "image-film");
  assert.equal(engineIdForMode("video-dub"), "video-dub");
  assert.throws(() => registry.resolve("image-film"), /PRODUCTION_ENGINE_UNAVAILABLE/);
  assert.throws(() => registry.resolve("video-dub"), /PRODUCTION_ENGINE_UNAVAILABLE/);
});

test("default production registry unifies image-film, video-dub and storyboard dispatch", () => {
  const registry = createDefaultProductionEngineRegistry();
  assert.deepEqual(registry.list(), ["image-film", "video-dub", "storyboard"]);
  assert.equal(registry.resolve("image-film").id, "image-film");
  assert.equal(registry.resolve("video-dub").id, "video-dub");
  assert.equal(registry.resolve("storyboard").id, "storyboard");
});

test("director packaging opt-outs respect punctuation and do not leak across clauses", () => {
  const prompt = "保留结尾，不需要字幕；不要背景音乐。";
  assert.equal(explicitlyDisabled(prompt, "结尾|片尾"), false);
  assert.equal(explicitlyDisabled(prompt, "字幕"), true);
  assert.equal(explicitlyDisabled(prompt, "背景音乐|BGM|配乐"), true);
  assert.equal(explicitlyDisabled("不要片头，也不要结尾", "开场|片头"), true);
  assert.equal(explicitlyDisabled("不要片头，也不要结尾", "结尾|片尾"), true);
  assert.equal(explicitlyDisabled("不要字幕", "字幕"), true);
});

test("production engine registry rejects duplicate adapters", () => {
  const storyboard = {
    id: "storyboard" as const,
    async execute() {
      return { outputPath: "unused.mp4", durationMs: 1 };
    },
  };
  assert.throws(
    () => createProductionEngineRegistry([storyboard, storyboard]),
    /Duplicate production engine/,
  );
});


test("storyboard packaging honors structured DirectorPlan opt-outs as well as explicit prompt opt-outs", () => {
  assert.equal(packagingEnabled(false, "制作一支产品短片", "字幕"), false);
  assert.equal(packagingEnabled(true, "制作一支产品短片", "字幕"), true);
  assert.equal(packagingEnabled(true, "制作一支产品短片，不需要字幕", "字幕"), false);
  assert.equal(packagingEnabled(undefined, "保留结尾，不需要字幕", "结尾|片尾"), true);
  assert.equal(packagingEnabled(undefined, "保留结尾，不需要字幕", "字幕"), false);
});
