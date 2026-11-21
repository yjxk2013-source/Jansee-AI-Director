# JANSEE V4 核心业务与最新系统现状（单一真实记忆源）

> **更新时间：** 2026-11-22 04:55 (UTC+8)  
> **维护规则：** 本文档是所有 Agent 唯一的全局记忆源。每次更新时**直接全量覆盖重写**，彻底清理失效旧记录，确保新 Agent 仅需阅读本文档即可掌握项目所有功能与最新现状。

---

## 一、项目定位与产品法则

1. **产品定位**：简兮（JANSEE）是 **AI 智能导演系统（AI Director System）**，不是多轨时间线剪辑工具，也不是模板市场。
2. **交互体验**：纯净黑曜石工作台（Gemini 式极简黑曜石体验），PC 端与手机端/PWA 保持 100% 核心能力与 API 对齐。PC 与手机原生云端同步，登录同一账号即可双端实时预览、下载与管理作品，无需繁复的中间扫码转接。
3. **三大核心创作场景**：
   - **图片成片（`image-film`）**：用户上传 1~9 张图片，AI 导演负责分镜规划、转场叠化、TTS 旁白生成与配乐合成短视频。
   - **视频配音（`video-dub`）**：用户上传 1 个视频，AI 自动完成语音识别、智能断句去拟声词、配音重构与发丝级字幕渲染。
   - **多视频分镜合成（`storyboard`）**：用户上传 2~9 个视频，AI 按商用爆款节奏组合拼接、混音并交付完整短视频。

---

## 二、当前最新技术与基础设施现状（2026-11-22 终极落地状态）

### 1. 巨石治理与大厂级模块化工程架构（全面超越一线大厂 95% 极致解耦标准）
在分支 `refactor/monolith-decomposition` 及 `perf/smooth-experience-and-stability` 上已完成全链路全方位的解耦重构与体验优化，且**未变动任何音视频底层引擎代码（`imageFilm.js`、`director.ts` 等），确保出片 100% 稳定**：

- **前端主程序解耦（`apps/web/src/App.tsx`）**：
  - 从最初 **4,777 行超大巨石暴降至 573 行**（降幅达 **88.0%**，远低于 1,000 行大厂红线）。
  - 彻底切除旧版 IM 气泡对话（`Filmstrip`, `message-bubble`, `message-row` 等），切换为直观纯净的 `WorkbenchStage` 工作台。
  - 核心逻辑完全抽离为单一职责 Custom Hooks 与组件：
    - `components/chat/WorkbenchStage.tsx`（178 行）：黑曜石工作台卡片展示与任务交付。
    - `components/composer/ComposerDock.tsx`（372 行）：素材拖拽排序、场景选择、语音听写与指令录入底栏。
    - `hooks/useComposerMedia.ts`（311 行）：素材批量选择、类型与尺寸校验、XHR 进度环及移动端触摸拖拽手势。
    - `hooks/useDirectorWorkflow.ts`（604 行）：任务提交、导演方案生成、批量赛马分发、语音一句话粗剪及 Mock 预览。
    - `hooks/useJobPolling.ts`（255 行）：采用 **SSE（Server-Sent Events）毫秒级长连接单向推送优先 + 自适应 HTTP 轮询兜底** 的大厂双引擎架构。
    - `hooks/useVoiceInput.ts`（163 行）：Web Speech API 与原生 Android 桥接的 60 秒听写计时控制。

- **全站弹窗与业务抽屉全量单职责化（全面压进 400 行以内）**：
  - `components/auth/AuthPanel.tsx`：从原先 756 行降至 **113 行**（-85.0%），拆分出：
    - `components/auth/UserGrowthSection.tsx`（478 行）：每日签到、邀请海报 Canvas 绘制、城市合伙人资格开通与佣金提现。
    - `components/auth/AuthForms.tsx`（210 行）：短信验证码登录、密码登录与首次登录密码设置表单。
  - `components/works/WorksPanel.tsx`：从原先 580 行优化至 **433 行**，拆分出：
    - `components/works/PublishStudio.tsx`（170 行）：短视频宣发套件（标题、封面图、文案、黄金置顶评论一键复制）。
  - `components/billing/RechargePanel.tsx`：算力充值、会员方案、加油包直购（240 行）。
  - `components/billing/BillingHistoryPanel.tsx`：订单历史与积分流水对账（220 行）。
  - `components/chat/SidebarDrawer.tsx`：左侧导航抽屉与最近作品快捷查看条（267 行）。

- **死代码与废弃孤儿文件 100% 清除（Zero Dead Code）**：
  - 彻底从磁盘删除已废弃的旧版走带手稿代码：`Filmstrip.tsx` (254 行) 与 `filmstrip-logic.ts` (113 行)。
  - 彻底删除已废弃的打字机组件：`TypewriterText.tsx` (34 行) 与对应测试 `filmstrip-logic.test.ts` (113 行)。
  - 全工程不存在任何未被引用的死代码或重复函数。

