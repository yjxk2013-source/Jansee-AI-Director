export {
  CANVAS,
  DISPLAY_INK,
  FONTS_ROOT,
  LAYOUTS,
  SLOT_DEF,
  buildLayoutBody,
  buildLayoutSvg,
  fontFilesFor,
  imageBoxFor,
  layoutById,
  resolvePairing,
  slotForRatio,
  slotKeyForRatio,
} from './layouts.js';
/* 结尾收束（15 款 CTA 卡）真源在 @jansee/ending-kit——视频配音链路共用同一份，
   这里 re-export 保持引擎既有对外接口（含 tests 的 import 路径习惯）。 */
export {
  ENDING_ASSETS,
  ENDING_FONTS,
  ENDING_SCENES,
  ENTRY_TO_SCENE,
  buildEndingSvg,
  endingCopyParts,
  endingsForScene,
  pickEnding,
} from '@jansee/ending-kit';
export {
  FILM_DEFAULTS,
  MOTIONS,
  TEXT_ANIMS,
  TRANSITIONS,
  buildFilmFilterGraph,
  mulberry32,
  planImageFilm,
  renderImageFilm,
  renderLayoutPng,
  renderSubtitlePng,
} from './imageFilm.js';
export {
  SUBTITLE_FONT,
  SUBTITLE_PLAN,
  SUBTITLE_STYLE,
  buildSubtitleCardSvg,
} from './subtitle.js';
