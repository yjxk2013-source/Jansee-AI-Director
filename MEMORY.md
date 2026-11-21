# JANSEE V4 核心业务与最新系统现状（单一真实记忆源）

> **更新时间：** 2026-11-21 22:45 (UTC+8)  
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

## 二、当前最新技术与基础设施现状（2026-11-21 终极落地状态）

### 1. 媒体存储与 CDN 边缘加速（大厂级闭环）
- **对象存储**：腾讯云 COS（桶：`jansee-1460392374`，地域：`ap-guangzhou`，私有读写）。
- **边缘 CDN 域名**：`https://cdn.jansee.cn`（已绑定 TrustAsia 免费 SSL 证书，开启 HTTP/2.0）。
- **鉴权与回源架构**：
  - COS 开启了【私有回源鉴权】，保护存储桶不被外部盗刷。
  - CDN 开启了【全部忽略 URL 参数缓存】与【忽略大小写】，缓存时间设为 30 天。
  - 后端分发给前端的播放链接通过 `302 Found` 直接重定向至 `https://cdn.jansee.cn/users/.../output.mp4`，彻底绕开云服务器单机 3Mbps 带宽瓶颈，实现全国边缘节点首帧秒开。
- **纯净服务器原则**：云服务器本地磁盘**不保留任何视频和素材实体**，成片合成完毕后立刻推入 COS，临时文件即刻销毁，云服务器仅充当纯净的工作代码运行节点。

### 2. DNS 与网络状态（域名：`jansee.cn`）
- **IPv4**：`203.195.243.42`（Nginx 80/443 正常通畅）。
- **IPv6（重要纪律）**：此前解析的 `AAAA` 记录因服务器未配置有效路由导致外部 1~3 秒超时假死，**已全量在 DNSPod 中暂停 AAAA 记录**。后续严禁擅自重新启用不可达的 IPv6 解析。
- **子域名**：
  - `jansee.cn`：官网与 Web 创作端。
  - `admin.jansee.cn`：管理控制台（AdminConsole）。
  - `cdn.jansee.cn`：专属音视频加速 CDN。

### 3. 用户体验（UX）最新细节
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
  sudo docker compose --env-file /srv/jansee-v4/.env -f docker-compose.v4.yml build api web
  sudo docker compose --env-file /srv/jansee-v4/.env -f docker-compose.v4.yml up -d --no-deps api web
  ```

---

## 四、接任 Agent 铁律纪律（必须严格执行）

1. **严禁裸写 main 分支**：接取任何新任务时，必须从 `main` 检出独立的 `feat/*` 或 `fix/*` 分支进行开发验证，合并前必须走测试和 build。
2. **严禁在服务器存留媒资**：所有生成成果必须推向腾讯云 COS，保持服务器硬盘干净轻量。
3. **保持纯净对话式界面**：严禁随意增加复杂多轨时间线或重度桌面剪辑软件 UI，必须遵循《JANSEE 设计系统》的极简黑曜石风格。
4. **记忆更新铁律**：每次完成重大功能、修复或基础设施变更时，**必须全量重写更新本文件**，剔除过期无效信息。
