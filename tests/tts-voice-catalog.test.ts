import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTtsAudio } from "../packages/tts-kit/tts.js";
import assert from "node:assert/strict";
import {
  TEMPERAMENTS,
  TEMPERAMENT_TENCENT,
  TENCENT_VOICE_CANDIDATES,
  applyTencentVoiceHealthSnapshot,
  getAvailableTemperamentOptions,
  getAvailableEnglishVoice,
  getAvailableCantoneseVoice,
  getAvailableTencentVoiceCandidates,
  isTencentVoiceAvailable,
} from "../packages/tts-kit/voices.js";
import { mapVoiceFor } from "../packages/tts-kit/ttsProvider.js";

const healthySnapshot = [...new Map(TENCENT_VOICE_CANDIDATES.map((voice) => [
  voice.voiceType,
  { voiceType: voice.voiceType, status: "healthy" },
])).values()];

test("TTS execution rejects a missing voice ID instead of silently falling back to a fixed voice", async () => {
  const root = await mkdtemp(join(tmpdir(), "jansee-tts-missing-voice-"));
  try {
    await assert.rejects(buildTtsAudio(root, "这是一段测试旁白。", ""), /TTS_VOICE_ID_REQUIRED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("the director has eight distinct real Tencent Mandarin VoiceTypes: four male and four female", () => {
  const entries = Object.entries(TEMPERAMENTS);
  const voiceTypes = Object.values(TEMPERAMENT_TENCENT);
  assert.equal(entries.length, 8);
  assert.equal(new Set(voiceTypes).size, 8);
  assert.equal(entries.filter(([, item]) => item.gender === "male").length, 4);
  assert.equal(entries.filter(([, item]) => item.gender === "female").length, 4);
  assert.deepEqual(voiceTypes.sort((a, b) => a - b), [402001, 402002, 403009, 403010, 403011, 403012, 403013, 403014]);
});

test("unknown or unprobed Tencent voices are never considered available or offered to a new director request", () => {
  applyTencentVoiceHealthSnapshot([]);
  assert.equal(isTencentVoiceAvailable(403010), false);
  assert.deepEqual(getAvailableTencentVoiceCandidates({ language: "zh" }), []);
  assert.deepEqual(getAvailableTencentVoiceCandidates({ language: "en" }), []);
  assert.deepEqual(getAvailableTencentVoiceCandidates({ language: "yue" }), []);
});

test("numeric Tencent VoiceType IDs pass through unchanged and unknown IDs never fall back to a default female voice", () => {
  applyTencentVoiceHealthSnapshot(healthySnapshot);
  for (const voiceType of Object.values(TEMPERAMENT_TENCENT)) {
    assert.equal(mapVoiceFor("tencent", String(voiceType)), voiceType);
  }
  assert.equal(mapVoiceFor("tencent", "404000"), 404000);
  assert.equal(mapVoiceFor("tencent", "402000"), 402000);
  assert.throws(() => mapVoiceFor("tencent", ""), /TTS_VOICE_ID_UNKNOWN/);
  assert.throws(() => mapVoiceFor("tencent", "m-story"), /TTS_VOICE_ID_UNKNOWN/);
  assert.throws(() => mapVoiceFor("tencent", "999999"), /TTS_VOICE_ID_UNKNOWN/);
});

test("an unavailable Mandarin voice is removed and replaced by a healthy voice of the same gender", () => {
  const snapshot = healthySnapshot.map((item) => item.voiceType === 403010
    ? { ...item, status: "unavailable" }
    : item);
  applyTencentVoiceHealthSnapshot(snapshot);
  const options = getAvailableTemperamentOptions();
  assert.equal(options.length, 8);
  assert.equal(mapVoiceFor("tencent", "m-calm"), 501000);
  assert.equal(TENCENT_VOICE_CANDIDATES.find((item) => item.voiceType === 501000)?.gender, "male");
  assert.equal(mapVoiceFor("tencent", "403010"), 501000, "旧任务遇到已下架主音色时应自动切换到同一性别替补");
});

test("dynamic candidates are healthy, language-specific, gender-filtered, deduplicated and capped at eight", () => {
  applyTencentVoiceHealthSnapshot(healthySnapshot);
  const mandarin = getAvailableTencentVoiceCandidates({ language: "zh" });
  assert.equal(mandarin.length, 8);
  assert.equal(new Set(mandarin.map((item) => item.voiceType)).size, mandarin.length);
  assert.ok(mandarin.every((item) => ["zh", "zh-en"].includes(item.language) && isTencentVoiceAvailable(item.voiceType)));
  assert.equal(mandarin.filter((item) => item.gender === "male").length, 4);
  assert.equal(mandarin.filter((item) => item.gender === "female").length, 4);
  const maleEnglish = getAvailableTencentVoiceCandidates({ language: "en", gender: "male" });
  assert.ok(maleEnglish.length > 0 && maleEnglish.length <= 8);
  assert.ok(maleEnglish.every((item) => item.gender === "male" && ["en", "zh-en"].includes(item.language)));
  const cantonese = getAvailableTencentVoiceCandidates({ language: "yue" });
  assert.deepEqual(cantonese.map((item) => item.voiceType).sort((a, b) => a - b), [101019, 404000]);
  const noMaleCantonese = getAvailableTencentVoiceCandidates({ language: "yue", gender: "male" });
  assert.deepEqual(noMaleCantonese, []);
  const degraded = healthySnapshot.map((item) => item.voiceType === 404000 ? { ...item, status: "unknown" } : item);
  applyTencentVoiceHealthSnapshot(degraded);
  assert.deepEqual(getAvailableTencentVoiceCandidates({ language: "yue" }).map((item) => item.voiceType), [101019]);
});

test("English and Cantonese voices switch to tested same-language backups", () => {
  const snapshot = healthySnapshot.map((item) => {
    if (item.voiceType === 402002 || item.voiceType === 402000 || item.voiceType === 404000) {
      return { ...item, status: "unavailable" };
    }
    return item;
  });
  applyTencentVoiceHealthSnapshot(snapshot);
  assert.equal(getAvailableEnglishVoice("male"), 501008);
  assert.equal(getAvailableEnglishVoice("female"), 501009);
  assert.equal(mapVoiceFor("tencent", "402002", "Hello, this is English narration."), 501008);
  assert.equal(mapVoiceFor("tencent", "402000", "Hello, this is English narration."), 501009);
  assert.equal(getAvailableCantoneseVoice(), 101019);
  assert.equal(mapVoiceFor("tencent", "404000"), 101019);
  const allCantoneseUnavailable = snapshot.map((item) => item.voiceType === 101019
    ? { ...item, status: "unavailable" }
    : item);
  applyTencentVoiceHealthSnapshot(allCantoneseUnavailable);
  assert.equal(getAvailableCantoneseVoice(), null);
  assert.throws(() => mapVoiceFor("tencent", "404000"), /TTS_VOICE_UNAVAILABLE/);
  applyTencentVoiceHealthSnapshot(healthySnapshot);
});
