# 简兮 (JANSEE) · 视频配音模块职责与依赖边界 (Module Boundary)

> **文档版本**：v1.0.0（与 video-dub-api v1.0.0 契约同批冻结，2026-10-13）
> **阶段定位**：阶段 D（模块封装、API 契约与冻结）交付物
> **配套文档**：[VIDEO_DUB_API_CONTRACT.md](../../api/VIDEO_DUB_API_CONTRACT.md) · [FREEZE_AND_VERSIONING.md](./FREEZE_AND_VERSIONING.md)

---

> ## ⚠️ 架构升级公告（2026-10-24，晚于上述冻结版）
>
> 视频配音模块已完成**独立包化 + AI 导演链路补齐**，本文正文（v1.0.0 冻结态）描述的是升级前现状，
> 以下为当前事实，与正文冲突时**以本节为准**：
>
> 1. **物理形态**：模块已上移为独立包 `packages/video-dub`（`@jansee/video-dub`），对外唯一 API
>    `produceVideoDub({ taskId, taskDir, videoFile, cut, voiceId, onStage })`——与图片成片
>    （`@jansee/image-film` 的 `produceImageFilm`）同一范式。原合成内核 `modules/video_creator/video/dub.js`
>    已删除（生产可达面收敛为「视频输入 + 预生成音轨」，图片序列/用户录音/保留原声三模式零调用方，随搬迁裁撤）；
>    `buildAtempoFilter` 下沉 `@jansee/ffmpeg-kit/atempo.mjs`（分镜链 storyboard.js 在消费）。
> 2. **入口端点**：旧 `POST /api/v1/video/produce` 已下线（410），统一走 `POST /api/v1/creation/create`
>    （`type=video_dub` + `materialIds` 素材表），轮询 `GET /api/v1/creation/task/:taskId`。
>    旧端点相关的「伪造 videoPath 归属校验」随素材表契约前移到上传端点，不再存在于 produce 链路。
> 3. **AI 导演已接通**：LLM 大导演（director.mjs 视频分支，`videoMeta` 传服务端实测时长）优先，
>    失败落 `generateConstitutionScript` 兜底。视频配音只保留 AI 配音一条路
>    （`scriptMode=provided` 用户自备文案模式已于 2026-10-24 清除，用户输入的 text
>    仅作为素材喂给导演，不再直接采信为旁白）。
>    TTS 逐段实测时长（不再按字数估算），段间停顿取剧本 `pause_after`（缺省 0.5s）。
> 4. **BGM 与图片成片同一套**：audio-kit `selectBgmByEmotion` 选曲 + 两段式人声闪避（duck 窗口=逐段人声区间），
>    循环铺满整段视频时长；不再用旧内核固定 0.22 音量垫底。
> 5. **依赖边界反而更严**：新包不 import 任何 `modules/`（旧 dub.js 曾反向依赖 video_creator 内部 asr/slicer），
>    时长探测走 `@jansee/ffmpeg-kit` 的 `probeDurationSec`；`modules/video_creator` 的 `video/dub.js` 删除后，
>    `video/index.js` 不再转发它，跨模块深层 import 归零。
> 6. **回归**：stage-b 45/45（E2E 走 creation/create）、stage-d 36/36（契约套件同步重写）、
>    引擎 38/38、stage-a 28/28、真 TTS 出片冒烟通过（12s 源视频 → 12s 成片，原音轨排除）。

---

## 一、模块定位

视频配音模块是 BFF 网关层（apps/web/server）内的**业务能力域**，负责「用户上传实拍视频 → AI 导演规划全片旁白 → TTS 配音 + BGM + 字幕 → 合成成片」的完整业务流程编排。

* 物理形态：当前封装于 `apps/web/server` 业务分支内（非独立 npm 包），对外 API 即契约 v1.0.0 的四端点；
* 与图片成片的关系：**共用 produce 端点与任务查询端点，分支互斥**（`videoPath` 非空即视频配音分支），两分支各自独立、互不侵入；
* 架构层级：位于四层架构的第一层（AI 导演层），向下只经冻结模块的公开 API 消费共享能力。

## 二、模块内部组成（文件级）

| 文件 | 职责 |
| :--- | :--- |
| `apps/web/server/index.mjs` | 路由层：视频上传端点、produce 视频分支（流程编排/任务接线/产物校验/状态更新）、任务查询合并、产物静态分发 |
| `apps/web/server/director.mjs` | 导演层：`buildDirectorPrompt` 的 `videoMeta` 视频创作规则注入、`sanitizeDirectorCut` 视频分支（多段旁白保留/asset 恒 1）、`generateConstitutionScript` 视频兜底（mocker，跟随用户指定配音性别） |
| `apps/web/server/prompt/*.md` | 导演提示词唯一真相源（运行时读取，随代码版本化） |
| `apps/web/client/index.html` | 官方调用方（前端工作台）：`uploadDubMaterial` 上传接线 + produce payload 组装。**仅是契约消费者，不属于模块本体** |

