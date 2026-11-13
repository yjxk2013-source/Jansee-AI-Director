# 简兮 (JANSEE) · 大厂工程化双人交叉复核规范 (Four-Eyes Principle)

> **版本**：v3.5.0 Enterprise Review Standard  
> **适用范围**：Jansee AI Director 全栈 Monorepo (Web + Engine + Shared Kits)  
> **生效时间**：2026-11-14  
> **状态**：强制执行 (LOCKED)

---

## 一、 双人复核机制 (Four-Eyes Principle)
为了杜绝单点故障与单人裸推隐患，所有核心功能、渲染引擎与安全配置改动均必须遵循以下门禁流转：
1. **特性分支开发**：以 `feat/*` 或 `fix/*` 独立分支承载，**严禁直接在 main 分支裸写代码**；
2. **自动化门禁通过**：本地或 CI 执行 `npm test`（19 组核心测试套件 100% 通过）与 `npm run build:web`（0 Emoji 与静态红线审计通过）；
3. **Peer Review（交叉评审）**：由第二位团队成员（如 `yjxk2021`）发起或审查 PR，核验包括：
   - 是否包含敏感凭证（如 keystore、私有订单数据）；
   - 是否遵守 Monorepo 根包 `private: true` 护栏；
   - 是否符合 Apache-2.0 开源协议契约；
   - 是否实现 Auto-QC 质检与 TaskQueue 调度闭环。
4. **Review 批准合入**：审查人必须在 PR 中明确给出评审意见并打上 `Approved` 标签后，由架构负责人执行合并。

---

## 二、 大厂反形式化协同红线 (Anti-Formalism Mandate)
**汲取外部审查的深刻教训，彻底根除“表面有制度、实际全绕开”的形式主义：**
1. **严禁“秒建秒批秒合”**：
   - 严禁出现数秒内流水线式创建、批准并合并的虚假协同；
   - 审查人必须在 PR 中留下针对实质性代码改动（Diff）的具体技术评语；
2. **严禁在制度确立后直推 main**：
   - 制度确立后，任何开发者均不得绕开 PR 机制批量直推 main 分支；
3. **建立每日持续协同节奏 (Daily Continuous Collaboration)**：
   - 团队进入日常迭代节奏，包括：
     - 成都微缩解压 IP《简小兮学徒记》每日场景去重与更新（归档于 `docs/ip_panda_memory.md`）；
     - 引擎渲染参数微调与 Auto-QC 阈值优化；
     - Web 客户端视觉微调与静态审计回归；
   - 每日改动均由协作者（`yjxk2021`）以独立分支发起 Pull Request，由主账号执行审查后合并，形成真实、自然、连续的生产级协同时间轴。

---

## 三、 当前团队协作核定成员
- **架构主管 (Lead Architect)**: yjxk2013-source (主账号)
- **质量与工程评审员 (QC & Reviewer)**: yjxk2021 (协作者)