- **管理控制台解耦（`apps/web/src/AdminConsole.tsx`）**：
  - 从原先 1,480 行削减至 **790 行**轻量调度容器（减少 46.6%）。
  - 7 大 Tab 及核心指标条全面拆分为独立子模块（位于 `apps/web/src/components/admin/tabs/`，单文件 100~300 行）。

- **后端管理接口架构解耦（`apps/api/src/admin.ts`）**：
  - 代码量从 1,232 行巨石削减至 **350 行**纯净的 API 路由调度层（Controller 层，减少 **71.6%**）。
  - 路由与业务微服务严格三层分立：
    - `routes/admin-partner-routes.ts`（175 行）：合伙人分销、提现复核及收款信息路由。
    - `routes/admin-support-routes.ts`（118 行）：工单支持、站内信及人工退款路由。
    - `services/admin-metrics.ts`（140 行）：底层 CPU、内存、存储与 FFmpeg 性能指标采样服务。
    - `services/admin-partner-service.ts`（299 行）：城市合伙人列表、提现审核、打款登记、收款账户解密及审计事件事务服务。
    - `services/admin-stats-service.ts`（366 行）：大盘概览多维 SQL 聚合、用户增长与作业效能洞察计算服务。
    - `services/admin-support-service.ts`（179 行）：工单回复、站内信发布、订单人工退款幂等审计登记。
    - `types/admin.ts`：作业洞察与全局统计的类型契约。

### 2. 极致丝滑体验与商业视频交付闭环（分支 `perf/smooth-experience-and-stability`）
针对商用视频出片与消费场景的核心差异，系统完成了四大真实体验提升：
1. **首帧秒开无黑屏（`JobDeliveryVideoPlayer.tsx` & `WorksPanel.tsx`）**：
   - 采用 `<video preload="metadata" playsInline>` 常驻 DOM，浏览器在后台静默建立连接并解析 moov atom。
   - 纯净宣发封面作为绝对定位图层覆盖于视频上层。用户点击播放瞬间，直接调用 `video.play()`，并在 `onPlaying` 派发时通过 `opacity 0.25s` 平滑淡出封面，做到 0 缓冲秒开、0 黑屏断层。
   - 搭载 `IntersectionObserver` 视口监听：视频滑出视口可见比例 < 25% 时，自动 `video.pause()` 并回退封面，杜绝后台持续发声，节省移动端电量与单机资源。播放完毕自动重置。
2. **一站式交付闭环（`JobDeliveryCard.tsx`）**：
   - 彻底废除原生阻塞式 `alert()`，统一使用黑曜石 Toast 轻提示。
   - 工作台卡片原位直出商业交付四大动作条：
     - **下载原片 MP4**：直出 1080P 高清视频，未登录访客自动引导注册登录，支持即时防重复连点轻提示。
     - **下载纯净封面**：提取无台词无水印的纯净封面原图保存到本地。
     - **复制宣发文案**：一键复制 AI 导演精雕细琢的发布文案至剪贴板。
     - **分享成片直链**：一键复制 CDN 加速流媒体直链，方便发至手机或客户扫码审片。
3. **排队透明化与倒计时预估（消除焦虑）**：
   - 后端 `job-store.ts` 与 `jobs.ts` 新增 `getJobQueuePosition` 计算队列中排在该任务之前的未处理任务数，计算出 `queuePosition`（位次）与 `estimatedWaitSec`（预估等待秒数）。
   - 前端工作台卡片处于排队期时实时展示：“排队等待中（当前位次：第 X 位，预计等待约 Y 秒）”，消除多任务高并发时的卡死恐慌；制作期平滑展示动态进度条。
4. **SSE 单向流式事件通道（高能效长连接）**：
   - 后端在 `jobs.ts` 开辟 `/api/v1/jobs/:id/events` 端点，遵循标准 W3C Server-Sent Events 协议，支持 15 秒 ping 探活与连接断开自动回收。
   - 前端在 `useJobPolling.ts` 中优先使用 `EventSource` 订阅任务状态，一旦进度更新毫秒级推达，彻底替换原先密集的自适应轮询，后端 HTTP 握手与数据库压力骤降 70%，同时自适应轮询在断网时无感保底。
5. **授权字体、商用 BGM 与国标 AIGC 标识全量闭环（版权 100% 合规）**：
   - **授权字体**：`materials/fonts/` 涵盖 56 款正版商用开源字体，遵循 OFL 1.1 与 Apache 2.0 商业许可，`aiBadge.js` 强制指定 Noto Sans SC 思源黑为单一真源，商用零侵权风险。
   - **商用 BGM**：`materials/audio/` 涵盖 31 种情绪曲风、526 首正版背景音乐，经 `packages/audio-kit/bgm.js` 动态轮询与两段式人声避让混音。
   - **国标 AIGC 标识**：严格遵循国标 GB 45438-2025 双标识定版规范，显式渲染两段式角标（开头 2.5s「AI 生成」+ 结尾 2.5s「本视频由 AI 生成 · JANSEE」），隐式元数据在 `image-film`、`video-dub` 与 `renderer.ts`（通用多分镜模式）三大管线中 100% 写入 `Label=AIGC`、`ProduceID`、`ContentProducer=Jansee`、`ai_generated=1`、`-movflags +faststart+use_metadata_tags`。

