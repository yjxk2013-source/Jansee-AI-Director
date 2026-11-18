# JANSEE V4 工程交接文档 (Handover for GPT)

> **目标受众**：接手 JANSEE V4 项目后续研发的 AI 助手（GPT-4 / GPT-4o / Claude 等）。  
> **交接日期**：2026-11-16  
> **当前稳定分支**：`feat/v4-admin-director-console`  
> **项目定位**：JANSEE 是面向 OPC（One-Person Company 一人公司）的 **AI 商业短视频智能导演系统**，核心价值在于智能分镜编排、爆款变体导演策略与自动化音画合成，而非简单的模版市场或时间轴剪辑工具。

---

## 一、 工程全局架构与技术栈

### 1. 代码库边界与宪法铁律 (Critical Boundaries)
1. **绝对禁止污染 V2 历史库**：`F:\janseeV2` 是只读参考源，严禁修改、格式化、提交或直接软链接 `node_modules`。V4 必须保持完全物理独立。
2. **分支开发纪律**：严禁在 `main` 分支裸写代码，任何新任务必须基于最新分支新建独立特性分支（如 `feat/v4-xxx`）。
3. **UI 设计系统铁律 (Gemini-inspired)**：
   - **绝对 0 Emoji 铁律**：前后台所有 UI、提示与状态文本严禁包含 Emoji 表情，统一使用 1.5px 极细线框 SVG 矢量图符。
   - **视觉质感**：2px 幽灵微光边框、通透留白、毛玻璃背景（`backdrop-filter: blur(18px)`）、标志性紫罗兰品牌色 `#6d65d9`。
4. **两段式音画原则**：
   - 相邻分镜必须叠化转场（Cross-dissolve 0.7s），严禁生硬硬切。
   - 两段式人声避让：有人声区间 BGM 压低至 0.10，无人声区间恢复至 0.22 垫底。

### 2. 模块拓扑 (Monorepo 结构)
```text
f:\Jansee-v4
├── apps/
│   ├── web/               # React 19 + TypeScript + Vite 前端客户端 (已集成导演对话、成片库、充值、OPC后台)
│   └── api/               # Fastify + TypeScript 后端 API 网关与作业调度
├── packages/
│   ├── contracts/         # 跨端公共契约、枚举与 Zod 数据校验
│   ├── domain/            # 核心业务领域纯逻辑、状态机与转换断言
│   ├── anchor-kit/        # 虚拟主播音色库、气质评分与匹配引擎
│   ├── audio-kit/         # BGM 情绪曲库与 Sidechain 避让混音
│   ├── tts-kit/           # 语音合成接入封装
│   ├── subtitle-kit/      # 发丝级字幕排版与 ASS/SRT 压制
│   └── ffmpeg-kit/        # FFmpeg 转码渲染执行器
├── modules/
│   └── visual_engine_v4/  # 图文成片与视频合成底座
└── tests/                 # Node.js 原生测试集 (涵盖鉴权、资产、任务、计费与管理后台)
```

---

## 二、 截至当前最新工程进度 (Current Milestones)

### 1. 最新落地成果：轻量级 OPC 指挥中心 (Admin Console)
已在分支 `feat/v4-admin-director-console`（Commit `f1bfa92`）完整落地，包含：
- **前端页面**：`apps/web/src/AdminConsole.tsx` 与 `styles.css`，支持顶栏【指挥台】按钮、左侧抽屉导航及 URL 参数 `?admin=1` 自动呼出。
- **重点新功能：AI 导演履约与质量追踪看板**：
  1. **耗时三度看板 (Latency Triad)**：
     - 用户端到端交付总时长 ($T_{\text{E2E}}$)
     - LLM 分镜剧本生成时长 ($T_{\text{LLM}}$)
     - 人声配音 TTS 耗时 ($T_{\text{TTS}}$)
     - FFmpeg 视频渲染转码时长 ($T_{\text{FFMPEG}}$)
  2. **决策三元指标质检 (Decision Triad)**：
     - **变体导演命中**：变体类型（如 `A-痛点直击型`、`B-沉浸体验型` 等）及规则模板匹配状态。
     - **主播与配音命中**：推荐主播与声线契合度检测（如 `李佳琦风格带货音 [m-warm]`）。
     - **场景选择与契合度打分**：场景分类（`种草型` / `体验型` / `测评型` / `功能展示型`）与 0~100 分契合度打分及对齐归因说明。
  3. **单片毛利穿透与经营大盘**：
     - 每片 Token 数、TTS 字数、单片成本（¥）与扣除积分（200分）。
     - 切换「商业与毛利大盘」查看流水、算力支出与单日净毛利率。
  4. **卡单告警与一键救火**：
     - 异常失败任务红标报警；
     - 提供「一键补发 200 积分」秒级解冻补偿。
- **后端 API**：`apps/api/src/admin.ts`（`/api/v1/admin/overview`、`/api/v1/admin/director-jobs`、`/api/v1/admin/jobs/:jobId/compensate`）。
- **质量验证**：`tests/admin.test.ts` 100% 通过；前端 `npm --prefix apps/web run build` 打包 0 错误。

### 2. 既有基础能力
- **用户体系与两阶段计费**：`apps/api/src/billing.ts`，出片预冻结 200 积分，渲染成功结算，失败自动回滚解冻。
- **资产上传管理**：`apps/api/src/assets.ts`，支持图片与视频防篡改文件头魔数校验、安全上传与生命周期过期清理。
- **导演方案引擎**：`apps/api/src/director.ts`，基于 OpenAI 兼容协议的大模型分镜规划器 + 启发式成熟规则兜底。

---

## 本轮接续记录（2026-11-16）

当前分支：`feat/v4-admin-director-console`。本轮仅修改 V4 仓库，没有操作 V2、线上环境或 main。

已完成：
- 算力积分中心采用克制的浅色编辑式布局，移除重复 class、内联旧价格样式和过度强调的按钮表现。
- 启发式导演降级方案改为中性旁白，不会把用户 prompt 直接朗读成旁白，也不会根据文件名虚构画面内容；默认包装仍包含开场、结尾、字幕、BGM。
- Worker 队列领取改为单条 PostgreSQL CTE + `FOR UPDATE SKIP LOCKED` + 原子状态更新，避免多个 Worker 重复领取；视频配音引擎新增 TTS、旁白拼接、BGM 混音与最终 FFmpeg 合成阶段计时，并透传至 Worker 和后台。
- 管理后台经营大盘增加当日真实成本聚合字段；只有存在真实 `costEstimateYuan` 记录时才标记成本数据可用，不用模拟值冒充成本。
- 新增 Worker 原子领取测试、PostgreSQL 管理大盘聚合测试。

验证结果：
- 全量测试：84/84 通过。
- `npm run build`：TypeScript、Web Vite、API TypeScript 构建全部通过。
- 本机 Web 开发服务器：`http://127.0.0.1:5173/` 返回 HTTP 200。
- 当前 `.env` 文件未包含 DATABASE_URL、导演模型、管理员白名单、TTS 凭据和独立媒体目录配置；本轮未启动 API，也未连接或修改任何真实数据库。成本估算字段仍等待真实模型/TTS 用量与单价埋点后才能显示。

## 三、 接下来的核心工作清单 (Backlog for GPT)

