import {assertNativeTeamSemanticCompatible,installNativeTeamSemanticPublication} from './team-semantic-publication.js'
import type pg from 'pg'

/** Native, body-free original publication/start facts. The ordinal orders only
 * facts in the SAME top-level transaction; it is never a commit watermark. */
export const NATIVE_INPUT_START_VERSION=1
export async function assertNativeInputStartCompatible(db:Pick<pg.Pool,'query'>):Promise<void>{
 await assertNativeTeamSemanticCompatible(db)
 let sharedDeclared=false
 if((await db.query("SELECT to_regclass('shared.memory_source_contract') IS NOT NULL AS present")).rows[0]?.present){
  const shared=(await db.query("SELECT COALESCE(to_jsonb(contract)->>'input_start_version','0') AS input_start_version FROM shared.memory_source_contract contract")).rows
  if(shared.length!==1||!['0','1'].includes(shared[0].input_start_version))throw Error('unsupported_shared_input_start_contract')
  sharedDeclared=shared[0].input_start_version==='1'
 }
 const present=(await db.query("SELECT to_regclass('public.native_input_start_contract') IS NOT NULL AS present")).rows[0]?.present
 if(!present){
  if(sharedDeclared)throw Error('native_input_start_history_missing')
  const partial=(await db.query("SELECT to_regclass('public.native_source_publications') IS NOT NULL OR to_regclass('public.native_installation_starts') IS NOT NULL OR to_regclass('public.native_input_start_order') IS NOT NULL OR to_regprocedure('public.capture_native_installation_start()') IS NOT NULL AS present")).rows[0]?.present
  if(partial)throw Error('native_input_start_history_missing')
  return
 }
 const rows=(await db.query('SELECT version FROM public.native_input_start_contract')).rows
 if(rows.length!==1||rows[0].version!==1)throw Error('unsupported_native_input_start_contract')
 const ready=(await db.query(`SELECT to_regclass('public.native_source_publications') IS NOT NULL
  AND to_regclass('public.native_installation_starts') IS NOT NULL
  AND EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.native_input_start_order') AND relkind='S')
  AND EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_index x ON x.indexrelid=c.conindid WHERE c.conrelid=to_regclass('public.native_source_publications') AND c.contype='p' AND x.indisvalid AND x.indisready
   AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='source_kind'),(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='source_key')]::smallint[])
  AND EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_index x ON x.indexrelid=c.conindid WHERE c.conrelid=to_regclass('public.native_installation_starts') AND c.contype='p' AND x.indisvalid AND x.indisready
   AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='installation_id')]::smallint[])

  AND NOT EXISTS(SELECT 1 FROM(VALUES ${NATIVE_INPUT_START_COLUMNS}) expected(relation,column_name,column_type)
   WHERE NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass(expected.relation) AND a.attname=expected.column_name
    AND a.atttypid=to_regtype(expected.column_type) AND a.attnum>0 AND NOT a.attisdropped))
  AND NOT EXISTS(SELECT 1 FROM(VALUES ${NATIVE_INPUT_START_EXPECTED}) expected(relation,trigger_name,function_name,trigger_type)
   WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=to_regclass(expected.relation)
    AND t.tgname=expected.trigger_name AND t.tgfoid=to_regprocedure(expected.function_name) AND t.tgtype=expected.trigger_type
    AND t.tgenabled IN('O','A') AND p.prosecdef
    AND EXISTS(SELECT 1 FROM unnest(p.proconfig) setting WHERE replace(setting,' ','')='search_path=pg_catalog,public'))) AS ready`)).rows[0]?.ready
 if(!ready)throw Error('native_input_start_history_missing')
}
export const NATIVE_INPUT_START_COLUMNS=[
 ['native_source_publications',{source_kind:'text',source_key:'text',owner_key:'text',source_session_id:'text',retired:'boolean',publication_xid:'bigint',publication_order:'bigint'}],
 ['native_installation_starts',{installation_id:'uuid',provider_id:'text',retired:'boolean',original_policy:'text',original_feed_id:'bigint',owner_user_id:'integer',owner_scope_kind:'text',owner_scope_id:'uuid',start_xid:'bigint',start_snapshot:'txid_snapshot',start_order:'bigint'}],
].flatMap(([table,columns])=>Object.entries(columns as Record<string,string>).map(([column,type])=>`('public.${table}','${column}','${type}')`)).join(',')

