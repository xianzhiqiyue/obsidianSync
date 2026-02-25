CREATE TABLE IF NOT EXISTS vault_sync_state (
  vault_id UUID PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
  latest_checkpoint BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS object_blobs (
  content_hash TEXT PRIMARY KEY,
  size_bytes BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sync_prepares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  base_checkpoint BIGINT NOT NULL,
  changes_json JSONB NOT NULL,
  conflicts_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'conflicted', 'committed', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS change_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  changeset_id UUID NOT NULL REFERENCES changesets(id) ON DELETE CASCADE,
  checkpoint BIGINT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('create', 'update', 'delete', 'rename', 'move')),
  file_id UUID NOT NULL REFERENCES file_entries(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vault_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_entries_vault_path_active
  ON file_entries(vault_id, current_path)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sync_prepares_vault_device ON sync_prepares(vault_id, device_id);
CREATE INDEX IF NOT EXISTS idx_change_events_vault_checkpoint ON change_events(vault_id, checkpoint);
