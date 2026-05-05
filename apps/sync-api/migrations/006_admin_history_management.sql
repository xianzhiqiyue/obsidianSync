ALTER TABLE changesets
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'device' CHECK (source IN ('device', 'admin')),
  ADD COLUMN IF NOT EXISTS actor_user_id UUID REFERENCES users(id);

CREATE TABLE IF NOT EXISTS admin_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL CHECK (operation IN ('restore', 'set_current_version', 'soft_delete')),
  status TEXT NOT NULL CHECK (status IN ('previewed', 'committed', 'failed')),
  file_id UUID REFERENCES file_entries(id) ON DELETE SET NULL,
  before_json JSONB NOT NULL,
  after_json JSONB,
  reason TEXT NOT NULL,
  changeset_id UUID REFERENCES changesets(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE change_events
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'device' CHECK (source IN ('device', 'admin')),
  ADD COLUMN IF NOT EXISTS admin_operation_id UUID REFERENCES admin_operations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reason TEXT;

CREATE INDEX IF NOT EXISTS idx_admin_operations_vault_created
  ON admin_operations(vault_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_operations_file_created
  ON admin_operations(file_id, created_at DESC);
