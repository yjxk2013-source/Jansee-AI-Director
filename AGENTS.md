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
