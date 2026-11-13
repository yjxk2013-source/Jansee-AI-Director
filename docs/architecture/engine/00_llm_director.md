# 00 · LLM 大导演架构（现行权威）

> 版本：v1.0（2026-10-12 定版，最高优先级）
> 取代：剪辑引擎程序编排层（见 [01_editing_engine.md](./01_editing_engine.md) 退役横幅）

## 1. 架构铁律

1. **LLM 是真正的大导演**：逐镜素材、台词、时长、转场、运镜、开场/结尾、BGM 情绪、音效取舍全部由 LLM 一次调用决定；**程序只做特效执行器**（查表 + 滤镜注入），不做任何编排决策。
2. **工程校验只兜底不限制**：非法特效名静默回退默认、越界索引自动补位、画面时长按 TTS 实测校正。目标是「最终能看到想要的成片」，绝不因特效名写错中断出片。
3. **N 图 = N 镜铁律**：分镜数与用户上传图片一一对应，每张图必须在成片完整显示，不得遗漏（sanitize 层去重 + 遗漏补位）。空镜/自有素材库已全面退役。
4. **mocker 仅兜底**：`generateConstitutionScript` 是纯程序剧本，只在 LLM 导演调用失败时启用，保证出片永不中断。
5. **硬件地基**：4核4G、2 并发必须正常出片。特效必须限定作用域（转场只在切换瞬间、开场限定首镜 ≤1.2s、结尾限定末镜），禁止全片级重滤镜。
6. **禁止调色**：素材原色直出，链上 RGB→YUV 统一 BT.709 标记。

## 2. 模块地图

| 模块 | 路径 | 职责 |
| :--- | :--- | :--- |
| 导演接口 | `apps/web/server/director.mjs` | SiliconFlow（DeepSeek）单次调用出全片 JSON；json_object 模式；温度 0.9 失败重试 0.3；sanitize 层执行 N图=N镜 + 参数钳位 + visual_design 透传。**prompt 单一真相源 = `apps/web/server/prompt/*.md`（运行时读取）**：constitution.md（V6 宪法导演：全局铁律+统一 JSON 契约+§3.5 导演手艺库，见 3.1 节）+ director-sell.md / director-local.md（人设导演：人设定位+变体表+判定优先级+台词铁律，sell/local 整份注入，personal 无）+ 视觉设计菜单（visualMenuTextForLLM 自动生成，见 rules.js）。**严禁在 director.mjs 里硬编码提示词常量**（曾因此出现 md 与代码双真相源打架） |
| 变体导演 | `apps/web/server/prompt/index.js` | `decideVariantLocal`（判定第一权威）：文案命中强信号正则 → decidedVariant 注入 prompt（LLM 不得改判）；未命中 → 交 LLM 按人设 md 选择逻辑兜底；personal 无变体体系内置返回空。mocker 兜底（generateConstitutionScript）复用同一判定器 |
| 特效库（唯一权威） | `packages/ffmpeg-kit/effectsLibrary.js` | 开场 7（5 reveal + 2 filter）/ 转场 5 / 运镜 6 / 结尾 4 的 resolve* 查表函数与非法 key 静默兜底；逐镜编排已由视觉蓝图引擎（packages/shared/visualComposerRules.js）接管，特效菜单不再随 prompt 下发 |
| 调度编排 | `apps/web/server/index.mjs`（produce 路由）+ `modules/image_creator/api/index.js` | produce 路由：decideVariantLocal 变体判定 → generateDirectorCut LLM 导演 → catch 回 mocker → createTask（任务注册表/进度/产物 URL）；`assembleVisualDesign` 给两种剧本统一挂视觉层（LLM visual_design 经 `sanitizeVisualDesign` 兜底清洗：枚举非法回退黑曜石默认、组合越界按 LAYOUT_DEFAULT_COMBOS 回退该布局默认维度），两者落点 `modules/image_creator/api/visual.js`；`alignShotMedia` 一镜一图 |
| 合成编排 | `modules/image_creator/core/timeline.js` | 转场查表（cut→0.05s 近似直切）、时长 = 导演值∨3.0s 与 TTS 实测取大 +0.6s 尾隙、BGM 4.5 段、TTS speed=1 |
| 合成器 | `packages/ffmpeg-kit/composer.js` | Ken Burns 6 档运镜（构图开窗/黄金切片几何）、xfade 转场、首镜 openingFilter 消费（fade 覆盖 / blurIn 限时模糊层渐隐）、endingKey 消费（zoom_far 末镜强制拉远）、ending_id 19 款场景收场 CTA 物化、BGM duck + 1.5s 结尾淡出 |
| BGM | `packages/audio-kit/bgm.js` | `selectBgmByEmotion(bgm_emotion, duckWindows)`：情绪目录轮转、非法情绪落 generic、两段式 duck（人声 0.10 / 其余 0.22）、人声永远优先 |
| 视觉引擎 | `packages/cover-kit/` | reveal 类开场（slam_black/dive_in/curtain_v/poster/light_sweep）+ 黑曜石标题层；背景分析对图片走 sharp 直读（ffmpeg 对图片 -ss 抽帧静默零输出，实测验证） |

