/** Metadata leases delay ordinary Relay purge only. Body authority remains in
 * the original reader/commit fences; privacy deletion never calls this gate. */
export const SHARED_SOURCE_PROCESSING_PIN_FUNCTIONS=[
 `ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS processing_pin_version INT NOT NULL DEFAULT 0`,
 `CREATE TABLE IF NOT EXISTS shared.memory_source_processing_windows(
  owner_user_id INT NOT NULL CHECK(owner_user_id>0),session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 512),
  activity_epoch BIGINT NOT NULL CHECK(activity_epoch>=0),business_activity_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL,hard_deadline TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(owner_user_id,session_id),CHECK(hard_deadline=started_at+interval '2 minutes'))`,
 `CREATE TABLE IF NOT EXISTS shared.memory_source_processing_pins(
  execution_id UUID NOT NULL REFERENCES shared.memory_source_executions(execution_id),
  installation_id UUID NOT NULL,owner_user_id INT NOT NULL,session_id TEXT NOT NULL,
  source_scope JSONB NOT NULL CHECK(jsonb_typeof(source_scope)='object' AND octet_length(source_scope::text)<=32768),
  source_version JSONB NOT NULL CHECK(jsonb_typeof(source_version)='object' AND octet_length(source_version::text)<=1024),
  activity_epoch BIGINT NOT NULL,lease_until TIMESTAMPTZ NOT NULL,hard_deadline TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(execution_id,owner_user_id,session_id),CHECK(lease_until<=hard_deadline),
  FOREIGN KEY(owner_user_id,session_id) REFERENCES shared.memory_source_processing_windows(owner_user_id,session_id))`,
 `CREATE INDEX IF NOT EXISTS memory_source_processing_pins_installation ON shared.memory_source_processing_pins(installation_id,lease_until)`,
 `CREATE INDEX IF NOT EXISTS memory_source_processing_pins_expiry ON shared.memory_source_processing_pins(lease_until,execution_id)`,
 `CREATE INDEX IF NOT EXISTS memory_source_processing_pins_root ON shared.memory_source_processing_pins(owner_user_id,session_id,lease_until)`,
 `CREATE OR REPLACE FUNCTION shared.acquire_memory_source_processing_pin(p_execution UUID,p_scope JSONB,p_root TEXT,p_version JSONB,p_renew BOOLEAN)
  RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
  DECLARE e RECORD;s RECORD;w RECORD;pin RECORD;owner_id INT;session_key TEXT;native JSONB;stamp TIMESTAMPTZ;BEGIN
   IF current_setting('transaction_isolation')<>'read committed' OR p_renew IS NULL OR p_execution IS NULL
    OR p_scope IS NULL OR jsonb_typeof(p_scope)<>'object' OR octet_length(p_scope::text)>32768
    OR p_scope - 'installationId' - 'principalUserId' - 'ownerScopeKind' - 'ownerScopeId' - 'authorizationRevision' - 'configVersion' - 'modeGeneration'<>'{}'::jsonb
    OR EXISTS(SELECT 1 FROM jsonb_each(p_scope) entry WHERE jsonb_typeof(entry.value)<>'string')
    OR p_version IS NULL OR jsonb_typeof(p_version)<>'object' OR octet_length(p_version::text)>1024
    OR p_version - 'content' - 'authorization' - 'storage'<>'{}'::jsonb
    OR EXISTS(SELECT 1 FROM jsonb_each(p_version) entry WHERE jsonb_typeof(entry.value)<>'string')
    OR COALESCE(p_version->>'content','')!~'^[0-9]{1,19}$' OR COALESCE(p_version->>'authorization','')!~'^[0-9]{1,19}$'
    OR COALESCE(p_version->>'storage','')!~'^[0-9]{1,19}$' OR p_root IS NULL OR length(p_root) NOT BETWEEN 1 AND 1024 THEN RETURN FALSE;END IF;
   SELECT * INTO e FROM shared.memory_source_executions WHERE execution_id=p_execution;
   IF NOT FOUND OR e.branch NOT IN('canonical-active','canonical-shadow') OR e.installation_id::text IS DISTINCT FROM p_scope->>'installationId'
    OR e.generation::text IS DISTINCT FROM p_scope->>'modeGeneration'
    OR NOT shared.assert_memory_job_source(p_execution,CASE WHEN e.branch='canonical-shadow' THEN 'compare' ELSE 'provider' END) THEN RETURN FALSE;END IF;
   -- All later locks are try/NOWAIT: never wait for Relay while holding a job.
   IF NOT shared.lock_memory_personal_source_commit(p_scope,'relay_event',p_root,p_version,FALSE) THEN RETURN FALSE;END IF;
   owner_id=(p_scope->>'principalUserId')::int;session_key=substr(p_root,strpos(p_root,':')+1);
   native=public.native_session_authority(session_key,owner_id,NULL);
   IF native->>'state' IS DISTINCT FROM 'current' THEN RETURN FALSE;END IF;
   session_key=native->>'originSessionId';
   IF session_key IS NULL THEN RETURN FALSE;END IF;
   SELECT activity_epoch,last_business_activity_at INTO s FROM public.sessions WHERE session_id=native->>'sessionId' AND user_id=owner_id;
   IF NOT FOUND OR s.activity_epoch IS NULL OR s.activity_epoch<0 THEN RETURN FALSE;END IF;
   IF NOT pg_try_advisory_xact_lock(hashtextextended('processing-pin:installation:'||e.installation_id::text,0)) THEN RETURN FALSE;END IF;
   IF NOT pg_try_advisory_xact_lock(hashtextextended('processing-pin:root:'||owner_id::text||':'||session_key,0)) THEN RETURN FALSE;END IF;
   stamp=clock_timestamp();
   -- Bounded lease GC. Window metadata deliberately survives release/expiry.
   DELETE FROM shared.memory_source_processing_pins WHERE ctid IN(SELECT ctid FROM shared.memory_source_processing_pins
    WHERE lease_until<=stamp ORDER BY lease_until LIMIT 128 FOR UPDATE SKIP LOCKED);
   SELECT * INTO pin FROM shared.memory_source_processing_pins WHERE execution_id=p_execution AND owner_user_id=owner_id AND session_id=session_key;
   IF NOT FOUND THEN
    IF p_renew THEN RETURN FALSE;END IF;
    IF (SELECT count(*) FROM shared.memory_source_processing_pins WHERE installation_id=e.installation_id AND lease_until>stamp)>=64
     OR (SELECT count(*) FROM shared.memory_source_processing_pins WHERE owner_user_id=owner_id AND session_id=session_key AND lease_until>stamp)>=8 THEN RETURN FALSE;END IF;
   ELSIF pin.lease_until<=stamp OR pin.source_scope IS DISTINCT FROM p_scope THEN RETURN FALSE;
   END IF;
   INSERT INTO shared.memory_source_processing_windows(owner_user_id,session_id,activity_epoch,business_activity_at,started_at,hard_deadline)
    VALUES(owner_id,session_key,s.activity_epoch,s.last_business_activity_at,stamp,stamp+interval '2 minutes') ON CONFLICT DO NOTHING;
   SELECT * INTO w FROM shared.memory_source_processing_windows WHERE owner_user_id=owner_id AND session_id=session_key FOR UPDATE NOWAIT;
   IF s.activity_epoch<w.activity_epoch THEN RETURN FALSE;END IF;
   -- Epoch also changes on non-business transitions. Only a verified native
   -- business edge may reopen the absolute window, never a new worker/claim.
   IF s.activity_epoch>w.activity_epoch AND s.last_business_activity_at>COALESCE(w.business_activity_at,'-infinity'::timestamptz) THEN
    UPDATE shared.memory_source_processing_windows SET activity_epoch=s.activity_epoch,business_activity_at=s.last_business_activity_at,
     started_at=stamp,hard_deadline=stamp+interval '2 minutes' WHERE owner_user_id=owner_id AND session_id=session_key RETURNING * INTO w;
   END IF;
   IF w.hard_deadline<=stamp THEN RETURN FALSE;END IF;
   -- A fresh independently current read may refresh the vector; an old
   -- prepared page still needs its own original current-version fence.
   INSERT INTO shared.memory_source_processing_pins(execution_id,installation_id,owner_user_id,session_id,source_scope,source_version,activity_epoch,lease_until,hard_deadline)
    VALUES(p_execution,e.installation_id,owner_id,session_key,p_scope,p_version,s.activity_epoch,LEAST(stamp+interval '30 seconds',w.hard_deadline),w.hard_deadline)
    ON CONFLICT(execution_id,owner_user_id,session_id) DO UPDATE SET source_version=EXCLUDED.source_version,activity_epoch=EXCLUDED.activity_epoch,lease_until=EXCLUDED.lease_until,hard_deadline=EXCLUDED.hard_deadline;
   RETURN TRUE;
   EXCEPTION WHEN lock_not_available OR invalid_text_representation OR numeric_value_out_of_range THEN RETURN FALSE;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.check_memory_source_processing_pin_commit() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE e RECORD;BEGIN
   -- A same-transaction release needs no positive admission.
   IF NOT EXISTS(SELECT 1 FROM shared.memory_source_processing_pins WHERE execution_id=NEW.execution_id AND owner_user_id=NEW.owner_user_id AND session_id=NEW.session_id) THEN RETURN NULL;END IF;
   SELECT * INTO e FROM shared.memory_source_executions WHERE execution_id=NEW.execution_id;
   IF NEW.lease_until<=clock_timestamp() OR NEW.hard_deadline<=clock_timestamp()
    OR NOT shared.assert_memory_job_source(NEW.execution_id,CASE WHEN e.branch='canonical-shadow' THEN 'compare' ELSE 'provider' END)
    OR NOT shared.guard_memory_control_commit(e.control_revision)
    OR NOT shared.lock_memory_personal_source_commit(NEW.source_scope,'relay_event',NEW.owner_user_id::text||':'||NEW.session_id,NEW.source_version,FALSE)
    THEN RAISE EXCEPTION 'source_processing_pin_unavailable' USING ERRCODE='55000';END IF;
   RETURN NULL;
  END $$`,
 `DROP TRIGGER IF EXISTS memory_source_processing_pin_commit ON shared.memory_source_processing_pins;
  CREATE CONSTRAINT TRIGGER memory_source_processing_pin_commit AFTER INSERT OR UPDATE ON shared.memory_source_processing_pins
   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shared.check_memory_source_processing_pin_commit()`,
 `CREATE OR REPLACE FUNCTION shared.guard_memory_source_processing_pins(p_execution UUID,p_expected INT)
  RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE pin RECORD;seen INT=0;BEGIN
   IF current_setting('transaction_isolation')<>'read committed' OR p_expected IS NULL OR p_expected NOT BETWEEN 0 AND 64
    OR (SELECT count(*) FROM shared.memory_source_processing_pins WHERE execution_id=p_execution)<>p_expected THEN RETURN FALSE;END IF;
   FOR pin IN SELECT * FROM shared.memory_source_processing_pins WHERE execution_id=p_execution ORDER BY owner_user_id,session_id FOR SHARE NOWAIT LOOP
    seen=seen+1;
    IF pin.lease_until<=clock_timestamp() OR pin.hard_deadline<=clock_timestamp() THEN RETURN FALSE;END IF;
   END LOOP;
   IF seen<>p_expected THEN RETURN FALSE;END IF;
   -- Positive writers still validate their own original full source vector.
   -- This guard does not replace, refresh, or weaken that authority check.
   RETURN TRUE;EXCEPTION WHEN lock_not_available THEN RETURN FALSE;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.check_memory_execution_processing_commit() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF EXISTS(SELECT 1 FROM shared.memory_source_processing_pins WHERE execution_id=NEW.execution_id
    AND (lease_until<=clock_timestamp() OR hard_deadline<=clock_timestamp())) THEN RAISE EXCEPTION 'source_processing_pin_unavailable' USING ERRCODE='55000';END IF;
   RETURN NULL;
  END $$`,
 `DROP TRIGGER IF EXISTS memory_execution_processing_commit ON shared.memory_source_executions;
  CREATE CONSTRAINT TRIGGER memory_execution_processing_commit AFTER UPDATE ON shared.memory_source_executions
   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shared.check_memory_execution_processing_commit()`,
 `CREATE OR REPLACE FUNCTION shared.release_memory_source_processing_pins(p_execution UUID)
  RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   DELETE FROM shared.memory_source_processing_pins WHERE execution_id=p_execution;
   RETURN TRUE;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.memory_source_processing_blocks_purge(p_owner INT,p_sessions TEXT[])
  RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE session_key TEXT;alias_ids TEXT[];BEGIN
   IF current_setting('transaction_isolation')<>'read committed' OR p_owner IS NULL OR p_owner<=0 OR p_sessions IS NULL
    OR cardinality(p_sessions) NOT BETWEEN 1 AND 4096 OR array_position(p_sessions,NULL) IS NOT NULL THEN RAISE EXCEPTION 'invalid_processing_pin_purge';END IF;
   IF NOT pg_try_advisory_xact_lock(p_owner::bigint) THEN RAISE EXCEPTION 'processing_pin_purge_busy';END IF;
   SELECT array_agg(DISTINCT id ORDER BY id) INTO alias_ids FROM unnest(p_sessions) requested
    CROSS JOIN LATERAL unnest(public.native_session_alias_set(ARRAY[requested])) id;
   IF cardinality(alias_ids)>4096 THEN RAISE EXCEPTION 'processing_pin_alias_limit';END IF;
   FOREACH session_key IN ARRAY alias_ids LOOP
    IF NOT pg_try_advisory_xact_lock(1885566061,hashtext(session_key)) THEN RAISE EXCEPTION 'processing_pin_purge_busy';END IF;
   END LOOP;
   FOR session_key IN SELECT DISTINCT unnest(p_sessions) ORDER BY 1 LOOP
    IF length(session_key) NOT BETWEEN 1 AND 512 OR NOT pg_try_advisory_xact_lock(1885566061,hashtext(session_key)) THEN RAISE EXCEPTION 'processing_pin_purge_busy';END IF;
    PERFORM 1 FROM public.sessions WHERE session_id=session_key AND user_id=p_owner FOR UPDATE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'processing_pin_purge_identity';END IF;
   END LOOP;
   RETURN EXISTS(SELECT 1 FROM shared.memory_source_processing_pins WHERE owner_user_id=p_owner AND session_id=ANY(alias_ids)
    AND lease_until>clock_timestamp() AND hard_deadline>clock_timestamp());
  END $$`,
 `REVOKE ALL ON shared.memory_source_processing_windows,shared.memory_source_processing_pins FROM PUBLIC`,
 `REVOKE ALL ON FUNCTION shared.acquire_memory_source_processing_pin(UUID,JSONB,TEXT,JSONB,BOOLEAN),shared.release_memory_source_processing_pins(UUID),shared.check_memory_source_processing_pin_commit(),shared.check_memory_execution_processing_commit(),shared.guard_memory_source_processing_pins(UUID,INT),shared.memory_source_processing_blocks_purge(INT,TEXT[]) FROM PUBLIC`,
 `UPDATE shared.memory_source_contract SET processing_pin_version=1 WHERE singleton`,
] as const
