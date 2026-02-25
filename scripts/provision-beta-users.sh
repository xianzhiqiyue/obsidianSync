#!/usr/bin/env bash
set -euo pipefail
umask 077

RELEASE_TAG="${RELEASE_TAG:-}"
WAVE="${WAVE:-wave2}"
COUNT="${COUNT:-10}"
START_INDEX="${START_INDEX:-1}"
EMAIL_PREFIX="${EMAIL_PREFIX:-${WAVE}-user}"
EMAIL_DOMAIN="${EMAIL_DOMAIN:-beta.local}"
PASSWORD_LENGTH="${PASSWORD_LENGTH:-16}"
ALLOW_EXISTING="${ALLOW_EXISTING:-0}"
APPLY="${APPLY:-0}"

POSTGRES_MODE="${POSTGRES_MODE:-auto}" # auto|local|docker
POSTGRES_DSN="${POSTGRES_DSN:-postgres://postgres:postgres@localhost:5432/obsidian_sync}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-obsidian-sync-postgres}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-obsidian_sync}"

FEEDBACK_ROOT="${FEEDBACK_ROOT:-reports/beta-feedback}"
PARTICIPANTS_FILE="${PARTICIPANTS_FILE:-$FEEDBACK_ROOT/$RELEASE_TAG/$WAVE/participants.csv}"
APPEND_PARTICIPANTS="${APPEND_PARTICIPANTS:-1}"

SECRETS_DIR="${SECRETS_DIR:-.secrets/beta-users}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
CREDENTIALS_FILE="${CREDENTIALS_FILE:-$SECRETS_DIR/${RELEASE_TAG}-${WAVE}-accounts-${timestamp}.csv}"

if [ -z "$RELEASE_TAG" ]; then
  echo "RELEASE_TAG is required" >&2
  exit 1
fi

case "$POSTGRES_MODE" in
  auto|local|docker) ;;
  *)
    echo "invalid POSTGRES_MODE: $POSTGRES_MODE (expected: auto|local|docker)" >&2
    exit 1
    ;;
esac

is_integer() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

if ! is_integer "$COUNT" || [ "$COUNT" -lt 1 ]; then
  echo "COUNT must be an integer >= 1" >&2
  exit 1
fi

if ! is_integer "$START_INDEX" || [ "$START_INDEX" -lt 1 ]; then
  echo "START_INDEX must be an integer >= 1" >&2
  exit 1
fi

if ! is_integer "$PASSWORD_LENGTH" || [ "$PASSWORD_LENGTH" -lt 10 ]; then
  echo "PASSWORD_LENGTH must be an integer >= 10" >&2
  exit 1
fi

selected_mode="$POSTGRES_MODE"
if [ "$selected_mode" = "auto" ]; then
  if command -v psql >/dev/null 2>&1; then
    selected_mode="local"
  else
    selected_mode="docker"
  fi
fi

if [ "$selected_mode" = "local" ] && ! command -v psql >/dev/null 2>&1; then
  echo "psql not found; use POSTGRES_MODE=docker or install PostgreSQL client tools" >&2
  exit 1
fi

if [ "$selected_mode" = "docker" ] && ! command -v docker >/dev/null 2>&1; then
  echo "docker not found; cannot run POSTGRES_MODE=docker" >&2
  exit 1
fi

run_psql() {
  if [ "$selected_mode" = "local" ]; then
    psql "$POSTGRES_DSN" -X -A -t -q -v ON_ERROR_STOP=1 "$@"
  else
    docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$POSTGRES_CONTAINER" \
      psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -A -t -q -v ON_ERROR_STOP=1 "$@"
  fi
}

sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

generate_password() {
  node -e '
    const { randomInt } = require("node:crypto");
    const len = Number(process.argv[1]);
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let out = "";
    for (let i = 0; i < len; i += 1) out += chars[randomInt(chars.length)];
    process.stdout.write(out);
  ' "$PASSWORD_LENGTH"
}

hash_password() {
  node -e '
    const { randomBytes, scryptSync } = require("node:crypto");
    const password = process.argv[1];
    const salt = randomBytes(16).toString("hex");
    const digest = scryptSync(password, salt, 64).toString("hex");
    process.stdout.write(`${salt}:${digest}`);
  ' "$1"
}

build_email() {
  local idx="$1"
  printf '%s%s@%s' "$EMAIL_PREFIX" "$idx" "$EMAIL_DOMAIN"
}

ensure_participants_header() {
  local participants_dir
  participants_dir="$(dirname "$PARTICIPANTS_FILE")"
  mkdir -p "$participants_dir"
  if [ ! -f "$PARTICIPANTS_FILE" ]; then
    cat > "$PARTICIPANTS_FILE" <<CSV
user_id,platform,status,joined_at,last_sync_at,notes
CSV
  fi
}

