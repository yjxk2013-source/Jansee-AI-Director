import test from "node:test";
import assert from "node:assert/strict";
import { decideVariantLocal } from "../apps/api/src/variant-rules.ts";
import { buildDuckFilter, normalizeBgmEmotion } from "@jansee/audio-kit";
import { BGM, XFADE } from "@jansee/domain";
import { createHeuristicDirectorPlanner } from "../apps/api/src/director.js";
import { TENCENT_VOICE_CANDIDATES, applyTencentVoiceHealthSnapshot } from "@jansee/tts-kit";

const healthyVoiceSnapshot = TENCENT_VOICE_CANDIDATES.map((candidate) => ({ voiceType: candidate.voiceType, status: "healthy" }));
applyTencentVoiceHealthSnapshot(healthyVoiceSnapshot);

test("mature engine decides sales variants from text cues", () => {
  const tutorial = decideVariantLocal("教你三步怎么画出自然眼线教程", "sell");
  assert.equal(tutorial, "K-教程演示型");

  const painPoint = decideVariantLocal("厨房顽固油污清洗困扰去除烦恼", "sell");
  assert.equal(painPoint, "A-痛点直击型");

  const emotional = decideVariantLocal("春茶明前头采回甘，送长辈高端伴手礼盒", "sell");
  assert.equal(emotional, "H-情感共鸣型");
});

test("mature engine generates two-stage ducking volume filter following constitution parameters", () => {
  assert.equal(BGM.baseVol, 0.22);
  assert.equal(BGM.duckVol, 0.10);
  assert.equal(XFADE.duration, 0.7);

  const filter = buildDuckFilter([{ start: 1.0, end: 5.0 }], BGM.baseVol, BGM.duckVol);
  assert.ok(filter.includes("volume=0.1"));
  assert.ok(filter.includes("volume=0.22"));
  assert.ok(filter.includes("between(t\\,1.00\\,5.00)"));
});

test("mature engine normalizes emotions and handles synonyms", () => {
  assert.equal(normalizeBgmEmotion("cheerful"), "relaxed");
  assert.equal(normalizeBgmEmotion("healing"), "cozy");
  assert.equal(normalizeBgmEmotion("hopeful"), "warm");
  assert.equal(normalizeBgmEmotion("warm"), "warm");
});

test("heuristic director planner produces complete plan with voice_id and bgm_emotion", async () => {
  const planner = createHeuristicDirectorPlanner();
  const plan = await planner.createPlan({
    mode: "image-film",
    prompt: "新品极速除油污清洁喷雾，家庭大扫除必备神器",
    aspectRatio: "9:16",
    assets: [
      { name: "油污对比.jpg", kind: "image", size: 1024 * 1024 },
      { name: "使用效果.jpg", kind: "image", size: 1024 * 1024 },
    ],
  });

  assert.ok(plan.title);
  assert.ok(plan.concept);
  assert.ok(plan.scenes.length >= 2);
  assert.ok(plan.voice_id);
  assert.ok(plan.bgm_emotion);
  assert.ok(plan.variant_type);
  // 片尾由系统强制生成，不再作为 packaging 可选项；运镜每镜必须有合法 ID。
  assert.deepEqual(plan.packaging, { intro: true, subtitles: true, bgm: true });
  const allowedMotions = ["sweep_lr", "sweep_rl", "rise_up", "diagonal"];
  assert.equal(plan.scenes.every((scene) => allowedMotions.includes(String((scene as { motion?: unknown }).motion))), true);
  assert.equal(plan.narration?.includes("新品极速除油污清洁喷雾"), false);
  assert.equal(plan.scenes.some((scene) => scene.description.includes("油污对比.jpg")), false);
});

test("heuristic director respects explicit user opt-outs from default packaging", async () => {
  const planner = createHeuristicDirectorPlanner();
  const plan = await planner.createPlan({
    mode: "image-film",
    prompt: "做一支简洁产品短片，不要开场，不加背景音乐，结尾保留，不需要字幕",
    aspectRatio: "9:16",
    assets: [
      { name: "a.jpg", kind: "image", size: 1024 },
      { name: "b.jpg", kind: "image", size: 1024 },
    ],
  });

  assert.deepEqual(plan.packaging, { intro: false, subtitles: false, bgm: false });
});



test("heuristic director routes explicit video slicing to the multi-output operation and respects requested interval", async () => {
  // 旧版本本地自然语言正则匹配切片已被移除，一句话剪辑和切片编排全面交由 LLM 理解。
  // 保留原声路径（keep-original）仍作为确定性免走完整配音的入口。
  const planner = createHeuristicDirectorPlanner();
  const plan = await planner.createPlan({
    mode: "video-dub",
    prompt: "常规口播配音",
    aspectRatio: "9:16",
    assets: [{ name: "talking.mp4", kind: "video", size: 12 * 1024 * 1024 }],
  });
  assert.equal(plan.operation, "standard");
});

test("heuristic director selects the original-audio engine when the user asks to preserve source audio", async () => {
  const planner = createHeuristicDirectorPlanner();
  const prompt = String.fromCharCode(0x4fdd, 0x7559, 0x539f, 0x58f0, 0xff0c, 0x4e0d, 0x8981, 0x914d, 0x97f3);
  const plan = await planner.createPlan({
    mode: "video-dub",
    prompt,
    aspectRatio: "9:16",
    assets: [{ name: "talking.mp4", kind: "video", size: 12 * 1024 * 1024 }],
  });
  assert.equal(plan.operation, "keep-original");
});

test("director distinguishes ordinary per-video instructions and explicit opt-outs", async () => {
  const planner = createHeuristicDirectorPlanner();
  const input = {
    mode: "video-dub" as const,
    aspectRatio: "9:16" as const,
    assets: [{ name: "source.mp4", kind: "video" as const, size: 1024 }],
  };

  const ordinary = await planner.createPlan({
    ...input,
    prompt: "每条视频都加字幕，做成一条完整视频",
  });
  assert.equal(ordinary.operation, "standard");

  const optedOut = await planner.createPlan({
    ...input,
    prompt: "不要把视频切成多段，保留为一条完整视频",
  });
  assert.equal(optedOut.operation, "standard");
});


