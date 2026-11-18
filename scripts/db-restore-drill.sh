#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${JANSEE_BACKUP_FILE:?Set JANSEE_BACKUP_FILE to the exact backup archive to restore}"
: "${JANSEE_RESTORE_SERVICE:?Set JANSEE_RESTORE_SERVICE to a dedicated, isolated, empty V4 restore database service}"
: "${PGSERVICEFILE:?Set PGSERVICEFILE to a protected libpq service file outside the repository}"

if [[ "${JANSEE_RESTORE_CONFIRM:-}" != "RESTORE_TO_ISOLATED_V4_DATABASE" ]]; then
  echo "Refusing restore. Set JANSEE_RESTORE_CONFIRM=RESTORE_TO_ISOLATED_V4_DATABASE only after verifying the target is isolated and disposable." >&2
  exit 1
fi
if [[ ! -f "$JANSEE_BACKUP_FILE" || ! -s "$JANSEE_BACKUP_FILE" ]]; then
  echo "Backup file does not exist or is empty." >&2
  exit 1
fi
if ! command -v pg_restore >/dev/null 2>&1 || ! command -v psql >/dev/null 2>&1; then
  echo "pg_restore and psql are required (install the PostgreSQL client package)." >&2
  exit 1
fi

pg_restore --list "$JANSEE_BACKUP_FILE" >/dev/null
# This command intentionally does not use --clean/--if-exists: the target must be a fresh,
# isolated database. It must never be pointed at the live production database.
pg_restore --no-password --exit-on-error --no-owner --no-acl --dbname="service=$JANSEE_RESTORE_SERVICE" "$JANSEE_BACKUP_FILE"

MIGRATIONS="$(psql --no-password --service="$JANSEE_RESTORE_SERVICE" --tuples-only --no-align --command='SELECT count(*) FROM schema_migrations;')"
USERS="$(psql --no-password --service="$JANSEE_RESTORE_SERVICE" --tuples-only --no-align --command='SELECT count(*) FROM users;')"
printf 'Restore drill passed. schema_migrations=%s users=%s target_service=%s\n' "$MIGRATIONS" "$USERS" "$JANSEE_RESTORE_SERVICE"
