ALTER TABLE users
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_active
  ON refresh_tokens(user_id, revoked_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_devices_user_status
  ON devices(user_id, status);
