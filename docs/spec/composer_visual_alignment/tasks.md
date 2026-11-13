# Tasks：composer → 新视觉引擎收敛

> 关联 spec：`docs/spec/composer_visual_alignment/spec.md`
> 约束：零真实出片、零付费、仅本地提交；Task 2 触碰冻结模块须先获批准。

- [x] T1 基线复核：`node --test` cover-kit×3 + shared×1 记录绿基线（24 项 PASS）。
- [x] T2 composer.js 导入 cover-kit 生成器与 frozenAssets。
- [x] T3 composer.js 全局底板：`flatVisualPlan/bgId/wantsPlate` + `generateBackgroundPlate` 写 `global_bg_plate.png`（try/catch 静默回退）。
- [x] T4 composer.js 构图开窗：`windowRectOf()` + `buildAdaptiveBase/kenBurnsFilter` 增 `win` 参数；用户图 seg 记录 `photoLayout`。
- [x] T5 composer.js 输入索引：底板/侧边字母/结尾 CTA 作为 `-loop 1` 视频输入，插在 `visualPngs` 之后、TTS 之前；同步 `audioBaseIdx`。
- [x] T6 composer.js 底板叠加（split+trim+overlay）+ 侧边字母 + `finalSegName` 统一标签（xfade 链/单镜/片头 `firstLabel`）。
- [x] T7 composer.js 结尾 CTA 物化与末 2s `fade in 0.35` overlay。
- [x] T8 composer.js `opts.visualPlan` 守卫：仅含 `mechanisms` 才走 `compileVisualPlan`。
- [x] T9 timeline.js（冻结，已获 Spec 批准）：分镜补 `photo_layout/title_position/is_ending_shot/ending_id/side_typo`；`visualPlan` 扁平兜底打包。
- [x] T10 回归验证：`node --test` cover-kit×3 + shared×1 + visual-director×3 → **47 项全 PASS**，无付费调用。
- [x] T11 静态核查：`node --check` 两文件通过；`git diff` 仅 composer.js + timeline.js；filtergraph 标签（vs/bp/bpt/p/l/x/vcta/vctaout）唯一无重复消费；输入索引与 `audioBaseIdx` 自洽。
- [x] T12 本地提交（不推送），输出变更清单 + 遗留项。
- [x] T13 `npm run check:health`：目录结构 OK；Emoji 扫描 **FAIL 仅命中 5 个既有无关文件**（`.ai-team/*.md`、`docs/visual-gallery/index.html`、`packages/ide-ai-team-extension/extension.js`），本次改动文件零 Emoji；5173 服务未启动（WARN，未启动服务）。
