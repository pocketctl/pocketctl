import {beginFreshInputFixture} from './input-start-fixture.js'
import {installRetainedInputStartFixture} from './input-start-fixture.js'
import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {provisionSharedDatabase} from '../../migrations/shared-db/namespace.js'
import {createMemoryPool} from '../../db.js'
import {acceptedDeliverySourceSessionId,type SourceScope,type SourceRoot} from '@pocketctl/session-source'
import {withSourceJobExecution} from '../../sources/source-execution.js'
import {prepareCanonicalReferencePage,persistCanonicalReferencePage} from '../../sources/canonical-references.js'
const url=process.env.TEAM_SEMANTIC_REGISTRATION_TEST_DATABASE_URL,suite=url?describe:describe.skip
const inst='10000000-0000-0000-0000-000000000007',submission='20000000-0000-0000-0000-000000000007',decision='30000000-0000-0000-0000-000000000007'
const teamScope='40000000-0000-0000-0000-000000000007',org='50000000-0000-0000-0000-000000000007'
const scope:SourceScope={installationId:inst,principalUserId:'1',ownerScopeKind:'team',ownerScopeId:teamScope,authorizationRevision:'1',configVersion:'1',modeGeneration:'3',bindingRevision:'1',participantRevision:'1'}
const otherScope={...scope,principalUserId:'2',participantRevision:'2'}
const root={kind:'team_collaboration' as const,key:'call'}
const deliverySession=acceptedDeliverySourceSessionId({teamSessionId:'ts',submissionId:submission,decisionId:decision,bindingId:'b',bindingRevision:1,userId:1,participantRevision:1})
suite('preparatory Team semantic registration',()=>{
 let pool:pg.Pool,runtime:pg.Pool
 beforeAll(async()=>{
  if(!url||!/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url});await pool.query('DROP SCHEMA IF EXISTS memory CASCADE; DROP SCHEMA IF EXISTS shared CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const inputFoundation=await beginFreshInputFixture(pool)
  await applyMemorySchema(pool,{namespace:'memory'});await applySharedSourceContract(pool)
  await pool.query(`CREATE TABLE public.users(id int PRIMARY KEY,team_enabled boolean); INSERT INTO public.users VALUES(1,true),(2,true);
   CREATE TABLE public.extension_providers(provider_id text,status text); INSERT INTO public.extension_providers VALUES('pocketctl-memory','enabled');
   CREATE TABLE public.extension_installations(installation_id uuid,provider_id text,owner_user_id int,owner_scope_kind text,owner_scope_id uuid,status text,authorization_epoch bigint,config_version bigint,granted_scopes text[],enabled_services text[],event_filter jsonb DEFAULT '{}',start_policy text NOT NULL DEFAULT 'retained_history',start_feed_id bigint NOT NULL DEFAULT 0);
   CREATE TABLE public.extension_scope_memberships(scope_kind text,scope_id uuid,user_id int,state text,roles text[],membership_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),membership_revision bigint DEFAULT 1);
   CREATE TABLE public.extension_teams(team_id uuid,organization_id uuid,state text,authorization_epoch bigint DEFAULT 1);
   CREATE TABLE public.extension_organizations(organization_id uuid,state text,authorization_epoch bigint DEFAULT 1);
   CREATE TABLE public.collaboration_teams(team_id text,state text); INSERT INTO public.collaboration_teams VALUES('team','active');
   CREATE TABLE public.collaboration_sessions(team_session_id text,team_id text,state text); INSERT INTO public.collaboration_sessions VALUES('ts','team','active');
   CREATE TABLE public.collaboration_team_memberships(team_id text,user_id int,state text); INSERT INTO public.collaboration_team_memberships VALUES('team',1,'active');
   CREATE TABLE public.collaboration_session_participants(team_session_id text,user_id int,state text,revision bigint); INSERT INTO public.collaboration_session_participants VALUES('ts',1,'active',1);
   CREATE TABLE public.team_memory_bindings(binding_id text,team_id text,installation_id uuid,owner_scope_kind text,owner_scope_id uuid,state text,revision bigint);
   CREATE TABLE public.collaboration_calls(call_id text,team_session_id text,event_id text,offer_id text,context_version bigint,state text,task_id text); INSERT INTO public.collaboration_calls VALUES('call','ts','goal','offer',0,'completed','task');
   CREATE TABLE public.team_agent_offers(offer_id text,daemon_id text); INSERT INTO public.team_agent_offers VALUES('offer','daemon');
   CREATE TABLE public.collaboration_events(event_id text,team_session_id text,event_seq bigint,kind text,author_user_id int,author_offer_id text,call_id text,content text,created_at timestamptz);
   INSERT INTO public.collaboration_events VALUES('goal','ts',1,'member_message',1,NULL,NULL,'private native goal','2026-11-01T00:00:00Z'),('reply','ts',2,'agent_message',NULL,'offer','call','private reply','2026-11-01T00:00:01Z'),('outcome','ts',3,'status',NULL,NULL,'call','completed','2026-11-01T00:00:02Z');
   CREATE TABLE public.team_delivery_memory_sources(source_session_id text,decision_id uuid,submission_id uuid,team_id text,team_session_id text,binding_id text,binding_revision bigint,reader_user_id int,participant_revision bigint,revoked_at timestamptz,withdrawn_at timestamptz);
   CREATE TABLE public.team_task_submissions(submission_id uuid,task_id text,spec_revision bigint,version bigint,state text,source_call_id text,source_offer_id text,context_version bigint,summary text,manifest_sha256 text,published_at timestamptz);
   CREATE TABLE public.team_acceptance_decisions(decision_id uuid,submission_id uuid,task_id text,spec_revision bigint,reviewer_user_id int,decision text,created_at timestamptz);
   CREATE TABLE public.team_task_specs(task_id text,revision bigint,goal text,acceptance text,reviewer_user_id int,created_by_user_id int,created_at timestamptz);
   INSERT INTO public.team_task_specs VALUES('task',1,'delivery goal','delivery criteria',1,1,'2026-11-01T00:00:00Z');
   CREATE TABLE public.team_artifact_revocations(submission_id uuid);
   CREATE TABLE public.team_delivery_memory_withdrawals(team_id text,team_session_id text,submission_id uuid,decision_id uuid);
   DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='semantic_registration_memory') THEN CREATE ROLE semantic_registration_memory LOGIN PASSWORD 'only-test';END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='semantic_registration_relay') THEN CREATE ROLE semantic_registration_relay NOLOGIN;END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='semantic_registration_migrator') THEN CREATE ROLE semantic_registration_migrator NOLOGIN;END IF;
   END $$;`)
  await pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  await pool.query("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'team',$2,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}');",[inst,teamScope])
  await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[inst])
  await pool.query("INSERT INTO public.team_memory_bindings VALUES('b','team',$1,'team',$2,'active',1)",[inst,teamScope])
  await pool.query("INSERT INTO public.team_delivery_memory_sources VALUES($1,$2,$3,'team','ts','b',1,1,1,NULL,NULL)",[deliverySession,decision,submission])
  await pool.query("INSERT INTO public.team_task_submissions VALUES($1,'task',1,1,'published','call','offer',0,'private accepted summary',$2,'2026-11-01T00:00:01Z')",[submission,'ab'.repeat(32)])
  await pool.query("INSERT INTO public.team_acceptance_decisions VALUES($1,$2,'task',1,1,'accepted','2026-11-01T00:00:02Z')",[decision,submission])
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-active',3)",[inst])
  await pool.query("SELECT shared.mark_memory_source_dirty('team_collaboration','call')");await pool.query("SELECT shared.mark_memory_source_dirty('team_delivery',$1)",[deliverySession])
  const {installRelayDeliveryPrivacyCapture}=await import(new URL('../../../../relay/src/shared-source/delivery-privacy-capture.ts',import.meta.url).href)
  await installRelayDeliveryPrivacyCapture(pool)
  await pool.query("INSERT INTO public.extension_organizations(organization_id,state) VALUES($1,'active')",[org])
  await pool.query("INSERT INTO public.extension_teams(team_id,organization_id,state) VALUES($1,$2,'active')",[teamScope,org])
  await pool.query("INSERT INTO public.extension_scope_memberships(scope_kind,scope_id,user_id,state,roles) VALUES('team',$1,1,'active',ARRAY['reader']),('team',$1,2,'active',ARRAY['reader'])",[teamScope])
  await pool.query("INSERT INTO public.collaboration_session_participants VALUES('ts',2,'active',2);INSERT INTO public.collaboration_team_memberships VALUES('team',2,'active')")
  await installRetainedInputStartFixture(pool,'retained_history',inputFoundation)
  await provisionSharedDatabase(pool,{memoryRole:'semantic_registration_memory',relayRole:'semantic_registration_relay',migratorRole:'semantic_registration_migrator'})
  const runtimeUrl=new URL(url);runtimeUrl.username='semantic_registration_memory';runtimeUrl.password='only-test';runtime=createMemoryPool({databaseUrl:runtimeUrl.href,databaseNamespace:'memory',dbPoolMax:3})
 },60000)
 afterAll(async()=>{await runtime?.end();await pool?.end()})
 const counts=async()=> (await pool.query(`SELECT (SELECT count(*)::int FROM memory.memory_team_semantic_groups) AS groups,(SELECT count(*)::int FROM memory.memory_team_semantic_witnesses) AS witnesses,(SELECT count(*)::int FROM memory.source_turns) AS turns,(SELECT count(*)::int FROM memory.memory_jobs) AS jobs`)).rows[0]
 const execution=async<T>(work:()=>Promise<T>,installationId=inst)=>{
  const job=randomUUID()
  await runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1::uuid,$2,'project_shared_source',($1::uuid)::text,52,'running','semantic-fixture',1,clock_timestamp()+interval '5 minutes')",[job,installationId])
  return withSourceJobExecution(runtime,{jobId:job,claimedBy:'semantic-fixture',claimEpoch:1},work)
 }
 const api=()=>import('../../sources/team-semantic-registration.js')
 const raw=async(contexts:{scope:SourceScope;root:SourceRoot}[]=[{scope,root},{scope:otherScope,root}])=>{
  for(const c of contexts)await persistCanonicalReferencePage(runtime,await prepareCanonicalReferencePage(runtime,c.scope,c.root))
 }
 test('current schema retains all semantic metadata tables without any body column',async()=>{
  const tables=(await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='memory' AND table_name LIKE 'memory_team_semantic_%' ORDER BY table_name")).rows
  expect(tables).toEqual([{table_name:'memory_team_semantic_groups'},{table_name:'memory_team_semantic_publications'},{table_name:'memory_team_semantic_witnesses'}])
  const columns=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='memory' AND table_name LIKE 'memory_team_semantic_%'")).rows.map(r=>r.column_name)
  expect(columns).not.toEqual(expect.arrayContaining(['payload']));expect(columns).not.toEqual(expect.arrayContaining(['body']))
 })
 test('scope/root extras, nested data and type confusions are rejected before any native IO or registration',async()=>execution(async()=>{
  const a=await api(),before=await counts();let acquisitions=0,getterReads=0
  const acquired=()=>{acquisitions++}
  const accessor=Object.defineProperty({...scope},'principalUserId',{enumerable:true,get(){getterReads++;return '1'}})
  const hidden=Object.defineProperty({...root},'payload',{value:{nested:'injection-sentinel'},enumerable:false})
  const invalid=[
   {scope:{...scope,body:'injection-sentinel',config:{secret:'injection-sentinel'}},root},
   {scope,root:{...root,payload:{nested:'injection-sentinel'}}},
   {scope:{...scope,principalUserId:1},root},
   {scope:{...scope,modeGeneration:undefined},root},
   {scope:{...scope,participantRevision:{value:'1'}},root},
   {scope:{...scope,bindingRevision:'01'},root},
   {scope:{...scope,ownerScopeKind:'future'},root},
   {scope:{...scope,ownerScopeId:{nested:'injection-sentinel'}},root},
   {scope,root:{...root,key:{nested:'injection-sentinel'}}},
   {scope,root:Object.assign(Object.create({unreviewed:true}),root)},
   {scope:accessor,root},
   {scope,root:hidden},
   {scope:{...scope,[Symbol('unreviewed')]:{nested:'injection-sentinel'}},root},
   {scope,root,keys:['valid',42]},
   {scope,root,config:{secret:'injection-sentinel'}},
  ]
  runtime.on('acquire',acquired)
  try{
   for(const request of invalid)await expect(a.prepareTeamSemanticRegistration(runtime,[request] as never)).rejects.toThrow('team_semantic_registration_request_invalid')
   expect(acquisitions).toBe(0);expect(getterReads).toBe(0)
   await a.prepareTeamSemanticRegistration(runtime,[{scope,root}]);expect(acquisitions).toBeGreaterThan(0)
  }finally{runtime.off('acquire',acquired)}
  expect(await counts()).toEqual(before)
 }))
 test('authentic two-reader facts register three semantic UUIDs, preserve six raw proofs, and repeat idempotently',async()=>execution(async()=>{
  const a=await api();await raw()
  const alias=(await runtime.query('SELECT source_event_id::text,event_type,source_provenance FROM source_events ORDER BY source_event_id LIMIT 1')).rows[0]
  const p=alias.source_provenance,role=({user_goal:'goal',agent_text:'reply',turn_status:'outcome'} as Record<string,string>)[alias.event_type]
  const wire=`team:${p.team_call_id}:${role}:u${p.read_scope.participant_user_id}:b${p.read_scope.team_memory_binding_revision}:v1`
  await pool.query('UPDATE memory.source_events SET canonical_key=$2 WHERE source_event_id=$1',[alias.source_event_id,wire])
  const original=(await runtime.query('SELECT source_event_id::text,canonical_key,content_hash,source_provenance,source_version,canonical_session_key,session_id,turn_id,event_type,classification,occurred_at,payload_hash FROM source_events ORDER BY source_event_id')).rows
  const stale=await a.prepareTeamSemanticRegistration(runtime,[{scope,root},{scope:otherScope,root}])
  await pool.query("SELECT shared.mark_memory_source_dirty('team_collaboration','call')")
  await expect(a.persistTeamSemanticRegistration(runtime,stale)).rejects.toThrow()
  const page=await a.prepareTeamSemanticRegistration(runtime,[{scope,root},{scope:otherScope,root}])
  const before=await counts(),result=await a.persistTeamSemanticRegistration(runtime,page)
  expect(result).toHaveLength(3);expect(result.every(r=>r.publishReady===false&&r.witnessCount===2)).toBe(true)
  expect(new Set(result.map(r=>r.semanticRefId)).size).toBe(3)
  expect(result.some(r=>original.some(raw=>raw.source_event_id===r.semanticRefId))).toBe(false)
  expect(await a.persistTeamSemanticRegistration(runtime,page)).toEqual(result)
  expect((await runtime.query('SELECT source_event_id::text,canonical_key,content_hash,source_provenance,source_version,canonical_session_key,session_id,turn_id,event_type,classification,occurred_at,payload_hash FROM source_events ORDER BY source_event_id')).rows).toEqual(original)
  expect(await counts()).toEqual({...before,groups:3,witnesses:6})
  expect((await runtime.query('SELECT raw_canonical_key FROM memory_team_semantic_witnesses WHERE source_event_id=$1',[alias.source_event_id])).rows).toEqual([{raw_canonical_key:wire}])
  const stored=(await runtime.query('SELECT row_to_json(g) AS meta FROM memory_team_semantic_groups g')).rows
  expect(JSON.stringify(stored)).not.toMatch(/private reply|private accepted summary|private native goal/)
  expect(stored.every(r=>r.meta.provenance_state==='provenance_unknown'&&r.meta.registration_state==='preparatory')).toBe(true)
 }))
 test('fresh r+1 registers original raw audit versions on repeat; stale preparation stays fenced',async()=>execution(async()=>{
  const a=await api(),contexts=[{scope,root},{scope:otherScope,root}]
  await raw(contexts)
  await a.persistTeamSemanticRegistration(runtime,await a.prepareTeamSemanticRegistration(runtime,contexts))
  const original=(await runtime.query('SELECT row_to_json(s) AS metadata FROM source_events s ORDER BY source_event_id')).rows
  const previousIds=(await runtime.query('SELECT semantic_ref_id::text FROM memory_team_semantic_groups ORDER BY semantic_ref_id')).rows.map(r=>r.semantic_ref_id)
  const stale=await a.prepareTeamSemanticRegistration(runtime,contexts),before=await counts()
  await pool.query("SELECT shared.mark_memory_source_dirty('team_collaboration','call')")
  await expect(a.persistTeamSemanticRegistration(runtime,stale)).rejects.toThrow()
  expect(await counts()).toEqual(before)
  for(const c of contexts){const replay=await persistCanonicalReferencePage(runtime,await prepareCanonicalReferencePage(runtime,c.scope,c.root));expect(replay.every(r=>!r.created)).toBe(true)}
  const first=await a.persistTeamSemanticRegistration(runtime,await a.prepareTeamSemanticRegistration(runtime,contexts))
  expect(first).toHaveLength(3);expect(first.every(r=>!r.publishReady)).toBe(true)
  expect(first.map(r=>r.semanticRefId).sort()).toEqual(previousIds)
  const audit=(await runtime.query('SELECT source_event_id::text,source_version FROM memory_team_semantic_witnesses ORDER BY source_event_id')).rows
  expect(audit).toEqual(original.map(r=>({source_event_id:r.metadata.source_event_id,source_version:r.metadata.source_version})))
  const secondStale=await a.prepareTeamSemanticRegistration(runtime,contexts)
  await pool.query("SELECT shared.mark_memory_source_dirty('team_collaboration','call')")
  await expect(a.persistTeamSemanticRegistration(runtime,secondStale)).rejects.toThrow()
  expect(await a.persistTeamSemanticRegistration(runtime,await a.prepareTeamSemanticRegistration(runtime,contexts))).toEqual(first)
  expect((await runtime.query('SELECT source_event_id::text,source_version FROM memory_team_semantic_witnesses ORDER BY source_event_id')).rows).toEqual(audit)
  expect((await runtime.query('SELECT row_to_json(s) AS metadata FROM source_events s ORDER BY source_event_id')).rows).toEqual(original)
  expect(await counts()).toEqual(before)
 }))
 test('forged outer descriptors and pure caller tokens cannot mint registration',async()=>execution(async()=>{
  const a=await api(),before=await counts()
  await expect(a.persistTeamSemanticRegistration(runtime,{token:{},count:3,publishReady:false})).rejects.toThrow('team_semantic_registration_token_invalid')
  const page=await a.prepareTeamSemanticRegistration(runtime,[{scope,root}])
  await expect(a.persistTeamSemanticRegistration(runtime,{...page,token:{}})).rejects.toThrow('team_semantic_registration_token_invalid')
  expect(await counts()).toEqual(before)
 }))
 test('concurrent edits to original raw identity/proof/audit version cannot support any group',async()=>execution(async()=>{
  const a=await api(),page=await a.prepareTeamSemanticRegistration(runtime,[{scope,root},{scope:otherScope,root}]),before=await counts()
  const original=(await runtime.query("SELECT source_event_id::text,source_provenance,content_hash,session_id,turn_id,canonical_key,classification,source_version,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS occurred_at FROM source_events ORDER BY source_event_id LIMIT 1")).rows[0]
  // A well-formed older raw audit version is legitimate. Replacing that exact
  // original metadata after an opaque preparation is a distinct tamper case.
  for(const [column,value] of [['source_provenance',{}],['content_hash',Buffer.alloc(32)],['session_id','wrong'],['turn_id','wrong'],['canonical_key','wrong'],['classification',{unexpected:'changed'}],['source_version',{content:'999999',authorization:'1',storage:'1'}],['occurred_at','2026-11-01T00:00:00.000001Z']] as const){
   await pool.query(`UPDATE memory.source_events SET ${column}=$2${column==='content_hash'?',payload_hash=$2':''} WHERE source_event_id=$1`,[original.source_event_id,value])
   try{await expect(a.persistTeamSemanticRegistration(runtime,page)).rejects.toThrow('team_semantic_raw_reference_invalid');expect(await counts()).toEqual(before)}
   finally{await pool.query(`UPDATE memory.source_events SET ${column}=$2${column==='content_hash'?',payload_hash=$2':''} WHERE source_event_id=$1`,[original.source_event_id,original[column]])}
  }
 }))
 test('malformed or injected original audit version metadata is rejected even before preparation',async()=>execution(async()=>{
  const a=await api(),original=(await runtime.query('SELECT source_event_id::text,source_version FROM source_events ORDER BY source_event_id LIMIT 1')).rows[0],before=await counts()
  for(const value of [{content:'01',authorization:'1',storage:'0'},{content:1,authorization:'1',storage:'0'},{content:'1',authorization:'1',storage:'-1'},{content:'9223372036854775808',authorization:'1',storage:'0'},{content:'1',authorization:'1'}, {content:'1',authorization:'1',storage:'0',body:{secret:'injection-sentinel'}}]){
   if(!('storage' in value)||typeof value.content!=='string'||value.content==='01'||value.storage==='-1'||value.content==='9223372036854775808'){
    await expect(pool.query('UPDATE memory.source_events SET source_version=$2 WHERE source_event_id=$1',[original.source_event_id,value])).rejects.toMatchObject({code:'23514'});expect(await counts()).toEqual(before);continue
   }
   await pool.query('UPDATE memory.source_events SET source_version=$2 WHERE source_event_id=$1',[original.source_event_id,value])
   try{await expect((async()=>a.persistTeamSemanticRegistration(runtime,await a.prepareTeamSemanticRegistration(runtime,[{scope,root},{scope:otherScope,root}])))()).rejects.toThrow('team_semantic_raw_reference_invalid');expect(await counts()).toEqual(before)}
   finally{await pool.query('UPDATE memory.source_events SET source_version=$2 WHERE source_event_id=$1',[original.source_event_id,original.source_version])}
  }
 }))
 test('audit snapshot withholds injected nested and oversized raw version values inside PostgreSQL',async()=>execution(async()=>{
  const a=await api();await raw()
  const original=(await runtime.query('SELECT source_event_id::text,source_version FROM source_events ORDER BY source_event_id LIMIT 1')).rows[0],before=await counts()
  const originalQuery=runtime.query.bind(runtime),exports:unknown[][]=[]
  runtime.query=(async(...args:unknown[])=>{
   const result=await Reflect.apply(originalQuery,runtime,args)
   if(/team_semantic_raw_version_snapshot|SELECT source_event_id::text,source_version FROM source_events/.test(String(args[0])))exports.push(result.rows)
   return result
  }) as typeof runtime.query
  try{
   for(const injected of [{...original.source_version,body:{secret:'audit-injection-sentinel'}},{...original.source_version,body:{secret:'audit-injection-sentinel'+ 'x'.repeat(8192)}}]){
    // Historical schema accepts extra keys. The preparation query must export
    // NULL, never that untrusted JSON, before application-side DTO validation.
    await pool.query('UPDATE memory.source_events SET source_version=$2 WHERE source_event_id=$1',[original.source_event_id,injected])
    await expect(a.prepareTeamSemanticRegistration(runtime,[{scope,root},{scope:otherScope,root}])).rejects.toThrow('team_semantic_raw_reference_invalid')
    expect(exports.length).toBeGreaterThan(0)
    const exported=exports.at(-1) as any[]
    expect(exported.find(r=>r.source_event_id===original.source_event_id)?.source_version).toBeNull()
    expect(JSON.stringify(exported)).not.toContain('audit-injection-sentinel')
    expect(await counts()).toEqual(before)
   }
  }finally{runtime.query=originalQuery as typeof runtime.query;await pool.query('UPDATE memory.source_events SET source_version=$2 WHERE source_event_id=$1',[original.source_event_id,original.source_version])}
 }))
 test('immutable business digest conflict rolls back earlier new metadata in the same batch',async()=>execution(async()=>{
  const a=await api(),page=await a.prepareTeamSemanticRegistration(runtime,[{scope,root},{scope:otherScope,root}])
  const groups=(await runtime.query('SELECT semantic_ref_id,business_digest FROM memory_team_semantic_groups ORDER BY semantic_key')).rows
  const first=groups[0],g=groups.at(-1)!
  await pool.query('DELETE FROM memory.memory_team_semantic_groups WHERE semantic_ref_id=$1',[first.semantic_ref_id])
  await pool.query("UPDATE memory.memory_team_semantic_groups SET business_digest=decode(repeat('00',32),'hex') WHERE semantic_ref_id=$1",[g.semantic_ref_id])
  const before=await counts()
  try{await expect(a.persistTeamSemanticRegistration(runtime,page)).rejects.toThrow('team_semantic_registration_conflict');expect(await counts()).toEqual(before)}
  finally{
   await pool.query('UPDATE memory.memory_team_semantic_groups SET business_digest=$2 WHERE semantic_ref_id=$1',[g.semantic_ref_id,g.business_digest])
   await a.persistTeamSemanticRegistration(runtime,page)
  }
 }))
 test('root/native and raw metadata locks fail NOWAIT without partial metadata',async()=>execution(async()=>{
  const a=await api(),page=await a.prepareTeamSemanticRegistration(runtime,[{scope,root},{scope:otherScope,root}]),before=await counts(),blocker=await pool.connect()
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM public.team_memory_bindings FOR UPDATE')
   await expect(a.persistTeamSemanticRegistration(runtime,page)).rejects.toThrow();expect(await counts()).toEqual(before)
   await blocker.query('ROLLBACK');await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM memory.source_events FOR UPDATE')
   await expect(a.persistTeamSemanticRegistration(runtime,page)).rejects.toMatchObject({code:'55P03'});expect(await counts()).toEqual(before)
  }finally{await blocker.query('ROLLBACK');blocker.release()}
 }))
 test('revocation, participant revision and mode changes after preparation deny registration',async()=>execution(async()=>{
  const a=await api(),page=await a.prepareTeamSemanticRegistration(runtime,[{scope,root},{scope:otherScope,root}]),before=await counts()
  for(const [change,restore] of [["UPDATE public.collaboration_team_memberships SET state='removed' WHERE user_id=2","UPDATE public.collaboration_team_memberships SET state='active' WHERE user_id=2"],["UPDATE public.collaboration_session_participants SET revision=3 WHERE user_id=2","UPDATE public.collaboration_session_participants SET revision=2 WHERE user_id=2"],["UPDATE shared.memory_source_modes SET generation=4 WHERE installation_id='"+inst+"'","UPDATE shared.memory_source_modes SET generation=3 WHERE installation_id='"+inst+"'"]]){
   await pool.query(change)
   try{await expect(a.persistTeamSemanticRegistration(runtime,page)).rejects.toThrow();expect(await counts()).toEqual(before)}finally{await pool.query(restore)}
  }
 }))
 test('preparation requires original active execution; it cannot run from a DTO or public pool',async()=>{
  const a=await api()
  await expect(a.prepareTeamSemanticRegistration(runtime,[{scope,root}])).rejects.toThrow('team_semantic_registration_execution_required')
  await expect(a.prepareTeamSemanticRegistration(pool,[{scope,root}])).rejects.toThrow('team_semantic_registration_requires_physical_pool')
 })
 test('original execution A preparation cannot be replayed by a fresh same-mode execution B',async()=>{
  const a=await api(),page=await execution(()=>a.prepareTeamSemanticRegistration(runtime,[{scope,root}]))
  await execution(async()=>{const before=await counts();await expect(a.persistTeamSemanticRegistration(runtime,page)).rejects.toThrow('team_semantic_registration_execution_changed');expect(await counts()).toEqual(before)})
 })
 test('reclaiming the same job in the same mode cannot reuse its former preparation',async()=>{
  const a=await api(),job=randomUUID()
  await runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1::uuid,$2,'project_shared_source',($1::uuid)::text,52,'running','reclaim-fixture',1,clock_timestamp()+interval '5 minutes')",[job,inst])
  const page=await withSourceJobExecution(runtime,{jobId:job,claimedBy:'reclaim-fixture',claimEpoch:1},()=>a.prepareTeamSemanticRegistration(runtime,[{scope,root}]))
  await runtime.query('UPDATE memory_jobs SET claim_epoch=2 WHERE job_id=$1',[job])
  await withSourceJobExecution(runtime,{jobId:job,claimedBy:'reclaim-fixture',claimEpoch:2},async()=>{
   const before=await counts();await expect(a.persistTeamSemanticRegistration(runtime,page)).rejects.toThrow('team_semantic_registration_execution_changed');expect(await counts()).toEqual(before)
  })
 })
 test('expired original job authority after preparation cannot persist any registration',async()=>{
  const a=await api(),job=randomUUID()
  await runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1::uuid,$2,'project_shared_source',($1::uuid)::text,52,'running','expiry-fixture',1,clock_timestamp()+interval '5 minutes')",[job,inst])
  await withSourceJobExecution(runtime,{jobId:job,claimedBy:'expiry-fixture',claimEpoch:1},async()=>{
   const page=await a.prepareTeamSemanticRegistration(runtime,[{scope,root}]),before=await counts()
   await runtime.query("UPDATE memory_jobs SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",[job])
   await expect(a.persistTeamSemanticRegistration(runtime,page)).rejects.toThrow('source_execution_generation_changed');expect(await counts()).toEqual(before)
  })
 })
 test('canonical shadow metadata registration stays closed',async()=>{
  const a=await api(),job=randomUUID()
  await pool.query('UPDATE shared.memory_source_modes SET mode=$2 WHERE installation_id=$1',[inst,'shared-shadow'])
  try{
   await runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1::uuid,$2,'project_shared_source',($1::uuid)::text,52,'running','shadow-fixture',1,clock_timestamp()+interval '5 minutes')",[job,inst])
   await withSourceJobExecution(runtime,{jobId:job,claimedBy:'shadow-fixture',claimEpoch:1},async()=>{
    await expect(a.prepareTeamSemanticRegistration(runtime,[{scope,root}])).rejects.toThrow('team_semantic_registration_execution_required')
   },{branch:'canonical-shadow'})
  }finally{await pool.query("UPDATE shared.memory_source_modes SET mode='shared-active' WHERE installation_id=$1",[inst])}
 })
 test('accepted-delivery registration is separately typed and preserves original decision provenance',async()=>execution(async()=>{
  const a=await api(),target={kind:'team_delivery' as const,key:deliverySession}
  await raw([{scope,root:target}]);const before=await counts()
  const result=await a.persistTeamSemanticRegistration(runtime,await a.prepareTeamSemanticRegistration(runtime,[{scope,root:target}]))
  expect(result).toHaveLength(3);expect(result.every(r=>r.publishReady===false&&r.witnessCount===1)).toBe(true)
  expect(await counts()).toEqual({...before,groups:before.groups+3,witnesses:before.witnesses+3})
  expect((await runtime.query("SELECT count(*)::int AS n FROM memory_team_semantic_witnesses WHERE original_provenance->>'source_version'='2' AND original_provenance->'accepted_delivery'->>'decision_id'=$1",[decision])).rows[0].n).toBe(3)
  const original=(await runtime.query("SELECT row_to_json(s) AS metadata FROM source_events s WHERE source_kind='team_delivery' ORDER BY source_event_id")).rows
  const audit=(await runtime.query("SELECT source_event_id::text,source_version FROM memory_team_semantic_witnesses WHERE source_root->>'kind'='team_delivery' ORDER BY source_event_id")).rows
  const stale=await a.prepareTeamSemanticRegistration(runtime,[{scope,root:target}])
  await pool.query("SELECT shared.mark_memory_source_dirty('team_delivery',$1)",[deliverySession])
  await expect(a.persistTeamSemanticRegistration(runtime,stale)).rejects.toThrow()
  const replay=await persistCanonicalReferencePage(runtime,await prepareCanonicalReferencePage(runtime,scope,target));expect(replay.every(r=>!r.created)).toBe(true)
  expect(await a.persistTeamSemanticRegistration(runtime,await a.prepareTeamSemanticRegistration(runtime,[{scope,root:target}]))).toEqual(result)
  expect((await runtime.query("SELECT source_event_id::text,source_version FROM memory_team_semantic_witnesses WHERE source_root->>'kind'='team_delivery' ORDER BY source_event_id")).rows).toEqual(audit)
  expect((await runtime.query("SELECT row_to_json(s) AS metadata FROM source_events s WHERE source_kind='team_delivery' ORDER BY source_event_id")).rows).toEqual(original)

 }))
 test('authentic persistence bounds a hung write and lost COMMIT response, releases locks and retries the committed UUIDs',async()=>execution(async()=>{
  const a=await api(),page=await a.prepareTeamSemanticRegistration(runtime,[{scope,root},{scope:otherScope,root}])
  const first=(await runtime.query("SELECT semantic_ref_id FROM memory_team_semantic_groups WHERE source_kind='team_collaboration' ORDER BY semantic_key LIMIT 1")).rows[0]
  await pool.query('DELETE FROM memory.memory_team_semantic_groups WHERE semantic_ref_id=$1',[first.semantic_ref_id])
  const before=await counts()
  const fault=async(phase:'write'|'commit')=>{
   const originalConnect=runtime.connect.bind(runtime) as ()=>Promise<pg.PoolClient>,sent:string[]=[],releases:unknown[]=[]
   let lateResponse:(()=>void)|undefined,physical:pg.PoolClient|undefined
   runtime.connect=(async()=>{
    const c=await originalConnect();physical=c
    const originalQuery=c.query.bind(c),originalRelease=c.release.bind(c)
    c.query=((...args:unknown[])=>{
     const sql=String(args[0]);sent.push(sql)
     const response=Reflect.apply(originalQuery,c,args) as Promise<unknown>
     if(phase==='write'?sql.startsWith('INSERT INTO memory_team_semantic_groups'):sql==='COMMIT')return response.then(result=>new Promise(resolve=>{lateResponse=()=>resolve(result)}))
     return response
    }) as pg.PoolClient['query']
    c.release=((destroy?:boolean)=>{releases.push(destroy);originalRelease(destroy)}) as pg.PoolClient['release']
    return c
   }) as typeof runtime.connect
   try{
    const started=performance.now()
    await expect(a.persistTeamSemanticRegistration(runtime,page)).rejects.toThrow('team_semantic_registration_budget_exceeded')
    expect(performance.now()-started).toBeLessThan(7000);expect(releases).toEqual([true])
    expect((physical as unknown as {connection:{stream:{destroyed:boolean}}}).connection.stream.destroyed).toBe(true)
    const atTimeout=sent.length;lateResponse?.();await new Promise(resolve=>setTimeout(resolve,20));expect(sent).toHaveLength(atTimeout);expect(releases).toEqual([true])
   }finally{runtime.connect=originalConnect as typeof runtime.connect}
  }
  await fault('write');expect(await counts()).toEqual(before)
  const check=await pool.connect()
  try{await check.query('BEGIN');await check.query('SELECT 1 FROM memory.source_events FOR UPDATE NOWAIT');await check.query('ROLLBACK')}finally{check.release()}
  await fault('commit')
  expect(await counts()).toEqual({...before,groups:before.groups+1,witnesses:before.witnesses+2})
  const committed=(await runtime.query("SELECT semantic_ref_id,semantic_key FROM memory_team_semantic_groups WHERE source_kind='team_collaboration'")).rows
  const retried=await a.persistTeamSemanticRegistration(runtime,page)
  expect(retried.every(r=>r.publishReady===false&&committed.some(g=>g.semantic_ref_id===r.semanticRefId&&g.semantic_key===r.semanticKey))).toBe(true)
  expect(await a.persistTeamSemanticRegistration(runtime,page)).toEqual(retried)
 }),20000)
 test('privacy deletion cascades only witness metadata and never retargets original UUIDs',async()=>{
  const original=(await runtime.query('SELECT source_event_id::text FROM source_events ORDER BY source_event_id LIMIT 1')).rows[0]
  await pool.query('DELETE FROM memory.source_events WHERE source_event_id=$1',[original.source_event_id])
  expect((await counts()).witnesses).toBe(8);expect((await counts()).groups).toBe(6)
  expect((await runtime.query('SELECT count(*)::int AS n FROM memory_team_semantic_witnesses WHERE source_event_id=$1',[original.source_event_id])).rows[0].n).toBe(0)
 })
 test.each(['team_collaboration','team_delivery'] as const)('personal B and C register native %s for binding target A without merging receiving installations',async kind=>{
  const a=await api(),target={kind,key:kind==='team_delivery'?deliverySession:'call'},ids=[randomUUID(),randomUUID()],all:string[][]=[]
  for(const installationId of ids){
   await pool.query("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}')",[installationId])
   await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installationId])
   await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-active',3)",[installationId])
   await pool.query("SELECT shared.mark_memory_control_dirty('installation',$1)",[installationId])
   const personal={...scope,installationId,ownerScopeKind:'personal' as const,ownerScopeId:installationId}
   await execution(async()=>{
    await raw([{scope:personal,root:target}])
    const original=(await runtime.query('SELECT row_to_json(s) AS metadata FROM source_events s WHERE installation_id=$1 ORDER BY source_event_id',[installationId])).rows
    const page=await a.prepareTeamSemanticRegistration(runtime,[{scope:personal,root:target}]),before=await counts()
    for(const [change,restore,args] of [
     ["UPDATE public.extension_installations SET status='paused' WHERE installation_id=$1","UPDATE public.extension_installations SET status='active' WHERE installation_id=$1",[inst]],
     ["UPDATE public.team_memory_bindings SET state='revoked' WHERE binding_id='b'","UPDATE public.team_memory_bindings SET state='active' WHERE binding_id='b'",[]],
     ["UPDATE public.team_memory_bindings SET revision=2 WHERE binding_id='b'","UPDATE public.team_memory_bindings SET revision=1 WHERE binding_id='b'",[]],
     ["UPDATE public.extension_teams SET state='suspended' WHERE team_id=$1","UPDATE public.extension_teams SET state='active' WHERE team_id=$1",[teamScope]],
    ] as const){
     await pool.query(change,[...args]);try{await expect(a.persistTeamSemanticRegistration(runtime,page)).rejects.toThrow();expect(await counts()).toEqual(before)}finally{await pool.query(restore,[...args])}
    }
    const result=await a.persistTeamSemanticRegistration(runtime,page);expect(result).toHaveLength(3);expect(result.every(r=>!r.publishReady)).toBe(true)
    expect(await a.persistTeamSemanticRegistration(runtime,page)).toEqual(result);all.push(result.map(r=>r.semanticRefId))
    const groups=(await runtime.query('SELECT owner_scope_kind,owner_scope_id,semantic_provenance,provenance_state,registration_state FROM memory_team_semantic_groups WHERE installation_id=$1',[installationId])).rows
    expect(groups).toHaveLength(3)
    for(const group of groups){expect(group).toMatchObject({owner_scope_kind:'personal',owner_scope_id:installationId,provenance_state:'provenance_unknown',registration_state:'preparatory'});expect(group.semantic_provenance.team.read_scope).toMatchObject({target_installation_id:inst,target_owner_scope_kind:'team',target_owner_scope_id:teamScope})}
    expect((await runtime.query('SELECT row_to_json(s) AS metadata FROM source_events s WHERE installation_id=$1 ORDER BY source_event_id',[installationId])).rows).toEqual(original)
    expect(await counts()).toEqual({...before,groups:before.groups+3,witnesses:before.witnesses+3})
   },installationId)
  }
  expect(all[0].every(id=>!all[1].includes(id))).toBe(true)
 })

})
