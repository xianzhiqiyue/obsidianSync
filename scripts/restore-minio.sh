#!/usr/bin/env bash
set -euo pipefail

MC_MODE="${MC_MODE:-auto}" # auto|local|docker
MINIO_BACKUP_DIR="${MINIO_BACKUP_DIR:-}"

S3_ENDPOINT="${S3_ENDPOINT:-http://localhost:9000}"
S3_ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"
S3_SECRET_KEY="${S3_SECRET_KEY:-minioadmin}"
S3_BUCKET="${S3_BUCKET:-obsidian-sync}"
TARGET_S3_BUCKET="${TARGET_S3_BUCKET:-$S3_BUCKET}"
REMOVE_EXTRA="${REMOVE_EXTRA:-0}" # 1 => remove target-only objects

MINIO_CONTAINER="${MINIO_CONTAINER:-obsidian-sync-minio}"
MC_DOCKER_ENDPOINT="${MC_DOCKER_ENDPOINT:-http://127.0.0.1:9000}"

if [ -z "$MINIO_BACKUP_DIR" ]; then
  echo "MINIO_BACKUP_DIR is required" >&2
  exit 1
fi

if [ ! -d "$MINIO_BACKUP_DIR" ]; then
  echo "backup directory not found: $MINIO_BACKUP_DIR" >&2
  exit 1
fi

case "$MC_MODE" in
  auto|local|docker) ;;
  *)
    echo "invalid MC_MODE: $MC_MODE (expected: auto|local|docker)" >&2
    exit 1
    ;;
esac

BACKUP_DIR_ABS="$(cd "$MINIO_BACKUP_DIR" && pwd)"
mirror_flags="--overwrite"
if [ "$REMOVE_EXTRA" = "1" ]; then
  mirror_flags="--overwrite --remove"
fi

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

  alias_name="restore-$RANDOM-$$"
  cleanup_alias() {
    mc alias rm "$alias_name" >/dev/null 2>&1 || true
  }
  trap cleanup_alias EXIT

  mc alias set "$alias_name" "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
  mc mb --ignore-existing "$alias_name/$TARGET_S3_BUCKET" >/dev/null
  # shellcheck disable=SC2086
  mc mirror $mirror_flags "$BACKUP_DIR_ABS" "$alias_name/$TARGET_S3_BUCKET" >/dev/null
else
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker not found; cannot run MC_MODE=docker" >&2
    exit 1
  fi

  docker run --rm --entrypoint /bin/sh --network "container:${MINIO_CONTAINER}" -v "$BACKUP_DIR_ABS:/restore:ro" minio/mc -c \
    "mc alias set dst \"$MC_DOCKER_ENDPOINT\" \"$S3_ACCESS_KEY\" \"$S3_SECRET_KEY\" >/dev/null && \
     mc mb --ignore-existing \"dst/$TARGET_S3_BUCKET\" >/dev/null && \
     mc mirror $mirror_flags /restore \"dst/$TARGET_S3_BUCKET\" >/dev/null"
fi

file_count="$(find "$BACKUP_DIR_ABS" -type f | wc -l | tr -d '[:space:]')"

echo "MINIO_RESTORE_MODE=$selected_mode"
echo "MINIO_RESTORE_BUCKET=$TARGET_S3_BUCKET"
echo "MINIO_RESTORE_SOURCE=$BACKUP_DIR_ABS"
echo "MINIO_RESTORE_FILE_COUNT=$file_count"
