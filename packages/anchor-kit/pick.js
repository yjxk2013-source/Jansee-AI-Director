// 简兮 · 主播抽签（seed 驱动 + 黑名单轮转）
//
// 机制（2026-10-24 与用户定版）：
//   命中变体 → 兼容集（硬约束，防「叫卖配情感共鸣」的精神分裂）
//            → 剔除黑名单（批次内 + 商家级，物理剔除）
//            → seed 洗牌取排名 → 抽中者入两级黑名单 → 池空自动重置（忽略黑名单返回全集）。
//
// seed 哲学与版式/结尾卡同源：同 taskId 可复现，新任务自动差异。
// 洗牌用 mulberry32（确定性 PRNG），seed 由 @jansee/ending-kit 的 seedFromTaskId 派生。

import { seedFromTaskId } from '@jansee/ending-kit';
import { HOST_LIBRARY, compatAnchors, getAnchor } from './anchors.js';

/** mulberry32：小而稳的确定性 PRNG（32 位种子） */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates 确定性洗牌（不改动入参） */
function seededShuffle(list, seedNum) {
  const arr = list.slice();
  const rand = mulberry32(seedNum >>> 0);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 变体主播排名：兼容集 ∖ 黑名单，seed 洗牌后返回主播对象列表（含 DNA 与推荐气质）。
 * 黑名单把兼容集全吃掉时自动忽略黑名单（轮完一圈重新放出来，永不空转卡死）。
 *
 * @param {object} p
 * @param {string} [p.variantType] 变体全名（'A-痛点直击型'）；空串/未知名 → 全池洗牌
 * @param {string[]} [p.blacklist] 已用主播 id（批次内 + 商家级合并后的并集）
 * @param {string}  [p.taskId]     派生 seed（同 taskId 同排名，可复现）
 * @param {number}  [p.seed]       显式 seed（优先于 taskId）
 * @returns {Array<object>} 排好序的主播对象（HostLibrary 项），可能为空（池配置错误时）
 */
export function rankAnchors({ variantType = '', blacklist = [], taskId = '', seed = 0 } = {}) {
  const bl = new Set((Array.isArray(blacklist) ? blacklist : []).map((s) => String(s).trim()).filter(Boolean));
  const compatible = String(variantType || '').trim() ? compatAnchors(variantType) : HOST_LIBRARY.map((h) => h.id);

  let alive = compatible.filter((id) => !bl.has(id));
  if (!alive.length) alive = compatible.slice(); // 轮完一圈：全部放出来重新轮

  const seedNum = Number(seed) > 0 ? Number(seed) : seedFromTaskId(String(taskId || 'jansee-anchor'));
  const shuffled = seededShuffle(alive, seedNum);
  return shuffled.map((id) => getAnchor(id)).filter(Boolean);
}

/** 便捷取首名（等价 rankAnchors(...)[0] || null） */
export function pickAnchor(opts) {
  return rankAnchors(opts)[0] || null;
}