const triggerSpecs=[
 ['events','native_input_event','public.capture_native_event_publication()',29],
 ['extension_installations','native_input_installation','public.capture_native_installation_start()',5],
 ['extension_installations','native_input_installation_guard','public.capture_native_installation_start()',27],
 ['users','native_input_privacy','public.retire_native_user_input()',11],
 ...['collaboration_calls','collaboration_events','team_delivery_memory_sources'].flatMap(table=>[
  [table,'native_input_team_before','public.capture_native_team_publication()',31],
  [table,'native_input_team_after','public.capture_native_team_publication()',29],
 ]),
 ...['native_source_publications','native_installation_starts','native_input_start_contract'].map(table=>[table,'native_input_immutable','public.guard_native_input_fact()',27]),
 ...['native_source_publications','native_installation_starts','native_input_start_contract'].map(table=>[table,'native_input_no_truncate','public.guard_native_input_fact()',34]),
] as const
export const NATIVE_INPUT_START_EXPECTED=triggerSpecs.map(([table,name,fn,type])=>`('public.${table}','${name}','${fn}',${type})`).join(',')
export async function assertNativeInputStartSchema(db:Pick<pg.Pool,'query'>):Promise<void>{
 await assertNativeInputStartCompatible(db)
 const ready=(await db.query(`SELECT to_regclass('public.native_input_start_contract') IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM(VALUES ${NATIVE_INPUT_START_EXPECTED}) expected(relation,trigger_name,function_name,trigger_type)
   WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(expected.relation) AND t.tgname=expected.trigger_name
    AND t.tgfoid=to_regprocedure(expected.function_name) AND t.tgtype=expected.trigger_type AND t.tgenabled IN('O','A'))) AS ready`)).rows[0]?.ready
 if(!ready)throw Error('native_input_start_contract_required')
}
/** Explicit Relay migrator / supported independent legacy init only. No scan,
 * no current-XID backfill, no body copy, and no installation fan-out. */