## 三、模块负责（职责边界）

1. **视频配音业务流程编排**：上传→探测→导演→选曲→合成→产物校验→交付的端到端调度；
2. **视频场景导演输入与结果校验**：服务端权威时长探测并注入导演层（`videoMeta`）；sanitize 视频分支（多段旁白全保留、asset 恒 1、空段丢弃、配音性别硬约束清洗）；LLM 失败回落 mocker 兜底；
3. **任务创建与状态管理接线**：复用 `inMemoryTasks` 任务体系，progress/stage/stageText 全程回报，产物校验通过才置 `completed`；
4. **对外 API 与业务错误映射**：统一信封、错误码（40004~50005/40400）、失败任务语义（`status: failed` + `error`）。

## 四、模块复用（依赖边界）

| 共享能力 | 消费方式 | 消费的公开接口 |
| :--- | :--- | :--- |
| 视频基础处理（@jansee/video-creator，冻结） | 只读消费 | `videoDurationSec`（上传端点时长探测）。合成内核已于 2026-10-24 搬迁至 `@jansee/video-dub`（见顶部升级公告），不再经 `composeDub` 消费 |
| TTS 语音服务 | 经 `@jansee/video-dub` 内部 | 模块仅做语义音色映射（`male→zh-CN-YunyangNeural` / `female→zh-CN-XiaoxiaoNeural`），腾讯云通道、密钥、并发门控全部下沉；逐段实测时长由 `synthesizeLines` 完成 |
| BGM 音乐服务（@jansee/audio-kit） | 经 `@jansee/video-dub` 内部 | `selectBgmByEmotion`（情绪选曲；`bgm_on=false` 或选曲失败则不混入）+ 两段式人声闪避（与图片成片同一套） |
| 字幕服务 | 经 `@jansee/video-dub` 内部 | 无直接依赖 |
| FFmpeg 渲染（@jansee/ffmpeg-kit） | 经 `@jansee/video-dub` 内部 | 无直接依赖（引擎自持 ffmpeg 二进制；时长探测走 `probeDurationSec`） |
| 现有导演引擎（apps/web/server/director.mjs） | 同包内调用 | `generateDirectorCut`、`generateConstitutionScript` |
| 现有任务体系 | 同进程内复用 | `inMemoryTasks` + `icGetTask` 合并查询 |
| 文件管理与安全机制 | 复用图片链路同规则 | `storage/uploads` 路径白名单校验（目录穿越/任意路径/不存在文件一律拒绝） |
| 创作防重账本（creativeLedger.mjs） | 只写消费 | `recordCreative`（与图片链路同源，供后续任务导演差异化） |

## 五、暴露红线（不得违反）

1. **不得把共享能力的内部接口暴露为视频配音模块的公共 API**：`composeDubTrack`（合成内核）/`produceVideoDub` 的参数细节、TTS 密钥与音色 ID 映射、BGM 曲库寻址、ffmpeg 命令细节、字幕渲染参数，一律不出现在契约端点的请求/响应中；
2. **`script` 字段（导演剧本）为可观测输出、非可依赖契约**：其内部结构随 LLM 导演能力演进，调用方不得对 shots 内部字段做结构化强依赖；
3. **voice_id 与 script.sfx 为冻结预留字段**：不加入 LLM 输出契约，不修改 image_creator_v1 / video_creator 黑盒内相关读取位。

## 六、提升红线（图片成片专属逻辑不得上提）

以下逻辑为图片成片分支专属，**禁止提升为共享能力或注入视频分支**：

1. `assetOrder` 素材去重与「N 图 = N 镜每图必现」规则（视频分支 asset 恒 1，多段旁白全保留）；
2. 图片场景 8s 单镜时长上限与 pause_after 图片口径（视频分支 duration=0 交合成层按 TTS 实测校正）；
3. 图片开场特效/转场/运镜消费逻辑（视频分支画面特效不消费，画面恒为源视频）；
4. 图片封面抽帧与视觉排版消费（视频链路仅装配 `assembleVisualDesign` 保证账本字段一致，不出封面产物）。

## 七、冻结边界关系

* `modules/image_creator`（image_creator_v1）：冻结黑盒，视频配音模块**零依赖**（仅经 produce 端点共存于同一网关）；
* `modules/video_creator`（@jansee/video-creator）：冻结，视频配音模块仅经 `video/slicer.js` 与 `video/dub.js` 的公开导出消费，禁止直改内部实现；
* `packages/*` 共享能力包：禁止为本模块需求修改；缺陷修复按各包自身版本规则执行。
