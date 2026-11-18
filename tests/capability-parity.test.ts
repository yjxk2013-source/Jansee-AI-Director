import test from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES } from "@jansee/contracts";
import { buildApp } from "../apps/api/src/app.ts";

test("API exposes exactly the shared capability registry used by the responsive PC/APP client", async (t) => {
  const app = buildApp({
    allowedOrigins: ["http://localhost:5173"],
    logLevel: "silent",
    production: false,
  });
  t.after(async () => app.close());
  await app.ready();

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/capabilities",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().capabilities, CAPABILITIES);
  assert.deepEqual(
    response.json().capabilities.map((item: { id: string }) => item.id),
    ["image-film", "video-dub", "storyboard"],
  );
});
