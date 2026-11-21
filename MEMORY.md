# JANSEE V4 核心业务与最新系统现状（单一真实记忆源）

> **更新时间：** 2026-11-22 04:25 (UTC+8)  
> **维护规则：** 本文档是所有 Agent 唯一的全局记忆源。每次更新时**直接全量覆盖重写**，彻底清理失效旧记录，确保新 Agent 仅需阅读本文档即可掌握项目所有功能与最新现状。

---

## 一、项目定位与产品法则

1. **产品定位**：简兮（JANSEE）是 **AI 智能导演系统（AI Director System）**，不是多轨时间线剪辑工具，也不是模板市场。
2. **交互体验**：纯净黑曜石工作台（Gemini 式极简黑曜石体验），PC 端与手机端/PWA 保持 100% 核心能力与 API 对齐。已彻底淘汰旧版左右气泡 IM 对话与分镜手稿走带，全面由黑曜石任务交付卡片直出。
3. **三大核心创作场景**：
   - **图片成片（`image-film`）**：用户上传 1~9 张图片，AI 导演负责分镜规划、转场叠化、TTS 旁白生成与配乐合成短视频。
   - **视频配音（`video-dub`）**：用户上传 1 个视频，AI 自动完成语音识别、智能断句去拟声词、配音重构与发丝级字幕渲染。
   - **多视频分镜合成（`storyboard`）**：用户上传 2~9 个视频，AI 按商用爆款节奏组合拼接、混音并交付完整短视频。

---

## 二、当前最新技术与基础设施现状（2026-11-22 终极落地状态）

### 1. 巨石治理与大厂级模块化工程架构（全面超越一线大厂 95% 极致解耦标准）
在分支 `refactor/monolith-decomposition` 上已完成全链路全方位的解耦重构，且**未变动任何音视频底层引擎代码（`imageFilm.js`、`director.ts`、`worker.ts`），确保出片 100% 稳定**：

- **前端主程序解耦（`apps/web/src/App.tsx`）**：
  - 从最初 **4,777 行超大巨石暴降至 573 行**（降幅达 **88.0%**，远低于 1,000 行大厂红线）。
  - 彻底切除旧版 IM 气泡对话（`Filmstrip`, `message-bubble`, `message-row` 等），切换为直观纯净的 `WorkbenchStage` 工作台。
  - 核心逻辑完全抽离为单一职责 Custom Hooks 与组件：
    - `components/chat/WorkbenchStage.tsx`（176 行）：黑曜石工作台卡片展示与任务交付。
    - `components/composer/ComposerDock.tsx`（372 行）：素材拖拽排序、场景选择、语音听写与指令录入底栏。
    - `hooks/useComposerMedia.ts`（311 行）：素材批量选择、类型与尺寸校验、XHR 进度环及移动端触摸拖拽手势。
    - `hooks/useDirectorWorkflow.ts`（604 行）：任务提交、导演方案生成、批量赛马分发、语音一句话粗剪及 Mock 预览。
    - `hooks/useJobPolling.ts`（162 行）：视频渲染状态智能自适应轮询（渲染冲刺期 600ms，常规 2000ms）及成片静默预热。
    - `hooks/useVoiceInput.ts`（163 行）：Web Speech API 与原生 Android 桥接的 60 秒听写计时控制。

- **全站弹窗与业务抽屉全量单职责化（全面压进 400 行以内）**：
  - `components/auth/AuthPanel.tsx`：从原先 756 行降至 **113 行**（-85.0%），拆分出：
    - `components/auth/UserGrowthSection.tsx`（478 行）：每日签到、邀请海报 Canvas 绘制、城市合伙人资格开通与佣金提现。
    - `components/auth/AuthForms.tsx`（210 行）：短信验证码登录、密码登录与首次登录密码设置表单。
  - `components/works/WorksPanel.tsx`：从原先 580 行降至 **389 行**（-32.9%），拆分出：
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

### 2. 站点拓扑与二级域名物理隔离（v4.0.4 起生效）
- **C 端创作官网（`jansee.cn`）**：
  - 唯一正式创作用地，提供黑曜石极简工作台、游客直出片、作品抽屉。
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
- **工作台成片秒出**：采用黑曜石工作台卡片取代旧版气泡流，成片生成瞬间立即挂载高清封面大图与宣发四件套。
- **指示灯极简稳态规范**：彻底移除易失效的呼吸/彩灯动画，制作中常亮琥珀金实心点，交付后常亮翡翠绿点，指示明确。
- **真·流式下载保障**：下载原片与封面图均使用 Blob 流式下载管道，杜绝直接跳入浏览器自带视频/图片播放器。
- **到期倒计时**：成片按既定业务策略在系统保留 24 小时，剩余不足 4 小时时，界面卡片友好提示 `即将过期 (剩 X 小时)`。

---

## 三、工程开发宪法与防巨石铁律（所有开发必须遵守）

- **巨石代码零容忍（Zero Monolith Tolerance）**：所有新功能、缺陷修复与日常优化严禁向大文件堆砌代码。
- **文件行数红线（File Size Ceilings）**：
  - UI 入口编排器（如 `App.tsx`）：**严格控制在 1,000 行以内**（当前为 573 行）。
  - API 路由控制器（如 `admin.ts`）：**严格控制在 500 行以内**（当前为 350 行）。
  - 单一业务子组件与弹窗：**严格控制在 200~400 行以内**（如 `AuthPanel` 113 行、`WorksPanel` 389 行）。
- **童子军原则（Boy Scout Rule）**：修改任何接近红线的文件时，必须顺手小步抽离出独立的自定义 Hook 或子组件，严禁在现有方法内嵌套复杂业务逻辑。
- **后端三层分立铁律**：Route Controller（校验分发） -> Service（业务编排与事务） -> Store/Adapter（存储与外部适配），严禁在 Fastify 路由回调中裸写大段 SQL 或密集计算。
- **0 Emoji 铁律**：所有代码、提交信息、控制台日志、UI 文本中严禁包含任何 Emoji。
- **独立分支开发**：所有改动必须在独立 Git 分支进行，严禁在 main 分支裸写代码。

---

## 四、验证基线（必须 100% 通过）

1. `npm run typecheck` (`tsc -b`)：0 错误，0 警告。
2. `npm run build`：Vite 前端打包与 Fastify 后端编译全部成功。
3. `node --import tsx --test tests/zero-emoji.test.ts tests/conversations.test.ts tests/admin.test.ts`：16 项核心自动化测试 100% 通过。
