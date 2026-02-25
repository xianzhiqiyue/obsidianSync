#!/usr/bin/env bash
set -euo pipefail

MC_MODE="${MC_MODE:-auto}" # auto|local|docker
S3_ENDPOINT="${S3_ENDPOINT:-http://localhost:9000}"
S3_ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"
S3_SECRET_KEY="${S3_SECRET_KEY:-minioadmin}"
S3_BUCKET="${S3_BUCKET:-obsidian-sync}"

MINIO_CONTAINER="${MINIO_CONTAINER:-obsidian-sync-minio}"
MC_DOCKER_ENDPOINT="${MC_DOCKER_ENDPOINT:-http://127.0.0.1:9000}"

BACKUP_DIR="${BACKUP_DIR:-backups/minio}"
BACKUP_TAG="${BACKUP_TAG:-$(date -u +%Y%m%dT%H%M%SZ)}"
BACKUP_NAME="${BACKUP_NAME:-${S3_BUCKET}-${BACKUP_TAG}}"

case "$MC_MODE" in
  auto|local|docker) ;;
  *)
    echo "invalid MC_MODE: $MC_MODE (expected: auto|local|docker)" >&2
    exit 1
    ;;
esac

mkdir -p "$BACKUP_DIR"
BACKUP_DIR_ABS="$(cd "$BACKUP_DIR" && pwd)"
BACKUP_PATH="$BACKUP_DIR_ABS/$BACKUP_NAME"

if [ -e "$BACKUP_PATH" ] && [ -n "$(ls -A "$BACKUP_PATH" 2>/dev/null || true)" ]; then
  echo "backup destination already exists and is not empty: $BACKUP_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_PATH"

selected_mode="$MC_MODE"
if [ "$selected_mode" = "auto" ]; then
  if command -v mc >/dev/null 2>&1; then
    selected_mode="local"
  else
    selected_mode="docker"
  fi
fi

if [ "$selected_mode" = "local" ]; then
  if ! command -v mc >/dev/null 2>&1; then
    echo "mc not found; use MC_MODE=docker or install MinIO client" >&2
    exit 1
  fi

  alias_name="backup-$RANDOM-$$"
  cleanup_alias() {
    mc alias rm "$alias_name" >/dev/null 2>&1 || true
  }
  trap cleanup_alias EXIT

  mc alias set "$alias_name" "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
  mc ls "$alias_name/$S3_BUCKET" >/dev/null
  mc mirror --overwrite "$alias_name/$S3_BUCKET" "$BACKUP_PATH" >/dev/null
else
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker not found; cannot run MC_MODE=docker" >&2
    exit 1
  fi

  docker run --rm --entrypoint /bin/sh --network "container:${MINIO_CONTAINER}" -v "$BACKUP_PATH:/backup" minio/mc -c \
    "mc alias set src \"$MC_DOCKER_ENDPOINT\" \"$S3_ACCESS_KEY\" \"$S3_SECRET_KEY\" >/dev/null && \
     mc ls \"src/$S3_BUCKET\" >/dev/null && \
     mc mirror --overwrite \"src/$S3_BUCKET\" /backup >/dev/null"
fi

file_count="$(find "$BACKUP_PATH" -type f | wc -l | tr -d '[:space:]')"

echo "MINIO_BACKUP_MODE=$selected_mode"
echo "MINIO_BACKUP_DIR=$BACKUP_PATH"
echo "MINIO_BACKUP_FILE_COUNT=$file_count"