## 3. 特效菜单（新引擎定版：编排由蓝图接管，LLM 不再逐镜选特效）

- **开场 7**：reveal 类 5（视觉引擎层执行）——slam_black 黑场砸出 / dive_in 加速贯入 / curtain_v 帘幕展开 / poster 大字报 / light_sweep 扫光入场；filter 类 2（合成层首镜淡入）——fade_reveal 黑屏渐显 / flash_in 闪白入场。蓝图模式下首镜开场收敛为 dive_in（director normalize 出口定值），其余 key 保留 resolve* 查表兼容
- **转场 5**：dissolve 叠化 / fadeblack 黑场 / fadewhite 闪白 / cut 直切（xfade=null）/ slide 轻快上滑（slideup）——蓝图 TRANSITION_CYCLE 相邻互斥轮选
- **运镜 6**：push_in 推近 / pull_out 拉远 / diagonal 斜向掠 / rise_up 垂直缓升 / sweep 横向平移 / breathing 呼吸律动（0-5 档映射 Ken Burns）——蓝图 MOTION_CYCLE 相邻互斥轮选
- **结尾 4 + 15 场景收场文字**：基础款 black_out 黑场收束 / fade_out 淡出 / zoom_far 快速拉远（末镜强制拉远专属实现）/ brand_out 品牌收尾（暂走默认尾淡出）；场景收场文字走 ending_id 体系 19 款（4 基础 + 15 CTA：线上商家 5 / 线下商家 5 / 个人创作者 5，与基础款组合使用，蓝图 ENDING_POOLS 按场景池编排，composer 物化 CTA 图层）

## 3.1 导演手艺库（constitution.md §3.5，2026-10-13 增补）

- **来源**：外部开源经验提炼注入 prompt 库——video-use（browser-use 口播剪辑 skill）的「音频优先」剪接手艺（气口即剪辑点 / 情绪峰值要接住）+ video-shotcraft（124 张镜头配方卡）的镜头语言（单手法原则 / hold 呼吸 / 能量曲线强冲击 ≤3 处 / 反炫技）。
- **定位**：创作参考非硬限（与宪法第 1 条创作自主权一致），只喂知识不约束输出契约；逐镜 key 合法性仍由特效菜单 + resolve* 静默兜底保障。条目中引用的 key 均已对照 effectsLibrary.js 真实菜单校验，无幻觉 key。
- **video-use 三条工程硬规则对照结论**（结论：引擎已覆盖，无需改动）：①字幕滤镜链最后烧录——composer.js 已满足（drawtext 在 xfade/结尾淡出之后）；②分段音频边界淡入淡出——已有等效实现（转场音效前移/截断 0.12s 快淡出、BGM 1.5s 尾淡出、TTS 气口天然隔离）；③分段 -c copy 无损拼接——图片出片域为静态图单次编码不适用，视频素材路径 slicer.js 已走 -c copy。
- **token 代价**：约 +600 token/次导演调用（constitution.md 为静态模板，sell/local/personal 三场景固定分摊）；相对 prompt 体积敏感度可接受。

