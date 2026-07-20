ALTER TABLE file_versions
  ADD COLUMN IF NOT EXISTS operation_time_ms BIGINT;

ALTER TABLE change_events
  ADD COLUMN IF NOT EXISTS operation_time_ms BIGINT,
  ADD COLUMN IF NOT EXISTS event_index INTEGER;

ALTER TABLE tombstones
  ADD COLUMN IF NOT EXISTS path TEXT,
  ADD COLUMN IF NOT EXISTS operation_time_ms BIGINT;

UPDATE file_versions
SET operation_time_ms = FLOOR(EXTRACT(EPOCH FROM created_at) * 1000)::BIGINT
WHERE operation_time_ms IS NULL;

UPDATE change_events
SET operation_time_ms = FLOOR(EXTRACT(EPOCH FROM created_at) * 1000)::BIGINT
WHERE operation_time_ms IS NULL;

WITH ordered_events AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY vault_id, checkpoint
           ORDER BY created_at ASC, id ASC
         )::INTEGER - 1 AS stable_index
  FROM change_events
)
UPDATE change_events AS event
SET event_index = ordered_events.stable_index
FROM ordered_events
WHERE event.id = ordered_events.id
  AND event.event_index IS NULL;

UPDATE tombstones AS tombstone
SET path = file_entry.current_path
FROM file_entries AS file_entry
WHERE tombstone.file_id = file_entry.id
  AND tombstone.path IS NULL;

UPDATE tombstones
SET operation_time_ms = FLOOR(EXTRACT(EPOCH FROM deleted_at) * 1000)::BIGINT
WHERE operation_time_ms IS NULL;

ALTER TABLE file_versions
  ALTER COLUMN operation_time_ms SET NOT NULL;

ALTER TABLE change_events
  ALTER COLUMN operation_time_ms SET NOT NULL,
  ALTER COLUMN event_index SET NOT NULL;

ALTER TABLE tombstones
  ALTER COLUMN path SET NOT NULL,
  ALTER COLUMN operation_time_ms SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_change_events_vault_checkpoint_event
  ON change_events(vault_id, checkpoint, event_index);

CREATE INDEX IF NOT EXISTS idx_tombstones_vault_path_operation_time
  ON tombstones(vault_id, path, operation_time_ms DESC);