append_participant_if_missing() {
  local user_id="$1"
  local email="$2"
  if [ ! -f "$PARTICIPANTS_FILE" ]; then
    ensure_participants_header
  fi
  if grep -q "^${user_id}," "$PARTICIPANTS_FILE"; then
    return 0
  fi

  printf '%s,%s,%s,%s,%s,%s\n' \
    "$user_id" \
    "unknown" \
    "invited" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "" \
    "email=$email" >> "$PARTICIPANTS_FILE"
}

mkdir -p "$(dirname "$CREDENTIALS_FILE")"
cat > "$CREDENTIALS_FILE" <<CSV
seq,email,password,user_id,db_status,created_at
CSV

emails=()
end_index=$((START_INDEX + COUNT - 1))
for ((idx = START_INDEX; idx <= end_index; idx += 1)); do
  emails+=("$(build_email "$idx")")
done

if [ "$APPLY" = "1" ]; then
  run_psql -c "SELECT 1" >/dev/null

  if [ "$ALLOW_EXISTING" != "1" ]; then
    existing_emails=()
    for email in "${emails[@]}"; do
      existing_id="$(run_psql -c "SELECT id FROM users WHERE email = '$(sql_escape "$email")' LIMIT 1;" | tr -d '[:space:]')"
      if [ -n "$existing_id" ]; then
        existing_emails+=("$email")
      fi
    done
    if [ "${#existing_emails[@]}" -gt 0 ]; then
      echo "existing beta users found (set ALLOW_EXISTING=1 to rotate passwords):" >&2
      for email in "${existing_emails[@]}"; do
        echo "  - $email" >&2
      done
      exit 1
    fi
  fi
fi

if [ "$APPEND_PARTICIPANTS" = "1" ] && [ "$APPLY" = "1" ]; then
  ensure_participants_header
fi

created_count=0
updated_count=0
for ((seq = 1; seq <= COUNT; seq += 1)); do
  idx=$((START_INDEX + seq - 1))
  email="$(build_email "$idx")"
  password="$(generate_password)"

  if [ "$APPLY" = "1" ]; then
    password_hash="$(hash_password "$password")"
    db_row="$(run_psql \
      -c "WITH upsert AS (
            INSERT INTO users (email, password_hash)
            VALUES ('$(sql_escape "$email")', '$(sql_escape "$password_hash")')
            ON CONFLICT (email)
            DO UPDATE SET password_hash = EXCLUDED.password_hash
            RETURNING id, (xmax = 0) AS inserted
          )
          SELECT id::text || ',' || CASE WHEN inserted THEN 'created' ELSE 'updated' END
          FROM upsert;")"

    user_id="$(printf '%s' "$db_row" | awk -F',' 'NR==1 {print $1}' | tr -d '[:space:]')"
    db_status="$(printf '%s' "$db_row" | awk -F',' 'NR==1 {print $2}' | tr -d '[:space:]')"

    if [ "$db_status" = "created" ]; then
      created_count=$((created_count + 1))
    else
      updated_count=$((updated_count + 1))
    fi

    if [ "$APPEND_PARTICIPANTS" = "1" ]; then
      append_participant_if_missing "$user_id" "$email"
    fi
  else
    user_id=""
    db_status="dry_run"
  fi

  printf '%s,%s,%s,%s,%s,%s\n' \
    "$seq" \
    "$email" \
    "$password" \
    "$user_id" \
    "$db_status" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$CREDENTIALS_FILE"
done

chmod 600 "$CREDENTIALS_FILE" || true

echo "BETA_PROVISION_APPLY=$APPLY"
echo "BETA_PROVISION_MODE=$selected_mode"
echo "BETA_PROVISION_RELEASE=$RELEASE_TAG"
echo "BETA_PROVISION_WAVE=$WAVE"
echo "BETA_PROVISION_COUNT=$COUNT"
echo "BETA_PROVISION_ALLOW_EXISTING=$ALLOW_EXISTING"
echo "BETA_PROVISION_CREATED=$created_count"
echo "BETA_PROVISION_UPDATED=$updated_count"
echo "BETA_PROVISION_CREDENTIALS_FILE=$CREDENTIALS_FILE"
if [ "$APPEND_PARTICIPANTS" = "1" ] && [ "$APPLY" = "1" ]; then
  echo "BETA_PROVISION_PARTICIPANTS_FILE=$PARTICIPANTS_FILE"
fi
echo "NOTE=credentials file contains plaintext passwords; handle it as secret data"
