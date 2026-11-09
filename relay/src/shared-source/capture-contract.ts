/** Only scalar/header metadata enters statement capture. Targeting payload
 * conservatively advances a scalar marker, avoiding detoast/equality work.
 * An equal-body replay can dirty a root; downstream revision processing must
 * retain its own durable idempotency and shadow no-charge contract. */
const eligible=(alias:string)=>`jsonb_build_object('effect_status',${alias}.effect_status,'user_id',${alias}.user_id,'session_id',${alias}.session_id)`
const metadata=(alias:string)=>`jsonb_build_object(${[
 'id','user_id','session_id','owner_retired','event_type','created_at','effect_status','source_sequence','canonical_payload_hash',
 'source_classification','source_header_version','source_body_change_revision','body_storage',
 'body_session_id','body_manifest_id','body_chunk_ordinal','body_activity_epoch','body_owner_user_id',
].map(name=>`'${name}',${alias}.${name}`).join(',')})`
export const RELAY_SOURCE_CAPTURE_SQL=[
 `ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS capture_version INT NOT NULL DEFAULT 0`,
 `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS owner_retired BOOLEAN NOT NULL DEFAULT FALSE`,
 `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS body_session_id VARCHAR(128)`,
 `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS source_body_change_revision BIGINT NOT NULL DEFAULT 0 CHECK(source_body_change_revision>=0)`,
 `CREATE OR REPLACE FUNCTION shared.mark_memory_event_body_write() RETURNS TRIGGER
  LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
   -- The SQL target list, rather than payload comparison, proves a possible
   -- body write. IS NULL reads the null bit; it does not serialize the body.
   IF OLD.body_storage='hot' AND NEW.body_storage='cold' AND NEW.payload IS NULL THEN
    NEW.source_body_change_revision=OLD.source_body_change_revision;
   ELSE NEW.source_body_change_revision=OLD.source_body_change_revision+1;END IF;
   RETURN NEW;
  END $$`,
 `DROP TRIGGER IF EXISTS memory_source_capture_body_marker ON public.events;
  CREATE TRIGGER memory_source_capture_body_marker BEFORE UPDATE OF payload ON public.events
    FOR EACH ROW EXECUTE FUNCTION shared.mark_memory_event_body_write()`,
 `CREATE OR REPLACE FUNCTION shared.memory_event_capture_eligible(p JSONB) RETURNS BOOLEAN
  LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $$ SELECT
   COALESCE(p->>'effect_status' IN ('none','completed'),FALSE)
   AND COALESCE(p->>'user_id' ~ '^[1-9][0-9]*$',FALSE)
   AND COALESCE(length(p->>'session_id') BETWEEN 1 AND 512,FALSE)
   AND p->>'session_id' NOT LIKE 'pending-%' AND p->>'session_id' NOT LIKE 'app-review-demo-%' $$`,
 `CREATE OR REPLACE FUNCTION shared.mark_memory_source_storage_changed(p_kind TEXT,p_root TEXT) RETURNS VOID
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF NOT pg_try_advisory_xact_lock(hashtextextended('memory-source-dirty:'||p_kind||':'||p_root,0)) THEN
    RAISE EXCEPTION 'source_dirty_busy' USING ERRCODE='55P03';END IF;
   PERFORM 1 FROM shared.memory_source_work WHERE source_kind=p_kind AND root_key=p_root FOR UPDATE NOWAIT;
   INSERT INTO shared.memory_source_work(source_kind,root_key,revision,storage_revision) VALUES(p_kind,p_root,1,1)
    ON CONFLICT(source_kind,root_key) DO UPDATE SET storage_revision=memory_source_work.storage_revision+1,updated_at=clock_timestamp();
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.capture_memory_relay_events() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE r RECORD;BEGIN
   IF TG_OP='INSERT' THEN
    FOR r IN SELECT DISTINCT (e.user_id::text||':'||e.session_id) COLLATE "C" AS root FROM capture_new e
      WHERE shared.memory_event_capture_eligible(${eligible('e')})
       AND NOT EXISTS(SELECT 1 FROM public.sessions s WHERE s.session_id=e.session_id AND s.source='app_review_demo') ORDER BY root
     LOOP PERFORM shared.mark_memory_source_dirty('relay_event',r.root);END LOOP;
   ELSIF TG_OP='DELETE' THEN
    FOR r IN SELECT DISTINCT (e.user_id::text||':'||e.session_id) COLLATE "C" AS root FROM capture_old e
      WHERE shared.memory_event_capture_eligible(${eligible('e')})
       AND NOT EXISTS(SELECT 1 FROM public.sessions s WHERE s.session_id=e.session_id AND s.source='app_review_demo') ORDER BY root
     LOOP PERFORM shared.mark_memory_source_dirty('relay_event',r.root);END LOOP;
   ELSE
    FOR r IN WITH pairs AS (
     SELECT ${metadata('n')} AS n,${metadata('o')} AS o FROM capture_new n FULL JOIN capture_old o ON n.id=o.id
    ), changed AS (
     SELECT * FROM pairs WHERE
      (n->>'id',n->>'user_id',n->>'session_id',n->>'event_type',n->>'created_at',n->>'source_sequence',n->>'canonical_payload_hash',n->'source_classification',n->>'source_header_version',n->>'source_body_change_revision',n->>'owner_retired')
       IS DISTINCT FROM (o->>'id',o->>'user_id',o->>'session_id',o->>'event_type',o->>'created_at',o->>'source_sequence',o->>'canonical_payload_hash',o->'source_classification',o->>'source_header_version',o->>'source_body_change_revision',o->>'owner_retired')
      OR shared.memory_event_capture_eligible(n) IS DISTINCT FROM shared.memory_event_capture_eligible(o)
    ), content_roots AS (
     SELECT n->>'user_id'||':'||(n->>'session_id') AS root,n->>'session_id' AS session FROM changed WHERE shared.memory_event_capture_eligible(n)
     UNION SELECT o->>'user_id'||':'||(o->>'session_id'),o->>'session_id' FROM changed WHERE shared.memory_event_capture_eligible(o)
    ), storage_roots AS (
     SELECT DISTINCT n->>'user_id'||':'||(n->>'session_id') AS root FROM pairs WHERE shared.memory_event_capture_eligible(n) AND shared.memory_event_capture_eligible(o)
      AND (n->>'user_id',n->>'session_id') IS NOT DISTINCT FROM (o->>'user_id',o->>'session_id')
      AND (n->>'body_session_id',n->>'body_storage',n->>'body_manifest_id',n->>'body_chunk_ordinal',n->>'body_activity_epoch',n->>'body_owner_user_id')
       IS DISTINCT FROM (o->>'body_session_id',o->>'body_storage',o->>'body_manifest_id',o->>'body_chunk_ordinal',o->>'body_activity_epoch',o->>'body_owner_user_id')
    ), changes AS (
     SELECT root,TRUE AS dirty,FALSE AS storage FROM content_roots
      WHERE NOT EXISTS(SELECT 1 FROM public.sessions s WHERE s.session_id=content_roots.session AND s.source='app_review_demo')
     UNION ALL SELECT root,FALSE,TRUE FROM storage_roots
    ) SELECT root,bool_or(dirty) AS dirty,bool_or(storage) AS storage FROM changes GROUP BY root ORDER BY root COLLATE "C"
     LOOP
      IF r.dirty THEN PERFORM shared.mark_memory_source_dirty('relay_event',r.root);END IF;
      IF r.storage THEN PERFORM shared.mark_memory_source_storage_changed('relay_event',r.root);END IF;
     END LOOP;
   END IF;RETURN NULL;
  END $$`,
 `DROP TRIGGER IF EXISTS memory_source_capture_insert ON public.events;
  CREATE TRIGGER memory_source_capture_insert AFTER INSERT ON public.events REFERENCING NEW TABLE AS capture_new FOR EACH STATEMENT EXECUTE FUNCTION shared.capture_memory_relay_events();
  DROP TRIGGER IF EXISTS memory_source_capture_update ON public.events;
  CREATE TRIGGER memory_source_capture_update AFTER UPDATE ON public.events REFERENCING OLD TABLE AS capture_old NEW TABLE AS capture_new FOR EACH STATEMENT EXECUTE FUNCTION shared.capture_memory_relay_events();
  DROP TRIGGER IF EXISTS memory_source_capture_delete ON public.events;
  CREATE TRIGGER memory_source_capture_delete AFTER DELETE ON public.events REFERENCING OLD TABLE AS capture_old FOR EACH STATEMENT EXECUTE FUNCTION shared.capture_memory_relay_events()`,
 `CREATE OR REPLACE FUNCTION shared.bootstrap_memory_relay_roots(p_after BIGINT,p_limit INT)
  RETURNS TABLE(session_row_id TEXT,root_key TEXT,revision TEXT)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE r RECORD;v BIGINT;BEGIN
   IF p_after IS NULL OR p_after<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'invalid_source_bootstrap';END IF;
   IF NOT EXISTS(SELECT 1 FROM shared.memory_source_contract WHERE version=1 AND capture_version=2)
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.events'::regclass AND tgenabled IN ('O','A')
      AND tgname IN ('memory_source_capture_insert','memory_source_capture_update','memory_source_capture_delete')
      AND tgfoid='shared.capture_memory_relay_events()'::regprocedure)<>3
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.events'::regclass AND attname='source_body_change_revision' AND NOT attisdropped)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.events'::regclass
      AND tgname='memory_source_capture_body_marker' AND tgenabled IN('O','A') AND tgtype=19
      AND tgfoid='shared.mark_memory_event_body_write()'::regprocedure)
    THEN RAISE EXCEPTION 'source_capture_required_before_bootstrap';END IF;
   FOR r IN SELECT * FROM (SELECT s.id,s.user_id::text||':'||s.session_id AS root FROM public.sessions s
     WHERE s.id>p_after AND s.user_id IS NOT NULL AND s.source IS DISTINCT FROM 'app_review_demo'
      AND s.session_id NOT LIKE 'pending-%' AND s.session_id NOT LIKE 'app-review-demo-%'
      AND s.content_state NOT IN ('deleting','deleted') AND NOT EXISTS(SELECT 1 FROM public.deleted_sessions d WHERE d.session_id=s.session_id)
     ORDER BY s.id LIMIT p_limit) page ORDER BY root COLLATE "C"
    LOOP v=shared.mark_memory_source_dirty('relay_event',r.root);RETURN QUERY SELECT r.id::text,r.root,v::text;END LOOP;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_event_capture_eligible(JSONB),shared.mark_memory_source_storage_changed(TEXT,TEXT),shared.capture_memory_relay_events(),shared.mark_memory_event_body_write(),shared.bootstrap_memory_relay_roots(BIGINT,INT) FROM PUBLIC`,
 `UPDATE shared.memory_source_contract SET capture_version=2 WHERE version=1`,
] as const
