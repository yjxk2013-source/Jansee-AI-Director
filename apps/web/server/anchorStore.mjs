// 简兮后端 · anchorStore.mjs —— 商家级主播黑名单（防同商家连续出片风格撞车）
//
// 机制（2026-10-24 定版）：主播风格随机池 + 两级黑名单——
//   批次内（多版成片 N 条互不重样，内存即可，creation.mjs 自持）+
//   商家级（本文件）：同一商家最近 K 次出片用过的主播进黑名单，
//   使其主页最近几条视频的主播风格天然错开——这是"替商家做的风格排班"。
//
// K = 6 的取舍：兼容集 2~4 人，黑名单过长会让兼容集常态为空、频繁触发
// rankAnchors 的池空重置，轮转语义失效；6 恰好覆盖"主页最近一屏"的可见差异。
// 落盘 DATA_DIR/anchor_ledger.json，任何异常静默吞掉，绝不影响出片主流程。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.mjs';

const LEDGER_FILE = path.join(DATA_DIR, 'anchor_ledger.json');
const BLACKLIST_DEPTH = 6;

function readAll() {
  try {
    const obj = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

/** 商家最近 K 次出片用过的主播 id（最近在前；异常返回空数组） */
export function getAnchorBlacklist(userId) {
  const key = String(userId || '').trim();
  if (!key) return [];
  const used = readAll()[key];
  return Array.isArray(used) ? used.filter((s) => typeof s === 'string' && s.trim()) : [];
}

/** 出片完成后追加主播记录（静默吞错；空 id 忽略） */
export function recordAnchors(userId, anchorIds = []) {
  const key = String(userId || '').trim();
  const ids = (Array.isArray(anchorIds) ? anchorIds : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (!key || !ids.length) return;
  try {
    const all = readAll();
    const used = Array.isArray(all[key]) ? all[key] : [];
    for (const id of ids) {
      // 去重保序：同主播重复出现时挪到队首（最近使用语义）
      const idx = used.indexOf(id);
      if (idx >= 0) used.splice(idx, 1);
      used.unshift(id);
    }
    while (used.length > BLACKLIST_DEPTH) used.pop();
    all[key] = used;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[ANCHOR LEDGER] 记录失败（不影响出片）: ${e.message}`);
  }
}