接手工程师请按以下优先级推进开发：

### 🎯 任务 1：管理后台真实数据持久化与 SQL 聚合 (P1 优先级)
- **现状**：`apps/api/src/admin.ts` 已接入 `pg.Pool`，经营大盘的营收、用户、任务成功率和时延通过 PostgreSQL 聚合；成本字段只读取真实 `_telemetry.costEstimateYuan`，没有真实记录时明确显示未接入。尚缺真实模型/TTS 用量成本埋点及真实 PostgreSQL 集成验证。
- **剩余目标**：
  1. 为模型与 TTS 接入真实用量计量（Token、字符数、服务商计费单价），将真实成本写入 `_telemetry.costEstimateYuan`；在此之前后台继续显示“未接入”，不推测成本。
  2. 配置独立 PostgreSQL 后执行真实数据库集成验证，覆盖时区日界线、空数据和多任务聚合。
  3. 保持数据库不可用或无记录时的优雅空状态。

### 🎯 任务 2：Worker 渲染流水线中的阶段耗时与决策埋点透传 (P1 优先级)
- **涉及文件**：`apps/api/src/worker.ts`、`apps/api/src/renderer.ts`、`apps/api/src/job-store.ts`
- **现状**：Worker 已记录并写回导演计划的 LLM、FFmpeg、TTS 和 E2E 耗时，并保留 `variant_type`、`anchor`、`voice_id` 等决策字段；视频配音模式已从 V4 迁移模块透传 TTS、拼接、BGM 与最终合成耗时；队列领取使用原子 SQL，防止多 Worker 重复消费。
- **剩余目标**：
  1. 完善 storyboard 模式的 ASR、BGM、片头片尾与 FFmpeg 分段计时；video-dub 的 TTS、旁白拼接、BGM 和最终合成计时已透传。
  2. 将失败任务的阶段耗时也安全写回，便于排障；增加 Worker 崩溃后的租约/超时恢复策略。
  3. 仅在真实计算出场景分类和评分后写入 `scene_type`、`scene_score`、`scene_alignment_reason`，不填充虚构指标。

### 🎯 任务 3：管理员权限与安全闸门 (P2 优先级)
- **涉及文件**：`apps/api/src/admin.ts`、`.env.example`
- **现状**：已通过 `ADMIN_EMAILS` 白名单和 `verifyAdminAuth` 校验管理员会话；生产环境启动时强制要求至少配置一个管理员邮箱，普通用户和空白名单均被拒绝。
- **剩余目标**：补充真实部署环境的密钥注入与权限运维流程，并评估管理员身份是否需要从邮箱白名单升级为独立角色。

---

## 四、 本地运行与验证指南 (Cheat Sheet)

### 1. 常用命令
```bash
# 1. 安装根依赖
npm install

# 2. 启动前端 Vite 开发服务器 (默认端口 5173)
npm run dev:web

# 3. 启动后端 API 开发服务器 (默认端口 3000)
npm run dev:api

# 4. 执行全量单元测试
npm test

# 5. 单独执行管理后台测试
npx tsx --test tests/admin.test.ts

# 6. 前端生产构建编译
npm --prefix apps/web run build
```

### 2. 界面访问方式
- 前端主页：`http://127.0.0.1:5173/`
- OPC 指挥中心直达：`http://127.0.0.1:5173/?admin=1`
- 点击首页顶栏右上角「**指挥台**」按钮可直接打开。


## 本轮继续执行记录（2026-11-16：自然语言导演执行闭环）

- 保持分支 `feat/v4-admin-director-console`；工作区原有未提交修改全部保留，未执行 reset/clean/commit；未操作 V2、线上环境或生产数据库。
- 生产 Worker 已注入 `@jansee/ffmpeg-kit/autoQc.mjs`。每个最终输出在写入作品库前逐一质检；拒绝或无法检查时阻断交付、清理本次私有输出对象，并沿用任务失败/额度退款流程。
- Auto-QC 按制作模式判断是否必须存在音轨：图片成片和普通视频配音要求音轨；分镜/切片结合默认 BGM 策略及原素材音轨判断。
- 通过任务 telemetry 记录每个输出的 QC 等级、媒体指标和警告。
- 新增 Worker 测试：通过时记录 QC 结果；拒绝时不发布作品并清理私有输出。
- 架构实施文档已同步更新：固定时长切片在字幕开启时调用 Whisper；语音停顿剪辑仍需接入 V2 speech-cut 的两阶段确认工作流。
- 当前 Auto-QC 仍不等于完整主观成片质检：完整解码、黑帧/静音、字幕时间窗、音画同步实测、隐式 AI 元数据可靠校验仍待增强。
- 验证：Auto-QC Worker 定向测试 2/2 通过；`npm run build` 在本轮 Auto-QC 接线时通过（TypeScript、Web Vite、API）。`node --test packages/ffmpeg-kit/tests/autoQc.test.mjs` 测试运行器 4/4 通过，其中依赖真实样片的两项因仓库中无样片而按测试逻辑跳过。全量 `npm test` 首次运行 98 项中 97 通过、1 项因 Engine Registry 测试仍期望仅注册 storyboard（代码已扩展为 image-film/video-dub/storyboard）而失败；随后测试文件已更新为三模式断言，需在代码稳定后重跑全量测试。不得将本地单测等同于生产素材验收。


## 本轮继续执行记录（2026-11-16：制作任务状态与交付信息回传）

- 在 `apps/web/src/App.tsx` 增加已受理制作任务的服务端状态轮询：持续读取 `GET /api/v1/jobs/:id`，同步状态、进度、失败原因和最终 DirectorPlan；网络临时失败时保留最后一次已知状态。
- 对话内任务状态展示覆盖受理、导演编排、渲染、质检、完成、失败；完成后可直接跳转作品中心。
- Worker 已生成并写回 DirectorPlan 的合规发布素材现在在对话内展示：发布文案、封面标题、置顶评论、建议发布时间，并支持一键复制。
- 轮询只在非终态任务存在时运行；比较状态、进度、错误及 JSON 方案，避免相同数据重复更新会话状态。
- 验证：`npm run build`（TypeScript、Web Vite、API）通过；`npm test` 98/98 通过。
- 本轮仅修改 V4 的 `apps/web/src/App.tsx` 与本交接文档；仍在 `feat/v4-admin-director-console`，未 commit、未部署、未连接生产数据库、未修改 V2。工作区原有其他修改继续保留。

## 下一步执行顺序（更新）

1. 为本轮前端任务状态轮询和发布素材回传补充针对性测试/回归验证，并完成真实浏览器交互验收。
2. 设计并实现持久化的 speech-cut 两阶段流程：服务端 ASR 分析、服务端保存词级时间戳/建议、用户只提交确认标识、服务端白名单校验后创建计费制作任务；不能接受客户端自带剪切时间范围，也不能自动删除用户说过的话。
3. 扩展 Auto-QC 的完整解码、黑帧/静音、字幕时间窗、音画同步和 AI 元数据检查，并用真实素材逐模式验收。
4. 完成 PostgreSQL、Whisper Linux、TTS、素材曲库、COS/持久化存储的生产集成；当前开发机没有 Docker 命令，生产容器构建尚未验证。
5. 支付真实网关、并发/故障恢复、安全与压力测试、灰度发布及上线验收。生产密钥/供应商账号/服务器操作授权缺失时，必须明确列为阻塞，不得使用模拟支付或开发配置冒充正式交付。


