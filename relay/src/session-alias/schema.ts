import type pg from 'pg'

/** Native routing/custody input is inspected before any migration DDL. */
export class NativeRetirementUpgradeError extends Error {
 constructor(readonly code:'native_retirement_upgrade_repair_required'|'native_retirement_contract_drift'){
  super(code);this.name='NativeRetirementUpgradeError'
 }
}
export async function assertNativeRetirementUpgradeInput(db:Pick<pg.Pool,'query'>):Promise<void>{
 let row:any
 try{row=(await db.query(`SELECT
   to_regprocedure('public.native_session_authority(text,integer,text)') IS NOT NULL AS native_function,
   (SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.native_session_authority(text,integer,text)')) AS definition,
   to_regclass('public.session_aliases') IS NOT NULL AS aliases,
   to_regclass('public.session_documents') IS NOT NULL AS documents,
   to_regclass('public.relay_schema_contract') IS NOT NULL AS relay_contract,
   to_regclass('shared.memory_source_session_barriers') IS NOT NULL AS barriers,
   EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.events') AND attname='owner_retired' AND atttypid='boolean'::regtype AND attnotnull AND NOT attisdropped) AS event_marker,
   EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.session_documents') AND attname='owner_retired' AND atttypid='boolean'::regtype AND attnotnull AND NOT attisdropped) AS document_marker,
   EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.session_aliases') AND attname='owner_boundary' AND atttypid='boolean'::regtype AND attnotnull AND NOT attisdropped) AS boundary_marker,
   to_regprocedure('public.native_event_authority(bigint,integer)') IS NOT NULL AS event_authority,
   EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.events') AND tgname='events_owner_retirement' AND tgenabled IN('O','A')) AS event_guard,
   EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.session_documents') AND tgname='session_document_owner' AND tgenabled IN('O','A')) AS document_guard`)).rows[0]}
 catch{throw new NativeRetirementUpgradeError('native_retirement_upgrade_repair_required')}
 if(!row)throw new NativeRetirementUpgradeError('native_retirement_upgrade_repair_required')
 const versions=[...String(row.definition??'').matchAll(/'contractVersion'\s*,\s*(\d+)/g)]
 if(row.native_function&&versions.length===1&&versions[0][1]==='3'){
  if(!row.event_marker||!row.boundary_marker||!row.event_authority||!row.event_guard||(row.documents||row.relay_contract)&&(!row.document_marker||!row.document_guard))
   throw new NativeRetirementUpgradeError('native_retirement_contract_drift')
  return
 }
 // Unsupported/unproved v1/v2 (or future) native input cannot manufacture a
 // historical retirement witness by ADD COLUMN DEFAULT FALSE.
 if(row.native_function||row.aliases)throw new NativeRetirementUpgradeError('native_retirement_upgrade_repair_required')
 if(row.barriers){
  let changed:boolean
  try{changed=(await db.query("SELECT EXISTS(SELECT 1 FROM shared.memory_source_session_barriers WHERE reason='owner_changed') AS changed")).rows[0]?.changed!==false}
  catch{throw new NativeRetirementUpgradeError('native_retirement_upgrade_repair_required')}
  if(changed)throw new NativeRetirementUpgradeError('native_retirement_upgrade_repair_required')
 }
}

/** Native routing proof belongs to Relay, including installations with no
 * optional Memory schema. Edges and storage/source identities never cascade. */
