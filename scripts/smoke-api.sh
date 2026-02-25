#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000/api/v1}"
EMAIL="${EMAIL:-admin@example.com}"
PASSWORD="${PASSWORD:-admin123456}"
DEVICE_NAME="${DEVICE_NAME:-smoke-mac}"
PLATFORM="${PLATFORM:-macos}"
PLUGIN_VERSION="${PLUGIN_VERSION:-0.1.0}"
VAULT_NAME="${VAULT_NAME:-SmokeVault}"

health=$(curl -sS "$BASE_URL/health")

login=$(curl -sS -X POST "$BASE_URL/auth/login" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"deviceName\":\"$DEVICE_NAME\",\"platform\":\"$PLATFORM\",\"pluginVersion\":\"$PLUGIN_VERSION\"}")

access=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.accessToken || "");' "$login")
[ -n "$access" ]

vault=$(curl -sS -X POST "$BASE_URL/vaults" \
  -H "authorization: Bearer $access" \
  -H "content-type: application/json" \
  -d "{\"name\":\"$VAULT_NAME\"}")

vault_id=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.vaultId || "");' "$vault")
[ -n "$vault_id" ]

state=$(curl -sS "$BASE_URL/vaults/$vault_id/sync/state" -H "authorization: Bearer $access")
base_cp=$(node -e 'const j=JSON.parse(process.argv[1]); const cp=(j.checkpoint || "cp_0").split("_")[1] || "0"; process.stdout.write(cp);' "$state")

prepare_payload=$(node -e 'const cp=Number(process.argv[1]); const now=Date.now(); const body={baseCheckpoint:cp,changes:[{op:"create",path:"notes/smoke.md",contentHash:`sha256:smoke-${now}`}]}; process.stdout.write(JSON.stringify(body));' "$base_cp")

prepare=$(curl -sS -X POST "$BASE_URL/vaults/$vault_id/sync/prepare" \
  -H "authorization: Bearer $access" \
  -H "content-type: application/json" \
  -d "$prepare_payload")

prepare_id=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.prepareId || "");' "$prepare")
[ -n "$prepare_id" ]

upload_url=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.uploadTargets?.[0]?.uploadUrl || "");' "$prepare")
content_hash=$(node -e 'const j=JSON.parse(process.argv[1]); const payload=JSON.parse(process.argv[2]); process.stdout.write(j.uploadTargets?.[0]?.contentHash || payload.changes[0].contentHash);' "$prepare" "$prepare_payload")

if [ -n "$upload_url" ]; then
  curl -sS -X PUT "$upload_url" --data-binary "smoke-content-$(date +%s)" >/dev/null
fi

idempotency=$(uuidgen | tr '[:upper:]' '[:lower:]')
commit=$(curl -sS -X POST "$BASE_URL/vaults/$vault_id/sync/commit" \
  -H "authorization: Bearer $access" \
  -H "content-type: application/json" \
  -d "{\"prepareId\":\"$prepare_id\",\"idempotencyKey\":\"$idempotency\"}")

pull=$(curl -sS "$BASE_URL/vaults/$vault_id/sync/pull?fromCheckpoint=0&limit=200" \
  -H "authorization: Bearer $access")

download=$(curl -sS -X POST "$BASE_URL/vaults/$vault_id/objects/download-urls" \
  -H "authorization: Bearer $access" \
  -H "content-type: application/json" \
  -d "{\"contentHashes\":[\"$content_hash\"]}")

printf 'HEALTH=%s\nLOGIN=%s\nVAULT=%s\nSTATE=%s\nPREPARE=%s\nCOMMIT=%s\nPULL=%s\nDOWNLOAD=%s\n' \
  "$health" "$login" "$vault" "$state" "$prepare" "$commit" "$pull" "$download"
