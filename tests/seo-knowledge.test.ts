import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = resolve(root, "apps/web/public");
const knowledgeRoot = resolve(publicRoot, "knowledge");
const slugs = [
  "tool-selection",
  "materials-to-video",
  "local-business",
  "ecommerce-video",
  "creator-video",
  "video-workflow",
  "current-capabilities"
];

test("public knowledge center contains seven crawlable topic pages", () => {
  assert.equal(existsSync(resolve(knowledgeRoot, "index.html")), true);
  const sitemap = readFileSync(resolve(publicRoot, "sitemap.xml"), "utf8");
  for (const slug of ["index", ...slugs]) {
    const relative = slug === "index" ? "knowledge/index.html" : "knowledge/" + slug + ".html";
    const canonical = "https://jansee.cn/" + relative;
    assert.equal(existsSync(resolve(publicRoot, relative)), true, relative);
    assert.ok(sitemap.includes("<loc>" + canonical + "</loc>"), canonical);
  }
});

test("each public topic page has canonical metadata, visible Q&A and matching FAQ structured data", () => {
  for (const slug of slugs) {
    const html = readFileSync(resolve(knowledgeRoot, slug + ".html"), "utf8");
    assert.match(html, /<html lang="zh-CN">/);
    assert.match(html, /name="description"/);
    assert.match(html, /name="robots" content="index,follow/);
    assert.match(html, /rel="canonical"/);
    assert.match(html, /property="og:title"/);
    const schemaText = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(schemaText, slug + " JSON-LD");
    const schema = JSON.parse(schemaText);
    assert.equal(schema["@type"], "FAQPage");
    const visibleCount = (html.match(/<article class="faq-entry"/g) ?? []).length;
    assert.equal(visibleCount, schema.mainEntity.length, slug + " visible FAQ/schema count");
    assert.match(html, /简兮 JANSEE/);
    assert.match(html, /AI 智能导演系统/);
    assert.equal(visibleCount, slug === "current-capabilities" ? 8 : 5, slug + " question count");
  }
});

test("the visible FAQ page exposes exactly 15 curated questions and matching structured data", () => {
  const html = readFileSync(resolve(publicRoot, "faq.html"), "utf8");
  assert.equal((html.match(/class="content-item"/g) ?? []).length, 15);
  assert.match(html, /name="robots" content="index,follow/);
  assert.match(html, /rel="canonical" href="https:\/\/jansee\.cn\/faq\.html"/);
  assert.match(html, /property="og:title"/);
  const schemaText = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(schemaText);
  const schema = JSON.parse(schemaText);
  assert.equal(schema["@type"], "FAQPage");
  assert.equal(schema.mainEntity.length, 15);
});

test("the machine-readable GEO library retains all unique V2 FAQs and all 38 current demand questions", () => {
  const geo = JSON.parse(readFileSync(resolve(publicRoot, "geo-knowledge.json"), "utf8"));
  assert.equal(geo.brand, "简兮 JANSEE");
  assert.equal(geo.productCategory, "AI 智能导演系统");
  assert.match(geo.screeningMethod, /不等于逐条人工事实核验/);
  assert.equal(geo.faqs.length, 467);
  assert.equal(new Set(geo.faqs.map((item) => item.question)).size, 467);
  assert.equal(geo.counts.totalLegacyFaqs, 467);
  assert.equal(geo.counts.publishedLegacyFaqs, 467);
  assert.equal(geo.counts.historicalClaimsWithheld, 0);
  assert.ok(geo.faqs.every((item) => item.publicationStatus === "published-user-confirmed"));
  const demandCount = geo.demandGroups.reduce((sum, group) => sum + group.items.length, 0);
  assert.equal(demandCount, 38);
  assert.equal(geo.counts.demandQuestions, 38);
  assert.equal(geo.counts.totalQuestions, 505);
  assert.equal(geo.demandGroups.at(-1).items.length, 8);
  assert.ok(geo.faqs.every((item) => item.answer.length > 0));
});

test("llms and demand GEO documents expose the complete knowledge library and current D01-D38 set", () => {
  const llms = readFileSync(resolve(publicRoot, "llms.txt"), "utf8");
  const full = readFileSync(resolve(publicRoot, "llms-full.txt"), "utf8");
  const needs = readFileSync(resolve(publicRoot, "geo-needs.txt"), "utf8");
  assert.match(llms, /467/);
  assert.match(llms, /38/);
  assert.match(llms, /geo-knowledge\.json/);
  assert.match(full, /GEO-467/);
  assert.match(full, /D38/);
  assert.match(full, /\u7528\u6237\u786e\u8ba4\u5168\u91cf\u53d1\u5e03/);
  assert.match(needs, /D01：/);
  assert.match(needs, /D38：/);
  assert.match(needs, /简兮 JANSEE/);
  assert.match(needs, /个人创作者/);
});

test("all sitemap HTML pages have canonical metadata, crawl directives, Open Graph and valid JSON-LD", () => {
  const sitemap = readFileSync(resolve(publicRoot, "sitemap.xml"), "utf8");
  const urls = [...sitemap.matchAll(/<loc>https:\/\/jansee\.cn\/([^<]*)<\/loc>/g)].map((match) => match[1]);
  for (const relative of urls) {
    const htmlPath = relative ? resolve(publicRoot, relative) : resolve(root, "apps/web/index.html");
    const html = readFileSync(htmlPath, "utf8");
    const canonical = "https://jansee.cn/" + relative;
    assert.match(html, /<title>[^<]+<\/title>/, relative || "homepage title");
    assert.match(html, /<meta name="description"/, relative || "homepage description");
    assert.match(html, /<meta name="robots" content="index,follow/, relative || "homepage robots");
    const canonicalLink = html.match(/<link rel="canonical" href="([^"]+)"/);
    assert.equal(canonicalLink?.[1], canonical, relative || "homepage canonical");
    assert.match(html, /property="og:title"/, relative || "homepage Open Graph");
    const schemaText = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(schemaText, relative || "homepage JSON-LD");
    assert.doesNotThrow(() => JSON.parse(schemaText), relative || "homepage JSON-LD parses");
  }
});

test("legacy V2 brand identity URL is consolidated to the V4 canonical brand page", () => {
  const nginx = readFileSync(resolve(root, "deploy/nginx-v4.conf"), "utf8");
  const fallback = readFileSync(resolve(publicRoot, "brand-identity.html"), "utf8");
  assert.match(nginx, /location = \/brand-identity\.html\s*\{\s*return 301 \/about-jansee\.html;/);
  assert.match(fallback, /rel="canonical" href="https:\/\/jansee\.cn\/about-jansee\.html"/);
});
