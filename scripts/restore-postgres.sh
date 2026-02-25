#!/usr/bin/env bash
set -euo pipefail

POSTGRES_MODE="${POSTGRES_MODE:-auto}" # auto|local|docker
POSTGRES_DSN="${POSTGRES_DSN:-postgres://postgres:postgres@localhost:5432/obsidian_sync}"
POSTGRES_BACKUP_FILE="${POSTGRES_BACKUP_FILE:-}"

TARGET_POSTGRES_DSN="${TARGET_POSTGRES_DSN:-$POSTGRES_DSN}"
TARGET_ADMIN_DSN="${TARGET_ADMIN_DSN:-}"
TARGET_DB_NAME="${TARGET_DB_NAME:-}"

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-obsidian-sync-postgres}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-obsidian_sync}"

ALLOW_DROP="${ALLOW_DROP:-0}"

derive_db_name_from_dsn() {
  node -e 'const u=new URL(process.argv[1]); process.stdout.write(u.pathname.replace(/^\/+/, ""));' "$1"
}

rewrite_dsn_db() {
  node -e 'const u=new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; process.stdout.write(u.toString());' "$1" "$2"
}

if [ -z "$POSTGRES_BACKUP_FILE" ]; then
  echo "POSTGRES_BACKUP_FILE is required" >&2
  exit 1
fi

if [ ! -f "$POSTGRES_BACKUP_FILE" ]; then
  echo "backup file not found: $POSTGRES_BACKUP_FILE" >&2
  exit 1
fi

if [ "$ALLOW_DROP" != "1" ]; then
  echo "restore is destructive; set ALLOW_DROP=1 to continue" >&2
  exit 1
fi

case "$POSTGRES_MODE" in
  auto|local|docker) ;;
  *)
    echo "invalid POSTGRES_MODE: $POSTGRES_MODE (expected: auto|local|docker)" >&2
    exit 1
    ;;
esac

selected_mode="$POSTGRES_MODE"
if [ "$selected_mode" = "auto" ]; then
  if command -v psql >/dev/null 2>&1; then
    selected_mode="local"
  else
    selected_mode="docker"
  fi
fi

if [ -z "$TARGET_DB_NAME" ]; then
  if [ "$selected_mode" = "local" ]; then
    TARGET_DB_NAME="$(derive_db_name_from_dsn "$TARGET_POSTGRES_DSN")"
  else
    TARGET_DB_NAME="$POSTGRES_DB"
  fi
fi

if [[ ! "$TARGET_DB_NAME" =~ ^[a-zA-Z0-9_]+$ ]]; then
  echo "invalid TARGET_DB_NAME: $TARGET_DB_NAME (expected regex: ^[a-zA-Z0-9_]+$)" >&2
  exit 1
fi

if [ "$selected_mode" = "local" ]; then
  if ! command -v psql >/dev/null 2>&1; then
    echo "psql not found; use POSTGRES_MODE=docker or install PostgreSQL client tools" >&2
    exit 1
  fi

  RESTORE_DSN="$(rewrite_dsn_db "$TARGET_POSTGRES_DSN" "$TARGET_DB_NAME")"
  if [ -z "$TARGET_ADMIN_DSN" ]; then
    TARGET_ADMIN_DSN="$(rewrite_dsn_db "$TARGET_POSTGRES_DSN" "postgres")"
  fi

  psql "$TARGET_ADMIN_DSN" -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TARGET_DB_NAME' AND pid <> pg_backend_pid();" >/dev/null
  psql "$TARGET_ADMIN_DSN" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$TARGET_DB_NAME\";" >/dev/null
  psql "$TARGET_ADMIN_DSN" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$TARGET_DB_NAME\";" >/dev/null
  gzip -dc "$POSTGRES_BACKUP_FILE" | psql "$RESTORE_DSN" -v ON_ERROR_STOP=1 >/dev/null
else
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker not found; cannot run POSTGRES_MODE=docker" >&2
    exit 1
  fi

  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$POSTGRES_CONTAINER" \
    psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TARGET_DB_NAME' AND pid <> pg_backend_pid();" >/dev/null
  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$POSTGRES_CONTAINER" \
    psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$TARGET_DB_NAME\";" >/dev/null
  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$POSTGRES_CONTAINER" \
    psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$TARGET_DB_NAME\";" >/dev/null
  gzip -dc "$POSTGRES_BACKUP_FILE" | docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$POSTGRES_CONTAINER" \
    psql -U "$POSTGRES_USER" -d "$TARGET_DB_NAME" -v ON_ERROR_STOP=1 >/dev/null
fi

echo "POSTGRES_RESTORE_MODE=$selected_mode"
echo "POSTGRES_RESTORE_DB=$TARGET_DB_NAME"
echo "POSTGRES_RESTORE_SOURCE=$POSTGRES_BACKUP_FILE"
