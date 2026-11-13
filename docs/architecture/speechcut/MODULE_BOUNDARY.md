# 简兮 (JANSEE) · 口播视频模块职责与依赖边界 (Module Boundary)

> **文档版本**：v1.0.0（speechcut_v1 协议冻结基线，2026-10-14）
> **阶段定位**：v1.0.0 封版交付物（模块化架构只读审查后的边界文档补充）
> **配套文档**：[../video_dub/MODULE_BOUNDARY.md](../video_dub/MODULE_BOUNDARY.md) · [../video_dub/FREEZE_AND_VERSIONING.md](../video_dub/FREEZE_AND_VERSIONING.md)
> **事实来源**：本文档全部内容以当前代码为事实来源（基线提交 ccba369）；文档与代码须同版本演进，防止漂移。

---

## ⚡ 升级公告（2026-10-24，本文正文以下述现状为准）

> 口播模块已完成**独立包化**，正文（v1.0.0 冻结态）描述的是升级前现状，冲突时**以本节为准**：
>
> 1. **物理形态**：核心与 BFF 适配层上移为独立包 `packages/speech-cut`（`@jansee/speech-cut`），
>    对外 API `startSpeechAnalyze` / `startSpeechProduce` 两段式，`exports` 单门
>    （深 import 内部文件直接 ERR_PACKAGE_PATH_NOT_EXPORTED）。原
>    `modules/video_creator/speechcut/` 与 `apps/web/server/speechcut.mjs` 已删除。
> 2. **长停顿标记（新增）**：对齐剪映「智能剪口播」口径——相邻词间隙 ≥0.8s 标记为
>    `reason:'pause'` 删除建议（键 = 间隙 start，与词 start 天然不冲突），用户确认后
>    剪除（两端各留 0.12s 呼吸防画面硬跳，收缩后 <0.4s 不剪）。词冗余三类规则不变。
> 3. **ASR 能力依赖**：经 `@jansee/video-creator/video/keepOriginal.js` 公开入口消费
>    （本地 whisper 词级时间戳），与 image-film 消费视觉引擎同范式；时长探测统一走
>    `@jansee/ffmpeg-kit` 的 `probeDurationSec`（不再经 slicer）。
> 4. **消费方**：网关 `index.mjs`（analyze/produce 端点）与 `creation.mjs`（分支四）均改
>    `import { startSpeechAnalyze, startSpeechProduce } from '@jansee/speech-cut'`。

---

## 一、模块定位与版本标识

口播视频模块负责「用户上传口播实拍视频 → 本地 Whisper 逐词识别 → 展示完整转录与冗余/长停顿删除建议 → 用户逐条确认 → 服务端权威剪辑 → 字幕/BGM → 导出 MP4」的两段式业务流程。

| 项 | 值 |
| :--- | :--- |
| 模块正式名称 | 简兮口播视频模块（jansee-speechcut） |
| 模块版本 | **v1.0.0**（冻结基线，2026-10-14；2026-10-24 包化 + 长停顿） |
| 模块协议版本 | **speechcut_v1**（代码锚点：`packages/speech-cut/index.js` 文件头声明） |
| 基线代码位置 | `packages/speech-cut/`（核心 + BFF 适配层，2026-10-24 起） |
| 与其他链路的关系 | 与图片成片（image_creator_v1）零依赖；与视频配音（video-dub）同网关共存，经 `kind: 'speechcut'` 共用任务轮询端点，分支互斥互不侵入 |

## 二、真实调用链

