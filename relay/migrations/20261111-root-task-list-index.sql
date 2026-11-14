-- Run explicitly outside a transaction, after session-history body schema exists.
-- This is deliberately not part of startup: events may be a large live table.
-- Verify pg_index.indisvalid before marking migration applied; if an interrupted
-- build left an invalid index, drop that index CONCURRENTLY before retrying.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_root_task_lists
ON events(session_id, event_type, id DESC)
WHERE event_type IN ('agent_plan','agent_todo')
  AND COALESCE(COALESCE(payload,body_header)->>'agent_id', '') = '';
