import pg from 'pg'
import {resolve} from 'node:path'
import {mkdtemp,mkdir,writeFile,rm,stat,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {randomUUID,createHash} from 'node:crypto'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {provisionSharedDatabase} from '../../migrations/shared-db/namespace.js'
import {createMemoryPool} from '../../db.js'
import {createPostgresSharedSourceReader,canonicalPayloadHash,encodeArchiveChunk,archiveObjectKey,type SourceScope} from '@pocketctl/session-source'
import {withSourceJobExecution} from '../../sources/source-execution.js'
import {prepareCanonicalReferencePage,persistCanonicalReferencePage} from '../../sources/canonical-references.js'
import {bindSourcePool} from '../../sources/pool-context.js'
import {prepareSourceReferences} from '../../sources/prepared-sources.js'
const url=process.env.NATIVE_SESSION_ALIAS_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
const inst='10000000-0000-0000-0000-000000000155'
suite('real native Relay and Memory alias/source/storage binding',()=>{
 let pool:pg.Pool,runtime:pg.Pool,admin:pg.Pool,relayRuntime:pg.Pool,relay:any,publisher:any,EventMaterializer:any,fixture:any,owner:number,other:number,scope:SourceScope,storage:any
 let sourceId:string,eventId:string,sourceHash:string,sourceProvenance:any,originalBytes:Buffer,oldManifest:string,claimId:string,versionId:string,evidenceId:string,episodeId:string,skill:any,skillRequest:any,originalSkill:any
 const root=(id='alias-old')=>({kind:'relay_event' as const,key:owner+':'+id})
 const reader=()=>createPostgresSharedSourceReader(runtime,{storage,limits:fixture.aliasLimits})
 beforeAll(async()=>{
  if(!url||new URL(url).pathname!=='/shared_native_alias_memory_w3_test'||!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw Error('dedicated_alias_memory_fixture_required')
  pool=new pg.Pool({connectionString:url,max:6,statement_timeout:10000,lock_timeout:1000})
  const identity=(await pool.query('SELECT current_user AS role_name,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0]
  expect(identity).toEqual({role_name:'shared_native_alias_memory_w3_test',superuser:false})
  const adminUrl=new URL(url);adminUrl.username='postgres'
  const suppliedAdmin=process.env.NATIVE_SESSION_ALIAS_FIXTURE_ADMIN_DATABASE_URL
  if(suppliedAdmin&&(new URL(suppliedAdmin).host!==adminUrl.host||new URL(suppliedAdmin).pathname!==adminUrl.pathname))throw Error('dedicated_alias_fixture_admin_required')
  admin=new pg.Pool({connectionString:suppliedAdmin??adminUrl.href,max:2})
  expect((await admin.query('SELECT current_database() AS db')).rows[0].db).toBe('shared_native_alias_memory_w3_test')
  await admin.query('DROP SCHEMA IF EXISTS memory CASCADE;DROP SCHEMA IF EXISTS shared CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public AUTHORIZATION shared_native_alias_memory_w3_test')
  const relayBuildHash=createHash('sha256')
  for(const name of ['db','session-alias/schema','materialization/event-materializer','extensions/journal','extensions/snapshot-repository','session-history/postgres-reader','session-history/schema','session-documents/schema','session-documents/repository','session-documents/body-schema','session-documents/body-reader','session-lifecycle/executor','session-archive/object-gc','shared-source/capture','shared-source/capture-contract','shared-source/session-capture','__tests__/native-session-alias-fixture']){
   const src=resolve('../relay/src/'+name+'.ts'),built=resolve('../relay/dist/'+name+'.js')
   const [sourceStat,builtStat]=await Promise.all([stat(src),stat(built)])
   if(sourceStat.mtimeMs>builtStat.mtimeMs)throw Error('native_relay_fixture_build_stale:'+name)
   relayBuildHash.update(name).update(await readFile(src)).update(await readFile(built))
  }
  console.info('native_relay_fixture_source_and_build_sha256='+relayBuildHash.digest('hex'))
  const load=(name:string)=>import(pathToFileURL(resolve('../relay/dist/'+name+'.js')).href)
  relay=await load('db');publisher=await load('shared-source/capture');({EventMaterializer}=await load('materialization/event-materializer'));fixture=await load('__tests__/native-session-alias-fixture')
  await relay.initDB(pool);await applyMemorySchema(pool,{namespace:'memory'});await applySharedSourceContract(pool);await publisher.applyRelaySourceCapture(pool)
  const owners=(await pool.query("INSERT INTO users(email,password_hash) VALUES('alias-memory-owner@test.invalid','x'),('alias-memory-other@test.invalid','x') RETURNING id")).rows;owner=owners[0].id;other=owners[1].id
  await pool.query("INSERT INTO daemons(daemon_id,user_id) VALUES('alias-daemon',$1),('alias-other-daemon',$2)",[owner,other])
  await pool.query("INSERT INTO sessions(session_id,daemon_id,user_id,agent_type,source,status) VALUES('alias-old','alias-daemon',$1,'codex','terminal','idle')",[owner])
  await pool.query("INSERT INTO extension_providers(provider_id,manifest_version,manifest,status) VALUES('pocketctl-memory',1,'{}','enabled') ON CONFLICT(provider_id) DO UPDATE SET status='enabled'")
  await pool.query("INSERT INTO extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory',$2,'personal',$1,'active',ARRAY['session:events:read','session:snapshot:read','session:deletion:read'],ARRAY['session.event'],ARRAY['memory.manage'],'retained_history')",[inst,owner])
  await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[inst])
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-active',1)",[inst]);await pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  await provisionSharedDatabase(admin,{memoryRole:'shared_alias_memory_rt_test',relayRole:'shared_alias_relay_rt_test',migratorRole:'shared_alias_migrator_test'})
  const u=new URL(url);u.username='shared_alias_memory_rt_test';u.password='synthetic-only';runtime=createMemoryPool({databaseUrl:u.href,databaseNamespace:'memory',dbPoolMax:6})
  const relayUrl=new URL(url);relayUrl.username='shared_alias_relay_rt_test';relayUrl.password='synthetic-only';relayRuntime=new pg.Pool({connectionString:relayUrl.href,max:4,options:'-c search_path=pg_catalog,public,shared -c lock_timeout=1000'})
  scope={installationId:inst,principalUserId:String(owner),ownerScopeKind:'personal',ownerScopeId:inst,authorizationRevision:'1',configVersion:'1',modeGeneration:'1'}
  await runtime.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)",[inst])
  storage=fixture.aliasStorage();bindSourcePool(runtime,{namespace:'memory',archive:{storage,limits:fixture.aliasLimits}})
 },60000)
 afterAll(async()=>{await runtime?.end();await relayRuntime?.end();await pool?.end();await admin?.end()})
 async function execution<T>(work:()=>Promise<T>,branch:'canonical-active'|'legacy-active'='canonical-active',target=inst){
  const job=randomUUID();await runtime.query("INSERT INTO memory.memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1,$2,'extract_candidates',$3,85,'running','alias-worker',1,clock_timestamp()+interval '5 minutes')",[job,target,job])
  return withSourceJobExecution(runtime,{jobId:job,claimedBy:'alias-worker',claimEpoch:'1'},work,{branch})
 }
 async function coolExistingEvent(id:string){
  const e=(await pool.query('SELECT e.*,s.activity_epoch::text AS archive_epoch FROM events e JOIN sessions s USING(session_id) WHERE e.id=$1',[id])).rows[0]
  const manifestId=randomUUID(),binding={userId:e.user_id,sessionId:e.session_id,activityEpoch:e.archive_epoch,manifestId,ordinal:0}
  const encoded=await encodeArchiveChunk(binding,[{id,eventType:e.event_type,payload:e.payload}],fixture.aliasLimits),m=encoded.manifest,key=archiveObjectKey(manifestId,0)
  await storage.put(key,encoded.bytes)
  await pool.query("INSERT INTO session_archive_manifests(manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,published_at,storage_namespace) VALUES($1,$2,$3,$4,1,'gzip','published',$5,NOW(),$6)",[manifestId,e.user_id,e.session_id,e.archive_epoch,id,storage.namespace])
  await pool.query('INSERT INTO session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256) VALUES($1,0,$2,$3,$3,1,$4,$5,$6,$7)',[manifestId,key,id,m.rawBytes,m.compressedBytes,m.rawSha256,m.compressedSha256])
  await pool.query("UPDATE events SET body_storage='cold',payload=NULL,body_session_id=$1,body_manifest_id=$2,body_chunk_ordinal=0,body_owner_user_id=$3,body_activity_epoch=$4 WHERE id=$5",[e.session_id,manifestId,e.user_id,e.archive_epoch,id])
 }
 test('actual canonical producer creates immutable UUID/provenance from trusted published source',async()=>{
  const journal=(await import(pathToFileURL(resolve('../relay/dist/extensions/journal.js')).href)).createPostgresExtensionJournalSink({sharedHeaders:true})
  const m=new EventMaterializer({pool:relayRuntime,extensionJournalSink:journal})
  const proof={version:1,producer:'codex',session_id:'alias-old',turn_id:'turn-one',event_id:'original-wire-event',sequence:'1',invocation_id:'alias-invocation',source_role:'assistant',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}
  const payload={type:'agent_text',session_id:'alias-old',event_id:'original-wire-event',text:'stable original source body',turn_id:'turn-one',memory_source:proof}
  const saved=await m.materialize({inboxId:1,userId:owner,daemonId:'alias-daemon',sessionId:'alias-old',eventType:'agent_text',payload,context:{hostname:'fixture'}});eventId=String(saved.eventId)
  sourceHash=canonicalPayloadHash(payload).toString('hex')
  await execution(async()=>{const page=await prepareCanonicalReferencePage(runtime,scope,root(),{keys:[eventId]});const refs=await persistCanonicalReferencePage(runtime,page);expect(refs).toHaveLength(1);sourceId=refs[0].sourceEventId})
  const row=(await runtime.query('SELECT source_event_id::text,session_id,canonical_session_key,source_provenance,encode(content_hash,\'hex\') AS hash,payload FROM source_events WHERE source_event_id=$1',[sourceId])).rows[0]
  expect(row).toMatchObject({source_event_id:sourceId,session_id:'alias-old',canonical_session_key:'alias-old',hash:sourceHash,payload:null});sourceProvenance=row.source_provenance
  claimId=randomUUID();versionId=randomUUID();evidenceId=randomUUID();episodeId=randomUUID()
  const repository=randomUUID(),snapshot=randomUUID(),excerpt=payload.text,excerptHash=createHash('sha256').update(excerpt).digest(),digest=Buffer.alloc(32,21)
  await runtime.query("INSERT INTO repositories(installation_id,repository_id,repository_key,first_observed_at,last_observed_at) VALUES($1,$2,'alias-repository',NOW(),NOW())",[inst,repository])
  await runtime.query("INSERT INTO repo_snapshots(installation_id,repo_snapshot_id,repository_id,commit_sha,observed_at) VALUES($1,$2,$3,$4,NOW())",[inst,snapshot,repository,'a'.repeat(40)])
  await runtime.query("INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2,'test_invariant','installation','','alias-invariant','active')",[claimId,inst])
  await runtime.query("INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,1,'Alias preserves original evidence','user_accepted',0.9)",[versionId,inst,claimId])
  await runtime.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claimId,versionId])
  await runtime.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,outcome,ready_at,compiler_version,repository_id,repo_snapshot_id,source_digest,document,evidence_manifest,document_compiler_version,compiled_at)
   VALUES($1,$2,'alias-old','turn-one','ready','completed',NOW()-interval '1 second','fixture',$3,$4,$5,$6,$7,'v1',NOW())`,[inst,episodeId,repository,snapshot,digest,{tests:[{status:'passed',text:excerpt,evidence_handle:'h1'}]},{h1:{kind:'episode',source_event_id:sourceId,excerpt_hash:excerptHash.toString('hex').slice(0,16),excerpt_length:excerpt.length,truncated:false}}])
  await runtime.query("INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,source_event_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at) VALUES($1,$2,$3,$4,$5,1,'event',$6,$7,NOW())",[evidenceId,inst,versionId,episodeId,sourceId,excerpt,excerptHash])
  const {createSkillAdmissionService}=await import('../../skills/admission-service.js'),{loadSkillConfig}=await import('../../skills/config.js')
  skill=createSkillAdmissionService({pool:runtime,context:{globalMode:'enabled',sharedMode:'shadow',config:loadSkillConfig({MEMORY_SKILL_MODE:'shadow'})}})
  skillRequest={installationId:inst,grant:{primaryInstallationId:inst,configVersion:'1',userId:owner,scopeBindings:[{installation_id:inst,owner_scope_kind:'personal',owner_scope_id:inst,membership_id:null,membership_revision:'0',authorization_epoch:'1',permissions:['read','contribute','review']}]},candidateKey:'alias-original-skill',source:{kind:'episode',episodeId}}
  originalSkill=await skill.schedule(skillRequest)
  const evidence=(await import('../../claims/evidence-service.js')).createEvidenceService(runtime)
  expect(await evidence.summary({installationId:inst,evidenceId,configVersion:'1',userId:owner})).toBeTruthy()

  const manifestId=randomUUID(),binding={userId:owner,sessionId:'alias-old',activityEpoch:'0',manifestId,ordinal:0}
  const encoded=await encodeArchiveChunk(binding,[{id:eventId,eventType:'agent_text',payload}],fixture.aliasLimits),chunk=encoded.manifest
  oldManifest=manifestId;originalBytes=Buffer.from(encoded.bytes);await storage.put(archiveObjectKey(manifestId,0),encoded.bytes)
  await pool.query("ALTER TABLE events ALTER COLUMN payload DROP NOT NULL")
  await pool.query("INSERT INTO session_archive_manifests(manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,published_at,storage_namespace) VALUES($1,$2,'alias-old',0,1,'gzip','published',$3,NOW(),$4)",[manifestId,owner,eventId,storage.namespace])
  await pool.query('INSERT INTO session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256) VALUES($1,0,$2,$3,$3,1,$4,$5,$6,$7)',[manifestId,archiveObjectKey(manifestId,0),eventId,chunk.rawBytes,chunk.compressedBytes,chunk.rawSha256,chunk.compressedSha256])
  await pool.query("UPDATE events SET body_storage='cold',payload=NULL,body_session_id='alias-old',body_manifest_id=$1,body_chunk_ordinal=0,body_owner_user_id=$2,body_activity_epoch=0 WHERE id=$3",[manifestId,owner,eventId])
 })
 test('old -> middle -> new preserves UUID and original headers; fresh old root sees later new-route events',async()=>{
  const rename=async(oldSessionId:string,newSessionId:string)=>relay.renameOwnedDaemonSession(relayRuntime,{oldSessionId,newSessionId,daemonId:'alias-daemon',userId:owner})
  const before=await reader().getHeads(scope,root(),[eventId]);await rename('alias-old','alias-middle');await rename('alias-middle','alias-new')
  expect((await reader().checkCurrent(scope,root(),before.version)).state).toBe('changed')
  const page=await reader().getHeads(scope,root('alias-new'),[eventId]);expect(page.heads[0]).toMatchObject({sessionKey:'alias-old',currentSessionKey:'alias-new',contentHash:sourceHash})
  await execution(async()=>{const page=await prepareCanonicalReferencePage(runtime,scope,root('alias-new'),{keys:[eventId]});expect(await persistCanonicalReferencePage(runtime,page)).toEqual([{sourceEventId:sourceId,canonicalKey:eventId,sessionId:'alias-old',created:false}])})
  const oldRoot=await reader().checkCurrent(scope,root());await pool.query("INSERT INTO events(session_id,user_id,event_type,payload,event_hash,effect_status) VALUES('alias-new',$1,'agent_text','{\"text\":\"new source\",\"turn_id\":\"turn-new\"}','new-route-source','completed')",[owner])
  expect((await reader().checkCurrent(scope,root(),oldRoot.version)).state).toBe('changed')
  const original=(await runtime.query('SELECT session_id,canonical_session_key,source_provenance,encode(content_hash,\'hex\') AS hash FROM source_events WHERE source_event_id=$1',[sourceId])).rows[0]
  expect(original).toEqual({session_id:'alias-old',canonical_session_key:'alias-old',source_provenance:sourceProvenance,hash:sourceHash})
  const prepared=await prepareSourceReferences(runtime,inst,[sourceId]);expect(prepared.events[0].source_event_id).toBe(sourceId)
  expect(await skill.schedule(skillRequest)).toMatchObject({taskId:originalSkill.taskId,runId:originalSkill.runId,deduplicated:true})
  expect(await (await import('../../claims/evidence-service.js')).createEvidenceService(runtime).summary({installationId:inst,evidenceId,configVersion:'1',userId:owner})).toBeTruthy()
  expect((await runtime.query('SELECT source_event_id::text FROM knowledge_evidence WHERE evidence_id=$1',[evidenceId])).rows[0].source_event_id).toBe(sourceId)

 })
 test('real Journal shared-header exact rename ACK replay survives a later route and cold body',async()=>{
  // A separate native source tests rename receipts without touching the original evidence source.
  await pool.query("INSERT INTO sessions(session_id,daemon_id,user_id,agent_type,source,status) VALUES('ack-old','alias-daemon',$1,'codex','terminal','idle')",[owner])
  const journal=(await import(pathToFileURL(resolve('../relay/dist/extensions/journal.js')).href)).createPostgresExtensionJournalSink({sharedHeaders:true});let hooks=0
  const m=new EventMaterializer({pool:relayRuntime,extensionJournalSink:journal,hooks:{renameSession:()=>{hooks++}}})
  const input={inboxId:21,userId:owner,daemonId:'alias-daemon',sessionId:'ack-middle',eventType:'session_id_changed',payload:{type:'session_id_changed',session_id:'ack-middle',old_session_id:'ack-old',event_id:'exact-ack'},context:{hostname:'fixture'}}
  const first=await m.materialize(input);const original=(await pool.query('SELECT event_hash,logical_source_session_id,source_sequence::text,canonical_payload_hash,source_classification FROM events WHERE id=$1',[first.eventId])).rows[0]
  await m.materialize({...input,sessionId:'ack-new',payload:{...input.payload,old_session_id:'ack-middle',session_id:'ack-new',event_id:'next-ack'}})
  await coolExistingEvent(String(first.eventId))
  expect((await m.materialize(input)).eventId).toBe(first.eventId);expect(hooks).toBe(2)
  expect((await pool.query('SELECT event_hash,logical_source_session_id,source_sequence::text,canonical_payload_hash,source_classification FROM events WHERE id=$1',[first.eventId])).rows[0]).toEqual(original)
 })
 test('old pin protects current route and rename does not reopen its absolute two minute window',async()=>{
  const before=(await admin.query('SELECT session_id,hard_deadline,started_at FROM shared.memory_source_processing_windows WHERE owner_user_id=$1',[owner])).rows
  expect(before).toHaveLength(1);expect(before[0].session_id).toBe('alias-old')
  await execution(async()=>{
   await prepareCanonicalReferencePage(runtime,scope,root('alias-new'),{keys:[eventId]})
   expect((await relayRuntime.query('SELECT shared.memory_source_processing_blocks_purge($1,$2::text[]) AS blocked',[owner,['alias-new']])).rows[0].blocked).toBe(true)
   const during=(await admin.query('SELECT session_id,hard_deadline,started_at FROM shared.memory_source_processing_windows WHERE owner_user_id=$1',[owner])).rows
   expect(during).toEqual(before)
  })
  expect((await relayRuntime.query('SELECT shared.memory_source_processing_blocks_purge($1,$2::text[]) AS blocked',[owner,['alias-new']])).rows[0].blocked).toBe(false)
 })
 test('stale preparation refuses while final native locks exclude privacy/rename through physical COMMIT',async()=>{
  const stale=await prepareSourceReferences(runtime,inst,[sourceId])
  await pool.query("INSERT INTO events(session_id,user_id,event_type,payload,event_hash,effect_status) VALUES('alias-new',$1,'agent_text','{\"text\":\"another new event\"}','alias-new-later','completed')",[owner])
  const c=await runtime.connect()
  try{
   await c.query('BEGIN');await expect(stale.assertCurrent(c,{forCommit:true})).rejects.toThrow('source_reference_changed');await c.query('ROLLBACK')
   const fresh=await prepareSourceReferences(runtime,inst,[sourceId]);await c.query('BEGIN');await fresh.assertCurrent(c,{forCommit:true})
   await expect(pool.query("INSERT INTO deleted_sessions(session_id) VALUES('alias-middle')")).rejects.toMatchObject({code:'55P03'})
   await expect(relay.renameOwnedDaemonSession(relayRuntime,{oldSessionId:'alias-new',newSessionId:'blocked-by-commit',daemonId:'alias-daemon',userId:owner})).rejects.toMatchObject({code:'55P03'})
   await c.query('COMMIT')
   expect((await reader().checkCurrent(scope,root())).state).toBe('current')
  }finally{await c.query('ROLLBACK');c.release()}
 })
 test('owner transfer denies old UUID/raw evidence and permits genuine new-owner facts; former-owner old-hop privacy cannot revoke them',async()=>{
  await pool.query("INSERT INTO sessions(session_id,daemon_id,user_id,agent_type,source,status) VALUES('transfer-old','alias-daemon',$1,'codex','terminal','idle')",[owner])
  const journal=(await import(pathToFileURL(resolve('../relay/dist/extensions/journal.js')).href)).createPostgresExtensionJournalSink({sharedHeaders:true})
  const oldBody={type:'agent_text',session_id:'transfer-old',event_id:'transfer-original',text:'separate owner facts'}
  const oldEvent=await new EventMaterializer({pool:relayRuntime,extensionJournalSink:journal}).materialize({inboxId:50,userId:owner,daemonId:'alias-daemon',sessionId:'transfer-old',eventType:'agent_text',payload:oldBody,context:{hostname:'fixture'}})
  let oldUuid='';await execution(async()=>{const p=await prepareCanonicalReferencePage(runtime,scope,root('transfer-old'),{keys:[String(oldEvent.eventId)]});oldUuid=(await persistCanonicalReferencePage(runtime,p))[0].sourceEventId})
  await relay.renameOwnedDaemonSession(relayRuntime,{oldSessionId:'transfer-old',newSessionId:'transfer-current',daemonId:'alias-daemon',userId:owner})
  await pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-other-daemon' WHERE session_id='transfer-current'",[other])
  const otherInst=randomUUID()
  await pool.query("INSERT INTO extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory',$2,'personal',$1,'active',ARRAY['session:events:read'],ARRAY['session.event'],ARRAY['memory.manage'],'retained_history')",[otherInst,other])
  await runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[otherInst])
  await admin.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-active',1)",[otherInst])
  const otherScope={...scope,installationId:otherInst,ownerScopeId:otherInst,principalUserId:String(other)},otherRoot={kind:'relay_event' as const,key:other+':transfer-current'}
  const newBody={type:'agent_text',session_id:'transfer-current',event_id:'new-owner-event',text:'separate owner facts'}
  const newEvent=await new EventMaterializer({pool:relayRuntime,extensionJournalSink:journal}).materialize({inboxId:51,userId:other,daemonId:'alias-other-daemon',sessionId:'transfer-current',eventType:'agent_text',payload:newBody,context:{hostname:'fixture'}})
  let newUuid='';await execution(async()=>{const p=await prepareCanonicalReferencePage(runtime,otherScope,otherRoot,{keys:[String(newEvent.eventId)]});newUuid=(await persistCanonicalReferencePage(runtime,p))[0].sourceEventId},'canonical-active',otherInst);expect(newUuid).not.toBe(oldUuid)
  const newer=await reader().getHeads(otherScope,otherRoot,[String(newEvent.eventId)]);expect(newer.heads[0].sessionKey).toBe('transfer-current')
  expect((await reader().resolveBodies(otherScope,otherRoot,newer.heads,newer.version))[0].payload).toEqual(newBody)
  await expect(reader().getHeads(otherScope,otherRoot,[String(oldEvent.eventId)])).rejects.toMatchObject({code:'body_set_mismatch'})
  await expect(prepareSourceReferences(runtime,inst,[oldUuid])).rejects.toThrow()
  await expect(prepareSourceReferences(runtime,otherInst,[oldUuid])).rejects.toThrow('source_reference_missing')
  await pool.query("INSERT INTO deleted_sessions(session_id) VALUES('transfer-old')")
  expect((await reader().checkCurrent(otherScope,otherRoot,newer.version)).state).toBe('current')
  expect((await reader().resolveBodies(otherScope,otherRoot,newer.heads,newer.version))[0].payload).toEqual(newBody)
  const getHistory=(await import(pathToFileURL(resolve('../relay/dist/session-history/postgres-reader.js')).href))
  getHistory.installPostgresHistoryBodyReader(relayRuntime,storage,fixture.aliasLimits)
  const visible=await getHistory.withSessionHistoryScope({userId:other},()=>relay.getSessionAllEvents(relayRuntime,'transfer-current'))
  expect(visible.map((r:any)=>String(r.id))).toEqual([String(newEvent.eventId)])
  expect((await pool.query('SELECT user_id,logical_source_session_id FROM events WHERE id=$1',[oldEvent.eventId])).rows[0]).toEqual({user_id:owner,logical_source_session_id:'transfer-old'})
  // The current identity can return to A; its old facts never become active again.
  await pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-daemon' WHERE session_id='transfer-current'",[owner])
  const aRoot=root('transfer-current'),aBody={type:'agent_text',session_id:'transfer-current',event_id:'A-after-owner-return',text:'genuinely post-cut A'}
  const aEvent=await new EventMaterializer({pool:relayRuntime,extensionJournalSink:journal}).materialize({inboxId:52,userId:owner,daemonId:'alias-daemon',sessionId:'transfer-current',eventType:'agent_text',payload:aBody,context:{hostname:'fixture'}})
  const aPage=await reader().getHeads(scope,aRoot,[String(aEvent.eventId)])
  expect((await reader().resolveBodies(scope,aRoot,aPage.heads,aPage.version))[0].payload).toEqual(aBody)
  await expect(reader().getHeads(scope,aRoot,[String(oldEvent.eventId)])).rejects.toMatchObject({code:'body_set_mismatch'})
  await expect(prepareSourceReferences(runtime,inst,[oldUuid])).rejects.toThrow()
  expect((await pool.query('SELECT owner_retired FROM events WHERE id=$1',[oldEvent.eventId])).rows[0].owner_retired).toBe(true)
  expect((await admin.query("SELECT reason FROM shared.memory_source_session_barriers WHERE owner_user_id=$1 AND session_id='transfer-current'",[owner])).rows[0].reason).toBe('owner_changed')
  const legacy=(await runtime.query("SELECT state FROM shared.memory_retained_relay_authority($1::jsonb,'legacy_archive',$2)",[JSON.stringify(scope),aRoot.key])).rows[0]
  expect(legacy.state).toBe('deleted')
  let aUuid='';await execution(async()=>{const p=await prepareCanonicalReferencePage(runtime,scope,aRoot,{keys:[String(aEvent.eventId)]});aUuid=(await persistCanonicalReferencePage(runtime,p))[0].sourceEventId})
  const stale=await prepareSourceReferences(runtime,inst,[aUuid])
  await pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-other-daemon' WHERE session_id='transfer-current'",[other]);await pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-daemon' WHERE session_id='transfer-current'",[owner])
  const c=await runtime.connect();try{await c.query('BEGIN');await expect(stale.assertCurrent(c,{forCommit:true})).rejects.toThrow();await c.query('ROLLBACK')}finally{c.release()}
  const finalBody={...aBody,event_id:'A-after-second-return',text:'latest genuine A'},finalEvent=await new EventMaterializer({pool:relayRuntime,extensionJournalSink:journal}).materialize({inboxId:53,userId:owner,daemonId:'alias-daemon',sessionId:'transfer-current',eventType:'agent_text',payload:finalBody,context:{hostname:'fixture'}})
  const finalPage=await reader().getHeads(scope,aRoot,[String(finalEvent.eventId)]);expect(finalPage.heads).toHaveLength(1)
  await runtime.query("INSERT INTO memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,'transfer-current','privacy',NOW())",[inst])
  expect((await reader().checkCurrent(scope,aRoot,finalPage.version)).state).toBe('deleted')
  await expect(reader().getHeads(scope,aRoot,[String(finalEvent.eventId)])).rejects.toThrow()
  expect((await runtime.query("SELECT reason FROM memory_session_tombstones WHERE installation_id=$1 AND session_id='transfer-current'",[inst])).rows[0].reason).toBe('privacy')

 })
 test('Memory exact cold reference retirement denies owner ABA during actual IO and warmed cache',async()=>{
  const journal=(await import(pathToFileURL(resolve('../relay/dist/extensions/journal.js')).href)).createPostgresExtensionJournalSink({sharedHeaders:true})
  for(const cached of [false,true]){
   const sid='memory-owner-aba-'+cached
   await pool.query("INSERT INTO sessions(session_id,daemon_id,user_id,agent_type,source,status) VALUES($1,'alias-daemon',$2,'codex','terminal','idle')",[sid,owner])
   const body={type:'agent_text',session_id:sid,event_id:'owner-aba-'+cached,text:'original fact never regranted'}
   const saved=await new EventMaterializer({pool:relayRuntime,extensionJournalSink:journal}).materialize({inboxId:54,userId:owner,daemonId:'alias-daemon',sessionId:sid,eventType:'agent_text',payload:body,context:{hostname:'fixture'}})
   let uuid='';await execution(async()=>{const p=await prepareCanonicalReferencePage(runtime,scope,root(sid),{keys:[String(saved.eventId)]});uuid=(await persistCanonicalReferencePage(runtime,p))[0].sourceEventId})
   const original=(await runtime.query('SELECT source_event_id::text,session_id,content_hash,source_provenance FROM source_events WHERE source_event_id=$1',[uuid])).rows[0]
   await coolExistingEvent(String(saved.eventId));const r=reader(),page=await r.getHeads(scope,root(sid),[String(saved.eventId)])
   const cut=async()=>{await pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-other-daemon' WHERE session_id=$2",[other,sid]);await pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-daemon' WHERE session_id=$2",[owner,sid])}
   if(cached){
    await r.resolveBodies(scope,root(sid),page.heads,page.version)
    const q=runtime.query.bind(runtime);let cutDone=false
    ;(runtime as any).query=async(...args:any[])=>{const value=await (q as any)(...args);if(!cutDone&&String(args[0]).includes('SELECT shared.read_memory_relay_archive')){cutDone=true;await cut()}return value}
    try{await expect(r.resolveBodies(scope,root(sid),page.heads,page.version)).rejects.toThrow();expect(cutDone).toBe(true)}finally{runtime.query=q as any}
   }else{
    const read=storage.read.bind(storage);let reads=0;storage.read=async(key:string)=>{const bytes=await read(key);reads++;await cut();return bytes}
    try{await expect(r.resolveBodies(scope,root(sid),page.heads,page.version)).rejects.toThrow();expect(reads).toBe(1)}finally{storage.read=read}
   }
   expect((await reader().checkCurrent(scope,root(sid))).state).toBe('current')
   await expect(reader().getHeads(scope,root(sid),[String(saved.eventId)])).rejects.toMatchObject({code:'body_set_mismatch'})
   await expect(prepareSourceReferences(runtime,inst,[uuid])).rejects.toThrow()
   expect((await runtime.query('SELECT source_event_id::text,session_id,content_hash,source_provenance FROM source_events WHERE source_event_id=$1',[uuid])).rows[0]).toEqual(original)
  }
 })
 test('current-route snapshot preserves original logical sessions, original envelope hash and existing UUID',async()=>{
  await admin.query("UPDATE shared.memory_source_modes SET mode='shared-shadow',generation=2 WHERE installation_id=$1",[inst]);scope={...scope,modeGeneration:'2'}
  const {createSnapshotRepository}=await import('../../snapshot/repository.js'),repository=createSnapshotRepository(runtime)
  const {installPostgresHistoryBodyReader}=await import(pathToFileURL(resolve('../relay/dist/session-history/postgres-reader.js')).href)
  const {getSnapshotEventPage}=await import(pathToFileURL(resolve('../relay/dist/extensions/snapshot-repository.js')).href)
  installPostgresHistoryBodyReader(relayRuntime,storage,fixture.aliasLimits)
  const rows=await getSnapshotEventPage(relayRuntime,{installationId:inst,providerId:'pocketctl-memory',ownerUserId:owner,eventFilter:{}},'alias-new',{afterEventId:0,limit:100})
  const original=rows.find((r:any)=>String(r.event_id)===eventId)
  expect(original.source_binding).toEqual({version:1,original_session_id:'alias-old',current_session_id:'alias-new'})
  const envelope={event_id:original.event_id,event_type:original.event_type,payload:original.payload,created_at:original.created_at}
  await runtime.query('INSERT INTO memory_snapshot_events(installation_id,session_id,relay_event_id,event_type,payload,payload_hash,created_at,occurred_at,generation,content_hash) VALUES($1,\'alias-old\',$2,$3,$4,$5,NOW(),$6,0,$7)',[inst,eventId,original.event_type,original.payload,canonicalPayloadHash(envelope),original.created_at,canonicalPayloadHash(original.payload)])
  await execution(async()=>{
   const run=await repository.startRun(inst)
   await expect(repository.persistSessionEvents(inst,run.generation,'alias-new',[{...original,source_binding:{...original.source_binding,version:2}}])).rejects.toThrow('snapshot_source_binding_invalid')
   await repository.persistSessionEvents(inst,run.generation,'alias-new',rows)
   await repository.finalizeRun({installationId:inst,generation:run.generation,inventorySessionIds:['alias-new'],sessionsSeen:1,eventsSeen:rows.length})
  },'legacy-active')
  const landed=(await runtime.query('SELECT session_id,payload_hash,generation FROM memory_snapshot_events WHERE installation_id=$1 AND relay_event_id=$2',[inst,eventId])).rows[0]
  expect(landed.session_id).toBe('alias-old');expect(landed.payload_hash).toEqual(canonicalPayloadHash(envelope));expect(Number(landed.generation)).toBeGreaterThan(0)
  expect((await runtime.query("SELECT source_event_id::text,session_id,source_provenance,encode(content_hash,'hex') AS hash FROM source_events WHERE source_kind='relay_event' AND canonical_key=$1",[eventId])).rows).toEqual([{source_event_id:sourceId,session_id:'alias-old',source_provenance:sourceProvenance,hash:sourceHash}])
 })
 test.skipIf(!process.env.NATIVE_SESSION_ALIAS_MAPPING_TEST_DATABASE_URL)('actual independent M0 mapping uses original source + original cold storage with fresh native owner authority',async()=>{
  const mappingUrl=process.env.NATIVE_SESSION_ALIAS_MAPPING_TEST_DATABASE_URL!,u=new URL(mappingUrl)
  if(u.pathname!=='/shared_native_alias_mapping_w3_test'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('dedicated_mapping_fixture_required')
  const legacy=new pg.Pool({connectionString:mappingUrl}),directory=await mkdtemp(resolve(tmpdir(),'pocketctl-native-alias-m0-'))
  const {openSnapshot}=await import('../../migrations/shared-source/database.js'),{scanMapping}=await import('../../migrations/shared-source/scanner.js'),{inventoryDatabase}=await import('../../migrations/shared-source/inventory.js'),{reviewRelayObjects}=await import('../../migrations/shared-source/object-review.js')
  let memorySnapshot:any,relaySnapshot:any
  try{
   expect((await legacy.query("SELECT current_user AS role_name,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser")).rows[0]).toEqual({role_name:'shared_native_alias_mapping_w3_test',superuser:false})
   await legacy.query(`DROP SCHEMA public CASCADE;CREATE SCHEMA public;
    CREATE TABLE public.source_events(source_event_id uuid PRIMARY KEY,installation_id uuid,origin text,origin_position text,session_id text,turn_id text,event_type text,occurred_at timestamptz,payload jsonb,payload_hash bytea,source_provenance jsonb,classification jsonb,body_reclaimed_at timestamptz);
    CREATE TABLE public.memory_feed_inbox(installation_id uuid,feed_id bigint,source_kind text,source_id text,session_id text,turn_id text,event_type text,data jsonb,classification jsonb);
    CREATE TABLE public.memory_snapshot_events(installation_id uuid,session_id text,relay_event_id bigint,event_type text,payload jsonb)`)
   const source=(await runtime.query('SELECT * FROM source_events WHERE source_event_id=$1',[sourceId])).rows[0],body=(await prepareSourceReferences(runtime,inst,[sourceId])).events[0].payload
   await legacy.query("INSERT INTO source_events VALUES($1,$2,'snapshot',$3,'alias-old','turn-one','agent_text',$4,$5,$6,$7,$8,NULL)",[sourceId,inst,eventId,source.occurred_at,body,Buffer.from(sourceHash,'hex'),source.source_provenance,source.classification])
   await legacy.query("INSERT INTO memory_snapshot_events VALUES($1,'alias-old',$2,'agent_text',$3)",[inst,eventId,body])
   const key=archiveObjectKey(oldManifest,0);await mkdir(resolve(directory,key,'..'),{recursive:true});await writeFile(resolve(directory,key),originalBytes)
   await pool.query("INSERT INTO sessions(session_id,daemon_id,user_id,agent_type,source,status) VALUES('m0-old','alias-daemon',$1,'codex','terminal','idle')",[owner])
   const auxiliary=await fixture.publishAliasBody(pool,storage,owner,'m0-old')
   await relay.renameOwnedDaemonSession(relayRuntime,{oldSessionId:'m0-old',newSessionId:'m0-new',daemonId:'alias-daemon',userId:owner})
   await mkdir(resolve(directory,auxiliary.key,'..'),{recursive:true});await writeFile(resolve(directory,auxiliary.key),auxiliary.bytes)

   const abaFixtures=[]
   for(const cached of [false,true]){
    const sid='m0-owner-aba-'+cached
    await pool.query("INSERT INTO sessions(session_id,daemon_id,user_id,agent_type,source,status) VALUES($1,'alias-daemon',$2,'codex','terminal','idle')",[sid,owner])
    const f=await fixture.publishAliasBody(pool,storage,owner,sid);await mkdir(resolve(directory,f.key,'..'),{recursive:true});await writeFile(resolve(directory,f.key),f.bytes);abaFixtures.push({sid,cached,f})
   }
   const config=async(p:pg.Pool,connectionString:string)=>({connectionString,expected:{...(await p.query('SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort"')).rows[0],mode:'isolated-restore' as const}})
   memorySnapshot=await openSnapshot(await config(legacy,mappingUrl));relaySnapshot=await openSnapshot(await config(pool,url!))
   const details:any[]=[];await scanMapping(memorySnapshot,relaySnapshot,{archive:{directory,namespace:storage.namespace},onDetail:async r=>{details.push(r)}})
   expect(details).toHaveLength(1);expect(details[0]).toMatchObject({sourceEventId:sourceId,canonicalId:eventId,state:'unique-cold',provenanceState:'known',contentHash:sourceHash})
   const inventory=await inventoryDatabase(relaySnapshot,'relay',{}),alias=inventory.objects.find(o=>o.key==='table:public.session_aliases')!
   expect(alias.classification.blocked).toBe(true)
   expect(reviewRelayObjects(inventory.objects,inventory.objects.filter(o=>o.key!==alias.key)).unreviewed.some(o=>o.key===alias.key)).toBe(true)
   const {ArchiveVerifier}=await import('../../migrations/shared-source/archive.js'),v=new ArchiveVerifier(relaySnapshot,{directory,namespace:storage.namespace})
   const native=(await pool.query('SELECT * FROM events WHERE id=$1',[eventId])).rows[0]
   await expect(v.body({...native,id:eventId,user_id:String(owner),session_id:'alias-old',current_session_id:'alias-new',native_identity_contract:true,body_activity_epoch:String(native.body_activity_epoch),body_session_id:null})).rejects.toThrow('archive_binding_invalid')
   expect(reviewRelayObjects([{...alias,definitionHash:'0'.repeat(64)}],[alias]).allObjectsReviewed).toBe(false)
   const a=(await pool.query('SELECT * FROM events WHERE id=$1',[auxiliary.row.id])).rows[0]
   const auxHead={...a,id:auxiliary.row.id,user_id:String(owner),session_id:'m0-old',current_session_id:'m0-new',native_identity_contract:true,body_activity_epoch:String(a.body_activity_epoch)}
   expect(await v.body(auxHead)).toEqual(auxiliary.row.payload)
   const current=relaySnapshot.currentNativeSessionAuthority.bind(relaySnapshot);let checks=0
   relaySnapshot.currentNativeSessionAuthority=async(sid:string,uid:number,eid?:string)=>{checks++;if(checks===2)await pool.query("INSERT INTO deleted_sessions(session_id) VALUES('m0-old')");return current(sid,uid,eid)}
   await expect(v.body(auxHead)).rejects.toThrow('archive_current_authority_denied');expect(checks).toBe(2)
   for(const {sid,cached,f} of abaFixtures){
    relaySnapshot.currentNativeSessionAuthority=current
    const e=(await relaySnapshot.client.query('SELECT * FROM public.events WHERE id=$1',[f.row.id])).rows[0]
    const head={...e,id:f.row.id,user_id:String(owner),session_id:sid,current_session_id:sid,native_identity_contract:true,body_activity_epoch:String(e.body_activity_epoch)}
    if(cached)expect(await v.body(head)).toEqual(f.row.payload)
    let polls=0;relaySnapshot.currentNativeSessionAuthority=async(sid:string,uid:number,eid?:string)=>{
     if(++polls===2){await pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-other-daemon' WHERE session_id=$2",[other,sid]);await pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-daemon' WHERE session_id=$2",[owner,sid])}
     return current(sid,uid,eid)
    }
    await expect(v.body(head)).rejects.toThrow('archive_current_authority_denied');expect(polls).toBe(2)
    expect((await relaySnapshot.client.query('SELECT owner_retired FROM public.events WHERE id=$1',[f.row.id])).rows[0].owner_retired).toBe(false)
    expect((await pool.query('SELECT owner_retired FROM events WHERE id=$1',[f.row.id])).rows[0].owner_retired).toBe(true)
   }


  }finally{await memorySnapshot?.close();await relaySnapshot?.close();await legacy.end();await rm(directory,{recursive:true,force:true})}
 })
 test('privacy during actual Memory archive IO denies old UUID and retained Claim/Skill without rewriting source facts',async()=>{
  const page=await reader().getHeads(scope,root(),[eventId]),read=storage.read.bind(storage)
  let reads=0;storage.read=async(key:string)=>{reads++;const bytes=await read(key);await pool.query("INSERT INTO deleted_sessions(session_id) VALUES('alias-middle')");return bytes}
  await expect(reader().resolveBodies(scope,root(),page.heads,page.version)).rejects.toMatchObject({code:'deleted'});expect(reads).toBe(1);storage.read=read
  const evidence=(await import('../../claims/evidence-service.js')).createEvidenceService(runtime)
  expect(await evidence.summary({installationId:inst,evidenceId,configVersion:'1',userId:owner})).toBeNull()
  await expect(skill.schedule({...skillRequest,candidateKey:'after-privacy'})).rejects.toThrow('skill_source_invalid')
  expect((await runtime.query("SELECT source_event_id::text,session_id,encode(content_hash,'hex') AS hash,source_provenance FROM source_events WHERE source_event_id=$1",[sourceId])).rows[0]).toEqual({source_event_id:sourceId,session_id:'alias-old',hash:sourceHash,source_provenance:sourceProvenance})
 })
})