```text
前端 index.html（口播专版 UI：词块 + 长停顿块确认）
  │  仅 HTTP fetch：POST /api/v1/speech/analyze → 词块确认 → POST /api/v1/speech/produce
  ▼
apps/web/server/index.mjs（HTTP 路由层：参数解析 + sendJson 错误码映射）
  ▼
packages/speech-cut/index.js（编排层：安全校验 / 状态机 / 任务记录 / 计费受理点）
  │  依赖注入：inMemoryTasks、storage 路径、chargeMockCredits 计费闭包
  ▼
packages/speech-cut/（唯一导出面，exports 单门）
  ├─ detect.js      纯函数冗余标记（词三类 + 长停顿，零依赖）
  └─ compose.js     切点规划纯函数 + FFmpeg 合成执行器
       ├─ @jansee/video-creator/video/keepOriginal.js → asr（本地 whisper 词级时间戳，公开能力入口）
       ├─ @jansee/ffmpeg-kit（probeDurationSec / 音轨检查 / 出片并发闸门 acquireComposeSlot）
       ├─ @jansee/subtitle-kit（drawtext 字幕滤镜）
       ├─ @jansee/audio-kit（情绪选曲 + sidechain 闪避滤镜链）
       └─ @jansee/shared（字体等资产寻址）
```

依赖严格单向：无任何文件反向引用 speech-cut（已 grep 验证）；核心不接触 HTTP 请求对象、前端状态或进程级全局单例。

## 三、对外导出入口（消费边界）

调用方**只能**经 `@jansee/video-creator/speechcut/index.js` 消费本模块，禁止直接 import `detect.js`、`compose.js` 内部文件：

| 导出符号 | 类型 | 职责 |
| :--- | :--- | :--- |
| `detectRedundancy(words, text)` | 纯函数（同步） | 冗余词识别（纯规则：保护数字/字母永不标、连续填充词只标第二窗口、宁少勿多），产出 `is_filler` 标记 |
| `planCutRanges({ words, deletedStarts, durationSec })` | 纯函数（同步） | 切点规划：删除词归并为剪辑区间，保守切点策略（GAP_MIDPOINT=0.16s 间隙中点优先 / EDGE_PAD=0.06s 钳位不越保留词边界）；全删时返回 `TOO_SHORT` |
| `buildShiftFn(kept, duration)` | 纯函数工厂 | 旧时间轴 → 新时间轴重映射（字幕时间重算的底层） |
| `composeSpeechcut(...)` | 异步执行器 | 真实 FFmpeg 合成：单 filter_complex 音画同步剪辑、字幕烧录、BGM 混合、并发闸门、产物校验 |

当前唯一调用方为 BFF 适配层（`apps/web/server/speechcut.mjs`）。模块不感知调用方身份，具备被其他编排层复用的条件。

## 四、职责边界（核心模块 / BFF / HTTP 路由）

| 层 | 文件 | 只负责 | 绝不负责 |
| :--- | :--- | :--- | :--- |
| HTTP 路由层 | `index.mjs` 两路由 | JSON 解析、错误码 → HTTP 状态映射（404/409/400）、响应信封 | 业务校验、剪辑算法、任务状态语义 |
| BFF 适配层 | `speechcut.mjs` | 上传路径白名单（仅 storage/uploads，防目录穿越）、音轨/时长校验（无音轨 40003、超 300s 40004）、状态机维护、任务记录写入、计费受理点、删除集过滤 | 剪切算法、滤镜编排、whisper 调用细节 |
| 核心模块 | `speechcut/` 三文件 | 冗余标记算法、切点规划、时间轴重算、FFmpeg 合成与产物校验 | 任务状态存储、计费语义、存储路径决策 |

## 五、输入输出、错误约定与任务状态管理

**输入/输出契约**：

- `startSpeechAnalyze({ videoFile, durationSec })`：受理后落 `words` 词表（含 word/start/end/is_filler）与 `durationSec`（服务端 sllicer 探测值，不信任前端上报）；
- `startSpeechProduce({ taskId, deletedStarts })`：`deletedStarts` 仅为词 start 标识数组，服务端按自持词表过滤未知 start（静默忽略）；剪辑区间、字幕剔除均由服务端权威数据决定，前端时间区间一律不被消费；
- 产物：`storage/outputs/{taskId}/final.mp4` + 字幕烧录进画面（与 video-dub 同策略，无独立字幕文件交付）。

**错误码表**（HTTP 层映射 404/409/400）：

