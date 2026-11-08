const featureFacts=(rows:string)=>`SELECT installation_id,jsonb_build_array(extraction_mode,embedding_mode,extraction_consent_fingerprint,embedding_consent_fingerprint) AS policy FROM ${rows}`
const featureChanges=(rows:string)=>`FOR changed_installation IN SELECT DISTINCT installation_id FROM (${rows}) changed
 WHERE policy<>'["off","off",null,null]'::jsonb ORDER BY installation_id LOOP
 PERFORM shared.mark_memory_control_dirty('local',changed_installation::text);END LOOP;`
/** Current controls have their own coalesced metadata stream. Relay commits
 * never enumerate Memory installations or copy a source/control body. */
export const SHARED_SOURCE_CONTROL_FUNCTIONS=[
 `ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS control_version INT NOT NULL DEFAULT 0`,
 `CREATE TABLE IF NOT EXISTS shared.memory_source_control_clock(
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),revision BIGINT NOT NULL CHECK(revision>0))`,
 `INSERT INTO shared.memory_source_control_clock VALUES(TRUE,1) ON CONFLICT DO NOTHING`,
 `CREATE TABLE IF NOT EXISTS shared.memory_source_control_work(
  control_kind TEXT NOT NULL CHECK(control_kind IN('provider','installation','user','scope','collaboration_team','collaboration_session','daemon','offer','mode','local')),
  control_key TEXT NOT NULL CHECK(length(control_key) BETWEEN 1 AND 2048),revision BIGINT NOT NULL CHECK(revision>0),
  processed_revision BIGINT NOT NULL DEFAULT 0 CHECK(processed_revision>=0 AND processed_revision<=revision),
  available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_owner TEXT,lease_token UUID,lease_until TIMESTAMPTZ,claimed_revision BIGINT,attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 32),
  dead_at TIMESTAMPTZ,last_error_code TEXT CHECK(last_error_code IN('temporary_unavailable','version_changed','source_unavailable','retry_exhausted')),
  PRIMARY KEY(control_kind,control_key),
  CHECK((lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL AND claimed_revision IS NULL)
   OR COALESCE(length(lease_owner) BETWEEN 1 AND 128 AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND claimed_revision BETWEEN 1 AND revision,FALSE)))`,
 `CREATE INDEX IF NOT EXISTS memory_source_control_work_pending ON shared.memory_source_control_work(available_at,updated_at,control_kind,control_key)
  WHERE dead_at IS NULL AND processed_revision<revision`,
 `CREATE OR REPLACE FUNCTION shared.mark_memory_control_dirty(p_kind TEXT,p_key TEXT) RETURNS BIGINT
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE r BIGINT;BEGIN
   IF p_kind IS NULL OR p_kind NOT IN('provider','installation','user','scope','collaboration_team','collaboration_session','daemon','offer','mode','local')
    OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 2048 THEN RAISE EXCEPTION 'invalid_source_control';END IF;
   -- AFTER capture may already hold native authority rows. Never add a
   -- reverse wait behind another control writer or a final consumer fence.
   PERFORM 1 FROM shared.memory_source_control_clock WHERE singleton FOR UPDATE NOWAIT;
   UPDATE shared.memory_source_control_clock SET revision=revision+1 WHERE singleton RETURNING revision INTO r;
   IF r IS NULL THEN RAISE EXCEPTION 'source_control_contract_missing';END IF;
   INSERT INTO shared.memory_source_control_work(control_kind,control_key,revision) VALUES(p_kind,p_key,r)
    ON CONFLICT(control_kind,control_key) DO UPDATE SET revision=r,updated_at=clock_timestamp(),
     available_at=CASE WHEN memory_source_control_work.lease_token IS NULL THEN clock_timestamp() ELSE memory_source_control_work.available_at END,
     dead_at=NULL,attempt=CASE WHEN memory_source_control_work.lease_token IS NULL THEN 0 ELSE memory_source_control_work.attempt END;
   RETURN r;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.memory_source_control_snapshot() RETURNS TEXT
  LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ SELECT revision::text FROM shared.memory_source_control_clock WHERE singleton $$`,
 `CREATE OR REPLACE FUNCTION shared.guard_memory_control_commit(p_expected BIGINT) RETURNS BOOLEAN
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE r BIGINT;BEGIN
   SELECT revision INTO r FROM shared.memory_source_control_clock WHERE singleton FOR SHARE NOWAIT;
   RETURN COALESCE(r=p_expected,FALSE);
   EXCEPTION WHEN lock_not_available THEN RETURN FALSE;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.claim_memory_control_work(p_worker TEXT,p_seconds INT,p_limit INT)
  RETURNS SETOF shared.memory_source_control_work LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 128 OR p_seconds IS NULL OR p_seconds NOT BETWEEN 5 AND 300
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'invalid_control_claim';END IF;
   WITH exhausted AS(SELECT control_kind,control_key FROM shared.memory_source_control_work WHERE dead_at IS NULL AND attempt>=32
    AND(lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY available_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
    UPDATE shared.memory_source_control_work w SET dead_at=clock_timestamp(),last_error_code='retry_exhausted',
     lease_owner=NULL,lease_token=NULL,lease_until=NULL,claimed_revision=NULL FROM exhausted e WHERE(w.control_kind,w.control_key)=(e.control_kind,e.control_key);
   RETURN QUERY WITH candidates AS(SELECT control_kind,control_key FROM shared.memory_source_control_work WHERE dead_at IS NULL AND attempt<32
    AND processed_revision<revision AND available_at<=clock_timestamp() AND(lease_until IS NULL OR lease_until<=clock_timestamp())
    ORDER BY available_at,updated_at,control_kind,control_key LIMIT p_limit FOR UPDATE SKIP LOCKED)
    UPDATE shared.memory_source_control_work w SET lease_owner=p_worker,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+make_interval(secs=>p_seconds),
     claimed_revision=w.revision,attempt=w.attempt+1,updated_at=clock_timestamp() FROM candidates c
    WHERE(w.control_kind,w.control_key)=(c.control_kind,c.control_key) RETURNING w.*;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.assert_memory_control_lease(p_kind TEXT,p_key TEXT,p_token UUID,p_worker TEXT,p_revision BIGINT) RETURNS BOOLEAN
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   PERFORM 1 FROM shared.memory_source_control_work WHERE control_kind=p_kind AND control_key=p_key AND lease_token=p_token AND lease_owner=p_worker
    AND claimed_revision=p_revision AND lease_until>clock_timestamp() AND dead_at IS NULL FOR UPDATE NOWAIT;
   RETURN FOUND;EXCEPTION WHEN lock_not_available THEN RETURN FALSE;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.ack_memory_control_work(p_kind TEXT,p_key TEXT,p_token UUID,p_worker TEXT,p_revision BIGINT) RETURNS BOOLEAN
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   UPDATE shared.memory_source_control_work SET processed_revision=GREATEST(processed_revision,p_revision),lease_owner=NULL,lease_token=NULL,
    lease_until=NULL,claimed_revision=NULL,attempt=0,last_error_code=NULL,available_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE control_kind=p_kind AND control_key=p_key AND lease_token=p_token AND lease_owner=p_worker AND claimed_revision=p_revision
     AND lease_until>clock_timestamp() AND dead_at IS NULL;
   RETURN FOUND;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.renew_memory_control_lease(p_kind TEXT,p_key TEXT,p_token UUID,p_worker TEXT,p_revision BIGINT,p_seconds INT)
  RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF p_seconds IS NULL OR p_seconds NOT BETWEEN 5 AND 300 THEN RAISE EXCEPTION 'invalid_control_claim';END IF;
   IF NOT shared.assert_memory_control_lease(p_kind,p_key,p_token,p_worker,p_revision) THEN RETURN FALSE;END IF;
   UPDATE shared.memory_source_control_work SET lease_until=clock_timestamp()+make_interval(secs=>p_seconds)
    WHERE(control_kind,control_key)=(p_kind,p_key);RETURN TRUE;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.fail_memory_control_work(p_kind TEXT,p_key TEXT,p_token UUID,p_worker TEXT,p_revision BIGINT,p_code TEXT) RETURNS BOOLEAN
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF p_code IS NULL OR p_code NOT IN('temporary_unavailable','version_changed','source_unavailable') THEN RAISE EXCEPTION 'invalid_control_error';END IF;
   UPDATE shared.memory_source_control_work SET dead_at=CASE WHEN attempt>=32 THEN clock_timestamp() ELSE NULL END,last_error_code=p_code,
    lease_owner=NULL,lease_token=NULL,lease_until=NULL,claimed_revision=NULL,
    available_at=clock_timestamp()+make_interval(secs=>LEAST(3600,5*power(2,LEAST(attempt-1,10)))::int),updated_at=clock_timestamp()
    WHERE control_kind=p_kind AND control_key=p_key AND lease_token=p_token AND lease_owner=p_worker AND claimed_revision=p_revision
     AND lease_until>clock_timestamp() AND dead_at IS NULL;
   RETURN FOUND;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.mark_memory_control_dirty(TEXT,TEXT),shared.memory_source_control_snapshot(),shared.guard_memory_control_commit(BIGINT),
  shared.claim_memory_control_work(TEXT,INT,INT),shared.assert_memory_control_lease(TEXT,TEXT,UUID,TEXT,BIGINT),
  shared.ack_memory_control_work(TEXT,TEXT,UUID,TEXT,BIGINT),shared.fail_memory_control_work(TEXT,TEXT,UUID,TEXT,BIGINT,TEXT) FROM PUBLIC`,
 `CREATE OR REPLACE FUNCTION shared.capture_memory_feature_controls() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE changed_installation UUID;BEGIN
   IF TG_OP='INSERT' THEN ${featureChanges(featureFacts('feature_new'))}
   ELSIF TG_OP='DELETE' THEN ${featureChanges(featureFacts('feature_old'))}
   ELSE ${featureChanges('('+featureFacts('feature_new')+' EXCEPT '+featureFacts('feature_old')+') UNION ('+featureFacts('feature_old')+' EXCEPT '+featureFacts('feature_new')+')')}
   END IF;RETURN NULL;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.capture_memory_feature_controls() FROM PUBLIC`,
 `REVOKE ALL ON FUNCTION shared.renew_memory_control_lease(TEXT,TEXT,UUID,TEXT,BIGINT,INT) FROM PUBLIC`,
 ...(['INSERT','UPDATE','DELETE'] as const).map(op=>`DO $$ BEGIN IF to_regclass('memory.memory_feature_settings') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS memory_feature_control_${op.toLowerCase()} ON memory.memory_feature_settings;
  CREATE TRIGGER memory_feature_control_${op.toLowerCase()} AFTER ${op} ON memory.memory_feature_settings
   REFERENCING ${op!=='INSERT'?'OLD TABLE AS feature_old ':''}${op!=='DELETE'?'NEW TABLE AS feature_new ':''}
   FOR EACH STATEMENT EXECUTE FUNCTION shared.capture_memory_feature_controls();END IF;END $$`),
 `UPDATE shared.memory_source_contract SET control_version=1 WHERE singleton`,
] as const
