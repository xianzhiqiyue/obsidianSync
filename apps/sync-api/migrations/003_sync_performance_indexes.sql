CREATE INDEX IF NOT EXISTS idx_change_events_vault_checkpoint_created
  ON change_events(vault_id, checkpoint ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_sync_prepares_prepared_expires
  ON sync_prepares(expires_at)
  WHERE status = 'prepared';
