// prompt 基线重建工具（阶段 D 验收引入）：在固定隔离账本种子下重建 baseline/{scene}.txt
// 用途：stage-a / stage-b 的图片场景零回归断言（逐字节比对）依赖确定性账本状态，
//       基线必须与本种子一一对应；种子或 prompt 逻辑变更时重跑本脚本并随测试资产同步审查。
// 运行：node apps/web/server/tests/video-dub/baseline/regen-prompt-baseline.mjs （仅写 baseline/ 下基线文件，不触碰真实业务账本）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const SEED_DIR = path.join(ROOT, 'scratch/prompt-baseline-data');
fs.rmSync(SEED_DIR, { recursive: true, force: true });
fs.mkdirSync(SEED_DIR, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'apps/web/server/tests/video-dub/baseline/ledger-seed.json'), path.join(SEED_DIR, 'creative_ledger.json'));
process.env.JX_DATA_DIR = SEED_DIR; // 必须先于 director.mjs 动态 import（paths.mjs 顶层读 env）

const { buildDirectorPrompt } = await import('../../../director.mjs');

// 入参与 test-stage-a / test-stage-b 的 Part 4 断言严格一致（单一事实来源）
const CASES = [
  ['sell', 'A-痛点直击型'],
  ['local', 'B-宝藏发现型'],
  ['personal', ''],
];
for (const [scene, variant] of CASES) {
  const cur = buildDirectorPrompt({
    scene, title: '测试商品标题六个字',
    sellingPoints: '这是一段用户输入的卖点描述文案用于统计',
    imageCount: 6, voice: '', decidedVariant: variant,
  });
  fs.writeFileSync(path.join(ROOT, `apps/web/server/tests/video-dub/baseline/${scene}.txt`), cur, 'utf8');
  console.log(`[Regen] ${scene}.txt 已重建（${cur.split('\n').length} 行，含种子账本注入=${cur.includes('test_open_a')}）`);
}
console.log('[Regen] 基线重建完成（隔离种子：apps/web/server/tests/video-dub/baseline/ledger-seed.json）');
