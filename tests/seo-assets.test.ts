import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = resolve(root, "apps/web/public");

test("V4 public SEO entry points and sitemap resolve to real static pages", () => {
  const required = [
    "robots.txt", "sitemap.xml", "llms.txt", "llms-full.txt", "geo-needs.txt",
    "seo.css", "about-jansee.html", "features.html", "solutions.html", "faq.html",
  ];
  for (const name of required) assert.equal(existsSync(resolve(publicRoot, name)), true, name);

  const robots = readFileSync(resolve(publicRoot, "robots.txt"), "utf8");
  assert.equal((robots.match(/^User-agent:/gm) ?? []).length, 1);
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.match(robots, /^Disallow: \/admin\/$/m);
  assert.match(robots, /Sitemap: https:\/\/jansee\.cn\/sitemap\.xml/);

  const sitemap = readFileSync(resolve(publicRoot, "sitemap.xml"), "utf8");
  const urls = [...sitemap.matchAll(/<loc>https:\/\/jansee\.cn\/([^<]*)<\/loc>/g)].map((match) => match[1]);
  assert.ok(urls.includes(""), "homepage must be present");
  for (const url of urls) {
    if (url) assert.equal(existsSync(resolve(publicRoot, url)), true, url);
  }
});

test("public product copy uses canonical AI Director positioning and a curated 15-question FAQ", () => {
  const llms = readFileSync(resolve(publicRoot, "llms.txt"), "utf8");
  const full = readFileSync(resolve(publicRoot, "llms-full.txt"), "utf8");
  const geo = readFileSync(resolve(publicRoot, "geo-needs.txt"), "utf8");
  const faq = readFileSync(resolve(publicRoot, "faq.html"), "utf8");

  for (const content of [llms, full, geo, faq]) {
    assert.match(content, /简兮 JANSEE/);
    assert.match(content, /AI 智能导演系统/);
    assert.match(content, /不保证|不承诺|不作结果保证|Do not claim fixed generation times/);
  }
  assert.equal((faq.match(/class="content-item"/g) ?? []).length, 15);
  assert.match(llms, /线上商家/);
  assert.match(llms, /线下商家/);
  assert.match(llms, /个人创作者/);
});
