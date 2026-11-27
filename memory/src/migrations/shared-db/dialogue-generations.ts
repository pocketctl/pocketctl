// The Relay write transaction captures one generation per affected turn. The
// pending row is a coalesced dispatch obligation; deleting it never deletes the
// input identity, completion receipt or coverage gap.
export const DIALOGUE_PROCESSOR_REVISION='dialogue-compile-v2'
export const DIALOGUE_GENERATIONS = [
  `ALTER TABLE memory.work_episodes ADD COLUMN IF NOT EXISTS dialogue_generation BIGINT`,
  `CREATE SEQUENCE IF NOT EXISTS memory.memory_dialogue_generation_seq AS bigint`,
  `CREATE TABLE IF NOT EXISTS memory.memory_dialogue_turns (
    installation_id UUID REFERENCES shared.memory_dialogue_installations ON DELETE CASCADE,
    session_id TEXT,turn_id TEXT,requested_generation BIGINT NOT NULL CHECK(requested_generation>0),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(installation_id,session_id,turn_id))`,
  `CREATE INDEX IF NOT EXISTS dialogue_turn_requested ON memory.memory_dialogue_turns(installation_id,requested_at DESC)`,
  `CREATE TABLE IF NOT EXISTS memory.memory_dialogue_compile_receipts (
    installation_id UUID,session_id TEXT,turn_id TEXT,generation BIGINT NOT NULL CHECK(generation>0),
    job_id UUID NOT NULL,claim_epoch BIGINT NOT NULL,status TEXT NOT NULL
      CHECK(status IN('published','not_admitted','input_gap','superseded','retrying','failed')),
    reason TEXT,input_digest TEXT,last_step TEXT,error_fingerprint TEXT,processor_revision TEXT,attempts INT NOT NULL DEFAULT 0,first_failed_at TIMESTAMPTZ,
    next_probe_at TIMESTAMPTZ,probes INT NOT NULL DEFAULT 0,closed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(installation_id,session_id,turn_id,generation),
    FOREIGN KEY(installation_id,session_id,turn_id) REFERENCES memory.memory_dialogue_turns ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS dialogue_compile_probes ON memory.memory_dialogue_compile_receipts(next_probe_at,job_id)
    WHERE next_probe_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS memory.memory_dialogue_legacy_failures (
    job_id UUID,claim_epoch BIGINT,installation_id UUID NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,
    generation BIGINT NOT NULL,dead_at TIMESTAMPTZ NOT NULL,payload_hash BYTEA NOT NULL,attempts INT NOT NULL,error_code TEXT NOT NULL,
    PRIMARY KEY(job_id,claim_epoch),FOREIGN KEY(installation_id,session_id,turn_id) REFERENCES memory.memory_dialogue_turns ON DELETE CASCADE)`,
  `ALTER TABLE shared.memory_dialogue_pending ADD COLUMN IF NOT EXISTS requested_generation BIGINT,
    ADD COLUMN IF NOT EXISTS next_dispatch_at timestamptz NOT NULL DEFAULT '-infinity',
    ADD COLUMN IF NOT EXISTS dispatch_attempts integer NOT NULL DEFAULT 0,ADD COLUMN IF NOT EXISTS dispatch_error text`,
  `CREATE OR REPLACE FUNCTION shared.advance_dialogue_generation() RETURNS TRIGGER
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
     IF TG_OP='UPDATE' THEN
      SELECT g.requested_generation INTO STRICT NEW.requested_generation FROM memory.memory_dialogue_turns g WHERE
       (g.installation_id,g.session_id,g.turn_id)=(NEW.installation_id,NEW.session_id,NEW.turn_id);
      RETURN NEW;
     END IF;
     INSERT INTO memory.memory_dialogue_turns(installation_id,session_id,turn_id,requested_generation)
       VALUES(NEW.installation_id,NEW.session_id,NEW.turn_id,nextval('memory.memory_dialogue_generation_seq')) ON CONFLICT(installation_id,session_id,turn_id)
       DO UPDATE SET requested_generation=nextval('memory.memory_dialogue_generation_seq'),requested_at=clock_timestamp() RETURNING requested_generation INTO NEW.requested_generation;
     RETURN NEW;
    END $$`,
  `REVOKE ALL ON FUNCTION shared.advance_dialogue_generation() FROM PUBLIC`,
  `DROP TRIGGER IF EXISTS advance_dialogue_generation ON shared.memory_dialogue_pending;
    CREATE TRIGGER advance_dialogue_generation BEFORE INSERT OR UPDATE ON shared.memory_dialogue_pending
     FOR EACH ROW EXECUTE FUNCTION shared.advance_dialogue_generation();
    INSERT INTO memory.memory_dialogue_turns(installation_id,session_id,turn_id,requested_generation,requested_at)
      SELECT installation_id,session_id,turn_id,nextval('memory.memory_dialogue_generation_seq'),enqueued_at FROM shared.memory_dialogue_pending p
     WHERE NOT EXISTS(SELECT 1 FROM memory.memory_dialogue_turns g WHERE (g.installation_id,g.session_id,g.turn_id)=(p.installation_id,p.session_id,p.turn_id)) ON CONFLICT DO NOTHING;
    UPDATE shared.memory_dialogue_pending SET touched_at=touched_at WHERE requested_generation IS NULL;
    ALTER TABLE shared.memory_dialogue_pending ALTER COLUMN requested_generation SET NOT NULL`,
  `INSERT INTO shared.memory_dialogue_pending(installation_id,session_id,turn_id)
    SELECT j.installation_id,j.payload->>'dialogue_session',j.payload->>'turn' FROM memory.memory_jobs j
     JOIN shared.memory_dialogue_installations policy USING(installation_id)
     WHERE j.job_type='compile_episode' AND j.state IN('pending','running') AND NOT (j.payload ? 'dialogue_generation')
      AND j.idempotency_key='dialogue:'||encode(sha256(convert_to(jsonb_build_array(j.payload->>'dialogue_session',j.payload->>'turn')::text,'UTF8')),'hex')
      AND COALESCE(j.payload->>'dialogue_session','')<>'' AND COALESCE(j.payload->>'turn','')<>''
      AND NOT EXISTS(SELECT 1 FROM memory.memory_dialogue_turns g WHERE g.installation_id=j.installation_id
       AND g.session_id=j.payload->>'dialogue_session' AND g.turn_id=j.payload->>'turn')
     ON CONFLICT DO NOTHING`,
  `CREATE INDEX IF NOT EXISTS memory_team_publication_execution ON memory.memory_team_semantic_publications(installation_id,publication_execution_id)`,
  `CREATE OR REPLACE FUNCTION shared.memory_team_stage_result(i uuid,j uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,shared AS $$
      SELECT p.disposition FROM shared.memory_source_executions e JOIN memory.memory_team_semantic_publications p
       ON p.installation_id=e.installation_id AND p.publication_execution_id=e.execution_id
       JOIN memory.memory_jobs job ON job.job_id=e.job_id AND job.installation_id=e.installation_id
       WHERE e.installation_id=i AND e.job_id=j AND e.branch='canonical-active' AND job.job_type='project_shared_source'
        AND p.source_kind=job.payload#>>'{root,kind}' AND p.disposition IN('published','policy_excluded','legacy_related')
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.source_roster->'roots') roster
          WHERE roster#>>'{root,key}'=job.payload#>>'{root,key}' AND roster#>>'{seal,scanId}'=job.payload->>'distribution_scan')
       LIMIT 1
    $$`,
  `REVOKE ALL ON FUNCTION shared.memory_team_stage_result(uuid,uuid) FROM PUBLIC`,
  `CREATE OR REPLACE FUNCTION shared.memory_dialogue_version(p_scope JSONB,p_root TEXT,p_turn TEXT)
   RETURNS TABLE(state TEXT,content_revision TEXT,authorization_revision TEXT,storage_revision TEXT)
   LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
    WITH a AS MATERIALIZED(SELECT * FROM shared.memory_relay_source_authority(p_scope,'relay_event',p_root)),
    producer AS (SELECT count(*)=3 AS valid FROM pg_trigger t JOIN pg_proc f ON f.oid=t.tgfoid
      WHERE t.tgrelid='public.events'::regclass AND t.tgname IN('turn_dialogue_insert','turn_dialogue_update','turn_dialogue_delete')
       AND t.tgenabled IN('O','A') AND f.oid=to_regprocedure('shared.capture_turn_dialogue()')
       AND position('Dialogue generation capture v2.' IN f.prosrc)>0)
    SELECT CASE WHEN g.requested_generation IS NULL OR NOT producer.valid THEN 'revoked' ELSE a.state END,
     COALESCE(g.requested_generation,0)::text,a.authorization_revision,a.storage_revision
     FROM a CROSS JOIN producer LEFT JOIN memory.memory_dialogue_turns g
      ON g.installation_id=(p_scope->>'installationId')::uuid AND g.session_id=substr(p_root,strpos(p_root,':')+1) AND g.turn_id=p_turn
   $$`,
  `REVOKE ALL ON FUNCTION shared.memory_dialogue_version(JSONB,TEXT,TEXT) FROM PUBLIC`,
  `CREATE OR REPLACE FUNCTION shared.dispatch_turn_dialogues() RETURNS INT LANGUAGE plpgsql
    SECURITY DEFINER SET search_path=pg_catalog,memory,shared SET lock_timeout='250ms' AS $$
    DECLARE dispatched INT:=0; recovered INT:=0; r RECORD; ctx JSONB; BEGIN
     FOR r IN SELECT p.* FROM shared.memory_dialogue_pending p WHERE p.next_dispatch_at<=clock_timestamp()
       ORDER BY p.enqueued_at,p.installation_id,p.session_id,p.turn_id LIMIT 64 FOR UPDATE SKIP LOCKED LOOP
      BEGIN
       INSERT INTO memory.memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload)
       VALUES(gen_random_uuid(),r.installation_id,'compile_episode','dialogue:'||encode(sha256(convert_to(jsonb_build_array(r.session_id,r.turn_id)::text,'UTF8')),'hex'),
        80,jsonb_build_object('dialogue_session',r.session_id,'turn',r.turn_id,'dialogue_generation',r.requested_generation::text))
       ON CONFLICT(installation_id,job_type,idempotency_key) DO UPDATE SET
        payload=excluded.payload,state=CASE WHEN memory_jobs.state='running' THEN 'running' ELSE 'pending' END,
        attempts=CASE WHEN memory_jobs.state='running' THEN memory_jobs.attempts ELSE 0 END,
        last_error_code=CASE WHEN memory_jobs.state='running' THEN 'rerun_required' END,available_at=clock_timestamp(),completed_at=NULL,priority=80
        WHERE CASE WHEN memory_jobs.payload->>'dialogue_generation' ~ '^[1-9][0-9]{0,18}$'
          THEN (memory_jobs.payload->>'dialogue_generation')::numeric NOT BETWEEN r.requested_generation AND 9223372036854775807
          ELSE TRUE END;
       DELETE FROM shared.memory_dialogue_pending WHERE (installation_id,session_id,turn_id)=(r.installation_id,r.session_id,r.turn_id);
       dispatched=dispatched+1;
      EXCEPTION WHEN OTHERS THEN
       UPDATE shared.memory_dialogue_pending SET dispatch_attempts=dispatch_attempts+1,dispatch_error=SQLSTATE,
        next_dispatch_at=clock_timestamp()+interval '1 minute'*LEAST(60,dispatch_attempts+1)
        WHERE (installation_id,session_id,turn_id)=(r.installation_id,r.session_id,r.turn_id);
      END;
     END LOOP;
     -- Fresh work gets a separate batch. Every probe takes the job first and
     -- uses only NOWAIT/try fences; a contended object cannot stop the batch.
     FOR r IN SELECT j.job_id,c.installation_id,c.session_id,c.turn_id,c.generation,c.probes
       FROM memory.memory_dialogue_compile_receipts c JOIN memory.memory_jobs j USING(job_id)
       JOIN memory.memory_dialogue_turns g ON (g.installation_id,g.session_id,g.turn_id)=(c.installation_id,c.session_id,c.turn_id)
       WHERE c.next_probe_at<=clock_timestamp() AND c.status='failed' AND
        (c.reason IN('lock_conflict','source_reference_unavailable','changed','revoked') OR c.processor_revision<>'${DIALOGUE_PROCESSOR_REVISION}')
        AND j.state='completed' AND g.requested_generation=c.generation
        AND j.payload->>'dialogue_generation'=c.generation::text
       ORDER BY c.next_probe_at,c.job_id LIMIT 4 FOR UPDATE OF j SKIP LOCKED LOOP
      BEGIN
       UPDATE memory.memory_dialogue_compile_receipts SET probes=probes+1,
        next_probe_at=clock_timestamp()+interval '1 minute'*LEAST(60,r.probes+1)
        WHERE job_id=r.job_id AND generation=r.generation AND status='failed';
       ctx=shared.memory_dialogue_context(r.installation_id,r.session_id);
       IF ctx IS NULL OR NOT shared.lock_memory_personal_source_commit(ctx->'scope','relay_event',ctx->>'root',ctx->'version',FALSE)
        OR NOT pg_try_advisory_xact_lock(hashtextextended('processing-pin:installation:'||r.installation_id::text,0))
        OR NOT pg_try_advisory_xact_lock(hashtextextended('processing-pin:root:'||(ctx->>'root'),0))
        OR NOT pg_try_advisory_xact_lock(hashtextextended('turn-dialogue:'||r.installation_id::text||':'||r.session_id||':'||r.turn_id,0))
        THEN CONTINUE;END IF;
       UPDATE memory.memory_jobs SET state='pending',available_at=clock_timestamp(),completed_at=NULL,priority=81,payload=payload||'{"failure_recovery":true}'::jsonb,
        claimed_by=NULL,claim_expires_at=NULL,last_error_code=NULL WHERE job_id=r.job_id;
       UPDATE memory.memory_dialogue_compile_receipts SET next_probe_at=NULL,status='retrying',updated_at=clock_timestamp()
        WHERE job_id=r.job_id AND generation=r.generation;
       recovered=recovered+1;
      EXCEPTION WHEN OTHERS THEN
       UPDATE memory.memory_dialogue_compile_receipts SET probes=probes+1,next_probe_at=clock_timestamp()+interval '5 minutes'
        WHERE job_id=r.job_id AND generation=r.generation AND status='failed';
      END;
     END LOOP;
     RETURN dispatched+recovered;
    END $$`,
  `CREATE OR REPLACE FUNCTION shared.supersede_dialogue_generation() RETURNS TRIGGER LANGUAGE plpgsql
   SECURITY DEFINER SET search_path=pg_catalog,memory AS $$ BEGIN
    IF OLD.job_type='compile_episode' AND OLD.payload->>'dialogue_generation' ~ '^[1-9][0-9]{0,18}$'
       AND (length(OLD.payload->>'dialogue_generation')<19 OR (OLD.payload->>'dialogue_generation') COLLATE "C"<='9223372036854775807')
       AND
       NEW.payload->>'dialogue_generation' IS DISTINCT FROM OLD.payload->>'dialogue_generation' THEN
     INSERT INTO memory.memory_dialogue_compile_receipts(installation_id,session_id,turn_id,generation,job_id,claim_epoch,status,reason,closed_at)
      VALUES(OLD.installation_id,OLD.payload->>'dialogue_session',OLD.payload->>'turn',(OLD.payload->>'dialogue_generation')::bigint,
       OLD.job_id,OLD.claim_epoch,'superseded','new_generation',clock_timestamp())
      ON CONFLICT(installation_id,session_id,turn_id,generation) DO UPDATE SET status='superseded',reason='new_generation',
       next_probe_at=NULL,closed_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE memory_dialogue_compile_receipts.status IN('retrying','failed');
    END IF; RETURN NULL;
   END $$`,
  `UPDATE memory.memory_dialogue_compile_receipts SET next_probe_at=clock_timestamp()
    WHERE status='failed' AND processor_revision<>'${DIALOGUE_PROCESSOR_REVISION}' AND next_probe_at IS NULL`,
  `CREATE OR REPLACE FUNCTION shared.clear_purged_dialogue_turns() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
    SET search_path=pg_catalog,shared AS $$ BEGIN
     DELETE FROM shared.memory_dialogue_pending WHERE installation_id=NEW.installation_id;
     DELETE FROM memory.memory_dialogue_turns WHERE installation_id=NEW.installation_id;
     RETURN NULL;END $$`,
  `REVOKE ALL ON FUNCTION shared.clear_purged_dialogue_turns() FROM PUBLIC;
    DROP TRIGGER IF EXISTS clear_purged_dialogue_turns ON memory.memory_installations;
    CREATE TRIGGER clear_purged_dialogue_turns AFTER UPDATE OF local_status,relay_status ON memory.memory_installations FOR EACH ROW
      WHEN (NEW.local_status IN('purging','purged') AND NEW.local_status IS DISTINCT FROM OLD.local_status
        OR NEW.relay_status='revoked' AND NEW.relay_status IS DISTINCT FROM OLD.relay_status)
      EXECUTE FUNCTION shared.clear_purged_dialogue_turns()`,
  `REVOKE ALL ON FUNCTION shared.supersede_dialogue_generation() FROM PUBLIC;
   DROP TRIGGER IF EXISTS supersede_dialogue_generation ON memory.memory_jobs;
   CREATE TRIGGER supersede_dialogue_generation AFTER UPDATE OF payload ON memory.memory_jobs
    FOR EACH ROW WHEN (OLD.job_type='compile_episode' AND OLD.payload ? 'dialogue_generation' AND
     OLD.payload->>'dialogue_generation' IS DISTINCT FROM NEW.payload->>'dialogue_generation') EXECUTE FUNCTION shared.supersede_dialogue_generation()`,
  `DO $$ BEGIN IF to_regprocedure('memory.memory_forget_turn_failures()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS memory_clear_turn_failures ON memory.memory_dialogue_turns;
    CREATE TRIGGER memory_clear_turn_failures AFTER DELETE ON memory.memory_dialogue_turns
      FOR EACH ROW EXECUTE FUNCTION memory.memory_forget_turn_failures(); END IF;END $$`,
] as const
