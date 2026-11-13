/**
 * @jansee/anchor-kit —— 主播风格中台（对外唯一 API 单门）
 *
 * 职责：主播池 + 6 风格 DNA + 变体兼容矩阵 + seed 抽签（黑名单轮转）。
 * 不碰 LLM、不碰文件系统（黑名单持久化由 app 侧 anchorStore 负责）。
 *
 * 消费方（prompt 注入与 sanitize 校验）：
 *   import { rankAnchors, getAnchor, getDna, dnaOverview, ANCHOR_REDLINE_MD } from '@jansee/anchor-kit';
 *
 * prompt 注入块组装见 buildAnchorContextBlock（director.mjs 侧）——
 * 本包只出原料（排名/DNA 文本/红线），不掺 JSON 契约措辞，契约唯一真源在 constitution.md。
 */
export {
  HOST_LIBRARY,
  ALL_HOST_IDS,
  SELL_VARIANTS,
  LOCAL_VARIANTS,
  LOCAL_ROLES,
  LOCAL_ROLE_COMPAT,
  LOCAL_ROLE_LIBRARY,
  getLocalRole,
  getAnchor,
  compatAnchors,
  isCompat,
  getDna,
  dnaOverview,
} from './anchors.js';
export { DNA_LIBRARY, ANCHOR_REDLINE_MD } from './dna.js';
export { rankAnchors, pickAnchor } from './pick.js';

