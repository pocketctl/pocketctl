-- Apply with psql -X -v ON_ERROR_STOP=1 in autocommit mode after deploying
-- the Relay version that no longer creates the payload-only index.
SET lock_timeout = '1s';
SET statement_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('public.idx_events_session_agent_id_desc') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indrelid = 'public.events'::regclass
      AND indexrelid = 'public.idx_events_session_agent_id_desc'::regclass
      AND NOT indisunique AND NOT indisclustered AND NOT indisreplident
  ) THEN
    RAISE EXCEPTION 'Unexpected legacy subagent index';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indrelid = 'public.events'::regclass
      AND indexrelid = to_regclass('public.idx_events_body_agent_id_desc')
      AND indisvalid AND indisready
  ) THEN
    RAISE EXCEPTION 'Valid hot/cold subagent index required';
  END IF;
END $$;

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_session_agent_id_desc;
RESET statement_timeout;
RESET lock_timeout;
