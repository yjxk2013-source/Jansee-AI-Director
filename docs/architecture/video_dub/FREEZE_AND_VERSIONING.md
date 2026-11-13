# 简兮 (JANSEE) · 视频配音模块冻结与版本管理 (Freeze & Versioning)

> **冻结日期**：2026-10-13
> **阶段定位**：阶段 D（模块封装、API 契约与冻结）交付物
> **配套文档**：[VIDEO_DUB_API_CONTRACT.md](../../api/VIDEO_DUB_API_CONTRACT.md) · [MODULE_BOUNDARY.md](./MODULE_BOUNDARY.md)
> **核心原则**：冻结公共接口与业务行为 ≠ 禁止未来修复缺陷。缺陷修复在允许范围内自由进行；任何触碰稳定面的变更必须走版本升级与回归流程。

---

## 一、版本标识

| 项 | 值 |
| :--- | :--- |
| 模块正式名称 | 简兮视频配音模块（jansee-video-dub） |
| 模块版本 | **v1.0.0**（冻结基线） |
| API 契约版本 | **video-dub-api v1.0.0** |
| 冻结基线内容 | 阶段 A（上传+时长探测+prompt 注入）+ 阶段 B（sanitize 视频分支+任务接线+合成接线+mocker 兜底+前端上传）+ 阶段 C（真实出片验证）+ 阶段 D（契约/边界/测试/冻结）全部交付物 |
| 基线代码位置 | apps/web/server（index.mjs / director.mjs / prompt/），变更清单 +281/-10 待负责人批准提交 |

## 二、稳定接口清单（冻结面，变更须升版本）

| # | 稳定项 | 契约锚点 |
| :--- | :--- | :--- |
| 1 | `POST /api/v1/upload/video`（binary 直传 + x-file-name + 200MB + .mp4/.mov + 落盘即探测） | 契约 §2 |
| 2 | `POST /api/v1/video/produce`（含别名 /produce/product；videoPath 非空走视频分支；立即返回 taskId） | 契约 §3 |
| 3 | `GET /api/v1/video/task/:taskId`（状态机 processing→completed/failed；404 40400 语义） | 契约 §4 |
| 4 | `GET /storage/outputs/{taskId}/final.mp4`（Range 206 支持；无鉴权现状） | 契约 §5 |
| 5 | 统一响应信封 `{code,msg,data,timestamp}` 与错误码表（40001/40004~40007/40400/50003~50005） | 契约 §1/§5 |
| 6 | completed 响应字段集（videoUrl/subtitleUrl/audioUrl/variantType/isRealRendered/script/duration/deliveredAt） | 契约 §4.4 |
| 7 | 配音性别语义（voice 仅 male/female 受控；用户指定为硬约束；未指定交 LLM 判定；mocker 跟随用户指定） | 契约 §3.2 |
| 8 | 业务行为红线（原音轨绝不进入成片；画面时长恒等于源视频真实时长；产物校验不过绝不置 completed） | 契约 §3.6 |

## 三、内部实现清单（可自由重构面，不升版本）

* index.mjs 视频分支的内部代码组织、进度百分比刻度、stage/stageText 中文文案；
* director.mjs sanitize 视频分支与 mocker 兜底的内部实现（输出结构等价前提下）；
* TTS 音色映射细节、BGM 选曲细节、composeDub 调用参数细节；
* 错误 msg 的中文措辞（`code` 才是调用方稳定依赖面）。

## 四、共享依赖清单（冻结，仅只读消费）

