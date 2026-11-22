# JANSEE V4 Engineering Constitution

## Product invariants
- JANSEE is an AI Director system, not a timeline editor or template marketplace.
- PC and APP expose the same core capabilities and business workflows. Only layout and input ergonomics may adapt to screen size.
- The three core creation workflows are image-to-video, video dubbing, and multi-video storyboard composition. Keep one shared capability registry and one shared API contract for every client.
- Reduce cognitive load and duplicate entry points; do not remove capability parity between device classes.
- Do not invent or claim a generation capability until its service path is implemented and tested.

## Repository boundaries
- This repository is V4. Do not edit, commit, reset, or reformat F:\janseeV2.
- V3 is a read-only source for candidate shared components. Audit source, transitive dependencies, secrets, licensing, runtime assumptions, and tests before importing anything.
- Keep V4 independent: no direct runtime imports from F:\janseeV2 and no shared node_modules.
- All implementation changes must be made on a non-main feature branch.
- Never commit credentials, user data, production media, generated outputs, or environment files.

## Architecture and quality
- Prefer explicit boundaries: apps, contracts, domain, infrastructure adapters, and workers.
- Keep domain logic pure and independent from HTTP, databases, UI frameworks, and media binaries.
- Validate all external input at boundaries. Enforce tenant ownership in service and persistence layers, not only in UI.
- Use structured logs with secret redaction. Never log tokens, cookies, raw uploaded content, or personal media.
- Use safe defaults for CORS, headers, body size, rate limits, timeouts, concurrency, and resource cleanup.
- Every asynchronous job must have an explicit lifecycle, idempotency strategy, timeout, cancellation policy, and failure/refund handling before production use.
- Use focused tests for each changed module. Never describe an unrun test as passed.

## Anti-monolith engineering discipline (防巨石开发铁律)
- **Zero Monolith Tolerance**: Any new feature, bugfix, or optimization must adhere to modular decoupling. Never dump hundreds of lines of inline JSX, state handlers, or database queries into orchestrator files.
- **File Size Ceilings**:
  - UI entry orchestrator (e.g., `App.tsx`): must stay under 1,000 lines. New panels, drawer menus, and modal dialogs must be placed in dedicated `components/<domain>/` subdirectories.
  - Sub-components & modals: single responsibility, ideally under 200–300 lines each.
  - API routers / Controllers (e.g., `admin.ts`): must stay under 500 lines. Heavy database transactions, calculations, and hardware inspections must be placed in `services/`.
- **Boy Scout Rule for Bugfixes & Optimization**: When modifying or fixing any file near the ceiling, always perform incremental extraction (顺手小步抽离) before adding new logic. Never patch bugs by nesting massive inline conditionals or copying blocks.
- **Three-Tier Backend Separation**: Route Controller (validation/dispatch) -> Service (business logic & transactions) -> Store/Adapter (persistence/external systems). Pure logic must never be embedded directly inside Fastify route handlers.
- **Admin Console Freeze Rule (后台管理面板绝对冻结铁律)**:
  - 后台管理面板（包括 `AdminConsole.tsx`、`components/admin/**`、相关样式 `styles.css` 中后台相关区域及后端 `apps/api/src/admin.ts`、`admin-*.ts`）的所有样式、排版与业务功能已于 2026-11-22 整体冻结。
  - **严禁擅自修改**：今后在未收到用户明确指令要求修改后台的情况下，任何 Agent 严禁触碰、修改、重构或删除后台管理面板相关的任何代码与配置。
- **Frontend Layout & Visual Presentation Freeze Rule (前端全局布局与视觉呈现绝对冻结铁律)**:
  - 前端界面与黑曜石工作台已于 2026-11-22 彻底达到产品预期并正式定稿，**前端全局布局、排版与视觉样式即刻进入绝对锁定与冻结状态**。
  - **范围**：涵盖 `apps/web/src/styles.css`、`App.tsx`、`WorkbenchStage.tsx`（暗房主监视屏、双栏成片交付等）、`ComposerDock.tsx`（底栏与素材栏）、`components/works/**`、`components/auth/**`、`components/billing/**` 及全站所有页面的 DOM 结构排布、尺寸比例、间距、调色与微光质感。
  - **严禁动视觉呈现**：**没有用户的明确指令，严禁改变任何布局和样式！** 以后的所有系统调整与迭代全部限定在纯底层逻辑与纯功能性支持（如接口联调、状态处理、音视频管线、容灾兜底等），坚决不得触碰、篡改或扰动现有的视觉呈现与排版结构。

## UI system
- Use a refined, restrained, Gemini-inspired interface: generous whitespace, clear hierarchy, subtle surfaces, precise typography, and responsive layout.
- No visual distinction in available creation capabilities between PC and APP.
- Accessibility is part of definition of done: keyboard support, visible focus, semantic controls, labels, and adequate contrast.


## Mandatory design-system rule
- Before any UI, visual, responsive, component, or CSS change, read `docs/design/JANSEE_DESIGN_SYSTEM.md`.
- That document is the normative visual source of truth for PC, mobile/PWA, and admin. Follow its tokens, dimensions, typography, spacing, responsive, accessibility, and review rules.
- Same-role controls must have identical dimensions. Billing purchase buttons must remain exactly equal in width and height across all plans and breakpoints.
- Do not introduce a new visual language, dominant gradients, neon/glow, decorative emoji, or arbitrary colors without explicit product-owner approval.
- When an approved reusable pattern changes, update the design-system document and implementation tokens together.

## Single Source of Truth for Project Context & Memory
- Always read `MEMORY.md` at the project root first. It contains the complete and up-to-date business architecture, current infrastructure status, and execution rules.
- Whenever completing any significant task, updating architecture, or changing production configurations, rewrite and clean `MEMORY.md` to ensure any incoming Agent understands the latest status instantly.
