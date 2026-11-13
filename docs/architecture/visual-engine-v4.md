# V4 图片成片执行引擎

> 本文档原名「V4 独立商品窗口视觉引擎」，描述的是本模块的第一版实现（模板 manifest + 固定窗口轮播，
> 只做"图放进洞 + 交叉淡化"，无版式、无文字、无音轨）。那一版连同 `renderer.js` / `manifest.js` /
> 绿幕模板契约已于 2026-10-23 整体删除。以下为现行实现。

## 定位

全平台**唯一**的图片成片引擎。执行层，不做创意决策：

- 不调 LLM（台词 / 小主题 / 英文标尺由导演层给）
- 不调 TTS（配音文件由上游给，每镜时长按 TTS 实测累加）
- 不选版式（版式与字体配对由调用方传入，同一单全片一套）

## 模块边界

- 实现：`modules/visual_engine_v4/`（`layouts.js` / `imageFilm.js` / `index.js`）+ `packages/ending-kit/`（结尾收束 15 款，2026-10-24 提升为独立包，视频配音链路共用）
- 版面与配对真源：`docs/visual-gallery/v4.html`；字体真源：`materials/fonts/index.json`
- 结尾真源：`docs/visual-gallery/v4.html` 的 `V4_ASSETS.ending`（3 场景 × 5 款）
- 不连接 Web 任务路由：`apps/web/server/creation.mjs` 的 `image_creator` 分支目前仍是占位返回

**已删除的旧链路**（不要再接回来）：`packages/ffmpeg-kit/composer.js` 的 `compose()`、
`packages/cover-kit/` 整套封面系统、`packages/shared/visualComposerRules.js`、
`packages/shared/visualDirector/`、本模块的 `renderer.js` + `manifest.js`。
删除依据与逐项清单见 `.workbuddy/memory/2026-10-23.md`。

## 渲染模型（三层严格分离）

1. **图片层**：用户图按洞位 contain，做运镜（3 档）与镜间转场（`cut` / `slide`）
2. **版面层**：SVG 渲成透明 PNG，坐标全片恒定，只做文字入场动效（4 档）
3. **结尾层**：`fadeblack` 到纯黑 → 停 0.35s → 结尾卡淡入 → 全亮停留

文字**不参与**转场与运镜。由此产生两条硬约束：淡入必须晚于转场结束，淡出必须早于镜边界 ≥2 帧
（否则 `overlay eof_action=pass` 会把残帧冻到片尾，且因坐标全片固定，残影会跟下一镜文字精确重叠）。

## 洞位与判据

画布 1080×1920。洞位按首图比例锁一档（竖 3:4 / 方 1:1 / 横 4:3），全片不变。
两条验收判据：**商品短边 ≥580px**（看得清字标）、**洞不超画布 40%**（版面有呼吸）。

## 性能

手机原图 4000×6000 直接交 ffmpeg 是逐帧重采样，4 秒素材要 17.9s。引擎先用 sharp 预缩到
"过扫描后的目标尺寸"（正是 graph 里最后那次 scale 的大小，两步 scale 退化为 no-op），同素材降到 2.05s。

## 未完成

- BGM 混音与 duck（`audio-kit/buildDuckFilter` 现成，未接）
- `quick_wipe` 动效（枚举有，滤镜未实现）
- 接入 `creation.mjs` 的 `image_creator` 分支（当前占位）
