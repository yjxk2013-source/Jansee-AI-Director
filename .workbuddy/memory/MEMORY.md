# JANSEE V4 项目长期记忆

## 产品结构（重要，别再搞混）
- JANSEE V4 = 简兮 AI 导演系统。用户给素材 + 一句意图，系统出成片，不是剪辑软件/模板市场。
- **两大功能**：
  1. **出片流**：三个创作场景 = 带货视频(`online-ecommerce`) / 门店获客(`physical-store`) / 个人创作(`personal-creation`)。代码里是 `creationScene`，前端 App.tsx 底部场景选择器，后端 director.ts 有场景路由。
  2. **一句话剪辑**：`quick-cut`，免费。自然语言指令 → 本地确定性数控（切片 video-slice / 保留原片 keep-original / 停顿精剪 speech-cut 两阶段），跳过 LLM 多角色思考动画。
- **底层三个生产引擎**（另一维度，不是产品功能）：`image-film` / `video-dub` / `storyboard`（contracts 的 CAPABILITIES，engine-registry.ts）。
- PC 与 APP 能力完全对等，只有布局适配；这是产品契约硬约束。

## 纯净封面链路（2026-11-20 打通并已部署）
- 引擎(image-film/video-dub/speech-cut)每次出片都生成 `taskDir/cover.jpg`（@jansee/intro-kit 的 composePureCover，无烧录台词、无 AI 角标）——这是产品专门制作的封面，别再用前端截帧当封面。
- 曾长期断链：renderer 只传成片、finally 删 taskDir 丢封面→前端只能 captureFrameAsCover 从成片截帧（带台词/AI标）。2026-11-20 打通：renderer stageCover 上传到 `users/{uid}/covers/{jobId}`，经 engine-adapters/worker 透传到 output-store 的 `cover_storage_key`（迁移 0024），works API 返回 coverUrl=`/api/v1/works/:id/cover`（鉴权图流）。前端优先真封面，自动截帧仅旧作品兜底。旧作品无封面，仍截帧。

## 部署要点（2026-11-20 全量部署后确认）
- 服务器：ubuntu@203.195.243.42，源码 /srv/jansee-v4 非 git，密钥 ~/.ssh/jansee_server。前端**可直接整文件覆盖**：服务器 App.tsx 已含语音代码（06:09 部署），与本地一致；旧的"必须精准注入"限制已失效。
- 数据库迁移：server.ts 启动自动跑 runMigrations（读 migrations/ 按版本跳过已应用），重建 api 镜像并 up -d 即自动应用，无需手动 psql。
- 部署命令：`sudo docker compose --env-file .env -f deploy/docker-compose.v4.yml build api web` → `up -d --no-deps api web`（避免连带重启 postgres）。磁盘纪律：构建后 `docker builder prune -af`。
- 验证线上 bundle：必须宿主机 `curl` 抓到文件再 grep；在 `docker exec sh -c` 里传中文关键字会编码失真全返回 0。

## 计费策略（2026-11-20 用户确认，别再反复提防逃费）
- 免费引流：个人创作(`personal-creation`) + 一句话剪辑(`quick-cut`)，全程不冻结/不核销/不退还积分，强制单版。
- 收费支撑：带货视频(`online-ecommerce`) + 门店获客(`physical-store`)，每条成片 200 积分。
- 免费判断统一走 `billing.ts` 的 `isFreeCreationEntry(scene)`；worker 领取 SQL 放行无 hold 记录的免费任务。
- **游客/登录边界（2026-11-20 事故后定案）**：任何人免登录可出片，下载时才要求登录。免费两场景游客随便用；收费两场景服务端 `jobs.ts` 用 `GUEST_PAID_SCENE_BLOCKED`(401) 强制拦截，游客钱包初始 0 积分（正式注册送 600），前端场景按钮游客下置灰+点击引导注册。不要小锁图标（用户否决）。
- 用户明确不做"服务端入口凭证签发"那类重防逃费改造；但游客收费拦截是业务漏斗必需，已做。不要再建议按会话签发凭证。
- 素材归属检查已按用户要求**从 jobs.ts 删除**（用户："用户素材有什么检查的"）；worker 按 job.userId 取素材渲染是正常业务，保留。

