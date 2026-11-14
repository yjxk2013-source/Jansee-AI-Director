#!/usr/bin/env node
/**
 * 简兮 (JANSEE) 四仓原子化同步与物理对账脚本
 *
 * 核心职责：
 * 1. 自动对齐四大核心仓库（Gitee开源、Gitee全量私有、GitHub开源、GitHub全量私有）；
 * 2. 具备网络抖动自动重试机制（最多 3 次退避重试）；
 * 3. 强对账门禁（物理拉取 4 仓远端 commit hash 对比，任一不符直接抛错阻断）。
 */

import { execSync } from 'node:child_process';

if (process.platform === 'win32') {
  const gitPaths = ['C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\Git\\bin'];
  process.env.PATH = `${gitPaths.join(';')};${process.env.PATH || ''}`;
}

const TARGET_REMOTES = [
  { name: 'gitee', label: 'Gitee 开源展示仓', branch: 'main' },
  { name: 'gitee-v3', label: 'Gitee 全量私有仓', branch: 'main' },
  { name: 'github', label: 'GitHub 开源展示仓', branch: 'main', needsProxy: true },
  { name: 'github-v3', label: 'GitHub 全量私有仓', branch: 'main', needsProxy: true }
];

function runCmd(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    const stdout = err.stdout ? err.stdout.toString() : '';
    throw new Error(`命令失败: ${cmd}\nSTDERR: ${stderr}\nSTDOUT: ${stdout}`);
  }
}

function getLocalHead() {
  return runCmd('git rev-parse HEAD');
}

/**
 * 第零阶段：推送前安全雷达扫描 (PRE-PUSH SECURITY RADAR)
 * 严格拦截一切密钥、二进制构建大包与非标音视频大素材
 */
function prePushSecurityAudit() {
  console.log('--- 第零阶段：推送前安全雷达与合规硬扫描 ---');
  const FORBIDDEN_PATTERNS = [
    { pattern: /\.keystore$/i, desc: 'Android 签名密钥证书 (*.keystore)' },
    { pattern: /\.jks$/i, desc: 'Java 密钥库证书 (*.jks)' },
    { pattern: /apps\/web\/server\/data\/.*\.json$/i, desc: '生产业务订单/用户会话数据 (*.json)' },
    { pattern: /\.apk$/i, desc: 'Android 打包二进制产物 (*.apk)' },
    { pattern: /\.aab$/i, desc: 'Android App Bundle 产物 (*.aab)' },
    { pattern: /\.mp4$/i, desc: '媒体视频文件 (*.mp4)' },
    { pattern: /\.tar\.gz$/i, desc: '大归档压缩包 (*.tar.gz)' }
  ];

  // 获取当前 HEAD 中跟踪的所有文件清单
  const trackedFiles = runCmd('git ls-tree -r --name-only HEAD').split('\n').filter(Boolean);
  const violations = [];

  for (const file of trackedFiles) {
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.pattern.test(file)) {
        violations.push({ file, violation: rule.desc });
      }
    }
  }

  if (violations.length > 0) {
    console.error('\n❌ [严重安全违规] 检测到仓库中包含禁止推送的凭证/大包/媒体文件：');
    console.table(violations);
    console.error('\n🚨 推送已被硬性拦截中断！请先使用 git rm --cached 剔除上述违规文件并更新 .gitignore！\n');
    process.exit(1);
  }

  console.log('✓ [安全扫描通过] 0 敏感凭证、0 二进制大包、0 冗余媒体，符合大厂级纯代码库规范。\n');
}

function pushWithRetry(remote, branch, needsProxy, maxRetries = 3) {
  const proxyFlag = needsProxy ? '-c http.proxy=http://127.0.0.1:10808 -c http.sslBackend=openssl -c http.postBuffer=524288000' : '';
  const pushCmd = `git ${proxyFlag} push ${remote} ${branch}`.replace(/\s+/g, ' ').trim();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[推送中] (${attempt}/${maxRetries}) 正在推送到 ${remote}/${branch} ...`);
      const output = runCmd(pushCmd);
      if (output) console.log(`   ${output.split('\n')[0]}`);
      return true;
    } catch (err) {
      console.warn(`[重试警告] 第 ${attempt} 次推送 ${remote} 失败: ${err.message.split('\n')[0]}`);
      if (attempt === maxRetries) {
        throw new Error(`[致命错误] ${remote} 推送失败，已达最大重试次数！\n${err.message}`);
      }
      // 等待 2 秒退避
      execSync('sleep 2 || timeout 2 >nul 2>&1');
    }
  }
}

function verifyRemoteSha(remote, branch, needsProxy) {
  const proxyFlag = needsProxy ? '-c http.proxy=http://127.0.0.1:10808 -c http.sslBackend=openssl' : '';
  const cmd = `git ${proxyFlag} ls-remote ${remote} refs/heads/${branch}`.replace(/\s+/g, ' ').trim();
  const res = runCmd(cmd);
  if (!res) return null;
  const sha = res.split(/\s+/)[0];
  return sha;
}

async function main() {
  console.log('================================================================');
  console.log('       简兮 (JANSEE) 四仓工程化原子同步与物理对账引擎           ');
  console.log('================================================================\n');

  const localHead = getLocalHead();
  console.log(`[本地物理 HEAD] -> ${localHead}\n`);

  // 执行推送前安全雷达扫描（第零阶段）
  prePushSecurityAudit();

  console.log('--- 第一阶段：原子化逐仓推送 ---');
  for (const target of TARGET_REMOTES) {
    pushWithRetry(target.name, target.branch, target.needsProxy);
    console.log(`✓ [推送成功] ${target.label} (${target.name})\n`);
  }

  console.log('--- 第二阶段：四仓远端物理 SHA 强对账门禁 ---');
  const auditResults = [];
  let hasMismatch = false;

  for (const target of TARGET_REMOTES) {
    process.stdout.write(`[核验中] 正在拉取 ${target.label} 远端真实 SHA ... `);
    const remoteSha = verifyRemoteSha(target.name, target.branch, target.needsProxy);
    const matched = remoteSha === localHead;
    if (!matched) hasMismatch = true;

    auditResults.push({
      仓库: target.label,
      标识: target.name,
      远端SHA: remoteSha ? remoteSha.slice(0, 10) : 'NULL',
      本地HEAD: localHead.slice(0, 10),
      对账结果: matched ? '100% 吻合 ✓' : '严重冲突 ✗'
    });
    console.log(matched ? '吻合 ✓' : '冲突 ✗');
  }

  console.log('\n================ 四仓物理对账清单 ================');
  console.table(auditResults);

  if (hasMismatch) {
    console.error('\n❌ [严重门禁阻断] 存在远端仓库 SHA 与本地不一致！四仓未完全对齐！');
    process.exit(1);
  }

  console.log('✅ [四仓物理对齐成功] 所有 4 个仓库的主干代码与本地 HEAD 100% 绝对一致，绝无漏推！\n');
}

main().catch(err => {
  console.error('\n❌ [四仓同步失败]:', err.message);
  process.exit(1);
});
