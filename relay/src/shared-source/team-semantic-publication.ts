import type pg from 'pg'

/** Original native group birth is independent of every later reader receipt.
 * Neither installation fanout nor normalized bodies belong in this ledger. */
export const NATIVE_TEAM_SEMANTIC_VERSION=1
const columnTypes={source_kind:'text',business_key_hash:'bytea',original_business_key:'text',team_id:'text',team_session_id:'text',call_id:'text',submission_id:'uuid',decision_id:'uuid',binding_id:'text',binding_revision:'bigint',target_installation_id:'uuid',target_owner_scope_kind:'text',target_owner_scope_id:'uuid',publication_xid:'bigint',publication_order:'bigint',retired:'boolean'}
const columns=Object.entries(columnTypes).map(([name,type])=>`('${name}','${type}')`).join(',')
const triggerSpecs=[
 ...['collaboration_calls','team_acceptance_decisions'].flatMap(table=>[
  [table,'native_team_semantic_before','capture_native_team_semantic_publication',31],
  [table,'native_team_semantic_after','capture_native_team_semantic_publication',29],
 ]),
 ...['collaboration_events','team_memory_bindings','extension_installations','collaboration_sessions','collaboration_teams'].map(table=>[table,'native_team_semantic_dependency','capture_native_team_semantic_publication',27]),
 ['collaboration_events','native_team_semantic_event_insert','capture_native_team_semantic_publication',5],
 ['users','native_team_semantic_user_privacy','capture_native_team_semantic_publication',11],
 ['native_team_semantic_publications','native_team_semantic_immutable','guard_native_team_semantic_fact',27],
 ['native_team_semantic_publications','native_team_semantic_no_truncate','guard_native_team_semantic_fact',34],
 ['collaboration_events','native_team_content_eligibility_capture','capture_native_team_content_eligibility',23],
 ['collaboration_events','native_team_content_eligibility_guard','capture_native_team_content_eligibility',19],
] as const
const expected=triggerSpecs.map(([table,name,fn,type])=>`('public.${table}','${name}','public.${fn}()',${type})`).join(',')
const privateFunctions=['native_team_semantic_identity(text,text)','capture_native_team_semantic_publication()','guard_native_team_semantic_fact()','native_team_semantic_structure_ready()','capture_native_team_content_eligibility()']
const functions=privateFunctions.map(fn=>`('public.${fn}')`).join(',')
const checkDefinitions={
 native_team_semantic_publications_source_kind_check:"CHECK (source_kind = ANY (ARRAY['team_collaboration'::text, 'team_delivery'::text]))",
 native_team_semantic_publications_business_key_hash_check:'CHECK (octet_length(business_key_hash) = 32)',
 native_team_semantic_publications_original_business_key_check:'CHECK (length(original_business_key) >= 1 AND length(original_business_key) <= 1024)',
 native_team_semantic_publications_binding_revision_check:'CHECK (binding_revision > 0)',
 native_team_semantic_publications_target_owner_scope_kind_check:"CHECK (target_owner_scope_kind = ANY (ARRAY['personal'::text, 'team'::text, 'organization'::text]))",
 native_team_semantic_publications_check:'CHECK (publication_xid IS NULL AND publication_order IS NULL OR publication_xid > 0 AND publication_order > 0 AND original_business_key IS NOT NULL AND team_id IS NOT NULL AND team_session_id IS NOT NULL AND call_id IS NOT NULL AND binding_id IS NOT NULL AND binding_revision IS NOT NULL AND target_installation_id IS NOT NULL AND target_owner_scope_kind IS NOT NULL AND target_owner_scope_id IS NOT NULL)',
 native_team_semantic_publications_check1:'CHECK (NOT retired OR original_business_key IS NULL AND team_id IS NULL AND team_session_id IS NULL AND call_id IS NULL AND submission_id IS NULL AND decision_id IS NULL AND binding_id IS NULL AND binding_revision IS NULL AND target_installation_id IS NULL AND target_owner_scope_kind IS NULL AND target_owner_scope_id IS NULL AND publication_xid IS NULL AND publication_order IS NULL)',
}
const sqlLiteral=(v:string)=>"'"+v.replaceAll("'","''")+"'"
const checks=Object.entries(checkDefinitions).map(([name,definition])=>`(${sqlLiteral(name)},${sqlLiteral(definition)})`).join(',')
const indexColumns=[['team','team_id'],['session','team_session_id'],['binding','binding_id'],['target','target_installation_id'],['call','call_id'],['submission','submission_id']] as const
const indexes=indexColumns.map(([name,column])=>`('native_team_semantic_${name}','${column}')`).join(',')
const metadataHelper='public.read_native_team_semantic_publication(text,text)'
const metadataHelperResult='TABLE(source_kind text, business_key_hash text, original_business_key text, team_id text, team_session_id text, call_id text, submission_id text, decision_id text, binding_id text, binding_revision text, target_installation_id text, target_owner_scope_kind text, target_owner_scope_id text, publication_xid text, publication_order text, retired boolean)'
const helperAcl=`(to_regprocedure('${metadataHelper}') IS NULL OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('${metadataHelper}')
 AND p.prosecdef AND p.provolatile='s' AND p.proretset AND p.proowner=(SELECT relowner FROM pg_class WHERE oid=to_regclass('public.native_input_start_contract'))
 AND pg_get_function_result(p.oid)='${metadataHelperResult}'
 AND EXISTS(SELECT 1 FROM unnest(p.proconfig) setting WHERE replace(setting,' ','')='search_path=pg_catalog,public')
 AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee<>p.proowner AND NOT COALESCE((
  acl.privilege_type='EXECUTE' AND NOT acl.is_grantable
  AND acl.grantee=(SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('shared.read_memory_team_semantic_group(uuid,text,text)'))
  AND acl.grantee=(SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='memory' AND c.relname='memory_schema_migrations' AND c.relkind='r')
  AND EXISTS(SELECT 1 FROM pg_roles role WHERE role.oid=acl.grantee AND NOT role.rolcanlogin AND NOT role.rolsuper AND NOT role.rolcreatedb AND NOT role.rolcreaterole AND NOT role.rolreplication AND NOT role.rolbypassrls)),FALSE))))`
