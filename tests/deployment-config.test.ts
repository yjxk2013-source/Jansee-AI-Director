import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dockerfile = readFileSync(new URL("../deploy/Dockerfile.v4", import.meta.url), "utf8");
const compose = readFileSync(new URL("../deploy/docker-compose.v4.yml", import.meta.url), "utf8");
const nginx = readFileSync(new URL("../deploy/nginx-v4.conf", import.meta.url), "utf8");
const dockerignore = readFileSync(new URL("../.dockerignore", import.meta.url), "utf8");
const databaseBackup = readFileSync(new URL("../deploy/backup-v4-db.sh", import.meta.url), "utf8");
const singleServerGuide = readFileSync(new URL("../deploy/V4-SINGLE-SERVER.md", import.meta.url), "utf8");
const productionEnvExample = readFileSync(new URL("../deploy/.env.production.example", import.meta.url), "utf8");
const cleanServerChecklist = readFileSync(new URL("../deploy/V4-CLEAN-SERVER-RELEASE-CHECKLIST.md", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
const apiPackage = JSON.parse(readFileSync(new URL("../apps/api/package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
};

test("V4 Docker build installs production dependencies and compiles web and API in Linux build stage", () => {
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS build/);
  assert.match(dockerfile, /RUN npm ci/);
  assert.match(dockerfile, /RUN npm run build/);
  assert.match(dockerfile, /RUN npm prune --omit=dev/);
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS api/);
  assert.match(dockerfile, /COPY --from=build \/app\/node_modules \.\/node_modules/);
  assert.ok(apiPackage.dependencies?.["ffmpeg-static"]);
});

test("V4 deployment provisions private persistent PostgreSQL for the single-server launch", () => {
  assert.match(compose, /postgres:\s*\n\s*image: postgres:16-alpine/);
  assert.match(compose, /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?Set POSTGRES_PASSWORD/);
  assert.match(compose, /v4_postgres_data:\/var\/lib\/postgresql\/data/);
  assert.match(compose, /DATABASE_URL: postgres:\/\/jansee_v4:\$\{POSTGRES_PASSWORD\}@postgres:5432\/jansee_v4/);
  assert.match(compose, /DATABASE_PRIVATE_NETWORK: "true"/);
  assert.match(compose, /DATABASE_SSL: "false"/);
  assert.match(compose, /depends_on:\s*\n\s*postgres:\s*\n\s*condition: service_healthy/);
  assert.doesNotMatch(compose, /postgres:\s*\n[\s\S]{0,300}?ports:/);
});

test("V4 deployment keeps runtime media persistent and provisions Linux Whisper as a host-mounted dependency", () => {
  assert.match(compose, /env_file:\s+- \.\.\/\.env/);
  assert.match(compose, /\.\.\/storage\/v4:\/app\/storage/);
  assert.match(compose, /\.\.\/materials:\/app\/materials:ro/);
  assert.match(compose, /\.\.\/whisper\.cpp:\/app\/whisper\.cpp:ro/);
  assert.match(compose, /JX_WHISPER_CLI:\s*\/app\/whisper\.cpp\/bin\/whisper-cli/);
  assert.match(compose, /JX_WHISPER_MODEL:\s*\/app\/whisper\.cpp\/models\/ggml-small\.bin/);
  assert.match(compose, /condition: service_healthy/);
});

test("V4 Docker context excludes secrets, local dependencies and machine-specific Whisper binaries", () => {
  assert.match(dockerignore, /^\.env$/m);
  assert.match(dockerignore, /^\.env\.\*$/m);
  assert.match(dockerignore, /^node_modules$/m);
  assert.match(dockerignore, /^whisper\.cpp$/m);
  assert.match(dockerignore, /^\*\.pem$/m);
  assert.match(dockerignore, /^\*\.key$/m);
  assert.doesNotMatch(dockerfile, /COPY \.env/);
});

test("V4 Nginx routes API and health endpoints to the private API service", () => {
  assert.match(nginx, /location \/api\/\s*\{[\s\S]*proxy_pass http:\/\/api:4100/);
  assert.match(nginx, /location \/health\/\s*\{[\s\S]*proxy_pass http:\/\/api:4100/);
  assert.match(nginx, /client_max_body_size 500m/);
  assert.match(compose, /127\.0\.0\.1:8080:80/);
  assert.doesNotMatch(compose, /- "8080:80"/);
  assert.match(nginx, /X-Forwarded-Proto \$http_x_forwarded_proto/);
  assert.match(nginx, /X-Forwarded-For \$http_x_forwarded_for/);
  assert.match(singleServerGuide, /Do not open port 8080 to the Internet/);
});


test("V4 PostgreSQL backup is verified in-container and incomplete dumps are never published", () => {
  assert.match(databaseBackup, /pg_dump -U jansee_v4 -d jansee_v4 -Fc/);
  assert.match(databaseBackup, /pg_restore --list/);
  assert.match(databaseBackup, /\.partial/);
  assert.match(databaseBackup, /mv "\$TEMP_FILE" "\$BACKUP_FILE"/);
  assert.match(databaseBackup, /-mtime \+14 -delete/);
  assert.match(singleServerGuide, /同机备份不能抵御整台服务器或磁盘损坏/);
  assert.match(singleServerGuide, /另一台机器或独立对象存储/);
});


test("V4 proxy identity is pinned to the private Nginx container and never trusts arbitrary forwarded headers", () => {
  assert.match(compose, /TRUST_PROXY_IP: "172\.30\.250\.2"/);
  assert.match(compose, /ipv4_address: 172\.30\.250\.2/);
  assert.match(compose, /ipv4_address: 172\.30\.250\.3/);
  assert.match(compose, /ipv4_address: 172\.30\.250\.4/);
  assert.match(compose, /subnet: 172\.30\.250\.0\/24/);
  assert.match(serverSource, /trustProxy: production \? trustProxyIp! : false/);
  assert.match(serverSource, /isIP\(trustProxyIp\) === 0/);
  assert.doesNotMatch(serverSource, /trustProxy:\s*true/);
  assert.match(singleServerGuide, /Never replace the fixed proxy address with unrestricted proxy trust/);
});

test("V4 production requires OPCPAY credentials while allowing secure polling when webhooks are not provisioned", () => {
  assert.match(serverSource, /production && !opcpayApiKey/);
  assert.doesNotMatch(serverSource, /production && !opcpayWebhookSecret/);
  assert.match(serverSource, /authenticated periodic OPCPAY order-query sweep remains the settlement path/);
  assert.match(serverSource, /paymentProvider\.sweepPending\(\)/);
  assert.match(serverSource, /process\.env\.NODE_ENV === "production" && !configuredOrigins/);
  assert.match(serverSource, /parsedOrigin\.protocol !== "https:"/);
  assert.match(serverSource, /accessSync\(whisperCli, constants\.X_OK\)/);
  assert.match(serverSource, /!whisperModel \|\| !existsSync\(whisperModel\)/);
  assert.match(serverSource, /!materialsRoot \|\| !existsSync\(materialsRoot\)/);
});


test("local authenticated browser profiles are excluded from Git and Docker build contexts", () => {
  const gitignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(gitignore, /^\.tmp-admin-profile\*\/$/m);
  assert.match(gitignore, /^\.tmp-visual-\*\/$/m);
  assert.match(dockerignore, /^\.tmp-admin-profile\*\/$/m);
  assert.match(dockerignore, /^\.tmp-visual-\*\/$/m);
});


test("production environment template is explicit, HTTPS-only and leaves credentials for secure provisioning", () => {
  assert.match(productionEnvExample, /^NODE_ENV=production$/m);
  assert.match(productionEnvExample, /^WEB_ORIGINS=https:\/\/jansee\.cn,https:\/\/admin\.jansee\.cn$/m);
  assert.match(productionEnvExample, /^TRUST_PROXY_IP=172\.30\.250\.2$/m);
  assert.match(productionEnvExample, /^JX_AUTH_TEST=0$/m);
  assert.match(productionEnvExample, /^POSTGRES_PASSWORD=$/m);
  assert.match(productionEnvExample, /^OPCPAY_WEBHOOK_SECRET=$/m);
  assert.match(productionEnvExample, /^PARTNER_PAYOUT_ENCRYPTION_KEY=$/m);
  assert.match(singleServerGuide, /do not overwrite an existing secret-bearing/);
  assert.match(serverSource, /Webhook signing is optional/);
  assert.match(cleanServerChecklist, /格式化云服务器/);
  assert.match(cleanServerChecklist, /不迁移 V2 数据库、文件、容器/);
  assert.match(cleanServerChecklist, /whisper-cli/);
  assert.match(cleanServerChecklist, /docker compose -f deploy\/docker-compose\.v4\.yml config --quiet/);
  assert.match(cleanServerChecklist, /至少完成一次 PostgreSQL 恢复演练/);
});
