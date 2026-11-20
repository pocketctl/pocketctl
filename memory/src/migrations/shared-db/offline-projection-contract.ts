export const APPEND_CAPTURE_V1_SHA256='9994082cfa6f1bba3789d62f4483a11946c45b06da0033f3036c52d60b1a4ac2'

// Only the migrator can enroll installations. Keep one open accumulator per
// root; frozen evidence travels with the immutable distribution scan.
export const OFFLINE_PROJECTION_SCHEMA = [
 `CREATE TABLE IF NOT EXISTS shared.memory_projection_policies (
   installation_id UUID PRIMARY KEY REFERENCES public.extension_installations(installation_id) ON DELETE CASCADE,
   mode TEXT NOT NULL CHECK(mode IN ('shadow','active')))`,
 `CREATE TABLE IF NOT EXISTS shared.memory_projection_windows (
   root_key TEXT PRIMARY KEY, first_revision BIGINT NOT NULL,last_revision BIGINT NOT NULL,
   first_id BIGINT,last_id BIGINT,late_ids BIGINT[] NOT NULL,
   due_at TIMESTAMPTZ NOT NULL, CHECK(first_revision<=last_revision))`,
 `ALTER TABLE shared.memory_source_work ADD COLUMN IF NOT EXISTS offline_claim JSONB`,
 `ALTER TABLE memory.memory_canonical_projection_progress ADD COLUMN IF NOT EXISTS offline_basis JSONB`,
] as const

