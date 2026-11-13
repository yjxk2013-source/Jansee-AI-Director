# 简兮 (JANSEE) · 大厂工程化双人交叉复核规范 (Four-Eyes Principle)

> **版本**：v3.5.0 Enterprise Review Standard  
> **适用范围**：Jansee AI Director 全栈 Monorepo (Web + Engine + Shared Kits)  
> **生效时间**：2026-11-14

---

## 一、双人复核机制 (Four-Eyes Principle)
为了杜绝单点故障与单人裸推隐患，所有核心功能、渲染引擎与安全配置改动均必须遵循以下门禁流转：
1. **特性分支开发**：以 `feat/*` 或 `fix/*` 独立分支承载，禁止在 main 裸写；
2. **自动化门禁通过**：本地或 CI 执行 `npm test`（19 组核心测试套件 100% 通过）与 `npm run build:web`（0 Emoji 与静态红线审计通过）；
3. **Peer Review（交叉评审）**：由第二位团队成员对 PR 进行架构审查，核验包括：
   - 是否包含敏感凭证（如 keystore、私有订单数据）；
   - 是否遵守 Monorepo 根包 `private: true` 护栏；
   - 是否符合 Apache-2.0 开源协议契约；
   - 是否实现 Auto-QC 质检与 TaskQueue 调度闭环。
4. **Review 批准合入**：审查人必须在 PR 中明确给出评审意见并打上 `Approved` 标签后，由架构负责人执行合并。

---

## 二、当前团队协作核定成员
- **架构主管 (Lead Architect)**: yjxk2013-source (主账号)
- **质量与工程评审员 (QC & Reviewer)**: yjxk2021 (协作者)