## 4. 成片数据流

```
用户上传 N 图 + 产品描述
  → apps/web/server/index.mjs（produce 路由）：decideVariantLocal 强信号变体判定（命中 → decidedVariant 锁定，未命中 → 空）
  → 【并行预热】preanalyzeAssets（modules/image_creator/api/index.js）：LLM 等待期对全部有效上传图 sharp 直读做背景四维分析，
     结果落盘任务目录 bg_analysis.json（fire and forget，失败静默由合成期现算兜底）
  → director.mjs：一次 LLM 调用 → 全片 JSON（title/variant_type/voice_gender/bgm_emotion/bgm_on/sfx_on/opening/ending/cover_line/visual_design/shots[{asset,line,duration,pause_after,motion,transition}]）
     · prompt 注入创作差异化上下文（creativeLedger 最近 3 条成片的开场/结尾/视觉/BGM 组合，只提示不强制）
  → sanitizeDirectorCut：N图=N镜、去重补位、duration 钳 1~8s、pause_after 钳 0~1.5s、visual_design 透传
  → modules/image_creator/api/visual.js：assembleVisualDesign 挂视觉层（主标题=LLM title、副标题=cover_line、排版=LLM visual_design 经兜底清洗）+ alignShotMedia 一镜一图
  → core/index.js：TTS 合成 → 时长校正 → 逐镜转场查表 → BGM 选曲(duckWindows)
  → composer.js：Ken Burns + xfade + drawtext 字幕 + openingFilter/endingKey + BGM duck/淡出
     · 视觉引擎背景分析优先读 bg_analysis.json 缓存（同素材路径精确匹配），未命中现算
  → final.mp4（1080x1920 / 25fps / libx264+yuv420p / bt709）+ cover.jpg（2.6s 抽帧）
  → recordCreative：本片全局创意决策（opening/ending/visual_design/bgm_emotion/variant_type）落创作防重账本
```

## 4.1 AIGC 合规双标识（GB 45438-2025 / 网信办《人工智能生成合成内容标识办法》）

1. **显式标识**：画面右上角「AI 生成」溯源角标，`subtitle/subtitle.js buildAiBadgeOverlay` 逐帧烧录，所有成片强制。
2. **隐式标识（文件元数据内嵌码）**：`composer.js` faststart remux 步骤写入（所有成片必经，`+use_metadata_tags` 落 mdta atom）：
   - 国标附录 B 推荐字段：`Label=AIGC`、`ContentProducer=Jansee`、`ProduceID=<taskId>`、`ReservedCode1=JANSEE`（平台编码预留，正式备案下发后替换）
   - 兼容扩展字段：`comment=AI-Generated:true; Provider:Jansee; ContentID:<taskId>`、`ai_generated=1`、`provider=Jansee`、`content_id=<taskId>`
   - remux 失败时保留原文件继续出片（兜底不阻断），此时仅缺元数据，显式角标不受影响。
   - 服务提供者编码暂用 JANSEE 代位；正式备案编码下发后仅需改 composer.js remux 段常量。

## 5. 程序兜底清单（全部静默，绝不中断）

| 异常 | 兜底 |
| :--- | :--- |
| LLM 调用失败（两次重试后） | mocker `generateConstitutionScript` 程序剧本（director:'fallback'） |
| 非法转场名 | resolveTransition → dissolve；cut 恒返 null（0.05s 近似直切） |
| 非法开场名 | reveal 类 → none；filter 类 → 无滤镜 |
| 非法运镜/结尾 key | 运镜 → 0 档；结尾 → 默认尾淡出 |
| visual_design 非法/缺失 | sanitizeVisualDesign 兜底清洗：枚举非法或缺失 → 黑曜石默认；组合越界 → LAYOUT_DEFAULT_COMBOS 该布局默认维度（清洗产物保证过 validateVisualJSON/validateCombo，视觉引擎零抛错） |
| asset 越界/重复/遗漏 | 首现顺序去重 + 未用图按序补位 |
| 某句 TTS 失败 | 该句静音兜底不阻断；全部失败才判定任务失败 |
| generic 曲库缺失 | FALLBACK_FOLDER → folders[0] |
| 视觉引擎异常 | 合成层降级无片头层继续出片 |

