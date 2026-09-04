import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createSkillPublicationFixture} from '../testing/skill-publication-fixture.js'
import {skillFixtureDocument} from '../testing/skill-fixture.js'
import {createSkillPublicationService} from '../skills/publication-service.js'
import {createSkillPolicyService} from '../skills/policy-service.js'
import {createSkillAdmissionService} from '../skills/admission-service.js'
import {createSkillWorker} from '../skills/worker.js'
import {createSkillGenerator} from '../skills/generator.js'
import {createJobRepository} from '../jobs/repository.js'
import type {TextGenerator} from '../ports/text-generator.js'
import {createSkillRolloutService} from '../skills/rollout-service.js'
import {createSkillExecutionService} from '../skills/execution-service.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const db=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
db('Phase5 controlled publication and rollback',()=>{
  let pool:pg.Pool
  beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:10});await assertMemoryTestDatabase(pool,url!);await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await applyMemorySchema(pool)},60000)
  beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
  afterAll(async()=>pool?.end())
  async function publishFromAnotherSource(f:Awaited<ReturnType<typeof createSkillPublicationFixture>>){
    const previousSource=(await pool.query(`SELECT a.claim_version_id FROM memory_skill_versions v JOIN memory_skill_archives a USING(installation_id,archive_id)
      WHERE v.installation_id=$1 AND v.version_id=$2`,[f.installationId,f.reviewed.versionId])).rows[0].claim_version_id as string
    const claimId=randomUUID(),sourceVersionId=randomUUID(),client=await pool.connect()
    try{
      await client.query('BEGIN')
      await client.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state,current_version_id,owner_scope_kind,owner_scope_id)
        VALUES($1,$2,'work_method','repository',$3,$1::uuid::text,'active',$4,'team',$2)`,[claimId,f.installationId,f.repositoryId,sourceVersionId])
      await client.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,source_promotion_candidate_id)
        VALUES($1,$2,$3,1,'Independent current source','team_published',1,$4)`,[sourceVersionId,f.installationId,claimId,randomUUID()])
      await client.query('COMMIT')
    }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
    await pool.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal,visibility)
      SELECT $1,installation_id,$2,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal,visibility FROM knowledge_evidence
      WHERE installation_id=$3 AND version_id=$4`,[randomUUID(),sourceVersionId,f.installationId,previousSource])
    await pool.query(`INSERT INTO memory_authority_records(authority_id,installation_id,version_id,candidate_revision_id,review_policy_version_id,counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash)
      SELECT $1,installation_id,$2,$3,review_policy_version_id,counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash FROM memory_authority_records
      WHERE installation_id=$4 AND version_id=$5`,[randomUUID(),sourceVersionId,randomUUID(),f.installationId,previousSource])
    const scheduled=await createSkillAdmissionService(f.deps).schedule({...f.author,candidateKey:'method',source:{kind:'claim_version',versionId:sourceVersionId,repositoryId:f.repositoryId,repoSnapshotId:f.snapshotId}})
    const job=(await createJobRepository(pool).claimJobs({workerId:'rollback-source-fixture',limit:1,leaseMs:30000}))[0]!
    const provider={generateJson:async()=>({ok:true,value:skillFixtureDocument(),usage:{inputTokens:1,outputTokens:1,model:'fixture'}})} as TextGenerator
    await createSkillWorker({...f.deps,generator:createSkillGenerator({provider,timeoutMs:100})}).handle(job,new AbortController().signal,{fence:{jobId:job.job_id,claimedBy:'rollback-source-fixture',claimEpoch:job.claim_epoch}})
    const candidateId=(await pool.query(`SELECT candidate_id FROM memory_skill_candidates WHERE installation_id=$1 AND task_id=$2 AND generation=$3`,[f.installationId,scheduled.taskId,scheduled.generation])).rows[0].candidate_id as string
    const next=await f.prepareVersion(f.reviewed,undefined,candidateId)
    await f.publication.execute(f.publisher,{...next.subject,expectedPublicationRevision:1,mode:'manual'})
    return {next,previousSource,sourceVersionId}
  }
  test('fixture publication keeps the reviewed head separate; production gate and forged capabilities deny',async()=>{
    const f=await createSkillPublicationFixture(pool,{publish:false})
    const external=createSkillPublicationService({pool,context:f.context,cases:f.cases})
    await expect(external.execute(f.publisher,f.publishRequest)).rejects.toMatchObject({code:'product_gate_closed'})
    await expect(f.publication.execute(f.publisher,{...f.publishRequest,fixtureCapability:true})).rejects.toMatchObject({code:'invalid_request'})
    const result=await f.publication.execute(f.publisher,f.publishRequest)
    expect(result).toMatchObject({state:'active',publicationRevision:1,provenance:'fixture'})
    expect((await pool.query(`SELECT state,revision::int FROM memory_skill_heads`)).rows).toEqual([{state:'reviewed',revision:2}])
    expect((await pool.query(`SELECT current_version_id FROM memory_skill_publication_heads`)).rows[0].current_version_id).toBe(f.reviewed.versionId)
  })
  test('reader and reviewer cannot publish; publisher cannot manufacture independent successes',async()=>{
    const f=await createSkillPublicationFixture(pool,{publish:false})
    for(const actor of [f.reader,f.reviewer])await expect(f.publication.execute(actor,f.publishRequest)).rejects.toMatchObject({code:'forbidden'})
    await expect(f.publication.execute(f.publisher,{...f.publishRequest,success_count:2})).rejects.toMatchObject({code:'invalid_request'})
    await expect(f.publication.execute(f.publisher,{...f.publishRequest,mode:'auto'})).rejects.toMatchObject({code:'independent_successes_required'})
    expect(await f.publication.getEligibility(f.publisher,f.reviewed.subject)).toMatchObject({eligible:false,manualEligible:true,independentSuccesses:0,productGate:'closed'})
    expect((await pool.query(`SELECT 1 FROM memory_skill_publication_heads`)).rowCount).toBe(0)
  })
  test('independent success eligibility deduplicates canonical source sessions, never Replay fixtures',async()=>{
    const same=await createSkillPublicationFixture(pool,{publish:false,naturalSourceSessionKeys:['same','same']})
    expect(await same.publication.getEligibility(same.publisher,same.reviewed.subject)).toMatchObject({eligible:false,independentSuccesses:1})
    await expect(same.publication.execute(same.publisher,{...same.publishRequest,mode:'auto'})).rejects.toMatchObject({code:'independent_successes_required'})
    const independent=await createSkillPublicationFixture(pool,{publish:false,naturalSourceSessionKeys:['one','two']})
    expect(await independent.publication.getEligibility(independent.publisher,independent.reviewed.subject)).toMatchObject({eligible:true,independentSuccesses:2})
    expect(independent.reviewed.evidence).toMatchObject({naturalExecutionCount:0,provenance:{fixture:2,recorded:0}})
    expect(await independent.publication.execute(independent.publisher,{...independent.publishRequest,mode:'auto'})).toMatchObject({state:'active',provenance:'fixture'})
  })
  test('configured budget requires bound, matching, settled and non-overrun reservation',async()=>{
    const f=await createSkillPublicationFixture(pool,{publish:false})
    const context={...f.context,config:{...f.context.config,providerBudget:{key:'publication-budget',textRequestLimit:10,textInputTokenLimit:10000,textOutputTokenLimit:10000,textMaxOutputTokensPerRequest:100}}}
    const service=createSkillPublicationService({...f.deps,context})
    await expect(service.execute(f.publisher,f.publishRequest)).rejects.toMatchObject({code:'budget_invalid'})
    const id=randomUUID()
    await pool.query(`INSERT INTO memory_provider_budget_reservations(reservation_id,budget_key,provider_kind,reserved_input_tokens,reserved_output_tokens)
      VALUES($1,'wrong-budget','text',10,10)`,[id])
    await pool.query(`UPDATE memory_skill_task_runs SET budget_reservation_id=$1 WHERE installation_id=$2`,[id,f.installationId])
    await expect(service.execute(f.publisher,f.publishRequest)).rejects.toMatchObject({code:'budget_invalid'})
    await pool.query(`UPDATE memory_provider_budget_reservations SET budget_key='publication-budget',state='settled',actual_input_tokens=1,actual_output_tokens=11 WHERE reservation_id=$1`,[id])
    await expect(service.execute(f.publisher,f.publishRequest)).rejects.toMatchObject({code:'budget_invalid'})
    await pool.query(`UPDATE memory_provider_budget_reservations SET actual_output_tokens=1 WHERE reservation_id=$1`,[id])
    expect(await service.execute(f.publisher,f.publishRequest)).toMatchObject({state:'active'})
  })
  test('high risk auto and author publication deny; independent reviewer+publisher can manually publish fixture',async()=>{
    const f=await createSkillPublicationFixture(pool,{high:true,publish:false})
    await expect(f.publication.execute(f.publisher,{...f.publishRequest,mode:'auto'})).rejects.toMatchObject({code:'risk_denied'})
    await pool.query(`UPDATE memory_scope_memberships SET roles=ARRAY['contributor','reviewer','publisher'] WHERE membership_id=$1`,[f.author.membershipId])
    const author={...f.author,grant:{...f.author.grant,scopeBindings:f.author.grant.scopeBindings.map(b=>({...b,permissions:['read','publish','review','contribute']}))}}
    await expect(f.publication.execute(author,f.publishRequest)).rejects.toMatchObject({code:'self_publish_denied'})
    expect(await f.publication.execute(f.publisher,f.publishRequest)).toMatchObject({state:'active'})
    expect((await pool.query(`SELECT 1 FROM memory_skill_publication_events WHERE mode='auto'`)).rowCount).toBe(0)
  })
  test.each(['reviewer','policy','recording','source','generation'])('%s stale facts deny without replacing the effective version',async(kind)=>{
    const f=await createSkillPublicationFixture(pool),next=await f.prepareVersion({skillId:f.reviewed.skillId,revision:f.reviewed.revision},{...skillFixtureDocument(),title:'New version'})
    if(kind==='reviewer')await pool.query(`UPDATE memory_scope_memberships SET state='revoked',membership_revision=2 WHERE membership_id=$1`,[f.reviewer.membershipId])
    if(kind==='policy')await createSkillPolicyService({pool}).execute(f.policyAdmin,{expectedRevision:0,policy:{minimumIndependentSuccesses:3,autoMode:'off',canaryMode:'off'}})
    if(kind==='recording')next.records[0].steps[0].response={matches:9}
    if(kind==='source')await pool.query(`UPDATE repositories SET repository_key='different' WHERE repository_id=$1`,[f.repositoryId])
    if(kind==='generation')await pool.query(`UPDATE memory_generation_runs SET state='failed' WHERE output_id=$1`,[f.candidateId])
    if(kind==='source')next.records[0].repository_id=randomUUID()
    const previous=(await pool.query(`SELECT current_version_id,revision::int,state FROM memory_skill_publication_heads`)).rows
    await expect(f.publication.execute(f.publisher,{...next.subject,expectedPublicationRevision:1,mode:'manual'})).rejects.toThrow()
    expect((await pool.query(`SELECT current_version_id,revision::int,state FROM memory_skill_publication_heads`)).rows).toEqual(previous)
    expect(previous[0].current_version_id).toBe(f.reviewed.versionId)
  })
  test('competing publication CAS allows one writer; rollback validates old exact version after a new draft',async()=>{
    const f=await createSkillPublicationFixture(pool),next=await f.prepareVersion({skillId:f.reviewed.skillId,revision:f.reviewed.revision},{...skillFixtureDocument(),title:'New version'})
    const request={...next.subject,expectedPublicationRevision:1,mode:'manual' as const}
    const results=await Promise.allSettled([f.publication.execute(f.publisher,request),f.publication.execute(f.publisher,request)])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    const draft=await f.review.execute(f.author,{action:'edit',skillId:next.skillId,expectedRevision:next.revision,document:{...skillFixtureDocument(),title:'Unreviewed next draft'}})
    const rollback=await f.rollback.execute(f.publisher,{skillId:draft.skillId,targetVersionId:f.reviewed.versionId,expectedRevision:draft.revision,expectedPublicationRevision:2})
    expect(rollback).toMatchObject({versionId:f.reviewed.versionId,publicationRevision:3})
    expect((await pool.query(`SELECT current_version_id FROM memory_skill_heads`)).rows[0].current_version_id).toBe(draft.versionId)
  })
  test('rollback requires actual previous target and revalidates revocation',async()=>{
    const f=await createSkillPublicationFixture(pool)
    await expect(f.rollback.execute(f.publisher,{skillId:f.reviewed.skillId,targetVersionId:f.reviewed.versionId,expectedRevision:f.reviewed.revision,expectedPublicationRevision:1})).rejects.toMatchObject({code:'no_previous_version'})
    const next=await f.prepareVersion({skillId:f.reviewed.skillId,revision:f.reviewed.revision},{...skillFixtureDocument(),title:'New'})
    await f.publication.execute(f.publisher,{...next.subject,expectedPublicationRevision:1,mode:'manual'})
    await pool.query(`INSERT INTO memory_skill_version_revocations(installation_id,skill_id,version_id)VALUES($1,$2,$3)`,[f.installationId,next.skillId,f.reviewed.versionId])
    await expect(f.rollback.execute(f.publisher,{skillId:next.skillId,targetVersionId:f.reviewed.versionId,expectedRevision:next.revision,expectedPublicationRevision:2})).rejects.toMatchObject({code:'target_revoked'})
    expect((await pool.query(`SELECT current_version_id,state,revision::int FROM memory_skill_publication_heads`)).rows[0]).toEqual({current_version_id:next.versionId,state:'disabled',revision:3})
  })
  test.each(['revoked','missing','expired'])('invalid %s previous target closes current delivery only after authorized CAS',async(kind)=>{
    const f=await createSkillPublicationFixture(pool),{next,previousSource}=await publishFromAnotherSource(f)
    const execution=createSkillExecutionService(f.deps)
    await createSkillRolloutService(f.deps).configure(f.publisher,{skillId:next.skillId,expectedRevision:0,basisPoints:10000,state:'canary'})
    const start={skillId:next.skillId,versionId:next.versionId,expectedPublicationRevision:2,sessionId:f.sessionId,idempotencyKey:'before-close'}
    if(kind==='revoked')await pool.query(`INSERT INTO memory_skill_version_revocations(installation_id,skill_id,version_id)VALUES($1,$2,$3)`,[f.installationId,next.skillId,f.reviewed.versionId])
    if(kind==='missing')await pool.query(`DELETE FROM memory_skill_versions WHERE installation_id=$1 AND version_id=$2`,[f.installationId,f.reviewed.versionId])
    if(kind==='expired')await pool.query(`UPDATE knowledge_versions SET valid_until=NOW()-INTERVAL '1 second' WHERE installation_id=$1 AND version_id=$2`,[f.installationId,previousSource])
    // The current version has independent valid sources and remains deliverable before rollback.
    expect(await execution.start(f.reader,start)).toMatchObject({state:'started',versionId:next.versionId})
    const request={skillId:next.skillId,targetVersionId:f.reviewed.versionId,expectedRevision:next.revision,expectedPublicationRevision:2}
    await expect(f.rollback.execute(f.reader,request)).rejects.toMatchObject({code:'forbidden'})
    await expect(f.rollback.execute(f.publisher,{...request,targetVersionId:randomUUID()})).rejects.toThrow()
    await expect(f.rollback.execute(f.publisher,{...request,expectedPublicationRevision:1})).rejects.toThrow()
    await expect(f.rollback.execute(f.publisher,{...request,expectedRevision:next.revision-1})).rejects.toThrow()
    expect((await pool.query(`SELECT state,revision::int FROM memory_skill_publication_heads`)).rows[0]).toEqual({state:'active',revision:2})
    await expect(f.rollback.execute(f.publisher,request)).rejects.toMatchObject({code:kind==='revoked'?'target_revoked':kind==='missing'?'not_found':'source_invalid'})
    expect((await pool.query(`SELECT current_version_id,state,revision::int FROM memory_skill_publication_heads`)).rows[0]).toEqual({current_version_id:next.versionId,state:'disabled',revision:3})
    expect((await pool.query(`SELECT state FROM memory_skill_executions`)).rows).toEqual([{state:'cancelled'}])
    await expect(execution.start(f.reader,{...start,idempotencyKey:'after-close'})).rejects.toThrow()
    const denial=(await pool.query(`SELECT actor_kind,actor_id,revision::int FROM memory_skill_audit_events WHERE action='rollback' AND outcome='denied' AND revision=3`)).rows
    expect(denial).toEqual([{actor_kind:'membership',actor_id:f.publisher.membershipId,revision:3}])
  })
  test('atomic failure preserves previous pointer/event count and commits content-free denial',async()=>{
    const f=await createSkillPublicationFixture(pool),next=await f.prepareVersion({skillId:f.reviewed.skillId,revision:f.reviewed.revision},{...skillFixtureDocument(),title:'Private candidate body'})
    await pool.query(`CREATE FUNCTION fixture_publication_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$`)
    await pool.query(`CREATE TRIGGER fixture_publication_fail BEFORE UPDATE ON memory_skill_publication_heads FOR EACH ROW EXECUTE FUNCTION fixture_publication_fail()`)
    try{await expect(f.publication.execute(f.publisher,{...next.subject,expectedPublicationRevision:1,mode:'manual'})).rejects.toMatchObject({code:'publication_failed'})}
    finally{await pool.query(`DROP TRIGGER fixture_publication_fail ON memory_skill_publication_heads`);await pool.query(`DROP FUNCTION fixture_publication_fail()`)}
    expect((await pool.query(`SELECT current_version_id FROM memory_skill_publication_heads`)).rows[0].current_version_id).toBe(f.reviewed.versionId)
    expect((await pool.query(`SELECT 1 FROM memory_skill_publication_events`)).rowCount).toBe(1)
    const audit=(await pool.query(`SELECT * FROM memory_skill_audit_events WHERE action='publish' AND outcome='denied'`)).rows
    expect(audit).toHaveLength(1);expect(JSON.stringify(audit)).not.toContain('Private candidate body')
  })
  test('policy versions are immutable, strict hard floors, policy_admin-only and invalidate old Replay',async()=>{
    const f=await createSkillPublicationFixture(pool,{publish:false}),service=createSkillPolicyService({pool})
    const request={expectedRevision:0,policy:{minimumIndependentSuccesses:3,autoMode:'shadow',canaryMode:'off'}}
    await expect(service.execute(f.publisher,request)).rejects.toMatchObject({code:'forbidden'})
    await expect(service.execute(f.policyAdmin,{...request,policy:{...request.policy,minimumIndependentSuccesses:1}})).rejects.toMatchObject({code:'invalid_request'})
    await expect(service.execute(f.policyAdmin,{...request,policy:{...request.policy,autoMode:'enabled'}})).rejects.toMatchObject({code:'invalid_request'})
    const results=await Promise.allSettled([service.execute(f.policyAdmin,request),service.execute(f.policyAdmin,request)])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    await expect(pool.query(`UPDATE memory_skill_publication_policy_versions SET policy_hash=repeat('a',64)`)).rejects.toThrow('skill_governance_immutable')
    await expect(f.publication.execute(f.publisher,f.publishRequest)).rejects.toMatchObject({code:'policy_changed'})
  })
  test('first policy insertion waits for the in-flight publication validation snapshot',async()=>{
    const f=await createSkillPublicationFixture(pool,{publish:false})
    let release!:()=>void,entered!:()=>void
    const blocked=new Promise<void>(r=>{release=r}),started=new Promise<void>(r=>{entered=r})
    const cases={loadCases:async(input:Parameters<typeof f.cases.loadCases>[0])=>{entered();await blocked;return f.cases.loadCases(input)}}
    const publishing=createSkillPublicationService({...f.deps,cases}).execute(f.publisher,f.publishRequest)
    await started
    const changing=createSkillPolicyService({pool}).execute(f.policyAdmin,{expectedRevision:0,policy:{minimumIndependentSuccesses:3,autoMode:'off',canaryMode:'off'}})
    try{
      let waiting=false
      for(let i=0;i<100&&!waiting;i++){
        waiting=Boolean((await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%skill:policy:%'`)).rowCount)
        if(!waiting)await new Promise(r=>setTimeout(r,10))
      }
      expect(waiting).toBe(true)
    }finally{release()}
    expect(await publishing).toMatchObject({state:'active'})
    expect(await changing).toMatchObject({revision:1})
    expect(await f.publication.getEligibility(f.publisher,f.reviewed.subject)).toMatchObject({manualEligible:false,reasonCodes:['policy_changed']})
  })
})