| code | 语义 |
| :--- | :--- |
| 40001 | 视频文件不存在/不可访问 |
| 40003 | 无有效音轨 |
| 40004 | 时长超限（>300s）或无有效内容 |
| 40005 | 不能删除全部内容（保留不足 1s） |
| 40401 | 任务不存在 |
| 40901 | 任务已在生成中或已完成（重复提交拦截） |
| 40902 | 任务尚未完成识别（词表不存在） |

**任务状态机**（复用网关 `inMemoryTasks`，`kind: 'speechcut'` 区分）：

```text
analyzed ──produce──▶ producing ──产物校验通过──▶ completed
    ▲                       │
    │                产物校验失败
    └── failed ◀─────────────┘
（failed 且词表完好：可携新删除集重试，再次进入 producing；completed/producing 重复提交 409 拦截）
```

任务轮询复用既有 `GET /api/v1/video/task/:taskId` 端点（合并查询），不新建任务系统与轮询通道。

## 六、底层能力复用关系

| 能力 | 复用方式 | 消费的公开接口 | 归属判断 |
| :--- | :--- | :--- | :--- |
| ASR 语音识别 | 经 `video/keepOriginal.js` → `asr.js` | `runKeepOriginalAsr`（本地 whisper.cpp，词级时间戳） | 与视频配音共用的 video_creator 包内共享入口；换 ASR 引擎只需改 asr.js，口播核心仅依赖 `{text, words[{word,start,end,is_filler}], segments, duration}` 数据结构 |
| FFmpeg | `ffmpeg-static`（包内依赖）+ 全站并发闸门 | `acquireComposeSlot('speechcut')` 与图片/视频营销链路共享 2 并发闸门 | 公共能力复用 |
| 字幕 | `@jansee/subtitle-kit` | `buildDrawtextFilters`（单行烧录） | 公共能力复用 |
| BGM | `@jansee/audio-kit` | `selectBgmByEmotion`（情绪选曲 + sidechain 闪避滤镜链；选曲失败降级无 BGM 不阻塞出片） | 公共能力复用 |
| 时长探测 | `video/slicer.js` | `videoDurationSec`（ffprobe） | 公共能力复用 |
| 切点规划/冗余标记/音画同步剪辑 | 模块自身 | — | 口播业务逻辑（本模块新增能力，不复制任何公共能力） |
| 任务态 | 网关 `inMemoryTasks` | 内存 Map 注入 | 公共基础设施复用 |
| 积分扣减 | BFF 计费闭包注入 | `chargeMockCredits`（口径定义在路由层，与现有出片路由同款：每次任务 200 积分、余额不足不拦截） | 公共能力复用（当前为 mock 口径） |

## 七、依赖注入与测试隔离

**依赖注入方式**：核心模块与适配层的全部外部依赖（任务表、存储路径、计费闭包）均经函数参数显式注入，模块内无隐藏单例、无 process.env 依赖、无网盘/网络隐式寻址。

**测试分层**（全部零付费、无需启动前端）：

| 层 | 文件 | 断言数 | 隔离方式 |
| :--- | :--- | :--- | :--- |
| 核心单元 | `modules/video_creator/tests/speechcut/test-detect.mjs` / `test-compose.mjs` | 12 / 20 | 直接 import 纯函数，零网关零 FFmpeg |
| 真实 FFmpeg 合成 | `test-compose-real.mjs` | 9 | 本地 ffmpeg 二进制，零付费 |
| BFF 适配层 | `apps/web/server/tests/speechcut/test-bff.mjs` | 11 | 函数级调用 + 注入 Map 模拟任务表，零网关零 FFmpeg |
| 端到端（stub） | `test-e2e-stub.mjs`（配 `e2e-speech-asr-stub-loader.mjs`） | 18 | 隔离端口网关实例 + ASR loader 桩 + 临时 storage |
| 端到端（真实） | `test-e2e-real.mjs` | 15 | 本地 whisper.cpp（零付费），需部署 whisper 二进制与模型 |

## 八、当前已知限制

