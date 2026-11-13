# 切片分镜模块 · 开发交接文档（HANDOFF）

> **交接日期**：2026-10-14
> **基线提交**：main @ `affb899`（本地领先 origin/gitee 16 个提交，未推送）
> **接手范围**：切片分镜模块 S2-B 起的实施（切片工具接线、分镜合成 BFF 适配层、前端专版）
> **必读前置**：[AGENTS.md](../../../AGENTS.md)（工作纪律与设计红线）、本文档全部内容

---

## 一、使命与当前状态

切片分镜模块经过 S1（依赖测绘）→ S1.5（性能与契约核验）→ S2-A（核心性能验证）三轮只读/受控审查，已具备实施条件。核心结论：**切片与分镜能力已归并在当前项目内，无需跨仓库移植，剩余工作是 BFF 适配层与前端接线**。

**当前分支 main，工作区干净。** 相关提交：

| 提交 | 内容 |
|---|---|
| `ccba369` | 口播视频模块 v1.0.0（speechcut，已冻结） |
| `fe2fe8e` | speechcut 冻结登记 + speechcut_v1 协议声明 |
| `affb899` | voiceVideo.js 死 import 修复（storyboard 链路可运行的前提） |

## 二、模块冻结状态总览

| 模块 | 状态 | 文档 |
|---|---|---|
| image_creator | 已冻结（image_creator_v1，黑盒，仅经 api/index.js 消费） | modules/image_creator/README.md |
| video-dub（视频营销/视频配音） | 已冻结 v1.0.0 | docs/architecture/video_dub/FREEZE_AND_VERSIONING.md |
| speechcut（口播） | 已冻结 v1.0.0（speechcut_v1） | docs/architecture/speechcut/MODULE_BOUNDARY.md |
| video_creator 包内既有文件（含 video/storyboard.js、video/slicer.js） | 冻结纪律覆盖：只经公开导出消费，改内部须审批 | video_dub FREEZE §四 |
| packages/*（tts-kit 等 7 包） | 待验收，未冻结 | — |

**红线：S2-B 不得修改任何冻结模块内部实现**（含 storyboard.js / slicer.js / composeGate.mjs 本体）。voiceVideo.js L18 的 import 修复是唯一例外且已经负责人批准。

## 三、已批准的产品决策（不可擅改）

1. 切片第一版**免费**，不扣积分（全链本地零成本）。
2. 分镜合成每任务 **200 mock 积分**（currentMockCredits 同款闭包 + creditsCharged 防重，失败重试/409 不重扣）。
3. 成片上限 **180 秒是目标值**：G3（9 镜实测）通过前不得作为对外产品承诺。
4. 第一版分镜最多 **9 镜**，每镜素材 **2–60 秒**（2s 下限已被代码证明安全：offset+XFADE=2.0 贴边，见 §四）。
5. 切片产物经**服务端素材登记制**进入分镜：前端不传文件路径、不开放 outputs 目录读取。
6. 全站出片任务统一 200 积分；真实持久化扣费（userStore.chargeGeneration）全站未接线，属全局债务，不在本模块范围。

## 四、已验证技术事实（S2-B 的设计依据，全部有代码/实测证据）

### 4.1 已归并能力（复用，禁止重写）

| 能力 | 位置 | 说明 |
|---|---|---|
| 分镜合成核心 | `modules/video_creator/video/storyboard.js` L248 `composeStoryboard({taskDir, shots, autoMode, voiceId, bgmPath, subtitles, onProgress})` | 依赖全部指向当前共享包；1920x1080/25fps 归一化；逐镜 sb_shot_*.mp4 → xfade dissolve 0.7s + acrossfade + 尾部黑场 → final.mp4 |
| 切片器 | `modules/video_creator/video/slicer.js` | `videoDurationSec`（L26，ffmpeg -i stderr 解析）、`prepareSlicer`（L98，定长 segSec 切割 + 逐段本地 ASR）、`composeSlicer`（L156，删词修剪原声+字幕+BGM 出片） |
| 并发闸门 | `packages/ffmpeg-kit/composeGate.mjs` L33 `acquireComposeSlot(label)` | 进程内信号量默认 2；**不自动释放，调用方必须 `try{...}finally{release()}`**；无重复提交保护（由状态机 409 承担） |
| 本地 ASR | `modules/video_creator/asr/asr.js` L88 `runASR(audioPath, workDir)` | 本地 whisper.cpp（已部署），报错含部署指引 |

### 4.2 实测性能数据（S2-A，2026-10-14，零付费）

| 组 | 输入 | 纯渲染耗时 | 成片时长 | ffmpeg WS 峰值 | 判定 |
|---|---|---|---|---|---|
| G1 | 2镜×15s/720p | ≈127s | 29.32s（理论 29.3） | 509MB | PASS |
| G2 | 3镜×20s/1080p | ≈187s | 58.72s（理论 58.6） | 438MB | PASS |

外推 180s 成片 ≈ 10 分钟渲染级；内存余量极大。测试脚本 `scratch/test-g1-g2-storyboard-perf.mjs`（不入 Git）可复跑。

### 4.3 关键边界行为（代码锚点）

- **N=1 单镜**：无 xfade 循环体，`[v0]`→fade→`[vout]` 直出（storyboard.js L336-354）。
- **短镜头**：`offset=max(0.001, prevDur-0.7)`，素材 <0.7s 会失败；2s 下限安全（L342）。
- **无音轨/图片镜**：audioKind='none' 走 `anullsrc` 静音垫底，多镜 acrossfade 音频引用恒有效（L164-184）。
- **asr 模式字幕**：由调用方传入 `subtitles[{words, deleted, finalText}]` 重建，composeStoryboard 不自己跑 ASR——**分镜受理不得重复跑 ASR，切片阶段已产出的结果直接透传**。
- **autoMode 判定**：任一镜有台词→tts；全无→asr。
- **时长预估公式**（受理前校验）：`Σ(video 实测秒 + image×12) − 0.7×(N−1) ≤ 180`；完成后 durationSec 终检 ≤181s。
- **XFADE.duration=0.7**（constitutionEffects.js L8-14）；`XFADE.duration`/`FADE` 是唯一效果参数源，引擎不另设。

## 五、S2-B 待实施清单（下一步工作）

### 5.1 新增文件

| 文件 | 内容 |
|---|---|
| `apps/web/server/storyboard.mjs` | BFF 适配层（参照 speechcut.mjs 同构）：素材登记制解析（taskId→服务端自持素材清单→真实路径，前端只见素材 ID）、全部服务端校验（素材存在+realpath 防符号链接、单镜 2–60s、≤9 镜、180s 预检、autoMode、voiceId 白名单 male/female）、`acquireComposeSlot('storyboard:'+taskId)` finally 包裹、inMemoryTasks 状态机（queued/processing→completed/failed，kind:'storyboard'）、分镜 200 积分扣费（creditsCharged 防重）、`composeStoryboard` 调度与 onProgress 落任务进度 |
| `apps/web/server/tests/storyboard/` | BFF 测试（校验矩阵/409/扣费一次/时长拦截/失败重试）+ E2E stub（隔离端口+临时 storage+stub TTS） |
| `modules/video_creator/tests/storyboard/` | 核心测试（storyboard.js 现零测试覆盖；纯函数与时长公式优先） |

### 5.2 修改文件

| 文件 | 内容 |
|---|---|
| `apps/web/server/index.mjs` | 注册路由：切片 prepare/compose + 分镜 compose（照 speechcut 两路由的接线方式，依赖注入 inMemoryTasks/storage 路径/扣费闭包） |
| `apps/web/client/index.html` | currentTab===3 现占位表单接真实流程：切片工具页（prepareSlicer→核对→composeSlicer）+ 分镜成片页（素材选择→主题输入→确认→进度轮询）。前端设计遵守 AGENTS.md 幽灵边框/零 emoji/毛玻璃红线 |

### 5.3 切片接线要点

- 切片免费：切片路由不注入扣费闭包。
- 切片产物 `taskDir/slices/slice_*.mp4`（taskDir=storage/outputs/{slicerTaskId}）→ 完成后向素材登记表写入 {slicerTaskId, fileName, durationSec} → 分镜可引用。
- prepareSlicer 的 segSec 第一版用默认 20s 或前端可调；**不要扩展冻结接口支持用户自选区间**（属 MINOR 级扩展，单列审批）。

### 5.4 验收标准

- 零付费测试全过（asr 模式 + 本地 whisper + stub TTS；**严禁触发真实腾讯云 TTS/LLM**）。
- video-dub 150 断言 + speechcut 85 断言回归全过（证明冻结链路零回归）。
- G3（9 镜×20s 1080p ≈180s）实测通过后才可将 180s 写入产品文案。
- 完成后停下提供变更清单，**不自行提交/合并/推送**（分支纪律：先建 feature 分支）。

## 六、后续阶段（S3-S5，需另行批准）

- **S3**：多素材上传扩展 + 前端会话内素材列表。
- **S5**：分镜解说文案 LLM 生成——复用 `buildDirectorPrompt` 体系新增 prompt（apps/web/server/prompt/，**运行时唯一真相源是 prompt 目录 md 文件**），输入=主题/商品信息+素材清单元数据（时长/有无原声，无画面语义识别），输出=逐镜 `[{shotIndex, text}]`，一次 LLM 调用；LLM 不可用回落 asr 模式。原项目 llm.mjs `generateStoryboardPlan`（仅选音色/BGM）已被此方案替代，不迁移。
- 原项目 `F:\JianXi-v2` 仅作参考：routes/storyboard.js、llm.mjs、前端 script.js 的任务/扣费/素材库机制**全部由当前项目机制替换**，不复制。

## 七、纪律红线（每个 agent 必须遵守）

1. 全程简体中文；根目录禁放文件；scratch/ 放临时脚本（不入 Git）。
2. 冻结模块只经公开导出消费；改冻结内部须先报告获批。
3. 付费调用红线：测试必须零付费或显式人工授权门槛；不得为测试绕过授权。
4. 开发流程：先建 feature 分支；任务书式审批（先方案后动手）；完成后不自行提交/合并/推送。
5. 每次提交前 `npm run check:health`；修改代码必须同步文档。
6. 不重启网关（重启会丢 inMemoryTasks；改磁盘代码后需重启才生效，但重启指令必须来自负责人）。
7. 180s / G3 未实测通过，不得对外承诺。

## 八、环境与测试设施

- Node 22 ESM：测试 loader 用相对路径（`--import` 不接受裸盘符路径）；PowerShell 5.1 无 `&&`，用 `;`；ps1 必须纯 ASCII。
- 本地 whisper：whisper.cpp/bin/whisper-cli.exe + models/ggml-small.bin（不入 Git，.gitignore 已配）。
- 测试素材合成法：ffmpeg lavfi `testsrc2+size+rate:duration` + `sine=frequency:duration`（见 scratch 脚本）。
- 性能采样法：PowerShell 500ms 轮询 `Get-Process ffmpeg` WorkingSet64 + `FreePhysicalMemory`；停止条件 WS>2GB 或可用<200MB。
- 本地 BGM：materials/audio/generic/cheerful_01.mp3（测试用）。

## 九、参考文件索引

| 主题 | 文件 |
|---|---|
| 口播模块（BFF 适配层最佳范本） | apps/web/server/speechcut.mjs |
| 分镜合成核心 | modules/video_creator/video/storyboard.js |
| 切片器 | modules/video_creator/video/slicer.js |
| 并发闸门 | packages/ffmpeg-kit/composeGate.mjs |
| speechcut 冻结与边界（文档范本） | docs/architecture/speechcut/MODULE_BOUNDARY.md |
| video-dub 冻结纪律 | docs/architecture/video_dub/FREEZE_AND_VERSIONING.md |
| 导演提示词真相源 | apps/web/server/prompt/（constitution.md 等） |
| S2-A 性能测试脚本（参考，不入 Git） | scratch/test-g1-g2-storyboard-perf.mjs |

## 十、追记：分镜成片双模式定版（2026-10-24）

分镜成片改为两种声音方案，用户任务级二选一（前端分镜模式第 2 步切换）：

### 方案一 · 原片直出（保原声，默认）
- 链路：多段上传 → `POST /api/v1/storyboard/direct/analyze`（逐段本地 whisper ASR + @jansee/speech-cut detectRedundancy 冗余/长停顿标记；无音轨/零词/识别失败段降级 silent 原样保留，不拖垮任务）→ 用户一次确认页按段分组勾选 → `POST /api/v1/storyboard/direct/produce`（逐段 planSegmentCut + cutSegmentByRanges 音画同步剪除 → 无声段 ensureAudioTrack 垫静音轨 → composeStoryboard autoMode='asr' 叠化拼接 + 剪除后重映射词表烧字幕 + BGM 跨段闪避）→ final.mp4。
- 任务 kind='storyboard_direct'，轮询 GET /api/v1/video/task/:taskId；200 积分/次（creditsCharged 防重）；selections 只传删除标识（白名单校验同口播口径）。
- 编排层：apps/web/server/storyboard.mjs startStoryboardDirectAnalyze / startStoryboardDirectProduce。

### 方案二 · AI 配音（替换原声）
- 链路复用既有统一创作编排：`POST /api/v1/creation/create {type:'storyboard', scriptMode:'auto'}` → generateStoryboardScript 逐镜台词（按每镜实测时长限字数 + 超长自愈重写）→ startStoryboardProduce（composeStoryboard autoMode='tts'：逐镜 TTS + atempo 对齐 + 字幕 + BGM）。
- 后端零改动；前端入口：主题必填 + 描述栏 + materialIds（upload/video 已返回）。
- 适用：无声空镜素材，或用户主动想要解说配音（原声被整体替换，顺带覆盖"原声是杂音"场景）。

### 设计定版依据
- 市场调研（Opus Clip/Vizard/Klap/剪映/度加/智影）：切片型长改短默认全保原声，AI 台词只属生成型产品线——故原片直出为默认方案，AI 配音纯 opt-in，不强加台词（混合素材无声段自然静默）。
- speech-cut 包新增第二消费方能力（planSegmentCut / shiftWordsToKeptTimeline / cutSegmentByRanges，经包单门导出），见 speechcut/MODULE_BOUNDARY.md 追记。
- 旧 `/api/v1/storyboard/concat` 纯拼接端点保留（API 兼容），前端已不再使用。
- 测试：tests/storyboard/test-direct-flow.mjs（6/6，含真实 ffmpeg 集成）；回归 bff/e2e-stub/simplify/creation/speechcut 全绿。

### 发布方案四件套接入（2026-10-24 傍晚追记）

分镜双模式 + 口播链路的成片现在都随片交付「发布方案」（@jansee/publish-kit 四件套）：

- **新增轻量生成器** `director.mjs generatePublishOnly({ transcript, title, sellingPoints, scene })`：单次 LLM 调用（规则全文注入 prompt/publish-rules.md），整体 30s 软上限，任何失败落 sanitizePublish 全兜底——**永不抛错、永不阻断出片**。返回值已剥 `_banned_hits`（命中词留日志），消费方零清洗。
- **原片直出**：startStoryboardDirectProduce 入口按「各段保留词拼接」并行发起，completed 前收口（与 ffmpeg 合成并行，正常零额外等待），`task.publish` 随 GET /api/v1/video/task 原子交付。
- **AI 配音**：creation storyboard 分支按「各镜解说词拼接」并行发起，syncStoryboardSubTask 完成后经 delivery.mjs `pickPublishFields` 白名单补写 outputs.publish。
- **口播**：能力包不依赖 LLM——startSpeechProduce 新增可选 `generatePublish` 依赖注入（与 chargeMockCredits 同范式），index.mjs 路由注入 generatePublishOnly；transcript = 清理后保留词原文。
- **前端**：口播/分镜直出交付处复用既有 renderPublishDeck 卡；analyze 起步清旧卡；AI 配音走 triggerMatrixRender 通用路径（原有）。
- 回归：direct-flow 7/7（新增 generatePublishOnly 契约测试）、storyboard bff/e2e-stub/simplify、speechcut 包 7/7 + bff/e2e、creation 全绿。

### 全版块收敛定版（2026-10-24 晚，四版块审计后执行）

以「四大版块（图片成片/视频配音/口播/切片与分镜）双标配（发布方案 + 结尾收束）」为最新版本，冲突项以本版本为准：

1. **结尾收束全版块标配**：ending-kit 新增 `appendEndingTail`（tail.js，通用尾段追加：结尾淡出 1.5s → 黑停 0.35s → CTA 卡淡入浮出，追加 2.95s 不截断源片；恒不抛错，失败保持原片交付）+ `fitEndingCard` 上移（dubKernel 改再导出，实现单一份）。接入三条链路：口播（speech-cut produce 后追加，scene=local）、分镜直出（startStoryboardDirectProduce，scene 跟随用户工作台选择）、分镜 AI 配音（startStoryboardProduce，scene 跟随 payload）。切片两条（精准截取/智能切片）按审计定版**不加**结尾卡与发布方案（输出是素材/单片，焊 CTA 卡毁用途）。
2. **一代遗留模块清除**：删 `modules/slicer/`、`modules/storyboard/` 全目录与 4 条路由（/slicer/create、/slicer/task/:id、/storyboard/create、/storyboard/task/:id），package-lock 悬空条目同步清理。
3. **旧 stage 路由收敛**：删 /storyboard/produce、/storyboard/concat、/storyboard/script/generate、/slicer/prepare、/slicer/compose 五条 HTTP 路由；底层函数仅保留 creation 内部复用者（startStoryboardProduce/startSlicerPrepare），死函数 startSlicerCompose/startSimpleStoryboardConcat 连测试一并删除。分镜/切片统一走 creation/create 契约（test-e2e-stub 已迁移，21/21）。
4. **智能切片接前端**：切片子模式第三卡（功能二 · 智能切片）→ creation type=slicer（50 积分）→ 交付切片清单（每段 video+转写+materialId，可进分镜二次消费）；合并成片统一走分镜板块，切片不再提供合成步骤（startSlicerCompose 删除）。**同时修复两个真 bug**：creation storyboard 分支 LLM 失败无兜底（补 generateConstitutionScript 兜底，与图片成片同口径）；syncSlicerSubTask/syncSpeechcutSubTask 60s 超时误杀本地 whisper 长任务（放宽 10 分钟）。
5. **scene 口径统一**：口播 local（原误用 personal）、分镜直出/分镜 AI 配音跟随用户工作台场景选择（前端 currentScene 随 analyze/create 提交，服务端白名单归一）。
