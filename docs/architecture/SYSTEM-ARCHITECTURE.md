# JANSEE V4 System Architecture

## 1. Architecture target

Build one AI Director product with multiple responsive clients. PC and APP must consume the same capability registry and application API. Screen size changes presentation, never business capability.

## 2. Logical layers

- **Clients**: responsive web/PWA shell; future native wrappers may host the same client bundle.
- **API / BFF**: authentication boundary, request validation, authorization, rate limiting, idempotency, orchestration entry points.
- **Application services**: create projects, register assets, request director plans, submit/cancel jobs, retrieve outputs.
- **Domain**: capability rules, job state machine, quota/refund policies, tenant ownership rules. No framework or infrastructure imports.
- **Infrastructure adapters**: PostgreSQL repository, object storage, queue/worker transport, AI model provider, TTS provider, FFmpeg/media pipeline.
- **Workers**: isolated media and AI tasks with bounded concurrency, timeouts, cancellation, retries, and cleanup.

## 3. Core domain concepts

- Tenant / Account
- User / Membership / Role
- Project
- Asset (immutable source, metadata, ownership, retention policy)
- DirectorSession (conversation/context and decisions)
- DirectorPlan (structured, versioned plan)
- Job (idempotency key, lifecycle, attempt, progress, timestamps)
- RenderArtifact (video, cover, subtitles, publication kit)
- CreditLedger (append-only billing and refund ledger)
- AuditEvent

The API must never trust a client-supplied tenant or owner ID. Tenant scope derives from the authenticated principal and is re-checked in every repository operation.

## 4. Capability contract

One source of truth defines the creation modes and supported asset types. The same schema is used by PC, APP, API validation, and job routing. No client may maintain a private capability list.

- image-film: image assets -> complete short video
- video-dub: one video asset -> dubbed and polished short video
- storyboard: multiple video assets -> ordered, paced composition

## 5. Media pipeline

The media path is asynchronous:

1. Validate request and authorize ownership.
2. Create an idempotent job and reserve quota in a transaction.
3. Validate upload metadata and inspect media in a resource-limited worker.
4. Ask the Director planner for a versioned structured plan.
5. Execute deterministic render components through audited adapters.
6. Run automated QC, compliance metadata, and artifact validation.
7. Atomically publish artifacts and settle the credit ledger.
8. On terminal failure, compensate quota exactly once and clean temporary files.

No API request should perform long-running FFmpeg or model work synchronously.

## 6. Security model

- Authentication must use secure, HttpOnly, SameSite cookies or a vetted OIDC flow; no long-lived tokens in localStorage.
- Authorization is enforced in application services and persistence queries.
- PostgreSQL row-level security is a defence-in-depth layer for tenant-owned records.
- Uploads use short-lived signed URLs, content sniffing, strict size/duration/pixel limits, quarantine, and malware/media parser isolation.
- CORS allowlist, CSRF protection for cookie-authenticated mutations, CSP, HSTS in production, secure headers, request size/time limits, and rate controls are mandatory.
- Secrets are managed outside the repository and redacted in logs.
- Sensitive actions produce append-only audit events.
- Retention and deletion are enforced by lifecycle jobs and verified against both metadata and physical objects.

## 7. Reliability and scale

- PostgreSQL is the durable source of truth.
- Media bytes live in S3-compatible object storage, not the application database or local ephemeral disk.
- Start with a PostgreSQL-backed job lease/outbox approach to avoid requiring a separate Redis fleet on the constrained initial server. The queue adapter may evolve behind an interface if measured throughput requires it.
- Worker concurrency is explicitly bounded by CPU/RAM/media profile. Never allow unbounded FFmpeg or model concurrency.
- Every job has an idempotency key, retry budget, heartbeat, deadline, and terminal state.
- Metrics include queue age, job latency, failure/refund ratio, worker resource use, and artifact expiry.

## 8. PC / APP parity

A single capability contract and API serve both. Responsive UI may reorganize panels, use native file pickers, or alter navigation density, but all modes, controls, and job lifecycle actions remain available on both device classes. Parity tests will exercise the shared capability registry at desktop and mobile breakpoints.

## 9. Extraction from V3

V3 is read-only. Shared modules are candidates, not assumed-safe dependencies. Each candidate requires:
- source and transitive dependency review;
- removal of hardcoded paths and process-global assumptions;
- secrets and PII scan;
- licence and attribution check;
- API contract and behavior tests;
- performance and resource-bound review;
- a V4-owned adapter or fork with recorded provenance.

Never use a workspace symlink or import path that reaches into the V3 directory at runtime.
