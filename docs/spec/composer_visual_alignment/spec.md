# Spec：视频合成引擎与全量视觉资产对齐（composer → 新视觉引擎收敛）

> 依据：`docs/HANDOVER_COMPOSER_VISUAL_ALIGNMENT.md`（交接指令）
> 分支：`fix/align-composer-visual-pipeline` · 基准 HEAD `1cca284`
> 制定：jansee 架构/视频引擎 · 2026-10-18
> 状态：待用户审批（本文件为执行前唯一事实源）

***

## 一、问题定义（已核实）

上层（`apps/web/server/director.mjs`）已 100% 产出全量视觉资产字段，底层合成（`packages/ffmpeg-kit/composer.js`）未消费它们，存在三处断裂：

| #  | 断裂点       | 代码证据                                                                                                         | 影响                    |
| :- | :-------- | :----------------------------------------------------------------------------------------------------------- | :-------------------- |
| 1  | 全局底板未贯穿   | `composer.js` L76-80 `buildAdaptiveBase` 仅做全屏 `scale+increase+crop`，无 `background_id`                        | 全片为原图硬拉伸，无 14 款渐变底板   |
| 2  | 构图节奏开窗未生效 | L87-131 `kenBurnsFilter` 恒定输出满屏；全文无 `photo_layout`                                                           | 6 款构图退化为全屏居中          |
| 3  | 装饰/结尾未叠加  | 全文无 `decorator_id`/`is_ending_shot`/`ending_id`；`generateEndingCtaLayer`、`renderSideVerticalLettersSvg` 未被调用 | 侧边字母标尺与 19 款结尾 CTA 缺失 |

**补充断裂（Task 2）**：`modules/image_creator/core/timeline.js` L99-109 的分镜映射只透传 6 个字段，**丢弃** `photo_layout/is_ending_shot/ending_id/side_typo`，且未把 `background_id/decorator_id/font_id` 打包进 `compose()` 的 `opts`。

## 二、权威事实源（已核实，禁止篡改）

