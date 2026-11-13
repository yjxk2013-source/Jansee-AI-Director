#!/usr/bin/env node
/**
 * 简兮一键部署脚本
 *
 * 用法：
 *   node scripts/deploy.mjs              部署当前已提交的最新代码（HEAD）
 *   node scripts/deploy.mjs v2.5.0       部署指定版本号（回滚用，填任意 git 版本号/标签）
 *   node scripts/deploy.mjs --fast       跳过服务器 npm install（纯页面/文案小改时更快）
 *   node scripts/deploy.mjs --force      本地有未提交改动时强行继续（不推荐）
 *
 * 原理：
 *   git archive 只打包"已提交"的代码 → 上传服务器解压覆盖到 /srv/jansee →（可选）装依赖 →
 *   重启 jianxi 服务 → 健康检查。
 *   服务器上的 .env / .alipay-prod.json / materials/ / data/ / storage/ / whisper.cpp/
 *   一概不碰，改坏代码随时可用旧版本号一条命令回滚。
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline/promises";

if (process.platform === "win32") {
  const gitPaths = ["C:\\Program Files\\Git\\cmd", "C:\\Program Files\\Git\\bin"];
  process.env.PATH = `${gitPaths.join(";")};${process.env.PATH || ""}`;
}

const HOST = "ubuntu@203.195.243.42";
const KEY = path.join(homedir(), ".ssh", "jansee_server");
const APP_DIR = "/srv/jansee";
const SERVICE = "jianxi";
const HEALTH_PORT = 3001;
const SITE = "https://jansee.cn";
const NPM_MIRROR = "https://registry.npmmirror.com/-/binary/ffmpeg-static";

const args = process.argv.slice(2);
const force = args.includes("--force");
const fast = args.includes("--fast");
const autoYes = args.includes("--yes") || args.includes("-y");
const ref = args.find((a) => !a.startsWith("--") && !a.startsWith("-")) || "HEAD";

function run(cmd, argv, opts = {}) {
  // 注意：传 input 时 stdin 必须是 pipe，否则 input 会被忽略（inherit 下远端只收到空脚本）
  const stdio = opts.capture
    ? ["ignore", "pipe", "pipe"]
    : opts.input
      ? ["pipe", "inherit", "inherit"]
      : "inherit";
  const r = spawnSync(cmd, argv, { stdio, input: opts.input, encoding: "utf8" });
  if (r.error) {
    console.error(`[部署] 命令无法执行: ${cmd}（${r.error.message}）`);
    process.exit(1);
  }
  if (r.status !== 0 && !opts.allowFail) {
    console.error(`[部署] 命令失败（退出码 ${r.status}）: ${cmd} ${argv.join(" ")}`);
    if (opts.capture && r.stderr) console.error(r.stderr.trim());
    process.exit(1);
  }
  return r;
}

const sshBase = ["-i", KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", HOST];

async function main() {
  console.log(`[部署] 目标版本: ${ref}  →  ${HOST}:${APP_DIR}`);

  // 1. 脏区检查：未提交的改动不会被打包，宁可拦下也不静默丢失
  const st = run("git", ["status", "--porcelain"], { capture: true });
  if (st.stdout.trim()) {
    if (!force) {
      console.error("[部署] 本地有未提交的改动，git 打包不会包含它们。");
      console.error('       先提交：git add -A && git commit -m "说明"');
      console.error("       确认要忽略这些改动请加 --force。");
      process.exit(1);
    }
    console.warn("[部署] --force：忽略未提交改动，只部署已提交内容。");
  }

  // 2. 解析版本号
  const rev = run("git", ["rev-parse", "--short", "--verify", `${ref}^{commit}`], { capture: true });
  const commit = rev.stdout.trim();
  const log = run("git", ["log", "-1", "--format=%s（%ci）", commit], { capture: true });
  console.log(`[部署] 部署内容: ${commit} ${log.stdout.trim()}`);

  // 3. 确认
  let yes = autoYes ? "y" : "";
  if (!autoYes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    yes = await rl.question(`[部署] 确认发布到生产 ${SITE} ？(y/N) `);
    rl.close();
  }
  if (yes.trim().toLowerCase() !== "y") {
    console.log("[部署] 已取消。");
    process.exit(0);
  }

  // 4. 打包已提交代码（自动排除 .env / storage / materials 等未跟踪文件）
  fs.mkdirSync(path.resolve("storage/tmp"), { recursive: true });
  const tarball = path.resolve(`storage/tmp/deploy-${Date.now()}.tar.gz`);
  run("git", ["archive", "--format=tar.gz", "-o", tarball, commit]);
  console.log(`[部署] 已打包 (${(fs.statSync(tarball).size / 1048576).toFixed(1)} MB)`);

  try {
    // 5. 上传 + 解压覆盖 + 装依赖 + 重启
    run("scp", ["-i", KEY, "-o", "BatchMode=yes", tarball, `${HOST}:/tmp/jansee-deploy.tar.gz`]);
    console.log("[部署] 已上传，服务器开始更新…");

    const remote = [
      "set -e",
      // 数据保险①：部署前快照用户数据（保留最近 10 份）
      `mkdir -p ${APP_DIR}/backups`,
      `if [ -d ${APP_DIR}/apps/web/server/data ]; then cp -r ${APP_DIR}/apps/web/server/data ${APP_DIR}/backups/data-\$(date +%Y%m%d-%H%M%S); ls -dt ${APP_DIR}/backups/data-* | tail -n +11 | xargs -r rm -rf; fi`,
      // 数据保险②：解压强制排除数据目录，任何情况下不允许部署覆盖用户数据
      `tar -xzf /tmp/jansee-deploy.tar.gz -C ${APP_DIR} --exclude='apps/web/server/data'`,
      "rm -f /tmp/jansee-deploy.tar.gz",
      `cd ${APP_DIR}`,
      fast
        ? 'echo "[服务器] --fast 跳过 npm install"'
        : `export FFMPEG_BINARIES_URL=${NPM_MIRROR}\nnpm install --no-audit --no-fund`,
      // ffmpeg 定版：npm install 的 postinstall 会重新下载 ffmpeg-static 自带二进制（7.0.2，
      // 缺 drawtext 导致视频配音链路崩溃），必须重新指向系统 ffmpeg 6.1.1（与本地开发版本一致）。
      `if [ -x /usr/bin/ffmpeg ] && [ -d ${APP_DIR}/node_modules/ffmpeg-static ]; then ln -sf /usr/bin/ffmpeg ${APP_DIR}/node_modules/ffmpeg-static/ffmpeg; fi`,
      `sudo systemctl restart ${SERVICE}`,
      "echo [服务器] 代码已更新，服务已重启",
    ].join("\n");
    run("ssh", [...sshBase, "bash -s"], { input: remote });
  } finally {
    fs.rmSync(tarball, { force: true });
  }

  // 6. 健康检查
  const health = run(
    "ssh",
    [...sshBase, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${HEALTH_PORT}/`],
    { capture: true, allowFail: true }
  );
  const code = (health.stdout || "").trim();
  if (code === "200") {
    console.log(`[部署] 健康检查 200 ✓  完成，打开 ${SITE} 核对效果。`);
  } else {
    console.error(`[部署] 健康检查异常（HTTP ${code || "无响应"}），查看日志：`);
    console.error(`  ssh -i ${KEY} ${HOST} "sudo journalctl -u ${SERVICE} -n 50 --no-pager"`);
    process.exit(1);
  }
}

main();