## 6. BGM 契约（详见 03_audio_constitution.md）

- 曲库 `materials/audio/`（2026-10-12 三批 Mixkit 扩容定版）：16 个 BGM 情绪目录各 20 首 + `generic` 兜底池 4 首 + `outro_sfx` 结尾专用音效池（用户手工裁剪至 9 个，运行时 sfx.js 直接扫目录自动适配，永不删除）；`intro_sfx` 片头音效池已整体迁移移除；LLM 永不会点名的 22 个情绪目录（负面情绪 + 近义词源目录，88 首）已删除。目录即情绪名，`*_sfx` 目录是音效不是情绪。
- 情绪池 16+1 个（director.mjs BGM_EMOTIONS 白名单）：luxury / warm / calm_narrative / relaxed / tech_future / fresh / inspirational / passionate + **二批新增 4 个：romantic（love tag）/ nostalgic（lo-fi+lifestyle tag）/ epic（epic-drama+cinematic tag）/ playful（comedy tag）** + **三批新增 4 个：corporate（corporate+documentary tag，商务专业）/ cozy（wellness tag，治愈温暖）/ energetic（workout tag，动感活力）/ dreamy（fairytale tag，梦幻轻盈）** + generic 兜底。新增曲目来源 Mixkit Stock Music Free License（免费商用无需署名，与 Pexels License 同级；Pexels 官方 API 无音乐端点且网页被 Cloudflare 拦截，故换 Mixkit），串行下载脚本 scripts/fetch-mixkit-bgm.mjs（含跨轮防重账本 mixkit-downloaded.json）。
- 运行时选曲直接扫目录（bgm.js），`materials/audio/index.json` 仅为参考账本（`scripts/reindex-bgm.mjs` 自动发现重建）；bgm.js 的 MOOD_REDIRECT 近义词重定向表已随扩容摘除 nostalgic/romantic/epic/dreamy 四条（目录真实存在后不再重定向），healing 由 warm 改道 cozy（治愈语义接管）。
- SDK 依赖注意：`tencentcloud-sdk-nodejs` 已离线装入 `packages/tts-kit/node_modules/`（含全部 35 个传递依赖闭包，来源 F:\JianXi-v2），密钥走 `.env` 的 `JX_TTS_TENCENT_SECRET_ID/KEY`；微软 Edge TTS 已于 2026-10-12 彻底移除（不可商用且常态风控 403），TTS 为腾讯云单通道，供应商链耗尽时句级静音兜底、全句失败任务失败退款。

## 7. 运行时保障与防重机制（2026-10-12 定版三件套）

### 7.1 TTS 账号级探活（ttsProbe.mjs）

- 依据：腾讯 TTS 所有音色共用同一账号接口，失效为账号级——单次极短合成探活即可判定账号健康，无需逐音色检查。
- 调度：网关启动 30s 后首探（尽快暴露失效），此后每日 04:00 错峰自检（业务低谷）；链式 setTimeout 续约，进程常驻期间每日一次。
- 探活动作：`resolveTTSProvider()` 取链首供应商，合成单字「探活」到系统临时文件（voiceId 101027 温柔女声），成功即账号健康。
- 结果落盘 `server/data/tts_probe.json`（ok/latencyMs/probedAt/trigger/reason）供运维查看；探活失败仅 console.error 告警，绝不触碰出片链路。

### 7.2 LLM 等待期图片预计算（模块 preanalyzeAssets，modules/image_creator/api/index.js）