export const NATIVE_TEAM_SEMANTIC_STRUCTURE=`
 to_regclass('public.native_team_semantic_publications') IS NOT NULL
 AND ${helperAcl}
 AND EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.native_team_semantic_publications') AND relkind='r' AND NOT relrowsecurity AND NOT relforcerowsecurity
  AND relowner=(SELECT relowner FROM pg_class WHERE oid=to_regclass('public.native_input_start_contract')))
 AND EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_index x ON x.indexrelid=c.conindid WHERE c.conrelid=to_regclass('public.native_team_semantic_publications') AND c.contype='p' AND x.indisvalid AND x.indisready
  AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='source_kind'),(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='business_key_hash')]::smallint[])
 AND NOT EXISTS(SELECT 1 FROM(VALUES ${columns}) expected(column_name,column_type) WHERE NOT EXISTS(SELECT 1 FROM pg_attribute a
  WHERE a.attrelid=to_regclass('public.native_team_semantic_publications') AND a.attname=expected.column_name AND a.atttypid=to_regtype(expected.column_type) AND a.attnotnull=(expected.column_name IN('source_kind','business_key_hash','retired')) AND a.attnum>0 AND NOT a.attisdropped))
 AND (SELECT count(*)=16 FROM pg_attribute WHERE attrelid=to_regclass('public.native_team_semantic_publications') AND attnum>0 AND NOT attisdropped)
 AND (SELECT count(*)=8 FROM pg_constraint WHERE conrelid=to_regclass('public.native_team_semantic_publications'))
 AND NOT EXISTS(SELECT 1 FROM(VALUES ${checks}) expected(constraint_name,definition) WHERE NOT EXISTS(SELECT 1 FROM pg_constraint c
  WHERE c.conrelid=to_regclass('public.native_team_semantic_publications') AND c.conname=expected.constraint_name AND c.contype='c' AND c.convalidated AND pg_get_constraintdef(c.oid,TRUE)=expected.definition))
 AND NOT EXISTS(SELECT 1 FROM(VALUES ${indexes}) expected(index_name,column_name) WHERE NOT EXISTS(SELECT 1 FROM pg_index x JOIN pg_class idx ON idx.oid=x.indexrelid JOIN pg_am am ON am.oid=idx.relam
  JOIN pg_attribute a ON a.attrelid=x.indrelid AND a.attname=expected.column_name
  WHERE x.indrelid=to_regclass('public.native_team_semantic_publications') AND idx.oid=to_regclass('public.'||expected.index_name)
   AND x.indisvalid AND x.indisready AND x.indislive AND NOT x.indisunique AND NOT x.indisprimary AND x.indnatts=1 AND x.indnkeyatts=1 AND x.indkey[0]=a.attnum
   AND x.indexprs IS NULL AND pg_get_expr(x.indpred,x.indrelid,TRUE)='NOT retired' AND am.amname='btree'))
 AND NOT EXISTS(SELECT 1 FROM(VALUES ${expected}) expected(relation,trigger_name,function_name,trigger_type) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
  WHERE t.tgrelid=to_regclass(expected.relation) AND t.tgname=expected.trigger_name AND t.tgfoid=to_regprocedure(expected.function_name)
   AND t.tgtype=expected.trigger_type AND t.tgenabled IN('O','A') AND NOT t.tgisinternal AND t.tgqual IS NULL
   AND t.tgattr::text=CASE expected.trigger_name
    WHEN 'native_team_content_eligibility_capture' THEN(SELECT attnum::text FROM pg_attribute WHERE attrelid=to_regclass('public.collaboration_events') AND attname='content' AND NOT attisdropped)
    WHEN 'native_team_content_eligibility_guard' THEN(SELECT attnum::text FROM pg_attribute WHERE attrelid=to_regclass('public.collaboration_events') AND attname='native_team_content_eligibility_version' AND NOT attisdropped)||' '||(SELECT attnum::text FROM pg_attribute WHERE attrelid=to_regclass('public.collaboration_events') AND attname='native_team_content_eligible' AND NOT attisdropped)
    ELSE '' END AND t.tgnargs=0 AND t.tgargs=decode('','hex') AND t.tgconstraint=0 AND t.tgconstrrelid=0 AND t.tgconstrindid=0
   AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgparentid=0 AND p.prosecdef
   AND p.proowner=(SELECT relowner FROM pg_class WHERE oid=to_regclass('public.native_input_start_contract'))
   AND EXISTS(SELECT 1 FROM unnest(p.proconfig) setting WHERE replace(setting,' ','')='search_path=pg_catalog,public')))
 AND NOT EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
  WHERE c.oid=to_regclass('public.native_team_semantic_publications') AND a.grantee<>c.relowner)
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid,LATERAL aclexplode(a.attacl) acl
  WHERE c.oid=to_regclass('public.native_team_semantic_publications') AND a.attnum>0 AND NOT a.attisdropped AND acl.grantee<>c.relowner)
 AND NOT EXISTS(SELECT 1 FROM(VALUES ('native_team_content_eligibility_version','smallint'),('native_team_content_eligible','boolean')) expected(column_name,column_type)
  WHERE NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.collaboration_events') AND a.attname=expected.column_name
   AND a.atttypid=to_regtype(expected.column_type) AND a.attnum>0 AND NOT a.attisdropped AND NOT a.attnotnull AND NOT a.atthasdef AND a.attidentity='' AND a.attgenerated=''
   AND NOT EXISTS(SELECT 1 FROM aclexplode(a.attacl) acl WHERE acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=to_regclass('public.native_input_start_contract')))))
 AND EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('public.collaboration_events') AND c.conname='native_team_content_eligibility_pair' AND c.contype='c' AND NOT c.convalidated
  AND pg_get_constraintdef(c.oid,TRUE)='CHECK (native_team_content_eligibility_version IS NULL AND native_team_content_eligible IS NULL OR native_team_content_eligibility_version IS NOT NULL AND native_team_content_eligibility_version = 1 AND native_team_content_eligible IS NOT NULL) NOT VALID')
 AND NOT EXISTS(SELECT 1 FROM(VALUES ${functions}) expected(function_name) WHERE NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(expected.function_name)
  AND p.prosecdef AND p.proowner=(SELECT relowner FROM pg_class WHERE oid=to_regclass('public.native_input_start_contract')) AND EXISTS(SELECT 1 FROM unnest(p.proconfig) setting WHERE replace(setting,' ','')='search_path=pg_catalog,public')
  AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)))`