## 本轮继续执行记录（2026-11-16：任务状态并发安全）

- 修复 PostgreSQL JobStore 的状态流转锁失效问题：此前 `SELECT ... FOR UPDATE` 通过 Pool 独立查询执行，自动提交后行锁已释放，后续 UPDATE 不在同一事务内，多个 Worker/请求可能竞争同一任务状态。
- 现在状态读取、领域状态机断言、状态 UPDATE 在同一数据库 Client 事务中执行；非法流转回滚；成功提交后再读取关联素材，避免长时间持有行锁。
- 状态更新同时清理非 failed 状态上的历史 error_code/error_message，只有进入 failed 时才写入当前错误信息。
- 新增 `tests/job-store.test.ts`，覆盖锁定与 UPDATE 同事务、非法流转回滚及连接释放。
- 验证：新增定向测试 2/2 通过；全量自动化测试 100/100 通过；`npm run build` 通过（根 TypeScript、Web Vite、API TypeScript）；`npm run check:independence` 通过，未发现 V2 checkout 或 V2 gateway runtime 引用。
- `git diff --check` 仍报告三个既有文件 EOF 空行：`apps/api/migrations/0002_add_phone_to_users.sql`、`packages/sms-kit/index.js`、`packages/sms-kit/package.json`；本轮未顺手清理这些无关历史差异。
- 未 commit、未部署、未连接生产数据库、未触碰线上数据，V2 仍只读。当前工作区原有未提交内容全部保留。

## P0–P4 当前验收状态（持续更新）

| 阶段 | 当前状态 | 尚需的硬验收 |
| --- | --- | --- |
| P0 导演中枢 | 核心对话规划、三种制作引擎、任务状态回传已存在；本轮补强任务状态事务安全 | 自然语言意图覆盖测试、真实端到端导演路由、失败恢复与真实素材验收 |
| P1 语音精剪 | V2 speech-cut 规则/合成能力已在 V4 代码库内，但尚未接入 V4 持久化两阶段 API | 服务端 ASR 结果与建议持久化、用户确认 suggestion ID、服务端校验后创建任务、完整 UI 对话闭环 |
| P2 自动质检 | Auto-QC 已进入 Worker，阻断不合格输出 | 完整解码、黑帧/静音、字幕时间窗、音画同步、AI 元数据校验；真实素材逐模式验收 |
| P3 生产设施 | PostgreSQL/COS/本地私有存储/Whisper/TTS 配置与部署模板已有基础 | 独立生产 PostgreSQL 集成、Linux Whisper/FFmpeg 容器验证、COS 真实凭据验证、持久化与备份恢复、Worker 租约恢复/压力测试 |
| P4 商业上线 | 账号、积分冻结/结算/退款、订单/流水与后台基础已存在 | 正式支付渠道回调验签与对账、安全审计、压测、灰度/回滚、合规检查及真实付费链路验收 |

**总状态：尚未达到 P0–P4 全部交付。** 自动化测试和本机构建通过不等于生产上线。下一步优先完成 P1 speech-cut 持久化两阶段工作流，再补 P2 深度质检与 P3 Worker 恢复/真实环境验证，最后完成 P4 商业验收。生产账号、密钥或部署授权缺失时保留为明确阻塞项。

## 最新审计与继续交付记录（2026-11-16：P0–P4 复核与交易安全）

本节优先于上文较早的 backlog 描述；旧记录保留为历史，不代表当前代码状态。

### 已核实的现有实现

- **P0 导演中枢**：导演规划 API、规则兜底、三种公开制作模式、内部 Engine Registry、Worker 调度、任务状态轮询、成片状态/发布素材回传均已存在。仍需扩充自然语言意图覆盖与真实用户素材端到端验收；本地构建不能替代真实模型供应商验收。
- **P1 语音精剪**：两阶段 API 已接入：创建分析会话、服务端 ASR 词级时间戳、服务端保存建议 ID、用户确认建议 ID、后端校验后创建计费任务；前端对话中展示建议与勾选确认。Worker 读取服务端持久化词数据并调用 speech-cut 合成，未接收客户端时间区间。已有 API/Worker 自动化测试及真实 FFmpeg 合成测试。生产仍需 Linux Whisper 可执行文件、模型和真实口播素材验收。
- **P2 Auto-QC**：Worker 发布前执行完整媒体解码、黑帧/静音检测、字幕时间窗、音轨和 AIGC 标识检查；深度质检测试已覆盖解码失败、黑帧/长静音、字幕越界。AIGC 检查目前是文件/媒体输出中的标记扫描，不应误称为完整 MP4 box 结构级密码学/来源证明；还需真实成片和音画同步的多素材验收。
- **P3 生产设施**：数据库迁移 0005_job_worker_leases.sql 与 Worker 租约、心跳、过期回收、最多三次尝试和最终退款路径已存在；COS 模块目前提供私有对象签名 URL、HEAD 和删除能力，但 API 上传/Worker 文件路径仍以 LocalObjectStorage 为主，COS 尚未成为完整生产对象存储后端。生产 PostgreSQL、Linux 容器/FFmpeg/Whisper、COS 凭据、备份恢复、压力测试尚未实测。
- **P4 商业上线**：钱包、积分冻结/结算/退款、订单/流水和开发环境模拟支付存在。真实支付渠道、回调验签、订单对账和退款闭环没有接入，不能上线收款。前端已明确提示订单创建不等于支付、不会自动到账。

### 本轮实际改动

- 修复开发环境模拟支付接口的订单归属校验：只有订单所属账号才能模拟完成；其他账号获得 404，订单保持 pending、钱包不变。
- 充值订单创建与模拟支付接口增加严格 Origin allowlist 校验，降低 Cookie 会话下的跨站请求风险。
- 删除内存测试账本生成的伪造支付 URL；无真实支付渠道时不生成看似可用的付款地址。
- PostgreSQL 作品记录写入改为按全局唯一 storage_key 幂等 upsert，支持 Worker 在租约恢复后重试时避免重复插入同一输出记录。
- RenderResult 补齐可选字幕时间轴类型，修复 Worker Auto-QC 字幕时间窗接线的 TypeScript 构建错误。
- 清理本轮编辑过程中误加的重复 import；没有改变现有 Worker 租约方案。

### 当前验收边界与剩余阻塞

- 本机全量测试与构建通过仅证明代码级回归，不证明真实生产环境、供应商服务或真实付费链路已验收。
- **阻塞 P3**：需要独立生产 PostgreSQL 连接信息、COS Bucket/Region/SecretId/SecretKey、部署服务器/容器运行环境、Linux Whisper binary 与模型文件，以及备份恢复目标。
- **阻塞 P4**：需要确定正式支付服务商（微信支付/支付宝/聚合支付）、商户号、AppID、API 密钥/证书、回调域名与退款规则。拿到服务商官方接口文档和测试商户环境后再实现；不臆造 OPCPAY 协议。
- 未提交、未部署、未修改线上数据、未操作 V2；所有既有未提交工作继续保留。


## 本轮继续执行记录（2026-11-16：P1 语音精剪闭环、P2 深度质检、P3 Worker 租约）

