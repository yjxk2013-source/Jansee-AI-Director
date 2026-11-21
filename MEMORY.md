# JANSEE V4 核心业务与最新系统现状（单一真实记忆源）

> **更新时间：** 2026-11-22 03:05 (UTC+8)  
> **维护规则：** 本文档是所有 Agent 唯一的全局记忆源。每次更新时**直接全量覆盖重写**，彻底清理失效旧记录，确保新 Agent 仅需阅读本文档即可掌握项目所有功能与最新现状。

---

## 一、项目定位与产品法则

1. **产品定位**：简兮（JANSEE）是 **AI 智能导演系统（AI Director System）**，不是多轨时间线剪辑工具，也不是模板市场。
2. **交互体验**：对话即创作（Gemini 式极简黑曜石体验），PC 端与手机端/PWA 保持 100% 核心能力与 API 对齐。
3. **三大核心创作场景**：
   - **图片成片（`image-film`）**：用户上传 1~9 张图片，AI 导演负责分镜规划、转场叠化、TTS 旁白生成与配乐合成短视频。
   - **视频配音（`video-dub`）**：用户上传 1 个视频，AI 自动完成语音识别、智能断句去拟声词、配音重构与发丝级字幕渲染。
   - **多视频分镜合成（`storyboard`）**：用户上传 2~9 个视频，AI 按商用爆款节奏组合拼接、混音并交付完整短视频。

---

## 二、当前最新技术与基础设施现状（2026-11-22 终极落地状态）

### 1. 巨石治理与大厂级模块化工程架构（全面达标一线大厂 85%~90% 解耦标准）
在分支 `refactor/monolith-decomposition` 上已完成全链路四大批次的解耦重构，且**未变动任何音视频底层引擎代码（`imageFilm.js`、`director.ts`、`worker.ts`），确保出片 100% 稳定**：

- **第一批次：管理控制台解耦（`apps/web/src/AdminConsole.tsx`）**：
  - 从原先 1,480 行削减至 790 行轻量调度容器（减少 47%）。
  - 7 大 Tab 及核心指标条全面拆分为独立子模块（位于 `apps/web/src/components/admin/tabs/`）：
    - `AdminOverviewTab.tsx`：经营概览与 30 天增长多维曲线。
    - `AdminUsersTab.tsx`：注册用户名册、地域分布及手机号搜索。
    - `AdminServerTab.tsx`：服务器 CPU/内存/磁盘 15s 动效采样及底层依赖检测。
    - `AdminDirectorJobsTab.tsx`：导演交付效能与失败任务补偿。
    - `AdminPartnerFinanceTab.tsx`：城市合伙人佣金账单及人工打款复核。
    - `AdminPricingTab.tsx`：OPCPAY 价格读取与展示原价修改。
    - `AdminInboxTab.tsx`：用户来信回复与全站公告发布。
    - `AdminMetricStrip.tsx`：控制台头部核心指标快速浏览条。
    - `types/admin.ts`：控制台全量数据模型类型。

- **第二与第三批次：前端主程序解耦（`apps/web/src/App.tsx`）**：
  - 从原先 4,777 行超大巨石暴降至 1,987 行（削减 **58.4%**）。
  - 外围弹窗、数据面板与业务工具全面独立：
    - `components/chat/ChatHeader.tsx`：顶栏品牌标与用户/登录快捷入口。
    - `components/composer/ScenePicker.tsx`：带货视频、门店获客、个人创作、一句话剪辑等创作场景切换器。
    - `components/chat/SidebarDrawer.tsx`：左侧导航抽屉与最近作品快捷查看条。
    - `components/chat/JobDeliveryCard.tsx`：失败恢复提示、成片视频交付播放与宣发四件套展示。
    - `components/modals/HeaderModalContainer.tsx`：全站弹层容器（整合作品库、充值、订单、账本、站内信、安装指引、管理入口）。
    - `components/auth/AuthPanel.tsx`：用户登录、注册、短信验证码、个人信息修改抽屉。
    - `components/works/WorksPanel.tsx`：作品库、成片播放、下载管理、宣发四件套展示。
    - `components/billing/BillingHistoryPanel.tsx`：订单历史与积分流水对账。
    - `components/billing/RechargePanel.tsx`：算力充值、会员方案、加油包直购。
    - `components/admin/AdminLoginPanel.tsx` & `StandaloneAdminApp.tsx`：管理员登录面板与独立后台挂载器。
    - `components/modals/SiteInboxPanel.tsx` & `InstallAppPanel.tsx`：站内信及 PWA/APK 安装指引。
    - `components/video/JobDeliveryVideoPlayer.tsx`：具备可视区离开自动暂停特性的成片播放器。
    - `utils/conversationStorage.ts` & `utils/clientPlatform.ts`：本地持久化对话存储与平台辅助方法。
    - `types/client.ts`：客户端数据协议接口集中规范。

- **第四批次：后端管理接口架构解耦（`apps/api/src/admin.ts`）**：
  - 代码量从 1,232 行巨石削减至 500 行左右纯净的 API 路由调度层（Controller 层）。
  - 三大业务逻辑微服务下沉拆解至 `apps/api/src/services/`：
    - `admin-metrics.ts`：底层 CPU、内存、存储与 FFmpeg 性能指标采样服务。
    - `admin-partner-service.ts`：城市合伙人列表、提现审核、打款登记、收款账户解密及审计事件事务服务。
    - `admin-stats-service.ts`：大盘概览多维 SQL 聚合、用户增长与作业效能洞察计算服务。