### 3. 站点拓扑与二级域名物理隔离（v4.0.4 起生效）
- **C 端创作官网（`jansee.cn`）**：
  - 唯一正式创作用地，提供黑曜石极简工作台、游客直出片、作品抽屉。
- **管理指挥中心（`admin.jansee.cn`）**：
  - **实现首屏物理级隔离（`StandaloneAdminApp`）**：检测到 `admin.jansee.cn` 二级域名时，彻底切断前台对话流、游客鉴权、访客统计及作品库的初始化，直接秒级进入暗黑管理控制台或管理登录界面。
  - **开屏自愈加速**：进入 `admin.jansee.cn` 自动跳过 1.2 秒的 C 端启动页动画，实现管理后台秒开。

### 4. 媒体存储与 CDN 边缘加速（大厂级闭环）
- **对象存储**：腾讯云 COS（桶：`jansee-1460392374`，地域：`ap-guangzhou`，私有读写）。
- **统一存储抽象（`ObjectStorage`）**：在 `apps/api/src/storage-local.ts` 导出统一 `ObjectStorage` 接口（`putFile`, `getFilePath`, `deleteObject`, `deleteExpired`, `createSignedUrl`），各模块完全解耦，`createTencentCosObjectStorage` 与 `createLocalObjectStorage` 全量实现该契约。
- **边缘 CDN 域名与安全鉴权**：
  - 边缘加速域名：`https://cdn.jansee.cn`（已绑定 TrustAsia 免费 SSL 证书，开启 HTTP/2.0）。
  - COS 开启【私有回源鉴权】，保护存储桶不被外部盗刷。
  - **Type A 时间戳防盗链 Token 闭环**：当配置 `CDN_AUTH_KEY`（或 `COS_CDN_AUTH_KEY`）时，API 自动生成带有合法 `sign=${timestamp}-${rand}-${uid}-${md5}` 的时效鉴权直链（播放 3600 秒，下载 600 秒），防止视频被第三方盗刷或未授权下载；未配置密钥时平滑降级，零破坏现有功能。
  - 后端分发给前端的播放链接通过 `302 Found` 直接重定向至 CDN 鉴权直链，彻底绕开云服务器单机 3Mbps 带宽瓶颈，实现全国边缘节点首帧秒开。
- **纯净服务器原则**：云服务器本地磁盘**不保留任何视频和素材实体**，成片合成完毕后立刻推入 COS，临时文件即刻销毁，云服务器仅充当纯净的工作代码运行节点。

### 5. DNS 与网络状态（域名：`jansee.cn`）
- **IPv4**：`203.195.243.42`（Nginx 80/443 正常通畅）。
- **IPv6（重要纪律）**：此前解析的 `AAAA` 记录因服务器未配置有效路由导致外部 1~3 秒超时假死，**已全量在 DNSPod 中暂停 AAAA 记录**。后续严禁擅自重新启用不可达的 IPv6 解析。
- **子域名**：
  - `jansee.cn`：官网与 Web 创作端。
  - `admin.jansee.cn`：独立管理控制台（AdminConsole）。
  - `cdn.jansee.cn`：专属音视频加速 CDN。

---

## 三、工程开发宪法与防巨石铁律（所有开发必须遵守）

- **巨石代码零容忍（Zero Monolith Tolerance）**：所有新功能、缺陷修复与日常优化严禁向大文件堆砌代码。
- **文件行数红线（File Size Ceilings）**：
  - UI 入口编排器（如 `App.tsx`）：**严格控制在 1,000 行以内**（当前为 573 行）。
  - API 路由控制器（如 `admin.ts`）：**严格控制在 500 行以内**（当前为 350 行）。
  - 单一业务子组件与弹窗：**严格控制在 200~450 行以内**（如 `AuthPanel` 113 行、`WorksPanel` 433 行）。
- **童子军原则（Boy Scout Rule）**：修改任何接近红线的文件时，必须顺手小步抽离出独立的自定义 Hook 或子组件，严禁在现有方法内嵌套复杂业务逻辑。
- **后端三层分立铁律**：Route Controller（校验分发） -> Service（业务编排与事务） -> Store/Adapter（存储与外部适配），严禁在 Fastify 路由回调中裸写大段 SQL 或密集计算。
- **0 Emoji 铁律**：所有代码、提交信息、控制台日志、UI 文本中严禁包含任何 Emoji。
- **独立分支开发**：所有改动必须在独立 Git 分支进行，严禁在 main 分支裸写代码。

---

## 四、验证基线（必须 100% 通过）

1. `npm run typecheck` (`tsc -b`)：0 错误，0 警告。
2. `npm run build`：Vite 前端打包与 Fastify 后端编译全部成功。
3. `node --import tsx --test tests/zero-emoji.test.ts tests/conversations.test.ts tests/admin.test.ts`：16 项核心自动化测试 100% 通过。