| 依赖 | 版本/状态 | 消费的公开接口 |
| :--- | :--- | :--- |
| @jansee/video-creator | image_creator_v1 同批冻结模块 | videoDurationSec（composeDub 已于 2026-10-24 随 dub.js 删除而废止，合成内核在 @jansee/video-dub） |
| @jansee/video-dub | 2026-10-24 新建（produceVideoDub 单门） | 视频配音合成内核（编排方：creation.mjs 分支二） |
| @jansee/audio-kit | 共享能力包 | selectBgmByEmotion |
| @jansee/image-creator | image_creator_v1 冻结黑盒 | assembleVisualDesign（仅账本字段一致性装配） |
| 腾讯云 TTS | 单通道，单任务并发 6 | 经 @jansee/video-dub → @jansee/tts-kit 下沉（synthesizeLines 逐段实测） |
| 导演提示词真相源 | apps/web/server/prompt/*.md | 运行时读取 |

## 五、当前不支持的行为（v1.0.0 明示不支持）

1. 鉴权与多用户归属（差距 G1）；
2. 任务态持久化（服务重启任务记录丢失，差距 G5）；
3. 产物不存在的 404 语义（现状落 SPA fallback，差距 G2）；
4. 重复请求幂等/去重（差距 G7）；
5. uploads 上传产物生命周期清理（差距 G8）；
6. `HEAD` 方法（差距 G6）；
7. .mp4/.mov 以外的视频格式（.webm/.avi 等一律拒绝）；
8. 配音语速参数（speed 恒 1.0，节奏由导演台词长短表达）；
9. 第三音色（voice_id 为冻结预留字段，不加入输出契约）；
10. 独立字幕/音轨产物交付（字幕已烧录进画面，subtitleUrl/audioUrl 恒空串）；
11. 视频分支消费画面特效/封面产物（画面恒为源视频，开场/转场/运镜 key 仅按契约填合法值，程序不消费）。

## 六、已知技术限制（物理/架构约束）

1. 硬件地基 4核4G：2 并发出片为上限，单任务 ffmpeg 渲染串行推进；
2. 200MB 上传上限为该硬件下的保守值（流式落盘不占网关内存，但渲染阶段内存受约束）；
3. 成片画幅/帧率恒跟随源视频，不做转码改画幅（混流 `-c:v copy` 域优先，避免重编码损害画质）；
4. LLM 导演输出不可控性：提示词约束 + sanitize 兜底 + mocker 回落三层保障，出片永不中断，但旁白质量依赖 LLM 表现；
5. 任务时长对齐策略固定：配音超长末尾 0.5s 淡出截断、不足以 BGM/静音补满，不截断/加速/循环画面。

## 七、允许的 Bug 修复范围（PATCH 级，不升版本）

以下修复可直接进行，但须通过既有回归（见 §九）：

1. 不改变请求/响应结构、状态枚举、错误码语义、字段名、端点路径的内部缺陷修复；
2. stageText/stage 展示文案与错误 msg 措辞调整；
3. 性能优化（不劣化出片质量与产物正确性）；
4. 安全加固（收紧校验不得使此前合法输入变为失败——此类属行为变更，须升 MINOR）；
5. mocker 兜底剧本的文案内容调整（创作内容非契约稳定面）；
6. 依赖包缺陷经上游修复后的版本对齐（不改公开接口用法）。

## 八、版本升级规则（触碰稳定面时强制执行）

### 8.1 版本号语义（对 模块版本 与 契约版本 同步生效）

| 级别 | 触发条件 | 示例 |
| :--- | :--- | :--- |
| **MAJOR** | 破坏性变更：删除/改名/改类型任何响应字段；删除任务状态；改变错误码语义或复用；变更端点路径/方法/传输方式；收紧同步校验使此前成功的请求变为失败；上传限制收紧（格式/大小）；改变失败任务语义 | 移除 `remainingCredits`；`/upload/video` 改 multipart |
| **MINOR** | 向后兼容新增：新增响应字段；新增任务状态；新增错误码；新增可选请求参数；新增端点 | 增加 `coverUrl` 字段；新增 `.webm` 支持 |
| **PATCH** | §七允许范围内的缺陷修复、文案、性能、内部重构 | 修复超限清理时序；优化进度回报粒度 |

### 8.2 升级强制流程

1. 修改 [VIDEO_DUB_API_CONTRACT.md](../../api/VIDEO_DUB_API_CONTRACT.md) 版本号、冻结日期及受影响条目，同步 [MODULE_BOUNDARY.md](./MODULE_BOUNDARY.md)；
2. 全量契约回归：`scratch/test-stage-d.mjs` + 既有零付费回归（test-stage-b 48 断言 / test-stage-a 28 断言 / test-voice-chain 22 断言 / test-variant-routing 9 断言）全部通过；
3. 行为级验证涉及真实出片时，须经负责人批准付费预算后执行（阶段 C 同口径）；
4. 提交变更清单与版本升级说明，**等待负责人批准后**方可提交（Git 操作纪律：不自行 commit/merge/push）；
5. 禁止静默变更：任何稳定面差异在文档未更新前不得合入 main。

## 九、回归测试资产（冻结基线的守护网）

| 脚本 | 断言数 | 覆盖域 |
| :--- | :--- | :--- |
| scratch/test-stage-d.mjs | 见执行报告 | 契约级：上传/错误路径/任务状态机/产物访问/失败语义/图片成片契约不变 |
| scratch/test-stage-b.mjs | 48 | sanitize 视频分支 + mocker 兜底 + 端到端合成 + 原音排除 + 图片回归 |
| scratch/test-stage-a.mjs | 28 | 上传探测 + prompt 注入 + 三场景基线零回归 |
| scratch/test-voice-chain.mjs | 22 | voice_gender 全链路（用户指定硬约束/LLM 判定/非法回退） |
| scratch/test-variant-routing.mjs | 9 | 变体路由（personal 泄漏防线） |
| scratch/stage-c-real.mjs | 20 | 真实出片验证（付费，按需执行） |

## 十、后续维护规则

1. 本模块进入冻结维护态：仅接受 PATCH 级缺陷修复与经批准的 MINOR/MAJOR 升级；
2. 任何新功能（口播视频、切片分镜、第三音色、鉴权体系等）**不得在冻结分支上直接开发**，须单独立项并评估对本契约的版本影响；
3. 文档与代码同版本冻结：改任一方必须同步另一方，防止文档漂移重演（API_SPECIFICATION.md v3.0 图片域漂移为前车之鉴）；
4. 每次版本变更在本文档 §一 追加变更履历。

### 变更履历

| 版本 | 日期 | 变更 |
| :--- | :--- | :--- |
| v1.0.0 | 2026-10-13 | 首次冻结基线（阶段 A/B/C/D 全量交付） |
