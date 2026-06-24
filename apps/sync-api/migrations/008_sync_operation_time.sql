ALTER TABLE file_versions
  ADD COLUMN IF NOT EXISTS operation_time_ms BIGINT;

ALTER TABLE change_events
  ADD COLUMN IF NOT EXISTS operation_time_ms BIGINT;

UPDATE file_versions
SET operation_time_ms = COALESCE(mtime_ms, FLOOR(EXTRACT(EPOCH FROM created_at) * 1000)::BIGINT)
WHERE operation_time_ms IS NULL;

UPDATE change_events
SET operation_time_ms = COALESCE(mtime_ms, FLOOR(EXTRACT(EPOCH FROM created_at) * 1000)::BIGINT)
WHERE operation_time_ms IS NULL;
