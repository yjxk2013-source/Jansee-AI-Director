#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const scanRoots = ["apps", "packages", "modules", "deploy"];
const ignored = new Set(["node_modules", "dist", "coverage", ".git"]);
const sourceExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".yml", ".yaml", ".sh", ".ps1"]);
const forbidden = [
  { label: "absolute V2 checkout path", pattern: /F:[\\/]+janseeV2/i },
  { label: "V2 checkout name in runtime source", pattern: /(?:\.\.\\|\.\.\/){1,4}janseeV2/i },
  { label: "V2 web gateway entrypoint", pattern: /apps[\\/]web[\\/]server[\\/]index\.mjs/i },
];

const violations = [];
async function walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (sourceExtensions.has(path.extname(entry.name).toLowerCase())) {
      const text = await readFile(full, "utf8");
      for (const rule of forbidden) {
        if (rule.pattern.test(text)) violations.push({ file: path.relative(root, full), rule: rule.label });
      }
    }
  }
}

for (const dir of scanRoots) await walk(path.join(root, dir));
if (violations.length) {
  console.error("V4 independence check failed:");
  for (const item of violations) console.error(`- ${item.file}: ${item.rule}`);
  process.exitCode = 1;
} else {
  console.log("V4 source independence check passed: no V2 checkout or V2 gateway runtime references found.");
}
