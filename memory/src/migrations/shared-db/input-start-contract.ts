import type pg from 'pg'
/** Independent semantic compatibility check: no Relay implementation import or
 * private readiness function can replace this pre-DDL catalog/ACL audit. */
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

const nativeTriggers=[
 ['events','native_input_event','public.capture_native_event_publication()',29],
 ['extension_installations','native_input_installation','public.capture_native_installation_start()',5],
 ['extension_installations','native_input_installation_guard','public.capture_native_installation_start()',27],
 ['users','native_input_privacy','public.retire_native_user_input()',11],
 ...['collaboration_calls','collaboration_events','team_delivery_memory_sources'].flatMap(table=>[
  [table,'native_input_team_before','public.capture_native_team_publication()',31],
  [table,'native_input_team_after','public.capture_native_team_publication()',29],
 ]),
 ...['native_source_publications','native_installation_starts','native_input_start_contract'].flatMap(table=>[
  [table,'native_input_immutable','public.guard_native_input_fact()',27],
  [table,'native_input_no_truncate','public.guard_native_input_fact()',34],
 ]),
].map(([table,name,fn,type])=>`('public.${table}','${name}','${fn}',${type})`).join(',')
const nativeColumns=[
 ['native_source_publications',{source_kind:'text',source_key:'text',owner_key:'text',source_session_id:'text',retired:'boolean',publication_xid:'bigint',publication_order:'bigint'}],
 ['native_installation_starts',{installation_id:'uuid',provider_id:'text',retired:'boolean',original_policy:'text',original_feed_id:'bigint',owner_user_id:'integer',owner_scope_kind:'text',owner_scope_id:'uuid',start_xid:'bigint',start_snapshot:'txid_snapshot',start_order:'bigint'}],
].flatMap(([table,columns])=>Object.entries(columns as Record<string,string>).map(([column,type])=>`('public.${table}','${column}','${type}')`)).join(',')
/** Same installed-history contract as Relay; read-only and independent of
 * shared function installation, so both Memory migrator entries can call it
 * before their first DDL. Fresh native0/shared0 is distinct from lost v1. */
const nativeStructure=`to_regclass('public.native_source_publications') IS NOT NULL AND to_regclass('public.native_installation_starts') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.native_input_start_order') AND relkind='S')
    AND EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_index x ON x.indexrelid=c.conindid WHERE c.conrelid=to_regclass('public.native_source_publications') AND c.contype='p' AND x.indisvalid AND x.indisready
     AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='source_kind'),(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='source_key')]::smallint[])
    AND EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_index x ON x.indexrelid=c.conindid WHERE c.conrelid=to_regclass('public.native_installation_starts') AND c.contype='p' AND x.indisvalid AND x.indisready
     AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='installation_id')]::smallint[])

    AND NOT EXISTS(SELECT 1 FROM(VALUES ${nativeColumns}) expected(relation,column_name,column_type) WHERE NOT EXISTS(SELECT 1 FROM pg_attribute a
     WHERE a.attrelid=to_regclass(expected.relation) AND a.attname=expected.column_name AND a.atttypid=to_regtype(expected.column_type) AND a.attnum>0 AND NOT a.attisdropped))
    AND NOT EXISTS(SELECT 1 FROM(VALUES ${nativeTriggers}     ) expected(relation,trigger_name,function_name,trigger_type) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid=to_regclass(expected.relation) AND t.tgname=expected.trigger_name AND t.tgfoid=to_regprocedure(expected.function_name)
       AND t.tgtype=expected.trigger_type AND t.tgenabled IN('O','A') AND p.prosecdef
       AND EXISTS(SELECT 1 FROM unnest(p.proconfig) setting WHERE replace(setting,' ','')='search_path=pg_catalog,public')))`
