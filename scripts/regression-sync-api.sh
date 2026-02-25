#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000/api/v1}"
EMAIL="${EMAIL:-admin@example.com}"
PASSWORD="${PASSWORD:-admin123456}"
PLUGIN_VERSION="${PLUGIN_VERSION:-0.1.0}"
DEVICE_A="${DEVICE_A:-reg-device-a}"
DEVICE_B="${DEVICE_B:-reg-device-b}"
VAULT_NAME="${VAULT_NAME:-RegressionVault-$(date +%s)}"

new_uuid() {
  node -e 'const { randomUUID } = require("crypto"); process.stdout.write(randomUUID());'
}

new_hash() {
  node -e 'const { randomUUID } = require("crypto"); process.stdout.write(`sha256:reg-${randomUUID()}`);'
}

checkpoint_to_num() {
  node -e 'const cp=process.argv[1] ?? "cp_0"; const m=/^cp_(\d+)$/.exec(cp); process.stdout.write(m ? m[1] : "0");' "$1"
}

assert_true() {
  local actual="$1"
  local message="$2"
  if [ "$actual" != "1" ]; then
    echo "ASSERT FAILED: $message" >&2
    exit 1
  fi
}

health=$(curl -sS "$BASE_URL/health")

login_a=$(curl -sS -X POST "$BASE_URL/auth/login" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"deviceName\":\"$DEVICE_A\",\"platform\":\"macos\",\"pluginVersion\":\"$PLUGIN_VERSION\"}")
token_a=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.accessToken || "");' "$login_a")
[ -n "$token_a" ]

login_b=$(curl -sS -X POST "$BASE_URL/auth/login" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"deviceName\":\"$DEVICE_B\",\"platform\":\"android\",\"pluginVersion\":\"$PLUGIN_VERSION\"}")
token_b=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.accessToken || "");' "$login_b")
[ -n "$token_b" ]

vault=$(curl -sS -X POST "$BASE_URL/vaults" \
  -H "authorization: Bearer $token_a" \
  -H "content-type: application/json" \
  -d "{\"name\":\"$VAULT_NAME\"}")
vault_id=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.vaultId || "");' "$vault")
[ -n "$vault_id" ]

state0=$(curl -sS "$BASE_URL/vaults/$vault_id/sync/state" -H "authorization: Bearer $token_a")
cp0=$(checkpoint_to_num "$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.checkpoint || "cp_0");' "$state0")")

# Step 1: device A creates notes/conflict.md
hash_a1=$(new_hash)
payload_create=$(node -e 'const cp=Number(process.argv[1]); const hash=process.argv[2]; process.stdout.write(JSON.stringify({baseCheckpoint: cp, changes: [{op: "create", path: "notes/conflict.md", contentHash: hash}]}));' "$cp0" "$hash_a1")
prepare_create=$(curl -sS -X POST "$BASE_URL/vaults/$vault_id/sync/prepare" \
  -H "authorization: Bearer $token_a" \
  -H "content-type: application/json" \
  -d "$payload_create")
prepare_create_id=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.prepareId || "");' "$prepare_create")
[ -n "$prepare_create_id" ]
upload_create_url=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.uploadTargets?.[0]?.uploadUrl || "");' "$prepare_create")
if [ -n "$upload_create_url" ]; then
  curl -sS -X PUT "$upload_create_url" --data-binary "reg-conflict-create-$(date +%s)" >/dev/null
fi

commit_create=$(curl -sS -X POST "$BASE_URL/vaults/$vault_id/sync/commit" \
  -H "authorization: Bearer $token_a" \
  -H "content-type: application/json" \
  -d "{\"prepareId\":\"$prepare_create_id\",\"idempotencyKey\":\"$(new_uuid)\"}")
cp_after_create=$(checkpoint_to_num "$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.newCheckpoint || "cp_0");' "$commit_create")")

pull_after_create=$(curl -sS "$BASE_URL/vaults/$vault_id/sync/pull?fromCheckpoint=0&limit=200" \
  -H "authorization: Bearer $token_a")
