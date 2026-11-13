#!/usr/bin/env node
/**
 * 简兮 (JANSEE) 官方 BGM 素材库一键同步脚本 (sync-materials.mjs)
 * 用途：换新电脑后，一键从官方云服务器极速拉取并自动解压 1.3GB 官方授权音轨曲库
 */

import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');
const materialsDir = resolve(rootDir, 'materials');
const audioDir = resolve(materialsDir, 'audio');

console.log('[JANSEE SYNC] 正在检查官方音频素材库状态...');

if (existsSync(audioDir) && existsSync(resolve(audioDir, 'corporate'))) {
  console.log('[JANSEE SYNC] 官方音频素材库已完整就绪，无需重复拉取。');
  process.exit(0);
}

mkdirSync(materialsDir, { recursive: true });

console.log('[JANSEE SYNC] 本地未检测到完整曲库，准备从官方云端执行高速同步...');

// 方案 1：优先尝试通过 SSH 从生产服务器同步 (适用于持有部署密钥的管理员/主力机)
const sshKeyPath = process.env.SSH_KEY || resolve(process.env.USERPROFILE || process.env.HOME || '', '.ssh', 'jansee_server');
const serverHost = 'ubuntu@203.195.243.42';
const remoteTar = '/srv/jansee/storage/jansee-materials-v3.tar.gz';
const localTar = resolve(rootDir, 'storage', 'jansee-materials-v3.tar.gz');

mkdirSync(resolve(rootDir, 'storage'), { recursive: true });

let synced = false;

if (existsSync(sshKeyPath)) {
  try {
    console.log(`[JANSEE SYNC] 正在通过专线 SSH 密钥从云服务器拉取全量素材包 (${remoteTar})...`);
    execSync(`scp -i "${sshKeyPath}" ${serverHost}:${remoteTar} "${localTar}"`, { stdio: 'inherit' });
    synced = true;
  } catch (err) {
    console.warn('[JANSEE SYNC] SSH 同步异常，尝试切换至 HTTPS 直链通道...', err.message);
  }
}

// 方案 2：走 HTTPS 官方直链下载 (通用无密钥场景)
if (!synced) {
  try {
    const downloadUrl = 'https://jansee.cn/storage/outputs/jansee-materials-v3.tar.gz';
    console.log(`[JANSEE SYNC] 正在通过官方 CDN/直链下载素材包: ${downloadUrl}`);
    execSync(`curl.exe -L -o "${localTar}" "${downloadUrl}"`, { stdio: 'inherit' });
    synced = true;
  } catch (err) {
    console.error('[JANSEE SYNC] 无法从官方直链下载素材包，请联系架构师或检查网络连接。');
    process.exit(1);
  }
}

if (synced && existsSync(localTar)) {
  console.log('[JANSEE SYNC] 素材包下载完成，正在自动解压到 materials/ 目录...');
  try {
    execSync(`tar -xzf "${localTar}" -C "${rootDir}"`, { stdio: 'inherit' });
    console.log('[JANSEE SYNC] 解压成功！全量 1.3GB 官方音频曲库已 100% 完整就绪。');
  } catch (err) {
    console.error('[JANSEE SYNC] 解压失败:', err);
    process.exit(1);
  }
}