/** Independent native pre-DDL gate. A phased semantic0 is valid only when
 * there are no semantic objects. A promised semantic1 is never reconstructed. */
export async function assertNativeTeamSemanticCompatible(db:Pick<pg.Pool,'query'>):Promise<void>{
 let native='0',shared='0'
 for(const [relation,isNative] of [['public.native_input_start_contract',true],['shared.memory_source_contract',false]] as const){
  if(!(await db.query('SELECT to_regclass($1) IS NOT NULL AS present',[relation])).rows[0]?.present)continue
  const shape=(await db.query("SELECT a.atttypid='int4'::regtype AND a.attnotnull AS valid FROM pg_attribute a WHERE a.attrelid=to_regclass($1) AND a.attname='team_semantic_capture_version' AND a.attnum>0 AND NOT a.attisdropped",[relation])).rows
  if(shape.length&&shape[0].valid!==true)throw Error('unsupported_native_team_semantic_contract')
  const rows=(await db.query(`SELECT COALESCE(to_jsonb(c)->>'team_semantic_capture_version','0') AS version FROM ${relation} c`)).rows
  if(rows.length!==1||!['0','1'].includes(rows[0].version))throw Error('unsupported_native_team_semantic_contract')
  if(isNative)native=rows[0].version;else shared=rows[0].version
 }
 const partial=(await db.query(`SELECT to_regclass('public.native_team_semantic_publications') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_proc WHERE oid IN(to_regprocedure('public.native_team_semantic_identity(text,text)'),to_regprocedure('public.capture_native_team_semantic_publication()'),to_regprocedure('public.guard_native_team_semantic_fact()'),to_regprocedure('public.native_team_semantic_structure_ready()'),to_regprocedure('public.capture_native_team_content_eligibility()'),to_regprocedure('public.read_native_team_semantic_publication(text,text)')))
  OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.collaboration_events') AND attname IN('native_team_content_eligibility_version','native_team_content_eligible') AND attnum>0 AND NOT attisdropped) AS present`)).rows[0]?.present
 if(native==='0'&&shared==='0'){
  if(partial)throw Error('native_team_semantic_history_missing')
  return
 }
 if(native!=='1'||!(await db.query(`SELECT ${NATIVE_TEAM_SEMANTIC_STRUCTURE} AS ready`)).rows[0]?.ready)throw Error('native_team_semantic_history_missing')
}

