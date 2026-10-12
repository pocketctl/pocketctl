import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto'
import pg from 'pg'
import Fastify,{type FastifyInstance} from 'fastify'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createFeedClient} from '../relay/feed-client.js'
import {createRelayHttpClient} from '../relay/http-client.js'
import {createFeedConsumer} from '../inbox/feed-worker.js'
import {createSourceProjector} from '../projection/source-projector.js'
import {createProjectionHandler} from '../projection/repository.js'
import {createJobRepository} from '../jobs/repository.js'
import {createPurgeRepository} from '../purge/repository.js'
import {createEpisodeRepository} from '../episodes/repository.js'
import {createCandidateExtractor} from '../extraction/extractor.js'
import {createExtractionRepository} from '../extraction/repository.js'
import {createCandidateDeduper} from '../extraction/deduper.js'
import {createClaimRepository} from '../claims/repository.js'

const memoryUrl=process.env.MEMORY_TEST_DATABASE_URL,relayUrl=process.env.RELAY_TEST_DATABASE_URL
const suite=memoryUrl&&relayUrl&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('Task07 actual Relay outbox → authenticated HTTP Feed → Memory lifecycle',()=>{
 let memory:pg.Pool,relay:pg.Pool,app:FastifyInstance,baseUrl:string
 let r:any
 const providerSecret='isolated-task07-provider-secret',issuer='task07-isolated-relay'
 const keys=generateKeyPairSync('rsa',{modulusLength:2048})
 const grantKeys={privateKeyPem:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}).toString(),kid:'task07-fixture'}
 beforeAll(async()=>{
  memory=new pg.Pool({connectionString:memoryUrl,max:8});relay=new pg.Pool({connectionString:relayUrl,max:8})
  await assertMemoryTestDatabase(memory,memoryUrl!)
  const parsed=new URL(relayUrl!)
  if(parsed.hostname!=='127.0.0.1'||parsed.username!=='pocketctl_relay_upgrade_test'||parsed.pathname!=='/pocketctl_relay_upgrade_test'||parsed.search)throw new Error('isolated Relay database required')
  const identity=(await relay.query('SELECT current_database() AS db,current_user AS role,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0]
  expect(identity).toEqual({db:'pocketctl_relay_upgrade_test',role:'pocketctl_relay_upgrade_test',superuser:false})
  // Dynamic runtime imports keep production component compilation independent.
  // These are the actual Relay services; no outbox/feed/authority adapter is mocked.
  r=Object.assign({},...await Promise.all(['db','team/repository','team/session-service','team/memory-source-projector','team/memory-binding-service','extensions/installation-repository','extensions/scope-repository','extensions/v2-grant-service','extensions/feed-projector','extensions/feed-routes','extensions/provider-auth'].map(path=>import(new URL(`../../../relay/src/${path}.ts`,import.meta.url).href))))
  await r.initDB(relay);await applyMemorySchema(memory)
  app=Fastify();r.registerFeedRoutes(app,{pool:relay,mode:'enabled',providerJwtSecret:providerSecret,issuer,cursorSecret:'isolated-task07-cursor',leaseTtlSeconds:30})
  baseUrl=await app.listen({host:'127.0.0.1',port:0})
 },60000)
 beforeEach(async()=>{
  await memory.query('TRUNCATE memory_session_tombstones,memory_purge_receipts,memory_installations CASCADE')
  await relay.query('TRUNCATE extension_feed,extension_source_outbox,extension_providers,users RESTART IDENTITY CASCADE')
 })
 afterAll(async()=>{await app?.close();await memory?.end();await relay?.end()})
 async function fixture(){
  const key=randomUUID(),personal=randomUUID(),target=randomUUID()
  const users=(await relay.query("INSERT INTO users(email,password_hash,team_enabled) VALUES($1,'x',true),($2,'x',true) RETURNING id",[key+'-owner@example.test',key+'-reader@example.test'])).rows
  const owner=Number(users[0].id),reader=Number(users[1].id),sources=new r.TeamMemorySourceProjector(true),teams=new r.TeamRepository(relay,sources)
  const team=(await teams.createTeam({actorUserId:owner,name:'Joint source lifecycle',requestId:key})).team
  const membership='cmm_'+key,session='css_'+key,offer='cao_'+key,agentBinding='cab_'+key
  await relay.query('INSERT INTO collaboration_team_memberships(membership_id,team_id,user_id) VALUES($1,$2,$3)',[membership,team.id,reader])
  await relay.query("INSERT INTO extension_providers(provider_id,manifest_version,manifest) VALUES('pocketctl-memory',1,'{}')")
  await relay.query(`INSERT INTO extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,event_filter,start_policy)
   VALUES($1,'pocketctl-memory',$2,'personal',$1,'active','{session:events:read,session:deletion:read}','{session.event.v1,session.access.revoked.v1}','{memory.manage,memory.search}','{}','from_now')`,[personal,reader])
  const {organization}=await r.createOrganizationWithCreator(relay,{name:'Joint source owner',createdByUserId:owner})
  const {team:scope}=await r.createTeamWithCreator(relay,{organizationId:organization.organization_id,name:'Joint source target',createdByUserId:owner})
  await relay.query(`INSERT INTO extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,event_filter,start_policy)
   VALUES($1,'pocketctl-memory','team',$2,'active','{}','{}','{memory.manage,memory.search}','{}','from_now')`,[target,scope.team_id])
  await relay.query('INSERT INTO collaboration_sessions(team_session_id,team_id,creator_user_id,title) VALUES($1,$2,$3,\'Joint source session\')',[session,team.id,owner])
  for(const user of [owner,reader])await relay.query('INSERT INTO collaboration_session_participants(participant_id,team_session_id,user_id,added_by_user_id) VALUES($1,$2,$3,$4)',['csp_'+key+'_'+user,session,user,owner])
  await relay.query("INSERT INTO daemons(daemon_id,hostname,agents,status,user_id) VALUES($1,'isolated','[]','online',$2)",['daemon_'+key,owner])
  await relay.query("INSERT INTO team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider) VALUES($1,$2,$3,$4,'codex')",[offer,team.id,owner,'daemon_'+key])
  await relay.query('INSERT INTO collaboration_session_agent_bindings(binding_id,team_session_id,offer_id,owner_user_id) VALUES($1,$2,$3,$4)',[agentBinding,session,offer,owner])
  const bindings=new r.TeamMemoryBindingService(relay,new r.ExtensionInstallationRepository(relay),r.createV2GrantService({pool:relay,issuer,v2Mode:'enabled',grantKeys}),{memoryBridgeEnabled:true,memorySources:sources})
  const binding=await bindings.bind({teamId:team.id,actorUserId:owner,installationId:target,expectedRevision:0,requestId:'initial-binding'})
  await memory.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[personal])
  await memory.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)",[personal])
  await memory.query("INSERT INTO memory_feature_settings(installation_id,extraction_mode) VALUES($1,'enabled')",[personal])
  const token=r.signProviderExtensionToken({providerId:'pocketctl-memory',credentialId:'isolated-fixture',secret:providerSecret,issuer})
  const feed=createFeedClient({http:createRelayHttpClient({baseUrl,timeoutMs:5000,maxRetries:0}),tokens:{get:async()=>token,invalidate:()=>{}}})
  const sessions=new r.TeamSessionService(relay,{},sources)
  return {key,personal,target,scope,owner,reader,team,membership,session,offer,agentBinding,sources,teams,bindings,binding,sessions,feed}
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>
 async function completed(f:Fixture,label:string){
  const call='ccl_'+randomUUID(),client=await relay.connect(),reply='Task07 original reply '+label
  try{
   await client.query('BEGIN')
   const seq=Number((await client.query('SELECT latest_event_seq FROM collaboration_sessions WHERE team_session_id=$1 FOR UPDATE',[f.session])).rows[0].latest_event_seq)
   await client.query("INSERT INTO collaboration_events(event_id,team_session_id,event_seq,kind,author_user_id,context_version,content) VALUES($1,$2,$3,'member_message',$4,0,$5)",[call+'_goal',f.session,seq+1,f.owner,'Task07 goal '+label])
   await client.query("INSERT INTO collaboration_calls(call_id,team_session_id,event_id,offer_id,binding_id,context_version,state) VALUES($1,$2,$3,$4,$5,0,'completed')",[call,f.session,call+'_goal',f.offer,f.agentBinding])
   await client.query("INSERT INTO collaboration_events(event_id,team_session_id,event_seq,kind,author_offer_id,call_id,content) VALUES($1,$2,$3,'agent_message',$4,$5,$6),($7,$2,$8,'status',$4,$5,'completed')",[call+'_reply',f.session,seq+2,f.offer,call,reply,call+'_done',seq+3])
   await client.query('UPDATE collaboration_sessions SET latest_event_seq=$2 WHERE team_session_id=$1',[f.session,seq+3])
   const outcome={id:call+'_done',team_session_id:f.session,event_seq:seq+3,kind:'status',author_user_id:null,author_offer_id:f.offer,target_mode:null,target_offer_ids:[],reference:null,context_version:null,call_id:call,content:'completed',created_at:new Date().toISOString()}
   expect(await f.sources.projectCompletedCall(client,call,outcome)).toBe(3)
   const packet=(await client.query('SELECT session_id,payload FROM extension_source_outbox WHERE owner_user_id=$1 AND payload->>\'team_call_id\'=$2 ORDER BY source_seq',[f.reader,call])).rows
   expect(packet).toHaveLength(3);await client.query('COMMIT')
   return {call,reply,sourceSession:String(packet[0].session_id),packet}
  }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
 }
 async function deliver(f:Fixture,options:{ackLost?:boolean;pool?:pg.Pool;project?:boolean}={}){
  await r.projectFeedBatch(relay,{batchSize:100})
  const errors:unknown[]=[]
  const consumer=createFeedConsumer({pool:options.pool??memory,pullFeed:f.feed.pullFeed,ackFeed:async input=>{
   if(options.ackLost)throw new Error('isolated lost ACK before Relay receives it')
   return f.feed.ackFeed(input)
  },workerId:'joint-worker',signal:new AbortController().signal,onError:error=>{errors.push(error)}})
  await consumer.runOnce()
  if(options.project!==false){
   // This finite driver dispatches only Feed work. Compilation/extraction is
   // exercised explicitly below; no native/model worker is started.
   await memory.query("UPDATE memory_jobs SET available_at=clock_timestamp()+interval '1 day' WHERE job_type<>'project_feed' AND state='pending'")
   const jobs=createJobRepository(memory),handler=createProjectionHandler(memory,{stabilizationMs:0,purge:createPurgeRepository(memory,{hmacKey:'isolated-task07-purge'})})
   const claims=await jobs.claimJobs({workerId:'joint-projector',limit:32,leaseMs:30000})
   for(const claim of claims){
    expect(claim.job_type).toBe('project_feed')
    await handler.handleProjectFeed(claim,new AbortController().signal)
    expect(await jobs.completeJob({jobId:claim.job_id,claimedBy:'joint-projector',claimEpoch:claim.claim_epoch})).toBe(true)
   }
  }
  return errors
 }
 async function counts(f:Fixture){
  return (await memory.query(`SELECT (SELECT count(*)::int FROM source_events WHERE installation_id=$1) AS events,
   (SELECT count(*)::int FROM memory_candidates WHERE installation_id=$1) AS candidates,
   (SELECT count(*)::int FROM knowledge_claims WHERE installation_id=$1 AND state='active') AS accepted`,[f.personal])).rows[0]
 }
 async function extractAndAccept(f:Fixture,call:string){
  const turn='team-call:'+call
  await createEpisodeRepository(memory,{stabilizationMs:0,extractionDebounceMs:0}).compileTurn(f.personal,turn)
  const episode=(await memory.query('SELECT evidence_manifest FROM work_episodes WHERE installation_id=$1 AND turn_id=$2',[f.personal,turn])).rows[0]
  const handle=Object.keys(episode.evidence_manifest).find(k=>episode.evidence_manifest[k].source_provenance?.team_event_ids?.includes(call+'_reply'))
  expect(handle).toBeTruthy()
  const extractor=createCandidateExtractor({store:createExtractionRepository(memory),deduper:createCandidateDeduper(memory),provider:'fixture',model:'joint-source',timeoutMs:5000,textGenerator:{generateJson:(async()=>({ok:true,value:{candidates:[
   {claim_type:'bug_root_cause',statement:'Task07 retained user accepted fact',confidence:0.9,scope_kind:'installation',scope_key:'global',evidence_handles:[handle]},
   {claim_type:'test_invariant',statement:'Task07 unaccepted source dependent fact',confidence:0.8,scope_kind:'installation',scope_key:'global',evidence_handles:[handle]},
  ]},usage:{inputTokens:1,outputTokens:1,model:'joint-source'}})) as never}})
  expect(await extractor.extract({installationId:f.personal,turnId:turn,signal:new AbortController().signal})).toMatchObject({kind:'succeeded',candidateCount:2})
  const candidate=(await memory.query('SELECT candidate_id,revision::int FROM memory_candidates WHERE installation_id=$1 ORDER BY ordinal LIMIT 1',[f.personal])).rows[0]
  expect(await createClaimRepository(memory).acceptCandidate({installationId:f.personal,candidateId:candidate.candidate_id,expectedRevision:candidate.revision})).toMatchObject({ok:true})
 }
 for(const action of ['leave','remove','dissolve'] as const){
  test(`${action} reaches the real personal installation and removes raw/unaccepted content while retaining accepted provenance`,async()=>{
   const f=await fixture(),old=await completed(f,action)
   expect(f.personal).not.toBe(f.target);expect(f.team.id).not.toBe(f.target)
   expect(await deliver(f)).toEqual([]);expect(await counts(f)).toMatchObject({events:3,accepted:0})
   await extractAndAccept(f,old.call)
   const retained=await memory.query(`SELECT e.evidence_id,e.capsule_id,e.excerpt,e.excerpt_hash,c.retention_basis,c.source_content_hash
    FROM knowledge_evidence e JOIN knowledge_evidence_capsules c USING(installation_id,capsule_id) WHERE e.installation_id=$1`,[f.personal])
   expect(retained.rows).toHaveLength(1)
   const input={teamId:f.team.id,actorUserId:action==='leave'?f.reader:f.owner,expectedRevision:1,requestId:action}
   if(action==='leave')await f.teams.leaveTeam(input)
   else if(action==='remove')await f.teams.removeMember({...input,membershipId:f.membership})
   else await f.teams.dissolveTeam(input)
   expect(await deliver(f)).toEqual([])
   expect(await counts(f)).toEqual({events:0,candidates:0,accepted:1})
   expect((await memory.query('SELECT 1 FROM source_sessions WHERE installation_id=$1 AND deleted_at IS NULL',[f.personal])).rowCount).toBe(0)
   expect((await memory.query('SELECT 1 FROM memory_feed_inbox WHERE installation_id=$1 AND data::text LIKE $2',[f.personal,'%'+old.reply+'%'])).rowCount).toBe(0)
   const evidence=(await memory.query('SELECT evidence_kind,locator FROM knowledge_evidence WHERE installation_id=$1',[f.personal])).rows[0]
   expect(evidence.evidence_kind).toBe('accepted_excerpt')
   expect((await memory.query(`SELECT e.evidence_id,e.capsule_id,e.excerpt,e.excerpt_hash,c.retention_basis,c.source_content_hash
    FROM knowledge_evidence e JOIN knowledge_evidence_capsules c USING(installation_id,capsule_id) WHERE e.installation_id=$1`,[f.personal])).rows).toEqual(retained.rows)
   expect(evidence.locator.source_provenance.read_scope).toMatchObject({team_memory_binding_id:f.binding.id,participant_revision:1,target_installation_id:f.target})
   expect((await memory.query('SELECT 1 FROM knowledge_claims WHERE installation_id=$1',[f.target])).rowCount).toBe(0)
  },15000)
 }
 test('participant re-entry projects a new generation before delayed old revocation, and old raw Feed replay stays empty',async()=>{
  const f=await fixture(),old=await completed(f,'old-participant'),legacy=await completed(f,'legacy-participant')
  // Bridge fixture for the documented pre-binding-ID producer identity. Only
  // the Journal subject differs; actual envelopes/HTTP delivery remain real.
  const legacyId='team_'+createHash('sha256').update(`${f.session}:1:1`).digest('hex').slice(0,32)
  await relay.query("UPDATE extension_source_outbox SET session_id=$1 WHERE payload->>'team_call_id'=$2",[legacyId,legacy.call])
  expect(await deliver(f)).toEqual([]);expect(await counts(f)).toMatchObject({events:6})
  await f.sessions.removeParticipant({sessionId:f.session,actorUserId:f.owner,userId:f.reader,expectedRevision:1,requestId:'remove-reader'})
  await f.sessions.addParticipant({sessionId:f.session,actorUserId:f.owner,userId:f.reader,expectedRevision:2,requestId:'rejoin-reader'})
  const fresh=await completed(f,'fresh-participant');expect(fresh.sourceSession).not.toBe(old.sourceSession)
  // Prior content is ACKed. Reorder pending Journal allocations to make the new
  // source arrive before its old-generation revoke, as independent workers can.
  await relay.query("UPDATE extension_source_outbox SET source_seq=nextval(pg_get_serial_sequence('extension_source_outbox','source_seq')) WHERE source_kind='session_access_revoked'")
  expect(await deliver(f)).toEqual([])
  expect((await memory.query('SELECT DISTINCT session_id FROM source_events WHERE installation_id=$1',[f.personal])).rows).toEqual([{session_id:fresh.sourceSession}])
  // Simulate checkpoint recovery/redelivery of the unchanged retained stream,
  // using real signed cursors, leases, HTTP, inbox hash checks and queued work.
  await relay.query('UPDATE extension_checkpoints SET ack_feed_id=0,lease_expires_at=NULL WHERE installation_id=$1',[f.personal])
  const replay=await f.feed.pullFeed(f.personal,100)
  expect(replay.items.filter(item=>item.topic==='session.event.v1'&&[old.sourceSession,legacyId].includes(item.subject.session_id!))).toHaveLength(6)
  expect(await deliver(f)).toEqual([])
  const last=(await memory.query('SELECT last_feed_id::text AS id FROM memory_installations WHERE installation_id=$1',[f.personal])).rows[0].id
  const rearmed=(await memory.query("SELECT state,claim_epoch::int FROM memory_jobs WHERE installation_id=$1 AND job_type='project_feed' AND idempotency_key=$2",[f.personal,`project:${f.personal}:${last}`])).rows[0]
  expect(rearmed.state).toBe('completed');expect(rearmed.claim_epoch).toBeGreaterThanOrEqual(2)
  const rows=(await memory.query('SELECT data,classification,projection_state FROM memory_feed_inbox WHERE installation_id=$1 AND session_id=ANY($2::text[]) ORDER BY feed_id',[f.personal,[old.sourceSession,legacyId]])).rows
  // A replayed revoke may erase the already redacted rows again. Neither
  // serialization outcome may retain old bodies or recreate an old source.
  for(const row of rows)expect(row).toEqual({data:{},classification:{},projection_state:'purged'})
  expect((await memory.query('SELECT DISTINCT session_id FROM source_events WHERE installation_id=$1',[f.personal])).rows).toEqual([{session_id:fresh.sourceSession}])
 },15000)
 for(const withdrawn of [false,true]){
  test(`${withdrawn?'withdrawn capture configuration':'event-only subscription'} still receives mandatory Team cleanup without source bodies`,async()=>{
   const f=await fixture()
   await relay.query("UPDATE extension_installations SET subscriptions='{session.event.v1}',granted_scopes='{session:events:read}' WHERE installation_id=$1",[f.personal])
   const old=await completed(f,'content-topic-control');expect(await deliver(f)).toEqual([])
   if(withdrawn)await relay.query("UPDATE extension_installations SET subscriptions='{}',granted_scopes='{}',config_version=config_version+1 WHERE installation_id=$1",[f.personal])
   await f.teams.leaveTeam({teamId:f.team.id,actorUserId:f.reader,expectedRevision:1,requestId:'mandatory-control'})
   await r.projectFeedBatch(relay,{batchSize:100})
   const batch=await f.feed.pullFeed(f.personal,100)
   expect(batch.items).toHaveLength(2)
   expect(batch.items.every(item=>item.topic==='session.access.revoked.v1')).toBe(true)
   expect(JSON.stringify(batch.items)).not.toContain(old.reply)
   expect(await deliver(f)).toEqual([]);expect(await counts(f)).toEqual({events:0,candidates:0,accepted:0})
  },15000)
 }
 test('paused personal installation receives durable cleanup after resume',async()=>{
  const f=await fixture();await completed(f,'paused');expect(await deliver(f)).toEqual([])
  await relay.query("UPDATE extension_installations SET status='paused' WHERE installation_id=$1",[f.personal])
  await f.teams.leaveTeam({teamId:f.team.id,actorUserId:f.reader,expectedRevision:1,requestId:'paused-leave'})
  expect((await relay.query("SELECT 1 FROM extension_source_outbox WHERE source_kind='session_access_revoked' AND owner_user_id=$1",[f.reader])).rowCount).toBe(2)
  await expect(f.feed.pullFeed(f.personal,100)).rejects.toMatchObject({code:'installation_paused'})
  await relay.query("UPDATE extension_installations SET status='active' WHERE installation_id=$1",[f.personal])
  expect(await deliver(f)).toEqual([]);expect(await counts(f)).toEqual({events:0,candidates:0,accepted:0})
 },15000)
 test('binding replacement commits old cleanup and its delayed delivery cannot delete the new target generation',async()=>{
  const f=await fixture(),old=await completed(f,'old-binding');expect(await deliver(f)).toEqual([])
  const nextTarget=randomUUID(),{team:nextScope}=await r.createTeamWithCreator(relay,{organizationId:f.scope.organization_id,name:'Replacement target',createdByUserId:f.owner})
  await relay.query(`INSERT INTO extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,event_filter,start_policy)
   VALUES($1,'pocketctl-memory','team',$2,'active','{}','{}','{memory.manage,memory.search}','{}','from_now')`,[nextTarget,nextScope.team_id])
  const replacement=await f.bindings.bind({teamId:f.team.id,actorUserId:f.owner,installationId:nextTarget,expectedRevision:1,requestId:'replace-binding'})
  expect(replacement.id).not.toBe(f.binding.id)
  const fresh=await completed(f,'new-binding');expect(fresh.sourceSession).not.toBe(old.sourceSession)
  await relay.query("UPDATE extension_source_outbox SET source_seq=nextval(pg_get_serial_sequence('extension_source_outbox','source_seq')) WHERE source_kind='session_access_revoked'")
  expect(await deliver(f)).toEqual([])
  expect((await memory.query('SELECT DISTINCT session_id FROM source_events WHERE installation_id=$1',[f.personal])).rows).toEqual([{session_id:fresh.sourceSession}])
  expect((await memory.query("SELECT payload->'team_source'->'read_scope' AS scope FROM source_events WHERE installation_id=$1 AND event_type='agent_text'",[f.personal])).rows[0].scope)
   .toMatchObject({team_memory_binding_id:replacement.id,team_memory_binding_revision:2,target_installation_id:nextTarget})
 },15000)
 test('capture off continues to deliver privacy cleanup for a previously captured source',async()=>{
  const f=await fixture();await completed(f,'capture-off');expect(await deliver(f)).toEqual([])
  await new r.TeamRepository(relay,new r.TeamMemorySourceProjector(false)).leaveTeam({teamId:f.team.id,actorUserId:f.reader,expectedRevision:1,requestId:'capture-off-leave'})
  expect(await deliver(f)).toEqual([]);expect(await counts(f)).toEqual({events:0,candidates:0,accepted:0})
 },15000)
 test('lost ACK after Memory commit safely redelivers through the real Relay checkpoint',async()=>{
  const f=await fixture();await completed(f,'ack-loss')
  expect(await deliver(f,{ackLost:true,project:false})).toHaveLength(1)
  expect((await memory.query('SELECT 1 FROM memory_feed_inbox WHERE installation_id=$1',[f.personal])).rowCount).toBe(3)
  expect((await relay.query('SELECT ack_feed_id::int FROM extension_checkpoints WHERE installation_id=$1',[f.personal])).rows[0].ack_feed_id).toBe(0)
  expect(await deliver(f)).toEqual([]);expect(await counts(f)).toMatchObject({events:3})
  expect((await memory.query('SELECT 1 FROM memory_feed_inbox WHERE installation_id=$1',[f.personal])).rowCount).toBe(3)
  expect((await relay.query('SELECT ack_feed_id::int FROM extension_checkpoints WHERE installation_id=$1',[f.personal])).rows[0].ack_feed_id).toBeGreaterThan(0)
 },15000)
 test('Relay projection crash after Feed insert preserves Journal rows and retry creates one packet',async()=>{
  const f=await fixture();await completed(f,'relay-crash')
  let failed=false
  const wrapped={connect:async()=>{const client=await relay.connect();return new Proxy(client,{get(target,key){if(key==='query')return async(...args:unknown[])=>{
   const result=await Reflect.apply(target.query,target,args)
   if(!failed&&typeof args[0]==='string'&&args[0].includes('INSERT INTO extension_feed')){failed=true;throw new Error('isolated after Feed insert crash')}
   return result
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})}} as pg.Pool
  await expect(r.projectFeedBatch(wrapped,{batchSize:100})).rejects.toThrow('isolated after Feed insert crash')
  expect((await relay.query('SELECT 1 FROM extension_feed')).rowCount).toBe(0)
  expect((await relay.query('SELECT 1 FROM extension_source_outbox')).rowCount).toBe(3)
  expect(await deliver(f)).toEqual([]);expect(await counts(f)).toMatchObject({events:3})
  expect((await relay.query('SELECT 1 FROM extension_feed')).rowCount).toBe(3)
 },15000)
 test('Memory inbox transaction failure never ACKs Relay and restart admits one immutable packet',async()=>{
  const f=await fixture();await completed(f,'memory-crash');let failed=false
  const wrapped={query:memory.query.bind(memory),connect:async()=>{const client=await memory.connect();return new Proxy(client,{get(target,key){if(key==='query')return async(...args:unknown[])=>{
   const result=await Reflect.apply(target.query,target,args)
   if(!failed&&typeof args[0]==='string'&&args[0].includes('INSERT INTO memory_feed_inbox')){failed=true;throw new Error('isolated inbox transaction crash')}
   return result
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})}} as unknown as pg.Pool
  expect(await deliver(f,{pool:wrapped,project:false})).toHaveLength(1)
  expect((await memory.query('SELECT 1 FROM memory_feed_inbox WHERE installation_id=$1',[f.personal])).rowCount).toBe(0)
  expect((await relay.query('SELECT ack_feed_id::int FROM extension_checkpoints WHERE installation_id=$1',[f.personal])).rows[0].ack_feed_id).toBe(0)
  expect(await deliver(f)).toEqual([]);expect(await counts(f)).toMatchObject({events:3})
 },15000)
 test('revoke projection failure rolls back deletion and retry clears the actual retained source',async()=>{
  const f=await fixture();await completed(f,'projection-crash');expect(await deliver(f)).toEqual([])
  await f.teams.leaveTeam({teamId:f.team.id,actorUserId:f.reader,expectedRevision:1,requestId:'projector-crash-leave'})
  expect(await deliver(f,{project:false})).toEqual([])
  let failed=false
  const wrapped={query:memory.query.bind(memory),connect:async()=>{const client=await memory.connect();return new Proxy(client,{get(target,key){if(key==='query')return async(...args:unknown[])=>{
   const result=await Reflect.apply(target.query,target,args)
   if(!failed&&typeof args[0]==='string'&&args[0].includes('DELETE FROM source_events')){failed=true;throw new Error('isolated crash after source deletion')}
   return result
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})}} as unknown as pg.Pool
  const purge=createPurgeRepository(memory,{hmacKey:'isolated-task07-purge'})
  await expect(createSourceProjector(wrapped,{stabilizationMs:0,purge}).projectOnce(f.personal)).rejects.toThrow('isolated crash after source deletion')
  expect(await counts(f)).toMatchObject({events:3})
  await createSourceProjector(memory,{stabilizationMs:0,purge}).projectOnce(f.personal)
  expect(await counts(f)).toEqual({events:0,candidates:0,accepted:0})
 },15000)
})
