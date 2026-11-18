# JANSEE V4 — AI Director 与 V2 能力迁移实施基线

> 状态：架构决策已确认；本文件记录 2026-11-16 本机审计结果。  
> V2：`F:\\janseeV2`（只读）  
> V4：`F:\\Jansee-v4`

## 1. 产品原则（不可偏离）

简兮是 AI 智能导演系统，不是要求用户逐项选择工具的剪辑软件。

**用户只描述创作目的并提供素材；导演负责决定制作流程、调用能力模块、完成包装、质检和交付。**

默认完整成片策略：
- 开场：默认设计并生成；用户明确要求原片直出/不要开场时取消。
- 主体：按用户提供的素材顺序、明确描述和可验证的元数据组织；没有视觉识别能力，不得虚构镜头内容或重排语义镜头。
- 字幕：有可靠文本来源时默认制作（用户文字、可选 ASR、导演实际生成的旁白）；不得把 LLM 编造的画面描述当作字幕。
- BGM：默认评估并添加；与原声/TTS 人声做音量避让；用户要求保留原声时必须混音而不是静音丢轨。
- 结尾：默认设计并生成；品牌名、Logo、CTA 等只使用用户提供或系统已验证的资料。
- 质检：检查文件、视频/音频流、画幅、时长、字幕时间窗、音画同步、编码和元数据后才能交付。

用户明确要求优先于默认策略。没有可靠内容依据时，采用诚实的降级方案或只问一个关键问题。

## 2. AI 导演的能力边界

当前导演只调用对话 LLM，不接图片/视频视觉识别模型。可用事实包括：
- 文件类型、大小、时长、分辨率、音视频流、上传顺序；
- 用户在对话中提供的文字、品牌资料和创作要求；
- 如明确启用本地 Whisper，可获得音频语音转写与词级时间戳。

禁止声称能识别图片/视频里的商品、人物、场景、颜色、动作、精彩镜头或画面质量。文件名和 LLM 根据文件名生成的描述不是视觉事实。Whisper 是音频 ASR，不是视觉识别。

## 3. FFmpeg 与专业能力模块的职责边界

- **AI Director**：理解意图、选择制作目标、制定结构化计划、确定默认包装和例外。
- **专业能力模块**：封装业务规则、素材/时间轴组织、参数计算、模块顺序、容错、阶段进度和专属质检。
- **FFmpeg/ffprobe**：执行确定性媒体操作，如裁剪、拼接、缩放、混音、转场、字幕烧录、转码和媒体探测。

不为每条 FFmpeg 命令创建一个独立服务；但必须保留专业任务模块。切片就是一个专业能力模块（或模块内的能力），内部调用 FFmpeg。只有用户指定时间范围或固定时长时可直接构造切片任务；按语音停顿切片需要 ASR；按“精彩镜头/商品特写/画面语义”切片当前不支持。

## 4. V2/V4 本机审计结果

本轮只读审计发现：V4 已包含大量从 V2 迁入的代码，不能再次整目录覆盖。

### 已存在于 V4 的 V2 模块/包
- `modules/video_creator`：ASR 辅助、原片保留、切片、口播/音频辅助、多视频分镜。目录内对应 V2 文件 SHA-256 一致。
- `modules/visual_engine_v4`：图片成片视觉引擎；其中 `imageFilm.js` 与 V2 有差异，需审查适配差异，不可盲目覆盖。
- `packages/image-film`、`video-dub`、`speech-cut`、`audio-kit`、`tts-kit`、`subtitle-kit`、`intro-kit`、`ending-kit`、`ffmpeg-kit`、`anchor-kit`、`publish-kit`、`shared`。
- 对比 V2 与 V4 packages（排除 node_modules）时，完全一致的包：ending-kit、ffmpeg-kit、image-film、intro-kit、publish-kit、shared、speech-cut、video-dub。
- 有源码差异需逐项审查的文件：anchor-kit/pick.js、audio-kit/bgm.js、visual_engine_v4/imageFilm.js；另有 anchor-kit、audio-kit、subtitle-kit、tts-kit 的 package.json 有差异。不得直接用 V2 覆盖 V4。