export async function assertNativeInputStartCompatible(db:Pick<pg.Pool,'query'>):Promise<void>{
 await assertNativeTeamSemanticCompatible(db)
 let sharedDeclared=false
 if((await db.query("SELECT to_regclass('shared.memory_source_contract') IS NOT NULL AS present")).rows[0]?.present){
  const shared=(await db.query("SELECT version,COALESCE(to_jsonb(contract)->>'input_start_version','0') AS input_start_version FROM shared.memory_source_contract contract")).rows
  if(shared.length!==1||shared[0].version!==1)throw Error('unsupported_shared_source_contract')
  if(!['0','1'].includes(shared[0].input_start_version))throw Error('unsupported_shared_input_start_contract')
  sharedDeclared=shared[0].input_start_version==='1'
 }
 if(!(await db.query("SELECT to_regclass('public.native_input_start_contract') IS NOT NULL AS present")).rows[0]?.present){
  if(sharedDeclared)throw Error('native_input_start_history_missing')
  if((await db.query("SELECT to_regclass('public.native_source_publications') IS NOT NULL OR to_regclass('public.native_installation_starts') IS NOT NULL OR to_regclass('public.native_input_start_order') IS NOT NULL OR to_regprocedure('public.capture_native_installation_start()') IS NOT NULL AS present")).rows[0]?.present)throw Error('native_input_start_history_missing')
  return
 }
 const versions=(await db.query('SELECT version FROM public.native_input_start_contract')).rows
 if(versions.length!==1||versions[0].version!==1)throw Error('unsupported_native_input_start_contract')
 if(!(await db.query(`SELECT ${nativeStructure} AS ready`)).rows[0]?.ready)throw Error('native_input_start_history_missing')
}
export const SHARED_INPUT_START_FUNCTIONS=[
 `ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS input_start_version INT NOT NULL DEFAULT 0`,
 `CREATE OR REPLACE FUNCTION shared.memory_installation_input_ready(p_installation uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE i record;b record;BEGIN
   IF to_regclass('public.extension_installations') IS NULL OR to_regclass('public.extension_providers') IS NULL THEN RETURN FALSE;END IF;
   SELECT * INTO i FROM public.extension_installations WHERE installation_id=p_installation AND provider_id='pocketctl-memory' AND status='active';
   IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.extension_providers WHERE provider_id='pocketctl-memory' AND status='enabled') THEN RETURN FALSE;END IF;
   IF i.owner_scope_kind='personal' THEN
    IF i.owner_user_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=i.owner_user_id) THEN RETURN FALSE;END IF;
   ELSIF i.owner_scope_kind='team' THEN
    IF NOT EXISTS(SELECT 1 FROM public.extension_teams t JOIN public.extension_organizations o USING(organization_id) WHERE t.team_id=i.owner_scope_id AND t.state='active' AND o.state='active') THEN RETURN FALSE;END IF;
   ELSIF i.owner_scope_kind='organization' THEN
    IF NOT EXISTS(SELECT 1 FROM public.extension_organizations WHERE organization_id=i.owner_scope_id AND state='active') THEN RETURN FALSE;END IF;
   ELSE RETURN FALSE;END IF;

   IF to_regclass('public.native_installation_starts') IS NULL THEN RETURN i.start_policy='retained_history';END IF;
   SELECT * INTO b FROM public.native_installation_starts WHERE installation_id=p_installation;
   IF NOT FOUND THEN RETURN i.start_policy='retained_history';END IF;
   IF b.retired IS DISTINCT FROM FALSE OR(b.provider_id,b.owner_user_id,b.owner_scope_kind,b.owner_scope_id,b.original_policy)
    IS DISTINCT FROM(i.provider_id,i.owner_user_id,i.owner_scope_kind,i.owner_scope_id,i.start_policy) THEN RETURN FALSE;END IF;
   IF i.start_policy='retained_history' THEN RETURN TRUE;END IF;
   RETURN i.start_policy='from_now' AND b.start_xid>0 AND b.start_order>0 AND b.start_snapshot IS NOT NULL AND octet_length(b.start_snapshot::text)<=1048576;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.memory_input_start_admission(p_installation uuid,p_kind text,p_key text,p_owner text,p_session text)
  RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE i record;b record;p record;BEGIN
   SELECT * INTO i FROM public.extension_installations WHERE installation_id=p_installation;
   IF NOT FOUND THEN RETURN 'denied';END IF;
   IF to_regclass('public.native_source_publications') IS NOT NULL THEN
    SELECT * INTO p FROM public.native_source_publications WHERE source_kind=p_kind AND source_key=p_key;
    IF FOUND AND(p.retired IS DISTINCT FROM FALSE OR(p.owner_key,p.source_session_id) IS DISTINCT FROM(p_owner,p_session)) THEN RETURN 'denied';END IF;
   END IF;
   IF to_regclass('public.native_installation_starts') IS NULL THEN RETURN CASE WHEN i.start_policy='retained_history' THEN 'eligible' ELSE 'unproven' END;END IF;
   SELECT * INTO b FROM public.native_installation_starts WHERE installation_id=p_installation;
   IF FOUND THEN
    IF b.retired IS DISTINCT FROM FALSE OR(b.provider_id,b.owner_user_id,b.owner_scope_kind,b.owner_scope_id,b.original_policy)
     IS DISTINCT FROM(i.provider_id,i.owner_user_id,i.owner_scope_kind,i.owner_scope_id,i.start_policy) THEN RETURN 'denied';END IF;
    IF b.original_policy='retained_history' THEN RETURN 'eligible';END IF;
    IF b.start_xid IS NULL OR b.start_xid<=0 OR b.start_order IS NULL OR b.start_order<=0 OR b.start_snapshot IS NULL THEN RETURN 'unproven';END IF;
    SELECT * INTO p FROM public.native_source_publications WHERE source_kind=p_kind AND source_key=p_key;
    IF FOUND THEN
     IF p.retired IS DISTINCT FROM FALSE OR(p.owner_key,p.source_session_id) IS DISTINCT FROM(p_owner,p_session) THEN RETURN 'denied';END IF;
     IF p.publication_xid IS NOT NULL THEN
      IF p.publication_xid<=0 OR p.publication_order IS NULL OR p.publication_order<=0 THEN RETURN 'unproven';END IF;
      IF p.publication_xid=b.start_xid THEN RETURN CASE WHEN p.publication_order>b.start_order THEN 'eligible' ELSE 'before' END;END IF;
      RETURN CASE WHEN txid_visible_in_snapshot(p.publication_xid,b.start_snapshot) THEN 'before' ELSE 'eligible' END;
     END IF;
    END IF;
    IF p_kind='relay_event' AND EXISTS(SELECT 1 FROM public.extension_feed f WHERE f.source_kind='canonical_event'
     AND f.source_id='event:'||p_key AND f.topic IN('session.event','session.event.v1') AND f.envelope_version=1
     AND(f.owner_user_id::text IS DISTINCT FROM p_owner OR f.session_id IS DISTINCT FROM p_session)) THEN RETURN 'unproven';END IF;
    -- A retained Feed row before the captured checkpoint can prove exclusion.
    -- A delayed row after it cannot prove original canonical publication.
    IF p_kind='relay_event' AND EXISTS(SELECT 1 FROM public.extension_feed f WHERE f.source_kind='canonical_event'
     AND f.source_id='event:'||p_key AND f.owner_user_id::text=p_owner AND f.session_id=p_session
     AND f.topic IN('session.event','session.event.v1') AND f.envelope_version=1 AND f.feed_id<=b.original_feed_id)
     THEN RETURN 'before';END IF;
    RETURN 'unproven';
   END IF;
   -- Legacy from_now has no immutable original checkpoint proof. The mutable
   -- delivery/recovery start_feed_id is never an automatic admission fallback.
   IF i.start_policy='retained_history' THEN RETURN 'eligible';END IF;
   RETURN 'unproven';
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.memory_relay_input_admitted(p_scope jsonb,p_event bigint,p_explicit boolean)
  RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE e record;state text;BEGIN
   SELECT * INTO e FROM public.events WHERE id=p_event AND user_id=(p_scope->>'principalUserId')::int AND NOT owner_retired;
   IF NOT FOUND OR public.native_event_authority(e.id,e.user_id)->>'state'<>'current' THEN RETURN FALSE;END IF;
   state=shared.memory_input_start_admission((p_scope->>'installationId')::uuid,'relay_event',e.id::text,e.user_id::text,e.logical_source_session_id);
   IF state='eligible' THEN RETURN TRUE;ELSIF state='denied' THEN RETURN FALSE;END IF;
   -- An exact already-owned UUID is a retained entitlement, never a discovery
   -- watermark. The original typed identity/hash/provenance must still agree.
   IF p_explicit AND EXISTS(SELECT 1 FROM memory.source_events r WHERE r.installation_id=(p_scope->>'installationId')::uuid
    AND r.source_kind='relay_event' AND r.mapping_state='verified' AND r.canonical_key=e.id::text
    AND r.canonical_session_key=e.logical_source_session_id AND r.session_id=e.logical_source_session_id AND r.event_type=e.event_type
    AND r.hash_version='canonical-json-sha256-v1' AND r.content_hash IS NOT NULL AND r.source_provenance->'memory'->>'version'='1'
    AND r.source_provenance->'memory'->>'session_id'=e.logical_source_session_id
    AND r.classification->'memory_source'=r.source_provenance->'memory'
    AND ((to_jsonb(e)->>'source_header_version') IS DISTINCT FROM '1' OR to_jsonb(e)->'source_classification'->'memory_source'=r.source_provenance->'memory')
    AND (encode(r.content_hash,'hex')=(to_jsonb(e)->>'canonical_payload_hash') OR((to_jsonb(e)->>'canonical_payload_hash') IS NULL AND(
     r.payload=e.payload AND r.content_hash=r.payload_hash
     -- Historical cold refs supply the expected canonical hash. The trusted
     -- decoder must verify actual bytes; no body/hash is reconstructed here.
     OR e.body_storage='cold' AND e.body_owner_user_id=e.user_id AND e.body_session_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM public.session_archive_manifests m JOIN public.session_archive_chunks c USING(manifest_id)
       WHERE m.manifest_id=e.body_manifest_id AND c.ordinal=e.body_chunk_ordinal AND m.state='published'
        AND m.user_id=e.user_id AND m.session_id=e.body_session_id AND m.activity_epoch=e.body_activity_epoch
        AND e.id BETWEEN c.first_event_id AND c.last_event_id)))))
    THEN RETURN TRUE;END IF;
   IF state='unproven' THEN RAISE EXCEPTION 'source_input_start_unproven';END IF;
   RETURN FALSE;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.memory_team_input_admitted(p_scope jsonb,p_kind text,p_root text,p_context jsonb)
  RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
  DECLARE key text;owner_key text;state text;receipt record;BEGIN
   key=p_root;owner_key=p_context->>'teamId';
   IF p_kind='team_delivery' THEN
    SELECT * INTO receipt FROM public.team_delivery_memory_sources WHERE source_session_id=p_root AND reader_user_id=(p_scope->>'principalUserId')::int;
    IF NOT FOUND THEN RETURN FALSE;END IF;
    owner_key=jsonb_build_array(receipt.team_id,receipt.reader_user_id,receipt.binding_id,receipt.binding_revision,receipt.participant_revision,(p_context->>'targetInstallationId')::uuid,p_context->>'targetOwnerScopeKind',(p_context->>'targetOwnerScopeId')::uuid)::text;
   END IF;
   state=shared.memory_input_start_admission((p_scope->>'installationId')::uuid,p_kind,key,owner_key,p_context->>'teamSessionId');
   IF state='unproven' THEN RAISE EXCEPTION 'source_input_start_unproven';END IF;
   RETURN state='eligible';
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.memory_input_start_ready() RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF NOT EXISTS(SELECT 1 FROM shared.memory_source_contract WHERE singleton AND input_start_version=1) THEN RETURN FALSE;END IF;
   IF to_regclass('public.native_input_start_contract') IS NULL THEN RETURN FALSE;END IF;
   RETURN (SELECT count(*)=1 AND min(version)=1 AND max(version)=1 FROM public.native_input_start_contract)
    AND ${nativeStructure};
  END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_installation_input_ready(uuid),shared.memory_input_start_admission(uuid,text,text,text,text),shared.memory_relay_input_admitted(jsonb,bigint,boolean),shared.memory_team_input_admitted(jsonb,text,text,jsonb),shared.memory_input_start_ready() FROM PUBLIC`,
 `UPDATE shared.memory_source_contract SET input_start_version=1 WHERE singleton`,
] as const
