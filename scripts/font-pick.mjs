/**
 * 字体抽取器 —— 出片引擎唯一应该调用的入口
 *
 * 三个设计约束，每一条都是踩出来的：
 *
 * 1. 必须可复现（seed）。同一订单重出一次必须得到同一版式。
 *    用户改了个错字再出片，结果整张片子换了字体和版式，是灾难级体验。
 *    所以这里的"随机"全部是 seed 派生的伪随机，不是 Math.random()。
 *
 * 2. 抽的是「配对」不是「单个字体」。字体混搭会崩：马善政楷书配 Playfair 和谐，
 *    站酷快乐体配思源宋体就是灾难。随机只能在预设组合里随机。
 *
 * 3. 抽之前必过三道过滤：字号区间、中/拉丁能力、审计等级。
 *    已经踩过：仿宋 88px 会散、仿宋 17px 在深底上会糊——同一个字体两端都不可用。
 */
import fs from 'node:fs';
import path from 'node:path';

const INDEX = 'materials/fonts/index.json';

let cache = null;
export function loadRegistry() {
  if (!cache) cache = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  return cache;
}

/* ---------- seed → 确定性随机 ---------- */

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hashSeed(String(seed));
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- 可用性过滤 ---------- */

const USABLE_LEVELS = new Set(['cn-full', 'latin-only']);

function fontById(reg, id) {
  const f = reg.fonts.find((x) => x.id === id);
  if (!f) throw new Error(`字体 ${id} 不在注册表里`);
  return f;
}

function isUsable(f) {
  return f.audit && USABLE_LEVELS.has(f.audit.level);
}

/** 按角色候选池，过滤出真正能用的字体 */
function candidates(reg, role, { size } = {}) {
  const spec = reg.roles[role];
  if (!spec) throw new Error(`角色 ${role} 不存在，可用：${Object.keys(reg.roles).filter((k) => k !== '_note').join(', ')}`);

  if (size != null && (size < spec.minPx || size > spec.maxPx)) {
    throw new Error(
      `字号 ${size}px 超出角色 ${role} 的可用区间 ${spec.minPx}-${spec.maxPx}px。` +
        `这个限制来自实测：同款字体在大字号会散、在小字号会糊。`
    );
  }

  return spec.pool
    .map((id) => fontById(reg, id))
    .filter((f) => {
      if (!isUsable(f)) return false;
      if (spec.latinOnly && f.audit.cnCoverage > 0) return false; // 拉丁角色只收拉丁字体
      if (!spec.latinOnly && f.audit.cnCoverage < 99.9) return false; // 中文角色必须有满覆盖
      return true;
    });
}

/* ---------- 解析出可上版的文件 ---------- */

function resolveFile(reg, id, wantWeight) {
  const f = fontById(reg, id);
  const files = Array.isArray(f.files) ? f.files.filter((x) => typeof x === 'object') : [];
  if (!files.length) throw new Error(`字体 ${id} 没有登记字重信息`);
  const hit =
    files.find((x) => x.weight === wantWeight) ||
    files.find((x) => x.weight === 400) ||
    files[0];
  const relPath = `materials/fonts/${id}/${hit.file}`;
  const absPath = path.resolve(relPath);
  if (!fs.existsSync(absPath)) throw new Error(`字体文件不存在：${relPath}（需要重新执行 fetch）`);
  return {
    id,
    name: f.name,
    family: f.family,
    weight: hit.weight,
    file: hit.file,
    relPath,
    absPath,
    license: f.license,
    audit: { cnCoverage: f.audit.cnCoverage, level: f.audit.level, ascender: f.audit.ascender, descender: f.audit.descender },
  };
}

/* ---------- 对外 API ---------- */

/**
 * 抽一整套配对（出片引擎的主入口）
 * @param {object} opt
 * @param {string|number} opt.seed  订单号 / 内容指纹，同一 seed 永远同一结果
 * @param {string} [opt.fit]        行业关键词，命中则优先从适配该行业的配对里抽
 * @param {string} [opt.pairingId]  强制指定某套配对（用户手动选了模板时用）
 */
export function pickPairing({ seed = 'default', fit, pairingId } = {}) {
  const reg = loadRegistry();
  const rand = rng(seed);

  let pool = reg.pairings;
  if (pairingId) {
    const one = pool.find((p) => p.id === pairingId);
    if (!one) throw new Error(`配对 ${pairingId} 不存在`);
    pool = [one];
  } else if (fit) {
    const hit = pool.filter((p) => p.fit.some((k) => fit.includes(k)));
    if (hit.length) pool = hit;
  }

  const p = pool[Math.floor(rand() * pool.length)];
  return {
    pairingId: p.id,
    pairingName: p.name,
    mood: p.mood,
    fit: p.fit,
    seed,
    display: resolveFile(reg, p.display, p.displayWeight),
    latin: resolveFile(reg, p.latin, 400),
    micro: resolveFile(reg, p.micro, 400),
  };
}

/**
 * 只抽单个角色（微调某个工位时用，例如只换英文小标）
 */
export function pickFont(role, { seed = 'default', size } = {}) {
  const reg = loadRegistry();
  const pool = candidates(reg, role, { size });
  if (!pool.length) throw new Error(`角色 ${role} 在 ${size ?? '当前'} 字号下没有可用字体`);
  const rand = rng(`${seed}:${role}`);
  const f = pool[Math.floor(rand() * pool.length)];
  return resolveFile(reg, f.id, 400);
}

/** 列出所有可上版的字体（给前端字体选择器用） */
export function listUsable() {
  const reg = loadRegistry();
  return reg.fonts
    .filter(isUsable)
    .map((f) => ({
      id: f.id,
      name: f.name,
      category: f.category,
      license: f.license,
      cnCoverage: f.audit.cnCoverage,
      level: f.audit.level,
      weights: (f.files || []).filter((x) => typeof x === 'object').map((x) => x.weight),
      tags: f.tags,
    }));
}

/* ---------- CLI ---------- */

if (process.argv[1] && process.argv[1].endsWith('font-pick.mjs')) {
  const arg = (k, d) => {
    const i = process.argv.indexOf('--' + k);
    return i > 0 ? process.argv[i + 1] : d;
  };

  if (process.argv.includes('--list')) {
    console.log('\n可上版面的字体（全部 OFL 可商用）：\n');
    for (const f of listUsable()) {
      console.log(`  ${f.id.padEnd(22)} ${f.name.padEnd(34)} 字重 ${f.weights.join('/')}  中文 ${f.cnCoverage}%`);
    }
    console.log();
  } else {
    const seed = arg('seed', 'demo-001');
    const fit = arg('fit');
    const pairingId = arg('pairing');
    const r = pickPairing({ seed, fit, pairingId });
    console.log(`\nseed = ${seed}${fit ? `  fit = ${fit}` : ''}`);
    console.log(`配对 = ${r.pairingName}（${r.pairingId}）· ${r.mood}`);
    console.log(`  大标题  ${r.display.name}  ${r.display.weight}  → ${r.display.relPath}`);
    console.log(`  拉丁    ${r.latin.name}  ${r.latin.weight}  → ${r.latin.relPath}`);
    console.log(`  说明行  ${r.micro.name}  ${r.micro.weight}  → ${r.micro.relPath}\n`);
    console.log('  换一个 seed 看是否变化：');
    for (const s of ['a', 'b', 'c']) {
      const x = pickPairing({ seed: s, fit });
      console.log(`    ${s} → ${x.pairingName}`);
    }
    console.log();
  }
}
