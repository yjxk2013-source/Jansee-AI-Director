# 简兮 (JANSEE) 视频合成引擎与全量视觉资产对齐交接文档

> **文档定位**：全链路视觉重构与底座合成修复指南（Agent 无缝交接版）  
> **制定角色**：视频引擎与架构组 `[jansee-视频引擎]` / `[jansee-架构]`  
> **编写时间**：2026-10-18  
> **当前独立分支**：`fix/align-composer-visual-pipeline`  
> **基准提交状态**：代码库已平稳恢复至 `2026-10-18 05:27:58` 锚点

---

## 一、背景与问题根因 (Root Cause)

### 1. 现象描述
在图片成片模块（`modules/image_creator`）生成的测试视频中，画面表现依然是**旧版链路产物**（整屏图片硬拉伸、粗暴铺满居中裁切），未体现出全量视觉实验室（Visual Lab）定稿的黑曜石大厂质感。

### 2. 断层根因排查定位
虽然上层规则与定义层（`packages/shared/visualComposerRules.js`、`apps/web/server/director.mjs`）已经 100% 对齐了全量 88 款资产（14款开场底板、6款构图节奏开窗、11款发丝装饰、19款结尾收束等），但在底层合成引擎与调度层存在**三大断裂点**：
1. **底板未贯穿**：`packages/ffmpeg-kit/composer.js` 中的 `buildAdaptiveBase` 仅执行旧版 `scale=canvasCropW:canvasCropH:force_original_aspect_ratio=increase,crop=...`，直接全屏裁切原图，没有将 `background_id`（14款高清渐变底板）生成并作为贯穿第 0 秒至结尾的静止画布。
2. **构图节奏开窗未生效**：上层分镜已分配 `photo_layout`（如 `left_story`、`right_story`、`center_balanced`、`golden_split`），但 `composer.js` 未根据布局尺寸开窗，而是继续暴力铺满全屏，导致 6 大构图比例全部退化为全屏居中。
3. **装饰图层与结尾收束未叠加**：`packages/cover-kit/decorators.js` 的 11 款透明发丝装饰（取景框、幽灵框、标尺等）与 `endingCta.js` 的 19 款场景收束，未在 `composer.js` 的 FFmpeg filtergraph 中作为 overlay 节点挂载。

---

## 二、架构事实源与已通过资产资产清单

各资产的唯一权威参数与生成器均已在 packages 中完成单元测试验证，可直接调用：