- 动机：LLM 导演调用耗时秒级，期间把合成期必经的「首镜背景四维分析」提前并行做完，缩出片总时长。
- 实现：阶段 1 发起 LLM 调用的同时 fire and forget——对全部有效上传图 sharp 直读（毫秒级纯 CPU）跑 `analyzeBackground`，结果按素材绝对路径为 key 落盘任务目录 `bg_analysis.json`。
- 消费：视觉引擎 `buildOpeningVisualPipeline` 第 4 步先走 `readCachedBgAnalysis`（路径精确匹配 + 四维特征合法性校验），命中直接复用，未命中现算兜底——两条路径结论一致（禁调色铁律保证原色直出，Ken Burns 仅几何变换不改色彩统计）。
- 边界：只预热图片（视频素材走合成期 ffmpeg 抽帧现算）；预热全程静默吞错，任何异常不影响出片。

### 7.3 创作防重账本（creativeLedger.mjs）

- 动机：视觉/听觉资源此前无跨任务轮流机制，连续出片易观感趋同。
- 账本：每次任务完成 `recordCreative(script)` 记录本片全局创意决策（opening/ending/visual_design 四维/bgm_emotion/variant_type），落 `server/data/creative_ledger.json`，保留最近 20 条；兼容 LLM 原始输出（扁平）与装配后（嵌套 design）两种 visual_design 形态。
- 消费：`buildDirectorPrompt` 注入最近 3 条成片组合为「创作差异化上下文」——只提示不强制，不约束导演创作自由；账本读写任何异常静默吞掉，绝不影响出片。

------------------------------------------------------------------------

## 8. 契约字段口径登记（2026-10-13 阶段三全字段审计，用户批准）

> 口径四分法：①程序读取＝存在代码读取位；②影响产物＝改变最终成片；③LLM 可控＝契约声明且 LLM 输出；
> ④意图/预留＝仅创作意图表达或未来预留。四种状态不得混同。

### 8.1 结论总览

- 统一 JSON 契约（constitution.md §4）26 个字段（顶层 12 + visual_design 8 子字段 + shots 6 子字段）经全链路审计全部为有效消费字段：③LLM 可控、①程序读取、②影响产物三态齐备；无死字段、无「契约存在但 LLM 未输出」字段。
- 特例口径（④创作意图）：`sales_intensity`（宪法 L73）——LLM 输出后仅作为人设导演提示词的创作逻辑输入；渲染管线与创作防重账本（creativeLedger.mjs，仅记 variant_type/opening/ending/bgm_emotion/visual_design）均无读取位，**不得描述为直接控制渲染的字段**；mocker 兜底值见 director.mjs L271（sell='medium'，local/personal 空串）。
- `voice_id` 不属于当前 LLM 输出契约：五路写入全零（提示词真相源/清洗/mocker/前端/storage），timeline.js L112 读取位为冻结预留（详见 03_audio_constitution.md §11.2）。
- `script.sfx` 尚未接通 LLM 写入链：LLM 当前不能直接控制音效强度与三类细分开关（timeline.js L347 消费位恒收缺省：全开 + intensity 0.8）；LLM 可控的音效表达仅 `sfx_on` 整体开关（详见 03_audio_constitution.md §11.3）。
- `bgm_on` / `sfx_on` 是当前有效契约字段（③LLM 可控、②实际影响产物）；`bgm_emotion` 同（选曲白名单见第 6 节）。

### 8.2 注释漂移记录（不擅自修改代码）

| 位置 | 漂移内容 | 处置 |
| :-- | :-- | :-- |
| timeline.js L62 | 注释 `shots:[{line, asset_id, audio_design}]`——实际契约为 `asset`（数字）且无 `audio_design`，全仓库零代码读取 | 挂账，随 image_creator_v1 → v2 协议升级修正 |
| timeline.js L347 | 注释「mocker 与真实 LLM 同结构」——清洗层与 mocker 均不写 `sfx` | 挂账，同上 |
| sfx.js L60 | JSDoc 注释「LLM 导演氛围意图（mocker 与真实 LLM 同结构）」——写入链未接通，prefs 恒收缺省（全开 + 0.8） | 已修正（2026-10-13 阶段收尾；packages/audio-kit 共享层非冻结黑盒，纯注释零行为变更） |

### 8.3 契约字段清单勘误补充

第 4 节数据流（L49）的 JSON 字段清单缺 `sales_intensity`（宪法 L73 的实际契约字段），以 constitution.md §4 为准，本节为补记。
