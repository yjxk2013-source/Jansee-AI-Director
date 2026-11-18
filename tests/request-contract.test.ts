import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CreateDirectorRequestSchema } from "@jansee/contracts";

const base = {
  prompt: "突出商品的质感和细节",
  aspectRatio: "9:16" as const,
  idempotencyKey: randomUUID(),
};

test("valid image-film request accepts up to nine unique assets", () => {
  const parsed = CreateDirectorRequestSchema.safeParse({
    ...base,
    mode: "image-film",
    assetIds: Array.from({ length: 9 }, () => randomUUID()),
  });
  assert.equal(parsed.success, true);
});

test("video-dub requires exactly one asset", () => {
  const parsed = CreateDirectorRequestSchema.safeParse({
    ...base,
    mode: "video-dub",
    assetIds: [randomUUID(), randomUUID()],
  });
  assert.equal(parsed.success, false);
});

test("storyboard requires at least two assets", () => {
  const parsed = CreateDirectorRequestSchema.safeParse({
    ...base,
    mode: "storyboard",
    assetIds: [randomUUID()],
  });
  assert.equal(parsed.success, false);
});

test("duplicate asset IDs and unknown request fields are rejected", () => {
  const id = randomUUID();
  const duplicates = CreateDirectorRequestSchema.safeParse({
    ...base, mode: "image-film", assetIds: [id, id],
  });
  const extraField = CreateDirectorRequestSchema.safeParse({
    ...base, mode: "image-film", assetIds: [randomUUID()], tenantId: "untrusted",
  });
  assert.equal(duplicates.success, false);
  assert.equal(extraField.success, false);
});
