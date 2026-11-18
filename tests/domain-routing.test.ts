import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

test("JANSEE V4 production domains stay canonical and admin origin stays explicit", () => {
  const env = read("deploy/.env.production.example");
  const home = read("apps/web/index.html");
  const robots = read("apps/web/public/robots.txt");
  const sitemap = read("apps/web/public/sitemap.xml");
  const app = read("apps/web/src/App.tsx");

  assert.match(env, /^WEB_ORIGINS=https:\/\/jansee\.cn,https:\/\/admin\.jansee\.cn$/m);
  assert.match(home, /<link rel="canonical" href="https:\/\/jansee\.cn\/"\s*\/>/);
  assert.match(home, /property="og:url" content="https:\/\/jansee\.cn\//);
  assert.match(robots, /Sitemap: https:\/\/jansee\.cn\/sitemap\.xml/);
  assert.match(sitemap, /<loc>https:\/\/jansee\.cn\//);
  assert.match(app, /hostname\.toLowerCase\(\) === "admin\.jansee\.cn"/);
});

test("host Nginx redirects www to the canonical domain and safely proxies both production hosts", () => {
  const nginx = read("deploy/nginx-host-jansee.conf.example");
  assert.match(nginx, /server_name www\.jansee\.cn/);
  assert.match(nginx, /return 301 https:\/\/jansee\.cn\$request_uri/);
  assert.match(nginx, /server_name jansee\.cn admin\.jansee\.cn/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8080/);
  assert.match(nginx, /proxy_set_header X-Real-IP \$remote_addr/);
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr/);
  assert.match(nginx, /proxy_set_header X-Forwarded-Proto \$scheme/);
  assert.match(nginx, /proxy_set_header X-Forwarded-Host \$host/);
  assert.doesNotMatch(nginx, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for/);
});
