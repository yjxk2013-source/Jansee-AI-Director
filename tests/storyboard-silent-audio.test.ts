import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import { composeStoryboard } from "@jansee/video-creator";

test("storyboard engine normalizes silent source clips with a synthetic audio track", async () => {
  const taskDir = await mkdtemp(join(tmpdir(), "jansee-storyboard-silent-"));
  try {
    const clips = [1, 2].map((n) => join(taskDir, `source-${n}.mp4`));
    for (const clip of clips) {
      const result = spawnSync(ffmpegStatic, [
        "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=black:s=160x284:r=25:d=2",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip,
      ], { encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, 0, result.stderr);
    }

    const output = await composeStoryboard({
      taskDir,
      shots: clips.map((file) => ({ mediaType: "video", file, text: "" })),
      autoMode: "asr",
      voiceId: "m-warm",
      bgmPath: "",
      subtitles: [],
    });

    assert.ok(output.output);
    assert.ok(output.durationSec > 0);
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});
