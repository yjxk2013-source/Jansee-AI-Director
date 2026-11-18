# Changelog

All notable changes to JANSEE V4 are documented here.

## 4.0.0-alpha.1 — 2026-11-15

### Added
- Independent V4 Git repository and feature branch, separate from V3.
- Shared capability contracts for image-film, video-dub, and multi-video storyboard.
- Cross-device parity rule: PC and APP use the same capabilities, API contracts, and business flows.
- Responsive React web client with a director-first creation interface and local asset selection.
- Installable PWA shell shared by PC and APP, with a static-only service worker and an offline notice page.
- Fastify API foundation with liveness/readiness routes and a shared capabilities endpoint.
- Strict job lifecycle domain model and Zod request validation.
- Security baseline: request limits, rate limiting, CORS allowlist, security headers, request IDs, and log redaction.
- Architecture decision records, threat model, contributor rules, security policy, and CI workflow.
- Automated tests for capability rules, request validation, state transitions, and API security.

### Not yet production-ready
- Authentication, tenant authorization, database persistence, signed uploads, object storage, CSRF protection, asynchronous workers, AI provider adapters, and audited media rendering are not implemented.
- Readiness endpoint intentionally returns HTTP 503 until the required production adapters exist.
- UI selection and prompt controls are an interaction preview; they do not upload assets or submit real rendering jobs.
