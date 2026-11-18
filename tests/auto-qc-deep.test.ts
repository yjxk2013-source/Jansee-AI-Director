import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import { aiMetaArgs } from "../packages/subtitle-kit/aiBadge.js";
import { performAutoQc } from "../packages/ffmpeg-kit/autoQc.mjs";

async function createMedia(directory: string, name: string, videoSource: string, audioSource: string, seconds: number, metadata = false) {
  const output = join(directory, name);
  const args = [
    "-nostdin", "-y",
    "-f", "lavfi", "-i", videoSource,
    "-f", "lavfi", "-i", audioSource,
    "-t", String(seconds),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart+use_metadata_tags",
  ];
  if (metadata) args.push(...aiMetaArgs("qc-test-task"));
  args.push(output);
  execFileSync(ffmpegStatic!, args, { stdio: "ignore" });
  return output;
}

async function createMediaWithAudioOffset(directory: string, name: string, audioOffsetSec: number) {
  const output = join(directory, name);
  const args = [
    "-nostdin", "-y",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24",
    "-itsoffset", String(audioOffsetSec),
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "4",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart",
    "-metadata", "comment=JANSEE AIGC",
    output,
  ];
  execFileSync(ffmpegStatic!, args, { stdio: "ignore" });
  return output;
}

test("Auto-QC validates metadata and an in-range subtitle timeline without a full decode", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jansee-auto-qc-pass-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const file = await createMedia(directory, "clean.mp4", "testsrc=size=640x360:rate=24", "sine=frequency=440:sample_rate=44100", 4, true);

  const result = await performAutoQc(file, {
    minSizeBytes: 1024,
    requireAudio: true,
    subtitleTimeline: [{ start: 0.4, end: 1.2 }, { start: 1.5, end: 2.2 }],
  });

  assert.equal(result.passed, true, result.errors.join("; "));
  assert.equal("deepScan" in result.metrics, false);
  assert.equal((result.metrics.subtitleTimeline as { checked: boolean; invalidCount: number }).checked, true);
  assert.equal((result.metrics.subtitleTimeline as { invalidCount: number }).invalidCount, 0);
  assert.equal(result.metrics.hasAigcUdta, true);
});

test("Auto-QC rejects MP4 files missing the complete JANSEE AIGC metadata set", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jansee-auto-qc-no-aigc-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const file = await createMedia(directory, "missing-metadata.mp4", "testsrc=size=640x360:rate=24", "sine=frequency=440:sample_rate=44100", 4, false);

  const result = await performAutoQc(file, { minSizeBytes: 1024, requireAudio: true, requireUdtaAigc: true });
  assert.equal(result.passed, false);
  assert.ok(result.suggestedCorrections.some((item) => item.issue === "METADATA_AIGC_MISSING"));
});

test("Auto-QC blocks subtitles outside the final media time window", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jansee-auto-qc-subtitles-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const file = await createMedia(directory, "clean.mp4", "testsrc=size=640x360:rate=24", "sine=frequency=440:sample_rate=44100", 4);

  const result = await performAutoQc(file, {
    minSizeBytes: 1024,
    requireAudio: true,
    subtitleTimeline: [{ start: -0.2, end: 1 }, { start: 1.5, end: 4.8 }],
  });
  assert.equal(result.passed, false);
  assert.ok(result.suggestedCorrections.some((item) => item.issue === "SUBTITLE_TIME_WINDOW_INVALID"));
});
