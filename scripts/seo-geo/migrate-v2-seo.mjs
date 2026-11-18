import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const archive = resolve(root, "docs/seo-geo/source-v2");
const publicRoot = resolve(root, "apps/web/public");
const sourceGuides = resolve(archive, "client/guides");
const targetGuides = resolve(publicRoot, "guides");

await mkdir(targetGuides, { recursive: true });
await cp(sourceGuides, targetGuides, { recursive: true, force: true });

// Keep the historic 251-question snapshot alongside the expanded current KB.
const legacySource = resolve(root, "../janseeV2/_backup/geo-251-20261031-010531");
const legacyTarget = resolve(archive, "legacy-251");
try {
  await mkdir(legacyTarget, { recursive: true });
  await cp(legacySource, legacyTarget, { recursive: true, force: true });
} catch (error) {
  console.warn("Legacy 251 snapshot copy skipped:", error.message);
}

// Publish the six evergreen guides and their index with one consistent, restrained design.
// The V2 pages remain preserved unchanged in docs/seo-geo/source-v2.
for (const name of await readdir(targetGuides)) {
  if (!name.endsWith(".html")) continue;
  const path = resolve(targetGuides, name);
  let html = await readFile(path, "utf8");
  html = html.replace(/<style>[\s\S]*?<\/style>/i, '<link rel="stylesheet" href="/seo.css">');
  html = html.replaceAll("/#matrix-workbench", "/");
  html = html.replaceAll("https://jansee.cn/#matrix-workbench", "https://jansee.cn/");
  html = html.replaceAll(
    "支持最多 9 张商品实拍图合成、Single-Pass 极速流式转码、双机位平滑推拉消除跳切与商业发布五件套导出。",
    "可根据素材类型选择当前产品提供的创作模式。具体功能与可用选项以简兮 JANSEE 当前产品界面为准。"
  );
  html = html.replaceAll(
    "支持最多 9 张商品实拍图合成、Single-Pass 极速流式转码、双机位平滑推拉与商业发布五件套导出。",
    "可根据素材类型选择当前产品提供的创作模式。具体功能与可用选项以简兮 JANSEE 当前产品界面为准。"
  );
  // Remove legacy promotional workbench blocks that describe V2-only controls.
  const marker = html.indexOf("JANSEE WORKBENCH");
  if (marker >= 0) {
    const start = html.lastIndexOf("<div", marker);
    if (start >= 0) {
      let depth = 0;
      let cursor = start;
      const token = /<div\b[^>]*>|<\/div\s*>/gi;
      token.lastIndex = start;
      let match;
      while ((match = token.exec(html))) {
        if (/^<div\b/i.test(match[0])) depth += 1;
        else depth -= 1;
        if (depth === 0) {
          html = html.slice(0, start) + html.slice(token.lastIndex);
          break;
        }
      }
    }
  }
  // Avoid publishing legacy anchor destinations that no longer exist in V4.
  html = html.replaceAll('href="/#matrix-workbench"', 'href="/"');
  await writeFile(path, html, "utf8");
}
console.log("Migrated guide pages:", (await readdir(targetGuides)).filter((name) => name.endsWith(".html")).length);
console.log("Published path:", targetGuides);
