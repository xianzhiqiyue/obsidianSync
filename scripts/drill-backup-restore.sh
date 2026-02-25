#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BASE_URL="${BASE_URL:-http://localhost:3000/api/v1}"
EMAIL="${EMAIL:-admin@example.com}"
PASSWORD="${PASSWORD:-admin123456}"
DEVICE_NAME="${DEVICE_NAME:-drill-runner}"
PLATFORM="${PLATFORM:-macos}"
PLUGIN_VERSION="${PLUGIN_VERSION:-0.1.0}"

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-obsidian-sync-postgres}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-obsidian_sync}"

MINIO_CONTAINER="${MINIO_CONTAINER:-obsidian-sync-minio}"
S3_ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"
S3_SECRET_KEY="${S3_SECRET_KEY:-minioadmin}"
S3_BUCKET="${S3_BUCKET:-obsidian-sync}"

DRILL_POSTGRES_MODE="${DRILL_POSTGRES_MODE:-docker}"
DRILL_MC_MODE="${DRILL_MC_MODE:-docker}"

DRILL_ROOT="${DRILL_ROOT:-backups/drill}"
RUN_NONCE="${RUN_NONCE:-$(node -e 'const { randomUUID } = require("crypto"); process.stdout.write(randomUUID().replace(/-/g, "").slice(0, 8));')}"
RUN_TAG="${RUN_TAG:-$(date -u +%Y%m%dT%H%M%SZ)-$RUN_NONCE}"
RUN_DIR="$DRILL_ROOT/$RUN_TAG"

VERIFY_DB_NAME="${VERIFY_DB_NAME:-obsidian_sync_restore_${RUN_NONCE}}"
VERIFY_BUCKET="${VERIFY_BUCKET:-obsidian-sync-restore-${RUN_NONCE}}"
CLEANUP_VERIFY_TARGETS="${CLEANUP_VERIFY_TARGETS:-0}"

new_uuid() {
  node -e 'const { randomUUID } = require("crypto"); process.stdout.write(randomUUID());'
}

checkpoint_to_num() {
  node -e 'const cp=process.argv[1] ?? "cp_0"; const m=/^cp_(\d+)$/.exec(cp); process.stdout.write(m ? m[1] : "0");' "$1"
}

fail() {
  echo "DRILL_RESULT=FAIL"
  echo "DRILL_ERROR=$1" >&2
  exit 1
}

for cmd in curl node docker gzip; do
  command -v "$cmd" >/dev/null 2>&1 || fail "missing command: $cmd"
done

mkdir -p "$RUN_DIR"

curl -fsS "$BASE_URL/health" >/dev/null || fail "sync-api health check failed: $BASE_URL/health"

vault_name="DrillVault-$RUN_TAG"
content_hash="$(node -e 'const { randomUUID } = require("crypto"); process.stdout.write(`sha256:drill-${randomUUID()}`);')"
target_path="drill/$RUN_TAG.md"

login=$(curl -fsS -X POST "$BASE_URL/auth/login" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"deviceName\":\"$DEVICE_NAME\",\"platform\":\"$PLATFORM\",\"pluginVersion\":\"$PLUGIN_VERSION\"}")
access=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.accessToken || "");' "$login")
[ -n "$access" ] || fail "login failed: accessToken missing"

vault=$(curl -fsS -X POST "$BASE_URL/vaults" \
  -H "authorization: Bearer $access" \
  -H "content-type: application/json" \
  -d "{\"name\":\"$vault_name\"}")
vault_id=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.vaultId || "");' "$vault")
[ -n "$vault_id" ] || fail "create vault failed"

state=$(curl -fsS "$BASE_URL/vaults/$vault_id/sync/state" -H "authorization: Bearer $access")
base_cp_num=$(checkpoint_to_num "$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.checkpoint || "cp_0");' "$state")")

prepare_payload=$(node -e 'const cp=Number(process.argv[1]); const hash=process.argv[2]; const path=process.argv[3]; process.stdout.write(JSON.stringify({baseCheckpoint:cp,changes:[{op:"create",path,contentHash:hash}]}));' "$base_cp_num" "$content_hash" "$target_path")
prepare=$(curl -fsS -X POST "$BASE_URL/vaults/$vault_id/sync/prepare" \
  -H "authorization: Bearer $access" \
  -H "content-type: application/json" \
  -d "$prepare_payload")
prepare_id=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.prepareId || "");' "$prepare")
[ -n "$prepare_id" ] || fail "prepare failed"
upload_url=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.uploadTargets?.[0]?.uploadUrl || "");' "$prepare")

if [ -n "$upload_url" ]; then
  curl -fsS -X PUT "$upload_url" --data-binary "drill-content-$RUN_TAG" >/dev/null
fi

commit=$(curl -fsS -X POST "$BASE_URL/vaults/$vault_id/sync/commit" \
  -H "authorization: Bearer $access" \
  -H "content-type: application/json" \
  -d "{\"prepareId\":\"$prepare_id\",\"idempotencyKey\":\"$(new_uuid)\"}")
new_cp="$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.newCheckpoint || "");' "$commit")"
new_cp_num="$(checkpoint_to_num "$new_cp")"
[ "$new_cp_num" -gt "$base_cp_num" ] || fail "commit checkpoint did not advance"

pg_backup_dir="$RUN_DIR/postgres"
minio_backup_root="$RUN_DIR/minio"

