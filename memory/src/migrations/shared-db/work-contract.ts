/** No body columns or network calls. Only trusted Relay/Memory service roles
 * receive these functions; end-user authority remains the reader/job fence. */
export const SHARED_SOURCE_WORK_FUNCTIONS=[
 `ALTER TABLE shared.memory_source_work ADD COLUMN IF NOT EXISTS dirty_since TIMESTAMPTZ`,
 `UPDATE shared.memory_source_work SET dirty_since=updated_at WHERE dirty_since IS NULL AND processed_revision<revision`,
 `ALTER TABLE shared.memory_source_work ALTER COLUMN dirty_since SET DEFAULT clock_timestamp()`,
 `CREATE OR REPLACE FUNCTION shared.mark_memory_source_dirty(p_kind TEXT,p_root TEXT) RETURNS BIGINT
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE r BIGINT; BEGIN
   -- Bootstrap holds a control lease. Never wait behind a native publisher
   -- holding an uncommitted insertion of this same root (including a missing
   -- row, which cannot be protected by SELECT FOR UPDATE NOWAIT).
   IF NOT pg_try_advisory_xact_lock(hashtextextended('memory-source-dirty:'||p_kind||':'||p_root,0)) THEN
    RAISE EXCEPTION 'source_dirty_busy' USING ERRCODE='55P03';END IF;
   PERFORM 1 FROM shared.memory_source_work WHERE source_kind=p_kind AND root_key=p_root FOR UPDATE NOWAIT;
   INSERT INTO shared.memory_source_work(source_kind,root_key,revision) VALUES(p_kind,p_root,1)
    ON CONFLICT(source_kind,root_key) DO UPDATE SET dirty_since=CASE WHEN memory_source_work.processed_revision=memory_source_work.revision THEN clock_timestamp() ELSE COALESCE(memory_source_work.dirty_since,clock_timestamp()) END,revision=memory_source_work.revision+1,updated_at=clock_timestamp(),
      available_at=CASE WHEN memory_source_work.lease_token IS NULL THEN clock_timestamp() ELSE memory_source_work.available_at END,
      dead_at=CASE WHEN memory_source_work.last_error_code IN ('provider_result_unknown','budget_hold') THEN memory_source_work.dead_at ELSE NULL END,
      attempt=CASE WHEN memory_source_work.last_error_code IN ('provider_result_unknown','budget_hold') OR memory_source_work.lease_token IS NOT NULL THEN memory_source_work.attempt ELSE 0 END
    RETURNING revision INTO r; RETURN r; END $$`,
 `CREATE OR REPLACE FUNCTION shared.claim_memory_source_work(p_worker TEXT,p_seconds INTEGER,p_limit INTEGER)
  RETURNS SETOF shared.memory_source_work LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF p_worker IS NULL OR p_seconds IS NULL OR p_limit IS NULL OR length(p_worker) NOT BETWEEN 1 AND 128 OR p_seconds NOT BETWEEN 5 AND 300 OR p_limit NOT BETWEEN 1 AND 256
    THEN RAISE EXCEPTION 'invalid_source_claim'; END IF;
   WITH exhausted AS (SELECT source_kind,root_key FROM shared.memory_source_work WHERE dead_at IS NULL AND attempt>=32 AND
    (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY available_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
   UPDATE shared.memory_source_work w SET dead_at=clock_timestamp(),last_error_code='retry_exhausted',lease_owner=NULL,lease_token=NULL,lease_until=NULL,claimed_revision=NULL
    FROM exhausted e WHERE w.source_kind=e.source_kind AND w.root_key=e.root_key;
   RETURN QUERY WITH candidates AS (SELECT source_kind,root_key FROM shared.memory_source_work WHERE dead_at IS NULL AND attempt<32
     AND processed_revision<revision AND available_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
     ORDER BY available_at,updated_at,source_kind,root_key LIMIT p_limit FOR UPDATE SKIP LOCKED)
    UPDATE shared.memory_source_work w SET lease_owner=p_worker,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+make_interval(secs=>p_seconds),
     claimed_revision=w.revision,attempt=w.attempt+1,updated_at=clock_timestamp()
    FROM candidates c WHERE w.source_kind=c.source_kind AND w.root_key=c.root_key RETURNING w.*;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.assert_memory_source_lease(p_kind TEXT,p_root TEXT,p_token UUID,p_worker TEXT,p_revision BIGINT)
  RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE found_work BOOLEAN; BEGIN
   SELECT TRUE INTO found_work FROM shared.memory_source_work WHERE source_kind=p_kind AND root_key=p_root AND lease_token=p_token
     AND lease_owner=p_worker AND claimed_revision=p_revision AND lease_until>clock_timestamp() AND dead_at IS NULL FOR UPDATE NOWAIT;
   RETURN COALESCE(found_work,FALSE);
   EXCEPTION WHEN lock_not_available THEN RETURN FALSE; END $$`,
 `CREATE OR REPLACE FUNCTION shared.renew_memory_source_lease(p_kind TEXT,p_root TEXT,p_token UUID,p_worker TEXT,p_revision BIGINT,p_seconds INT)
  RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF p_seconds IS NULL OR p_seconds NOT BETWEEN 5 AND 300 THEN RAISE EXCEPTION 'invalid_source_claim';END IF;
   IF NOT shared.assert_memory_source_lease(p_kind,p_root,p_token,p_worker,p_revision) THEN RETURN FALSE;END IF;
   UPDATE shared.memory_source_work SET lease_until=clock_timestamp()+make_interval(secs=>p_seconds)
    WHERE(source_kind,root_key)=(p_kind,p_root);RETURN TRUE;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.ack_memory_source_work(p_kind TEXT,p_root TEXT,p_token UUID,p_worker TEXT,p_revision BIGINT)
  RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   UPDATE shared.memory_source_work SET dirty_since=CASE WHEN revision=p_revision THEN NULL ELSE dirty_since END,processed_revision=GREATEST(processed_revision,p_revision),lease_owner=NULL,lease_token=NULL,lease_until=NULL,
    claimed_revision=NULL,attempt=0,last_error_code=NULL,available_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE source_kind=p_kind AND root_key=p_root AND lease_token=p_token AND lease_owner=p_worker AND claimed_revision=p_revision
    AND lease_until>clock_timestamp() AND dead_at IS NULL;
   RETURN FOUND; END $$`,
 `CREATE OR REPLACE FUNCTION shared.fail_memory_source_work(p_kind TEXT,p_root TEXT,p_token UUID,p_worker TEXT,p_revision BIGINT,p_code TEXT)
  RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF p_code IS NULL OR p_code NOT IN ('source_revoked','source_deleted','source_unavailable','version_changed','temporary_unavailable','provider_result_unknown','budget_hold')
     THEN RAISE EXCEPTION 'invalid_source_error_code'; END IF;
   UPDATE shared.memory_source_work SET dead_at=CASE WHEN p_code IN ('source_revoked','source_deleted','provider_result_unknown','budget_hold') OR attempt>=32 THEN clock_timestamp() ELSE NULL END,
    last_error_code=p_code,lease_owner=NULL,lease_token=NULL,lease_until=NULL,claimed_revision=NULL,
    available_at=clock_timestamp()+make_interval(secs=>LEAST(3600,5*power(2,LEAST(attempt-1,10)))::int),updated_at=clock_timestamp()
   WHERE source_kind=p_kind AND root_key=p_root AND lease_token=p_token AND lease_owner=p_worker AND claimed_revision=p_revision
    AND lease_until>clock_timestamp() AND dead_at IS NULL;
   RETURN FOUND; END $$`,
 `REVOKE ALL ON FUNCTION shared.mark_memory_source_dirty(TEXT,TEXT),shared.claim_memory_source_work(TEXT,INTEGER,INTEGER),
   shared.assert_memory_source_lease(TEXT,TEXT,UUID,TEXT,BIGINT),shared.ack_memory_source_work(TEXT,TEXT,UUID,TEXT,BIGINT),
   shared.fail_memory_source_work(TEXT,TEXT,UUID,TEXT,BIGINT,TEXT) FROM PUBLIC`,
 `REVOKE ALL ON FUNCTION shared.renew_memory_source_lease(TEXT,TEXT,UUID,TEXT,BIGINT,INT) FROM PUBLIC`,
] as const
