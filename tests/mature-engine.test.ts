import test from "node:test";
import assert from "node:assert/strict";
import { decideVariantLocal } from "../apps/api/src/variant-rules.ts";
import { rankAnchors, HOST_LIBRARY } from "@jansee/anchor-kit";
import { buildDuckFilter, normalizeBgmEmotion } from "@jansee/audio-kit";
import { BGM, XFADE } from "@jansee/domain";
import { createHeuristicDirectorPlanner } from "../apps/api/src/director.js";
import { TENCENT_VOICE_CANDIDATES, applyTencentVoiceHealthSnapshot } from "../packages/tts-kit/voices.js";

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

test("mature engine ranks anchors compatible with variant and provides DNA temperaments", () => {
  const ranked = rankAnchors({ variantType: "B-反差对比型", taskId: "test-task-1" });
  assert.ok(ranked.length > 0);
  // 兼容反差对比型的主播应当包含李佳琦或辛巴
  const ids = ranked.map((a: { id: string }) => a.id);
  assert.ok(ids.includes("li-jiaqi") || ids.includes("xin-ba"));

  const top = ranked[0];
  assert.ok(top.name);
  assert.ok(Array.isArray(top.temperaments) && top.temperaments.length > 0);
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

test("heuristic director planner produces complete plan with anchor, voice_id and bgm_emotion", async () => {
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
  assert.ok(plan.anchor);
  assert.ok(plan.voice_id);
  assert.ok(plan.bgm_emotion);
  assert.ok(plan.variant_type);
  assert.deepEqual(plan.packaging, { intro: true, ending: true, subtitles: true, bgm: true });
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

  assert.deepEqual(plan.packaging, { intro: false, ending: true, subtitles: false, bgm: false });
});



test("heuristic director routes explicit video slicing to the multi-output operation and respects requested interval", async () => {
  const planner = createHeuristicDirectorPlanner();
  const plan = await planner.createPlan({
    mode: "video-dub",
    prompt: "\u6bcf\u6bb5 15 \u79d2",
    aspectRatio: "9:16",
    assets: [{ name: "talking.mp4", kind: "video", size: 12 * 1024 * 1024 }],
  });
  assert.equal(plan.operation, "video-slice");
  assert.equal(plan.sliceSeconds, 15);
  const compact = await planner.createPlan({
    mode: "video-dub",
    prompt: String.fromCharCode(0x628a, 0x89c6, 0x9891, 0x5207, 0x6210) + " 12 " + String.fromCharCode(0x79d2, 0x7247, 0x6bb5, 0xff0c, 0x5206, 0x522b, 0x5bfc, 0x51fa),
    aspectRatio: "9:16",
    assets: [{ name: "source.mp4", kind: "video", size: 1024 }],
  });
  assert.equal(compact.operation, "video-slice");
  assert.equal(compact.sliceSeconds, 12);
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

test("director distinguishes actual multi-output slicing from ordinary per-video instructions and explicit opt-outs", async () => {
  const planner = createHeuristicDirectorPlanner();
  const input = {
    mode: "video-dub" as const,
    aspectRatio: "9:16" as const,
    assets: [{ name: "source.mp4", kind: "video" as const, size: 1024 }],
  };

  const sliced = await planner.createPlan({
    ...input,
    prompt: "请把这段口播分成三条短视频，每条15秒",
  });
  assert.equal(sliced.operation, "video-slice");
  assert.equal(sliced.sliceSeconds, 15);

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

test("director understands Chinese-number and minute-based slice durations", async () => {
  const planner = createHeuristicDirectorPlanner();
  const input = {
    mode: "video-dub" as const,
    aspectRatio: "9:16" as const,
    assets: [{ name: "source.mp4", kind: "video" as const, size: 1024 }],
  };
  const fifteenSeconds = await planner.createPlan({ ...input, prompt: "每段十五秒，分段输出" });
  assert.equal(fifteenSeconds.operation, "video-slice");
  assert.equal(fifteenSeconds.sliceSeconds, 15);

  const halfMinute = await planner.createPlan({ ...input, prompt: "把视频切成每段半分钟" });
  assert.equal(halfMinute.operation, "video-slice");
  assert.equal(halfMinute.sliceSeconds, 30);

  const oneMinute = await planner.createPlan({ ...input, prompt: "每段一分钟" });
  assert.equal(oneMinute.operation, "video-slice");
  assert.equal(oneMinute.sliceSeconds, 60);
});