file_id=$(node -e 'const j=JSON.parse(process.argv[1]); const c=(j.changes || []).find((x) => x.path === "notes/conflict.md"); process.stdout.write(c?.fileId || "");' "$pull_after_create")
version_after_create=$(node -e 'const j=JSON.parse(process.argv[1]); const c=(j.changes || []).find((x) => x.path === "notes/conflict.md"); process.stdout.write(String(c?.version ?? ""));' "$pull_after_create")
[ -n "$file_id" ]
[ -n "$version_after_create" ]

# Step 2: device B updates same file, committing version+1
hash_b2=$(new_hash)
payload_update_b=$(node -e 'const cp=Number(process.argv[1]); const fileId=process.argv[2]; const baseVersion=Number(process.argv[3]); const hash=process.argv[4]; process.stdout.write(JSON.stringify({baseCheckpoint: cp, changes: [{op: "update", fileId, path: "notes/conflict.md", baseVersion, contentHash: hash}]}));' "$cp_after_create" "$file_id" "$version_after_create" "$hash_b2")
prepare_update_b=$(curl -sS -X POST "$BASE_URL/vaults/$vault_id/sync/prepare" \
  -H "authorization: Bearer $token_b" \
  -H "content-type: application/json" \
  -d "$payload_update_b")
prepare_update_b_id=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.prepareId || "");' "$prepare_update_b")
[ -n "$prepare_update_b_id" ]
upload_update_b_url=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.uploadTargets?.[0]?.uploadUrl || "");' "$prepare_update_b")
if [ -n "$upload_update_b_url" ]; then
  curl -sS -X PUT "$upload_update_b_url" --data-binary "reg-conflict-update-$(date +%s)" >/dev/null
fi
commit_update_b=$(curl -sS -X POST "$BASE_URL/vaults/$vault_id/sync/commit" \
  -H "authorization: Bearer $token_b" \
  -H "content-type: application/json" \
  -d "{\"prepareId\":\"$prepare_update_b_id\",\"idempotencyKey\":\"$(new_uuid)\"}")
cp_after_update_b=$(checkpoint_to_num "$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.newCheckpoint || "cp_0");' "$commit_update_b")")

pull_after_update_b=$(curl -sS "$BASE_URL/vaults/$vault_id/sync/pull?fromCheckpoint=$cp_after_create&limit=200" \
  -H "authorization: Bearer $token_b")
version_after_update_b=$(node -e 'const j=JSON.parse(process.argv[1]); const c=(j.changes || []).find((x) => x.fileId === process.argv[2]); process.stdout.write(String(c?.version ?? ""));' "$pull_after_update_b" "$file_id")
[ -n "$version_after_update_b" ]

# Step 3: device A retries stale update with old baseVersion -> VERSION_CONFLICT
hash_a2=$(new_hash)
payload_stale_update_a=$(node -e 'const cp=Number(process.argv[1]); const fileId=process.argv[2]; const staleVersion=Number(process.argv[3]); const hash=process.argv[4]; process.stdout.write(JSON.stringify({baseCheckpoint: cp, changes: [{op: "update", fileId, path: "notes/conflict.md", baseVersion: staleVersion, contentHash: hash}]}));' "$cp_after_update_b" "$file_id" "$version_after_create" "$hash_a2")
prepare_stale_update_a=$(curl -sS -X POST "$BASE_URL/vaults/$vault_id/sync/prepare" \
  -H "authorization: Bearer $token_a" \
  -H "content-type: application/json" \
  -d "$payload_stale_update_a")

has_version_conflict=$(node -e 'const j=JSON.parse(process.argv[1]); const ok=Array.isArray(j.conflicts) && j.conflicts.some((c) => c.code === "VERSION_CONFLICT"); process.stdout.write(ok ? "1" : "0");' "$prepare_stale_update_a")
assert_true "$has_version_conflict" "stale update must return VERSION_CONFLICT in prepare"

# Step 4: rename should keep fileId and produce rename/move event
payload_rename_b=$(node -e 'const cp=Number(process.argv[1]); const fileId=process.argv[2]; const baseVersion=Number(process.argv[3]); process.stdout.write(JSON.stringify({baseCheckpoint: cp, changes: [{op: "rename", fileId, path: "notes/conflict-renamed.md", baseVersion}]}));' "$cp_after_update_b" "$file_id" "$version_after_update_b")
prepare_rename_b=$(curl -sS -X POST "$BASE_URL/vaults/$vault_id/sync/prepare" \
  -H "authorization: Bearer $token_b" \
  -H "content-type: application/json" \
  -d "$payload_rename_b")
