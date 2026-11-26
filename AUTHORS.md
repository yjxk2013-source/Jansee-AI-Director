# JANSEE Core Team & Contributors (简兮核心团队与贡献者名册)

JANSEE V4 是一个由工程技术团队分布式协同研发的新一代 AI 导演级短视频自动化生产系统。

---

## 🏛 核心团队架构与模块治理矩阵 (Core Team & Governance)

| 团队角色 / 领域 | 核心贡献者身份与标识 | 领域职责矩阵 | 专属模块 Owner |
| :--- | :--- | :--- | :--- |
| **Project Lead & Core Systems** | **YJXK Team** (yjxk2013-source / yjxk2021@gmail.com) | 商业化系统架构设计、全链路状态机流转、多端一致性治理与团队规范管控 | pps/web, docs/, governance |
| **System Architecture & Cloud Engineering** | **yjxk2026-bit** (yjxk2026-bit@users.noreply.github.com) | 云原生部署编排、多角色协同工作区、持续集成门禁与大厂级架构规范落地 | deploy/, packages/contracts, infrastructure |
| **Chief Backend Architect** | **JANSEE Architecture Lab** (dmin@jansee.cn) | 高并发 API 网关、PG 事务性任务队列、双阶段任务调度与 Fail-closed 安全中枢 | pps/api, packages/domain |
| **Visual & Interaction Engineering** | **JANSEE Visual Design Group** (design@jansee.cn) | 黑曜石设计系统规范、0 Emoji 发丝级微光排版与多端响应式 PWA 人机工程 | pps/web/src, materials/ |
| **Media & Audio Rendering Lab** | **JANSEE Video Engine Lab** (engine@jansee.cn) | FFmpeg 流水线渲染、Ken Burns 运镜算法、大模型 TTS 调度与 Auto-QC 质检门禁 | packages/image-film, packages/video-dub, packages/ffmpeg-kit |

---

## 🤝 团队协作与工程守则 (Collaboration & Engineering Standards)

1. **多端平权与单一真相源**：PC 端与移动端保持 100% 创作能力平权，严格遵循共享 OpenAPI 契约与领域模型。
2. **去巨石化与模块边界 (Anti-Monolith Discipline)**：遵循三层架构隔离，杜绝巨石文件，核心控制器与组件实行单一职责原则。
3. **严格分支与自动化门禁**：所有功能迭代与缺陷修复必须在独立特性分支进行，严禁裸推 main 分支，合入前必须全量通过单测与类型检查。
4. **零凭证泄露原则**：所有生产密钥、客户敏感信息严禁提交代码仓库，全链路采用环境变量注入与结构化脱敏。

---

> 感谢所有参与 JANSEE AI Director 架构设计、工程研发、音视频算法优化与交付验证的团队成员。