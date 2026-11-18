# JANSEE V4 Lightweight Admin Scope

The V4 admin is an operator console, not a second product. It should expose only information needed to run the service safely and understand commercial performance.

## Primary navigation

1. **Overview** — today / 7-day / 30-day visitors, registrations, active users, generation volume, completion rate, failures, paid users and gross payment totals. Show trend deltas only when the comparison window is valid.
2. **Generation jobs** — queued/running/completed/failed jobs, queue age, duration, failure reason, retry/cancel where safe, and linked user/job trace. Never expose raw secrets or unrestricted media paths.
3. **Users & orders** — user lookup, account state, membership/credits, order/payment/refund status and a minimal audit trail for operator actions.
4. **System health** — API/database/worker/provider status, disk free space, queue depth, error rate, backup freshness and alert history.

## Explicitly out of scope for initial release

- Multi-level enterprise RBAC, organization/tenant administration UI and custom permission builders.
- A large analytics/reporting suite, arbitrary SQL console, generic CMS or workflow designer.
- Exposing environment variables, credentials, raw server shell, unrestricted file browser or direct database editing.
- Duplicating every operational setting as a dashboard control. Sensitive configuration stays in deployment/secret management.

## Interaction rules

- Default landing page is Overview, with a compact health strip and clear abnormal-state emphasis.
- Every metric has a definition, time window and source; avoid vanity metrics and ambiguous totals.
- List pages support search, date range, status filter and pagination; no giant tables by default.
- Destructive or financial actions require confirmation, reason capture and append-only audit records.
- Retry is idempotent and available only for retryable failures; refund/credit changes must use a ledger, never edit balances silently.
- Admin access is separate from normal user sessions, protected by strong authentication, rate limits and secure cookies.
- Mobile layout is responsive for emergency monitoring, but detailed operations may remain desktop-first.

## Release acceptance

The admin is not complete until metrics are backed by real database events, financial totals reconcile with payment records, sensitive actions are audited, access is isolated from customer accounts, and health alerts are exercised in staging.
