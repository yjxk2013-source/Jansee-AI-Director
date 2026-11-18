import test from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES } from "@jansee/contracts";

test("one shared capability registry contains all three supported creation modes", () => {
  assert.deepEqual(
    CAPABILITIES.map((capability) => capability.id),
    ["image-film", "video-dub", "storyboard"],
  );
});

test("creation capability bounds are explicit and internally consistent", () => {
  for (const capability of CAPABILITIES) {
    assert.ok(capability.minAssets >= 1);
    assert.ok(capability.maxAssets <= 9);
    assert.ok(capability.minAssets <= capability.maxAssets);
  }
  assert.equal(CAPABILITIES.find((item) => item.id === "video-dub")?.maxAssets, 1);
  assert.equal(CAPABILITIES.find((item) => item.id === "storyboard")?.minAssets, 2);
});
