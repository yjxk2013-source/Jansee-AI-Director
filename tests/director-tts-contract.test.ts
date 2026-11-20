import test from "node:test";
import assert from "node:assert/strict";
import { DirectorPlanSchema } from "../apps/api/src/director.ts";
import { buildDirectorSystemPrompt } from "../apps/api/src/prompt-assembly.ts";
import { resolveShotDurations } from "../apps/api/src/renderer.ts";
import { TENCENT_VOICE_CANDIDATES, applyTencentVoiceHealthSnapshot } from "@jansee/tts-kit";

const healthySnapshot = [...new Map(TENCENT_VOICE_CANDIDATES.map((voice) => [voice.voiceType, { voiceType: voice.voiceType, status: "healthy" }])).values()];

const minimalPlan = {
  title: "产品短片",
  concept: "通过真实素材表达产品的特点与使用场景。",
  narration: "让每一处细节都被认真呈现，让画面自己说话。",
  scenes: [
    { order: 1, description: "展示素材主体" },
    { order: 2, description: "呈现细节并收尾" },
  ],
  style: "克制的商业电影感",
  soundtrack: "轻节奏配乐",
  voice_id: "403010",
  speech_speed: 1.0,
  variant_type: "H-情感共鸣型",
};

test("director contract requires an explicit real Tencent VoiceType and carries a bounded speech speed", () => {
  assert.equal(DirectorPlanSchema.safeParse({ ...minimalPlan, voice_id: undefined }).success, false);
  assert.equal(DirectorPlanSchema.safeParse({ ...minimalPlan, speech_speed: undefined }).success, false);
  const plan = DirectorPlanSchema.parse(minimalPlan);
  assert.equal(plan.voice_id, "403010");
  assert.equal(plan.speech_speed, 1);
  assert.equal(DirectorPlanSchema.parse({ ...minimalPlan, voice_id: "403010", speech_speed: 1.2 }).speech_speed, 1.2);
  assert.equal(DirectorPlanSchema.safeParse({ ...minimalPlan, speech_speed: 1.3 }).success, false);
  assert.equal(DirectorPlanSchema.safeParse({ ...minimalPlan, voice_id: "m-story" }).success, false);
});

test("director prompt exposes only live Tencent VoiceType numbers and requires speech_speed", () => {
  applyTencentVoiceHealthSnapshot(healthySnapshot);
  const prompt = buildDirectorSystemPrompt({
    mode: "image-film",
    prompt: "为商品制作一支宣传短片",
    aspectRatio: "9:16",
    assets: [{ name: "product.jpg", kind: "image", size: 1024 }],
  });
  const candidateSection = prompt.split("[真实腾讯 TTS 动态候选集]")[1] || "";
  const candidateIds = [...candidateSection.matchAll(/\b(\d{6})（/g)].map((match) => Number(match[1]));
  assert.equal(candidateIds.length, 8);
  assert.equal(new Set(candidateIds).size, 8);
  assert.ok(candidateIds.every((id) => healthySnapshot.some((voice) => voice.voiceType === id)));
  assert.match(prompt, /speech_speed/);
  assert.match(prompt, /0\.85–1\.25/);
  assert.doesNotMatch(prompt, /m-story|m-energy|f-chic/);
});

test("explicit Cantonese and English requests pass all healthy language-matched candidates to the LLM", () => {
  applyTencentVoiceHealthSnapshot(healthySnapshot);
  const base = { mode: "image-film" as const, aspectRatio: "9:16" as const, assets: [{ name: "clip.mp4", kind: "video" as const, size: 1024 }] };
  const cantonese = buildDirectorSystemPrompt({ ...base, prompt: "请用粤语配音" });
  const cantoneseSection = (cantonese.split("[真实腾讯 TTS 动态候选集]")[1] || "").split("[语速控制]")[0] || "";
  assert.match(cantoneseSection, /404000/);
  assert.match(cantoneseSection, /101019/);
  assert.doesNotMatch(cantoneseSection, /403010|402000|402002/);
  const english = buildDirectorSystemPrompt({ ...base, prompt: "Please create an English voiceover" });
  const englishSection = (english.split("[真实腾讯 TTS 动态候选集]")[1] || "").split("[语速控制]")[0] || "";
  for (const id of [402000, 402002, 501008, 501009]) assert.match(englishSection, new RegExp(String(id)));
  assert.doesNotMatch(englishSection, /404000|101019|403010/);
});

test("director plan and prompt leave every duration to TTS", () => {
  assert.equal("durationSeconds" in minimalPlan, false);
  // 旧模型惯性多吐时长字段时仍能解析，但执行层不再消费它。
  assert.equal(DirectorPlanSchema.safeParse({
    ...minimalPlan,
    durationSeconds: 15,
    scenes: minimalPlan.scenes.map((scene) => ({ ...scene, durationSeconds: 5 })),
  }).success, true);
  applyTencentVoiceHealthSnapshot(healthySnapshot);
  const prompt = buildDirectorSystemPrompt({
    mode: "storyboard",
    prompt: "做一个短片",
    aspectRatio: "9:16",
    assets: [{ name: "a.jpg", kind: "image", size: 1024 }],
  });
  assert.doesNotMatch(prompt, /durationSeconds/);
  assert.doesNotMatch(prompt, /字数上限/);
});

test("shot durations come from measured TTS cues and the film ends exactly with the voice", () => {
  const cues = [
    { audioStart: 0, audioEnd: 3 },
    { audioStart: 3.4, audioEnd: 7 },
    { audioStart: 7.4, audioEnd: 9 },
  ];
  const fade = 0.7;
  const voiceSec = 9.2;
  const shots = resolveShotDurations({ shotCount: 3, cues, speechDurationSec: voiceSec, fadeDuration: fade, fallbackClipDuration: 5 });
  const filmSec = shots.reduce((sum, value) => sum + value, 0) - fade * (shots.length - 1);
  assert.ok(Math.abs(filmSec - voiceSec) < 0.001, `成片 ${filmSec}s 必须等于配音实测 ${voiceSec}s`);
  let cursor = 0;
  for (let i = 0; i < shots.length; i += 1) {
    cursor += shots[i]! - (i > 0 ? fade : 0);
    const expected = cues[i]!.audioEnd * (voiceSec / 9);
    assert.ok(Math.abs(cursor - expected) < 0.01, `第 ${i + 1} 镜切换点 ${cursor}s 应对齐第 ${i + 1} 句配音结束 ${expected}s`);
  }
});
