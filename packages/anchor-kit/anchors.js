// 简兮 · 主播池与变体兼容矩阵（唯一事实源）
//
// 主播池 = 真实头部主播的风格锚点（内部 prompt 语料先验用，输出端禁真名）。
// compat 键 = prompt/index.js 的变体全名（'A-痛点直击型' 等，sell/local 同名字母
// 全名不同不会撞）。兼容矩阵与 director-sell.md / director-local.md 的「推荐主播」
// 列保持同源——md 是人读的表，这里是机器可执行版，两边改一处必改另一处。
//
// 每个主播附推荐气质 key（tts-kit TEMPERAMENTS 抽象层，供应商无关）：
// prompt 里作为 voice_id 推荐注入，LLM 仍可按商品调性改选，sanitize 只校验合法性不校验来源。

import { DNA_LIBRARY, LOCAL_ROLE_LIBRARY } from './dna.js';

export { LOCAL_ROLE_LIBRARY };

/** 实体角色列表 */
export const LOCAL_ROLES = Object.values(LOCAL_ROLE_LIBRARY);

/** 实体角色兼容表（按 local 8 大变体分配） */
export const LOCAL_ROLE_COMPAT = {
  'A-宝藏发现型': ['local-friend', 'shopowner'],
  'B-性价比种草型': ['budget-guide', 'shopowner'],
  'C-环境氛围型': ['local-friend', 'craftsman'],
  'D-硬核测评型': ['craftsman', 'budget-guide'],
  'E-避坑提醒型': ['local-friend', 'budget-guide'],
  'F-限时活动型': ['shopowner', 'budget-guide'],
  'G-信任背书型': ['shopowner', 'craftsman'],
  'H-高客单沉稳型': ['shopowner', 'craftsman'],
};

/** 按 id 获取实体角色 */
export function getLocalRole(id) {
  const r = LOCAL_ROLE_LIBRARY[String(id || '').trim()];
  return r ? { ...r } : null;
}

/** sell 场景 14 变体全名（与 prompt/index.js SELL_VARIANT_TYPES 逐字一致） */
export const SELL_VARIANTS = [
  'A-痛点直击型', 'B-反差对比型', 'C-福利低价型', 'D-场景代入型', 'E-证言型',
  'F-紧迫逼单型', 'G-结果先行型', 'H-情感共鸣型', 'I-权威专业型', 'J-反转型/避坑型',
  'K-教程演示型', 'L-信任测评型', 'M-数字冲击型', 'N-保障安心型',
];

/** local 场景 8 变体全名（与 prompt/index.js LOCAL_VARIANT_TYPES 逐字一致） */
export const LOCAL_VARIANTS = [
  'A-宝藏发现型', 'B-性价比种草型', 'C-环境氛围型', 'D-硬核测评型',
  'E-避坑提醒型', 'F-限时活动型', 'G-信任背书型', 'H-高客单沉稳型',
];

/**
 * 主播池（18 人）：id 稳定不可改（黑名单/账本引用它）；name 只做 prompt 锚点展示。
 * compat 值域：sell/local 变体全名。
 */