export async function initNativeSessionAliasSchema(db:Pick<pg.Pool,'query'>):Promise<void>{
 await assertNativeRetirementUpgradeInput(db)
 await db.query(`
 CREATE SEQUENCE IF NOT EXISTS public.session_alias_revision;
 CREATE TABLE IF NOT EXISTS public.session_aliases(
  old_session_id VARCHAR(128) PRIMARY KEY,next_session_id VARCHAR(128) NOT NULL,
  owner_user_id INT,original_daemon_id VARCHAR(64),request_daemon_id VARCHAR(64),
  revision BIGINT NOT NULL DEFAULT nextval('public.session_alias_revision') CHECK(revision>0),
  blocked BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK(old_session_id<>next_session_id));
 -- A durable owner cut is distinct from a privacy/unknown block. Existing
 -- blocked rows keep unknown provenance and are never automatically repaired.
 ALTER TABLE public.session_aliases ADD COLUMN IF NOT EXISTS owner_boundary BOOLEAN NOT NULL DEFAULT FALSE;
 CREATE INDEX IF NOT EXISTS idx_native_session_alias_next ON public.session_aliases(next_session_id);
 ALTER TABLE public.events ADD COLUMN IF NOT EXISTS logical_source_session_id VARCHAR(128);
 UPDATE public.events SET logical_source_session_id=session_id WHERE logical_source_session_id IS NULL;
 ALTER TABLE public.events ALTER COLUMN logical_source_session_id SET NOT NULL;
 ALTER TABLE public.events ADD COLUMN IF NOT EXISTS owner_retired BOOLEAN NOT NULL DEFAULT FALSE;
 CREATE OR REPLACE FUNCTION public.preserve_native_owner_retirement() RETURNS TRIGGER
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
  IF TG_OP='INSERT' AND NEW.owner_retired OR TG_OP='UPDATE' AND
   (OLD.owner_retired AND NOT NEW.owner_retired OR NEW.owner_retired IS DISTINCT FROM OLD.owner_retired AND pg_trigger_depth()<2)
   THEN RAISE EXCEPTION 'native owner retirement is server-owned and permanent';END IF;
  RETURN NEW;
 END $$;
 DROP TRIGGER IF EXISTS events_owner_retirement ON public.events;
 CREATE TRIGGER events_owner_retirement BEFORE INSERT OR UPDATE OF owner_retired ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.preserve_native_owner_retirement();
 CREATE OR REPLACE FUNCTION public.native_session_alias_set(p_ids TEXT[]) RETURNS TEXT[]
 LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
 DECLARE ids TEXT[];fresh TEXT[];step INT;BEGIN
  SELECT array_agg(id ORDER BY id COLLATE "C") INTO ids FROM(SELECT DISTINCT id FROM unnest(p_ids) id WHERE id IS NOT NULL) q;
  IF cardinality(ids) NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'native_alias_set_invalid';END IF;
  FOR step IN 1..33 LOOP
   SELECT array_agg(id ORDER BY id COLLATE "C") INTO fresh FROM(
    SELECT unnest(ids) AS id UNION SELECT a.old_session_id FROM public.session_aliases a WHERE a.next_session_id=ANY(ids)
    UNION SELECT a.next_session_id FROM public.session_aliases a WHERE a.old_session_id=ANY(ids)) q;
   IF cardinality(fresh)>64 THEN RAISE EXCEPTION 'native_alias_set_limit';END IF;
   IF fresh=ids THEN RETURN ids;END IF;ids=fresh;
  END LOOP;RAISE EXCEPTION 'native_alias_chain_limit';
 END $$;
 CREATE OR REPLACE FUNCTION public.native_session_authority(p_id TEXT,p_owner INT,p_daemon TEXT DEFAULT NULL) RETURNS JSONB
 LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
 DECLARE sid TEXT=p_id;seen TEXT[]=ARRAY[]::text[];ids TEXT[];fresh TEXT[];edge RECORD;s RECORD;rev BIGINT;step INT;BEGIN
  IF p_id IS NULL OR length(p_id) NOT BETWEEN 1 AND 128 THEN RETURN jsonb_build_object('state','revoked');END IF;
  -- Bound the complete name graph even when historical owners form separate authority components.
  PERFORM public.native_session_alias_set(ARRAY[p_id]);
  FOR step IN 1..33 LOOP
   IF sid=ANY(seen) OR step>32 THEN RETURN jsonb_build_object('state','revoked');END IF;
   seen=array_append(seen,sid);
   SELECT * INTO edge FROM public.session_aliases WHERE old_session_id=sid;
   IF NOT FOUND THEN EXIT;END IF;
   IF edge.owner_user_id IS DISTINCT FROM p_owner OR(p_owner IS NULL AND edge.original_daemon_id IS DISTINCT FROM p_daemon)
    THEN RETURN jsonb_build_object('state','revoked');END IF;
   IF edge.blocked THEN RETURN jsonb_build_object('state','deleted');END IF;
   sid=edge.next_session_id;
  END LOOP;
  SELECT * INTO s FROM public.sessions WHERE session_id=sid;
  IF NOT FOUND OR s.user_id IS DISTINCT FROM p_owner OR(p_owner IS NULL AND s.daemon_id IS DISTINCT FROM p_daemon)
   THEN RETURN jsonb_build_object('state','revoked');END IF;
  IF s.content_state IN('deleting','deleted') THEN RETURN jsonb_build_object('state','deleted');END IF;
  ids=ARRAY[sid];
  FOR step IN 1..32 LOOP
   SELECT array_agg(id ORDER BY id COLLATE "C") INTO fresh FROM(SELECT unnest(ids) AS id
    UNION SELECT a.old_session_id FROM public.session_aliases a WHERE a.next_session_id=ANY(ids)
     AND NOT a.owner_boundary AND a.owner_user_id IS NOT DISTINCT FROM p_owner AND(p_owner IS NOT NULL OR a.original_daemon_id=p_daemon)) q;
   EXIT WHEN fresh=ids;ids=fresh;
  END LOOP;
  -- Only a durable blocked owner boundary permits fresh facts under a new owner.
  IF EXISTS(SELECT 1 FROM public.session_aliases a WHERE a.next_session_id=ANY(ids)
    AND a.owner_user_id IS DISTINCT FROM p_owner AND NOT a.owner_boundary) THEN RETURN jsonb_build_object('state','revoked');END IF;
  IF EXISTS(SELECT 1 FROM public.deleted_sessions WHERE session_id=ANY(ids))
   OR EXISTS(SELECT 1 FROM public.session_aliases WHERE old_session_id=ANY(ids) AND blocked)
   THEN RETURN jsonb_build_object('state','deleted');END IF;
  SELECT COALESCE(max(revision),0) INTO rev FROM public.session_aliases WHERE old_session_id=ANY(ids);
  RETURN jsonb_build_object('contractVersion',3,'state','current','sessionId',sid,'sessionIds',ids,'revision',rev::text,
   'originSessionId',COALESCE((SELECT a.old_session_id FROM public.session_aliases a WHERE a.old_session_id=ANY(ids)
     AND NOT EXISTS(SELECT 1 FROM public.session_aliases parent WHERE parent.next_session_id=a.old_session_id
       AND NOT parent.owner_boundary AND parent.owner_user_id IS NOT DISTINCT FROM p_owner) LIMIT 1),sid));
 END $$;
 CREATE OR REPLACE FUNCTION public.native_event_authority(p_id BIGINT,p_owner INT) RETURNS JSONB
 LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$ DECLARE e RECORD;n JSONB;BEGIN
  SELECT id,user_id,session_id,logical_source_session_id,owner_retired INTO e FROM public.events WHERE id=p_id;
  IF NOT FOUND OR e.owner_retired OR e.user_id IS DISTINCT FROM p_owner OR p_owner IS NULL
   THEN RETURN jsonb_build_object('state','revoked');END IF;
  n=public.native_session_authority(e.logical_source_session_id,p_owner,NULL);
  IF n->>'state' IS DISTINCT FROM 'current' OR n->>'sessionId' IS DISTINCT FROM e.session_id
   THEN RETURN jsonb_build_object('state','revoked');END IF;
  RETURN n||jsonb_build_object('eventId',e.id::text,'logicalSessionId',e.logical_source_session_id,'ownerRetired',FALSE);
 END $$;
 CREATE OR REPLACE FUNCTION public.guard_native_alias_edge() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 DECLARE sid TEXT;ids TEXT[];BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'native retired name is permanent';END IF;
  IF TG_OP='UPDATE' THEN
   IF (NEW.old_session_id,NEW.next_session_id,NEW.created_at) IS DISTINCT FROM(OLD.old_session_id,OLD.next_session_id,OLD.created_at)
    OR (OLD.blocked AND NOT NEW.blocked)
    OR (OLD.owner_boundary AND NOT NEW.owner_boundary)
    OR (NEW.owner_boundary AND NOT NEW.blocked)
    OR (NEW.owner_boundary AND NOT OLD.owner_boundary AND pg_trigger_depth()<2)
    OR((NEW.original_daemon_id,NEW.request_daemon_id,NEW.owner_user_id) IS DISTINCT FROM(OLD.original_daemon_id,OLD.request_daemon_id,OLD.owner_user_id)
      AND NOT(NEW.blocked AND NEW.owner_user_id IS NULL AND NEW.original_daemon_id IS NULL AND NEW.request_daemon_id IS NULL)
      AND NOT(OLD.owner_user_id IS NULL AND NEW.owner_user_id>0 AND NOT OLD.blocked AND NOT NEW.blocked
       AND NEW.original_daemon_id=OLD.original_daemon_id AND NEW.request_daemon_id=OLD.request_daemon_id
       AND NEW.original_daemon_id=NEW.request_daemon_id AND EXISTS(SELECT 1 FROM public.daemons d WHERE d.daemon_id=NEW.original_daemon_id AND d.user_id=NEW.owner_user_id)))
    OR NEW.revision<=OLD.revision THEN RAISE EXCEPTION 'immutable native alias edge';END IF;
   RETURN NEW;
  END IF;
  ids=public.native_session_alias_set(ARRAY[NEW.old_session_id,NEW.next_session_id]);
  IF NEW.owner_boundary OR cardinality(ids)>32 OR EXISTS(SELECT 1 FROM public.session_aliases WHERE old_session_id=NEW.next_session_id)
    OR EXISTS(SELECT 1 FROM public.sessions WHERE session_id=NEW.next_session_id)
    OR EXISTS(SELECT 1 FROM public.deleted_sessions WHERE session_id=NEW.next_session_id)
    OR public.native_session_authority(NEW.old_session_id,NEW.owner_user_id,NEW.original_daemon_id)->>'state' IS DISTINCT FROM 'current'
    OR NOT EXISTS(SELECT 1 FROM public.sessions s WHERE s.session_id=NEW.old_session_id
      AND s.user_id IS NOT DISTINCT FROM NEW.owner_user_id AND s.daemon_id IS NOT DISTINCT FROM NEW.original_daemon_id)
    THEN RAISE EXCEPTION 'invalid native alias edge';END IF;
  FOREACH sid IN ARRAY ids LOOP
   IF NOT pg_try_advisory_xact_lock(1885566061,hashtext(sid)) THEN RAISE EXCEPTION 'native_alias_fence_busy' USING ERRCODE='55P03';END IF;
  END LOOP;
  RETURN NEW;
 END $$;
 DROP TRIGGER IF EXISTS native_alias_edge_guard ON public.session_aliases;
 CREATE TRIGGER native_alias_edge_guard BEFORE INSERT OR UPDATE OR DELETE ON public.session_aliases FOR EACH ROW EXECUTE FUNCTION public.guard_native_alias_edge();
 CREATE OR REPLACE FUNCTION public.guard_native_session_alias() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 DECLARE sid TEXT;ids TEXT[];BEGIN
  ids=public.native_session_alias_set(ARRAY[CASE WHEN TG_OP<>'INSERT' THEN OLD.session_id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.session_id END]);
  FOREACH sid IN ARRAY ids LOOP
   IF NOT pg_try_advisory_xact_lock(1885566061,hashtext(sid)) THEN RAISE EXCEPTION 'native_alias_fence_busy' USING ERRCODE='55P03';END IF;
  END LOOP;
  IF TG_OP='INSERT' AND (EXISTS(SELECT 1 FROM public.session_aliases WHERE old_session_id=NEW.session_id)
   OR EXISTS(SELECT 1 FROM public.deleted_sessions WHERE session_id=NEW.session_id))
   THEN RAISE EXCEPTION 'retired native session' USING ERRCODE='23514';END IF;
  IF TG_OP='UPDATE' AND OLD.session_id IS DISTINCT FROM NEW.session_id THEN
   IF OLD.user_id IS DISTINCT FROM NEW.user_id OR NOT EXISTS(SELECT 1 FROM public.session_aliases a WHERE
    a.old_session_id=OLD.session_id AND a.next_session_id=NEW.session_id AND a.owner_user_id IS NOT DISTINCT FROM OLD.user_id
    AND a.original_daemon_id IS NOT DISTINCT FROM OLD.daemon_id AND NOT a.blocked)
    THEN RAISE EXCEPTION 'unproved native rename' USING ERRCODE='23514';END IF;
  END IF;
  IF TG_OP='DELETE' OR(TG_OP='UPDATE' AND OLD.user_id IS DISTINCT FROM NEW.user_id AND NOT(
    OLD.user_id IS NULL AND NEW.user_id>0 AND OLD.daemon_id=NEW.daemon_id
    AND EXISTS(SELECT 1 FROM public.daemons d WHERE d.daemon_id=NEW.daemon_id AND d.user_id=NEW.user_id)
    AND NOT EXISTS(SELECT 1 FROM public.session_aliases WHERE old_session_id=ANY(ids) AND
     (owner_user_id IS DISTINCT FROM NEW.user_id OR original_daemon_id IS DISTINCT FROM NEW.daemon_id OR blocked)))) THEN
   IF TG_OP='UPDATE' THEN
    -- Set-based metadata only, under the full native component fence. Include
    -- every pre-cut routed reference, even legacy foreign originals.
    PERFORM id FROM public.events WHERE session_id=OLD.session_id AND NOT owner_retired ORDER BY id FOR UPDATE NOWAIT;
    UPDATE public.events SET owner_retired=TRUE WHERE session_id=OLD.session_id AND NOT owner_retired;
    IF to_regclass('public.session_documents') IS NOT NULL THEN
     PERFORM document_id FROM public.session_documents WHERE session_id=OLD.session_id AND NOT owner_retired ORDER BY document_id FOR UPDATE NOWAIT;
     UPDATE public.session_documents SET owner_retired=TRUE WHERE session_id=OLD.session_id AND NOT owner_retired;
    END IF;
   END IF;
   UPDATE public.session_aliases SET blocked=TRUE,owner_boundary=TRUE,revision=nextval('public.session_alias_revision')
    WHERE old_session_id=ANY(ids) AND (NOT blocked OR NOT owner_boundary);
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
 END $$;
 DROP TRIGGER IF EXISTS native_session_alias_guard ON public.sessions;
 CREATE TRIGGER native_session_alias_guard BEFORE INSERT OR DELETE OR UPDATE OF session_id,user_id,daemon_id,content_state ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_native_session_alias();
 CREATE OR REPLACE FUNCTION public.adopt_native_session_owner(p_id TEXT,p_owner INT,p_daemon TEXT) RETURNS BOOLEAN
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE ids TEXT[];sid TEXT;s RECORD;BEGIN
  IF p_owner IS NULL THEN RETURN FALSE;END IF;
  ids=public.native_session_alias_set(ARRAY[p_id]);
  FOREACH sid IN ARRAY ids LOOP
   IF NOT pg_try_advisory_xact_lock(1885566061,hashtext(sid)) THEN RAISE EXCEPTION 'native_alias_fence_busy' USING ERRCODE='55P03';END IF;
  END LOOP;
  SELECT * INTO s FROM public.sessions WHERE session_id=p_id FOR UPDATE NOWAIT;
  IF NOT FOUND OR s.user_id IS NOT NULL THEN RETURN FALSE;END IF;
  PERFORM daemon_id FROM public.daemons WHERE daemon_id=p_daemon AND user_id=p_owner FOR SHARE NOWAIT;
  IF NOT FOUND OR s.daemon_id IS DISTINCT FROM p_daemon
    OR EXISTS(SELECT 1 FROM public.session_aliases WHERE old_session_id=ANY(ids) AND
      (owner_user_id IS NOT NULL OR original_daemon_id IS DISTINCT FROM p_daemon OR request_daemon_id IS DISTINCT FROM p_daemon OR blocked))
    THEN RAISE EXCEPTION 'native adoption unauthorized' USING ERRCODE='23514';END IF;
  UPDATE public.session_aliases SET owner_user_id=p_owner,revision=nextval('public.session_alias_revision') WHERE old_session_id=ANY(ids);
  UPDATE public.sessions SET user_id=p_owner WHERE session_id=p_id;
  RETURN TRUE;
 END $$;
 CREATE OR REPLACE FUNCTION public.guard_native_alias_privacy() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 DECLARE ids TEXT[];privacy_ids TEXT[];fresh TEXT[];step INT;sid TEXT;subject_owner INT;BEGIN
  ids=public.native_session_alias_set(ARRAY[CASE WHEN TG_OP<>'INSERT' THEN OLD.session_id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.session_id END]);
  FOREACH sid IN ARRAY ids LOOP
   IF NOT pg_try_advisory_xact_lock(1885566061,hashtext(sid)) THEN RAISE EXCEPTION 'native_alias_fence_busy' USING ERRCODE='55P03';END IF;
  END LOOP;
  IF TG_OP<>'DELETE' THEN
    SELECT owner_user_id INTO subject_owner FROM public.session_aliases WHERE old_session_id=NEW.session_id;
    IF NOT FOUND THEN SELECT user_id INTO subject_owner FROM public.sessions WHERE session_id=NEW.session_id;END IF;
    -- Privacy follows only the recorded authority component. Crossing a
    -- permanent owner cut must never revoke a later owner's new facts.
    privacy_ids=ARRAY[NEW.session_id];
    FOR step IN 1..32 LOOP
      SELECT array_agg(id ORDER BY id COLLATE "C") INTO fresh FROM(
        SELECT unnest(privacy_ids) AS id
        UNION SELECT a.old_session_id FROM public.session_aliases a WHERE a.next_session_id=ANY(privacy_ids)
          AND NOT a.owner_boundary AND a.owner_user_id IS NOT DISTINCT FROM subject_owner
        UNION SELECT a.next_session_id FROM public.session_aliases a WHERE a.old_session_id=ANY(privacy_ids)
          AND NOT a.owner_boundary AND a.owner_user_id IS NOT DISTINCT FROM subject_owner) q;
      EXIT WHEN fresh=privacy_ids;privacy_ids=fresh;
    END LOOP;
    UPDATE public.session_aliases SET blocked=TRUE,revision=nextval('public.session_alias_revision')
     WHERE old_session_id=ANY(privacy_ids) AND owner_user_id IS NOT DISTINCT FROM subject_owner AND NOT blocked;RETURN NEW;
  END IF;
  RETURN OLD;
 END $$;
 DROP TRIGGER IF EXISTS native_alias_privacy_guard ON public.deleted_sessions;
 CREATE TRIGGER native_alias_privacy_guard BEFORE INSERT OR UPDATE OR DELETE ON public.deleted_sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_native_alias_privacy();
 CREATE OR REPLACE FUNCTION public.preserve_native_archive_identity() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
  IF (NEW.manifest_id,NEW.user_id,NEW.session_id,NEW.activity_epoch,NEW.schema_version,NEW.codec,NEW.storage_namespace,NEW.operation_id)
    IS DISTINCT FROM(OLD.manifest_id,OLD.user_id,OLD.session_id,OLD.activity_epoch,OLD.schema_version,OLD.codec,OLD.storage_namespace,OLD.operation_id)
    THEN RAISE EXCEPTION 'immutable archive identity';END IF;RETURN NEW;
 END $$;
 DROP TRIGGER IF EXISTS native_archive_identity ON public.session_archive_manifests;
 CREATE TRIGGER native_archive_identity BEFORE UPDATE ON public.session_archive_manifests
  FOR EACH ROW EXECUTE FUNCTION public.preserve_native_archive_identity();
 CREATE OR REPLACE FUNCTION public.scrub_native_session_alias_owner() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
  UPDATE public.session_aliases SET owner_user_id=NULL,original_daemon_id=NULL,request_daemon_id=NULL,blocked=TRUE,
   revision=nextval('public.session_alias_revision') WHERE owner_user_id=OLD.id;RETURN OLD;
 END $$;
 DROP TRIGGER IF EXISTS native_session_alias_scrub_owner ON public.users;
 CREATE TRIGGER native_session_alias_scrub_owner BEFORE DELETE ON public.users FOR EACH ROW EXECUTE FUNCTION public.scrub_native_session_alias_owner();
 CREATE OR REPLACE FUNCTION public.preserve_event_logical_session() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
  IF TG_OP='INSERT' THEN NEW.logical_source_session_id=COALESCE(NEW.logical_source_session_id,NEW.session_id);
  ELSIF NEW.logical_source_session_id IS DISTINCT FROM OLD.logical_source_session_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN RAISE EXCEPTION 'immutable logical source session';END IF;
  RETURN NEW;
 END $$;
 DROP TRIGGER IF EXISTS events_logical_session ON public.events;
 CREATE TRIGGER events_logical_session BEFORE INSERT OR UPDATE OF logical_source_session_id,user_id ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.preserve_event_logical_session();
 `)
}

