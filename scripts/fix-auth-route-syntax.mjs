import { readFile, writeFile } from "node:fs/promises";
const p = "F:/Jansee-v4/apps/api/src/auth.ts";
let s = await readFile(p, "utf8");
s = s.replace('app.post("/api/v1/auth/sms/send"  app.post("/api/v1/auth/sms/send",', 'app.post("/api/v1/auth/sms/send",');
s = s.replace('app.post("/api/v1/auth/sms/login" { config:', 'app.post("/api/v1/auth/sms/login", { config:');
await writeFile(p, s, "utf8");
console.log("fixed auth route declarations");