export const HOST_LIBRARY = [
  // ===== sell 主力（头部综合带货）=====
  { id: 'li-jiaqi', name: '李佳琦', dna: 'hard-sell', compat: ['B-反差对比型', 'C-福利低价型', 'F-紧迫逼单型'], temperaments: ['f-passion', 'm-sunny'] },
  { id: 'xin-ba', name: '辛巴', dna: 'hard-sell', compat: ['B-反差对比型', 'C-福利低价型', 'F-紧迫逼单型', 'M-数字冲击型', 'F-限时活动型'], temperaments: ['m-sunny', 'f-passion'] },
  { id: 'guangdong-fufu', name: '广东夫妇', dna: 'hard-sell', compat: ['C-福利低价型', 'D-场景代入型', 'F-紧迫逼单型', 'F-限时活动型'], temperaments: ['f-bright', 'm-sunny'] },
  { id: 'dong-yuhui', name: '董宇辉', dna: 'old-friend', compat: ['H-情感共鸣型', 'I-权威专业型'], temperaments: ['m-warm', 'f-soft'] },
  { id: 'dundun', name: '东方甄选顿顿', dna: 'old-friend', compat: ['H-情感共鸣型'], temperaments: ['f-soft', 'm-warm'] },
  { id: 'luo-yonghao', name: '罗永浩', dna: 'old-friend', compat: ['E-证言型', 'I-权威专业型', 'N-保障安心型', 'H-高客单沉稳型'], temperaments: ['m-calm', 'm-deep'] },
  { id: 'xiao-yang-ge', name: '疯狂小杨哥', dna: 'theater', compat: ['B-反差对比型', 'G-结果先行型', 'J-反转型/避坑型', 'E-避坑提醒型'], temperaments: ['m-sunny', 'f-bright'] },
  { id: 'b-tai', name: 'B太', dna: 'theater', compat: ['A-痛点直击型', 'G-结果先行型', 'J-反转型/避坑型', 'E-避坑提醒型', 'D-硬核测评型'], temperaments: ['m-calm', 'm-sunny'] },
  { id: 'laoba-pingce', name: '老爸评测', dna: 'lab-report', compat: ['A-痛点直击型', 'L-信任测评型', 'D-硬核测评型'], temperaments: ['m-calm', 'm-warm'] },
  { id: 'luo-wangyu', name: '骆王宇', dna: 'lab-report', compat: ['L-信任测评型'], temperaments: ['m-warm', 'f-soft'] },
  { id: 'cheng-shian', name: '程十安', dna: 'lab-report', compat: ['K-教程演示型'], temperaments: ['f-soft', 'f-warm'] },
  { id: 'wang-gang', name: '美食作家王刚', dna: 'lab-report', compat: ['K-教程演示型'], temperaments: ['m-calm', 'm-deep'] },
  { id: 'caihong-fufu', name: '彩虹夫妇', dna: 'ledger', compat: ['M-数字冲击型', 'D-场景代入型'], temperaments: ['f-bright', 'm-sunny'] },
  { id: 'dong-xiansheng', name: '董先生珠宝', dna: 'old-friend', compat: ['I-权威专业型', 'N-保障安心型', 'H-高客单沉稳型'], temperaments: ['m-calm', 'm-deep'] },

  // ===== 乡土唠嗑（农产品/土特产/手工艺商家刚需，现有池覆盖不了的风格）=====
  { id: 'yu-jie', name: '东北雨姐', dna: 'rural-chat', compat: ['A-痛点直击型', 'E-证言型', 'H-情感共鸣型', 'G-信任背书型'], temperaments: ['f-warm', 'm-deep'] },
  { id: 'taozi-jie', name: '蜀中桃子姐', dna: 'rural-chat', compat: ['D-场景代入型', 'E-证言型', 'H-情感共鸣型', 'G-信任背书型'], temperaments: ['f-warm', 'm-warm'] },
  { id: 'liangshan-jige', name: '李子坝梁山鸡', dna: 'rural-chat', compat: ['A-宝藏发现型', 'B-性价比种草型', 'C-环境氛围型', 'G-信任背书型'], temperaments: ['m-warm', 'm-sunny'] },

  // ===== local 探店补位 =====
  { id: 'xiaobei-ele', name: '小贝饿了', dna: 'theater', compat: ['A-宝藏发现型', 'B-性价比种草型', 'C-环境氛围型'], temperaments: ['f-bright', 'f-warm'] },
];

export const ALL_HOST_IDS = HOST_LIBRARY.map((h) => h.id);
const HOST_BY_ID = new Map(HOST_LIBRARY.map((h) => [h.id, h]));

/** 按 id 取主播（不存在返回 null） */
export function getAnchor(id) {
  return HOST_BY_ID.get(String(id || '').trim()) || null;
}

/**
 * 变体 → 兼容主播 id 列表（矩阵反向索引，进程内缓存一次构建）。
 * 未知名一律忽略不抛错（md 与代码同源漂移时不炸任务）。
 */
let compatIndex = null;
export function compatAnchors(variantType) {
  const key = String(variantType || '').trim();
  if (!key) return [];
  if (!compatIndex) {
    compatIndex = new Map();
    for (const h of HOST_LIBRARY) {
      for (const v of h.compat) {
        if (!compatIndex.has(v)) compatIndex.set(v, []);
        compatIndex.get(v).push(h.id);
      }
    }
  }
  return (compatIndex.get(key) || []).slice();
}

/** 主播是否兼容某变体 */
export function isCompat(variantType, anchorId) {
  return compatAnchors(variantType).includes(String(anchorId || '').trim());
}

/** DNA 细则（含 label），未知 id 返回 null */
export function getDna(dnaId) {
  const d = DNA_LIBRARY[String(dnaId || '').trim()];
  return d ? { ...d } : null;
}

/** 池内全量 DNA 概览（prompt 注入用：id + label + 锚点名） */
export function dnaOverview() {
  return Object.entries(DNA_LIBRARY).map(([id, d]) => ({
    id,
    label: d.label,
    anchors: d.anchors.map((a) => HOST_BY_ID.get(a)?.name || a).join('、'),
  }));
}
