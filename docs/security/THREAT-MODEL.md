# JANSEE V4 Threat Model

## Assets to protect

- User accounts, credentials, sessions, and tenant membership.
- Original media uploads and generated media artifacts.
- Director prompts, generated scripts, and private business context.
- Credits, payment records, quotas, refunds, and invoices.
- Provider credentials, signing keys, storage credentials, and operational secrets.
- Audit trails and deletion / retention records.

## Trust boundaries

1. Untrusted browser or mobile client -> public API.
2. Authenticated user -> tenant-scoped application services.
3. API -> media upload and object-storage boundary.
4. API / outbox -> asynchronous worker.
5. Worker -> model, TTS, and media-processing providers.
6. Operator / admin -> privileged control plane.

## Primary threats and controls

| Threat | Required controls |
|---|---|
| Broken object-level authorization | Derive tenant from authenticated principal; enforce ownership in every service and repository query; PostgreSQL RLS as defence in depth |
| Malicious or oversized media | Signed short-lived upload URLs; MIME sniffing; size, duration, pixel and codec limits; quarantine; sandboxed parsers; bounded CPU/RAM |
| Cross-site request forgery | SameSite cookies, CSRF tokens and Origin validation for state-changing cookie-authenticated requests |
| Credential theft | HttpOnly + Secure cookies, OIDC or vetted password flow, secret manager, rotation and log redaction |
| Replay / duplicate billing | Idempotency keys, database uniqueness constraints, append-only credit ledger and exactly-once compensation semantics |
| Queue starvation / resource exhaustion | Worker leases, heartbeat, hard deadlines, bounded concurrency, retry budgets and backpressure |
| Prompt injection / untrusted model output | Treat prompts and model output as data; schema-validate director plans; allowlisted render operations; no model-generated shell commands |
| Cross-tenant data leakage | Tenant-qualified storage keys; authorization before signed URLs; RLS policies; integration tests with multiple tenants |
| Stale or orphaned media | Explicit retention state machine; lifecycle sweeper; verify metadata and physical object deletion |
| Supply-chain compromise | Lockfile, npm audit, CI dependency review, pinned toolchain and integrity verification of native binaries |

## Mandatory release gates

- No production release before authentication, CSRF, database authorization and tenant isolation are tested.
- No media worker exposed to the public network.
- No untrusted prompt or model output may become an executable command or raw FFmpeg filter graph.
- A paid task must reserve, settle or refund credits atomically and at most once.
- Delete operations must be auditable and verified against object storage.
- Secrets and private media must never enter application logs or source control.

## Current status

The alpha foundation currently includes API security headers, CORS allowlisting, rate limiting, a 2 MiB JSON body limit, request timeouts, request IDs and structured-log redaction. Authentication, persistence, upload signing, workers, CSRF and tenant isolation are not yet implemented; production readiness intentionally remains HTTP 503.