### P1：语音精剪两阶段流程已接入 V4

- 新增迁移 `0004_speech_cut_sessions.sql` 和 PostgreSQL 持久化存储 `speech-cut-store.ts`：保存用户素材关联、ASR 词级时间戳、识别文本、服务端生成的建议 UUID、确认状态、最终任务关联，24 小时过期。
- 新增认证 API：
  - `POST /api/v1/speech-cut/analyze`：只接受本人拥有的视频素材，检查音轨与 3 分钟上限，异步执行 Whisper/ASR 与建议识别。
  - `GET /api/v1/speech-cut/:id`：只返回当前用户自己的分析会话。
  - `POST /api/v1/speech-cut/:id/confirm`：只接受数据库中已有的 suggestion UUID；拒绝客户端伪造的时间区间、重复 ID 和删除全部台词的请求。
- V4 对话界面增加内嵌确认卡：分析完成后逐条展示口头语、重复表达、冗余语句与停顿；默认勾选建议删除项，用户可以逐条取消；用户确认之前绝不删除任何台词。
- 确认后由服务端从持久化 ASR 数据构造受信任 DirectorPlan，再创建制作任务。普通 `POST /api/v1/jobs` 明确拒绝客户端自带的 speech-cut 执行计划，防止绕过确认流程。
- Worker 已接入 `composeSpeechcut`：按已确认建议删除词级时间区间/停顿，保留原始人声；片头、片尾、字幕、BGM 遵守导演包装配置。字幕时间轴随最终渲染结果交给 Auto-QC 校验。
- 新增 API 权限/篡改/重复提交测试，以及真实 FFmpeg 合成的 Worker 端到端测试。

### P2：Auto-QC 深度检测已增强

- 质检增加异步 FFmpeg 全量解码（限制 2 个线程，默认 180 秒超时），不是只读取文件头或探测时长。
- 在同一解码过程中检测黑帧和静音区间：持续黑帧超过阈值阻断发布；长静音默认警告，语音精剪模式启用连续语音门槛。
- 增加字幕时间窗检查：字幕起止必须有效、不能越出成片时长，且不能出现明显时间重叠。
- AIGC 来源标识检查改为扫描完整 MP4，而不是只检查文件前 8 KB；Worker 对正式生成任务要求存在 JANSEE/AIGC 标识。
- 新增正常成片、损坏文件、长黑帧、长静音、字幕越界等自动化测试。

### P3：任务并发与崩溃恢复已补强

- PostgreSQL 任务状态读取、状态机校验与 UPDATE 现在共用同一个事务和行锁，避免 Pool 自动提交导致 `FOR UPDATE` 锁提前释放。
- 新增迁移 `0005_job_worker_leases.sql`：记录 Worker ID、租约到期时间、心跳时间与尝试次数。
- Worker 每 30 秒续租 120 秒；队列可回收租约过期且未超过 3 次的任务；租约丢失的旧 Worker 在发布前停止。
- 超过重试次数的过期任务先尝试幂等退款，退款成功后再标记失败；退款失败则保留可重试状态，避免任务已失败但积分永久冻结。
- 队列只领取存在积分 hold 记录的任务，避免“任务已排队但积分冻结尚未完成”时 Worker 抢先开始制作。

### 本轮验证

- `npm run build`：通过（TypeScript、Web Vite、API TypeScript）。
- `npm test`：112/112 通过。
- 仍需执行 `npm run check:independence` 和 `git diff --check` 作为最终本轮收尾。
- 未提交、未部署、未连接生产数据库，未修改 V2，未触碰线上数据。

### P0–P4 最新状态

| 阶段 | 代码实现状态 | 生产验收状态 |
| --- | --- | --- |
| P0 导演中枢 | 对话任务轮询、导演计划、三引擎调度、任务状态事务安全已有实现 | 仍需真实自然语言覆盖、Linux 端到端素材验收 |
| P1 语音精剪 | 服务端持久化两阶段流程、对话内逐条确认、Worker 原声精剪闭环已接入 | 仍需真实 Whisper 语音素材验收、PostgreSQL 迁移实库验证、Linux FFmpeg 验证 |
| P2 自动质检 | 全量解码、黑帧/静音、字幕时间窗、AIGC 标识检查已接入 Worker | 仍需真实生产素材与各模式输出阈值校准 |
| P3 生产设施 | Worker 心跳租约、过期回收、最大重试与积分 hold 门槛已有代码和迁移 | 仍需生产 PostgreSQL 集成、Worker kill/restart、并发压力、COS 持久化/备份恢复与 Linux 容器验收 |
| P4 商业上线 | 账号、订单、积分冻结/结算/退款、交易后台已有基础 | 正式支付渠道、回调验签、对账、安全审计、压测、灰度与回滚仍未完成 |

**交付判断：P0–P3 的关键代码路径已进一步落地，但尚不能称为生产验收完成；P4 商业上线仍未完成。** 继续按 P3 真实环境验收和 P4 支付/安全闭环推进。任何生产密钥、正式账号或部署权限缺失都作为阻塞项，不绕过、不虚构。


## P3 后续推进补充（2026-11-16：COS 持久化对象存储接入）

在上一节审计之后，P3 又完成了以下代码工作；以下状态覆盖“COS 尚未成为完整生产对象存储后端”的旧描述：

- 新增 Tencent COS 对象存储适配器，实现与 LocalObjectStorage 相同的 putFile/getFilePath/deleteObject/deleteExpired 接口。
- 上传时服务端将文件写入 COS 私有对象，随后通过 HEAD 校验对象大小；Worker 需要媒体文件时按对象键下载到本地私有缓存，并校验下载字节数；删除/过期清理会同时处理远端对象和本地缓存。
- server.ts 支持 MEDIA_STORAGE_DRIVER=local 或 cos；生产 COS 模式强制检查 SecretId、SecretKey、Bucket、Region 和绝对路径缓存目录。
- Docker Compose 增加独立 COS 下载/渲染缓存目录；Dockerfile 创建相应目录。
- 新增 COS 对象存储适配器测试 2 项，覆盖上传、下载缓存、删除、路径安全和大小限制。
- 本轮最新全量自动化测试：114/114 通过；V4 independence 检查通过；最新 TypeScript/Web/API 构建通过。

仍未完成的 P3 验收：当前只有模拟 COS 客户端测试，未使用真实 Bucket/凭据验证；Docker/生产 Linux 镜像未实际构建运行；Whisper Linux binary/model、PostgreSQL 迁移/备份恢复、真实并发和压力测试尚未完成。COS 凭据必须由用户提供或在部署机安全配置，不能写入仓库。


### 额外实机烟测与环境阻塞确认