const scrub=`retired=TRUE,original_business_key=NULL,team_id=NULL,team_session_id=NULL,call_id=NULL,submission_id=NULL,decision_id=NULL,binding_id=NULL,binding_revision=NULL,target_installation_id=NULL,target_owner_scope_kind=NULL,target_owner_scope_id=NULL,publication_xid=NULL,publication_order=NULL`
// One metadata-only selection algorithm is embedded in the two already
// allocated trigger entrypoints. Actual INSERT uses AFTER, so ON CONFLICT
// DO NOTHING cannot consume a key as an uncommitted BEFORE side effect.
const eventCoreFence=()=>`
  old_event=NULL;old_call=NULL;
  IF TG_OP<>'INSERT' THEN old_event=OLD.event_id;old_call=OLD.call_id;END IF;
  new_event=NULL;new_call=NULL;
  IF TG_OP<>'DELETE' THEN new_event=NEW.event_id;new_call=NEW.call_id;END IF;
  FOR candidate IN SELECT c.call_id,c.event_id,c.team_session_id FROM public.collaboration_calls c
   WHERE c.call_id IN(old_call,new_call) OR c.event_id IN(old_event,new_event) ORDER BY c.call_id COLLATE "C" FOR UPDATE NOWAIT LOOP
   IF NOT EXISTS(SELECT 1 FROM public.native_team_semantic_publications p WHERE p.source_kind='team_collaboration'
    AND p.business_key_hash=sha256(convert_to(jsonb_build_array('team_collaboration'::text,candidate.call_id)::text,'UTF8')) AND NOT p.retired) THEN CONTINUE;END IF;
   SELECT e.event_id,e.event_seq INTO boundary_event,boundary_seq FROM public.collaboration_events e
    WHERE e.call_id=candidate.call_id AND e.team_session_id=candidate.team_session_id AND e.kind='status'
     AND(TG_OP<>'INSERT' OR e.event_id<>new_event) ORDER BY e.event_seq DESC,e.event_id COLLATE "C" DESC LIMIT 1;
   selected=FALSE;
   IF TG_OP<>'INSERT' THEN
    selected=OLD.event_id=candidate.event_id OR(OLD.team_session_id=candidate.team_session_id AND OLD.call_id=candidate.call_id
     AND(OLD.kind='status' AND OLD.event_id=boundary_event OR OLD.kind='agent_message' AND(boundary_seq IS NULL OR OLD.event_seq<boundary_seq)));
   END IF;
   IF TG_OP<>'DELETE' THEN
    selected=selected OR NEW.event_id=candidate.event_id OR(NEW.team_session_id=candidate.team_session_id AND NEW.call_id=candidate.call_id
     AND(NEW.kind='status' AND(boundary_seq IS NULL OR NEW.event_seq>boundary_seq OR NEW.event_id=boundary_event)
      OR NEW.kind='agent_message' AND(boundary_seq IS NULL OR NEW.event_seq<boundary_seq)));
   END IF;
   IF selected IS DISTINCT FROM FALSE THEN
    UPDATE public.native_team_semantic_publications SET ${scrub} WHERE source_kind='team_collaboration'
     AND business_key_hash=sha256(convert_to(jsonb_build_array('team_collaboration'::text,candidate.call_id)::text,'UTF8')) AND NOT retired;
   END IF;
  END LOOP;
`
/** Called only by the dedicated native migrator inside its schema transaction.
 * One query keeps phased install atomic even for a controlled owned client. */
