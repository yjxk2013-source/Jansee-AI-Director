# PostgreSQL Operations — Tencent Cloud V4

Production target: a dedicated TencentDB for PostgreSQL instance in a mainland China region, preferably the same VPC and region as the V4 application server. Application connections must use the private endpoint. Do not enable public database access for normal application traffic.

The V4 database is separate from all V3 databases. Never point DATABASE_URL at a V3 database. Use a dedicated database user with only the permissions required by the V4 API and migration process; keep migration credentials separate from the runtime role where practical.

## Current implementation

- `apps/api/migrations/0001_initial.sql` defines the initial account, session, conversation, asset, job, and output schema.
- `apps/api/src/database.ts` creates the PostgreSQL pool and readiness check.
- `apps/api/src/migrate.ts` runs ordered SQL migrations under a PostgreSQL advisory lock.
- No live database is currently configured and no production migration has been applied. A successful local build does not prove a database connection or migration.

## Environment

```env
DATABASE_URL=postgresql://<v4-user>:<password>@<private-host>:5432/<v4-database>
DATABASE_SSL=true
```

Set the actual secret only in the V4 server's protected environment or secret manager. Never commit `.env`, expose credentials to the browser, or send secrets in chat. Keep the DB endpoint private and restrict the Tencent Cloud security group to the V4 server/worker.

## First connection and migration

1. Create a dedicated TencentDB PostgreSQL instance in a mainland region and VPC selected for V4.
2. Create a V4 database and least-privilege roles.
3. Configure the private endpoint and security group.
4. Set DATABASE_URL and DATABASE_SSL=true on the V4 environment.
5. Run `npm run migrate --workspace @jansee/api` from the release artifact or controlled migration runner.
6. Verify `schema_migrations`, then run integration tests and `/health/ready`.
7. Confirm automated backups and perform a restore rehearsal before production traffic.

## Operational safeguards

- Do not use public database endpoints for application traffic.
- Do not share V3 credentials, schemas, backups, or databases.
- Keep connection pool size bounded and account for API plus worker replicas.
- Monitor connection saturation, slow queries, storage, backup age, replication/availability, and migration outcomes.
- Test backup restoration into an isolated V4 environment.
- Rotate secrets and redact them from logs.


## Backup and isolated restore drill

The repository includes two operator scripts; they run on the Linux host or a secured operations runner with PostgreSQL client tools installed:

- `scripts/db-backup.sh`: creates a PostgreSQL custom-format dump using `pg_dump`, validates the archive with `pg_restore --list`, writes files with restrictive permissions, emits a SHA-256 checksum when available, and prunes archives beyond the configured retention period.
- `scripts/db-restore-drill.sh`: restores to a separately provisioned, empty, isolated V4 test database and checks the migration and user tables. It deliberately does not use `--clean`; it must never target production.

Use a protected libpq service file outside the repository (permissions 0600), rather than putting database passwords in command-line arguments:

```ini
[jansee_v4_backup]
host=PRIVATE_POSTGRES_HOST
port=5432
dbname=JANSEE_V4_DATABASE
user=V4_BACKUP_ROLE
password=SECRET_FROM_SECRET_MANAGER
sslmode=verify-full
sslrootcert=/etc/ssl/certs/tencentdb-root-ca.pem

[jansee_v4_restore_drill]
host=ISOLATED_RESTORE_POSTGRES_HOST
port=5432
dbname=JANSEE_V4_RESTORE_DATABASE
user=V4_RESTORE_ROLE
password=SECRET_FROM_SECRET_MANAGER
sslmode=verify-full
sslrootcert=/etc/ssl/certs/tencentdb-root-ca.pem
```

Example operations:

```bash
export PGSERVICEFILE=/etc/jansee-v4/pg_service.conf
export PGSERVICE=jansee_v4_backup
export JANSEE_BACKUP_DIR=/srv/backups/jansee-v4/postgres
export JANSEE_BACKUP_RETENTION_DAYS=14
bash scripts/db-backup.sh

export JANSEE_BACKUP_FILE=/srv/backups/jansee-v4/postgres/EXACT_BACKUP_FILE.dump
export JANSEE_RESTORE_SERVICE=jansee_v4_restore_drill
export JANSEE_RESTORE_CONFIRM=RESTORE_TO_ISOLATED_V4_DATABASE
bash scripts/db-restore-drill.sh
```

The service file and backup directory must be readable only by the operations account. Prefer encrypted host/block storage and an off-host copy in a separate failure domain. A successful dump command is not a restore drill: release acceptance requires a completed isolated restore, recorded duration, row-count checks, and confirmation that the restored application can pass read-only smoke tests. These scripts have not yet been run against a live TencentDB instance because production credentials and an isolated restore target are not provisioned.


## Latest V4 retention and billing-integrity corrections (2026-11-16)

The implementation now sets an explicit 24-hour `expires_at` on every uploaded asset. The hourly sweeper:
- deletes expired source objects from storage first, and only marks the matching database rows expired after successful object deletion;
- leaves rows eligible for retry when COS/local storage deletion fails;
- excludes assets still referenced by queued, inspecting, planning, rendering or quality-check jobs, so an overlong active render is not deprived of its source media;
- uses the database expiry timestamp rather than accidentally applying an additional 24-hour grace period.

The production PostgreSQL billing store now exposes `completeJobAndSettle`: it locks the job row, verifies the current Worker lease and `quality-check` state, verifies the credit hold and frozen wallet balance, writes the settle ledger entry, and marks the job completed in the same database transaction. This closes the gap where a job could be marked completed before credit settlement succeeded (or a charged job could then be incorrectly moved to failed). Stale workers cannot settle or complete jobs after lease reclamation.

Regression coverage added for asset expiry timestamps, active-job retention, storage deletion failure retryability, and atomic job completion/credit settlement. These are code-level tests; a live PostgreSQL concurrency/failure drill remains required.