### 2. 站点拓扑与二级域名物理隔离（v4.0.4 起生效）
- **C 端创作官网（`jansee.cn`）**：
  - 唯一正式创作用地，提供黑曜石极简对话创作流、游客直出片、作品抽屉。
- **管理指挥中心（`admin.jansee.cn`）**：
  - **实现首屏物理级隔离（`StandaloneAdminApp`）**：检测到 `admin.jansee.cn` 二级域名时，彻底切断前台对话流、游客鉴权、访客统计及作品库的初始化，直接秒级进入暗黑管理控制台或管理登录界面。
  - **开屏自愈加速**：进入 `admin.jansee.cn` 自动跳过 1.2 秒的 C 端启动页动画，实现管理后台秒开。

### 3. 媒体存储与 CDN 边缘加速（大厂级闭环）
- **对象存储**：腾讯云 COS（桶：`jansee-1460392374`，地域：`ap-guangzhou`，私有读写）。
- **边缘 CDN 域名**：`https://cdn.jansee.cn`（已绑定 TrustAsia 免费 SSL 证书，开启 HTTP/2.0）。
- **鉴权与回源架构**：
  - COS 开启了【私有回源鉴权】，保护存储桶不被外部盗刷。
  - CDN 开启了【全部忽略 URL 参数缓存】与【忽略大小写】，缓存时间设为 30 天。
  - 后端分发给前端的播放链接通过 `302 Found` 直接重定向至 `https://cdn.jansee.cn/users/.../output.mp4`，彻底绕开云服务器单机 3Mbps 带宽瓶颈，实现全国边缘节点首帧秒开。
- **纯净服务器原则**：云服务器本地磁盘**不保留任何视频和素材实体**，成片合成完毕后立刻推入 COS，临时文件即刻销毁，云服务器仅充当纯净的工作代码运行节点。

### 4. DNS 与网络状态（域名：`jansee.cn`）
- **IPv4**：`203.195.243.42`（Nginx 80/443 正常通畅）。
- **IPv6（重要纪律）**：此前解析的 `AAAA` 记录因服务器未配置有效路由导致外部 1~3 秒超时假死，**已全量在 DNSPod 中暂停 AAAA 记录**。后续严禁擅自重新启用不可达的 IPv6 解析。
- **子域名**：
  - `jansee.cn`：官网与 Web 创作端。
  - `admin.jansee.cn`：独立管理控制台（AdminConsole）。
  - `cdn.jansee.cn`：专属音视频加速 CDN。

### 5. 用户体验（UX）最新细节
- **方案封面 100% 完整展示**：工作台与作品库的封面展示强制采用 `object-fit: contain` + 纯黑底衬，杜绝裁切，确保封面标题与商业构图全量露出。
- **指示灯极简稳态规范**：彻底移除易失效的呼吸/彩灯动画，制作中常亮琥珀金实心点，交付后常亮翡翠绿点，指示明确。
- **真·流式下载保障**：下载原片与封面图均使用 Blob 流式下载管道，杜绝直接跳入浏览器自带视频/图片播放器。
- **播放器黑屏消除**：交付流中的 `<video>` 默认挂载 `poster={"/api/v1/works/" + id + "/cover"}`，成片生成瞬间立即呈现高清精美封面大图。
- **到期倒计时**：成片按既定业务策略在系统保留 24 小时，剩余不足 4 小时时，界面卡片友好提示 `即将过期 (剩 X 小时)`。

---

## 三、仓库模块与部署拓扑

### 1. Monorepo 目录划分
- `apps/web`：React + Vite 客户端，纯前端构建产物输出到 `dist/`，由宿主或 Nginx 容器提供托管。
- `apps/api`：Fastify + TypeScript 后端，调度任务、管理鉴权（Session+手机验证码）、处理计费与媒资。
- `packages/contracts`：API 协议、请求响应类型定义。
- `packages/domain`：核心领域模型与常数。
- `packages/image-film`：图片成片核心渲染管道。
- `packages/video-dub`：视频配音重制核心引擎。
- `packages/ffmpeg-kit`：底层 FFmpeg 转码命令生成器（已强制 `-movflags +faststart`）。

### 2. 服务器部署拓扑（生产环境：`203.195.243.42`）
- 部署根路径：`/srv/jansee-v4/`
- Docker Compose 配置文件：`/srv/jansee-v4/deploy/docker-compose.v4.yml`
- 容器集群：
  - `deploy-postgres-1`：PostgreSQL 16 数据库。
  - `deploy-api-1`：Node 22 API 容器（端口 4100）。
  - `deploy-web-1`：Nginx 静态 Web 容器（宿主 8080）。
- 部署指令规范：
  ```bash
  cd /srv/jansee-v4/deploy
  docker compose -f docker-compose.v4.yml down
  docker compose -f docker-compose.v4.yml build --no-cache api web
  docker compose -f docker-compose.v4.yml up -d
  ```

---

## 四、验证卡点与工程铁律

1. **0 Emoji 铁律**：所有代码、提交信息、控制台日志中严禁包含任何 Emoji 表情。
2. **纯净出片保护**：绝对禁止直接修改音视频合成核心（`imageFilm.js`、`director.ts` 等），确保出片流程不受任何重构冲击。
3. **全流程回归卡点**：
   - `npm run typecheck`（`tsc -b`）：全量 0 错误。
   - `npm run build`：Monorepo 全量编译构建（Vite + API）0 错误通过。
   - `node --import tsx --test tests/zero-emoji.test.ts tests/conversations.test.ts tests/admin.test.ts`：16 项测试全部通过（15 pass, 1 skip, 0 fail）。