| 资产类别 | 数量 | 核心定义文件 | 渲染实现方法 |
| :--- | :--- | :--- | :--- |
| **开场底板 (Scheme)** | 14 款 | [frozenAssets.js](file:///f:/janseeV2/packages/shared/frozenAssets.js) | `generateBackgroundPlate({ preset, mode, width, height, outputPath })` 位于 [backgroundPresets.js](file:///f:/janseeV2/packages/cover-kit/backgroundPresets.js) |
| **构图节奏 (Layout)** | 6 款 | [frozenAssets.js](file:///f:/janseeV2/packages/shared/frozenAssets.js) | 物理比例与定位坐标（见下文第三节） |
| **发丝装饰 (Decorators)** | 10 款 | [visualComposerRules.js](file:///f:/janseeV2/packages/shared/visualComposerRules.js) | 画布 6 款 + 文案挂件 3 款渲染器（`renderViewfinderCornersSvg`/`renderGhostFrameSvg`/`renderEditorialAxisSvg`/`renderOpticCrossSvg`/`renderCornerBracketSvg`/`renderSwissWireSvg`/`renderTextFollowerDecoratorSvg`）+ 构图窄边竖排字母 1 款（`renderSideVerticalLettersSvg`，已由侧边字母块物化）位于 [decorators.js](file:///f:/janseeV2/packages/cover-kit/decorators.js) |
| **结尾收束 (Ending)** | 19 款 | [frozenAssets.js](file:///f:/janseeV2/packages/shared/frozenAssets.js) | `generateEndingCtaLayer({ scene, copywritingId, skeletonId, width, height })` 位于 [endingCta.js](file:///f:/janseeV2/packages/cover-kit/endingCta.js) |
| **字体字族 (Font)** | 6 款 | [frozenAssets.js](file:///f:/janseeV2/packages/shared/frozenAssets.js) | `resolveFontFile`（传统三族 sans/serif/latin）+ `resolveFontFileById({fontId,weight,text})`（6 款 font_id 直连，失败返 null 由调用方兜底）位于 [fonts.js](file:///f:/janseeV2/packages/cover-kit/fonts.js) |

> **回归验证命令**：
> ```bash
> node --test packages/cover-kit/test-background-presets.test.mjs packages/cover-kit/test-decorators.test.mjs packages/cover-kit/test-ending-cta.test.mjs packages/shared/test-visualComposerRules.test.mjs
> ```
> *当前状态：全部 20 项子测试 100% PASS。*

---

## 三、接手 Agent 必须执行的修改方案

### 任务 1：改造 [packages/ffmpeg-kit/composer.js](file:///f:/janseeV2/packages/ffmpeg-kit/composer.js)

#### 1. 引入必要的预设与生成工具
在顶部导入：
```javascript
import {
  generateBackgroundPlate,
  renderViewfinderCornersSvg,
  renderGhostFrameSvg,
  renderEditorialAxisSvg,
  renderOpticCrossSvg,
  renderCornerBracketSvg,
  renderSideVerticalLettersSvg,
  rasterizeDecoratorToPng,
  generateEndingCtaLayer
} from '@jansee/cover-kit';
```

#### 2. 生成并挂载全局贯穿静止底板
在合成开始前（`inputSpecs` 装配前）：
1. 提取全片全局背景 ID：
   ```javascript
   const bgId = opts?.visualPlan?.background_id || shots[0]?.background_id || opts?.blueprint?.global?.background_id || 'obsidian';
   ```
2. 依据画布尺寸（`canvasW` × `canvasH`）在 `taskDir` 内生成静态 PNG：
   ```javascript
   const bgPlateFile = path.join(taskDir, 'global_bg_plate.png');
   await generateBackgroundPlate({
     preset: bgId,
     mode: 'gradient',
     width: canvasW,
     height: canvasH,
     outputPath: bgPlateFile
   });
   ```
3. 将底板以 `-loop 1` 输入追加到 FFmpeg 输入参数中，确保从第 0 秒贯穿至全片结束。

#### 3. 升级 `kenBurnsFilter` 匹配 6 种构图节奏开窗与留白
构图节奏的物理开窗尺寸定义源（`W = canvasW`, `H = canvasH`）：
- `center_balanced`：宽 `Math.round(W * 0.92)`，高 `Math.round(H * 0.72)`，X: `Math.round(W * 0.04)`，Y: `Math.round(H * 0.04)`
- `top_focused`：宽 `Math.round(W * 0.92)`，高 `Math.round(H * 0.78)`，X: `Math.round(W * 0.04)`，Y: `Math.round(H * 0.025)`
- `left_story`：宽 `Math.round(W * 0.76)`，高 `Math.round(H * 0.68)`，X: `Math.round(W * 0.03)`，Y: `Math.round(H * 0.05)`（右侧留白）
- `right_story`：宽 `Math.round(W * 0.76)`，高 `Math.round(H * 0.68)`，X: `Math.round(W * 0.21)`，Y: `Math.round(H * 0.05)`（左侧留白）
- `bottom_subtle`：宽 `Math.round(W * 0.92)`，高 `Math.round(H * 0.76)`，X: `Math.round(W * 0.04)`，Y: `Math.round(H * 0.14)`
- `full_immersive`：宽 `Math.round(W * 0.96)`，高 `Math.round(H * 0.88)`，X: `Math.round(W * 0.02)`，Y: `Math.round(H * 0.02)`

**滤镜流水线标准改造**：
1. 裁切与运镜在视窗矩形（`windowW` × `windowH`）内部进行，保持图片清晰锐利；
2. 运镜流与背景底板执行 `overlay=X:Y` 贴合；
3. **侧边字母标尺联动**：当 `photo_layout` 为 `left_story` 时在右侧留白叠加 `renderSideVerticalLettersSvg({ side: 'right' })` 的透明 PNG；为 `right_story` 时在左侧留白叠加 `renderSideVerticalLettersSvg({ side: 'left' })` 的透明 PNG。

#### 4. 结尾 CTA 收束物化
在分镜最后一镜（`is_ending_shot === true` 或 `ending_id` 存在时）：
- 调用 `generateEndingCtaLayer` 生成透明 PNG；
- 在成片末尾最后 2.0s 通过 `overlay` 配合 `fade=t=in:st=...:d=0.35` 优雅浮现。

---

### 任务 2：打通 [modules/image_creator/core/timeline.js](file:///f:/janseeV2/modules/image_creator/core/timeline.js) 的蓝图透传

确保调用 `compose()` 时将 `script` 中的 `background_id`、`photo_layout`、`decorator_id` 完整打包传入：
```javascript
const composed = await compose(
  taskDir,
  shots,
  scheduled,
  srtPath,
  mediaVideos,
  { sfxItems, bgmPath: bgmExtras?.bgmPath || '', filterChain: bgmExtras?.filterChain || '' },
  imageFiles,
  {
    onProgress: onEncode,
    maxSeconds,
    transitionDuration: xfadeD,
    perShotTransitions: shotTransitions,
    visualPlan: script.visual_plan || script.visualPlan || {
      background_id: script.background_id,
      decorator_id: script.decorator_id,
      font_id: script.font_id,
    },
    ...
  }
);
```

---

## 四、工程与性能红线提醒 (Non-negotiables)

1. **4核16G 性能与内存纪律**：
   - 严禁产生任何额外的中间临时视频文件（如 `temp_shot_1.mp4`）；
   - 所有特效必须在单一 FFmpeg 进程的单条 filtergraph 中一气呵成完成；
   - 静态装饰层与底板一律由 Sharp/SVG 快速生成为静态 PNG（耗时必须控制在 15ms 内）。
2. **大厂视觉铁律**：
   - **0 Emoji 绝杀令**：全站禁止使用系统 Emoji；
   - **2px 倒角微光幽灵边框**：装饰框严禁实心白底；
   - **9张图硬拦截**：严格锁定最多 9 张。
3. **色彩空间铁律**：
   - 所有转换保持 BT.709 标准，严禁挂载重调色或脏灰高斯模糊，保持素材原色直出。

---

## 五、验收与交付标准

1. 运行最小渲染测试脚本，在 `storage/outputs/` 生成真实的 `final.mp4`；
2. 检查成片第一秒至最后一秒：
   - 底板呈现对应行业的细腻微渐变（非全屏纯黑/纯色拉伸）；
   - 分镜具备明显的 70%~80% 开窗黄金比例与微推拉运镜；
   - 偏左/偏右分镜呈现窄边英文字母标尺；
   - 片尾最后 2 秒呈现精致的 2px 幽灵框/发丝线 CTA行动号召。
3. 执行 Git 提交并推送分支 `fix/align-composer-visual-pipeline`。

---

## 六、接线状态更新（2026-10-18，供后续代理遵循）

- **Task1 + Task2 已完成**（提交 `18f10b5`）：全局底板贯穿 / 构图开窗 / 侧边字母 / 结尾 CTA / timeline.js 字段透传与扁平 visualPlan 打包。
- **decorator_id 已接线**（提交 `9796829`）：`composer.js` 按 `flatVisualPlan.decorator_id || blueprint.global.decorator_id` 解析，全画幅镂空 PNG 于 0.15s 淡入后贯穿全片，置于结尾 CTA 与字幕之下（对齐 V2 编译器叠加范式）。
  - 画布类 5 款直连官方渲染器：`gf`/`vf`/`editorial_axis`/`optic_cross`/`corner_bracket`；
  - `swiss_wire` 同属发丝框族，静默回退 `gf`（工程兜底铁律）；
  - `text_editorial_bracket`/`text_ghost_capsule`/`text_side_hairline`（文案挂件，属字幕层）、`side_vertical_letters`（已由侧边字母块物化，防双重渲染）**有意静默跳过**——后续如需补齐属独立专项，勿在画布 overlay 层硬造；
  - `edge_feather` 已于 2026-10-18 经用户判定**彻底清理**（渲染层无实现且零品类引用，孤儿 ID）：composer 注释、实验室页面（卡片/生成器/羽化分支/动效映射/CSS/photo_3d 联动 feather 字段 14 处）、测试注释全链删除，装饰资产收敛为 9 款（画布 6 + 文案挂件 3）。
- **验收注意**：装饰物化与叠加同样仅在图片成片视觉链路（`wantsPlate`）启用，视频配音旧链路零注入；filtergraph 变更的观感确认仍需一次授权真实出片（见 §五）。
- **字体 6 款已全量接线**（提交 `86ccd86`，2026-10-18）：此前主题表锁定的 font_id 在执行层无真实字体支撑（仅 sans/serif/latin 三族）。现修复为：
  - 注册表（`cover-kit/fonts.js` FONT_REGISTRY）新增 6 个 font_id 键：`source_han`/`songti` 复用引擎已部署字体；`mashanzheng`/`zcool_xiaowei`/`zcool_huangyou`/`zcool_kuaile` **直连 materials/fonts 素材中心**（index.json v3.0.0 盘点，OFL 免费商用授权），单一事实源不复制文件，勿在 cover-kit/assets 下重复放置；
  - 新解析入口 `resolveFontFileById({fontId,weight,text})`（cover-kit/index.js 再导出）：任何失败返回 null 由调用方回退默认字族，出片永不因字体中断；字重档位自动归一到最近档（display 单档族恒 400）；
  - 双消费点：全片字幕（composer.js drawtext，回退 obsidian_hairline.ttc）+ 片头/封面标题（buildOpeningVisualPipeline → resolveTypography 第 5 参 opts.fontId，字形校验未通过自动降级语义族）；
  - 字重归一规则更新：请求档不在表内 → 最近重字重档（原 sans 700→600 特例由此统一覆盖，行为兼容）；
  - 回归：字体解析断言 33 项（scratch/test-font-id-resolution.mjs）+ 既有 47 项 + video-dub 全绿，零付费。
- **行业品类已接线**（2026-10-18，工作区改动待提交）：主题表 `CATEGORY_THEME_MAP` 从「建好未启用」转为按用户文案自动命中。
  - 判定层：`prompt/index.js` 新增 `CATEGORY_SIGNAL_RULES`（14 品类强信号正则，具体品类在前防泛词抢命中）+ `decideCategoryLocal()`，与变体判定同模式同址维护，品类 key 与 `CATEGORY_THEME_MAP` 一一对应；
  - 消费层：`director.mjs` LLM 主链路（`generateDirectorCut`，输入 `title + sellingPoints`）与 mocker 兜底（`generateConstitutionScript`，输入 `cleanTitle + cleanDesc`）两处 `planVisualBlueprint` 调用点均传入 category；`sanitizeDirectorCut` 的蓝图缺失防御分支不传，落兜底；
  - 兜底语义：`planVisualBlueprint` 签名默认 `category=''`——未命中 / 空串 / 未知 key 统一落 `DEFAULT_THEME` 固定兜底（黑曜石 + 思源黑体 + 幽灵框），不再默认 luxury 主题（产品拍板：未命中保持固定兜底，不做随机）；
  - BGM 归属：主题表 14 条 + 兜底的 `bgm_emotion` 字段已全部删除，BGM 统一由 LLM 从 17 情绪白名单判定（留空落 generic 兜底曲库）；mocker 兜底用场景默认情绪（local=warm / personal=calm_narrative / sell=passionate）；
  - 影响边界：仅图片成片视觉链路生效（背景/字体/装饰三件套联动），视频配音 / 口播 / 切片链路零注入（与 decorator_id 同口径）；
  - 验证：品类路由断言 39 项（scratch/test-category-routing.mjs）+ 视觉规则 9 项 + 变体路由 9 项 + video-dub（stage-a 28 项含三场景 prompt 隔离账本逐字节零回归 / voice-chain 全绿）；stage-b/d 的 E1 端到端失败为旧版 produce 接口 410 下线的历史遗留（index.mjs 已下线旧接口，测试资产未迁移），与本改动无因果；
  - 生效条件：改完需重启网关进程（旧代码缓存教训）。
- **点睛笔五条已接线**（2026-10-18，分支 `feature/composer-visual-accent` 工作区改动待审核）——用户拍板「这五条要全部算得」，修复视觉链路五处断点：
  1. **photo3d 14 款图片版式真物化**：此前 blueprint 产出 `photo3d`（PHOTO_3D_CYCLE 14 款 frame_*）在 director shots 组装、timeline 透传、composer 消费三层全断。现 director.mjs 两路径（LLM sanitizeDirectorCut + mocker 兜底）shots 补带 `photo3d`/`golden_split_form`；timeline.js 逐镜透传补 `sub_theme`/`photo3d`/`golden_split_form`/`split_center_typo` 四字段（compileVisualIntent 对无 intent 脚本原样克隆，字段不丢）；composer 新增 PNG 物化层——`frame_floating_glow` 生成窗缘三层同心描边背光 PNG 叠于图下，其余 12 款切角/圆角生成「白=框外/黑=孔洞」灰度蒙版 PNG，与底板副本 `alphamerge` 后叠加图上把窗形外图角盖回底板（真切片，色彩与底板零偏差），`frame_pure_clean` 纯平不物化；物化失败逐镜静默跳过（工程兜底铁律）；
  2. **golden_split 黄金分割真效果**：此前 `windowRectOf('golden_split')` 不在 frozenAssets 冻结表（仅 6 款），静默回退 center_balanced。现 composer 专用 `goldenWindowRect()` 几何（中缝带宽 12%、图片视窗占 88%，剩余透出全局底板；**不进 frozenAssets 冻结表**，仅 composer 消费），4 款形态按 GOLDEN_SPLIT_CYCLE 定版语义落位（上中缝图沉底/下中缝图居顶/左竖缝图居右/右竖缝图居左），统一解析口 `shotWindowOf(seg)`（Ken Burns 开窗与底板 overlay 同源）；
  3. **split_center_typo 中缝题字联动**：LLM 产出的 4 字核心词+英文翻译（此前被 timeline 丢弃）现渲染进中缝底板带——横缝中文主词+英文小字上下堆叠居中，竖缝汉字/英文字母逐字竖排，附缝缘发丝 drawbox 线；缺失时回退 sub_theme 担纲；
  4. **title_position 每镜专属标题位**：每镜 `sub_theme` 标题（4-8 字小主题）按 `title_position` 渲染——`bottom` 窗下方/`top` 窗上方（贴边自动钳回画面安全区）/`split_corners` 留白侧上角标题词+同侧下角镜序号（与竖排字母标尺错位）/`middle_seam` 由中缝题字担当；标题色随 `BACKGROUND_PRESETS[bg_id].textColor` 自适应（浅底板深墨字免黑影、深底板白字加影），字体走 `resolveFontFileById`（weight 400，失败回退 obsidian_hairline.ttc）；
  5. **5 品类装饰换画布直连款**：`CATEGORY_THEME_MAP` 中 tea `edge_feather→vf`、oriental `text_editorial_bracket→editorial_axis`、snack `text_ghost_capsule→gf`、ecommerce `text_side_hairline→corner_bracket`、beauty `side_vertical_letters→editorial_axis`，14 品类 decorator_id 现全部落在 composer 可渲染集合（6 款画布类 100% 被引用）；测试口径同步（test-visualComposerRules 装饰覆盖断言改为「画布类必须被引用+品类装饰必须可直连渲染」）；
  - **附带修复潜伏断点**：filtergraph 组装口新增统一规范化（剥尾分号/剔空串再 join(';')）——装饰/CTA 段历史残留的 `;;` 双分号会让 ffmpeg 报 `No such filter: ''` 直接崩，此前装饰从未真实出片渲染所以未暴露；
  - **验证**：零付费真实渲染验证 23 项断言全 PASS（scratch/test-composer-accent.mjs：4 任务 2 并发、14 款 photo3d 全形态 + 4 款 golden 形态 + 标题位全覆盖，抽帧像素级断言「缝区=底板色/图区=素材色/窗角外=底板色」）+ 视觉规则 9 项 + 品类路由 39 项；ffmpeg 2 并发 WS 峰值 1087MB（540×960 测试画幅双进程合计，无 OOM）；image_creator.e2e 的 fetch failed 为需网关在线的环境依赖（契约单测全过），非本改动回归；
  - **遗留**：1080×1920 生产画幅全链路 2 并发压测与真实出片观感确认待用户授权（付费红线：涉真实 LLM/TTS）；生效需重启网关进程。
- **文字动效 5 款已接线**（2026-10-18，同分支工作区改动待审核）——用户拍板「文字动效暂时随机（黄金分割里文字不要任何动效）」，激活 text_anim 冻结资产：
  1. **蓝图编排**：visualComposerRules.js 新增 `TEXT_ANIM_IDS`（frozenAssets.text_anim 5 款 id 池），`planVisualBlueprint` 逐镜随机轮选 `textAnim`；**黄金分割镜恒空串**（中缝题字不做任何动效，用户定版）；
  2. **全链路透传**：director.mjs 两路径（LLM sanitizeDirectorCut + mocker 兜底）shots 补带 `text_anim`；timeline.js 逐镜透传补 `text_anim`；composer segNodes 补 `textAnim`；
  3. **渲染实现**：composer `dt()` 绘字助手新增第 7 参 anim，5 款动效映射为 drawtext 表达式级实现（仅入场 ≤0.6s 后完全静止，零常驻算力）——`text_fade_up` 0.6s 透明度爬升+自下 22px 缓升归位 / `text_fade_in` 0.6s 纯淡入 / `text_slide_in` 0.5s 自右 40px 滑入 / `text_micro_pop` 0.18s 快显+6px 微升回弹（sin/PI 表达式）/ `text_quick_wipe` 0.35s 快速横移 28px 近似遮罩推展；动画态走 drawtext 独立 `alpha` 表达式选项（`fontcolor` 不再带 @alpha），静态路径（无 anim）逐字节保持原样；
  4. **作用域**：动效仅作用于每镜 `sub_theme` 标题（top/bottom/split_corners 三款标题位）；黄金分割中缝题字、镜序号、侧边字母、结尾 CTA、台词字幕一律不动效；
  - **验证**：scratch/test-text-anim.mjs 8 项断言全 PASS（蓝图 textAnim 分布 4 项 + 5 款动效单次渲染全覆盖 4 项，ffmpeg 表达式语法真机接受）；既有点睛笔回归 23/23 全过（测试剧本不带 text_anim 走静态路径，零回归）；ffmpeg WS 峰值 884MB 无 OOM。
- **审计清理三件套**（2026-10-18，同分支工作区改动待审核）——用户判定「②menuTextForLLM 清理 / ④openingMotion 清理 / ⑦freeze_cta 注释残留清理；③brand_out 暂不管；⑤text_anim 按新引擎收敛（上条已接线）」：
  1. **menuTextForLLM 全删**：effectsLibrary.js 删函数（特效菜单不再随 prompt 下发，编排已由蓝图接管）、director.mjs 删死 import、00_llm_director.md L19/L21 文档行同步修正（特效菜单数勘误为 开场 7 / 转场 5 / 运镜 6 / 结尾 4）；
  2. **openingMotion 三条变速曲线全删**（旧引擎死代码，speed_ramp/zoom_punch/beat_zoom）：composer kenBurnsFilter/imageShotFilter 删 curve 分支与 zCurves 表，签名收敛（kenBurnsFilter 第 5 参直接收 win），两处调用点同步去 null 占位；00_llm_director.md L24 同步修正（Ken Burns 6 档、openingFilter 仅 fade/blurIn、endingKey 仅 zoom_far 专属）；
  3. **freeze_cta 残留清理**：timeline.js L411 注释剔除 freeze_cta（新引擎结尾 = ending_id 体系 19 款，freeze_cta 系旧引擎定格序列遗产）；00_llm_director.md 第 3 节整节重写为新引擎定版（开场 7 / 转场 5 / 运镜 6 / 结尾 4+15 场景收场文字组合体系）；check-materials-integrity.mjs 中 freeze_cta 引用保留（校验实验室样片文件存在性，属实验室资产非出片链路）；
  - **⑥ edge_feather 查证结论**：新引擎零引用（tea 品类原锁定款已于点睛笔换 vf，测试断言明确禁止其落入品类主题表），仅存实验室前端演示与渲染层占位 ID，处置（删 ID / 补实现）待用户判定；
- **⑥⑦ 彻底清理**（2026-10-18，同分支工作区改动待审核）——用户判定「⑥ 清理、⑦ 清理」：
  1. **edge_feather 全链删除**：composer.js 注释剔除；实验室 index.html 6 处删净（资产卡片、SVG 生成器、羽化分支、DEC_ANIM_MAP 动效映射、classList/CSS 两处、photo_3d 联动 `feather: false` 字段 14 处与 4 处守卫判断、分类徽标 11→9）；测试注释同步。装饰资产收敛定版 **9 款 = 画布 6（gf/vf/editorial_axis/optic_cross/corner_bracket/swiss_wire）+ 文案挂件 3**；
  2. **freeze_cta 全链删除**：上轮已清 timeline.js 注释与 00_llm_director.md 第 3 节；本轮补删 scripts/check-materials-integrity.mjs 校验名单（ENDINGS 5 种勘误为 4 种）+ 删除实验室旧样片 docs/visual-gallery/assets/endings/ed_freeze_cta.mp4（旧引擎定格序列遗产，无引用）；
  - **验证**：composer/check-materials-integrity node --check 通过；视觉规则测试 9/9 全过；素材完整性校验跑通（只读镜像物化完成，删样片后账实一致）；全库 grep edge_feather/freeze_cta 代码零残留（交接文档历史记录除外）。
  - **验证**：4 文件 node --check 通过；点睛笔回归 23/23 全过（ffmpeg 2 并发 WS 峰值 1238MB 无 OOM）。
- **P0+P1 合成性能收敛**（2026-10-18，同分支工作区改动待审核）——真实 2 并发任务把 3.9GB 机器打穿（系统服务批量启动失败、`Commit 4.04GB > 物理内存`、ffmpeg `speed=0.0006x`）。根因不是并发设置，而是**每镜多层全画幅 overlay + 12 路静态 PNG 输入**：
  1. **P0-a 图下基底烘焙（保留原能力）**：`baked_plate_{i}.png` = 底板 + 背光 + 侧边字母，仅覆盖「无蒙版」镜，作为图层基底，1 次 overlay；
  2. **P0-b 图上盖回层烘焙（新增）**：`baked_mask_{i}.png` = 底板按灰度蒙版 alpha 剪裁 + 侧边字母，覆盖全部切角/圆角镜；作为**图之上**的盖回层，等价旧链路 `alphamerge(底板副本, 灰度蒙版)` 后 overlay，省掉一路底板副本输入与逐帧 alphamerge 运算；
     - **关键坑（已踩）**：不能把蒙版直接烘成底板的 alpha 再放到图下方——圆角/切角外侧会被上层用户图盖住，视觉退化。蒙版剪裁必须位于图之上；字母必须叠在剪裁后的底板上（否则会被蒙版盖死）；
     - **关键坑（已踩）**：`sharp.joinChannel` 追加 alpha 的通道推断不可靠（实测产出 alpha 恒 255、整镜被底板盖死）。改用「灰度 → 白色 RGBA（alpha=灰度）→ `composite blend:'dest-in'`」，逐像素构造，结果可控；
  3. **P1 合成域统一**：底板/烘焙基底/用户图全部先转一次 `format=rgba`，逐层 overlay 全程停留在 rgba 域，镜尾统一一次 `scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`（TO_YUV709）直出，消除 FFmpeg 每层 overlay 内部隐式 `yuv→rgba→yuv` 往返；
  4. **输入注册收敛**：`baked_mask` 独立注册并计入 `extraPngCount`；底板原件仅在仍有未烘焙镜需要基底时注册（`needSharedPlate`）；蒙版/荧光/字母输入在已烘焙时全部跳过；
  5. **验证（零付费）**：`scratch/verify-p0-bake.mjs` 12 项断言全 PASS（产物分流 / 盖回层 alpha 窗内=0 窗外=255 / alphamerge 归零 / overlay 7 次 vs 旧链路 9+ / 圆角外侧底板暗像素占比 62% / 窗内正常显图 / 成片时长音频正常）；`scratch/test-composer-accent.mjs` 23/23 全 PASS（14 款 photo3d + 4 款 golden + 4 款标题位 + 装饰 + CTA）；cover-kit 单测 8+3+4、shared 视觉规则 9 全绿。同场景 4 镜 540×960 单任务渲染 7.3s（旧实现 14.3s）；
  - **遗留（待后续授权）**：P2 跨进程合成互斥（当前 `composeGate.mjs` 为进程内信号量，压测脚本 + 网关两个 node 进程会各自放行 2 并发 → 实际 3~4 个 ffmpeg）、P3 默认并发降到 1、1080×1920 真实 2 并发压测。
- **固定 1080P 输入归一化 + 静态层收敛**（2026-10-18，同分支工作区改动，按用户指令未跑渲染验证）——用户定版原则：**输出画布恒为 1080×1920，用户上传图不论多大都只按 1080P 需求处理**。
  1. **上传层归一化**（`apps/web/server/index.mjs`，`normalizeImageForPipeline`）：落盘原图后生成 `upload_{ts}/norm/img_N.jpg` 副本，尺寸 = cover 1080×1920 所需的最小尺寸（缩放系数 `max(1080/w, 1920/h)`，封顶 1 绝不放大；EXIF 方向烘焙成正立像素；带 alpha 转 PNG、否则 JPEG q95 + 4:4:4）。`imagePaths` 与 `registerMaterial` 均指向归一化副本，背景分析 / 视觉引擎 / 合成全链路统一消费；`originalPaths` 保留原图用于追溯。归一化失败静默回退原图，绝不阻断上传。原图真实样本为 4000×6000 ~ 5464×8192，归一化后降到约 1280×1920。
  2. **合成层按视窗精归一化**（`composer.js`，`prescaleShotImage`）：每镜用户图在进入 ffmpeg 前用 sharp cover 到「该镜 photo_layout/golden_split 视窗尺寸」（满屏镜才用 1080×1920），原图本就不大于目标时直接复用。开窗镜的视窗通常只有约 1000×1380，比 1080P 更省。实测有效：真实素材重放 ffmpeg `speed` 由 0.035x 提升到 **0.0587x（+68%）**（该轮因终端回收中断于 25.58s/26.32s，产物不完整，最终完整数据待重跑）。
  3. **删除空转 scale**：底板与烘焙产物在生成时已是 `PLATE_W×PLATE_H`，链上 `scale=PLATE_W:PLATE_H` 删除，省每帧一次无效 swscale。
  4. **静态输入降帧率已回退（负优化）**：`-framerate 1 + 链上 fps 补帧` 实测比 25fps 慢 32%（65.31s vs 49.38s，1080×1920/25s/6 层 overlay 微基准），image2 demuxer 对单张图的循环解码本身已足够便宜，fps filter 的时间戳处理反而更贵。已恢复 25fps 输入，仅保留各消费点的 `fps=${canvasFps}` 幂等补帧。
  5. **④逐镜标题 PNG 化 / ⑤片头层合并 / ⑥AI 标识 PNG 化 —— 经微基准判定不做**：1080×1920/25s/veryfast 微基准显示，6 个 drawtext 仅 +0.28s（占 4%），而 6 层全画幅 overlay +42.45s（占 86%）。drawtext 不是瓶颈，PNG 化反而要把局部文字变成全画幅 overlay 并引入字体栅格化/基线偏移的视觉回归风险。**真正的性能大头是 overlay 层数**，后续优化应继续围绕「减少全画幅 overlay 次数 / 局部区域 overlay」展开，不要再动 drawtext。
  6. **待验证**：用户要求本轮改完不跑渲染（一跑即卡），以上改动仅通过 `node --check`；完整前后耗时/内存对比、真实出片观感确认、网关重启生效均待用户指令。
- **分镜缓存 + 跨进程资源调度**（2026-10-18，同分支工作区改动，未经渲染验证）——针对「新引擎 448s vs 旧引擎 60s」与「2 并发打穿 4G 机器」两项根因。
  1. **跨进程合成槽位**（`packages/ffmpeg-kit/composeGate.mjs` 重写）：在原有进程内信号量之上新增磁盘槽位 `storage/locks/compose_slot_{i}.lock`，用 `O_EXCL` 原子创建、15s 心跳、90s 无心跳视为僵尸锁可抢占。网关 / 压测脚本 / 批量补算共用名额，杜绝「两个 node 进程各自放行 2 并发」。上限 `JX_GLOBAL_COMPOSE_SLOTS`（默认同 `JX_COMPOSE_CONCURRENCY`）。
  2. **内存背压**：派发前检查 `os.freemem()`，低于 `JX_MIN_FREE_MEM_MB`（默认 400MB）时每 2s 重试、最长等 90s，超时仍继续但打印警告。这是 2026-10-18 事故（系统服务批量启动失败）的最后一道闸。
  3. **接入点**（`modules/image_creator/core/timeline.js` `composeProductVideo`）：三层门控顺序 = 进程内槽位 → 跨进程槽位 → 内存背压 → 合成；任何一层释放都在 `finally` 中完成，跨进程槽位超时会降级为仅进程内限流并告警。
  4. **分镜缓存模块**（新增 `packages/ffmpeg-kit/shotCache.mjs`，本期只建能力未接线）：缓存键 = 图片内容哈希 + 视窗几何 + 运镜档 + 帧数 + photo3d 款 + 标题文本/位置 + 画布 + `SHOT_CACHE_VERSION`；命中时必须通过 `probeDurationSec` 时长校验（≥ 预期 90%），损坏即删除；容量上限 2GB（`JX_SHOT_CACHE_MAX_MB`），按 `lastHit` LRU 淘汰到 80%；落盘 `storage/cache/shots/{key}.mp4|.json`。
  5. **两阶段渲染验证结论**（未接线）：6 镜 / 1080×1920 / 每镜 2s 基准——单进程 6 分支全链 **100.65s**；拆成「6 段各自独立渲染（12.00s）+ 一次拼接转场（31.02s）」合计 **43.02s，提速 57%**。根因是 6 条并行分支同时活跃导致 CPU 缓存与内存带宽劣化（每帧成本 63.7ms → 402.6ms）。
  6. **两阶段渲染为何本期未落地**：需要把 `composer.js` 内联的逐镜滤镜链（底板/蒙版/运镜/标题，约 300 行）抽成独立渲染器，并让装配阶段以 `matched[i].file = seg_i.mp4` 复用现有 video 分支；这属于架构级重构，仓促修改会引入视觉回归。下一期实施要点：①新增 `renderShotUnits()` 逐镜渲染器（复用现有 helper）；②装配阶段复用 compose 的 video 分支 + `skipPlateBase` 开关（保留装饰/CTA）；③接入 `shotCache` 读写；④保留单进程路径作为 fallback（`JX_TWO_STAGE=0` 可关闭）。
- **P1~P4 已全部落地**（2026-10-18，同分支工作区改动，按用户要求未跑渲染验证，统一留待后续验证）：
  1. **P1 两阶段渲染（composer.js + timeline.js）**：`compose` 新增三个开关——`shotOnly`（只渲染单镜画面，跳过装饰/CTA/字幕/AI 标识/片头层）、`skipPlateBase`（装配阶段跳过底板/烘焙/蒙版/逐镜标题，保留装饰/CTA/字幕/片头层/音轨）、`outName`（自定义产物名）；另新增 `_isLead`/`_isTail` 逐镜标记，避免单镜 compose 时每镜都套用开场淡入与收尾运镜。
     - `timeline.js` 新增 `renderShotUnits()`：逐镜串行调用 `compose(shotOnly)`，产出 `seg_NN.mp4`；`composeProductVideoInner` 在 TTS/时长/BGM 编排完成后分流，成功则走「分镜 → 装配」，任一环节抛错自动回退原单进程路径（`JX_TWO_STAGE=0` 可强制关闭）。
     - 装配阶段把 `matched[i] = { file: seg_i.mp4, duration }` 传入，复用现有 video 分支做 xfade、装饰、CTA、字幕、AI 标识、片头视觉层与音轨混音。
  2. **P2 分镜缓存接线**：`renderShotUnits` 每镜先算 `shotCacheKey`（图片内容哈希 + 视窗/黄金形态 + 运镜 + 帧数 + photo3d + 标题 + 标题位 + 画布），命中且时长校验通过则直接复用；未命中渲染后 `putCachedShot` 写入 `storage/cache/shots/`；任务末尾 `pruneShotCache()` 做 LRU 收尾（失败不影响出片）。
  3. **P3 跨进程调度**：见上一条（磁盘槽位 + 内存背压），已在 `composeProductVideo` 包装层生效。
  4. **P4 编码策略**：`shotOnly` 中间片走 `-crf 16`（可用 `opts.crf` 覆盖）以保证二次编码质量；装配终片保持 `-maxrate 2.5M -bufsize 5M` 控制体积；分镜阶段显式传 `maxSeconds: 0` 避免被截断。
  5. **进度上报**：分镜阶段映射到 40~60%（`分镜渲染中 i/N`），装配阶段沿用 composer 内部 63~98%。
  6. **待验证清单（统一验证时执行）**：①单进程 vs 两阶段的成片像素/时长一致性；②分镜缓存命中率与二次任务耗时；③跨进程槽位在「网关 + 脚本」双进程下的互斥；④内存背压阈值 400MB 是否适配；⑤片头视觉层在装配阶段（video 分支 + skipPlateBase）是否正确叠加；⑥旧链路（视频配音/口播/切片）零回归。
- **导演 LLM 四级降级链**（2026-10-18 用户定版，`apps/web/server/director.mjs`）——模型 ID 已通过 `GET /v1/models` 实列核对：
  1. 一层 `zai-org/GLM-5.3-Flash`（速度优先，正常快路径，temp 0.85，reasoning_effort=low）
  2. 二层 `deepseek-ai/DeepSeek-V4.1-Flash`（快速互备，关闭思考链，temp 0.5）
  3. 三层 `Pro/deepseek-ai/DeepSeek-V3`（质量兜底，temp 0.4）
  4. 四层 `Qwen/Qwen2.5-14B-Instruct`（最终低成本兜底，temp 0.3）；仍失败抛错交 mocker
  - 排序口径（用户定版）：**优先保证出片时长**，flash 级在前，旗舰级在后兜底。
  - 环境变量：`SILICONFLOW_DIRECTOR_MODEL` / `_SECONDARY_MODEL` / `_FALLBACK_MODEL` / `_QUATERNARY_MODEL`；调用链改为数据驱动数组，后续增删层只改数组。
  - **已知风险**：降级条件目前只认「调用抛错」。首选 flash 若返回字段缺失/特效 key 编造/时长越界的 JSON，`sanitizeDirectorCut` 会静默修补而不触发升级，画面质量会被悄悄降档。后续应把契约校验（JSON 可解析 + 字段完整 + 特效 key 合法 + 时长合规）接进降级条件。
  - **思考档位**：GLM-5.3 官方默认 `max`（面向复杂编码/架构任务），对导演 JSON 输出属于浪费。已对 GLM 系列下发 `reasoning_effort`（默认 `low`，可用 `JX_DIRECTOR_REASONING_EFFORT` 改为 high/max）；其他模型不下发该字段，避免未支持参数导致 400。超时默认从 60s 提到 90s，`max_tokens` 从 4096 提到 6144（可用 `JX_DIRECTOR_MAX_TOKENS` 覆盖）。
  - **流式已引入**：`stream: true` + SSE 逐段拼接。首包超时 12s（`JX_DIRECTOR_FIRST_PACKET_MS`），超过即中止降级；总超时 90s（`JX_DIRECTOR_TIMEOUT_MS`）。目的是让 12s 内能看到数据在流动，避免非流式「还在吐字就被误判超时」。
  - **连通性实测（2026-10-18）**：四层全部 PASS——GLM-5.3-Flash 0.8s / DeepSeek-V4.1-Flash 0.6s / DeepSeek-V3 Pro 1.4s / Qwen2.5-14B 2.1s（极短 prompt，不代表真实导演任务耗时）。同时验证 `reasoning_effort=low`、`enable_thinking=false`、`stream + json_object` 三组参数均被接受。
  - 生效需重启网关进程。

- **TAG1~TAG10 视觉对齐全量复核**（2026-10-19，工作区改动待审核）——用户铁律：**`docs/visual-gallery/index.html`（实验室）为唯一视觉真相源，执行引擎「只执行不加工」**。实验室画布 269×478 代表成品 1080×1920，换算比例 **×4**。按 TAG 顺序逐条比对并落地：
  1. **TAG1 scheme 封面开场（14 款）**：`backgroundPresets` 全部按实验室 `bg_css` 重写渲染（纯色 4 / 径向渐变 4 / 带角度线性渐变 6），像素级抽样验证通过，测试 4/4 绿。
  2. **TAG2 photo_layout（6 款）**：数据源（frozenAssets）与消费侧 `windowRectOf` 几何完全一致，**无需修改**。
  3. **TAG3 motion 运镜（6 款）**：语义/幅度与实验室一致；修复 **v4 sweep y 居中笔误**（`iw/zoom` → `ih/zoom`）；对全库 9 处 zoompan 审计无同类残留。
  4. **TAG4 transition 转场（5 款）**：与实验室完全一致，**无需修改**。
  5. **TAG5 text_anim 文字动效（5 款）**：按实验室重写——时长 0.8/0.85s、幅度 ×4 换算、`slide_in` 方向纠正为从左滑入、easing 改 smoothstep；`micro_pop` 缩放以位移近似（已登记），drawtext 单帧验证通过。
  6. **TAG6 photo_3d 图片版式（14 款）**：几何重写（asym 改真圆角弧线 176px、固定像素 224/144/224）；shadow 三档接线（背光 8 款 / 深曜投影 2 款）；烘焙 mask+glow 双层并存；小样冒烟 PASS。**登记微差**：`floating_glow`/`pure_clean` 的 8px 图片圆角未做（需动 prescale 签名，观感极弱）。
  7. **TAG7 golden_split 黄金分割（4 款）**：重写为**真物理切片**（黄金点 38.2%/61.8% 切分双翼、72px 中缝、图窗 96%×88%、中缝题字 T17-T20 重写），冒烟 PASS。
  8. **TAG8 ending 结尾收束（19 款）**：4 骨架全部按实验室直译 ×4 重写（居中 0.5h、0.68 曜黑底罩、字号 52/32、ghost 盒内容驱动、pillar 横排+折行、typo 56/34）；composer `black_out` 0.5s 纯黑 / `fade_out` 0.8s 曜黑差异化、CTA 淡入 0.5s。CTA 测试 3/3 + 像素冒烟 4/4 + compose 冒烟 PASS。**登记**：`zoom_far` 引擎取尾镜 pull_out strong 持续运镜（实验室 0.7s scale0.82 瞬时）语义近似维持；`brand_out` 按用户指令**维持暂不处理**。
  9. **TAG9 decorator 装饰图层（10 款）**：6 画布类全部按实验室深色档直译（含新增 `swiss_wire` 独立实现、`feDropShadow` 微阴影、三档 opacity 常量）；`text_follower` 3 款重写为 100×100 归一化拉伸直译；side letters 字号/档位/渐变/旋转对齐。index.js 导出 + composer 接线完成，测试 8/8 + 主题 9/9 + 冒烟全绿。
  10. **TAG10 font 字体字族（6 款）**：字族映射 5/6 与实验室字库文件完全一致（source_han→SourceHanSansCN；mashanzheng/zcool_kuaile/zcool_huangyou/zcool_xiaowei→materials/fonts/*.ttf）；**songti 差异登记为非缺口**（实验室用系统字体 'Songti SC'/SimSun，实验室自身亦无 Songti @font-face；引擎以 Noto Serif SC 替代，均属衬线宋体观感，无 OFL 授权宋体可直连）。**字重对齐实验室权威档**：标题 400→600（`.title-text` 主导档 600，7 款布局 6 款 600 / split-corners 700）、字幕 300→400（`.subtitle-text` 400），落点 `composer.js` 两处 + `cover-kit/typography.js` fontId 直连模式一处；display 单档族由解析层归一 400 不受影响。6 款 font_id × 双档（600/400）解析全绿。**顺带修复**既存陈旧字幕测试断言（`test-subtitle.test.mjs` 4 处 x/y 单引号，源码正确、测试未同步的历史 regression）。
  - **验证**：`node --check` composer.js/typography.js/fonts.js 通过；覆盖测试 34 项（cover-kit 4+8+3 + shared 12 + visual-director 7）全 PASS；subtitle-kit 4/4 PASS。
  - **生效条件**：改动在磁盘，Node ESM 网关进程仍持旧代码——**需重启网关进程**方生效；真实出片观感确认待用户授权（付费红线）。

---

- **原视觉实验室全面清理，唯保留 V4 实验室**（2026-10-21，用户指令）——用户铁律升级：**视觉参数唯一真相源 = `packages/shared/frozenAssets.js`（冻结定版清单）+ 各 kit 可执行实现（cover-kit / ffmpeg-kit），物理素材唯一真相源 = `materials/`；全平台严禁到处复制相同素材，每份文件只放正确位置**。原 `docs/visual-gallery/index.html`（全量 88 款自由搭配实验室）为设计期参照物，其参数已全部固化进执行层，历史使命完成，全量清理：
  1. **删除原实验室及其资产**：`docs/visual-gallery/index.html` 与 `docs/visual-gallery/assets/` 全量删除（约 10MB：预览样片 MP4/PNG、字体副本、音频试听副本、元数据 JSON）。其中字体/音频副本与 `materials/` 物理文件重复，属违规复制，按 canonical 原则删除副本、引用保留方；效果样片为实验室独有演示产物，随实验室一并退场。
  2. **删除实验室维护脚本两件套**：`scripts/update-gallery-full.mjs`（原实验室元数据回填）、`scripts/generate-tables-snippet.mjs`（表格片段生成）——输入即被删的 assets 目录，无存在意义。
  3. **审计镜像迁移至正规位置**：`scripts/check-materials-integrity.mjs` 输出从 `docs/visual-gallery/assets/assets_inventory.json` 迁至 **`docs/materials/assets_inventory.json`**（自动建目录）；JSON 内 `audition_file`/`font_file` 全部改指 canonical 路径（`materials/audio/*`、`materials/fonts/*`、`packages/cover-kit/assets/fonts/*`），不再保留实验室副本路径；原指向实验室样片的 `file` 字段置空并备注（`verified_render` 历史结论保留有效）。
  4. **修复既存损坏**：HEAD 提交（5601d6e）删除 `packages/visual-director/` 后，本脚本 import 已悬空无法运行（`ERR_MODULE_NOT_FOUND`）——本脚本 import 改接 `frozenAssets.js`（scheme 14 款）与 `effectsLibrary.js`，删除随包消亡的 `openings_mechanisms`（O01~O12 导演机制）段，注释重排后跑通：333 首音频 / 5 款物理字族 / 15 种转场 / 23 项硬编码保护资产。
  5. **注释真相源改指**：`backgroundPresets.js`（2 处）、`decorators.js`（2 处）、`typography.js`（1 处）、`composer.js`（3 处）共 8 处「对齐实验室 docs/visual-gallery」注释，全部改指 frozenAssets.js 冻结定版 + 本 kit 实现，杜绝悬空路径。
  6. **文档同步**：`结构树说明.md` visual-gallery 条目收敛为 V4 两件套、补 `docs/materials/` 条目、删两脚本条目；本交接文档登记本条。
  7. **V4 实验室资产纪律不变**：`docs/visual-gallery/v4.html` 唯一外部引用为 `storage/outputs/product-window-v4-preview/preview.mp4`（由 `modules/visual_engine_v4/tests/preview.mjs` 生成的运行时产物，位置经 `docs/architecture/visual-engine-v4.md`  documented，非素材库复制品）；V4 页面零 fetch/localStorage 纪律保持。
  - **验证**：`node --check` 4 个改动包文件 + 审计脚本全过；`node --test docs/visual-gallery/v4-check.mjs` 6/6 全绿（含本地预览 MP4 存在性，本轮已用 preview.mjs 实生成补全）；`check-materials-integrity.mjs` 跑通并物化新镜像；`npm run check:health` PASSED；全库 grep `visual-gallery/index.html` / `visual-gallery/assets` 代码零残留（本交接文档历史记录除外）。
