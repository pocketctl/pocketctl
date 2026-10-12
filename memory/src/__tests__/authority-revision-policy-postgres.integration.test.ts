import pg from 'pg'
import Fastify from 'fastify'
import {registerGovernanceRoutes} from '../api/governance-routes.js'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createPromotionRepository} from '../governance/promotion-repository.js'
import {createPromotionService} from '../governance/promotion-service.js'
import {createPublicationService} from '../governance/publication-service.js'
import {createReviewPolicyRepository,DEFAULT_TEAM_REVIEW_POLICY} from '../governance/review-policy.js'
import type {ValidatedV2Grant} from '../governance/authorization.js'
import {createSourceRepository} from '../codegraph/source-repository.js'
import {createPurgeRepository} from '../purge/repository.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('revision source authority and policy bootstrap transactions',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:8});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool.end()})

 async function waitForBlock(pid:()=>number|undefined,finished:()=>boolean=()=>false){
  for(let attempt=0;attempt<100;attempt++){
   const id=pid()
   if(id&&(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[id])).rows[0].blocked)return
   if(finished())throw new Error('transaction finished before the expected database wait')
   await new Promise(resolve=>setTimeout(resolve,10))
  }
  throw new Error('transaction never reached the expected database wait')
 }
 function hookPool(after:(sql:string)=>Promise<void>){
  return {query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();return new Proxy(client,{get(target,key){
   if(key==='query')return async(...args:unknown[])=>{
    const result=await Reflect.apply(target.query,target,args)
    if(typeof args[0]==='string')await after(args[0])
    return result
   }
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})}} as unknown as pg.Pool
 }

 async function sharedSourceFixture(){
   const f=await governanceFixture(pool),approved=await f.approved()
   const source=await createPublicationService(pool).publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:approved.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})
   const org=randomUUID(),member=randomUUID()
   await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[org])
   await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'organization',$1)",[org])
   await pool.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles) VALUES($1,$2,ARRAY['contributor'])",[org,member])
   const grant:ValidatedV2Grant={primaryInstallationId:org,configVersion:'1',scopeBindings:[
    {installation_id:f.team,owner_scope_kind:'team',owner_scope_id:f.team,membership_id:f.proposer,membership_revision:'1',authorization_epoch:'1',permissions:['read']},
    {installation_id:org,owner_scope_kind:'organization',owner_scope_id:org,membership_id:member,membership_revision:'1',authorization_epoch:'1',permissions:['read','contribute']}]}
   const evidenceId=(await pool.query('SELECT evidence_id FROM knowledge_evidence WHERE installation_id=$1 AND version_id=$2',[f.team,source.versionId])).rows[0].evidence_id
   const proposal=await createPromotionService(pool).propose({grant,sourceInstallationId:f.team,sourceClaimId:source.claimId,evidenceIds:[evidenceId],idempotencyDigest:randomUUID()})
   return {f,source,org,member,grant,evidenceId,proposal}
 }

 test('a secondary revision target expiring after its final write rolls back the immutable revision',async()=>{
  const f=await governanceFixture(pool),proposal=await f.proposed(),grant=f.grant(f.reviewer,['read','review'])
  grant.primaryInstallationId=f.personal
  let reached!:()=>void,release!:()=>void
  const written=new Promise<void>(resolve=>{reached=resolve}),allowed=new Promise<void>(resolve=>{release=resolve})
  const hooked=hookPool(async sql=>{if(sql.includes('UPDATE memory_promotion_candidates')){reached();await allowed}})
  const deadline=Number((await pool.query('SELECT extract(epoch FROM clock_timestamp())::float8 AS now')).rows[0].now)+1
  await pool.query('UPDATE memory_scope_memberships SET valid_until=to_timestamp($2) WHERE membership_id=$1',[f.reviewer,deadline])
  const pending=createPromotionRepository(hooked).appendRevision({grant,targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedRevision:1,
   statement:'Must not commit after selected reviewer expiry',structuredContent:{},createdByMembershipId:f.reviewer,evidenceSelection:{retainedOrdinals:[1],removedOrdinals:[],newEvidenceIds:[]}})
  const outcome=pending.then(value=>({value}),error=>({error}))
  try{
   await Promise.race([written,outcome.then(result=>{if('error' in result)throw result.error;throw new Error('revision exited before final write barrier')})])
   await pool.query('SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp()))::float8)',[deadline+0.02]);release()
   expect(await outcome).toMatchObject({error:{name:'TargetBindingError'}})
   expect((await pool.query('SELECT revision::int FROM memory_promotion_candidates')).rows).toEqual([{revision:1}])
   expect((await pool.query('SELECT 1 FROM memory_promotion_candidate_versions')).rowCount).toBe(1)
  }finally{release();await pending.catch(()=>undefined)}
 },10000)

 for(const mode of ['new_evidence','legacy_repair','retained_copy','metadata_patch','source_refresh'] as const){
  test(mode==='retained_copy'?'retaining copied evidence does not require an unused source membership':`revision ${mode} cannot outlive the selected source membership`,async()=>{
   const {f,org,member,grant,evidenceId,proposal}=await sharedSourceFixture()
   if(mode==='legacy_repair')await pool.query('UPDATE memory_promotion_candidate_versions SET revision_bundle=NULL,revision_bundle_hash=NULL WHERE candidate_revision_id=$1',[proposal.candidateRevision.candidate_revision_id])
   let reached!:()=>void,release!:()=>void
   const written=new Promise<void>(resolve=>{reached=resolve}),allowed=new Promise<void>(resolve=>{release=resolve})
   const hooked=hookPool(async sql=>{if(sql.includes('UPDATE memory_promotion_candidates')){reached();await allowed}})
   const deadline=Number((await pool.query('SELECT extract(epoch FROM clock_timestamp())::float8 AS now')).rows[0].now)+1
   await pool.query('UPDATE memory_scope_memberships SET valid_until=to_timestamp($2) WHERE membership_id=$1',[f.proposer,deadline])
   const pending=createPromotionRepository(hooked).appendRevision({grant,targetInstallationId:org,candidateId:proposal.candidate.candidate_id,expectedRevision:1,
    statement:'Revised organization fact',structuredContent:{},createdByMembershipId:member,repairLegacyBundle:mode==='legacy_repair',
    metadataPatch:mode==='metadata_patch'?{sourceValidFrom:null}:undefined,refreshSourceMetadata:mode==='source_refresh',
    evidenceSelection:mode!=='new_evidence'?{retainedOrdinals:[1],removedOrdinals:[],newEvidenceIds:[]}:{retainedOrdinals:[],removedOrdinals:[1],newEvidenceIds:[evidenceId]}})
   const outcome=pending.then(value=>({value}),error=>({error}))
   try{
    await Promise.race([written,outcome.then(result=>{if('error' in result)throw result.error;throw new Error('revision exited before source expiry barrier')})])
    await pool.query('SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp()))::float8)',[deadline+0.02]);release()
    if(mode==='retained_copy')expect(await outcome).toMatchObject({value:{revisionNumber:2}})
    else expect(await outcome).toMatchObject({error:{name:'TargetBindingError'}})
    expect((await pool.query('SELECT revision::int FROM memory_promotion_candidates WHERE candidate_id=$1',[proposal.candidate.candidate_id])).rows).toEqual([{revision:mode==='retained_copy'?2:1}])
    expect((await pool.query('SELECT 1 FROM memory_promotion_candidate_versions WHERE candidate_id=$1',[proposal.candidate.candidate_id])).rowCount).toBe(mode==='retained_copy'?2:1)
   }finally{release();await pending.catch(()=>undefined)}
  },10000)
 }

 for(const mode of ['new_evidence','legacy_repair'] as const){
  test(`${mode} revision and proposal share source-before-parent-bootstrap lock order`,async()=>{
   const f=await governanceFixture(pool),proposal=await f.proposed(),org=randomUUID()
   await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[org])
   await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'organization',$1)",[org])
   await pool.query('UPDATE memory_owner_scopes SET parent_organization_id=$2 WHERE installation_id=$1',[f.team,org])
   await pool.query('INSERT INTO memory_review_policy_sets(policy_id,installation_id) VALUES($1,$2)',[randomUUID(),org])
   if(mode==='legacy_repair')await pool.query('UPDATE memory_promotion_candidate_versions SET revision_bundle=NULL,revision_bundle_hash=NULL WHERE candidate_revision_id=$1',[proposal.candidateRevision.candidate_revision_id])
   let reached!:()=>void,release!:()=>void,proposerPid:number|undefined,finished=false
   const parentLocked=new Promise<void>(resolve=>{reached=resolve}),allowed=new Promise<void>(resolve=>{release=resolve})
   const revisionPool=hookPool(async sql=>{if(sql.includes('SELECT policy_id::text FROM memory_review_policy_sets')&&sql.includes('FOR UPDATE')){reached();await allowed}})
   const proposerPool={query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();proposerPid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return client}} as unknown as pg.Pool
   const revising=createPromotionRepository(revisionPool).appendRevision({grant:f.proposeInput.grant,targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedRevision:1,
    statement:'Current source with inherited policy',structuredContent:{},createdByMembershipId:f.proposer,repairLegacyBundle:mode==='legacy_repair',
    evidenceSelection:mode==='legacy_repair'?{retainedOrdinals:[1],removedOrdinals:[],newEvidenceIds:[]}:{retainedOrdinals:[],removedOrdinals:[1],newEvidenceIds:[f.evidence]}})
   const revisionOutcome=revising.then(value=>({value}),error=>({error}))
   let proposing:Promise<unknown>|undefined
   try{
    await Promise.race([parentLocked,revisionOutcome.then(result=>{if('error' in result)throw result.error;throw new Error('revision exited before bootstrap barrier')})])
    proposing=createPromotionService(proposerPool).propose({...f.proposeInput,idempotencyDigest:randomUUID()})
    const proposalOutcome=proposing.then(value=>{finished=true;return {value}},error=>{finished=true;return {error}})
    await waitForBlock(()=>proposerPid,()=>finished);release()
    const revisionResult=await revisionOutcome,proposalResult=await proposalOutcome
    expect(['error' in revisionResult?(revisionResult.error as {code?:string}).code:null,'error' in proposalResult?(proposalResult.error as {code?:string}).code:null]).toEqual([null,null])
    expect(revisionResult).toHaveProperty('value.candidateRevisionId')
    expect(proposalResult).toHaveProperty('value.candidate.candidate_id')
    expect((await pool.query('SELECT 1 FROM memory_promotion_candidates')).rowCount).toBe(2)
   }finally{release();await revising.catch(()=>undefined);await proposing?.catch(()=>undefined)}
  },15000)
 }

 test('concurrent first-head initialization rechecks a head created after its empty read',async()=>{
  const f=await governanceFixture(pool),policyId=randomUUID()
  await pool.query('INSERT INTO memory_review_policy_sets(policy_id,installation_id) VALUES($1,$2)',[policyId,f.team])
  let reached!:()=>void,release!:()=>void,paused=false
  const emptyHead=new Promise<void>(resolve=>{reached=resolve}),allowed=new Promise<void>(resolve=>{release=resolve})
  const hooked=hookPool(async sql=>{if(!paused&&sql.includes('FROM memory_review_policy_heads')){paused=true;reached();await allowed}})
  const first=createReviewPolicyRepository(hooked).ensurePolicySet(f.team,DEFAULT_TEAM_REVIEW_POLICY)
  const outcome=first.then(value=>({value}),error=>({error}))
  try{
   await Promise.race([emptyHead,outcome.then(result=>{if('error' in result)throw result.error;throw new Error('initializer exited before empty head barrier')})])
   const second=await createReviewPolicyRepository(pool).ensurePolicySet(f.team,DEFAULT_TEAM_REVIEW_POLICY)
   release();expect(await outcome).toEqual({value:second})
   expect((await pool.query('SELECT 1 FROM memory_review_policy_versions WHERE policy_id=$1',[policyId])).rowCount).toBe(1)
   expect((await pool.query('SELECT 1 FROM memory_review_policy_heads WHERE policy_id=$1',[policyId])).rowCount).toBe(1)
  }finally{release();await first.catch(()=>undefined)}
 },10000)

 test('idempotent policy initialization reports the active immutable version after a rollback',async()=>{
  const f=await governanceFixture(pool),repo=createReviewPolicyRepository(pool)
  const initial=await repo.ensurePolicySet(f.team,DEFAULT_TEAM_REVIEW_POLICY)
  await repo.publishVersion({installationId:f.team,document:{...DEFAULT_TEAM_REVIEW_POLICY,minimum_approvals:2},createdByMembershipId:null,expectedRevision:1})
  await repo.rollback({installationId:f.team,targetVersionId:initial.policyVersionId,expectedRevision:2})
  expect(await repo.ensurePolicySet(f.team,DEFAULT_TEAM_REVIEW_POLICY)).toEqual(initial)
  expect((await repo.getHead(f.team))!.revision).toBe(3)
 })

 function appFor(grant:ValidatedV2Grant,dbPool=pool){
  const app=Fastify()
  registerGovernanceRoutes(app,{pool:dbPool,guard:{guardV2:async()=>({...grant,version:'v2',installationId:grant.primaryInstallationId,services:['memory.search'],callerType:'web'})} as never,
   sharedScopesEnabled:true,cursorSigningKey:'revision-authority-fixture'})
  return app
 }
 for(const mode of ['target_before_commit','new_evidence_after_receipt','legacy_after_receipt','metadata_after_receipt','refresh_after_receipt'] as const){
  test(`HTTP revision ${mode} refuses expired authority and rolls back its idempotency receipt`,async()=>{
   const {f,org,member,grant,evidenceId,proposal}=await sharedSourceFixture()
   if(mode==='legacy_after_receipt')await pool.query('UPDATE memory_promotion_candidate_versions SET revision_bundle=NULL,revision_bundle_hash=NULL WHERE candidate_revision_id=$1',[proposal.candidateRevision.candidate_revision_id])
   let reached!:()=>void,release!:()=>void,paused=false
   const written=new Promise<void>(resolve=>{reached=resolve}),allowed=new Promise<void>(resolve=>{release=resolve})
   const hooked=hookPool(async sql=>{
    const barrier=mode==='target_before_commit'?sql.includes('UPDATE memory_promotion_candidates'):sql.includes('UPDATE memory_idempotency_keys')&&sql.includes('response_metadata')
    if(!paused&&barrier){paused=true;reached();await allowed}
   })
   const app=appFor(grant,hooked)
   const deadline=Number((await pool.query('SELECT extract(epoch FROM clock_timestamp())::float8 AS now')).rows[0].now)+1
   await pool.query('UPDATE memory_scope_memberships SET valid_until=to_timestamp($2) WHERE membership_id=$1',[mode==='target_before_commit'?member:f.proposer,deadline])
   const pending=app.inject({method:'POST',url:`/api/v1/memory/governance/proposals/${proposal.candidate.candidate_id}/revise`,headers:{'idempotency-key':mode},
    payload:{target_installation_id:org,expected_revision:1,statement:'HTTP revision with current authority',structured_content:{},repair_legacy_bundle:mode==='legacy_after_receipt',
     metadata_patch:mode==='metadata_after_receipt'?{sourceValidFrom:null}:undefined,refresh_source_metadata:mode==='refresh_after_receipt',
     evidence_selection:mode==='new_evidence_after_receipt'?{retained_ordinals:[],removed_ordinals:[1],new_evidence_ids:[evidenceId]}:{retained_ordinals:[1],removed_ordinals:[],new_evidence_ids:[]}}})
   const outcome=pending.then(value=>({value}),error=>({error}))
   try{
    await Promise.race([written,outcome.then(result=>{if('error' in result)throw result.error;throw new Error('HTTP revision exited before its authority barrier')})])
    await pool.query('SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp()))::float8)',[deadline+0.02]);release()
    const response=await pending
    expect(response.statusCode).toBe(403);expect(response.json().error.code).toBe('forbidden')
    expect((await pool.query('SELECT revision::int FROM memory_promotion_candidates WHERE candidate_id=$1',[proposal.candidate.candidate_id])).rows).toEqual([{revision:1}])
    expect((await pool.query("SELECT 1 FROM memory_idempotency_keys WHERE operation='governance.revise'")).rowCount).toBe(0)
   }finally{release();await pending.catch(()=>undefined);await app.close()}
  },10000)
 }
 test('a revision receipt replay needs current target permission but does not recopy an expired source',async()=>{
  const {f,org,grant,evidenceId,proposal}=await sharedSourceFixture(),app=appFor(grant)
  const request={method:'POST' as const,url:`/api/v1/memory/governance/proposals/${proposal.candidate.candidate_id}/revise`,headers:{'idempotency-key':'copied-source-replay'},
   payload:{target_installation_id:org,expected_revision:1,statement:'Immutable copied source replay',structured_content:{},evidence_selection:{retained_ordinals:[],removed_ordinals:[1],new_evidence_ids:[evidenceId]}}}
  try{
   const first=await app.inject(request);expect(first.statusCode).toBe(200)
   await pool.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()-interval '1 second' WHERE membership_id=$1",[f.proposer])
   const replay=await app.inject(request);expect(replay.statusCode).toBe(200);expect(replay.json()).toEqual(first.json())
   expect((await pool.query('SELECT 1 FROM memory_promotion_candidate_versions WHERE candidate_id=$1',[proposal.candidate.candidate_id])).rowCount).toBe(2)
  }finally{await app.close()}
 })
 test.each(['registry','purge'] as const)('source refresh and %s mutation serialize before Claim/policy locks',async mode=>{
  const f=await governanceFixture(pool),repositoryId=randomUUID()
  await pool.query(`INSERT INTO repositories(installation_id,repository_id,repository_key,canonical_remote,first_observed_at,last_observed_at)
   VALUES($1,$2,'source','https://github.com/Acme/Repo.git',NOW(),NOW())`,[f.personal,repositoryId])
  const app={scopeKind:'repository',scopeKey:repositoryId,canonicalRepositoryKey:'github.com/Acme/Repo',repositoryId,snapshotId:null,branch:null,status:'verified'}
  await pool.query("UPDATE knowledge_claims SET scope_kind='repository',scope_key=$2,canonical_repository_key=$3 WHERE claim_id=$1",[f.claim,repositoryId,app.canonicalRepositoryKey])
  await pool.query('UPDATE knowledge_versions SET repository_id=$2,applicability=$3 WHERE version_id=$1',[f.version,repositoryId,app])
  const proposal=await f.proposed()
  let reached!:()=>void,release!:()=>void,pid:number|undefined,other:Promise<unknown>|undefined
  const written=new Promise<void>(resolve=>{reached=resolve}),allowed=new Promise<void>(resolve=>{release=resolve})
  const hooked=hookPool(async sql=>{if(sql.includes('UPDATE memory_promotion_candidates')){reached();await allowed}})
  const revision=createPromotionRepository(hooked).appendRevision({grant:f.proposeInput.grant,targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedRevision:1,
   statement:proposal.candidateRevision.statement,structuredContent:{},createdByMembershipId:f.proposer,refreshSourceMetadata:true,evidenceSelection:{retainedOrdinals:[1],removedOrdinals:[],newEvidenceIds:[]}})
  const observed=revision.then(value=>({value}),error=>({error}))
  const writerPool={connect:async()=>{const client=await pool.connect();pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return client}} as pg.Pool
  try{
   await Promise.race([written,observed.then(result=>{throw 'error' in result?result.error:new Error('missing metadata lock barrier')})])
   other=mode==='registry'?createSourceRepository(writerPool).resolveRepository({installationId:f.personal,repositoryKey:'source',canonicalRemote:'https://github.com/Acme/Other.git'})
    :createPurgeRepository(writerPool,{hmacKey:'test-only-source-purge'}).purgeRepository({installationId:f.personal,repositoryId,reasonCode:'test'})
   const otherResult=other.then(value=>({value}),error=>({error}))
   await waitForBlock(()=>pid)
   release()
   expect(await observed).toHaveProperty('value.revisionNumber',2)
   expect(await otherResult).toHaveProperty('value')
  }finally{release();await revision.catch(()=>undefined);await other?.catch(()=>undefined)}
 })
 test('metadata request body binds the idempotency receipt; replay does not refresh expired sources',async()=>{
  const {f,org,grant,proposal}=await sharedSourceFixture(),app=appFor(grant)
  const request={method:'POST' as const,url:`/api/v1/memory/governance/proposals/${proposal.candidate.candidate_id}/revise`,headers:{'idempotency-key':'metadata-replay'},
   payload:{target_installation_id:org,expected_revision:1,statement:proposal.candidateRevision.statement,structured_content:{},refresh_source_metadata:true,
    metadata_patch:{sourceValidFrom:'2025-01-01T00:00:00Z'},evidence_selection:{retained_ordinals:[1],removed_ordinals:[],new_evidence_ids:[]}}}
  try{
   const first=await app.inject(request);expect(first.statusCode).toBe(200)
   const changed=await app.inject({...request,payload:{...request.payload,metadata_patch:{sourceValidFrom:'2026-01-01T00:00:00Z'}}})
   expect(changed.statusCode).toBe(409)
   await pool.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()-interval '1 second' WHERE membership_id=$1",[f.proposer])
   const replay=await app.inject(request);expect(replay.statusCode).toBe(200);expect(replay.json()).toEqual(first.json())
   expect((await pool.query('SELECT count(*)::int AS n FROM memory_promotion_candidate_versions WHERE candidate_id=$1',[proposal.candidate.candidate_id])).rows[0].n).toBe(2)
   expect((await pool.query('SELECT revision_bundle FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[first.json().candidateRevisionId])).rows[0].revision_bundle.sourceValidFrom).toBe('2025-01-01T00:00:00.000Z')
  }finally{await app.close()}
 })
 test('source refresh retains a server-proven upstream policy hash; client overrides are rejected',async()=>{
  const {org,member,grant,proposal}=await sharedSourceFixture(),repository=createPromotionRepository(pool)
  const input={targetInstallationId:org,candidateId:proposal.candidate.candidate_id,expectedRevision:1,statement:proposal.candidateRevision.statement,structuredContent:{},grant,
   createdByMembershipId:member,refreshSourceMetadata:true,evidenceSelection:{retainedOrdinals:[1],removedOrdinals:[],newEvidenceIds:[]}}
  const old=(await repository.getLatestRevision(input.candidateId))!.revision_bundle!
  expect(old.originPolicyHash).toMatch(/^[a-f0-9]{64}$/)
  await repository.appendRevision(input)
  expect((await repository.getLatestRevision(input.candidateId))!.revision_bundle!.originPolicyHash).toBe(old.originPolicyHash)
  await expect(repository.appendRevision({...input,expectedRevision:2,metadataPatch:{originPolicyHash:'b'.repeat(64)}} as never)).rejects.toThrow(/metadata/)
 })
 test('a legacy revision appearing after source discovery requires a fresh ordered repair attempt',async()=>{
  const {org,member,grant,proposal}=await sharedSourceFixture(),candidateId=proposal.candidate.candidate_id
  let reached!:()=>void,release!:()=>void,paused=false
  const discovered=new Promise<void>(resolve=>{reached=resolve}),allowed=new Promise<void>(resolve=>{release=resolve})
  const hooked=hookPool(async sql=>{if(!paused&&sql.includes('JOIN LATERAL')){paused=true;reached();await allowed}})
  const input={grant,targetInstallationId:org,candidateId,expectedRevision:2,statement:'Fresh ordered legacy repair',structuredContent:{},createdByMembershipId:member,
   repairLegacyBundle:true,evidenceSelection:{retainedOrdinals:[1],removedOrdinals:[],newEvidenceIds:[]}}
  const pending=createPromotionRepository(hooked).appendRevision(input),outcome=pending.then(value=>({value}),error=>({error}))
  const legacyWriter=await pool.connect()
  try{
   await Promise.race([discovered,outcome.then(result=>{if('error' in result)throw result.error;throw new Error('repair exited before discovery barrier')})])
   const oldRevision=randomUUID()
   await legacyWriter.query('BEGIN')
   // Frozen Bridge-compatible legacy shape: append a null-bundle revision
   // and its immutable copied evidence, then advance the candidate CAS.
   await legacyWriter.query(`INSERT INTO memory_promotion_candidate_versions
     SELECT (jsonb_populate_record(NULL::memory_promotion_candidate_versions,to_jsonb(v)||jsonb_build_object(
       'candidate_revision_id',$2::text,'revision_number',2,'revision_bundle',NULL,'revision_bundle_hash',NULL))).*
     FROM memory_promotion_candidate_versions v WHERE candidate_id=$1 AND revision_number=1`,[candidateId,oldRevision])
   await legacyWriter.query(`INSERT INTO memory_promotion_evidence SELECT (jsonb_populate_record(NULL::memory_promotion_evidence,
     to_jsonb(e)||jsonb_build_object('candidate_revision_id',$2::text))).* FROM memory_promotion_evidence e WHERE candidate_revision_id=$1`,[proposal.candidateRevision.candidate_revision_id,oldRevision])
   await legacyWriter.query('UPDATE memory_promotion_candidates SET revision=2 WHERE candidate_id=$1 AND revision=1',[candidateId])
   await legacyWriter.query('COMMIT');release()
   const result=await outcome
   expect(result).toHaveProperty('error')
   expect('error' in result?String((result.error as Error).message):'unexpected success').toMatch(/source.*revision|revision.*source/)
   expect((await pool.query('SELECT revision::int FROM memory_promotion_candidates WHERE candidate_id=$1',[candidateId])).rows).toEqual([{revision:2}])
   const retried=await createPromotionRepository(pool).appendRevision(input)
   expect(retried.revisionNumber).toBe(3)
   expect((await pool.query('SELECT revision_bundle FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[oldRevision])).rows[0].revision_bundle).toBeNull()
  }finally{release();await legacyWriter.query('ROLLBACK');legacyWriter.release();await pending.catch(()=>undefined)}
 },10000)
})
