# V4 Data Ownership and Persistence

## Database target

PostgreSQL is the target relational database for V4. The initial migration is `apps/api/migrations/0001_initial.sql`.

## Tables in the initial schema

- `users`: account identity, status, verification timestamp, and password hash slot.
- `auth_sessions`: hashed session token only; raw bearer/session tokens must never be persisted.
- `conversations` and `conversation_messages`: account-owned director history.
- `assets`: metadata and private object-storage key for uploaded source media.
- `generation_jobs` and `generation_job_assets`: idempotent creation requests, job state, and ordered asset references.
- `generated_outputs`: private generated MP4 metadata and expiry/deletion lifecycle.

## Tenant isolation

Every user-owned record carries `user_id`. Child relationships use composite foreign keys to ensure that a conversation, asset, job, and output cannot be linked across different accounts. Every repository query and object-storage authorization check must also filter by the authenticated `user_id`; foreign keys are defense in depth, not a substitute for authorization.

Never accept `user_id`, storage keys, job ownership, or account roles from a browser request as authoritative. Derive ownership from a verified server-side session.

## Security and lifecycle requirements

- Store only password hashes using a modern password-hashing algorithm; never store plaintext passwords.
- Generate high-entropy opaque session tokens, store only their cryptographic hashes, rotate and revoke sessions, and use secure HttpOnly cookies in production.
- Keep source media and generated outputs in private object storage. Serve downloads through short-lived signed URLs after ownership checks.
- Validate MIME type using file signatures after upload; browser-provided MIME and filenames are untrusted.
- Apply retention and deletion with a worker that removes both database metadata and underlying objects. Expiry indexes are included, but no retention duration is imposed by this migration.
- Use the job idempotency key to prevent duplicate paid generation requests.
- Record audit events for authentication, billing, and destructive account actions before public launch.

## Not yet live

The migration is a reviewed schema artifact, not an applied database. This development machine currently has no PostgreSQL client/server, Docker runtime, PostgreSQL driver, or `.env` database connection. No account, cloud conversation, upload, job, or output data is persisted by this schema yet. Do not enable production readiness until a real managed PostgreSQL instance is configured, migrations are applied, and the persistence adapter and integration tests pass.
