import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  ENDING_ASSETS,
  ENDING_SCENES,
  buildEndingSvg,
  seedFromTaskId,
  pickEndingForTask,
} from "@jansee/ending-kit";

import {
  buildIntroSvg,
  INTRO_TIMING,
  INTRO_FONTS,
} from "@jansee/intro-kit";

import {
  probeDurationSec,
  probeVideoSize,
  hasAudioStream,
} from "@jansee/ffmpeg-kit/probe.mjs";

import {
  performAutoQc,
  QC_THRESHOLDS,
} from "@jansee/ffmpeg-kit/autoQc.mjs";

import {
  acquireComposeSlot,
  getComposeGateSnapshot,
  resetConcurrency,
  setDegradedConcurrency,
} from "@jansee/ffmpeg-kit/composeGate.mjs";

import {
  filterBannedWords,
  sanitizePublish,
} from "@jansee/publish-kit";

import { assetsDir } from "@jansee/shared/assetsPath.mjs";

test("V2 reuse: ending-kit exports exactly 15 locked CTA assets across 3 scenes and generates valid SVG", () => {
  assert.equal(ENDING_ASSETS.length, 15, "Ending assets must have exactly 15 CTA cards");
  assert.deepEqual(Array.from(ENDING_SCENES), ["personal", "sell", "local"]);

  const sampleCard = ENDING_ASSETS[0];
  const svg = buildEndingSvg(sampleCard, { width: 1080, height: 1920 });
  assert.ok(svg.includes("<svg"), "SVG output must contain svg root tag");
  assert.ok(svg.includes("1080"), "SVG output must respect width");
  assert.ok(svg.includes("1920"), "SVG output must respect height");

  const seed = seedFromTaskId("task_test_123");
  assert.equal(typeof seed, "number");
  const picked = pickEndingForTask("task_test_123", "sell");
  assert.ok(picked);
  assert.equal(picked.scene, "sell");
});

test("V2 reuse: intro-kit generates dual-edge vignette cinematic SVG with correct timing constants", () => {
  assert.equal(INTRO_TIMING.startSec, 0.2);
  assert.equal(INTRO_TIMING.durationSec, 2.5);
  assert.equal(INTRO_FONTS.zh, "Noto Sans SC");

  const svg = buildIntroSvg({
    title: "春季新品上市",
    brandEn: "JANSEE REFRAME",
    site: "CHENGDU",
    note: "留白慢品",
    width: 1080,
    height: 1920,
  });

  assert.ok(svg.includes("<svg"), "Intro SVG must contain svg root tag");
  assert.ok(svg.includes("春季新品上市"), "Intro SVG must contain main title");
  assert.ok(svg.includes("JANSEE REFRAME"), "Intro SVG must contain brand English title");
});

test("V2 reuse: ffmpeg-kit provides probe utilities, Auto-QC guardian and concurrency gate", async () => {
  assert.equal(typeof probeDurationSec, "function");
  assert.equal(typeof probeVideoSize, "function");
  assert.equal(typeof hasAudioStream, "function");

  // Auto-QC thresholds check
  assert.equal(QC_THRESHOLDS.MIN_FILE_SIZE_BYTES, 100 * 1024);
  assert.equal(QC_THRESHOLDS.MAX_DRIFT_MS, 350);

  // Auto-QC non-existent file rejection test
  const nonExistentResult = await performAutoQc("/path/to/non/existent/video.mp4");
  assert.equal(nonExistentResult.passed, false);
  assert.equal(nonExistentResult.grade, "REJECT");
  assert.ok(nonExistentResult.suggestedCorrections.length > 0);

  // Concurrency gate test
  resetConcurrency();
  const snapshotBefore = getComposeGateSnapshot();
  assert.equal(snapshotBefore.activeCount, 0);

  const release1 = await acquireComposeSlot("test-task-1");
  const release2 = await acquireComposeSlot("test-task-2");
  const snapshotActive = getComposeGateSnapshot();
  assert.equal(snapshotActive.activeCount, 2);

  release1();
  release2();
  const snapshotAfter = getComposeGateSnapshot();
  assert.equal(snapshotAfter.activeCount, 0);
});

test("V2 reuse: publish-kit sanitizes commercial copy against advertising law redlines", () => {
  const dirtyText = "这是全网最低价的衣服，拥有极致的质量，最好最便宜，而且无副作用。";
  const { text: cleanText, hits } = filterBannedWords(dirtyText);

  assert.ok(hits.includes("全网最低") || hits.includes("最低价"));
  assert.ok(hits.includes("极致"));
  assert.ok(hits.includes("最便宜"));
  assert.ok(!cleanText.includes("全网最低"), "Clean text must not contain '全网最低'");
  assert.ok(!cleanText.includes("最便宜"), "Clean text must not contain '最便宜'");
  assert.ok(cleanText.includes("划算"), "Clean text should smoothly substitute '最便宜' with '划算'");

  const sanitized = sanitizePublish({
    caption: dirtyText,
    cover_title: "最强爆款",
    pinned_comment: "第一名推荐",
    scene: "sell",
    title: "高品质风衣",
  });

  assert.ok(sanitized.caption);
  assert.ok(!sanitized.caption.includes("全网最低"));
  assert.ok(sanitized.cover_title);
  assert.ok(!sanitized.cover_title.includes("最强"));
  assert.ok(sanitized.pinned_comment);
  assert.ok(!sanitized.pinned_comment.includes("第一名"));
});

test("V2 reuse: shared package locates materials root and verifies fonts and audio assets", () => {
  const materials = assetsDir();
  assert.ok(fs.existsSync(materials), `Materials root must exist at: ${materials}`);

  const fontsDir = path.join(materials, "fonts");
  assert.ok(fs.existsSync(fontsDir), "Fonts dir must exist");
  assert.ok(fs.existsSync(path.join(fontsDir, "noto-sans-sc", "NotoSansSC_400Regular.ttf")), "NotoSansSC font must exist");

  const audioDir = path.join(materials, "audio");
  assert.ok(fs.existsSync(audioDir), "Audio dir must exist");
  const audioCategories = fs.readdirSync(audioDir);
  assert.ok(audioCategories.includes("calm_narrative"), "Audio categories must include calm_narrative");
  assert.ok(audioCategories.includes("corporate"), "Audio categories must include corporate");
});

test("V2 reuse: deploy security configs and code review guidelines are intact and enforced", () => {
  const deployDir = path.resolve(process.cwd(), "deploy");
  assert.ok(fs.existsSync(deployDir), "deploy directory must exist in V4");

  const secHardening = fs.readFileSync(path.join(deployDir, "security-hardening.conf"), "utf8");
  assert.ok(secHardening.includes("return 444;"), "Nginx config must enforce silent 444 drop for naked IPs");

  const fail2ban = fs.readFileSync(path.join(deployDir, "fail2ban-jansee-security.conf"), "utf8");
  assert.ok(fail2ban.includes("nginx-sensitive-scan"), "fail2ban must defend against sensitive path scanning");

  const nginxConf = fs.readFileSync(path.join(deployDir, "nginx-v4.conf"), "utf8");
  assert.ok(nginxConf.includes("client_max_body_size 500m;"), "Nginx config must support 500m uploads");

  const reviewGuidelines = fs.readFileSync(path.resolve(process.cwd(), "docs/CODE_REVIEW_GUIDELINES.md"), "utf8");
  assert.ok(reviewGuidelines.includes("Four-Eyes Principle"), "Review guidelines must enforce Four-Eyes Principle");
  assert.ok(reviewGuidelines.includes("Anti-Formalism Mandate"), "Review guidelines must enforce Anti-Formalism");
});
