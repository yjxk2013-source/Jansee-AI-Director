# 简兮 (JANSEE) — AI 智能导演系统 (AI Director System)
### 生产级微服务 Monorepo 架构与工程规范白皮书 (Production Architecture Showcase)

[![License: Proprietary Evaluation](https://img.shields.io/badge/License-Proprietary_Source--Available-red.svg)](LICENSE)
[![Engine: Node 22 ESM](https://img.shields.io/badge/Node-v22.x_ESM-blue.svg)](package.json)
[![Architecture: Monorepo](https://img.shields.io/badge/Architecture-Clean_Monorepo-emerald.svg)](packages/)
[![Status: Production](https://img.shields.io/badge/Status-Live_in_Production-gold.svg)](https://jansee.cn)
[![CI Gate](https://github.com/yjxk2013-source/Jansee-AI-Director/actions/workflows/ci.yml/badge.svg)](https://github.com/yjxk2013-source/Jansee-AI-Director/actions/workflows/ci.yml)

> **重要声明**：本仓库为**简兮 (JANSEE) 商业级真实开发源代码与系统架构展示仓**。所有目录、状态机、多任务编排与音视频渲染流水线均来自团队一手生产工程，用于展示团队深厚的全栈工程研发实力与 AI 系统调度深度。  
> **商业授权限制**：本项目受严格的 [商业受限展示许可证 (FSL)](LICENSE) 保护，严禁未经授权的商业化部署、分发或竞品抄袭。

---

## 一、 系统定位与工程哲学

### 官方品牌 IP：简小兮
简小兮（昵称“小兮”）是 AI 智能导演系统「简兮·JANSEE」官方打造的数字品牌 IP 形象，设定为一只生活在四川成都微缩世界、头戴印有 JANSEE 字样红头巾、身穿深蓝牛仔工装围裙的学徒大熊猫，代表栏目为《简小兮学徒记》。

简兮（JANSEE）不是多轨时间线剪辑工具，也不是死板的视频模板市场，而是**端到端自主决策的 AI 智能导演系统（AI Director System）**。

```
┌────────────────────────────────────────────────────────────────────────┐
│                        简兮 (JANSEE) 生产架构全景                       │
└────────────────────────────────────────────────────────────────────────┘
                                 │
         ┌───────────────────────┴───────────────────────┐
         ▼                                               ▼
┌──────────────────┐                           ┌──────────────────┐
│  PC / 移动双端响应 │                           │   独立管理指挥中心  │
│  (jansee.cn)     │                           │ (admin.jansee.cn)│
└────────┬─────────┘                           └────────┬─────────┘
         │                                              │
         └───────────────────────┬──────────────────────┘
                                 ▼
         ┌───────────────────────────────────────────────┐
         │ Fastify 高性能 API 网关 + 状态机编排引擎 (Node 22)│
         └───────────────────────┬───────────────────────┘
                                 │
     ┌───────────────────────────┼───────────────────────────┐
     ▼                           ▼                           ▼
┌──────────────────┐   ┌───────────────────┐   ┌──────────────────┐
│ AI 导演调度中枢   │   │ 高并发渲染流水线   │   │ 大厂级媒资与 CDN  │
│ (LLM & Prompt)   │   │ (FFmpeg Kit / 混音)│   │ (COS 私有回源加速)│
└──────────────────┘   └───────────────────┘   └──────────────────┘
```

### 1. 核心工程原则
- **对话即创作**：基于 Gemini 风格极简黑曜石体验，将复杂的参数配置收敛于直觉式自然语言交互。
- **纯粹的领域边界**：UI 表现层、网关协议层、业务领域层（Domain）与音视频底层二进制完全解耦。
- **纯净服务器设计**：宿主云服务器仅作工作调度流转，视频合成即刻直推对象存储（COS），临时媒资即刻销毁，单机零积压。
- **大厂级 CDN 边缘直出**：私有回源鉴权 + 全链路 302 重定向至边缘 CDN，全国首帧秒开。

---

## 二、 核心创作引擎矩阵

系统在底层将三条核心引擎封装为高度确定性、可测试的高内聚渲染包：

| 引擎模块 | 领域职责 | 关键工程突破 |
| :--- | :--- | :--- |
| **`packages/image-film`** | 图片成片引擎 | 1~9 张静态商品/场景图，AI 规划转场叠化、运镜（Ken Burns）、TTS 旁白与商用 BGM 合成 |
| **`packages/video-dub`** | 视频配音重制 | 语音识别、智能断句去拟声词、配音重构、多轨混音与发丝级发音对齐字幕 |
| **`packages/ffmpeg-kit`** | 底层视频流水线 | 强制 `-movflags +faststart`，工业级滤镜图拼接，硬件加速与流式输出 |

---

## 三、 Monorepo 模块治理与代码组织

```
apps/
  web/          黑曜石设计规范客户端 (React + Vite + Tailwind，PC/移动端 100% 能力对齐)
  api/          HTTP 协议边界、鉴权安全、AI 导演调度与任务编排引擎 (Fastify + TS)
packages/
  contracts/    全端共享的 API 强类型契约与 Schema 校验
  domain/       纯净领域模型与商业状态机规则 (零外部 HTTP/UI 依赖)
  image-film/   图片转短视频渲染核心
  video-dub/    原片人声剥离、智能配音与发丝级字幕对齐
  ffmpeg-kit/   FFmpeg 复杂滤镜生成器与音视频封装套件
deploy/
  生产 Docker Compose 多阶段构建、Nginx 反代安全规则与部署拓扑
```

---


---

## 四、 极致克制的设计哲学与安全审计体系

### 1. 极致克制的设计系统 (Obsidian Design System)
- **0 Emoji 工业级视觉铁律**：全站拒绝任何彩色 Emoji 装饰，所有图标均采用发丝级微光矢量 SVG，并由自动化单测门禁强制校验。
- **PC / 移动双端 100% 能力平权**：PC 端与移动端共享同一套领域契约与核心创作链路，仅针对屏幕尺寸做响应式人机工程适配，绝不阉割移动端核心能力。
- **去巨石化工程纪律 (Anti-Monolith)**：严格执行三层架构分离（Controller → Service → Store/Adapter），严控单文件体量上限，杜绝面条代码。

### 2. 生产级安全审计与容灾防线
| 安全维度 | 工程落地实现 |
| :--- | :--- |
| **Fail-closed 安全契约** | 关键存储与鉴权配置缺失时直接拒绝启动，绝不静默降级为不安全默认值 |
| **多租户越权隔离** | 在 Service 与持久化层双重校验租户归属，不仅依赖前端 UI 隐藏 |
| **CDN Type A 防盗链** | 腾讯云 COS 私有回源鉴权 + 边缘 CDN Type A 时效签名，防盗刷与防泄露 |
| **零凭证入库红线** | 生产密钥全部通过环境变量注入，日志自动脱敏，严禁明文 Token 入库 |
| **异步任务全生命周期** | 具备幂等键、超时控制、取消策略与失败自动退费/状态回滚机制 |

---

## 五、 自动化测试与质量门禁矩阵

本项目通过多维度自动化门禁保障每次交付的确定性：
- **严格类型门禁 (
pm run typecheck)**：全仓 TypeScript 严格模式静态类型检查。
- **架构独立性门禁 (
pm run check:independence)**：自动扫描并阻断任何跨代际耦合或非法依赖引入。
- **核心链路测试 (
pm test)**：覆盖 AI 导演规划契约校验、任务状态机流转、语音转写生命周期、媒体渲染管线及 0 Emoji 视觉门禁。
---

## 六、 商业授权与合作

简兮技术团队支持面向企业级客户的**私有化部署、行业定制化模型中枢适配与商业源码交付**。

- **官方体验站点**：[https://jansee.cn](https://jansee.cn)
- **企业合作与商务授权**：`contact@jansee.cn` / `admin@jansee.cn`
- **商业许可正文**：详见本仓库 [LICENSE](LICENSE) 文件

---

## 五、 团队协作与工程治理 (Team Governance & Contributors)

简兮（JANSEE）采用分布式专业团队协同研发模式，由多领域工程师共同维护核心系统的高可用与持续演进。  
关于团队成员名册、核心模块责任人与协作准则，详见 [AUTHORS.md](AUTHORS.md)。

- **系统产品架构与商业化**：YJXK Team (yjxk2013-source)
- **云原生部署与工程协同**：yjxk2026-bit
- **核心架构与后端系统**：JANSEE Architecture Lab (dmin@jansee.cn)
- **视觉系统与交互工程**：JANSEE Visual Design Group (design@jansee.cn)
- **音视频渲染引擎实验室**：JANSEE Video Engine Lab (engine@jansee.cn)