### 当前关键缺口
- 图片成片与视频配音已有 V2 专用执行链；多视频分镜已接入 Worker Engine Registry。仍需将各内部能力统一为可组合的任务图，而非按三种顶层模式封闭。
- `modules/video_creator` 已登记为 V4 workspace package；固定时长切片已由 Worker 直接调度，字幕开启时调用 Whisper；原片保留通过 storyboard Engine 适配器执行；speech-cut 两阶段确认流程尚未接入。
- 通用 FFmpeg fallback 已停止把 scenes.description 或用户 prompt 伪装成字幕；无可信字幕来源时不烧录虚构字幕。
- Storyboard 原声和 BGM 混音链已复用 V2；Whisper 缺失时保留原声并记录质量警告，但字幕会缺失，部署 Whisper 是生产验收前置条件。
- 图片成片的首镜承担开场表达，尚未实现可独立关闭/替换的 cinematic intro 片段。
- 批量矩阵、语音停顿剪辑和指定区间切片仍需逐项接线与验收。Auto-QC 已接入生产 Worker：每个输出在写入作品库前逐一检查；拒绝时阻断交付并清理私有输出对象，后续沿用任务失败与额度退款流程。完整解码、黑帧/静音检测、字幕时间窗和隐式 AI 元数据的端到端验收仍需加强。

## 5. 目标 Engine Registry（内部能力，不暴露成工具箱）

当前按“成熟制作链先复用、逐步收敛到统一 Registry”实施：
- `image-film` → 当前由 `apps/api/src/renderer.ts` 调用 V2 `@jansee/image-film`，使用真实 TTS、图片版式、字幕、BGM、CTA 片尾。
- `video-dub` → 当前由 `apps/api/src/renderer.ts` 调用 V2 `@jansee/video-dub`，并支持默认包装和显式关闭开场/结尾/字幕/BGM。
- `storyboard` → 已由 `apps/api/src/engine-adapters.ts` 注册到 Engine Registry，Worker 按模式路由到 V2 `modules/video_creator/video/storyboard.js`。
- `video_slice` → `modules/video_creator/video/slicer.js`（当前 Worker 支持固定时长切片；字幕开启时执行 Whisper ASR；指定时间区间与语音语义切片仍需扩展）。
- `keep_original` → `modules/video_creator/video/keepOriginal.js`。
- `speech_cut` → `@jansee/speech-cut`（需单独接入和端到端验证）。
- `audio_mix / subtitle / intro / ending` → 继续复用 `audio-kit`、`subtitle-kit`、`intro-kit`、`ending-kit`；由对应制作链编排，不暴露为用户工具按钮。
- `publish_copy` → `@jansee/publish-kit`（只在用户需要发布文案时调用）。

一个用户请求可组合多个内部能力。DirectorPlan 只表达业务意图和经过验证的文本/时间数据，不直接包含可执行 shell 命令或任意 FFmpeg 参数。所有素材路径由服务端资产记录解析，不能信任客户端传入路径。

## 6. 实施顺序与验收

已完成的基础接线：
1. V2/V4 模块差异和 SHA-256 对账；确认现有包不重复复制。
2. DirectorPlan 增加默认包装策略：intro、ending、subtitles、bgm 默认 true。
3. 规则型降级导演不再朗读用户的制作指令，也不使用文件名/场景臆测作为旁白或字幕。
4. Worker 已支持通过 Engine Registry 路由 storyboard；图片成片和视频配音保留现有 V2 专用执行链。
5. Storyboard 支持 9:16、16:9、1:1、4:3 画幅，保留原视频音轨；本地 Whisper 不可用时不会伪造字幕，降级警告写入任务 telemetry。
6. 视频配音引擎已支持显式关闭开场、结尾、字幕、BGM；图片成片支持关闭 CTA 结尾和字幕。
7. 生产 Worker 已接入 ffmpeg-kit Auto-QC：对每个交付文件逐一检查，记录等级、媒体指标和警告；QC 拒绝时不创建作品记录、删除本次私有输出并进入失败退款流程。