- 在 Windows 开发机上用系统中文语音合成生成了真实 WAV 样本，直接调用 V4 的 `runKeepOriginalAsr`，使用仓库内 `whisper-cli.exe` 与 `ggml-small.bin` 完成真实推理；不是 mock ASR。
- 本次样本返回 37 个词级时间戳，识别出“恩/恩啊/这个”等口头语，以及约 1.9 秒、1.0 秒停顿；领域提示词让“简兮人工智能导演系统”被正确识别。已增加 JANSEE 领域提示词与“恩/恩啊”口头语归一化。
- 本机 `whisper-cli.exe` 与模型文件可用；模型约 487 MB。真实语音烟测通过，但这不替代生产 Linux 服务器上的内存、并发和延迟验收。
- Linux 验收当前被环境阻塞：Windows 有 WSL 命令但没有可用 Linux 发行版，Docker 命令不可用；因此尚未完成 Linux FFmpeg/Whisper 容器验收。
- 仅检查了本机进程环境变量名与项目 `.env` 键名（未读取或输出任何密钥值）：当前未发现 `DATABASE_URL`、COS 正式密钥、模型/TTS 正式密钥、微信支付或支付宝商户凭据。项目 `.env` 目前只配置了短信相关键名。生产数据库、对象存储、正式模型/TTS 和支付联调因此仍是外部阻塞项。


### P4：上线安全闸门与资源保护

- 生产环境没有真实支付 Provider 时，`POST /api/v1/billing/orders` 现在明确返回 `503 PAYMENT_PROVIDER_NOT_CONFIGURED`，不再创建没有支付路径的假充值订单；开发环境的模拟支付仍只在明确启用时可用。
- `/health/ready` 在生产环境额外检查真实支付渠道状态；即使数据库和 Worker 正常，支付未接入时也不会报告整体 ready。
- 对语音精剪分析、语音精剪确认、任务创建和充值下单增加独立限流，避免昂贵 ASR/FFmpeg 与计费接口被滥用。
- 生产支付 Provider 尚未实现，也没有微信支付/支付宝商户凭据，因此 P4 仍然未完成；当前采取 fail-closed，而不是模拟支付冒充正式支付。


## P3 Worker 租约 fencing 加固（2026-11-16）

进一步复核发现，只有心跳与过期回收还不够：旧 Worker 在租约被另一个 Worker 接管后，仍可能尝试更新任务状态或发布作品。本轮已补上所有权 fencing：

- PostgreSQL 任务状态更新在 SELECT FOR UPDATE 中同时读取 worker_id；带 workerId 的 Worker 状态变更必须匹配当前持有者，否则抛出 WORKER_LEASE_LOST。
- DirectorPlan 写回必须匹配当前 worker_id。
- 作品发布使用带 FOR UPDATE 的 owned_job CTE；只有仍持有租约且任务处于 quality-check 的 Worker 才能创建/幂等更新作品记录。
- 心跳数据库错误也视为无法确认租约，Worker 停止继续发布；失去租约的旧 Worker 不得清理共享 storage_key、不改任务状态、不退款，以免误伤新 Worker。
- 修正租约耗尽恢复逻辑：恢复事务已经将任务置为 failed，后续只执行幂等退款，不再重复尝试 failed→failed 的非法状态迁移。
- 新增 stale Worker 状态写入测试及作品发布 fencing 测试；定向 Worker/JobStore/OutputStore 测试 17/17 通过；完整构建通过。完整测试套件正在重新执行。


### 最新回归结果（P4 安全闸门加入后）

- `npm run build`：通过。
- `npm test`：118/118 通过（包含 P1 两阶段语音精剪 API、真实 FFmpeg 精剪 Worker、P2 深度质检、P3 Worker 租约/心跳、P4 生产支付 fail-closed 与 readiness 测试）。
- Windows 本地真实 Whisper 烟测：`runKeepOriginalAsr` 返回 37 个词级时间戳，并识别出口头语与停顿建议；品牌提示词将“简兮”正确识别。


## P3/P4 continued engineering (2026-11-16: media retention + atomic billing completion)

### Fixed issues found during production-readiness review
- Every newly uploaded asset now receives a 24-hour `expires_at` deadline; previously upload inserts did not set it, so the scheduled asset sweeper could never discover normal uploaded files for expiry.
- The hourly asset cleanup now uses the actual expiry timestamp (not an extra 24-hour-old cutoff), skips assets still referenced by active jobs, and only marks DB rows expired after physical object deletion succeeds. Failed COS/local deletion remains retryable.
- Production PostgreSQL job completion and credit settlement now run through `BillingStore.completeJobAndSettle` in one transaction: lock and verify current Worker lease + quality-check state, verify the credit hold/frozen balance, write the settle ledger entry, and complete the job atomically. This prevents a completed-but-unsettled job and avoids charging then marking a job failed after a later settlement error.
- Stale workers cannot settle a reclaimed job. Regression tests cover successful atomic settlement, stale lease, missing hold, prior refund, expiry, active-job retention, and storage deletion failure.

### Backup and restore operational tooling
- Added `scripts/db-backup.sh`: PostgreSQL custom-format backup, archive-list verification, restrictive file permissions, optional SHA-256 sidecar and configurable retention pruning.
- Added `scripts/db-restore-drill.sh`: explicit-confirmation restore into a separate isolated empty V4 database, without destructive `--clean` behavior, followed by schema/user count checks.
- Added libpq service-file setup and operator instructions to `docs/architecture/POSTGRESQL-OPERATIONS.md`. Scripts pass Git Bash syntax validation; they have not been run against a live database.

### Verification
- `npm run build`: passed after these changes.
- Focused tests: 23/23 passed for billing, worker, and atomic settlement; 15/15 passed for asset/output retention and store tests.
- Shell scripts: `bash -n` passed.
- A fresh full-suite run is still required after this batch.
- Still no live PostgreSQL/COS credentials, isolated restore target, Docker/WSL Linux environment, or formal payment merchant credentials. No production resource has been provisioned or modified; no V2, production, or online data was touched. No commit or deployment was performed.


## P2 continued: A/V timestamp synchronization gate (2026-11-16)

- The deep FFmpeg QC decode now runs `showinfo` and `ashowinfo` alongside black-frame and silence detection.
- It measures audio/video first-frame start drift and final-frame/sample end drift; any measured drift above 350 ms blocks publication and is stored in QC metrics.
- Added a real FFmpeg-generated test MP4 with an 800 ms audio offset; Auto-QC rejects it. Deep QC tests now 5/5 pass.
- This is timestamp-level stream synchronization, not a perceptual lip-sync model. Real talking-head samples, device playback checks and human review remain release gates.


## Latest verification checkpoint (2026-11-16)

- Director intent routing tightened: explicit slicing terms, split-verb + multi-output/interval patterns, per-segment duration phrases; explicit opt-outs are honored; generic “每条视频都加字幕” does not become a slicing job. The LLM system prompt now explicitly returns `operation` and `sliceSeconds`.
- Auto-QC now checks start/end audio/video stream timestamps in addition to full decode, black frames, silence, subtitle windows and AIGC markers.
- Fixed stale growth migration schema assertions in `tests/database-schema.test.ts` to assert the actual inline unique foreign-key declaration for `invitee_user_id`.
- Latest full suite: **138/138 passed**.
- Latest `npm run build`: passed (typecheck + web production build + API build).
- Latest `npm run check:independence`: passed; no V2 checkout or V2 gateway runtime references.
- Latest `git diff --check`: passed; only CRLF/LF normalization warnings remain.
- Git branch remains `feat/v4-admin-director-console`; working tree intentionally remains uncommitted. Existing `.tmp-visual-*` / `.tmp-admin-*` folders were left untouched. No reset/clean, commit, deployment, production DB, V2, or online data mutation occurred.

