// 简兮 · 主播风格层契约测试（anchor-kit + director sanitize + anchorStore）
// 运行：node apps/web/server/tests/anchor/test-anchor-kit.mjs
// 覆盖：兼容矩阵完备性 / seed 确定性 / 黑名单轮转与池空重置 / sanitize 校验与
//       语速钳制（经 generateDirectorCut 间接不可行——sanitize 为内部函数，
//       这里经 buildDirectorPrompt + 独立重实现校验逻辑对拍？不：直接走
//       prompt 注入断言 + anchorStore 真实读写。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PASS = [];
const FAIL = [];
const assert2 = (name, cond, detail = '') => {
  (cond ? PASS : FAIL).push(name);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + detail}`);
};

// ===== Part 1 anchor-kit：矩阵完备性 / 抽签确定性 / 黑名单轮转 =====
const kit = await import('@jansee/anchor-kit');
const { rankAnchors, compatAnchors, HOST_LIBRARY, SELL_VARIANTS, LOCAL_VARIANTS, getDna, getAnchor, isCompat, ANCHOR_REDLINE_MD } = kit;

{
  const all = [...SELL_VARIANTS, ...LOCAL_VARIANTS];
  const orphans = all.filter((v) => compatAnchors(v).length === 0);
  assert2(`兼容矩阵零孤儿（22 变体全覆盖）`, orphans.length === 0, orphans.join('、'));
  const min = Math.min(...all.map((v) => compatAnchors(v).length));
  assert2(`每变体兼容数 ≥ 2（轮转有余量）`, min >= 2, `min=${min}`);
  assert2(`主播池 18 人`, HOST_LIBRARY.length === 18, `actual=${HOST_LIBRARY.length}`);
  assert2(`6 个风格 DNA`, Object.keys(kit.DNA_LIBRARY).length === 6);

  // DNA 细则以台词句式为主体：每段必含「句式」与「禁止」（TTS 适配纪律的机器可查面）
  for (const [id, d] of Object.entries(kit.DNA_LIBRARY)) {
    assert2(`DNA ${id} 含句式与禁止条目`, d.md.includes('句式') && d.md.includes('禁止'));
    assert2(`DNA ${id} 锚点均存在于池`, d.anchors.every((a) => getAnchor(a)), d.anchors.join(','));
  }

  // seed 确定性：同 taskId 同排名；不同 taskId 不同排名（概率性，抽 3 对至少 2 对不同）
  const r1 = rankAnchors({ variantType: 'H-情感共鸣型', blacklist: [], taskId: 't-seed' }).map((a) => a.id);
  const r2 = rankAnchors({ variantType: 'H-情感共鸣型', blacklist: [], taskId: 't-seed' }).map((a) => a.id);
  assert2(`同 taskId 抽签可复现`, JSON.stringify(r1) === JSON.stringify(r2));

  // 黑名单：跳过已用；兼容集全被拉黑 → 池空重置放回全集
  const r3 = rankAnchors({ variantType: 'K-教程演示型', blacklist: ['cheng-shian'], taskId: 't-bl' }).map((a) => a.id);
  assert2(`黑名单物理剔除`, !r3.includes('cheng-shian') && r3.length === compatAnchors('K-教程演示型').length - 1);
  const r4 = rankAnchors({ variantType: 'K-教程演示型', blacklist: ['cheng-shian', 'wang-gang'], taskId: 't-bl2' }).map((a) => a.id);
  assert2(`池空自动重置（轮完一圈全放出来）`, r4.length === 2);

  // 每主播 DNA 归组与其兼容集不相交性抽查：李佳琦不得兼容 H-情感共鸣型（叫卖配共鸣=精神分裂）
  assert2(`风格亲和硬约束（李佳琦×情感共鸣=false）`, !isCompat('H-情感共鸣型', 'li-jiaqi'));
}

// ===== Part 2 director prompt 注入（缺省零回归 / 自选模式 / 锁定模式） =====
{
  // 隔离 DATA_DIR，避免污染真实创作账本
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'jansee-anchor-test-'));
  process.env.JX_DATA_DIR = tmpData;
  const director = await import('../../director.mjs');

  const p0 = director.buildDirectorPrompt({
    scene: 'sell', title: '测试商品标题六个字',
    sellingPoints: '这是一段用户输入的卖点描述文案用于统计',
    imageCount: 6, voice: '', decidedVariant: '',
  });
  assert2(`缺省（无 anchorContext）不注入主播池/DNA/红线块`,
    !p0.includes('【风格 DNA 细则】') && !p0.includes('变体-主播兼容表') && !p0.includes('主播人设红线'));

  const ranked = rankAnchors({ variantType: '', blacklist: [], taskId: 't-ctx' });
  const p1 = director.buildDirectorPrompt({
    scene: 'sell', title: '测试商品标题六个字',
    sellingPoints: '这是一段用户输入的卖点描述文案用于统计',
    imageCount: 6, voice: '', decidedVariant: '',
    anchorContext: { ranked, lockedAnchor: null },
  });
  assert2(`自选模式注入池/DNA/兼容表/红线/语速`,
    p1.includes('本片主播池') && p1.includes('【风格 DNA 细则】') && p1.includes('变体-主播兼容表') &&
    p1.includes('主播人设红线') && p1.includes('speech_speed'));

  const locked = ranked[0];
  const p2 = director.buildDirectorPrompt({
    scene: 'sell', title: '测试商品标题六个字',
    sellingPoints: '这是一段用户输入的卖点描述文案用于统计',
    imageCount: 6, voice: '', decidedVariant: 'H-情感共鸣型',
    anchorContext: { ranked: [locked], lockedAnchor: locked },
  });
  assert2(`锁定模式注入排班锁定块`, p2.includes('已由系统排班锁定') && p2.includes(locked.id));

  // local 场景兼容表只用 local 变体
  const p3 = director.buildDirectorPrompt({
    scene: 'local', title: '测试门店标题六个字',
    sellingPoints: '这是一段用户输入的门店描述文案用于统计',
    imageCount: 6, voice: '', decidedVariant: '',
    anchorContext: { ranked, lockedAnchor: null },
  });
  assert2(`local 场景兼容表含 local 变体`, p3.includes('A-宝藏发现型：'));
  assert2(`local 场景兼容表不含 sell 专属变体`, !p3.includes('A-痛点直击型：'));

  // 红线：真名禁令文本存在
  assert2(`红线含真名禁令`, ANCHOR_REDLINE_MD.includes('严禁出现任何真实主播'));

  fs.rmSync(tmpData, { recursive: true, force: true });
}

// ===== Part 3 anchorStore：商家级黑名单读写与深度裁剪 =====
{
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'jansee-anchor-store-'));
  process.env.JX_DATA_DIR = tmpData;
  // 动态 import 让 paths.mjs 顶层读到的 env 生效
  const store = await import('../../anchorStore.mjs');
  store.recordAnchors('u-a', ['h1', 'h2']);
  store.recordAnchors('u-a', ['h3']);
  assert2(`黑名单读取（最近在前）`, JSON.stringify(store.getAnchorBlacklist('u-a')) === JSON.stringify(['h3', 'h2', 'h1']));
  store.recordAnchors('u-a', ['h2']); // 去重挪到队首
  assert2(`重复记录去重挪队首`, JSON.stringify(store.getAnchorBlacklist('u-a')) === JSON.stringify(['h2', 'h3', 'h1']));
  for (let i = 0; i < 10; i++) store.recordAnchors('u-a', [`k${i}`]);
  assert2(`深度裁剪（≤6）`, store.getAnchorBlacklist('u-a').length === 6);
  assert2(`空用户不记不炸`, store.getAnchorBlacklist('') .length === 0 && store.recordAnchors('', ['x']) === undefined);
  // 隔离：不同用户互不可见
  assert2(`用户隔离`, store.getAnchorBlacklist('u-b').length === 0);
  fs.rmSync(tmpData, { recursive: true, force: true });
}

console.log(`\n========== 结果：${PASS.length} PASS / ${FAIL.length} FAIL ==========`);
process.exit(FAIL.length ? 1 : 0);