POSTGRES_MODE="$DRILL_POSTGRES_MODE" \
POSTGRES_CONTAINER="$POSTGRES_CONTAINER" \
POSTGRES_USER="$POSTGRES_USER" \
POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
POSTGRES_DB="$POSTGRES_DB" \
BACKUP_DIR="$pg_backup_dir" \
BACKUP_TAG="$RUN_TAG" \
"$SCRIPT_DIR/backup-postgres.sh"

postgres_backup_file="$(ls -1t "$pg_backup_dir"/*.sql.gz 2>/dev/null | head -n 1 || true)"
[ -n "$postgres_backup_file" ] || fail "postgres backup file not found under $pg_backup_dir"

MC_MODE="$DRILL_MC_MODE" \
MINIO_CONTAINER="$MINIO_CONTAINER" \
S3_ACCESS_KEY="$S3_ACCESS_KEY" \
S3_SECRET_KEY="$S3_SECRET_KEY" \
S3_BUCKET="$S3_BUCKET" \
BACKUP_DIR="$minio_backup_root" \
BACKUP_TAG="$RUN_TAG" \
"$SCRIPT_DIR/backup-minio.sh"

minio_backup_dir="$(find "$minio_backup_root" -mindepth 1 -maxdepth 1 -type d | head -n 1 || true)"
[ -n "$minio_backup_dir" ] || fail "minio backup directory not found under $minio_backup_root"

POSTGRES_MODE="$DRILL_POSTGRES_MODE" \
POSTGRES_CONTAINER="$POSTGRES_CONTAINER" \
POSTGRES_USER="$POSTGRES_USER" \
POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
POSTGRES_DB="$POSTGRES_DB" \
POSTGRES_BACKUP_FILE="$postgres_backup_file" \
TARGET_DB_NAME="$VERIFY_DB_NAME" \
ALLOW_DROP=1 \
"$SCRIPT_DIR/restore-postgres.sh"

MC_MODE="$DRILL_MC_MODE" \
MINIO_CONTAINER="$MINIO_CONTAINER" \
S3_ACCESS_KEY="$S3_ACCESS_KEY" \
S3_SECRET_KEY="$S3_SECRET_KEY" \
MINIO_BACKUP_DIR="$minio_backup_dir" \
TARGET_S3_BUCKET="$VERIFY_BUCKET" \
REMOVE_EXTRA=1 \
"$SCRIPT_DIR/restore-minio.sh"

restored_cp="$(docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$POSTGRES_CONTAINER" \
  psql -U "$POSTGRES_USER" -d "$VERIFY_DB_NAME" -At -c \
  "SELECT latest_checkpoint FROM vault_sync_state WHERE vault_id = '$vault_id' LIMIT 1;" | tr -d '[:space:]')"
[ -n "$restored_cp" ] || fail "restored DB checkpoint missing for vault $vault_id"
[ "$restored_cp" -ge "$new_cp_num" ] || fail "restored checkpoint $restored_cp is behind expected $new_cp_num"

restored_event_count="$(docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$POSTGRES_CONTAINER" \
  psql -U "$POSTGRES_USER" -d "$VERIFY_DB_NAME" -At -c \
  "SELECT count(*) FROM change_events WHERE vault_id = '$vault_id';" | tr -d '[:space:]')"
[ "${restored_event_count:-0}" -ge 1 ] || fail "restored DB has no change events for vault $vault_id"

object_key="$(printf '%s' "$content_hash" | sed 's/:/\//')"
docker run --rm --entrypoint /bin/sh --network "container:${MINIO_CONTAINER}" minio/mc -c \
  "mc alias set verify http://127.0.0.1:9000 \"$S3_ACCESS_KEY\" \"$S3_SECRET_KEY\" >/dev/null && \
   mc stat \"verify/$VERIFY_BUCKET/$object_key\" >/dev/null" || fail "restored MinIO object missing: $VERIFY_BUCKET/$object_key"

if [ "$CLEANUP_VERIFY_TARGETS" = "1" ]; then
  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$POSTGRES_CONTAINER" \
    psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$VERIFY_DB_NAME' AND pid <> pg_backend_pid();" >/dev/null
  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$POSTGRES_CONTAINER" \
    psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$VERIFY_DB_NAME\";" >/dev/null

  docker run --rm --entrypoint /bin/sh --network "container:${MINIO_CONTAINER}" minio/mc -c \
    "mc alias set verify http://127.0.0.1:9000 \"$S3_ACCESS_KEY\" \"$S3_SECRET_KEY\" >/dev/null && \
     mc rb --force \"verify/$VERIFY_BUCKET\" >/dev/null"
fi

echo "DRILL_RESULT=PASS"
echo "DRILL_RUN_DIR=$RUN_DIR"
echo "DRILL_VAULT_ID=$vault_id"
echo "DRILL_CHECKPOINT_NEW=cp_$new_cp_num"
echo "DRILL_POSTGRES_BACKUP_FILE=$postgres_backup_file"
echo "DRILL_MINIO_BACKUP_DIR=$minio_backup_dir"
echo "DRILL_VERIFY_DB_NAME=$VERIFY_DB_NAME"
echo "DRILL_VERIFY_BUCKET=$VERIFY_BUCKET"
echo "DRILL_OBJECT_KEY=$object_key"