export const OFFLINE_PROJECTION_DISTRIBUTION = [
 `CREATE OR REPLACE FUNCTION shared.freeze_memory_projection_window() RETURNS TRIGGER
 LANGUAGE plpgsql SET search_path=pg_catalog,shared AS $$ DECLARE
  w shared.memory_projection_windows; previous JSONB=OLD.offline_claim; native JSONB; sid TEXT; upper_id BIGINT;
 BEGIN
  IF NEW.offline_claim->>'revision'=NEW.claimed_revision::text THEN RETURN NEW; END IF;
  NEW.offline_claim=NULL;
  DELETE FROM shared.memory_projection_windows WHERE root_key=NEW.root_key AND last_revision<=NEW.claimed_revision RETURNING * INTO w;
  IF NOT EXISTS(SELECT 1 FROM shared.memory_projection_policies p JOIN public.extension_installations i USING(installation_id)
    WHERE i.owner_user_id=split_part(NEW.root_key,':',1)::int) THEN RETURN NEW; END IF;
  -- Aliases can contribute multiple work revisions to a single source version.
  -- Only the unchanged native, single-root identity has a 1:1 revision proof.
  sid=substr(NEW.root_key,strpos(NEW.root_key,':')+1);
  native=public.native_session_authority(sid,split_part(NEW.root_key,':',1)::int,NULL);
  IF native->>'state' IS DISTINCT FROM 'current' OR native->'sessionIds' IS DISTINCT FROM jsonb_build_array(sid)
    OR native->>'revision' IS DISTINCT FROM '0' THEN RETURN NEW; END IF;
  SELECT id INTO upper_id FROM public.events WHERE session_id=sid ORDER BY id DESC LIMIT 1;
  NEW.offline_claim=jsonb_build_object('revision',NEW.claimed_revision::text,'upper',COALESCE(upper_id,0)::text,'native',encode(sha256(convert_to(native::text,'UTF8')),'hex'));
  -- A previous scan may still own its jobs while the scheduler repeatedly
  -- renews a newer claim. Carry forward the unassigned prefix through those
  -- renewals. Once a distribution owns it, its target receipts cover it.
  IF w.last_revision=NEW.claimed_revision AND previous ? 'firstRevision'
    AND previous->>'native'=NEW.offline_claim->>'native'
    AND (previous->>'revision')::bigint+1=w.first_revision
    AND NOT EXISTS(SELECT 1 FROM shared.memory_source_distributions d WHERE d.source_kind=NEW.source_kind
      AND d.root_key=NEW.root_key AND d.work_revision=(previous->>'revision')::bigint) THEN
   w.first_revision=(previous->>'firstRevision')::bigint;
   w.first_id=least(w.first_id,(previous->>'lo')::bigint);
   w.last_id=greatest(w.last_id,(previous->>'hi')::bigint);
   SELECT ARRAY(SELECT DISTINCT id FROM (
     SELECT unnest(w.late_ids) AS id UNION ALL SELECT value::bigint FROM jsonb_array_elements_text(previous->'late')
    ) q WHERE NOT COALESCE(id BETWEEN w.first_id AND w.last_id,FALSE) ORDER BY id) INTO w.late_ids;
   IF cardinality(w.late_ids)>64 THEN RETURN NEW; END IF;
  END IF;
  IF w.last_revision=NEW.claimed_revision THEN
   NEW.offline_claim=NEW.offline_claim||jsonb_build_object('firstRevision',w.first_revision::text,
    'lo',w.first_id::text,'hi',w.last_id::text,'late',to_jsonb(w.late_ids::text[]));
  END IF;
  RETURN NEW;
 END $$`,
 `DROP TRIGGER IF EXISTS freeze_memory_projection_window ON shared.memory_source_work;
  CREATE TRIGGER freeze_memory_projection_window BEFORE UPDATE OF claimed_revision ON shared.memory_source_work
  FOR EACH ROW WHEN (NEW.source_kind='relay_event' AND NEW.claimed_revision=NEW.revision)
  EXECUTE FUNCTION shared.freeze_memory_projection_window()`,
 `CREATE OR REPLACE FUNCTION shared.bind_memory_projection_batch() RETURNS TRIGGER
 LANGUAGE plpgsql SET search_path=pg_catalog,shared AS $$ BEGIN
  IF TG_OP='UPDATE' AND OLD.offline_batch IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM shared.memory_source_distribution_targets WHERE scan_id=OLD.scan_id AND offline_batch IS NOT NULL AND offline_ack IS NULL) THEN
   UPDATE shared.memory_source_distribution_targets SET offline_batch=NULL WHERE scan_id=OLD.scan_id AND offline_batch IS NOT NULL;
  END IF;
  SELECT offline_claim INTO NEW.offline_batch FROM shared.memory_source_work WHERE source_kind=NEW.source_kind
    AND root_key=NEW.root_key AND offline_claim->>'revision'=NEW.work_revision::text;
  RETURN NEW;
 END $$`,
 `DROP TRIGGER IF EXISTS bind_memory_projection_batch ON shared.memory_source_distributions;
  CREATE TRIGGER bind_memory_projection_batch BEFORE INSERT OR UPDATE OF scan_id ON shared.memory_source_distributions
  FOR EACH ROW WHEN (NEW.source_kind='relay_event') EXECUTE FUNCTION shared.bind_memory_projection_batch()`,
 `CREATE OR REPLACE FUNCTION shared.bind_memory_projection_target() RETURNS TRIGGER
 LANGUAGE plpgsql SET search_path=pg_catalog,shared AS $$ BEGIN
  SELECT d.offline_batch||jsonb_build_object('mode',p.mode) INTO NEW.offline_batch
   FROM shared.memory_source_distributions d JOIN shared.memory_projection_policies p ON p.installation_id=NEW.installation_id
   WHERE d.scan_id=NEW.scan_id AND d.offline_batch IS NOT NULL;
  RETURN NEW;
 END $$`,
 `DROP TRIGGER IF EXISTS bind_memory_projection_target ON shared.memory_source_distribution_targets;
  CREATE TRIGGER bind_memory_projection_target BEFORE INSERT ON shared.memory_source_distribution_targets
  FOR EACH ROW WHEN (NEW.target_mode='shared-active' AND NEW.state='current') EXECUTE FUNCTION shared.bind_memory_projection_target()`,
 `CREATE OR REPLACE FUNCTION shared.classify_memory_projection_job() RETURNS TRIGGER
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
  IF NEW.payload->>'distribution_scan' !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM shared.memory_source_distribution_targets t WHERE t.scan_id=(NEW.payload->>'distribution_scan')::uuid
   AND t.cursor_key=NEW.payload->>'target_cursor' AND t.installation_id=NEW.installation_id AND t.offline_batch->>'mode'='active')
   THEN NEW.payload=NEW.payload||'{"offline_projection":true}'::jsonb; END IF;
  RETURN NEW;
 END $$`,
 `DROP TRIGGER IF EXISTS classify_memory_projection_job ON memory.memory_jobs;
  CREATE TRIGGER classify_memory_projection_job BEFORE INSERT ON memory.memory_jobs
  FOR EACH ROW WHEN (NEW.job_type='project_shared_source' AND NEW.payload ? 'distribution_scan')
  EXECUTE FUNCTION shared.classify_memory_projection_job()`,
 `CREATE OR REPLACE FUNCTION shared.ack_memory_projection_target() RETURNS TRIGGER
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
  UPDATE shared.memory_source_distribution_targets t SET offline_ack=NEW.offline_basis
   WHERE t.scan_id=(NEW.offline_basis->>'scanId')::uuid AND t.installation_id=NEW.installation_id
    AND shared.memory_source_scope_key(t.source_scope)=NEW.context_key AND t.offline_batch IS NOT NULL
    AND EXISTS(SELECT 1 FROM shared.memory_source_distributions d WHERE d.scan_id=t.scan_id
     AND d.root_key=NEW.root_key AND d.source_kind=NEW.source_kind AND NEW.offline_basis->'version'->>'content'=d.work_revision::text);
  RETURN NEW;
 END $$`,
 `DROP TRIGGER IF EXISTS ack_memory_projection_target ON memory.memory_canonical_projection_progress;
  CREATE TRIGGER ack_memory_projection_target AFTER INSERT OR UPDATE OF offline_basis ON memory.memory_canonical_projection_progress
  FOR EACH ROW WHEN (NEW.offline_basis->>'covered'='true') EXECUTE FUNCTION shared.ack_memory_projection_target()`,
 `CREATE OR REPLACE FUNCTION shared.memory_projection_capture_installed() RETURNS BOOLEAN
 LANGUAGE SQL STABLE SET search_path=pg_catalog AS $$ SELECT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('shared.capture_memory_projection_window()') AND p.prosecdef
    AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='ea1d58ae400cd3751be08e14eac82ffdfeb56b6541b4f81806b4b9b474873722'
    AND (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid='public.events'::regclass AND t.tgfoid=p.oid
     AND t.tgenabled IN('O','A') AND t.tgnewtable='capture_new'
     AND (t.tgname,t.tgtype) IN(('memory_window_capture_insert',4),('memory_window_capture_update',16))
     AND (t.tgtype=4 OR t.tgoldtable='capture_old'))=2)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('shared.capture_memory_relay_events()') AND p.prosecdef
   AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='${APPEND_CAPTURE_V1_SHA256}'
   AND (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid='public.events'::regclass AND t.tgfoid=p.oid
    AND t.tgenabled IN('O','A') AND (t.tgname,t.tgtype) IN(('memory_source_capture_insert',4),
     ('memory_source_capture_update',16),('memory_source_capture_delete',8)))=3) $$`,
 `CREATE OR REPLACE FUNCTION shared.memory_projection_runtime_ready() RETURNS BOOLEAN
 LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
  SELECT NOT EXISTS(SELECT 1 FROM shared.memory_projection_policies) OR shared.memory_projection_capture_installed() $$`,
 `CREATE OR REPLACE FUNCTION shared.check_memory_projection_capture() RETURNS TRIGGER
 LANGUAGE plpgsql SET search_path=pg_catalog,shared AS $$ BEGIN
  IF NOT shared.memory_projection_capture_installed()
   THEN RAISE EXCEPTION 'offline_projection_capture_migration_required'; END IF;
  RETURN NEW;
 END $$`,
 `DROP TRIGGER IF EXISTS check_memory_projection_capture ON shared.memory_projection_policies;
  CREATE TRIGGER check_memory_projection_capture BEFORE INSERT OR UPDATE ON shared.memory_projection_policies
  FOR EACH STATEMENT EXECUTE FUNCTION shared.check_memory_projection_capture()`,
 `REVOKE ALL ON FUNCTION shared.freeze_memory_projection_window(),shared.bind_memory_projection_batch(),
  shared.bind_memory_projection_target(),shared.classify_memory_projection_job(),shared.ack_memory_projection_target(),
  shared.memory_projection_runtime_ready(),shared.memory_projection_capture_installed(),shared.check_memory_projection_capture() FROM PUBLIC`,
 `ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS offline_projection_version INT NOT NULL DEFAULT 0`,
 `UPDATE shared.memory_source_contract SET offline_projection_version=1 WHERE singleton`,
] as const