### P3/P4 external acceptance blockers
- This Windows development machine has no Docker, Podman or WSL runtime; the V4 Linux image cannot be built or booted here yet.
- No production PostgreSQL endpoint/credentials or isolated restore database: migrations, backup, and restore scripts have not had a live DB drill.
- No real Tencent COS bucket/credentials: COS adapter has mock-client tests only; production permissions, private bucket policy, CORS, lifecycle and upload/download throughput remain unverified.
- No real Linux Whisper CLI/model deployment or Linux FFmpeg integration test.
- No real payment provider has been selected/configured; production readiness intentionally stays closed and development `simulate-pay` is not a production payment path.
- No real SMS/TTS/model production credentials or merchant callback signatures have been validated.
- P4 release remains blocked until infrastructure and payment credentials are supplied and the end-to-end production smoke, restore, concurrency, security and human media acceptance drills pass.

## 本轮继续执行记录（2026-11-16：P4 一人付交易安全、会员权益执行与回归）

### P4：一人付（OPCPAY）交易链路补强

- 将支付 API 是否可用与 Webhook 密钥是否配置分离：OPCPAY API 能力检查通过即可建立付款入口并通过定时查单/权益核销完成对账；Webhook 密钥缺失时只关闭 Webhook 回调，不错误地把整个支付服务判定为不可用。
- 每笔新订单在调用 OPCPAY purchase 前先查询并持久化用户当前权益余额 provider_quota_baseline；对账时必须证明当前权益余额达到“下单前余额 + 本订单应得权益”，并在消费成功且 confirmed=true 后才执行本地积分/会员权益入账。已有余额不能冒充新购买。
- 首次创建支付意图时先持久化用户、订单、SKU、权益单位/数量与余额快照；purchase 超时重试沿用原订单 ID 幂等键和原始快照，不重新抬高 baseline。
- SKU 映射增加唯一性、CNY 币种校验；价格相同的多个候选 SKU 会被拒绝，必须配置唯一 display_name；价格、币种、QUANTITY 模式、权益单位与数量任一不符均阻断付款。
- 补充真实 HTTP webhook 路由层测试：按原始请求字节验签、篡改 body 拒绝、重复 event ID 幂等去重。Webhook 仍是可选能力；未配置密钥时必须保持回调未启用。
- OPCPAY 当前无自动退款能力，V4 不伪造退款接口；真实购买退款仍需按服务商支持的人工流程处理。

### 会员权益：从套餐展示落实到服务端强制执行

- 每日素材上传额度以套餐定义为准：Lite 30、Plus 60、Pro 120、Ultra 无限次；按 Asia/Shanghai 中国标准时间自然日重置。
- 上传额度校验与资产数据库插入使用同一 PostgreSQL 事务，并通过每用户 advisory transaction lock 串行化；并发请求不能绕过套餐额度。超限批次会回滚，不留下数据库素材记录，并清理本次已写入的对象。
- 会员制作队列按 Ultra、Pro、Plus、Lite、普通用户优先级领取，同时每等待六小时增加优先级补偿，避免普通用户无限饥饿。

### 最新验证结果

- npm test：**164/164 全量测试通过**，覆盖 P0 导演路由/三引擎、P1 speech-cut API 与真实 FFmpeg Worker、P2 深度 Auto-QC、P3 Worker 租约/作品发布 fencing/COS 适配器、P4 订单/权益核销/会员额度/签名 Webhook。
- npm run build：通过，包含根 TypeScript typecheck、Web Vite 生产构建、API TypeScript 构建。
- npm run check:independence：通过；没有 V2 checkout 或 V2 gateway runtime 引用。
- git diff --check：通过；Git 仅提示部分既有文件 CRLF/LF 规范化警告，没有 whitespace error。
- 会员额度定向测试：2/2 通过；支付、资产事务与 webhook 定向测试：23/23 通过。
- 代码仍在 feat/v4-admin-director-console。工作区存在大量此前已存在的未提交改动和临时目录；全部保留，没有 reset、clean、commit 或覆盖操作。没有部署、没有连接/修改生产数据库、没有触碰线上数据，V2 仍只读。

### P0–P4 当前真实交付判断（本节覆盖更早的状态表）

| 阶段 | 代码与本地验证 | 尚未通过的生产验收 |
| --- | --- | --- |
| P0 导演中枢 | 三种创作入口、自然语言导演规划/规则兜底、引擎注册表、Worker 调度、状态轮询、成片与发布素材回传已有实现；自动化测试通过 | 真实模型账号、不同用户素材/提示词覆盖、生产 Linux 全流程与商业成片人工验收 |
| P1 语音精剪 | 服务端 ASR 持久化、建议 ID、用户逐项确认、服务端校验后创建任务、Worker 按确认项剪辑已有闭环；Windows Whisper 实机烟测与 FFmpeg 合成测试通过 | Linux Whisper binary/model、生产 PostgreSQL 迁移、真实用户长短口播/多口音/噪声样本验收 |
| P2 自动质检 | 完整解码、黑帧/静音、字幕时间窗、音视频首尾时间戳偏差、AIGC 标识检查已接入发布前 Worker | 真实多设备播放、真实说话人唇形感知、不同模式/素材的人审阈值校准；AIGC 扫描不是密码学来源证明 |
| P3 生产设施 | PostgreSQL 迁移/存储接口、COS 适配器、私有媒体存储、备份/恢复脚本、Worker 心跳租约/回收/fencing 已有代码与测试 | 本机没有 Docker/可用 WSL Linux；尚未实建/启动 Linux 镜像，未连接独立生产 PostgreSQL/COS，未完成实库迁移、备份恢复演练、Linux FFmpeg/Whisper 与压力测试 |
| P4 商业上线 | OPCPAY/一人付 SDK 接入、SKU/价格/额度校验、订单持久化、二维码/付款入口、查单/核销/幂等入账、可选签名 Webhook、会员延展、积分流水与推荐佣金结算已有代码与自动化测试；没有支付配置时生产 readiness fail-closed | 尚未用正式 OPCPAY API Key、正式 SKU 与真实支付宝付款做低额交易验收；Webhook Secret/回调域名尚未真实验签；服务商不支持自动退款；还需实付/重复回调/中断恢复/退款人工流程验证、安全审计与灰度/回滚 |

**结论：本轮把 P0–P4 的关键代码路径继续推进，并将本地自动化回归提升到 164/164；但不能称为 P0–P4 生产交付完成，更不能称为已上线。** 当前最大剩余工作是取得并安全配置生产基础设施与正式 OPCPAY/模型/TTS 凭据，然后执行 Linux、真实 PostgreSQL/COS、真实支付宝付款、备份恢复、并发压测与真实素材人工验收。不得把 mock 测试或本地构建冒充真实支付/生产验收。

### 下轮继续执行的具体顺序

1. 复核支付权益快照与 OPCPAY SDK 的正式 API 语义，在服务商测试项目中跑通一笔低额真实支付、余额增量、消费核销、回调重放与本地入账。
2. 将会员权益页展示的每日额度与服务端限制/后台数据完全对齐，补充会员到期边界、跨日并发和同用户多 API 副本测试。
3. 解决 Linux 运行环境：在独立 Linux 主机/CI 上构建 deploy/Dockerfile.v4，安装匹配架构的 Whisper CLI 和模型，验证 FFmpeg/ASR/TTS/COS。
4. 取得独立 V4 PostgreSQL/COS 资源后，执行迁移、真实媒体读写、备份与隔离恢复演练。
5. 完成真实素材端到端验收、并发/故障恢复、安全审计、灰度和回滚。未获得明确部署授权前不向线上发布。


