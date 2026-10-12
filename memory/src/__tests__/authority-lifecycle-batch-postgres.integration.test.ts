import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {gitExportFixture} from '../testing/phase6-export-fixture.js'
import {attestationFixture} from '../testing/phase6-attestation-fixture.js'
import {createGitExportService} from '../git-sync/export-service.js'
import {createPurgeRepository} from '../purge/repository.js'
import {createClaimRepository} from '../claims/repository.js'
import {createLifecycleService} from '../claims/lifecycle-service.js'
import {createSourceProjector} from '../projection/source-projector.js'
import {createAdmissionService} from '../context/admission-service.js'
import {createSharedClaimLifecycle,createPublicationService} from '../governance/publication-service.js'
import {createTransferService} from '../governance/transfer-service.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createReviewPolicyRepository,DEFAULT_ORGANIZATION_REVIEW_POLICY} from '../governance/review-policy.js'
import type {ValidatedV2Grant} from '../governance/authorization.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('lifecycle, source batches and privacy cleanup lock ownership',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:10});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_session_tombstones,memory_purge_receipts,memory_installations CASCADE')})
 afterAll(async()=>{await pool.end()})

 function hookPool(after:(sql:string,values:unknown[])=>Promise<void>,onPid?:(pid:number)=>void){
  return {query:pool.query.bind(pool),connect:async()=>{
   const client=await pool.connect();onPid?.((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
   return new Proxy(client,{get(target,key){
    if(key==='query')return async(...args:unknown[])=>{
     const result=await Reflect.apply(target.query,target,args)
     if(typeof args[0]==='string')await after(args[0],args[1] as unknown[]??[])
     return result
    }
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
   }})
  }} as unknown as pg.Pool
 }
 function barrier(){let reached!:()=>void,release!:()=>void;return {
  reached:new Promise<void>(r=>{reached=r}),allowed:new Promise<void>(r=>{release=r}),reach:()=>reached(),release:()=>release(),
 }}
 async function waitForBlock(pid:()=>number|undefined,finished:()=>boolean=()=>false){
  for(let i=0;i<150;i++){
   const id=pid()
   if(id&&(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[id])).rows[0].blocked)return true
   if(finished())return false
   await new Promise(r=>setTimeout(r,10))
  }
  throw new Error('transaction did not reach its expected PostgreSQL wait')
 }
 async function exported(){
  const f=await gitExportFixture(pool)
  await createGitExportService({pool,keys:attestationFixture().registry,
   skill:{context:f.skill.context,cases:f.skill.cases}}).export(f.grant,{installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',baseCommit:'c'.repeat(40),purpose:'external_export',assets:f.keys.filter(k=>k.kind==='rule')})
  return f
 }
 for(const order of ['purge_first','admission_first'] as const){
  test(`Context admission and Session cleanup keep source-first order (${order})`,async()=>{
   const f=await governanceFixture(pool),gate=barrier();let pid:number|undefined,finished=false,paused=false
   const hooked=hookPool(async sql=>{if(!paused&&sql.includes('pg_advisory_xact_lock')&&sql.includes(order==='purge_first'?'purge:session:':'purge:')){paused=true;gate.reach();await gate.allowed}})
   const following=hookPool(async()=>{},id=>{pid=id})
   const purge=(db:pg.Pool)=>createPurgeRepository(db,{hmacKey:'isolated-lifecycle'}).purgeSession({installationId:f.personal,sessionId:'transaction-fixture',reason:'user_deleted',sourceFeedId:null})
   const admit=(db:pg.Pool)=>createAdmissionService({pool:db,nonceHmacKey:Buffer.alloc(32,7)}).admit({installationId:f.personal,sessionId:'transaction-fixture',clientRequestId:randomUUID(),packId:randomUUID(),agent:'codex',adapter:'codex-app-server',grantConfigVersion:'1'})
   const first=order==='purge_first'?purge(hooked):admit(hooked)
   const firstOutcome=first.then(value=>({value}),error=>({error}));let second:Promise<unknown>|undefined
   try{
    await Promise.race([gate.reached,firstOutcome.then(r=>{throw 'error' in r?r.error:new Error('first lifecycle operation missed barrier')})])
    second=order==='purge_first'?admit(following):purge(following)
    const secondOutcome=second.then(value=>{finished=true;return {value}},error=>{finished=true;return {error}})
    expect(await waitForBlock(()=>pid,()=>finished)).toBe(true);gate.release()
    const firstResult=await firstOutcome,secondResult=await secondOutcome
    expect(order==='purge_first'?firstResult:secondResult).toMatchObject({value:1})
    expect(order==='purge_first'?secondResult:firstResult).toMatchObject({value:{ok:false,error:'pack_not_ready'}})
    expect((await pool.query('SELECT 1 FROM memory_context_injections WHERE installation_id=$1',[f.personal])).rowCount).toBe(0)
    expect((await pool.query('SELECT 1 FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rowCount).toBe(0)
   }finally{gate.release();await first.catch(()=>undefined);await second?.catch(()=>undefined)}
  },15000)
 }
 test('Session purge fences shared Claim revoke before Git invalidation',async()=>{
  const f=await exported(),gate=barrier();let pid:number|undefined,finished=false
  const purgePool=hookPool(async sql=>{if(sql.includes('INSERT INTO memory_session_tombstones')){gate.reach();await gate.allowed}})
  const actorPool=hookPool(async()=>{},id=>{pid=id})
  const purging=createPurgeRepository(purgePool,{hmacKey:'isolated-lifecycle'}).purgeSession({installationId:f.installationId,sessionId:'shared-governance',reason:'user_deleted',sourceFeedId:null})
  const purgeOutcome=purging.then(value=>({value}),error=>({error}));let revoking:Promise<unknown>|undefined
  try{
   await Promise.race([gate.reached,purgeOutcome.then(r=>{throw 'error' in r?r.error:new Error('purge missed barrier')})])
   revoking=createSharedClaimLifecycle(actorPool).revokeSharedClaim({grant:f.grant,targetInstallationId:f.installationId,claimId:f.rule.claimId,expectedRevision:1,reason:'user_revoke'})
   const revokeOutcome=revoking.then(value=>{finished=true;return {value}},error=>{finished=true;return {error}})
   expect(await waitForBlock(()=>pid,()=>finished)).toBe(true);gate.release()
   expect(await purgeOutcome).toHaveProperty('value')
   expect(await revokeOutcome).toMatchObject({error:{code:'not_found'}})
   expect((await pool.query('SELECT 1 FROM knowledge_claims WHERE claim_id=$1',[f.rule.claimId])).rowCount).toBe(0)
   expect((await pool.query('SELECT 1 FROM memory_git_snapshots')).rowCount).toBe(0)
  }finally{gate.release();await purging.catch(()=>undefined);await revoking?.catch(()=>undefined)}
 },15000)

 for(const kind of ['transition','supersede','expiry_sweep'] as const){
  test(`installation purge fences ${kind} before Claim/outbox locks`,async()=>{
   const f=await exported(),gate=barrier();let pid:number|undefined,finished=false,paused=false
   if(kind==='expiry_sweep')await pool.query('UPDATE knowledge_versions SET valid_until=clock_timestamp()-interval \'1 day\' WHERE version_id=$1',[f.rule.versionId])
   // The expiry update invalidates the old export; obtain a fresh local projection
   // using a different live source so the installation purge still owns Git.
   if(kind==='expiry_sweep')await createGitExportService({pool,keys:attestationFixture().registry,
    skill:{context:f.skill.context,cases:f.skill.cases}}).export(f.grant,{installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'2',baseCommit:'c'.repeat(40),purpose:'local_preview',assets:f.keys.filter(k=>k.kind==='claim')})
   const purgePool=hookPool(async sql=>{if(!paused&&sql.includes('DELETE FROM memory_wikis')){paused=true;gate.reach();await gate.allowed}})
   const actorPool=hookPool(async()=>{},id=>{pid=id}),claims=createClaimRepository(actorPool)
   const purging=createPurgeRepository(purgePool,{hmacKey:'isolated-lifecycle'}).purgeInstallation({installationId:f.installationId,requestId:randomUUID(),reason:'user_deleted'})
   const purgeOutcome=purging.then(value=>({value}),error=>({error}));let mutating:Promise<unknown>|undefined
   try{
    await Promise.race([gate.reached,purgeOutcome.then(r=>{throw 'error' in r?r.error:new Error('purge missed barrier')})])
    mutating=kind==='transition'?claims.transitionClaim({installationId:f.installationId,claimId:f.rule.claimId,target:'revoked',expectedRevision:1})
     :kind==='supersede'?claims.supersedeClaim({installationId:f.installationId,claimId:f.rule.claimId,supersededByClaimId:f.keys.find(k=>k.kind==='claim')!.id,expectedRevision:1})
     :createLifecycleService(actorPool,claims).expireDueClaims()
    const outcome=mutating.then(value=>{finished=true;return {value}},error=>{finished=true;return {error}})
    await waitForBlock(()=>pid,()=>finished);gate.release()
    expect(await purgeOutcome).toHaveProperty('value')
    if(kind==='expiry_sweep')expect(await outcome).toEqual({value:0})
    else expect(await outcome).toEqual({value:{ok:false,error:{code:'claim_not_found'}}})
    expect((await pool.query('SELECT 1 FROM knowledge_claims WHERE installation_id=$1',[f.installationId])).rowCount).toBe(0)
    expect((await pool.query('SELECT 1 FROM memory_feedback WHERE installation_id=$1',[f.installationId])).rowCount).toBe(0)
   }finally{gate.release();await purging.catch(()=>undefined);await mutating?.catch(()=>undefined)}
  },15000)
 }

 test('a winning Claim transition commits before installation cleanup removes its feedback and copies',async()=>{
  const f=await exported(),gate=barrier();let pid:number|undefined,finished=false
  const actorPool=hookPool(async sql=>{if(sql.includes('FROM knowledge_claims')&&sql.includes('FOR UPDATE')){gate.reach();await gate.allowed}})
  const purgePool=hookPool(async()=>{},id=>{pid=id})
  const changing=createClaimRepository(actorPool).transitionClaim({installationId:f.installationId,claimId:f.rule.claimId,target:'revoked',expectedRevision:1})
  const changeOutcome=changing.then(value=>({value}),error=>({error}));let purging:Promise<unknown>|undefined
  try{
   await Promise.race([gate.reached,changeOutcome.then(r=>{throw 'error' in r?r.error:new Error('transition missed barrier')})])
   purging=createPurgeRepository(purgePool,{hmacKey:'isolated-lifecycle'}).purgeInstallation({installationId:f.installationId,requestId:randomUUID(),reason:'user_deleted'})
   const purgeOutcome=purging.then(value=>{finished=true;return {value}},error=>{finished=true;return {error}})
   expect(await waitForBlock(()=>pid,()=>finished)).toBe(true);gate.release()
   expect(await changeOutcome).toEqual({value:{ok:true}})
   expect(await purgeOutcome).toHaveProperty('value')
   for(const table of ['knowledge_claims','memory_feedback','memory_git_snapshots'])expect((await pool.query(`SELECT 1 FROM ${table} WHERE installation_id=$1`,[f.installationId])).rowCount).toBe(0)
  }finally{gate.release();await changing.catch(()=>undefined);await purging?.catch(()=>undefined)}
 },15000)

 test('expiry batch rechecks a source deadline changed while waiting for its installation fence',async()=>{
  const f=await governanceFixture(pool),gate=barrier()
  await pool.query('UPDATE knowledge_versions SET valid_until=clock_timestamp()-interval \'1 day\' WHERE version_id=$1',[f.version])
  const blocker=await pool.connect();await blocker.query('BEGIN')
  await blocker.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:' || $1,0))`,[f.personal])
  const observedPool=hookPool(async sql=>{if(sql.includes('FROM knowledge_claims')&&sql.includes('LIMIT 500'))gate.reach()})
  const expiry=createLifecycleService(observedPool,createClaimRepository(observedPool)).expireDueClaims()
  const outcome=expiry.then(value=>({value}),error=>({error}))
  try{
   await Promise.race([gate.reached,outcome.then(r=>{throw 'error' in r?r.error:new Error('expiry missed discovery')})])
   await blocker.query('UPDATE knowledge_versions SET valid_until=clock_timestamp()+interval \'1 day\' WHERE version_id=$1',[f.version]);await blocker.query('COMMIT')
   expect(await outcome).toEqual({value:0})
   expect((await pool.query('SELECT state,revision::int FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rows[0]).toEqual({state:'active',revision:1})
   expect((await pool.query("SELECT 1 FROM memory_feedback WHERE action='claim_expired'")).rowCount).toBe(0)
  }finally{await blocker.query('ROLLBACK');blocker.release();await expiry.catch(()=>undefined)}
 },15000)

 test('bulk transfer uses the serialized policy initializer after a competing first-head write',async()=>{
  const t=await transferFixture(),gate=barrier();let pid:number|undefined,finished=false
  await pool.query('INSERT INTO memory_review_policy_sets(policy_id,installation_id) VALUES($1,$2)',[randomUUID(),t.org])
  const initializerPool=hookPool(async sql=>{if(sql.includes('SELECT policy_id::text FROM memory_review_policy_sets')&&sql.includes('FOR UPDATE')){gate.reach();await gate.allowed}})
  const transferPool=hookPool(async()=>{},id=>{pid=id})
  const initializing=createReviewPolicyRepository(initializerPool).ensurePolicySet(t.org,DEFAULT_ORGANIZATION_REVIEW_POLICY)
  const initializationOutcome=initializing.then(value=>({value}),error=>({error}));let transferring:Promise<unknown>|undefined
  try{
   await Promise.race([gate.reached,initializationOutcome.then(r=>{throw 'error' in r?r.error:new Error('initializer missed barrier')})])
   transferring=createTransferService(transferPool).startTeamTransfer(t.input)
   const outcome=transferring.then(value=>{finished=true;return {value}},error=>{finished=true;return {error}})
   expect(await waitForBlock(()=>pid,()=>finished)).toBe(true);gate.release()
   const initialized=await initializationOutcome;expect(initialized).toHaveProperty('value.policyVersionId')
   expect(await outcome).toMatchObject({value:{candidates:1}})
   expect((await pool.query('SELECT review_policy_version_id FROM memory_promotion_candidate_versions v JOIN memory_promotion_candidates c USING(candidate_id) WHERE c.target_installation_id=$1',[t.org])).rows[0].review_policy_version_id).toBe('value' in initialized?initialized.value.policyVersionId:null)
   expect((await pool.query('SELECT 1 FROM memory_review_policy_versions v JOIN memory_review_policy_sets s USING(policy_id) WHERE s.installation_id=$1',[t.org])).rowCount).toBe(1)
  }finally{gate.release();await initializing.catch(()=>undefined);await transferring?.catch(()=>undefined)}
 },15000)

 test('bulk transfer rejects a newly discovered legacy source session and a fresh ordered retry succeeds',async()=>{
  const t=await transferFixture(),gate=barrier();let paused=false
  const episode=randomUUID()
  await pool.query("INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) VALUES($1,$2,'legacy-new-session','legacy-new-turn','ready','fixture')",[t.f.team,episode])
  const hooked=hookPool(async sql=>{if(!paused&&sql.includes('SELECT installation_id FROM memory_owner_scopes')&&sql.includes('FOR SHARE')){paused=true;gate.reach();await gate.allowed}})
  const transferring=createTransferService(hooked).startTeamTransfer(t.input)
  const outcome=transferring.then(value=>({value}),error=>({error}))
  try{
   await Promise.race([gate.reached,outcome.then(r=>{throw 'error' in r?r.error:new Error('transfer missed source discovery barrier')})])
   // Bridge-compatible direct writer changes provenance after discovery. It
   // deliberately bypasses the new Session fence; the current attempt must CAS.
   await pool.query('UPDATE knowledge_evidence SET episode_id=$2 WHERE installation_id=$1 AND version_id=$3',[t.f.team,episode,t.published.versionId]);gate.release()
   expect(await outcome).toMatchObject({error:{code:'conflict'}})
   expect((await pool.query('SELECT 1 FROM memory_transfer_runs')).rowCount).toBe(0)
   expect((await pool.query('SELECT 1 FROM memory_promotion_candidates WHERE target_installation_id=$1',[t.org])).rowCount).toBe(0)
   expect(await createTransferService(pool).startTeamTransfer(t.input)).toMatchObject({candidates:1})
   expect((await pool.query('SELECT 1 FROM memory_promotion_evidence e JOIN memory_promotion_candidate_versions v USING(candidate_revision_id) JOIN memory_promotion_candidates c USING(candidate_id) WHERE c.target_installation_id=$1',[t.org])).rowCount).toBe(1)
  }finally{gate.release();await transferring.catch(()=>undefined)}
 },15000)

 test('projection retries a changed multi-Session inbox batch without taking a late source lock',async()=>{
  const f=await governanceFixture(pool),gate=barrier();let paused=false
  async function insert(feedId:number,session:string){await pool.query(`INSERT INTO memory_feed_inbox(installation_id,feed_id,envelope_version,topic,source_kind,source_id,
    session_id,event_type,recorded_at,classification,data,payload_hash)
    VALUES($1,$2,1,'session.deleted.v1','session',$3,$3,'deleted',NOW(),'{}','{}',sha256(convert_to('{}','utf8')))`,[f.personal,feedId,session])}
  await insert(2,'second-session')
  const hooked=hookPool(async sql=>{if(!paused&&sql.includes('FROM memory_feed_inbox')&&!sql.includes('FOR UPDATE')){paused=true;gate.reach();await gate.allowed}})
  const projecting=createSourceProjector(hooked,{purge:createPurgeRepository(hooked,{hmacKey:'isolated-lifecycle'})}).projectOnce(f.personal)
  const outcome=projecting.then(value=>({value}),error=>({error}))
  try{
   await Promise.race([gate.reached,outcome.then(r=>{throw 'error' in r?r.error:new Error('projector missed discovery barrier')})])
   await insert(1,'first-session');gate.release()
   expect(await outcome).toMatchObject({error:{message:'projection_source_changed'}})
   expect((await pool.query("SELECT 1 FROM memory_feed_inbox WHERE projection_state='pending'")).rowCount).toBe(2)
   expect((await pool.query('SELECT 1 FROM memory_session_tombstones')).rowCount).toBe(0)
   expect(await createSourceProjector(pool,{purge:createPurgeRepository(pool,{hmacKey:'isolated-lifecycle'})}).projectOnce(f.personal)).toEqual({projected:2})
   expect((await pool.query('SELECT session_id FROM memory_session_tombstones ORDER BY session_id')).rows).toEqual([{session_id:'first-session'},{session_id:'second-session'}])
  }finally{gate.release();await projecting.catch(()=>undefined)}
 },15000)

 async function transferFixture(){
  const f=await governanceFixture(pool),p=await f.approved()
  const published=await createPublicationService(pool).publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:p.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})
  const org=randomUUID(),member=randomUUID()
  await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[org])
  await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'organization',$1)",[org])
  await pool.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles) VALUES($1,$2,ARRAY['scope_administrator'])",[org,member])
  await pool.query("UPDATE memory_owner_scopes SET state='dissolving',parent_organization_id=$2 WHERE installation_id=$1",[f.team,org])
  const grant:ValidatedV2Grant={primaryInstallationId:org,configVersion:'1',scopeBindings:[
   {installation_id:f.team,owner_scope_kind:'team',owner_scope_id:f.team,membership_id:f.publisher,membership_revision:'1',authorization_epoch:'1',permissions:['read','scope_admin']},
   {installation_id:org,owner_scope_kind:'organization',owner_scope_id:org,membership_id:member,membership_revision:'1',authorization_epoch:'1',permissions:['read','scope_admin']},
  ]}
  return {f,org,grant,published,input:{grant,sourceInstallationId:f.team,targetInstallationId:org,expectedAuthorizationEpoch:1}}
 }
 test('deletion projection joins lifecycle fences before claiming its inbox batch',async()=>{
  const f=await exported(),gate=barrier();let pid:number|undefined,finished=false,paused=false
  await pool.query(`INSERT INTO memory_feed_inbox(installation_id,feed_id,envelope_version,topic,source_kind,source_id,
    session_id,event_type,recorded_at,classification,data,payload_hash)
    VALUES($1,1,1,'session.deleted.v1','session','shared-governance','shared-governance','deleted',NOW(),'{}','{}',sha256(convert_to('{}','utf8')))`,[f.installationId])
  const purgePool=hookPool(async sql=>{if(!paused&&sql.includes('DELETE FROM memory_wikis')){paused=true;gate.reach();await gate.allowed}})
  const projectorPool=hookPool(async()=>{},id=>{pid=id})
  const purging=createPurgeRepository(purgePool,{hmacKey:'isolated-lifecycle'}).purgeInstallation({installationId:f.installationId,requestId:randomUUID(),reason:'user_deleted'})
  const purgeOutcome=purging.then(value=>({value}),error=>({error}));let projecting:Promise<unknown>|undefined
  try{
   await Promise.race([gate.reached,purgeOutcome.then(r=>{throw 'error' in r?r.error:new Error('purge missed barrier')})])
   projecting=createSourceProjector(projectorPool,{purge:createPurgeRepository(projectorPool,{hmacKey:'isolated-lifecycle'})}).projectOnce(f.installationId)
   const outcome=projecting.then(value=>{finished=true;return {value}},error=>{finished=true;return {error}})
   expect(await waitForBlock(()=>pid,()=>finished)).toBe(true);gate.release()
   expect(await purgeOutcome).toHaveProperty('value')
   expect(await outcome).toEqual({value:{projected:0}})
   expect((await pool.query('SELECT 1 FROM memory_feed_inbox')).rowCount).toBe(0)
  }finally{gate.release();await purging.catch(()=>undefined);await projecting?.catch(()=>undefined)}
 },15000)
 test('bulk Team transfer waits for a winning source revoke and copies no stale Claim',async()=>{
  const t=await transferFixture(),gate=barrier();let pid:number|undefined,finished=false
  const actorPool=hookPool(async sql=>{if(sql.includes('FROM knowledge_claims')&&sql.includes('FOR UPDATE')){gate.reach();await gate.allowed}})
  const transferPool=hookPool(async()=>{},id=>{pid=id})
  const revoking=createClaimRepository(actorPool).transitionClaim({installationId:t.f.team,claimId:t.published.claimId,target:'revoked',expectedRevision:1})
  const revokeOutcome=revoking.then(value=>({value}),error=>({error}));let transferring:Promise<unknown>|undefined
  try{
   await Promise.race([gate.reached,revokeOutcome.then(r=>{throw 'error' in r?r.error:new Error('revoke missed barrier')})])
   transferring=createTransferService(transferPool).startTeamTransfer(t.input)
   const transferOutcome=transferring.then(value=>{finished=true;return {value}},error=>{finished=true;return {error}})
   const blocked=await waitForBlock(()=>pid,()=>finished);gate.release()
   expect(await revokeOutcome).toEqual({value:{ok:true}})
   expect(await transferOutcome).toMatchObject({value:{candidates:0}})
   expect(blocked,'transfer must fence its source before copying').toBe(true)
   expect((await pool.query('SELECT 1 FROM memory_promotion_candidates WHERE target_installation_id=$1',[t.org])).rowCount).toBe(0)
  }finally{gate.release();await revoking.catch(()=>undefined);await transferring?.catch(()=>undefined)}
 },15000)
})
