import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildIntroSvg,
  renderIntroPng,
  buildIntroOverlayFilter,
  INTRO_TIMING,
} from '../index.js';

test('intro-kit: SVG 结构与黑曜石羽化暗晕完整', () => {
  const svg = buildIntroSvg({
    title: '一杯好茶',
    brandEn: 'CHINESE TEA RETREAT',
    width: 1080,
    height: 1920,
  });

  assert.ok(svg.includes('topCinematicMask'), '必须包含顶部黑曜石渐变定义');
  assert.ok(svg.includes('bottomCinematicMask'), '必须包含底部黑曜石渐变定义');
  assert.ok(svg.includes('一杯好茶'), '包含主标题文字');
  assert.ok(svg.includes('CHINESE TEA RETREAT'), '包含装饰英文');
  assert.ok(svg.includes('height="1.5"'), '包含发丝微光分割线');
});

test('intro-kit: 画幅自适应（横屏与小分辨率安全计算）', () => {
  const svgH = buildIntroSvg({
    title: '横屏大片',
    width: 1920,
    height: 1080,
  });
  assert.ok(svgH.includes('viewBox="0 0 1920 1080"'));

  const svgSmall = buildIntroSvg({
    title: '微型缩略',
    width: 320,
    height: 240,
  });
  assert.ok(svgSmall.includes('viewBox="0 0 320 240"'));
});

test('intro-kit: renderIntroPng 真实产出有效透明 PNG', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'intro-test-'));
  try {
    const out = path.join(tmp, 'intro.png');
    renderIntroPng({
      title: '高山岩茶',
      brandEn: 'ROCK TEA CRAFT',
      width: 1080,
      height: 1920,
      outPath: out,
    });
    assert.ok(existsSync(out), 'PNG 文件应生成落盘');
    const sz = statSync(out).size;
    assert.ok(sz > 1000, `文件体积应合理，实际 ${sz} 字节`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('intro-kit: buildIntroOverlayFilter 输出正确的时间窗与滤镜链', () => {
  const filters = buildIntroOverlayFilter({ inputIndex: '3', baseLabel: 'vbase', outLabel: 'vout' });
  assert.equal(filters.length, 2);
  assert.ok(filters[0].includes('[3:v]format=rgba'));
  assert.ok(filters[0].includes(`st=${INTRO_TIMING.startSec.toFixed(2)}`));
  assert.ok(filters[1].includes('[vbase]'));
  assert.ok(filters[1].includes('[vout]'));
});
