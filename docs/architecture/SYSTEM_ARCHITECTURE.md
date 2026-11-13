# 简兮 (JANSEE) · 系统全景架构设计文档 (System Architecture)

> **文档密级**：内部技术架构标准  
> **设计哲学**：高内聚低耦合 · 关注点分离 · 引擎无业务逻辑 · 纯粹黑白灰极致美学  
> **适用版本**：v3.0 Enterprise

---

## 一、分层架构模型 (Layered Architecture)

简兮系统采用分层演进的现代 Monorepo 体系，主要分为以下 4 个层次：

### 1. 终端应用层 (Application Layer - `apps/`)
* **`apps/web` (官方门户与工作台)**：
  - `client/`：高保真响应式 Web 工作台，面向最终用户（电商卖家、实体老板、主播、创作者），实现“极简三步出片”；
  - `server/`：BFF（Backend For Frontend）层，负责会话管理、三方支付鉴权、与大模型通信输出分镜剧本 JSON。
* **`apps/admin` (管理控制台)**：
  - 支撑运营、财务与运维人员，提供用户全生命周期管理、交易流水审计、AI 算力成本监控、全量素材库维护。
* **共享能力层 `packages/` (媒体合成能力包)**：
  - `tts-kit`（腾讯云 TTS 配音，Edge-TTS 已移除 2026-10-12）、`audio-kit`（BGM 选曲与音效时间轴）、`subtitle-kit`（字幕烧录与 AIGC 合规标识）、`cover-kit`（片头视觉层与背景分析）、`ffmpeg-kit`（Ken Burns 运镜与 FFmpeg 合成器），解耦一切上层商业逻辑，仅提供纯合成能力；
* **冻结模块 `modules/image_creator` (图片成片黑盒)**：
  - 仅接收结构化任务指令（分镜台词、时长、运镜参数、图片路径、visual_design 视觉设计与 sfx 音效契约），编排上述共享能力完成图片成片，对外仅暴露 `createTask` / `getTask` / `preanalyzeAssets` 三接口（协议版本 image_creator_v1）；`modules/video_creator` 为视频成片未来能力预留。
* **`apps/mobile` (移动端容器)**：
  - 封装移动应用外壳，支持手机拍摄即传、原画质视频预览与本地相册极速保存。

### 2. 领域服务与基础设施层 (Domain & Foundation Layer)
* **大模型编排层 (LLM Orchestrator)**：
  - 维护商家人设提示词、宪法导演规范，将用户简短输入转化为标准分镜剧本（Prompt Engine）；
* **异步任务状态机 (Task Runner & State Machine)**：
  - 统一管理所有生成任务生命周期：`pending` → `processing` → `completed` / `failed`；
  - 校验成片音频流完整性与最终画质。

### 3. 多模态资产与素材中台 (Materials Center - `materials/`)
* 集中纳管三类点触音效库（`audio/{intro_sfx, transition_sfx, outro_sfx}`）与 BGM 情绪曲库；
* 维护 `index.json` 全局倒排索引标签，为大模型自动配乐提供毫秒级检索。

### 4. 共享库层 (Shared Packages - `packages/`)
* **`packages/design-system`**：黑曜石核心调色板、发丝幽灵线框样式、微动效曲线；
* **`packages/shared`**：前后端统一错误码定义、API 响应信封格式、工具函数库。

---

## 二、核心端到端数据流向 (End-to-End Data Flow)

### 1. 极简商品成片链路 (Product-to-Video Pipeline)
```
[用户浏览器]
   │  1. 上传最多 9 张商品图 + 必填卖点
   ▼
[apps/web/server]
   │  2. 扣除 10 点数配额，生成 task_id
   │  3. 导演层产出分镜剧本 JSON
   │     （含 transition / visual_design / sfx 契约字段）
   ▼
[packages/ffmpeg-kit/composer]
   │  4. 遍历剧本：
   │     ├─ TTS 生成各分镜配音音频
   │     ├─ 计算精确分镜时长，应用 Ken Burns 运镜推拉
   │     ├─ 片头视觉层（visual_design）+ 三类点触音效
   │     └─ FFmpeg 管道混音、单行字幕、末尾 1.5s 淡出
   ▼
[storage/outputs/{task_id}/final.mp4]
   │  5. 产出成片并返回下载链接
   ▼
[监视器预览与下载]
```

---

## 三、大厂架构演进原则 (Evolution Rules)
1. **单一事实源 (Single Source of Truth)**：任何业务配置与路径均从配置模块中读取，杜绝硬编码；
2. **幂等性保障**：支付、扣费、出片任务具备唯一流水号，避免因网络抖动引起重复扣点；
3. **零 Emoji 与极致一致性**：无论前台还是后台管理，严格遵照简兮黑曜石设计规范。

---

## 四、V2 定版铁律 (2026-10，用户验收后落盘)

以下铁律已写入宪法正典（`apps/web/server/prompt/constitution.md`）与各引擎子规范，
任何 Agent 改动图片成片链路前必须遵守，与旧版行为冲突时**一律以 V2 为准**：

1. **禁调色**：主画面素材原色直出，严禁 eq/vignette/curves/lut（旧版 ENHANCE 急救包已废除，严禁复挂）；
2. **主标题单行**：严禁拆行，单行缩号最多 4 档；导演侧标题建议 ≤10 字；
3. **每图一镜**：N 张实拍图 = N 个图片镜，每图必现；
4. **字幕单行轮播**：任意时刻仅一行字幕，长台词按时间均分轮播。

> 版块边界：图片成片是唯一走 V2 链路的版块；口播原声 / 切片分镜仍保留各自 BGM 与原有管线，严禁互相混用。