1. **任务状态为内存存储**：网关重启后任务记录丢失——全站既有设计（视频配音/图片成片同），非口播独有缺口；
2. **真实持久化计费未统一接入**：`userStore.chargeGeneration` 全站出片路由均未接线，当前全链路为内存 mock 积分口径（前端 localStorage 数字与后端 mock 池为两套独立数字）——全站统一扣费架构未立项，非口播独有；
3. **whisper 本地部署依赖**：`whisper.cpp/bin/whisper-cli.exe`（Windows）或 Linux 自编译，模型 `ggml-small.bin`；可用 `JX_WHISPER_CLI` / `JX_WHISPER_MODEL` 环境变量覆盖；部署要求记录于 `modules/video_creator/asr/asr.js` 文件头（运行时唯一真相源），whisper.cpp 不入 Git（.gitignore 隔离）；
4. **合成音填充词识别偏差**：测试中 SAPI 合成的「呃」被识别为「乐」，TTS 合成语音的填充词发音不典型，真实人声识别质量需上线观察；
5. **单任务串行渲染**：受 4核4G 硬件地基约束，与全站一致。

## 九、协议版本与兼容性变更原则

1. 本模块对外稳定面 = 「仅经 `speechcut/index.js` 导出的 4 个符号」+「BFF 层 speechcut 两端点的请求/响应结构、错误码语义、任务状态机」；
2. 模块协议版本 **speechcut_v1** 以文件头注释 + 本文档 §一 登记形式冻结（对齐项目既有惯例：image_creator_v1 为注释/文档级声明，无运行时导出）；接口协议变更必须升级版本（v2 命名 `speechcut_v2`）并同步本文档；
3. PATCH 级（不触碰稳定面）缺陷修复可直接进行，但须通过 §七 全部零付费测试；触碰稳定面须升级版本、全量回归并经负责人批准后提交；
4. 禁止静默变更：稳定面差异在本文档未更新前不得合入 main。

## 十、冻结登记

> **冻结日期**：2026-10-14（经模块化架构只读审查 + 冻结条件盘点后，由负责人批准登记）

| 项 | 值 |
| :--- | :--- |
| 冻结范围 | `modules/video_creator/speechcut/`（detect.js / compose.js / index.js）+ `apps/web/server/speechcut.mjs`（BFF 适配层）+ BFF 两个 speech 端点的前端接线 |
| 模块版本 | v1.0.0（冻结基线，基线提交 ccba369） |
| 协议版本 | **speechcut_v1**（代码锚点：speechcut/index.js 文件头声明；文档锚点：本文档 §一/§十） |
| 冻结基线测试证据 | 85 断言全过（BFF 11 + detect 12 + compose 20 + e2e-stub 18 + e2e-real 15 + compose-real 9，2026-10-14 于 main 实测两轮） |

**稳定公共接口清单（冻结面，变更须升级 speechcut_v2）**：

| # | 稳定项 | 代码锚点 |
| :--- | :--- | :--- |
| 1 | `detectRedundancy(words, text)` 纯函数 | speechcut/index.js re-export |
| 2 | `planCutRanges({ words, deletedStarts, durationSec })` 纯函数 | speechcut/index.js re-export |
| 3 | `buildShiftFn(kept, duration)` 纯函数工厂 | speechcut/index.js re-export |
| 4 | `composeSpeechcut(...)` 异步执行器 | speechcut/index.js re-export |
| 5 | `POST /api/v1/speech/analyze`（请求/响应结构与安全校验语义） | apps/web/server/index.mjs |
| 6 | `POST /api/v1/speech/produce`（词标识 deletedStarts 契约、计费受理语义、每任务 200 积分口径） | apps/web/server/index.mjs |
| 7 | 错误码语义（40001/40003/40004/40005/40401/40901/40902）与任务状态机（analyzed→producing→completed/failed） | §五 |
| 8 | 消费边界：其他模块只能经 `@jansee/video-creator/speechcut/index.js` 公共导出与上述端点调用，禁止直接依赖 detect.js / compose.js 内部实现 | §三 |

