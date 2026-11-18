import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// 简兮黑曜石视觉规范 · 0 Emoji 绝杀令门禁自动化测试
// 全站禁止使用系统彩色表情符号，一律采用发丝细线与克制几何矢量图。
test("Design constitution: 0 Emoji mandate enforced across all source files", () => {
  const rootDir = process.cwd();
  const targetDirs = ["apps/web/src", "apps/api/src", "packages", "modules"];

  // Unicode Emoji 与符号匹配正则
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}]/u;

  const violations: Array<{ file: string; line: number; char: string; snippet: string }> = [];

  function scanDir(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if ([".ts", ".tsx", ".js", ".mjs", ".html", ".css"].includes(ext)) {
          const content = fs.readFileSync(fullPath, "utf8");
          const lines = content.split("\n");
          lines.forEach((line, idx) => {
            const match = line.match(emojiRegex);
            if (match) {
              violations.push({
                file: path.relative(rootDir, fullPath),
                line: idx + 1,
                char: match[0],
                snippet: line.trim().slice(0, 80),
              });
            }
          });
        }
      }
    }
  }

  for (const relDir of targetDirs) {
    const absDir = path.join(rootDir, relDir);
    if (fs.existsSync(absDir)) {
      scanDir(absDir);
    }
  }

  assert.equal(
    violations.length,
    0,
    `Found ${violations.length} emoji violation(s):\n` +
      violations.map((v) => `  - ${v.file}:${v.line} [${v.char}]: ${v.snippet}`).join("\n")
  );
});
