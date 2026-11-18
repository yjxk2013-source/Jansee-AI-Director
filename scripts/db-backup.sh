#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${PGSERVICE:?Set PGSERVICE to a dedicated V4 PostgreSQL libpq service name}"
: "${PGSERVICEFILE:?Set PGSERVICEFILE to a protected libpq service file outside the repository}"

BACKUP_DIR="${JANSEE_BACKUP_DIR:-/srv/backups/jansee-v4/postgres}"
RETENTION_DAYS="${JANSEE_BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
HOST="$(hostname -s 2>/dev/null || printf 'unknown-host')"
FINAL="${BACKUP_DIR}/jansee-v4-${HOST}-${STAMP}.dump"
TEMP="${FINAL}.partial"

if ! command -v pg_dump >/dev/null 2>&1 || ! command -v pg_restore >/dev/null 2>&1; then
  echo "pg_dump and pg_restore are required (install the PostgreSQL client package)." >&2
  exit 1
fi
if ! [[ "$RETENTION_DAYS" =~ ^[1-9][0-9]{0,3}$ ]]; then
  echo "JANSEE_BACKUP_RETENTION_DAYS must be an integer between 1 and 999." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
trap 'rm -f "$TEMP"' EXIT

pg_dump --no-password --format=custom --no-owner --no-acl --service="$PGSERVICE" --file="$TEMP"
test -s "$TEMP"
pg_restore --list "$TEMP" >/dev/null
mv "$TEMP" "$FINAL"
chmod 600 "$FINAL"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$FINAL" > "${FINAL}.sha256"
  chmod 600 "${FINAL}.sha256"
fi

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'jansee-v4-*.dump' -mtime "+$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'jansee-v4-*.dump.sha256' -mtime "+$RETENTION_DAYS" -delete

echo "Backup completed and archive integrity listing passed: $FINAL"