export async function installNativeTeamSemanticPublication(db:Pick<pg.Pool,'query'>):Promise<void>{
 await assertNativeTeamSemanticCompatible(db)
 const ddl=[`
 ALTER TABLE public.collaboration_events ADD COLUMN IF NOT EXISTS native_team_content_eligibility_version smallint NULL,
  ADD COLUMN IF NOT EXISTS native_team_content_eligible boolean NULL;
 DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.collaboration_events'::regclass AND conname='native_team_content_eligibility_pair') THEN
  ALTER TABLE public.collaboration_events ADD CONSTRAINT native_team_content_eligibility_pair CHECK(
   native_team_content_eligibility_version IS NULL AND native_team_content_eligible IS NULL
   OR native_team_content_eligibility_version IS NOT NULL AND native_team_content_eligibility_version=1 AND native_team_content_eligible IS NOT NULL) NOT VALID;
 END IF;END $$;
 CREATE OR REPLACE FUNCTION public.capture_native_team_content_eligibility() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE candidate record;old_event text;old_call text;new_event text;new_call text;boundary_event text;boundary_seq bigint;selected boolean;BEGIN
  IF current_setting('transaction_isolation') NOT IN('read committed','read uncommitted') THEN RAISE EXCEPTION 'native_team_semantic_writer_isolation_unsupported';END IF;
  IF TG_NAME='native_team_content_eligibility_guard' THEN RAISE EXCEPTION 'native_team_content_header_immutable';END IF;
  -- Only the native INSERT/content-write trigger reaches this branch. No
  -- stored body is selected or inspected by a terminal/read authority fence.
  IF TG_OP='UPDATE' THEN ${eventCoreFence()} END IF;
  NEW.native_team_content_eligibility_version=1;
  NEW.native_team_content_eligible=NEW.content IS NOT NULL AND octet_length(NEW.content)>0;
  RETURN NEW;
 END $$;
 CREATE TABLE IF NOT EXISTS public.native_team_semantic_publications(
  source_kind text NOT NULL CHECK(source_kind IN('team_collaboration','team_delivery')),
  business_key_hash bytea NOT NULL CHECK(octet_length(business_key_hash)=32),
  original_business_key text CHECK(length(original_business_key) BETWEEN 1 AND 1024),team_id text,team_session_id text,call_id text,submission_id uuid,decision_id uuid,
  binding_id text,binding_revision bigint CHECK(binding_revision>0),target_installation_id uuid,target_owner_scope_kind text CHECK(target_owner_scope_kind IN('personal','team','organization')),target_owner_scope_id uuid,
  publication_xid bigint,publication_order bigint,retired boolean NOT NULL DEFAULT FALSE,
  PRIMARY KEY(source_kind,business_key_hash),
  CHECK((publication_xid IS NULL AND publication_order IS NULL) OR(publication_xid>0 AND publication_order>0 AND original_business_key IS NOT NULL AND team_id IS NOT NULL AND team_session_id IS NOT NULL AND call_id IS NOT NULL AND binding_id IS NOT NULL AND binding_revision IS NOT NULL AND target_installation_id IS NOT NULL AND target_owner_scope_kind IS NOT NULL AND target_owner_scope_id IS NOT NULL)),
  CHECK(NOT retired OR(original_business_key IS NULL AND team_id IS NULL AND team_session_id IS NULL AND call_id IS NULL AND submission_id IS NULL AND decision_id IS NULL AND binding_id IS NULL AND binding_revision IS NULL AND target_installation_id IS NULL AND target_owner_scope_kind IS NULL AND target_owner_scope_id IS NULL AND publication_xid IS NULL AND publication_order IS NULL)));
 ${indexColumns.map(([name,column])=>`CREATE INDEX IF NOT EXISTS native_team_semantic_${name} ON public.native_team_semantic_publications(${column}) WHERE NOT retired;`).join('\n')}
 CREATE OR REPLACE FUNCTION public.guard_native_team_semantic_fact() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
  IF TG_OP='UPDATE' AND NOT OLD.retired AND NEW.retired AND(NEW.source_kind,NEW.business_key_hash) IS NOT DISTINCT FROM(OLD.source_kind,OLD.business_key_hash)
   AND NEW.original_business_key IS NULL AND NEW.team_id IS NULL AND NEW.team_session_id IS NULL AND NEW.call_id IS NULL AND NEW.submission_id IS NULL AND NEW.decision_id IS NULL
   AND NEW.binding_id IS NULL AND NEW.binding_revision IS NULL AND NEW.target_installation_id IS NULL AND NEW.target_owner_scope_kind IS NULL AND NEW.target_owner_scope_id IS NULL
   AND NEW.publication_xid IS NULL AND NEW.publication_order IS NULL THEN RETURN NEW;END IF;
  RAISE EXCEPTION 'native_team_semantic_fact_immutable';
 END $$;
 CREATE OR REPLACE FUNCTION public.native_team_semantic_identity(p_kind text,p_key text)
 RETURNS TABLE(team_id text,team_session_id text,call_id text,submission_id uuid,decision_id uuid,binding_id text,binding_revision bigint,target_installation_id uuid,target_owner_scope_kind text,target_owner_scope_id uuid)
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE c record;b record;s record;d record;submission_key uuid;decision_key uuid;goal record;outcome record;reply record;reply_count int:=0;nonempty_reply boolean:=FALSE;BEGIN
  IF p_kind='team_collaboration' THEN
   SELECT call_row.call_id,call_row.team_session_id,call_row.event_id,call_row.state,call_row.task_id,call_row.offer_id,call_row.context_version INTO c FROM public.collaboration_calls call_row WHERE call_row.call_id=p_key AND call_row.state IN('completed','failed','cancelled','blocked') FOR SHARE NOWAIT;
   IF NOT FOUND THEN RETURN;END IF;
   SELECT e.event_id,e.event_seq,e.native_team_content_eligibility_version AS eligibility_version,e.native_team_content_eligible AS eligible INTO goal
    FROM public.collaboration_events e WHERE e.event_id=c.event_id AND e.team_session_id=c.team_session_id AND e.kind='member_message' FOR SHARE NOWAIT;
   IF NOT FOUND OR goal.eligibility_version IS DISTINCT FROM 1 OR goal.eligible IS NULL THEN RETURN;END IF;
   SELECT e.event_id,e.event_seq,e.native_team_content_eligibility_version AS eligibility_version,e.native_team_content_eligible AS eligible INTO outcome
    FROM public.collaboration_events e WHERE e.call_id=c.call_id AND e.team_session_id=c.team_session_id AND e.kind='status'
    ORDER BY e.event_seq DESC,e.event_id COLLATE "C" DESC LIMIT 1 FOR SHARE NOWAIT;
   IF NOT FOUND OR outcome.eligibility_version IS DISTINCT FROM 1 OR outcome.eligible IS NULL THEN RETURN;END IF;
   FOR reply IN SELECT e.event_id,e.event_seq,e.native_team_content_eligibility_version AS eligibility_version,e.native_team_content_eligible AS eligible
    FROM public.collaboration_events e WHERE e.call_id=c.call_id AND e.team_session_id=c.team_session_id AND e.kind='agent_message' AND e.event_seq<outcome.event_seq
    ORDER BY e.event_id COLLATE "C" LIMIT 513 FOR SHARE NOWAIT LOOP
    reply_count=reply_count+1;
    IF reply_count>512 OR reply.eligibility_version IS DISTINCT FROM 1 OR reply.eligible IS NULL THEN RETURN;END IF;
    nonempty_reply=nonempty_reply OR reply.eligible;
   END LOOP;
   IF NOT nonempty_reply THEN RETURN;END IF;
  ELSIF p_kind='team_delivery' THEN
   SELECT decision.decision_id,decision.submission_id,decision.task_id,decision.spec_revision,decision.reviewer_user_id,decision.decision INTO d FROM public.team_acceptance_decisions decision WHERE decision.decision_id=p_key::uuid AND decision.decision='accepted' FOR SHARE NOWAIT;
   IF NOT FOUND THEN RETURN;END IF;
   submission_key=d.submission_id;decision_key=d.decision_id;
   SELECT submission.source_call_id,submission.task_id,submission.source_offer_id,submission.context_version INTO s FROM public.team_task_submissions submission JOIN public.team_task_specs spec ON spec.task_id=submission.task_id AND spec.revision=submission.spec_revision
    WHERE submission.submission_id=d.submission_id AND submission.task_id=d.task_id AND submission.spec_revision=d.spec_revision AND submission.state='published'
     AND spec.reviewer_user_id=d.reviewer_user_id FOR SHARE OF submission,spec NOWAIT;
   IF NOT FOUND THEN RETURN;END IF;
   SELECT call_row.call_id,call_row.team_session_id,call_row.event_id,call_row.state,call_row.task_id,call_row.offer_id,call_row.context_version INTO c FROM public.collaboration_calls call_row WHERE call_row.call_id=s.source_call_id AND call_row.task_id=s.task_id AND call_row.offer_id=s.source_offer_id AND call_row.context_version=s.context_version FOR SHARE NOWAIT;
   IF NOT FOUND THEN RETURN;END IF;
  ELSE RETURN;END IF;
  SELECT session.team_id,session.team_session_id INTO s FROM public.collaboration_sessions session JOIN public.collaboration_teams team USING(team_id)
   WHERE session.team_session_id=c.team_session_id AND team.state='active' AND session.state IN('active','paused') FOR SHARE OF session,team NOWAIT;
  IF NOT FOUND THEN RETURN;END IF;
  IF(SELECT count(*) FROM public.team_memory_bindings binding WHERE binding.team_id=s.team_id AND binding.state='active')<>1 THEN RETURN;END IF;
  SELECT binding.binding_id,binding.revision,binding.installation_id,binding.owner_scope_kind,binding.owner_scope_id INTO b
   FROM public.team_memory_bindings binding JOIN public.extension_installations target ON target.installation_id=binding.installation_id
   WHERE binding.team_id=s.team_id AND binding.state='active' AND binding.revision>0 AND target.provider_id='pocketctl-memory' AND target.status='active'
    AND(target.owner_scope_kind,target.owner_scope_id) IS NOT DISTINCT FROM(binding.owner_scope_kind,binding.owner_scope_id)
   FOR SHARE OF binding,target NOWAIT;
  IF NOT FOUND THEN RETURN;END IF;
  RETURN QUERY SELECT s.team_id::text,s.team_session_id::text,c.call_id::text,submission_key,decision_key,
   b.binding_id::text,b.revision::bigint,b.installation_id::uuid,b.owner_scope_kind::text,b.owner_scope_id::uuid;
 END $$;
 CREATE OR REPLACE FUNCTION public.capture_native_team_semantic_publication() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE kind text;key text;fact record;supported boolean:=FALSE;h bytea;candidate record;old_event text;old_call text;new_event text;new_call text;boundary_event text;boundary_seq bigint;selected boolean;BEGIN
  -- Other Providers do not participate in Memory's native semantic ledger.
  -- Preserve their supported RR/serializable control/recovery transactions.
  -- A rekey involving Memory still reaches all original guards below.
  IF TG_TABLE_NAME='extension_installations' THEN
   IF TG_OP='DELETE' THEN
    IF OLD.provider_id IS DISTINCT FROM 'pocketctl-memory' THEN RETURN OLD;END IF;
   ELSIF TG_OP='INSERT' THEN
    IF NEW.provider_id IS DISTINCT FROM 'pocketctl-memory' THEN RETURN NEW;END IF;
   ELSIF OLD.provider_id IS DISTINCT FROM 'pocketctl-memory' AND NEW.provider_id IS DISTINCT FROM 'pocketctl-memory' THEN RETURN NEW;
   END IF;
  END IF;
  IF current_setting('transaction_isolation') NOT IN('read committed','read uncommitted') THEN RAISE EXCEPTION 'native_team_semantic_writer_isolation_unsupported';END IF;
  IF TG_TABLE_NAME IN('collaboration_calls','team_acceptance_decisions') THEN
   kind=CASE WHEN TG_TABLE_NAME='collaboration_calls' THEN 'team_collaboration' ELSE 'team_delivery' END;
   IF kind='team_collaboration' THEN key=CASE WHEN TG_OP='DELETE' THEN OLD.call_id ELSE NEW.call_id END;
   ELSE key=CASE WHEN TG_OP='DELETE' THEN OLD.decision_id::text ELSE NEW.decision_id::text END;END IF;
   IF TG_OP='DELETE' THEN
    h=sha256(convert_to(jsonb_build_array(kind,key)::text,'UTF8'));
    INSERT INTO public.native_team_semantic_publications(source_kind,business_key_hash,retired) VALUES(kind,h,TRUE) ON CONFLICT DO NOTHING;
    UPDATE public.native_team_semantic_publications SET ${scrub} WHERE source_kind=kind AND business_key_hash=h AND NOT retired;
    RETURN OLD;
   END IF;
   IF TG_WHEN='BEFORE' THEN
    IF TG_OP='INSERT' THEN RETURN NEW;END IF;
    IF kind='team_collaboration' THEN key=OLD.call_id;supported=OLD.state IN('completed','failed','cancelled','blocked');
    ELSE key=OLD.decision_id::text;supported=TRUE;END IF;
    IF supported THEN
     INSERT INTO public.native_team_semantic_publications(source_kind,business_key_hash,original_business_key)
      VALUES(kind,sha256(convert_to(jsonb_build_array(kind,key)::text,'UTF8')),key) ON CONFLICT DO NOTHING;
    END IF;
    IF kind='team_collaboration' THEN
     IF(OLD.call_id,OLD.team_session_id,OLD.event_id,OLD.context_version,OLD.offer_id,OLD.task_id) IS DISTINCT FROM(NEW.call_id,NEW.team_session_id,NEW.event_id,NEW.context_version,NEW.offer_id,NEW.task_id) THEN
      UPDATE public.native_team_semantic_publications SET ${scrub} WHERE call_id=OLD.call_id AND NOT retired;
     END IF;
    END IF;
    IF kind='team_collaboration' THEN h=sha256(convert_to(jsonb_build_array(kind,NEW.call_id)::text,'UTF8'));
    ELSE h=sha256(convert_to(jsonb_build_array(kind,NEW.decision_id::text)::text,'UTF8'));END IF;
    IF h IS DISTINCT FROM sha256(convert_to(jsonb_build_array(kind,key)::text,'UTF8')) THEN
     UPDATE public.native_team_semantic_publications SET ${scrub} WHERE source_kind=kind AND business_key_hash=sha256(convert_to(jsonb_build_array(kind,key)::text,'UTF8')) AND NOT retired;
     IF kind='team_collaboration' THEN key=NEW.call_id;ELSE key=NEW.decision_id::text;END IF;
     INSERT INTO public.native_team_semantic_publications(source_kind,business_key_hash,original_business_key)
      VALUES(kind,sha256(convert_to(jsonb_build_array(kind,key)::text,'UTF8')),key) ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
   END IF;
   IF kind='team_collaboration' THEN
    IF NEW.state NOT IN('completed','failed','cancelled','blocked') THEN RETURN NEW;END IF;
    IF TG_OP='UPDATE' THEN supported=OLD.state IN('dispatched','accepted','uncertain');END IF;
   ELSE supported=TG_OP='INSERT' AND NEW.decision='accepted';END IF;
   h=sha256(convert_to(jsonb_build_array(kind,key)::text,'UTF8'));
   IF EXISTS(SELECT 1 FROM public.native_team_semantic_publications p WHERE p.source_kind=kind AND p.business_key_hash=h) THEN RETURN NEW;END IF;
   SELECT * INTO fact FROM public.native_team_semantic_identity(kind,key);
   IF FOUND THEN
    INSERT INTO public.native_team_semantic_publications(source_kind,business_key_hash,original_business_key,team_id,team_session_id,call_id,submission_id,decision_id,binding_id,binding_revision,target_installation_id,target_owner_scope_kind,target_owner_scope_id,publication_xid,publication_order)
     VALUES(kind,h,key,fact.team_id,fact.team_session_id,fact.call_id,fact.submission_id,fact.decision_id,fact.binding_id,fact.binding_revision,fact.target_installation_id,fact.target_owner_scope_kind,fact.target_owner_scope_id,
      CASE WHEN supported THEN txid_current() END,CASE WHEN supported THEN nextval('public.native_input_start_order') END) ON CONFLICT DO NOTHING;
   ELSE
    INSERT INTO public.native_team_semantic_publications(source_kind,business_key_hash,original_business_key) VALUES(kind,h,key) ON CONFLICT DO NOTHING;
   END IF;
   RETURN NEW;
  END IF;
  -- Classify both OLD and NEW membership of the exact three-role core.
  IF TG_TABLE_NAME='collaboration_events' THEN
   IF TG_OP IN('INSERT','DELETE') THEN
    ${eventCoreFence()}
   ELSIF(OLD.event_id,OLD.team_session_id,OLD.call_id,OLD.kind,OLD.event_seq,OLD.created_at,
     CASE WHEN OLD.kind='member_message' THEN OLD.author_user_id END,CASE WHEN OLD.kind='agent_message' THEN OLD.author_offer_id END)
    IS DISTINCT FROM(NEW.event_id,NEW.team_session_id,NEW.call_id,NEW.kind,NEW.event_seq,NEW.created_at,
     CASE WHEN NEW.kind='member_message' THEN NEW.author_user_id END,CASE WHEN NEW.kind='agent_message' THEN NEW.author_offer_id END) THEN
    ${eventCoreFence()}
   END IF;
  ELSIF TG_TABLE_NAME='team_memory_bindings' THEN
   IF TG_OP='DELETE' OR(OLD.binding_id,OLD.team_id,OLD.revision,OLD.installation_id,OLD.owner_scope_kind,OLD.owner_scope_id) IS DISTINCT FROM(NEW.binding_id,NEW.team_id,NEW.revision,NEW.installation_id,NEW.owner_scope_kind,NEW.owner_scope_id) THEN
    UPDATE public.native_team_semantic_publications SET ${scrub} WHERE binding_id=OLD.binding_id AND NOT retired;
   END IF;
  ELSIF TG_TABLE_NAME='extension_installations' THEN
   IF TG_OP='DELETE' OR(OLD.installation_id,OLD.provider_id,OLD.owner_scope_kind,OLD.owner_scope_id) IS DISTINCT FROM(NEW.installation_id,NEW.provider_id,NEW.owner_scope_kind,NEW.owner_scope_id) THEN
    UPDATE public.native_team_semantic_publications SET ${scrub} WHERE target_installation_id=OLD.installation_id AND NOT retired;
   END IF;
  ELSIF TG_TABLE_NAME='collaboration_sessions' THEN
   IF TG_OP='DELETE' OR(OLD.team_session_id,OLD.team_id) IS DISTINCT FROM(NEW.team_session_id,NEW.team_id) THEN
    UPDATE public.native_team_semantic_publications SET ${scrub} WHERE team_session_id=OLD.team_session_id AND NOT retired;
   END IF;
  ELSIF TG_TABLE_NAME='collaboration_teams' THEN
   IF TG_OP='DELETE' OR OLD.team_id IS DISTINCT FROM NEW.team_id THEN UPDATE public.native_team_semantic_publications SET ${scrub} WHERE team_id=OLD.team_id AND NOT retired;END IF;
  ELSIF TG_TABLE_NAME='users' THEN
   UPDATE public.native_team_semantic_publications SET ${scrub} WHERE target_installation_id IN(SELECT installation_id FROM public.extension_installations WHERE owner_user_id=OLD.id AND owner_scope_kind='personal') AND NOT retired;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
 END $$;
 `]
 for(const [table,name,fn,type] of triggerSpecs){
  const ops=name==='native_team_semantic_event_insert'?'INSERT':name==='native_team_content_eligibility_capture'?'INSERT OR UPDATE OF content':name==='native_team_content_eligibility_guard'?'UPDATE OF native_team_content_eligibility_version,native_team_content_eligible':type===11?'DELETE':type===27?'UPDATE OR DELETE':type===34?'TRUNCATE':'INSERT OR UPDATE OR DELETE'
  ddl.push(`DROP TRIGGER IF EXISTS ${name} ON public.${table};CREATE TRIGGER ${name} ${Number(type)&2?'BEFORE':'AFTER'} ${ops} ON public.${table} FOR EACH ${type===34?'STATEMENT':'ROW'} EXECUTE FUNCTION public.${fn}();`)
 }
 ddl.push(`CREATE OR REPLACE FUNCTION public.read_native_team_semantic_publication(p_kind text,p_key text)
 RETURNS TABLE(source_kind text,business_key_hash text,original_business_key text,team_id text,team_session_id text,call_id text,submission_id text,decision_id text,binding_id text,binding_revision text,target_installation_id text,target_owner_scope_kind text,target_owner_scope_id text,publication_xid text,publication_order text,retired boolean)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
  IF p_kind IS NULL OR p_kind NOT IN('team_collaboration','team_delivery') OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 1024 THEN RAISE EXCEPTION 'native_team_semantic_metadata_request_invalid';END IF;
  RETURN QUERY SELECT p.source_kind,encode(p.business_key_hash,'hex'),p.original_business_key,p.team_id,p.team_session_id,p.call_id,p.submission_id::text,p.decision_id::text,p.binding_id,p.binding_revision::text,p.target_installation_id::text,p.target_owner_scope_kind,p.target_owner_scope_id::text,p.publication_xid::text,p.publication_order::text,p.retired
   FROM public.native_team_semantic_publications p WHERE p.source_kind=p_kind AND p.business_key_hash=sha256(convert_to(jsonb_build_array(p_kind,p_key)::text,'UTF8'))
    AND(p.retired OR (p.original_business_key=p_key AND length(p.original_business_key)<=1024
     AND(p.team_id IS NULL OR length(p.team_id) BETWEEN 1 AND 1024) AND(p.team_session_id IS NULL OR length(p.team_session_id) BETWEEN 1 AND 1024)
     AND(p.call_id IS NULL OR length(p.call_id) BETWEEN 1 AND 1024) AND(p.binding_id IS NULL OR length(p.binding_id) BETWEEN 1 AND 1024)));
 END $$;
 REVOKE ALL ON FUNCTION public.read_native_team_semantic_publication(text,text) FROM PUBLIC;
 CREATE OR REPLACE FUNCTION public.native_team_semantic_structure_ready() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT ${NATIVE_TEAM_SEMANTIC_STRUCTURE} $$;
 REVOKE ALL ON public.native_team_semantic_publications FROM PUBLIC;
 REVOKE ALL (${Object.keys(columnTypes).join(',')}) ON public.native_team_semantic_publications FROM PUBLIC;
 REVOKE ALL ON FUNCTION ${privateFunctions.map(fn=>'public.'+fn).join(',')} FROM PUBLIC;
 ALTER TABLE public.native_input_start_contract ADD COLUMN IF NOT EXISTS team_semantic_capture_version int NOT NULL DEFAULT 0;
 UPDATE public.native_input_start_contract SET team_semantic_capture_version=1 WHERE team_semantic_capture_version=0;
 DO $$ BEGIN IF to_regclass('shared.memory_source_contract') IS NOT NULL THEN
  ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS team_semantic_capture_version int NOT NULL DEFAULT 0;
  UPDATE shared.memory_source_contract SET team_semantic_capture_version=1 WHERE team_semantic_capture_version=0;
 END IF;END $$;`)
 await db.query(ddl.join('\n'))
 await assertNativeTeamSemanticCompatible(db)
}
