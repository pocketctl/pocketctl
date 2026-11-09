import type pg from 'pg'
/** Session identity/privacy capture. No event body or whole-row JSON is read.
 * Try locks cover legacy reverse row order without introducing a deadlock. */
export const RELAY_SESSION_CAPTURE_SQL=[
 `ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS session_capture_version INT NOT NULL DEFAULT 0`,
 `CREATE INDEX IF NOT EXISTS memory_source_work_personal_session ON shared.memory_source_work((substr(root_key,strpos(root_key,':')+1)))
  WHERE source_kind IN('relay_event','legacy_archive')`,
 `CREATE OR REPLACE FUNCTION shared.fence_memory_source_session() RETURNS TRIGGER
  LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE sid TEXT;BEGIN
   FOR sid IN SELECT DISTINCT id COLLATE "C" AS id FROM unnest(ARRAY[CASE WHEN TG_OP<>'INSERT' THEN OLD.session_id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.session_id END]) id
    WHERE id IS NOT NULL ORDER BY id LOOP
    IF NOT pg_try_advisory_xact_lock(1885566061,hashtext(sid)) THEN RAISE EXCEPTION 'source_session_fence_busy' USING ERRCODE='55P03';END IF;
   END LOOP;
   IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.capture_memory_source_session() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE old_root TEXT;new_root TEXT;r RECORD;BEGIN
   IF OLD.user_id>0 AND length(OLD.session_id) BETWEEN 1 AND 512 THEN
    old_root=OLD.user_id::text||':'||OLD.session_id;
    IF TG_OP='DELETE' OR OLD.session_id IS DISTINCT FROM NEW.session_id OR OLD.user_id IS DISTINCT FROM NEW.user_id THEN
     INSERT INTO shared.memory_source_session_barriers(owner_user_id,session_id,canonical_session_id,reason)
      VALUES(OLD.user_id,OLD.session_id,CASE WHEN TG_OP='UPDATE' AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id THEN NEW.session_id END,
       CASE WHEN TG_OP='DELETE' THEN 'removed' WHEN OLD.user_id IS DISTINCT FROM NEW.user_id THEN 'owner_changed' ELSE 'renamed' END)
      ON CONFLICT(owner_user_id,session_id) DO UPDATE SET canonical_session_id=EXCLUDED.canonical_session_id,reason=EXCLUDED.reason,
       revision=memory_source_session_barriers.revision+1,updated_at=clock_timestamp();
    END IF;
   END IF;
   IF TG_OP='UPDATE' AND NEW.user_id>0 AND length(NEW.session_id) BETWEEN 1 AND 512 AND NEW.session_id NOT LIKE 'pending-%'
    AND NEW.session_id NOT LIKE 'app-review-demo-%' AND NEW.source IS DISTINCT FROM 'app_review_demo' THEN new_root=NEW.user_id::text||':'||NEW.session_id;END IF;
   FOR r IN SELECT source_kind,root_key FROM(
     SELECT source_kind,root_key FROM shared.memory_source_work WHERE source_kind IN('relay_event','legacy_archive') AND root_key IN(old_root,new_root)
     UNION SELECT 'relay_event',new_root WHERE new_root IS NOT NULL AND(old_root IS DISTINCT FROM new_root OR EXISTS(SELECT 1 FROM shared.memory_source_work WHERE root_key=old_root AND source_kind='relay_event'))
    ) roots ORDER BY source_kind COLLATE "C",root_key COLLATE "C" LOOP
     PERFORM shared.mark_memory_source_dirty(r.source_kind,r.root_key);
   END LOOP;RETURN NULL;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.capture_memory_source_tombstone() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE r RECORD;BEGIN
   FOR r IN SELECT DISTINCT w.source_kind COLLATE "C" AS source_kind,w.root_key COLLATE "C" AS root_key FROM shared.memory_source_work w JOIN privacy_changed p
     ON substr(w.root_key,strpos(w.root_key,':')+1)=p.session_id WHERE w.source_kind IN('relay_event','legacy_archive')
     ORDER BY source_kind,root_key LOOP
    PERFORM shared.mark_memory_source_dirty(r.source_kind,r.root_key);
   END LOOP;RETURN NULL;
  END $$`,
 `DO $$ DECLARE columns TEXT;BEGIN
   SELECT string_agg(quote_ident(attname),',' ORDER BY attname) INTO columns FROM pg_attribute
    WHERE attrelid='public.sessions'::regclass AND attnum>0 AND NOT attisdropped
     AND attname IN('session_id','user_id','source','content_state','daemon_id','agent_type');
   DROP TRIGGER IF EXISTS memory_source_session_fence ON public.sessions;
   EXECUTE 'CREATE TRIGGER memory_source_session_fence BEFORE INSERT OR DELETE OR UPDATE OF '||columns||' ON public.sessions FOR EACH ROW EXECUTE FUNCTION shared.fence_memory_source_session()';
   DROP TRIGGER IF EXISTS memory_source_session_capture ON public.sessions;
   EXECUTE 'CREATE TRIGGER memory_source_session_capture AFTER DELETE OR UPDATE OF '||columns||' ON public.sessions FOR EACH ROW EXECUTE FUNCTION shared.capture_memory_source_session()';
   DROP TRIGGER IF EXISTS memory_source_tombstone_fence ON public.deleted_sessions;
   CREATE TRIGGER memory_source_tombstone_fence BEFORE INSERT OR UPDATE OR DELETE ON public.deleted_sessions FOR EACH ROW EXECUTE FUNCTION shared.fence_memory_source_session();
   DROP TRIGGER IF EXISTS memory_source_tombstone_capture_insert ON public.deleted_sessions;
   CREATE TRIGGER memory_source_tombstone_capture_insert AFTER INSERT ON public.deleted_sessions REFERENCING NEW TABLE AS privacy_changed FOR EACH STATEMENT EXECUTE FUNCTION shared.capture_memory_source_tombstone();
   DROP TRIGGER IF EXISTS memory_source_tombstone_capture_update ON public.deleted_sessions;
   CREATE TRIGGER memory_source_tombstone_capture_update AFTER UPDATE ON public.deleted_sessions REFERENCING NEW TABLE AS privacy_changed FOR EACH STATEMENT EXECUTE FUNCTION shared.capture_memory_source_tombstone();
   DROP TRIGGER IF EXISTS memory_source_tombstone_capture_delete ON public.deleted_sessions;
   CREATE TRIGGER memory_source_tombstone_capture_delete AFTER DELETE ON public.deleted_sessions REFERENCING OLD TABLE AS privacy_changed FOR EACH STATEMENT EXECUTE FUNCTION shared.capture_memory_source_tombstone();
  END $$`,
 `REVOKE ALL ON FUNCTION shared.fence_memory_source_session(),shared.capture_memory_source_session(),shared.capture_memory_source_tombstone() FROM PUBLIC`,
 `UPDATE shared.memory_source_contract SET session_capture_version=1 WHERE singleton`,
] as const