* 资产清单：[frozenAssets.js](file:///f:/janseeV2/packages/shared/frozenAssets.js) —— `photo_layout` 6 款（含 `pos_info` 百分比）、`ending` 19 款（每条含 `scene/copyId/skelId`）、`scheme` 14 款（`bg_id`）。

* 编排规则：[visualComposerRules.js](file:///f:/janseeV2/packages/shared/visualComposerRules.js) —— `planVisualBlueprint()` 产出 `global.{background_id,font_id,decorator_id}` + `shots[].{photoLayout,motion,transition,isEndingShot,ending_id}`。

* 生成器（均已在 [cover-kit/index.js](file:///f:/janseeV2/packages/cover-kit/index.js) 导出）：

  * `generateBackgroundPlate({preset,mode,width,height,outputPath})` → 静态 PNG（写文件）。

  * `renderSideVerticalLettersSvg({width,height,side,text,subText})` → `{svg}`；`rasterizeDecoratorToPng({svg,outputPath})` → 透明 PNG。

  * `generateEndingCtaLayer({scene,copywritingId,skeletonId,width,height})` → `{pngBuffer}`（**返回 Buffer，需自行写盘**）。

* V2 机制计划编译器：[compiler.js](file:///f:/janseeV2/packages/visual-director/compiler.js) `compileVisualPlan({plan,...})` —— **强依赖** **`plan.canvas/mechanisms/timeline`**。

## 三、必须处理的四类已知坑（决定实现细节）

1. **`opts.visualPlan`** **形状冲突**：`compileVisualPlan` 读 `plan.canvas/mechanisms`。而 Task 2 传入的兜底对象是扁平 `{background_id,decorator_id,font_id}`，直接送进 `compileVisualPlan` 会**崩溃**。→ 必须加守卫：仅当 `opts.visualPlan?.mechanisms` 存在才走 `compileVisualPlan`。
2. **输入索引偏移**：新增静态 PNG（底板/侧边字母/结尾 CTA）均以 `-loop 1` 追加为视频输入，必须与 `visualPngs`、`closingInputIdx`、`audioBaseIdx`、sfx/bgm 标签索引**同步**。
3. **`photo_layout`** **含** **`golden_split`**：`planVisualBlueprint` 在 5\~9 图时会产出 `photo_layout='golden_split'`（不在 6 款 `pos_info` 表内）。→ 开窗查表未命中时**静默回退** `center_balanced`，不中断出片。
4. **底板 split 复用**：单条 filtergraph 内同一输入不可被消费两次；底板按 `segNodes` 数量 `split` 多份，逐镜 `overlay`。视频/纯色/精选图 seg 仍走满屏（overlay 为视觉无操作）。

## 四、目标设计

### Task 1 —— `packages/ffmpeg-kit/composer.js`

1. **导入**：`@jansee/cover-kit/index.js` 的 `generateBackgroundPlate / renderSideVerticalLettersSvg / rasterizeDecoratorToPng / generateEndingCtaLayer`；`@jansee/shared/frozenAssets.js` 的 `FROZEN_VISUAL_ASSETS`。
2. **全局底板**：

   * 解析 `bgId = opts?.visualPlan(扁平)?.background_id || opts?.background_id || opts?.blueprint?.global?.background_id || ''`；

   * `wantsPlate = !!bgId || shots.some(s=>s.photo_layout)`（**仅在图片成片视觉链路启用；视频配音旧链路零回归**）；

   * `await generateBackgroundPlate({preset: bgId||'obsidian', mode:'gradient', width:PLATE_W, height:PLATE_H, outputPath: taskDir/global_bg_plate.png})`；失败则 `hasBgPlate=false` 静默回退旧链路。
3. **构图节奏开窗**：

   * 由 `FROZEN_VISUAL_ASSETS.photo_layout[].pos_info` 计算 `windowRectOf(layoutId)` → `{x,y,w,h}`（偶数对齐 yuv420p）；

   * `buildAdaptiveBase(inputIdx, win)` / `kenBurnsFilter(..., win)` 增加视窗参数：`scale/crop` 与 `zoompan s=` 均改为窗口尺寸；

   * 用户图 seg 记录 `photoLayout`（来自 `shots[i].photo_layout`）。
4. **底板叠加**：`[bgPlateIdx:v] → scale → TO_YUV709 → split=sm`；逐 seg `[vs{i}][bp{i}]overlay=x:y[p{i}]`；窗口外自然透出底板。
5. **侧边字母**：`left_story→side:'right'`、`right_story→side:'left'`，`renderSideVerticalLettersSvg` + `rasterizeDecoratorToPng` 物化；逐镜 `[p{i}][li:v]overlay=0:0[l{i}]`。
6. **结尾 CTA**：末镜 `is_ending_shot||ending_id` 且命中 `frozenAssets.ending` 中带 `scene/copyId/skelId` 条目 → `generateEndingCtaLayer` 写 `ending_cta.png`；在成片末尾 `videoDuration-2.0s` 起 `fade=t=in:d=0.35` 叠加。
7. **V2 守卫**：`opts.visualPlan` 仅当含 `mechanisms` 才走 `compileVisualPlan`；扁平对象只供底板/装饰读取。
8. **filtergraph 标签一致性**：`finalSegName(i)` = `vs{i}`→(`p{i}` 有底板)→(`l{i}` 有侧边字母)；xfade 链、单镜分支、片头视觉层 `firstLabel` 全部统一引用该名字，杜绝标签重复消费。

### Task 2 —— `modules/image_creator/core/timeline.js`（**冻结模块，需显式批准**）

1. 分镜映射补字段：`photo_layout / title_position / is_ending_shot / ending_id / side_typo`。
2. `compose()` 的 `visualPlan`：保留 `script.visual_plan || script.visualPlan`；否则若 `script` 含 `background_id/decorator_id/font_id` 则打包扁平对象传入。

## 五、边界与红线

* **验证方式（用户指定）**：仅跑回归测试 + 静态检查；**禁止真实出片**、**禁止付费 LLM/TTS**。

* **提交方式（用户指定）**：**仅本地提交，不推送远程**。

* 零中间临时视频、单 filtergraph、PNG 生成 ≤15ms、BT.709 原色直出、0 Emoji、9 图上限。

* 4 核机器内存纪律：底板 `split` 为 yuv420p（非 RGBA），峰值受控。

* **旧链路零回归**：`wantsPlate=false` 时（视频配音/无 photo\_layout）所有新增滤镜均不注入，行为与现状逐字节一致。

## 六、验收标准

1. `node --test packages/cover-kit/test-background-presets.test.mjs packages/cover-kit/test-decorators.test.mjs packages/cover-kit/test-ending-cta.test.mjs packages/shared/test-visualComposerRules.test.mjs` 全绿（基线 24 项）。
2. `packages/visual-director/*.test.mjs`（3 个）全绿。
3. `git diff` 仅命中 `composer.js`、`timeline.js` 两文件（+ 本 spec 目录），无其他生产代码扩散。
4. 静态检查：filtergraph 标签无重复定义/重复消费；新增输入索引与 `audioBaseIdx`、sfx/bgm 标签自洽。
5. **遗留（无法在本次闭环）**：真实出片观感（底板/开窗/字母/CTA）需一次授权渲染方可确认 → 列为合并前必做项。

## 七、需用户决策/批准项

1. **是否批准修改冻结模块** **`modules/image_creator/core/timeline.js`**（Task 2）？不批准则 Task 1 的 `photo_layout/bgId` 无来源，收敛无法生效。
2. **是否接受「本轮只见代码、不见成片」**：filtergraph 变更无法在无渲染前提下定论，需后续一次授权出片复验。
3. `decorator_id` 全局装饰（幽灵框/取景标等）**本轮不接线**（交接文档 Task1 未明确要求，仅列资产表）；是否纳入下一轮？