export async function installNativeInputStart(db:Pick<pg.Pool,'query'>):Promise<void>{
 await assertNativeInputStartCompatible(db)
 await db.query(`
 CREATE TABLE IF NOT EXISTS public.native_input_start_contract(singleton boolean PRIMARY KEY DEFAULT TRUE CHECK(singleton),version int NOT NULL CHECK(version>0));
 INSERT INTO public.native_input_start_contract(singleton,version) VALUES(TRUE,1) ON CONFLICT DO NOTHING;
 CREATE SEQUENCE IF NOT EXISTS public.native_input_start_order AS bigint;
 CREATE TABLE IF NOT EXISTS public.native_source_publications(
  source_kind text NOT NULL CHECK(source_kind IN('relay_event','team_collaboration','team_delivery')),source_key text NOT NULL CHECK(length(source_key) BETWEEN 1 AND 1024),
  owner_key text CHECK(length(owner_key) BETWEEN 1 AND 1024),source_session_id text CHECK(length(source_session_id) BETWEEN 1 AND 512),retired boolean NOT NULL DEFAULT FALSE,
  publication_xid bigint,publication_order bigint,
  PRIMARY KEY(source_kind,source_key),CHECK(retired OR(owner_key IS NOT NULL AND source_session_id IS NOT NULL)),CHECK((publication_xid IS NULL AND publication_order IS NULL) OR(publication_xid>0 AND publication_order>0)));
 CREATE TABLE IF NOT EXISTS public.native_installation_starts(
  installation_id uuid PRIMARY KEY,provider_id text,retired boolean NOT NULL DEFAULT FALSE,original_policy text NOT NULL CHECK(original_policy IN('from_now','retained_history')),
  original_feed_id bigint NOT NULL CHECK(original_feed_id>=0),owner_user_id int,owner_scope_kind text,owner_scope_id uuid,
  start_xid bigint NOT NULL CHECK(start_xid>0),start_snapshot txid_snapshot NOT NULL,start_order bigint NOT NULL CHECK(start_order>0));
 CREATE INDEX IF NOT EXISTS native_source_publications_personal_owner ON public.native_source_publications(owner_key) WHERE source_kind='relay_event' AND NOT retired;
 CREATE INDEX IF NOT EXISTS native_source_publications_delivery_reader ON public.native_source_publications((CASE WHEN source_kind='team_delivery' THEN owner_key::jsonb->>1 END)) WHERE source_kind='team_delivery' AND NOT retired;
 CREATE INDEX IF NOT EXISTS native_installation_starts_owner ON public.native_installation_starts(owner_user_id) WHERE NOT retired;

 CREATE OR REPLACE FUNCTION public.guard_native_input_fact() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='native_source_publications' THEN
   IF NOT OLD.retired AND NEW.retired AND NEW.source_kind=OLD.source_kind AND NEW.source_key=OLD.source_key
    AND NEW.owner_key IS NULL AND NEW.source_session_id IS NULL AND NEW.publication_xid IS NULL AND NEW.publication_order IS NULL THEN RETURN NEW;END IF;
  ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='native_installation_starts' THEN
   IF NOT OLD.retired AND NEW.retired AND NEW.installation_id=OLD.installation_id AND NEW.provider_id IS NULL
    AND NEW.owner_user_id IS NULL AND NEW.owner_scope_kind IS NULL AND NEW.owner_scope_id IS NULL
    AND (NEW.original_policy,NEW.original_feed_id,NEW.start_xid,NEW.start_snapshot::text,NEW.start_order)
     IS NOT DISTINCT FROM(OLD.original_policy,OLD.original_feed_id,OLD.start_xid,OLD.start_snapshot::text,OLD.start_order) THEN RETURN NEW;END IF;
  END IF;
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='native_input_start_contract'
   AND COALESCE(to_jsonb(OLD)->>'team_semantic_capture_version','0')='0' AND to_jsonb(NEW)->>'team_semantic_capture_version'='1'
   AND(to_jsonb(NEW)-'team_semantic_capture_version') IS NOT DISTINCT FROM(to_jsonb(OLD)-'team_semantic_capture_version')
   AND pg_has_role(session_user,(SELECT relowner FROM pg_class WHERE oid='public.native_input_start_contract'::regclass),'MEMBER')
   AND public.native_team_semantic_structure_ready() THEN RETURN NEW;END IF;
  RAISE EXCEPTION 'native_input_fact_immutable';END $$;
 CREATE OR REPLACE FUNCTION public.retire_native_user_input() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
  UPDATE public.native_source_publications SET retired=TRUE,owner_key=NULL,source_session_id=NULL,publication_xid=NULL,publication_order=NULL
   WHERE NOT retired AND(source_kind='relay_event' AND owner_key=OLD.id::text OR source_kind='team_delivery' AND CASE WHEN source_kind='team_delivery' THEN owner_key::jsonb->>1 END=OLD.id::text);
  UPDATE public.native_installation_starts SET retired=TRUE,provider_id=NULL,owner_user_id=NULL,owner_scope_kind=NULL,owner_scope_id=NULL
   WHERE owner_user_id=OLD.id AND NOT retired;
  RETURN OLD;
 END $$;
 CREATE OR REPLACE FUNCTION public.capture_native_installation_start() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE snap txid_snapshot;BEGIN
  IF TG_OP='DELETE' THEN
   UPDATE public.native_installation_starts SET retired=TRUE,provider_id=NULL,owner_user_id=NULL,owner_scope_kind=NULL,owner_scope_id=NULL WHERE installation_id=OLD.installation_id AND NOT retired;
   RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
   IF OLD.provider_id='pocketctl-memory' AND NEW.provider_id IS DISTINCT FROM 'pocketctl-memory' THEN
    UPDATE public.native_installation_starts SET retired=TRUE,provider_id=NULL,owner_user_id=NULL,owner_scope_kind=NULL,owner_scope_id=NULL WHERE installation_id=OLD.installation_id AND NOT retired;
    RETURN NEW;
   END IF;
   IF NEW.provider_id IS DISTINCT FROM 'pocketctl-memory' THEN RETURN NEW;END IF;
   IF OLD.provider_id IS DISTINCT FROM 'pocketctl-memory' THEN RAISE EXCEPTION 'native_input_start_provider_rekey_unsupported';END IF;
   IF (OLD.installation_id,OLD.start_policy) IS DISTINCT FROM(NEW.installation_id,NEW.start_policy) THEN RAISE EXCEPTION 'native_input_start_immutable';END IF;
   RETURN NEW;
  END IF;
  -- Same provider identity used by the existing first-party Feed policy.
  -- Other Providers retain their native isolation/policy/recovery contract.
  IF NEW.provider_id IS DISTINCT FROM 'pocketctl-memory' THEN RETURN NEW;END IF;
  IF current_setting('transaction_isolation') NOT IN('read committed','read uncommitted') THEN RAISE EXCEPTION 'native_input_start_isolation_unsupported';END IF;
  snap=txid_current_snapshot();IF octet_length(snap::text)>1048576 THEN RAISE EXCEPTION 'native_input_start_snapshot_unsupported';END IF;
  INSERT INTO public.native_installation_starts(installation_id,provider_id,original_policy,original_feed_id,owner_user_id,owner_scope_kind,owner_scope_id,start_xid,start_snapshot,start_order)
   VALUES(NEW.installation_id,NEW.provider_id,NEW.start_policy,NEW.start_feed_id,NEW.owner_user_id,NEW.owner_scope_kind,COALESCE(NEW.owner_scope_id,CASE WHEN NEW.owner_scope_kind='personal' THEN NEW.installation_id END),txid_current(),snap,nextval('public.native_input_start_order'));
  RETURN NEW;
 END $$;
 CREATE OR REPLACE FUNCTION public.capture_native_event_publication() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE old_eligible boolean;BEGIN
  -- An eligible historical row may be updated, cooled or enter pending again.
  -- Its first observed update freezes UNKNOWN, never a new publication XID.
  IF TG_OP IN('UPDATE','DELETE') THEN
   old_eligible=OLD.effect_status IN('none','completed') AND OLD.user_id IS NOT NULL AND NOT OLD.owner_retired;
   IF old_eligible THEN
    INSERT INTO public.native_source_publications(source_kind,source_key,owner_key,source_session_id)
     VALUES('relay_event',OLD.id::text,OLD.user_id::text,OLD.logical_source_session_id) ON CONFLICT DO NOTHING;
   END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.id IS DISTINCT FROM NEW.id THEN
   INSERT INTO public.native_source_publications(source_kind,source_key,owner_key,source_session_id) VALUES('relay_event',NEW.id::text,NEW.user_id::text,NEW.logical_source_session_id) ON CONFLICT DO NOTHING;
  END IF;
  IF TG_OP='DELETE' OR(TG_OP='UPDATE' AND NEW.owner_retired) THEN
   UPDATE public.native_source_publications SET retired=TRUE,owner_key=NULL,source_session_id=NULL,publication_xid=NULL,publication_order=NULL
    WHERE source_kind='relay_event' AND source_key=OLD.id::text AND NOT retired;
   IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
  END IF;
  IF NEW.effect_status IN('none','completed') AND NEW.user_id IS NOT NULL AND NOT NEW.owner_retired
   AND EXISTS(SELECT 1 FROM public.sessions s JOIN public.daemons d USING(daemon_id) WHERE s.session_id=NEW.session_id
    AND s.user_id=NEW.user_id AND d.user_id=NEW.user_id AND s.source IS DISTINCT FROM 'app_review_demo')
   AND NEW.logical_source_session_id NOT LIKE 'app-review-demo-%' THEN
   INSERT INTO public.native_source_publications(source_kind,source_key,owner_key,source_session_id,publication_xid,publication_order)
    VALUES('relay_event',NEW.id::text,NEW.user_id::text,NEW.logical_source_session_id,txid_current(),nextval('public.native_input_start_order')) ON CONFLICT DO NOTHING;
  END IF;RETURN NEW;
 END $$;
 CREATE OR REPLACE FUNCTION public.native_team_publication_identity(p_kind text,p_key text) RETURNS TABLE(owner_key text,session_id text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
  IF p_kind='team_collaboration' THEN
   RETURN QUERY SELECT s.team_id,c.team_session_id FROM public.collaboration_calls c JOIN public.collaboration_sessions s USING(team_session_id)
    WHERE c.call_id=p_key AND c.state IN('completed','failed','cancelled','blocked')
     AND EXISTS(SELECT 1 FROM public.collaboration_events g WHERE g.event_id=c.event_id AND g.team_session_id=c.team_session_id AND g.kind='member_message')
     AND EXISTS(SELECT 1 FROM public.collaboration_events o WHERE o.call_id=c.call_id AND o.team_session_id=c.team_session_id AND o.kind='status'
      AND EXISTS(SELECT 1 FROM public.collaboration_events r WHERE r.call_id=c.call_id AND r.team_session_id=c.team_session_id AND r.kind='agent_message' AND r.event_seq<o.event_seq AND octet_length(r.content)>0));
  ELSIF p_kind='team_delivery' THEN
   RETURN QUERY SELECT jsonb_build_array(r.team_id,r.reader_user_id,r.binding_id,r.binding_revision,r.participant_revision,b.installation_id,b.owner_scope_kind,b.owner_scope_id)::text,r.team_session_id
    FROM public.team_delivery_memory_sources r JOIN public.team_acceptance_decisions d USING(decision_id) JOIN public.team_task_submissions s ON s.submission_id=r.submission_id
     JOIN public.team_memory_bindings b ON b.binding_id=r.binding_id AND b.revision=r.binding_revision
    WHERE r.source_session_id=p_key AND d.submission_id=r.submission_id AND d.decision='accepted' AND s.state='published' AND r.revoked_at IS NULL AND r.withdrawn_at IS NULL;
  END IF;
 END $$;
 CREATE OR REPLACE FUNCTION public.capture_native_team_publication() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE kind text;key text;event_key text;call_key text;identity record;BEGIN
  IF TG_TABLE_NAME='collaboration_calls' THEN
   -- Only the native nonterminal -> terminal call transition can publish a
   -- collaboration. An already-terminal incomplete call is UNKNOWN forever;
   -- later event SQL cannot supply its original terminal boundary.
   IF TG_OP='DELETE' THEN
    -- Historical calls can have no fact. Deletion must still consume the key
    -- irreversibly without retaining subjects or inventing a publication XID.
    INSERT INTO public.native_source_publications(source_kind,source_key,retired)
     VALUES('team_collaboration',OLD.call_id,TRUE) ON CONFLICT DO NOTHING;
    UPDATE public.native_source_publications SET retired=TRUE,owner_key=NULL,source_session_id=NULL,publication_xid=NULL,publication_order=NULL
     WHERE source_kind='team_collaboration' AND source_key=OLD.call_id AND NOT retired;
   ELSIF TG_WHEN='BEFORE' THEN
    IF TG_OP='UPDATE' AND OLD.state IN('completed','failed','cancelled','blocked') THEN
     INSERT INTO public.native_source_publications(source_kind,source_key,owner_key,source_session_id)
      SELECT 'team_collaboration',OLD.call_id,s.team_id,OLD.team_session_id FROM public.collaboration_sessions s WHERE s.team_session_id=OLD.team_session_id ON CONFLICT DO NOTHING;
    END IF;
   ELSIF NEW.state IN('completed','failed','cancelled','blocked') THEN
    INSERT INTO public.native_source_publications(source_kind,source_key,owner_key,source_session_id,publication_xid,publication_order)
     SELECT 'team_collaboration',NEW.call_id,s.team_id,NEW.team_session_id,
      CASE WHEN TG_OP='UPDATE' AND OLD.state IN('dispatched','accepted','uncertain') AND EXISTS(SELECT 1 FROM public.native_team_publication_identity('team_collaboration',NEW.call_id)) THEN txid_current() END,
      CASE WHEN TG_OP='UPDATE' AND OLD.state IN('dispatched','accepted','uncertain') AND EXISTS(SELECT 1 FROM public.native_team_publication_identity('team_collaboration',NEW.call_id)) THEN nextval('public.native_input_start_order') END
      FROM public.collaboration_sessions s WHERE s.team_session_id=NEW.team_session_id ON CONFLICT DO NOTHING;
   END IF;
   IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
  ELSIF TG_TABLE_NAME='collaboration_events' THEN
   -- Agent/status events have one call. Goal updates may affect several calls,
   -- but this never enumerates installations or access projections.
   call_key=CASE WHEN TG_OP='DELETE' THEN OLD.call_id ELSE NEW.call_id END;event_key=CASE WHEN TG_OP='DELETE' THEN OLD.event_id ELSE NEW.event_id END;
   FOR identity IN SELECT call_id FROM public.collaboration_calls WHERE call_id=call_key OR event_id=event_key LOOP
    IF TG_OP='DELETE' AND TG_WHEN='AFTER' AND NOT EXISTS(SELECT 1 FROM public.native_team_publication_identity('team_collaboration',identity.call_id)) THEN
     UPDATE public.native_source_publications SET retired=TRUE,owner_key=NULL,source_session_id=NULL,publication_xid=NULL,publication_order=NULL
      WHERE source_kind='team_collaboration' AND source_key=identity.call_id AND NOT retired;
    END IF;
    INSERT INTO public.native_source_publications(source_kind,source_key,owner_key,source_session_id,publication_xid,publication_order)
     SELECT 'team_collaboration',identity.call_id,p.owner_key,p.session_id,
      NULL,NULL
      FROM public.native_team_publication_identity('team_collaboration',identity.call_id) p ON CONFLICT DO NOTHING;
   END LOOP;
   IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
  ELSE
   kind='team_delivery';
   key=CASE WHEN TG_OP='DELETE' THEN OLD.source_session_id ELSE NEW.source_session_id END;
  END IF;
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='team_delivery_memory_sources' THEN
   IF NEW.revoked_at IS NOT NULL OR NEW.withdrawn_at IS NOT NULL THEN
    UPDATE public.native_source_publications SET retired=TRUE,owner_key=NULL,source_session_id=NULL,publication_xid=NULL,publication_order=NULL WHERE source_kind=kind AND source_key=key AND NOT retired;
   END IF;
  END IF;
  IF key IS NOT NULL AND TG_OP='DELETE' AND TG_TABLE_NAME IN('collaboration_calls','team_delivery_memory_sources') THEN
   UPDATE public.native_source_publications SET retired=TRUE,owner_key=NULL,source_session_id=NULL,publication_xid=NULL,publication_order=NULL
    WHERE source_kind=kind AND source_key=key AND NOT retired;
  END IF;
  IF key IS NOT NULL THEN
   INSERT INTO public.native_source_publications(source_kind,source_key,owner_key,source_session_id,publication_xid,publication_order)
    SELECT kind,key,p.owner_key,p.session_id,CASE WHEN TG_WHEN='AFTER' THEN txid_current() END,
     CASE WHEN TG_WHEN='AFTER' THEN nextval('public.native_input_start_order') END
     FROM public.native_team_publication_identity(kind,key) p ON CONFLICT DO NOTHING;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
 END $$;
 REVOKE ALL ON public.native_source_publications,public.native_installation_starts,public.native_input_start_contract,public.native_input_start_order FROM PUBLIC;
 REVOKE ALL ON FUNCTION public.guard_native_input_fact(),public.capture_native_installation_start(),public.capture_native_event_publication(),
  public.native_team_publication_identity(text,text),public.capture_native_team_publication(),public.retire_native_user_input() FROM PUBLIC;
 `)
 for(const [table,name,fn,type] of triggerSpecs){
  const before=Number(type)&2?'BEFORE':'AFTER'
  const ops=Number(type)===5?'INSERT':Number(type)===11?'DELETE':Number(type)===34?'TRUNCATE':Number(type)===27?'UPDATE OR DELETE':'INSERT OR UPDATE OR DELETE'
  await db.query(`DROP TRIGGER IF EXISTS ${name} ON public.${table}; CREATE TRIGGER ${name} ${before} ${ops} ON public.${table} FOR EACH ${Number(type)===34?'STATEMENT':'ROW'} EXECUTE FUNCTION ${fn}`)
 }
 await installNativeTeamSemanticPublication(db)
}
