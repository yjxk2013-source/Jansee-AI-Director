/**
 * 结尾收束 · 确定性 seed（与 packages/image-film 的 seedFromTaskId 同族同实现）
 *
 * 同一任务必须重出同一结果：用户改个错字重出一次，整片风格（含片尾结尾卡）
 * 全换是灾难级体验。FNV-1a 与 scripts/font-pick.mjs 同族；
 * mulberry32 与 modules/visual_engine_v4/imageFilm.js 的同名实现同算法——
 * 引擎那份服务成片编排（动效/运镜/转场/结尾），本份服务结尾卡抽样域，
 * 两边必须同算法：同 taskId 在两条链路抽结尾的行为要一致。
 */
import { pickEnding } from './ending.js';

/**
 * 由 taskId 派生 32 位无符号种子。
 * @param {string} taskId
 * @returns {number} 0 ~ 2^32-1
 */
export function seedFromTaskId(taskId) {
  let h = 2166136261;
  const s = String(taskId || 'seed');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 按 taskId 直接抽一款结尾卡（seedFromTaskId → mulberry32 → pickEnding 一步到位）。
 * 同一 taskId 永远抽同一款：用户改个错字重出一次，结尾卡整个换掉是灾难级体验。
 * @param {string} taskId
 * @param {{scene?: string, endingId?: string|null}} [opts]
 * @returns {object} ENDING_ASSETS 里的一款
 */
export function pickEndingForTask(taskId, opts = {}) {
  return pickEnding(mulberry32(seedFromTaskId(taskId)), opts);
}