prepare_rename_b_id=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.prepareId || "");' "$prepare_rename_b")
[ -n "$prepare_rename_b_id" ]
commit_rename_b=$(curl -sS -X POST "$BASE_URL/vaults/$vault_id/sync/commit" \
  -H "authorization: Bearer $token_b" \
  -H "content-type: application/json" \
  -d "{\"prepareId\":\"$prepare_rename_b_id\",\"idempotencyKey\":\"$(new_uuid)\"}")
cp_after_rename_b=$(checkpoint_to_num "$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.newCheckpoint || "cp_0");' "$commit_rename_b")")

pull_after_rename=$(curl -sS "$BASE_URL/vaults/$vault_id/sync/pull?fromCheckpoint=$cp_after_update_b&limit=200" \
  -H "authorization: Bearer $token_a")
rename_event_ok=$(node -e 'const j=JSON.parse(process.argv[1]); const fileId=process.argv[2]; const ok=(j.changes || []).some((c) => (c.op === "rename" || c.op === "move") && c.fileId === fileId && c.path === "notes/conflict-renamed.md"); process.stdout.write(ok ? "1" : "0");' "$pull_after_rename" "$file_id")
assert_true "$rename_event_ok" "rename event missing or fileId changed"

# Step 5: commit idempotency replay returns same response
hash_idempotency=$(new_hash)
payload_create_idempotency=$(node -e 'const cp=Number(process.argv[1]); const hash=process.argv[2]; process.stdout.write(JSON.stringify({baseCheckpoint: cp, changes: [{op: "create", path: "notes/idempotency.md", contentHash: hash}]}));' "$cp_after_rename_b" "$hash_idempotency")
prepare_idempotency=$(curl -sS -X POST "$BASE_URL/vaults/$vault_id/sync/prepare" \
  -H "authorization: Bearer $token_a" \
  -H "content-type: application/json" \
  -d "$payload_create_idempotency")
prepare_idempotency_id=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.prepareId || "");' "$prepare_idempotency")
[ -n "$prepare_idempotency_id" ]
upload_idempotency_url=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.uploadTargets?.[0]?.uploadUrl || "");' "$prepare_idempotency")
if [ -n "$upload_idempotency_url" ]; then
  curl -sS -X PUT "$upload_idempotency_url" --data-binary "reg-idempotency-$(date +%s)" >/dev/null
fi

idempotency_key=$(new_uuid)
commit_idempotency_1=$(curl -sS -X POST "$BASE_URL/vaults/$vault_id/sync/commit" \
  -H "authorization: Bearer $token_a" \
  -H "content-type: application/json" \
  -d "{\"prepareId\":\"$prepare_idempotency_id\",\"idempotencyKey\":\"$idempotency_key\"}")
commit_idempotency_2=$(curl -sS -X POST "$BASE_URL/vaults/$vault_id/sync/commit" \
  -H "authorization: Bearer $token_a" \
  -H "content-type: application/json" \
  -d "{\"prepareId\":\"$prepare_idempotency_id\",\"idempotencyKey\":\"$idempotency_key\"}")

same_idempotency_response=$(node -e 'const a=JSON.parse(process.argv[1]); const b=JSON.parse(process.argv[2]); const same=a.changesetId===b.changesetId && a.newCheckpoint===b.newCheckpoint && a.appliedChanges===b.appliedChanges; process.stdout.write(same ? "1" : "0");' "$commit_idempotency_1" "$commit_idempotency_2")
assert_true "$same_idempotency_response" "idempotent commit replay should return identical response"

printf 'HEALTH=%s\nVAULT_ID=%s\nCONFLICT_PREPARE=%s\nRENAME_PULL=%s\nCOMMIT_IDEMPOTENCY_1=%s\nCOMMIT_IDEMPOTENCY_2=%s\n' \
  "$health" "$vault_id" "$prepare_stale_update_a" "$pull_after_rename" "$commit_idempotency_1" "$commit_idempotency_2"