/** Catalog only: runtime must never silently bootstrap native authority. */
export async function assertNativeSessionAliasSchema(db:Pick<pg.Pool,'query'>):Promise<void>{
 const row=(await db.query(`SELECT to_regclass('public.session_aliases') IS NOT NULL
  AND to_regprocedure('public.native_session_authority(text,integer,text)') IS NOT NULL
  AND to_regprocedure('public.adopt_native_session_owner(text,integer,text)') IS NOT NULL
  AND to_regprocedure('public.native_event_authority(bigint,integer)') IS NOT NULL
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.events'::regclass AND attname='owner_retired' AND attnotnull AND NOT attisdropped)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.session_documents'::regclass AND attname='owner_retired' AND attnotnull AND NOT attisdropped)
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.events'::regclass AND tgname='events_owner_retirement' AND tgenabled IN('O','A'))
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.session_aliases'::regclass AND attname='owner_boundary' AND attnotnull AND NOT attisdropped)
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.session_documents'::regclass AND tgname='session_document_owner' AND tgenabled IN('O','A'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.session_document_uploads'::regclass AND tgname='session_document_upload_owner' AND tgenabled IN('O','A'))
  AND EXISTS(SELECT 1 FROM pg_constraint c WHERE c.contype='f' AND c.conrelid='public.session_documents'::regclass
    AND c.confrelid='public.sessions'::regclass AND c.confupdtype='c'
    AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.session_documents'::regclass AND attname='session_id')]::smallint[])
  AND NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.contype='f' AND c.conrelid='public.session_documents'::regclass
    AND c.confrelid='public.sessions'::regclass AND cardinality(c.conkey)<>1)
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.session_aliases'::regclass AND tgname='native_alias_edge_guard' AND tgenabled IN('O','A'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.deleted_sessions'::regclass AND tgname='native_alias_privacy_guard' AND tgenabled IN('O','A'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.session_archive_manifests'::regclass AND tgname='native_archive_identity' AND tgenabled IN('O','A'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.sessions'::regclass AND tgname='native_session_alias_guard' AND tgenabled IN('O','A'))
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.events'::regclass AND attname='logical_source_session_id' AND attnotnull AND NOT attisdropped)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.events'::regclass AND attname='body_session_id' AND NOT attisdropped)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.session_document_versions'::regclass AND attname='body_session_id' AND NOT attisdropped)
  AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.events'::regclass AND conname='events_body_manifest_binding'
    AND pg_get_constraintdef(oid) LIKE '%body_session_id%')
  AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.session_document_versions'::regclass AND conname='document_body_manifest_binding'
    AND pg_get_constraintdef(oid) LIKE '%body_session_id%')
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE contype='f' AND conrelid IN('public.session_documents'::regclass,'public.session_document_versions'::regclass,'public.session_document_uploads'::regclass)
    AND confrelid IN('public.sessions'::regclass,'public.session_documents'::regclass) AND confupdtype<>'c') AS ready`)).rows[0]
 if(row?.ready!==true)throw Error('native_session_alias_migrator_required')
}
