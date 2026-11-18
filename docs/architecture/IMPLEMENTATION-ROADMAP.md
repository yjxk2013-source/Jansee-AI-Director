# JANSEE V4 Implementation Roadmap

## Phase 0 — Independent foundation
- Separate repository and branch.
- Shared client/API capability contract.
- Responsive PC/APP shell.
- Typed request schemas and job state machine.
- API security baseline, CI, tests and threat model.

**Status: Complete for alpha.1.**

## Phase 1 — Identity, tenant boundary and persistence
- Select PostgreSQL schema and migration tool.
- Implement users, accounts, memberships, roles and sessions.
- Add secure login, session rotation, HttpOnly/Secure/SameSite cookies and CSRF.
- Add service-layer authorization and repository tenant scoping.
- Add PostgreSQL row-level security and cross-tenant integration tests.
- Add append-only audit and credit-ledger tables.

## Phase 2 — Asset ingestion and retention
- Signed, short-lived upload authorization.
- Private object storage with tenant-qualified keys.
- Content sniffing and size, duration, pixel, codec and format limits.
- Quarantine and isolated metadata inspection.
- Retention state machine, deletion sweeper and physical deletion verification.
- PC and APP share the same upload and asset APIs.

## Phase 3 — Director orchestration and job reliability
- Versioned DirectorPlan schema and structured AI provider adapter.
- Prompt injection boundary: model output is data, not code or shell instructions.
- Idempotent job submission and transactional credit reservation.
- PostgreSQL outbox and worker leases.
- Heartbeat, deadline, retries, cancellation, bounded concurrency and cleanup.
- Exactly-once settlement or refund semantics.

## Phase 4 — Audited V3 capability extraction
Candidate modules are reviewed individually; no bulk copy:
- Image-film and visual engine.
- Video dubbing.
- Audio, subtitle, TTS, intro and ending shared components.
- Publication kit.
- Multi-video storyboard service, based on verified implemented behavior.

For every extraction: inspect source and transitive dependencies, hardcoded paths, secrets, licensing, resource constraints, API contracts and tests. Adapt into V4-owned packages and retain provenance.

## Phase 5 — Commercial quality and operations
- Automated media QC and compliance metadata verification.
- Output artifact delivery, expiry and deletion.
- Metrics for queue age, P50/P95/P99 latency, failure/refund ratio and worker resource use.
- Operational dashboards, alerting, backups, restore drills and disaster recovery.
- Load, abuse, isolation, penetration and mobile/desktop parity testing.

## Release gate
Production readiness is blocked until identity, tenant isolation, durable persistence, asset security, job reliability, refund correctness, retention deletion, observability and restore procedures are tested.
