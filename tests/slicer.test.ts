import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareSlicer, composeSlicer } from "../modules/video_creator/video/slicer.js";

const require = createRequire(import.meta.url);
const ffmpeg = require("ffmpeg-static") as string;

test("fixed-duration slicer creates separate MP4s without invoking ASR or inventing captions", async () => {
  const root = await mkdtemp(join(tmpdir(), "jansee-v4-slicer-test-"));
  try {
    const source = join(root, "source.mp4");
    execFileSync(ffmpeg, [
      "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "12",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
    ], { stdio: "ignore" });

    const prepared = await prepareSlicer({ taskDir: root, videoFile: source, segSec: 6, transcribe: false });
    assert.equal(prepared.count, 2);
    assert.ok(prepared.segments.every((segment) => segment.text === "" && segment.words.length === 0));

    const composed = await composeSlicer({
      taskDir: root,
      segments: prepared.segments.map((segment) => ({ ...segment, words: [], final_text: "", deleted: [] })),
    });
    assert.equal(composed.count, 2);
    for (const slice of composed.slices) {
      const info = await stat(join(root, "slices", slice.name));
      assert.ok(info.size > 1_000);
      assert.match(slice.name, /^final_\d{3}\.mp4$/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