/** Startup is catalog-only. The role need not execute capture or read bodies. */
export async function assertRelaySessionCaptureContract(db:Pick<pg.Pool,'query'>):Promise<void>{
 const marker=(await db.query("SELECT to_jsonb(c)->>'session_capture_version' AS version FROM shared.memory_source_contract c")).rows
 if(marker.length!==1||marker[0].version!=='1')throw Error('relay_shared_session_capture_contract_required')
 const required=[['public.sessions','memory_source_session_fence','shared.fence_memory_source_session()',31],['public.sessions','memory_source_session_capture','shared.capture_memory_source_session()',25],['public.deleted_sessions','memory_source_tombstone_fence','shared.fence_memory_source_session()',31],['public.deleted_sessions','memory_source_tombstone_capture_insert','shared.capture_memory_source_tombstone()',4],['public.deleted_sessions','memory_source_tombstone_capture_update','shared.capture_memory_source_tombstone()',16],['public.deleted_sessions','memory_source_tombstone_capture_delete','shared.capture_memory_source_tombstone()',8]]
 const complete=(await db.query(`SELECT NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS r(relation text,trigger text,fn text,kind int)
  WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(r.relation) AND t.tgname=r.trigger AND t.tgfoid=to_regprocedure(r.fn) AND t.tgenabled IN('O','A') AND t.tgtype=r.kind)) AS complete`,[JSON.stringify(required.map(([relation,trigger,fn,kind])=>({relation,trigger,fn,kind})))])).rows[0]?.complete
 if(!complete)throw Error('relay_shared_session_capture_contract_required')
}
