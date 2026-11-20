#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
BACKUP_DIR="${V4_BACKUP_DIR:-$ROOT_DIR/backups/postgres}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="$BACKUP_DIR/jansee-v4-$STAMP.dump"
TEMP_FILE="$BACKUP_FILE.partial"
trap 'rm -f "$TEMP_FILE"' EXIT
COMPOSE_CMD=(docker compose -f deploy/docker-compose.v4.yml --env-file .env)
"${COMPOSE_CMD[@]}" exec -T postgres pg_dump -U jansee_v4 -d jansee_v4 -Fc > "$TEMP_FILE"
"${COMPOSE_CMD[@]}" exec -T postgres pg_restore --list < "$TEMP_FILE" >/dev/null
mv "$TEMP_FILE" "$BACKUP_FILE"
find "$BACKUP_DIR" -type f -name 'jansee-v4-*.dump' -mtime +14 -delete
printf 'Database backup verified: %s\n' "$BACKUP_FILE"