## OPCPAY 真实服务商只读核验补充（2026-11-16）

- 安全检查仅输出配置项是否存在，不读取或输出密钥值：V4 本地 .env 有 OPCPAY_API_KEY；没有 OPCPAY_WEBHOOK_SECRET、DATABASE_URL、COS Secret/Bucket/Region、Director API Key、TTS 凭据或 PARTNER_PAYOUT_ENCRYPTION_KEY。
- 使用 V4 的 OPCPAY SDK 对服务商执行只读 GET：capabilities 与 product 均成功返回。服务商 API v1.1、provider_configured=true、商品 ENABLED；purchase_entry、entitlement_query、consumption、purchase_request_query 均为 true。
- 服务商实际返回五档 SKU：Lite ¥41/38 COUNT、Plus ¥119/124 COUNT、Pro ¥299/333 COUNT、Ultra ¥599/769 COUNT、小加油包 ¥9.90/5 COUNT；与 V4 本地价格和 COUNT→200 积分映射一致。套餐显示名 Lite/Plus/Pro/Ultra 可直接匹配；小加油包通过唯一价格匹配，不存在多个同价 SKU 歧义。
- 本次没有创建订单、发起购买、调用 consume、修改 Webhook 或进行支付宝扣款。当前没有 Webhook Secret，因此不能启用服务商回调；可用定时查单/权益核销对账路径，但仍需真实低额交易验证 baseline 增量、核销和本地入账。
- Docker/Podman 不存在，WSL 命令存在但没有可用 Linux 发行版；独立 PostgreSQL/COS/模型/TTS 等生产配置仍未提供。禁止将 V2 凭据或数据库复制到 V4，禁止将本机密钥写入仓库或交接文档。


### P3 部署配置静态回归补充（2026-11-16）

- 新增 tests/deployment-config.test.ts，覆盖 Linux Docker 构建阶段、生产依赖裁剪、FFmpeg 静态依赖、持久化媒体卷、Linux Whisper 主机挂载、Docker build context 的密钥/本机二进制排除、Nginx API/health 反向代理与 500 MB 上传上限。
- 部署配置定向测试 4/4 通过。该测试只验证配置文本和仓库依赖，不代表 Docker 镜像已构建；当前机器仍没有 Docker/Podman 和可用 Linux 发行版。


### P4 旧订单权益基线安全补强（2026-11-16）

- provider_quota_baseline 迁移列改为 nullable 且不设默认 0。PostgreSQL 订单映射在数据库值为 NULL 时保留为“缺失”，不会把历史订单伪装成 baseline=0。
- 对已经绑定 OPCPAY 但没有下单前权益快照的历史待支付订单，V4 拒绝恢复付款入口与自动入账，提示人工核对；不能在购买请求可能已经创建后重新拍摄 baseline。
- 新增回归测试：旧订单缺少 baseline 时阻止 checkout；PostgreSQL 订单映射保留 baseline 缺失；迁移 schema 明确允许 NULL 但不设置默认 0。
- 定向支付/账本/迁移测试：32/32 通过。


### P4 一人付核销回执逐字段验收（2026-11-16）

- 对照一人付官方 Quickstart 的交付要求，核销成功不能只看 status/confirmed；必须同时校验原请求幂等号、consumed 数量、quota_unit 是否与本站订单完全一致。
- 已将同一严格校验用于首次 consume 响应和进程崩溃后的既有 consumption 查询恢复路径。任何字段不匹配都不入账，等待人工核对。
- 新增错请求号、错数量、错权益单位，以及历史成功核销回执字段不匹配测试。


## 本轮最终回归与环境盘点（2026-11-16）

- 最新全量 npm test：**175/175 通过**（包含部署配置、旧支付订单 baseline、严格核销回执校验等最新测试）。
- 最新 npm run build：通过（根 TypeScript、Web Vite、API TypeScript）。
- 最新 npm run check:independence：通过。
- 最新 git diff --check：通过；只有 CRLF/LF 规范化提示，无 whitespace error。
- 最新分支仍为 feat/v4-admin-director-console；没有 commit、没有 deploy、没有触碰 V2/线上数据。
- V4 短信通道配置检查：smsStatus() 返回 ready=true、provider=aliyun、mock=false；只读取状态，没有发送短信。
- V4 环境配置项存在性检查（只输出 true/false，不读取/打印密钥值）：OPCPAY_API_KEY 存在；阿里云 SMS 的 SECRET_ID/SECRET_KEY、签名、模板配置存在。缺少 DATABASE_URL、DATABASE_SSL、COS_SECRET_ID/KEY/BUCKET/REGION、MEDIA_STORAGE_DRIVER/ROOT、ADMIN_EMAILS、WEB_ORIGINS、DIRECTOR_API_BASE_URL/KEY/MODEL、JX_TTS_TENCENT_SECRET_ID/KEY、PARTNER_PAYOUT_ENCRYPTION_KEY、OPCPAY_WEBHOOK_SECRET。
- 这意味着支付服务商只读 API 配置已经可用，但正式 V4 API 目前不能进入生产启动条件：没有持久化数据库、媒体存储、导演模型、TTS、管理员与域名 CORS 配置及分账加密密钥。不得绕过生产 fail-closed 检查。
- 本机 Docker/Podman 不存在，WSL 没有可用发行版；当前不能完成 Linux 镜像构建和 Linux Whisper/FFmpeg 实机验收。

**当前结论：代码级 P0–P4 关键链路已通过 175 项本地自动化测试；生产环境尚未就绪。下一步不是继续堆代码，而是为独立 V4 提供上述缺失的正式基础设施与密钥，再逐项完成 Linux、真实数据库/COS、真实支付宝交易、真实 TTS/导演模型、备份恢复、压力与人工成片验收。**


### 最终核销安全回归（2026-11-16）

- 一人付核销回执新增逐字段校验后，最新全量测试为 **175/175 通过**；最新生产构建、V4 independence、git diff --check 均通过。
- 一人付官方 Quickstart 明确要求 status=SUCCEEDED、confirmed=true，并核对请求号、数量、单位后再交付；V4 首次核销与崩溃恢复现在都按此规则执行。
- 只读环境状态检查确认短信通道为 Aliyun 且非 Mock；这不代表真实短信下发已做过用户号码实测。


## 用户最新部署决策与本轮实现（2026-11-16）

### 用户确认的实施边界

- 一人付已在线上稳定使用：不再重复发起真实支付/扣款测试；沿用 OPCPAY_API_KEY、查单、权益查询与核销。Webhook Secret 是可选项，只在启用服务商主动回调签名验证时才需要；主动查单/权益核销路径不依赖它。
- 初期不启用 COS：使用云服务器独立持久化磁盘目录；必须有磁盘余量监控、TTL 清理与备份。达到容量/扩容条件后再迁移 COS。
- TTS 沿用 V2 线上腾讯云 TTS：按用户明确授权，将 V2 .env 中 JX_TTS_TENCENT_SECRET_ID、JX_TTS_TENCENT_SECRET_KEY 迁入 V4 本地 .env；密钥不打印、不进入源码或提交。运行时 loadEnvFile 检查确认两个变量均可读取。
- V2 的 SiliconFlow API Key 已确认存在，但用户只明确授权迁移 TTS 密钥；导演 API Key 暂不复制。待用户明确授权复用同一 SiliconFlow Key，或在 V4 服务器密钥环境单独配置。
- V4 数据库独立部署于云服务器，不连接 V2 数据库。

