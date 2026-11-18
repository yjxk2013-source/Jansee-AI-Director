# JANSEE Core Team & Contributors (简兮核心团队与贡献者名册)

JANSEE V4 是一个由分布式专业团队协同研发的新一代 AI 导演级短视频自动化系统。

---

## 🏛 核心团队与模块治理 (Core Team & Governance)

| 成员 / 角色 | 贡献者身份与邮箱 | 核心职责矩阵 | 专属模块 Owner |
| :--- | :--- | :--- | :--- |
| **YJXK (Project Lead & Core Contributor)** | `yjxk2021@gmail.com` | 系统产品架构规划、AI 导演调度管线设计、多端一致性体验治理、商业化链路与团队协作管理 | `apps/web`, `docs/`, `governance` |
| **JANSEE Architecture (Chief Architect)** | `admin@jansee.cn` | 核心基础设施演进、单服务器容器编排、数据库安全迁移、两阶段异步任务队列与安全网关 | `apps/api`, `deploy/`, `packages/` |
| **JANSEE Visual Experience Group** | `design@jansee.cn` | 黑曜石设计系统规范、0 Emoji 工业级微光矢量视觉、全端发丝级排版与响应式 PWA 人机交互 | `apps/web/src`, `materials/` |
| **JANSEE Media Engine Lab** | `engine@jansee.cn` | FFmpeg 媒体管线渲染、Ken Burns 转场算法、腾讯超自然大模型 TTS 智能调度、Auto-QC 质检门禁 | `packages/`, `modules/` |

---

## 🤝 协作准则 (Collaboration Principles)

1. **多端平权与单一真相源**：PC 端与移动端保持 100% 创作能力平权，共享统一的底层契约与 OpenAPI 规范。
2. **规范化分支与审查交付**：所有特性与缺陷修复均在独立特性分支开发，必须通过自动化测试套件与代码审查后方可合并至 `main`。
3. **安全边界与最小特权**：生产密钥严禁入库，敏感操作具备防重放、幂等与事务性保障。

---

> 感谢所有为 JANSEE AI Director 演进提供架构设计、代码审查、测试验证与商业实践的团队成员。