## 仓库与架构
- 独立 V4 monorepo（npm workspaces，Node 22+）。apps/web（React+TS，PWA，App.tsx 约 4100 行 + AdminConsole.tsx）、apps/api（Fastify，40+ 模块）、packages/*（契约/domain + 音视频 kit，多从 V2 审计迁入）、modules/*（visual_engine_v4、video_creator）。
- 异步管线：上传 → director/plan → jobs（方案确认环节已下线，直接建任务）→ worker → FFmpeg + Auto-QC → 交付。Job 状态机、幂等、超时/取消/退款。
- 工程红线（AGENTS.md）：只在非 main 分支改；不动 F:\janseeV2；V3 只读；UI/CSS 改动前必读 docs/design/JANSEE_DESIGN_SYSTEM.md；不提交密钥/用户数据/产出物。

## 生产状态（2026-11-19 用户确认已完成）
- 生产库：原生 PostgreSQL 16 + Docker 卷（deploy/docker-compose.v4.yml）。
- 真实短信：阿里云 dypnsapi，生产 JX_AUTH_TEST=0，mock 启动被拒。
- 真实支付：一人付 OPCPAY + webhook 验签，生产 PAY_SIMULATE=0。
- 生产密钥注入、单服务器 Docker/Nginx 部署（jansee.cn / admin.jansee.cn）均已验证。
- 模板与运维文档在 deploy/（.env.production.example、V4-SINGLE-SERVER.md、V4-CLEAN-SERVER-RELEASE-CHECKLIST.md、nginx-v4.conf、Dockerfile.v4、backup-v4-db.sh）。
- 待核对：V4-CLEAN-SERVER-RELEASE-CHECKLIST.md 开头仍写"不表示任何清理或部署已执行"且未勾选，与已完成的口径不一致，等用户确认是否更新该清单。

## LLM 导演模型策略（2026-11-20 用户口径）
- 首选 `zai-org/GLM-5.3-Flash`，备选 `deepseek-ai/DeepSeek-V4.1-Flash`，走 SiliconFlow OpenAI 兼容接口。
- **降级唯一条件：25 秒内没有吐出首个数据包**（思考模型的 reasoning_content 也算首包）。一旦开始流式输出，即使完整方案要 40 秒以上也不许降级；完整流另受 `DIRECTOR_STREAM_TIMEOUT_MS`（默认 120s）约束。
- `thinking_budget` 只发给首选模型；备选 DeepSeek 带该参数会返回残缺 JSON。

## 时长来源契约（2026-11-20 用户定案，别再让 LLM 给秒数）
- 成片时长 = LLM 选的语速(speech_speed) + TTS 念完台词的实测时间 + 句间留白(tts.js GAP=0.4s)。台词是唯一时间源；LLM 禁止输出任何时长/秒数字段（提示词与 JSON 模板已删）。
- renderer.ts 的 `resolveShotDurations()` 按 TTS cues 每句结束点切镜头，成片总时长严格等于配音轨真实时长；`buildTtsAudio` 不再传 targetSpanSec（禁止把台词硬拉到假时长）。
- schema 里 durationSeconds 仍是 optional，只为兼容旧模型惯性输出，执行层完全不读。工作台不展示导演估算秒数。

## 服务器磁盘红线（2026-11-20 事故复盘）
- 服务器 40G 盘，正常水位约 13G 已用（V2 裸跑时代 9.2G，Docker 化后净开销 ~4.4G：引擎+镜像+快照）。Docker 构建缓存别堆积：重构建后跑 `docker builder prune -af`；缓存实际存于 `/var/lib/containerd`。
- `deploy/Dockerfile.v4` 不得 COPY materials/whisper.cpp/node_modules——compose 全部 bind-mount；ffmpeg 用 `mwader/static-ffmpeg:7.1` 单文件（~80M），不用 apt（~500M）。api 镜像最终 532MB。
- `.dockerignore` 陷阱：不能忽略 node_modules（build 阶段 COPY 它跑 tsc）、不能忽略 `**/dist`（会删依赖包类型声明致 tsc 失败）。
