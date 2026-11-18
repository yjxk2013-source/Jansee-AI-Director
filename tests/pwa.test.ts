import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../apps/web/public/manifest.webmanifest", import.meta.url), "utf8"),
) as {
  start_url: string;
  scope: string;
  display: string;
  icons: Array<{ src: string; type: string }>;
};

const serviceWorker = readFileSync(
  new URL("../apps/web/public/sw.js", import.meta.url),
  "utf8",
);

test("PWA uses the same responsive app shell as its installed experience", () => {
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some((icon) => icon.src === "/assets/jansee-mark.svg"));
});

test("service worker excludes private API and media paths from its cache", () => {
  for (const path of ["/api/", "/auth/", "/session/", "/uploads/", "/media/"]) {
    assert.ok(serviceWorker.includes(`"${path}"`));
  }
  assert.match(serviceWorker, /request\.method !== "GET"/);
  assert.match(serviceWorker, /request\.mode === "navigate"/);
});