仍需完成：
1. 口播停顿优化（speech-cut 两阶段分析/确认/制作）、指定区间切片接入统一调度；当前固定时长切片已由 Worker 路由，原片保留已通过 storyboard 适配器调用。
2. Storyboard 的真实素材端到端测试，验证 Whisper 部署、字幕时间戳、原声与 BGM 混音。
3. 图片成片的开场独立片头策略（目前首镜包装承担开场表达）。
4. 扩展 Auto-QC 的真实媒体验收：当前已在生产 Worker 接线并执行文件/流/时长/分辨率/音轨等现有检查；仍需补充完整解码、黑帧/静音、字幕时间窗、音画同步实测和 AI 隐式元数据的可靠验证。
5. 完成真实素材验收前不宣称全部 V2 能力已接通，不部署生产环境。

## 7. 工程安全

- V2 只读；不从 V2 运行时直接导入代码，V4 必须独立。
- 不覆盖现有 V4 未提交修改，不 reset、不 clean、不删除用户数据。
- 继续在非 main 分支开发；不触碰线上数据；完成测试和人工验收前不部署。

 
## 2026-11-16 最新实现状态更正

以下内容覆盖本文早期“speech-cut 尚未接入”和“Auto-QC 仍缺完整解码”等历史描述：

- speech-cut 已接入持久化两阶段流程：服务端 ASR/建议、服务端 suggestion ID、用户确认 ID、Worker 执行。公开 jobs API 拒绝客户端伪造的 speech-cut DirectorPlan。
- Auto-QC 已执行完整 FFmpeg 解码，并在同一解码过程中检测黑帧、静音；同时校验字幕时间窗、音轨和 AIGC 标记。真实多素材验收仍待生产环境。
- Worker 租约迁移、心跳和过期恢复已经存在；失败重试上限为三次，耗尽后退款。作品存储记录支持按 storage_key 幂等 upsert。
- COS 目前是独立的私有对象签名 URL/HEAD/删除能力，不等于已经接入 Worker 的持久化对象存储后端。当前 API/Worker 仍主要使用本地私有存储。
- 真实支付网关、回调验签、退款和对账仍未实现。开发环境模拟支付不能作为生产支付能力。

 
## P3 COS 后端接线补充（2026-11-16）

最新实现已新增 Tencent COS 作为 LocalObjectStorage 兼容后端。设置 MEDIA_STORAGE_DRIVER=cos，并配置 COS_SECRET_ID/COS_SECRET_KEY/COS_BUCKET/COS_REGION 与 MEDIA_CACHE_ROOT 后，API 上传和 Worker 输入/输出存储均使用私有 COS 对象；Worker 通过本地缓存路径向 FFmpeg 提供文件。生产真实 Bucket、凭据、网络、权限策略、生命周期策略和 Linux/Docker 仍未实测。默认 MEDIA_STORAGE_DRIVER=local，不会在没有明确配置时切换远端存储。


### Audio/video timestamp drift gate

Auto-QC now attaches FFmpeg `showinfo` and `ashowinfo` filters to the same full decode pass. It compares the first video/audio presentation timestamps and the final video-frame/audio-sample end times. A drift above the configured 350 ms threshold blocks publication and records the measured start/end drift in QC metrics. The regression suite includes a real FFmpeg-generated MP4 with an 800 ms audio start offset and verifies that it is rejected. This is a stream-timestamp integrity check, not a perceptual lip-sync model; real talking-head samples and human review remain required.


### Director intent routing guardrails

The deterministic operation selector is intentionally conservative:
- Explicit slice operations (`切片`、`拆条`、`分段`、`拆分`、`分割`、`切段`) route to multi-output slicing unless the user explicitly negates that request.
- Natural-language forms such as “分成三条短视频，每条15秒” and “每段15秒” are recognized through split verbs, multi-output cues and duration cues.
- Generic instructions such as “每条视频都加字幕” do not trigger slicing.
- Explicit opt-outs such as “不要把视频切成多段” preserve a single standard output.
- The LLM planning prompt must emit the bounded `operation` and `sliceSeconds` fields; server-side deterministic intent checks remain authoritative for clear slicing and keep-original requests.
