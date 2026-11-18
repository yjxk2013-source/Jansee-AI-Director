import { readFile, writeFile } from "node:fs/promises";
const p = "F:/Jansee-v4/scripts/patch-auth-password.mjs";
let s = await readFile(p, "utf8");
const a = s.indexOf("  const profileAnchor =");
const b = s.indexOf("\n});\nawait edit(\"apps/api/src/auth-store.ts\"", a);
if (a < 0 || b < 0) throw new Error("bad script anchor");
s = s.slice(0, a) + "  return s;" + s.slice(b);
await writeFile(p, s, "utf8");
console.log("removed malformed script block");
