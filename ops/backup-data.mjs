// 简兮 · 业务数据自动备份（零依赖，本地/服务器通用）
// 备什么：apps/web/server/data/ 全部业务账本（订单/积分/用户/留言/主播排班/配置历史）。
//   这是全站唯一「只涨不删且不可再生」的数据，磁盘故障即全丢，必须每日备份。
// 不备什么：data/backups（防递归）、storage/（素材/成片已有时效清理，可再生）。
// 保留策略：滚动保留最近 7 份，超出自动删除。
// 用法：node ops/backup-data.mjs
//   退出码 0 = 成功；非 0 = 失败（供 cron/自动化判断）。
// 调度：本地由 WorkBuddy 每日自动化驱动；服务器部署时挂 cron（见 deploy 清单）。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'apps/web/server/data');
const OUT_DIR = path.join(ROOT, 'storage/backups');
const KEEP = 7;

if (!fs.existsSync(DATA_DIR)) {
  console.error(`[backup] 数据目录不存在: ${DATA_DIR}`);
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

// 归档名带分钟级时间戳，同日多跑不覆盖
const now = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
const archive = path.join(OUT_DIR, `data-${stamp}.tar.gz`);

try {
  // 全部用相对路径 + cwd：GNU tar 会把 Windows 盘符 `F:` 误判为远程主机，绝对路径必炸
  execFileSync(
    'tar',
    ['-czf', path.relative(ROOT, archive), '-C', path.relative(ROOT, path.dirname(DATA_DIR)), '--exclude', 'data/backups', path.basename(DATA_DIR)],
    { stdio: 'pipe', cwd: ROOT },
  );
} catch (e) {
  console.error(`[backup] tar 失败: ${e.message}`);
  process.exit(1);
}

const size = fs.statSync(archive).size;
if (size < 200) {
  // 正常至少含几十 KB JSON；过小说明打包异常，宁可报错
  console.error(`[backup] 归档过小(${size}B)，疑似异常，请检查`);
  process.exit(1);
}

// 滚动清理：只删自己命名的旧归档，不碰目录里其它东西
const old = fs
  .readdirSync(OUT_DIR)
  .filter((f) => /^data-\d{8}-\d{6}\.tar\.gz$/.test(f))
  .sort()
  .slice(0, -KEEP);
for (const f of old) fs.unlinkSync(path.join(OUT_DIR, f));

console.log(`[backup] OK ${path.basename(archive)} ${(size / 1024).toFixed(1)}KB（保留最近 ${KEEP} 份，清理 ${old.length} 份旧档）`);
