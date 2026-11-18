# 简兮 V4 图片成片执行引擎

全平台**唯一**的图片成片引擎。旧链路（V1 单体合成器 `ffmpeg-kit/composer.js`、旧封面系统 `packages/cover-kit`、
旧视觉编排 `visualComposerRules.js`、本模块第一版 `renderer.js`）已于 2026-10-23 全部删除。

## 职责边界

执行层只负责"把已经定好的东西渲染出来"，不做任何创意决策：

- **不调 LLM**（台词、小主题、英文标尺由上游导演层给）
- **不调 TTS**（配音文件由上游给，每镜时长按 TTS 实测值累加）
- **不选版式**（版式与字体配对由调用方传入；同一单全片只用一套）

确定性：所有随机（文字动效 / 运镜 / 转场 / 结尾款）都吃同一个 `seed`，
同一单重出结果一致。

## 四层结构

| 文件 | 职责 |
|---|---|
| `layouts.js` | 洞位几何（竖/方/横三档）+ T1–T5 五套版式 + 字体配对派生 + 墨迹系数 |
| `ending.js` → `packages/ending-kit` | 结尾收束 15 款（3 场景 × 5 款），镜像 `docs/visual-gallery/v4.html`；2026-10-24 提升为独立包（视频配音链路共用），引擎经 index re-export |
| `imageFilm.js` | 编排（`planImageFilm`）+ 滤镜图（`buildFilmFilterGraph`）+ 渲染（`renderImageFilm`） |
| `index.js` | 唯一导出入口 |

## 用法

```js
import { renderImageFilm } from '@jansee/visual-engine-v4';

await renderImageFilm({
  shots: [
    { imagePath: '/path/a.jpg', durationSec: 3.72, copy: { title: '手作奶咖', label: 'EST. 2019', idx: '01 / 03', site: 'JANSEE.CN' } },
    { imagePath: '/path/b.jpg', durationSec: 4.05, copy: { title: '甜一点', label: 'BAKERY', idx: '02 / 03', site: 'JANSEE.CN' } },
  ],
  layoutId: 'layout_t1',
  pairingId: 'modern-editorial',
  seed: 20261023,
  outputPath: '/path/film.mp4',
  workDir: '/path/work',
  audio: { voiceClips: [{ file: '/path/line0.mp3' }, { file: '/path/line1.mp3' }] },
  cta: { scene: 'local', brandZh: 'CORNER BAKE', brandEn: '' },
});
```

`durationSec` 必须由上游给（TTS 实测），引擎不估算；缺失直接报错。
`cta.scene` 决定从哪个场景的 5 款里抽结尾（`sell` / `local` / `personal`），
也可以用 `endingId` 直指某一款。

## 三层分离（渲染纪律）

1. **图片层**：只做运镜（`sweep_LR` / `sweep_RL` / `rise_up`）和镜间转场（`cut` / `slide`）
2. **版面层**：只做文字入场动效（`fade_in` / `fade_up` / `slide_in` / `quick_wipe`），坐标全片固定
3. **结尾层**：`fadeblack` 淡到纯黑 → 停 0.35s → 结尾卡淡入

文字**不参与**转场与运镜。因此文字淡入必须晚于转场结束、淡出必须早于镜边界 ≥2 帧，
否则 `overlay eof_action=pass` 会把残帧冻到片尾（实测踩过）。

## 性能

手机原图 4000×6000 直接交给 ffmpeg 是逐帧重采样，4 秒素材要 17.9s。
引擎先用 sharp 预缩到"过扫描后的目标尺寸"，同一条素材降到 2.05s，滤镜图不变。

## 已知未做

- BGM 混音与 duck（`audio-kit/buildDuckFilter` 现成，未接）
- `quick_wipe` 动效（枚举里有，滤镜未实现）
- 未接入 web 服务（`creation.mjs` 的 `image_creator` 分支仍是占位）