**不在冻结范围（内部实现可自由重构面，不升版本）**：切点保守策略参数（GAP_MIDPOINT/EDGE_PAD 数值）、冗余标记规则细节、滤镜编排内部实现、stage 文案与错误 msg 中文措辞（code 才是稳定依赖面）。

**解冻审批原则**：

1. PATCH 级缺陷修复（不改变请求/响应结构、状态枚举、错误码语义、字段名、端点路径）可直接进行，须通过 §七 全部零付费测试；
2. 触碰稳定面的任何变更必须：升级 `speechcut_v2` → 更新本文档（§一/§九/§十/变更履历）→ 全量回归通过 → 提交变更清单等待负责人批准后方可提交合入；
3. 收紧校验使此前合法输入变为失败、改变计费口径或失败任务语义，均属 MAJOR 级变更，禁止以修复名义进行；
4. 禁止静默变更：文档与代码同版本演进，稳定面差异在本文档未更新前不得合入 main；
5. 本模块冻结不解除其调用的共享能力包（packages/*）与 video_creator 既有文件的冻结纪律——缺陷修复按各包自身规则执行，口播不擅自修改。

## 十一、变更履历

| 版本 | 日期 | 变更 |
| :--- | :--- | :--- |
| v1.0.0 | 2026-10-14 | 首次冻结基线（v1.0.0 功能交付 + speechcut_v1 协议声明 + 本冻结登记） |

### 追记（2026-10-24，包化 + 分镜直出第二消费方）

1. 模块已从 `modules/video_creator/speechcut/` + `apps/web/server/speechcut.mjs` 上移为独立包 `packages/speech-cut`（@jansee/speech-cut），单门 exports（startSpeechAnalyze / startSpeechProduce）。上表锚点中的 `speechcut/index.js re-export` 对应包内 index.js；检测/合成内部实现随之迁移，语义零变化（detect 7/7、bff 11/11、e2e-stub 18/18 回归通过）。
2. **新增第二消费方：分镜成片「原片直出」**（apps/web/server/storyboard.mjs 编排）。包新增三件能力并经单门导出（纯能力层，编排逻辑不进包）：
   - `planSegmentCut({words, deletedStarts, pauseCuts, durationSec})` —— planCutRanges 稳定门面；
   - `shiftWordsToKeptTimeline(words, keepRanges)` —— 词表时间轴重映射（删除区词塌缩过滤）；
   - `cutSegmentByRanges({videoFile, keepRanges, taskDir, outFile})` —— 单段音画同步剪除（不烧字幕/不混 BGM/不加角标，交由下游分镜拼接层统一处理，避免双重叠加）；
   - `detectRedundancy` 经包单门再导出（编排层逐段复用）。
3. 新消费链路端点：`POST /api/v1/storyboard/direct/analyze` / `POST /api/v1/storyboard/direct/produce`（任务 kind='storyboard_direct'，轮询复用 GET /api/v1/video/task/:taskId；每次出片 200 积分同口径）。测试：apps/web/server/tests/storyboard/test-direct-flow.mjs（6/6，含真实 ffmpeg 剪除+无声段垫静音+叠化拼接集成）。
4. 上述新增导出为**增量面**（原 v1.0.0 冻结端点与语义零改动），不触发 speechcut_v2 升版。

### 追记（2026-10-24 晚，结尾收束标配）

包新增依赖 @jansee/ending-kit：startSpeechProduce 在 composeSpeechcut 完成后调用 `appendEndingTail` 追加 CTA 尾段（全版块收束标配；appendEndingTail 恒不抛错，失败保持原片交付）。startSpeechProduce 新增可选 `scene` 参数（缺省 local，口播场景池口径）。成片时长口径变为「剪除后原片 + 2.95s 尾段」，e2e 断言已同步。fitEndingCard 实现上移 ending-kit（dubKernel 同步再导出），whisper/剪除/字幕/BGM 能力面不变。
