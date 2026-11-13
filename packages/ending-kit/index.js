/**
 * @jansee/ending-kit —— 结尾收束能力包（对外统一出口）
 *
 * 15 款 CTA 资产（3 场景 × 5 款，骨架 + 文案固定搭配）+ PNG 渲染 +
 * 确定性 seed + 片尾时间口径。图片成片（@jansee/image-film → 视觉引擎）与
 * 视频配音（@jansee/video-dub）两条链路共用同一份真源：
 * 同一单在两处看到的片尾必须是同一张脸。
 */
export {
  ENDING_ASSETS,
  ENDING_FONTS,
  ENDING_SCENES,
  ENTRY_TO_SCENE,
  buildEndingSvg,
  endingCopyParts,
  endingsForScene,
  pickEnding,
  sceneForEngine,
} from './ending.js';
export { ENDING_TAIL, FONTS_ROOT, renderEndingPng } from './render.js';
export { pickEndingForTask, seedFromTaskId } from './seed.js';
// 通用尾段追加（2026-10-24 全版块收束下沉）：口播 / 分镜直出 / 分镜 AI 配音出片后追加结尾卡
export { appendEndingTail, fitEndingCard } from './tail.js';
