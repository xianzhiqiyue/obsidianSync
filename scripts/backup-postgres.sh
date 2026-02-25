#!/usr/bin/env bash
set -euo pipefail

POSTGRES_MODE="${POSTGRES_MODE:-auto}" # auto|local|docker
POSTGRES_DSN="${POSTGRES_DSN:-postgres://postgres:postgres@localhost:5432/obsidian_sync}"

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-obsidian-sync-postgres}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-obsidian_sync}"

BACKUP_DIR="${BACKUP_DIR:-backups/postgres}"
BACKUP_TAG="${BACKUP_TAG:-$(date -u +%Y%m%dT%H%M%SZ)}"
BACKUP_BASENAME="${BACKUP_BASENAME:-${POSTGRES_DB}-${BACKUP_TAG}.sql.gz}"

case "$POSTGRES_MODE" in
  auto|local|docker) ;;
  *)
    echo "invalid POSTGRES_MODE: $POSTGRES_MODE (expected: auto|local|docker)" >&2
    exit 1
    ;;
esac

mkdir -p "$BACKUP_DIR"
BACKUP_DIR_ABS="$(cd "$BACKUP_DIR" && pwd)"
BACKUP_FILE="$BACKUP_DIR_ABS/$BACKUP_BASENAME"
TMP_FILE="${BACKUP_FILE}.tmp"

selected_mode="$POSTGRES_MODE"
if [ "$selected_mode" = "auto" ]; then
  if command -v pg_dump >/dev/null 2>&1; then
    selected_mode="local"
  else
    selected_mode="docker"
  fi
fi

rm -f "$TMP_FILE"

if [ "$selected_mode" = "local" ]; then
  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "pg_dump not found; use POSTGRES_MODE=docker or install PostgreSQL client tools" >&2
    exit 1
  fi

  pg_dump "$POSTGRES_DSN" | gzip -c > "$TMP_FILE"
else
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker not found; cannot run POSTGRES_MODE=docker" >&2
    exit 1
  fi

  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$POSTGRES_CONTAINER" \
    pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" | gzip -c > "$TMP_FILE"
fi

mv "$TMP_FILE" "$BACKUP_FILE"
size_bytes="$(wc -c < "$BACKUP_FILE" | tr -d '[:space:]')"

echo "POSTGRES_BACKUP_MODE=$selected_mode"
echo "POSTGRES_BACKUP_FILE=$BACKUP_FILE"
echo "POSTGRES_BACKUP_SIZE_BYTES=$size_bytes"