### 本轮实现

- deploy/docker-compose.v4.yml 增加 PostgreSQL 16 私有服务、健康检查、持久化命名卷；数据库无公网 ports 映射；API 等待 PostgreSQL healthy 后启动。
- API 通过私有 Docker DNS 主机 postgres 连接数据库。仅当 DATABASE_PRIVATE_NETWORK=true 且主机名精确为 postgres 时允许内部网络明文连接；其他生产 PostgreSQL 连接仍要求 TLS。
- 初期媒体存储明确固定为 local，API 容器目录 /app/storage/media 挂载到宿主机 storage/v4；不要求 COS 密钥。
- 新增 deploy/backup-v4-db.sh：生成 PostgreSQL custom-format dump，在 PostgreSQL 容器内执行 pg_restore --list 验证，成功后原子重命名；仅保留 14 天本机备份；失败时清除 partial 文件。
- 新增 deploy/V4-SINGLE-SERVER.md：单机拓扑、启动命令、密钥配置、Linux Whisper 要求、数据库与媒体备份、恢复演练和上线验收。
- .gitignore 与 .dockerignore 排除 backups，避免备份进入 Git 或镜像。
- DirectorPlanner 支持主模型+多级备用模型，模型失败/超时/响应结构无效时自动切换；每模型默认 12 秒；所有响应仍必须通过 DirectorPlanSchema 校验。
- .env.example 设置 SiliconFlow 兼容端点、GLM-5.3-Flash 主模型和 DeepSeek/Qwen 备用模型示例；真实 DIRECTOR_API_KEY 仍需授权复用或单独配置。

### 验证

- npm test：177/177 通过（包含新增 PostgreSQL 私有部署、导演模型 failover 测试；数据库备份静态测试追加后需再跑全量）。
- npm run build：通过。
- npm run check:independence：通过。
- git diff --check：通过（只有 Git CRLF/LF 规范化提示）。
- 本机没有 Docker/Podman、没有可用 Linux 发行版，因此没有声称完成 Docker 镜像构建、PostgreSQL 容器启动、Linux Whisper/FFmpeg 实机验证。
- V4 本地 .env 中 TTS 两个密钥变量可读取；DIRECTOR_API_KEY、DATABASE_URL、POSTGRES_PASSWORD 尚未配置。
- 没有部署、没有 commit、没有修改线上环境或 V2。


### 最终回归更新（2026-11-16）

- 新增数据库备份脚本静态测试后，最终 npm test 为 **178/178 通过**。
- npm run build 通过（TypeScript、Web Vite、API TypeScript）。
- npm run check:independence 通过。
- git diff --check 通过；仅存在 CRLF/LF 规范化提示。
- TTS 两个腾讯云凭据在 V4 .env 中 loadEnvFile 后均可读取；未进行真实 TTS 付费/线上请求。
- 仍未配置 DIRECTOR_API_KEY、POSTGRES_PASSWORD、DATABASE_URL（Compose 会根据 POSTGRES_PASSWORD 注入私有 PostgreSQL URL）；因此尚不能启动完整生产栈。
- Docker/Podman 和可用 Linux 发行版仍缺失，Compose 配置只完成静态测试，没有实际容器运行验证。


### 导演 API 密钥授权迁移完成（2026-11-16）

- 用户明确授权复用 V2 的 SiliconFlow API Key；已从 V2 本地 .env 复制到 V4 本地 .env 的 DIRECTOR_API_KEY，值从未打印。
- V4 已配置 SiliconFlow OpenAI-compatible endpoint。
- 四层导演模型已按 V2 原配置写入 V4：
  1. zai-org/GLM-5.3-Flash（主模型）
  2. deepseek-ai/DeepSeek-V4.1-Flash（备用一）
  3. Pro/deepseek-ai/DeepSeek-V3（备用二）
  4. Qwen/Qwen2.5-14B-Instruct（备用三）
- 每层由 DirectorPlanner 按顺序尝试，默认单模型 12 秒超时；模型失败或返回无效结构时进入下一层。四层都失败才返回错误。
- Node loadEnvFile 实际读取 V4 .env 验证：DIRECTOR_API_KEY、端点、主模型、备用模型、超时配置、TTS 两项密钥均可读取；备用模型数量为 3，总计四层。密钥值不输出。
- 未发起真实 SiliconFlow 请求，避免在开发机意外消耗额度；模型连通性待云端部署后使用受控健康检查验证。
- 最新全量 npm test：178/178 通过；npm run build 通过；npm run check:independence 通过；git diff --check 通过（仅 CRLF/LF 提示）。
- 分支仍为 feat/v4-admin-director-console；没有 commit、部署或修改线上/V2。


## 2026-11-16 — production security hardening follow-up

Work completed on branch feat/v4-admin-director-console. Existing uncommitted work was preserved; no reset, clean, staging, commit, deployment, or production data changes were performed.

- Enforced one-time, session-bound SMS reauthentication on server-side payout-profile changes and withdrawal creation. Added the account UI flow and focused regression tests.
- Made billing order status GET read-only. Moved OPCPAY reconciliation/entitlement consumption to a same-origin, rate-limited POST endpoint and updated the client poller.
- Pinned Fastify proxy trust to the exact Nginx container IP (172.30.250.2) on a dedicated Compose network; added tests proving untrusted peers cannot spoof X-Forwarded-For.
- Added fail-closed production startup checks for canonical HTTPS WEB_ORIGINS, exact TRUST_PROXY_IP, OPCPAY API/webhook credentials, executable Linux Whisper CLI/model, media assets, and media storage configuration. Environment checks now run before database migrations.
- Added deploy/.env.production.example and documented production secret provisioning, network collision checks, and backup requirements.
- Added Git/Docker ignore rules for local authenticated browser profiles and visual QA state; existing local profiles were preserved.

Final local gates at this handover: npm test 191/191 passed; npm run build passed (typecheck, Vite web build, API TypeScript build); npm run check:independence passed; git diff --check passed. npm audit --omit=dev --audit-level=high previously reported zero production dependency vulnerabilities; no dependency changes were made during this hardening pass.

Production sign-off is still blocked. The current local .env has no WEB_ORIGINS, POSTGRES_PASSWORD, ADMIN_EMAILS, PARTNER_PAYOUT_ENCRYPTION_KEY, or OPCPAY_WEBHOOK_SECRET. The repo has the Whisper model and materials directory, but no Linux whisper-cli executable at whisper.cpp/bin/whisper-cli. Docker CLI and a Linux/WSL runtime are unavailable on the connected workstation, and no production Linux host was connected; therefore Compose parsing/image build, real PostgreSQL startup/migrations, real OPCPAY webhook round-trip, Linux Whisper execution, load/fault injection, and backup-restore drill remain unverified. Do not call V4 9.5/10 or production-ready until these gates pass.
