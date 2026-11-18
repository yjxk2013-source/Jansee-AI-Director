/**
 * 结尾资产一致性校验：`@jansee/ending-kit` 的 15 款必须与 `docs/visual-gallery/v4.html` 逐条一致。
 *
 * 为什么需要这条：15 款资产是从实验室页面手工镜像到 Node 侧的，
 * 页面改一个字、节点没跟，产出就会跟实验室看到的效果不一样，而且不报错。
 * 这个测试把两边拉平——任一边单独改都会红。
 *
 * 注：真源 2026-10-24 已从本引擎提升到 @jansee/ending-kit（视频配音链路共用），
 * 对账职责留在引擎侧（v4.html 是实验室资产，跟引擎同属视觉域）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDING_ASSETS, ENDING_SCENES, endingCopyParts, endingsForScene } from '@jansee/ending-kit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const V4_HTML = path.resolve(__dirname, '../../../docs/visual-gallery/v4.html');

function labAssets() {
  const html = fs.readFileSync(V4_HTML, 'utf8');
  const m = html.match(/V4_ASSETS=(\{[\s\S]*?\});?\s*\n/);
  assert.ok(m, 'v4.html 里找不到 V4_ASSETS 定义');
  return JSON.parse(m[1]).ending;
}

test('15 款资产与 v4.html 逐字段一致（id / name / desc / scene / copyId / skelId / kind）', () => {
  const lab = labAssets();
  assert.equal(ENDING_ASSETS.length, lab.length, '款数必须一致');

  ENDING_ASSETS.forEach((mine, i) => {
    const theirs = lab[i];
    for (const key of ['id', 'name', 'desc', 'scene', 'copyId', 'skelId', 'kind']) {
      assert.equal(mine[key], theirs[key], `第 ${i + 1} 款「${mine.id}」的 ${key} 与实验室不一致`);
    }
  });
});

test('三场景各 5 款，且顺序与实验室一致', () => {
  assert.deepEqual([...ENDING_SCENES], ['personal', 'sell', 'local']);
  for (const scene of ENDING_SCENES) {
    const list = endingsForScene(scene);
    assert.equal(list.length, 5, `${scene} 必须 5 款`);
    assert.ok(list.every((e) => e.scene === scene), `${scene} 不许混入别的场景`);
  }
});

test('文案解析：每款都能切出中文与英文两段', () => {
  for (const item of ENDING_ASSETS) {
    const { zh, en } = endingCopyParts(item);
    assert.ok(zh && zh.length >= 3, `${item.id} 中文为空`);
    assert.ok(en && /[A-Z]/.test(en), `${item.id} 英文为空或非大写`);
  }
});
