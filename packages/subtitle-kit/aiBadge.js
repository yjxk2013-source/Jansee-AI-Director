// 简兮 · AI 生成内容标识单一真源（显式角标 + 隐式元数据）
//
// 国标 GB 45438-2025 双标识定版（2026-10-24）：
//   显式：两段式角标——开头 2.5s「AI 生成」+ 结尾 2.5s「本视频由 AI 生成 · JANSEE」（宣传位），
//         字号 = 画面短边 5%（1080 宽即 54px），左上角。
//         国标要素：必须同时含「AI（或人工智能）」+「生成（或合成）」，只写「AI」不合规。
//   隐式：mp4 元数据（movflags +use_metadata_tags），平台算法读字段判 AIGC，缺了会限流。
//
// 两条技术路线都从这里出，调用方不许自带字体、不许手抄字段：
//   - drawtext 路线（4 条视频链路）：buildAiBadgeOverlay（subtitle.js，字体缺省取本文件真源）
//   - PNG overlay 路线（图片成片）：renderAiBadgePng（本文件）
// 字体唯一真源 = materials/fonts OFL 库（思源黑），Windows 系统字体不得进生产。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/* packages/subtitle-kit → packages → 仓库根 */
const REPO_ROOT = path.resolve(__dirname, '../../');

/** 角标规则常量：文案 / 时长 / 字号比例 / 位置。改这里，全平台生效。 */
export const AI_BADGE = Object.freeze({
  headText: 'AI 生成',
  tailText: '本视频由 AI 生成 · JANSEE',
  headSec: 2.5,
  tailSec: 2.5,
  fontSizeRatio: 0.05, /* 国标下限：文字高度 ≥ 画面短边 5% */
  x: 130, /* 移动端安全区距左 */
  y: 120, /* 移动端安全区距顶（防挖孔与状态栏） */
});

/**
 * AI 标识字体唯一真源（绝对路径）。OFL 思源黑 Regular——中文渲染零 Tofu、商用零版权风险。
 * 任何链路的 AI 标识（角标/元数据渲染）字体只许从这里拿，不许再传 Windows 系统字体。
 */
export function aiBadgeFontFile() {
  const materials = process.env.JX_MATERIALS_ROOT || path.resolve(REPO_ROOT, 'materials');
  const p = path.join(materials, 'fonts', 'noto-sans-sc', 'NotoSansSC_400Regular.ttf');
  if (!fs.existsSync(p)) {
    throw new Error(`aiBadge: 字体真源缺失 ${p}（materials/fonts 必须随仓库走）`);
  }
  return p;
}

/**
 * 隐式标识元数据（ffmpeg -metadata 键值对数组）。字段口径全平台唯一一份：
 * Label/ContentProducer/ProduceID/ReservedCode1/title/comment/ai_generated/provider/content_id。
 * @param {string} taskId 任务 ID（ProduceID/content_id 用它溯源到具体一次出片）
 * @returns {Array<[string,string]>}
 */
export function buildAiMetaTags(taskId) {
  const id = String(taskId || '').trim();
  return [
    ['Label', 'AIGC'],
    ['ContentProducer', 'Jansee'],
    ['ProduceID', id],
    ['ReservedCode1', 'JANSEE'],
    ['title', 'AI 生成视频 - Jansee'],
    ['comment', `AI-Generated:true; Provider:Jansee; ContentID:${id}`],
    ['ai_generated', '1'],
    ['provider', 'Jansee'],
    ['content_id', id],
  ];
}

/** buildAiMetaTags 的 ffmpeg 参数扁平形式：['-metadata', 'K=V', ...] 直接 push 进 args */
export function aiMetaArgs(taskId) {
  const out = [];
  for (const [k, v] of buildAiMetaTags(taskId)) out.push('-metadata', `${k}=${v}`);
  return out;
}

function escapeXmlText(t) {
  return String(t)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * AI 标识 PNG：整幅画布透明底、文字钉在左上角（调用方渲染后走 trimAlphaBBox 裁边提速）。
 * 与 drawtext 版同一套规则常量（AI_BADGE）、同一款字体（思源黑 Regular）——
 * 两条链路的角标是同一张脸。字形参数（fill/描边/基线比例）与原引擎内联版逐像素一致。
 * @param {string} text 角标文案（AI_BADGE.headText / tailText）
 * @param {string} outPath
 * @param {{width?:number, height?:number}} sizes 画布尺寸（图片成片 1080×1920）
 */
export function renderAiBadgePng(text, outPath, { width = 1080, height = 1920 } = {}) {
  const shortEdge = Math.min(width, height);
  const fsz = Math.max(24, Math.round(shortEdge * AI_BADGE.fontSizeRatio));
  const baseline = AI_BADGE.y + fsz * 0.78;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<text x="${AI_BADGE.x}" y="${baseline.toFixed(1)}" font-family="Noto Sans SC" font-size="${fsz}" ` +
    `fill="#F8FAFC" stroke="#0A0A0E" stroke-opacity="0.3" stroke-width="1" paint-order="stroke">` +
    `${escapeXmlText(text)}</text></svg>`;
  const png = new Resvg(svg, {
    font: { fontFiles: [aiBadgeFontFile()], loadSystemFonts: false, defaultFontFamily: 'Noto Sans SC' },
    fitTo: { mode: 'width', value: width },
  })
    .render()
    .asPng();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, png);
  return outPath;
}
