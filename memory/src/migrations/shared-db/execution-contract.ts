/** Durable execution metadata only. Admission commits before external IO;
 * returned effects remain recordable after job, mode or source invalidation. */
export const SHARED_SOURCE_EXECUTION_FUNCTIONS=[
 `CREATE TABLE IF NOT EXISTS shared.memory_source_executions(
  execution_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),job_id UUID NOT NULL,worker TEXT NOT NULL CHECK(length(worker) BETWEEN 1 AND 128),
  claim_epoch BIGINT NOT NULL CHECK(claim_epoch>0),installation_id UUID NOT NULL,generation BIGINT NOT NULL CHECK(generation>0),
  branch TEXT NOT NULL CHECK(branch IN('legacy-active','canonical-active','canonical-shadow')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),last_guarded_at TIMESTAMPTZ,UNIQUE(job_id,claim_epoch))`,
 `ALTER TABLE shared.memory_source_executions ADD COLUMN IF NOT EXISTS last_guarded_at TIMESTAMPTZ`,
 `ALTER TABLE shared.memory_source_executions ADD COLUMN IF NOT EXISTS last_compared_at TIMESTAMPTZ`,
 `ALTER TABLE shared.memory_source_executions ADD COLUMN IF NOT EXISTS control_revision BIGINT CHECK(control_revision>0)`,
 `CREATE TABLE IF NOT EXISTS shared.memory_source_provider_attempts(
  execution_id UUID NOT NULL REFERENCES shared.memory_source_executions(execution_id),reservation_id UUID NOT NULL,
  request_hash TEXT NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK(state IN('inflight','accounted','uncertain','not-sent')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),finished_at TIMESTAMPTZ,
  PRIMARY KEY(execution_id,reservation_id),CHECK((state='inflight')=(finished_at IS NULL)))`,
 `CREATE INDEX IF NOT EXISTS memory_source_executions_installation ON shared.memory_source_executions(installation_id,execution_id)`,
 `CREATE INDEX IF NOT EXISTS memory_source_provider_inflight ON shared.memory_source_provider_attempts(execution_id) WHERE state='inflight'`,
 `CREATE UNIQUE INDEX IF NOT EXISTS memory_source_provider_reservation ON shared.memory_source_provider_attempts(reservation_id)`,
 `CREATE OR REPLACE FUNCTION shared.capture_memory_job_source(p_job UUID,p_worker TEXT,p_epoch BIGINT,p_branch TEXT)
  RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE j RECORD;m RECORD;e RECORD;control_clock BIGINT;BEGIN
   IF p_job IS NULL OR p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 128 OR p_epoch IS NULL OR p_epoch<=0
    OR p_branch IS NULL OR p_branch NOT IN('active','canonical','legacy-active','canonical-active','canonical-shadow') THEN RAISE EXCEPTION 'invalid_source_execution';END IF;
   SELECT installation_id INTO j FROM memory.memory_jobs WHERE job_id=p_job;
   IF NOT FOUND OR j.installation_id IS NULL THEN RAISE EXCEPTION 'source_execution_job_unavailable';END IF;
   INSERT INTO shared.memory_source_modes(installation_id) SELECT j.installation_id WHERE NOT EXISTS(SELECT 1 FROM shared.memory_source_modes WHERE installation_id=j.installation_id) ON CONFLICT DO NOTHING;
   SELECT mode,generation INTO m FROM shared.memory_source_modes WHERE installation_id=j.installation_id FOR SHARE NOWAIT;
   IF p_branch='active' THEN p_branch=CASE WHEN m.mode='shared-active' THEN 'canonical-active' ELSE 'legacy-active' END;END IF;
   IF p_branch='canonical' THEN
    IF m.mode NOT IN('shared-shadow','shared-active') THEN RAISE EXCEPTION 'source_execution_generation_changed';END IF;
    p_branch=CASE WHEN m.mode='shared-active' THEN 'canonical-active' ELSE 'canonical-shadow' END;
   END IF;
   IF NOT((p_branch='legacy-active' AND m.mode IN('legacy-feed','shared-shadow')) OR(p_branch='canonical-active' AND m.mode='shared-active')
     OR(p_branch='canonical-shadow' AND m.mode='shared-shadow')) THEN RAISE EXCEPTION 'source_execution_generation_changed';END IF;
   PERFORM 1 FROM memory.memory_jobs WHERE job_id=p_job AND installation_id=j.installation_id AND claimed_by=p_worker
    AND claim_epoch=p_epoch AND state='running' AND claim_expires_at>clock_timestamp() FOR SHARE NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION 'source_execution_job_unavailable';END IF;
   control_clock=shared.memory_source_control_snapshot()::bigint;
   IF control_clock IS NULL THEN RAISE EXCEPTION 'source_control_contract_missing';END IF;
   INSERT INTO shared.memory_source_executions(job_id,worker,claim_epoch,installation_id,generation,branch,control_revision)
    VALUES(p_job,p_worker,p_epoch,j.installation_id,m.generation,p_branch,control_clock) ON CONFLICT(job_id,claim_epoch) DO NOTHING;
   SELECT * INTO e FROM shared.memory_source_executions WHERE job_id=p_job AND claim_epoch=p_epoch;
   IF(e.worker,e.installation_id,e.generation,e.branch,e.control_revision) IS DISTINCT FROM(p_worker,j.installation_id,m.generation,p_branch,control_clock)
    THEN RAISE EXCEPTION 'source_execution_generation_changed';END IF;
   RETURN jsonb_build_object('executionId',e.execution_id,'installationId',e.installation_id,'generation',e.generation::text,'claimEpoch',e.claim_epoch::text,'branch',e.branch,'controlRevision',e.control_revision::text);
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.assert_memory_job_source(p_execution UUID,p_purpose TEXT)
  RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE e RECORD;m RECORD;stamp JSONB;BEGIN
   IF p_purpose IS NULL OR p_purpose NOT IN('provider','publish','compare') THEN RAISE EXCEPTION 'invalid_source_execution_purpose';END IF;
   SELECT * INTO e FROM shared.memory_source_executions WHERE execution_id=p_execution;
   IF NOT FOUND THEN RETURN FALSE;END IF;
   IF e.control_revision IS NULL OR e.control_revision::text IS DISTINCT FROM shared.memory_source_control_snapshot() THEN RETURN FALSE;END IF;
   SELECT mode,generation INTO m FROM shared.memory_source_modes WHERE installation_id=e.installation_id FOR SHARE NOWAIT;
   IF NOT FOUND OR m.generation<>e.generation OR NOT((e.branch='legacy-active' AND m.mode IN('legacy-feed','shared-shadow'))
    OR(e.branch='canonical-active' AND m.mode='shared-active') OR(e.branch='canonical-shadow' AND m.mode='shared-shadow' AND p_purpose='compare')) THEN RETURN FALSE;END IF;
   stamp=NULLIF(current_setting('pocketctl.job_fence',TRUE),'')::jsonb;
   PERFORM 1 FROM memory.memory_jobs WHERE job_id=e.job_id AND installation_id=e.installation_id AND claim_epoch=e.claim_epoch
    AND ((state='running' AND claimed_by=e.worker AND claim_expires_at>clock_timestamp())
     OR(p_purpose='publish' AND stamp->>'jobId'=e.job_id::text AND stamp->>'claimedBy'=e.worker AND stamp->>'claimEpoch'=e.claim_epoch::text
       AND clock_timestamp()<(stamp->>'leaseUntil')::timestamptz
       AND((state='completed' AND claimed_by=e.worker AND completed_at<=(stamp->>'leaseUntil')::timestamptz)
        OR(state='pending' AND stamp->>'releaseState'='pending' AND claimed_by IS NULL AND claim_expires_at IS NULL)))) FOR SHARE NOWAIT;
   RETURN FOUND;
   EXCEPTION WHEN lock_not_available THEN RETURN FALSE;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.guard_memory_job_source_commit(p_execution UUID)
  RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF NOT shared.assert_memory_job_source(p_execution,'publish') THEN RETURN FALSE;END IF;
   PERFORM 1 FROM shared.memory_source_executions WHERE execution_id=p_execution FOR UPDATE NOWAIT;
   IF NOT FOUND THEN RETURN FALSE;END IF;
   UPDATE shared.memory_source_executions SET last_guarded_at=clock_timestamp() WHERE execution_id=p_execution;
   RETURN TRUE;
   EXCEPTION WHEN lock_not_available THEN RETURN FALSE;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.guard_memory_job_source_comparison(p_execution UUID)
  RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF NOT shared.assert_memory_job_source(p_execution,'compare') THEN RETURN FALSE;END IF;
   PERFORM 1 FROM shared.memory_source_executions WHERE execution_id=p_execution AND branch='canonical-shadow' FOR UPDATE NOWAIT;
   IF NOT FOUND THEN RETURN FALSE;END IF;
   UPDATE shared.memory_source_executions SET last_compared_at=clock_timestamp() WHERE execution_id=p_execution;
   RETURN TRUE;EXCEPTION WHEN lock_not_available THEN RETURN FALSE;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.start_memory_source_provider(p_execution UUID,p_reservation UUID,p_request_hash TEXT)
  RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF p_reservation IS NULL OR p_request_hash IS NULL OR p_request_hash!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid_source_provider_attempt';END IF;
   IF NOT shared.assert_memory_job_source(p_execution,'provider') THEN RETURN FALSE;END IF;
   PERFORM 1 FROM memory.memory_provider_budget_reservations WHERE reservation_id=p_reservation AND state='reserved' FOR SHARE NOWAIT;
   IF NOT FOUND THEN RETURN FALSE;END IF;
   INSERT INTO shared.memory_source_provider_attempts(execution_id,reservation_id,request_hash,state)
    VALUES(p_execution,p_reservation,p_request_hash,'inflight') ON CONFLICT DO NOTHING;
   RETURN FOUND;
   EXCEPTION WHEN lock_not_available THEN RETURN FALSE;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.finish_memory_source_provider(p_execution UUID,p_reservation UUID,p_state TEXT)
  RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF p_state IS NULL OR p_state NOT IN('accounted','uncertain','not-sent') THEN RAISE EXCEPTION 'invalid_source_provider_effect';END IF;
   UPDATE shared.memory_source_provider_attempts SET state=p_state,finished_at=clock_timestamp()
    WHERE execution_id=p_execution AND reservation_id=p_reservation AND state='inflight';
   IF FOUND THEN RETURN TRUE;END IF;
   RETURN EXISTS(SELECT 1 FROM shared.memory_source_provider_attempts WHERE execution_id=p_execution AND reservation_id=p_reservation AND state=p_state);
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.check_memory_source_execution_commit() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE control_clock BIGINT;purpose TEXT='compare';BEGIN
   IF TG_TABLE_NAME='memory_source_provider_attempts' THEN purpose='provider';
   ELSIF TG_OP='UPDATE' THEN
    IF NEW.last_guarded_at IS DISTINCT FROM OLD.last_guarded_at OR NEW.last_compared_at IS NOT DISTINCT FROM OLD.last_compared_at THEN purpose='publish';END IF;
   END IF;
   IF NOT shared.assert_memory_job_source(NEW.execution_id,purpose)
    THEN RAISE EXCEPTION 'source_execution_generation_changed' USING ERRCODE='55000';END IF;
   SELECT control_revision INTO control_clock FROM shared.memory_source_executions WHERE execution_id=NEW.execution_id;
   IF NOT shared.guard_memory_control_commit(control_clock) THEN RAISE EXCEPTION 'source_execution_generation_changed' USING ERRCODE='55000';END IF;
   RETURN NULL;
  END $$`,
 `DROP TRIGGER IF EXISTS memory_source_execution_commit ON shared.memory_source_executions;
  CREATE CONSTRAINT TRIGGER memory_source_execution_commit AFTER INSERT OR UPDATE ON shared.memory_source_executions
   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shared.check_memory_source_execution_commit()`,
 `DROP TRIGGER IF EXISTS memory_source_provider_commit ON shared.memory_source_provider_attempts;
  CREATE CONSTRAINT TRIGGER memory_source_provider_commit AFTER INSERT ON shared.memory_source_provider_attempts
   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shared.check_memory_source_execution_commit()`,
 `REVOKE ALL ON FUNCTION shared.capture_memory_job_source(UUID,TEXT,BIGINT,TEXT),shared.assert_memory_job_source(UUID,TEXT),shared.guard_memory_job_source_commit(UUID),
  shared.start_memory_source_provider(UUID,UUID,TEXT),shared.finish_memory_source_provider(UUID,UUID,TEXT),shared.check_memory_source_execution_commit() FROM PUBLIC`,
 `REVOKE ALL ON FUNCTION shared.guard_memory_job_source_comparison(UUID) FROM PUBLIC`,
] as const
