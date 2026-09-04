import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll,beforeAll,beforeEach,describe,expect,test,vi } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createSkillGovernanceFixture,skillFixtureDocument } from '../testing/skill-fixture.js'
import { createSkillReviewService } from '../skills/review-service.js'
import { createSkillAdmissionService } from '../skills/admission-service.js'
import { createSkillLifecycleService } from '../skills/lifecycle-service.js'
import { loadSkillConfig } from '../skills/config.js'
import { createSkillWorker } from '../skills/worker.js'
import { createSkillGenerator } from '../skills/generator.js'
import { createJobRepository } from '../jobs/repository.js'
import { createScopeControlProjector } from '../governance/membership-projector.js'
import type { TextGenerator } from '../ports/text-generator.js'
import type { ExtensionScopeFeedEnvelopeV2 } from '../relay/contracts.js'

const url=process.env.MEMORY_TEST_DATABASE_URL,db=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
const context={globalMode:'enabled' as const,sharedMode:'shadow' as const,config:loadSkillConfig({MEMORY_SKILL_MODE:'shadow'})}
db('Phase5 lifecycle tombstone and replay fences',()=>{
  let pool:pg.Pool
  beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:8});await assertMemoryTestDatabase(pool,url!);await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await applyMemorySchema(pool)},60000)
  afterAll(()=>pool?.end())
  beforeEach(()=>pool.query('TRUNCATE memory_installations CASCADE'))
  async function fixture(kind:'personal'|'team'='personal') {
    const f=await createSkillGovernanceFixture(pool,context,kind)
    const draft=await createSkillReviewService({pool,context}).execute(f.author,{action:'draft',candidateId:f.candidateId,expectedRevision:0})
    return {...f,draft,lifecycle:createSkillLifecycleService({pool,hmacKey:'fixture-only'})}
  }
  async function noContent() {
    for(const table of ['memory_skill_archives','memory_skill_archive_sources','memory_skill_versions','memory_skill_heads','memory_skill_replay_runs','memory_skill_replay_cases','memory_skill_publication_heads','memory_skill_rollouts','memory_skill_executions'])
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count,table).toBe(0)
  }
  test.each(['dissolved','suspended'])('scope %s deletes Skill content and repeated old grant cannot restore it',async state=>{
    const f=await fixture('team')
    await pool.query(`UPDATE memory_owner_scopes SET state=$2,authorization_epoch=authorization_epoch+1 WHERE installation_id=$1`,[f.installationId,state])
    await noContent()
    await expect(createSkillReviewService({pool,context}).execute(f.author,{action:'edit',skillId:f.draft.skillId,expectedRevision:1,document:skillFixtureDocument()})).rejects.toMatchObject({code:'forbidden'})
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM memory_skill_tasks`)).rows[0].count).toBe(0)
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM memory_skill_audit_events`)).rows[0].count).toBeGreaterThan(0)
  })
  test.each(['repository','session'])('%s purge remains idempotent and the source cannot schedule again',async scope=>{
    const f=await fixture()
    if(scope==='repository') {
      expect(await f.lifecycle.purgeRepository({installationId:f.installationId,repositoryId:f.repositoryId,reasonCode:'fixture'})).toEqual({purged:true})
      expect(await f.lifecycle.purgeRepository({installationId:f.installationId,repositoryId:f.repositoryId,reasonCode:'fixture'})).toEqual({purged:false})
    } else {
      await f.lifecycle.purgeSession({installationId:f.installationId,sessionId:f.sessionId,reason:'fixture',sourceFeedId:null})
      await f.lifecycle.purgeSession({installationId:f.installationId,sessionId:f.sessionId,reason:'fixture',sourceFeedId:null})
    }
    await noContent()
    await expect(createSkillAdmissionService({pool,context}).schedule({...f.author,candidateKey:'retry',source:{kind:'episode',episodeId:f.episodeId}})).rejects.toThrow()
  })
  test('source snapshot tombstone invalidates matching commit and prevents regeneration from surviving episode',async()=>{
    const f=await fixture(),sourceSnapshotId=randomUUID()
    await pool.query(`INSERT INTO memory_source_snapshots(snapshot_id,installation_id,repository_id,git_object_format,commit_sha,manifest_hash,state,generation,parser_matrix_version,file_count,byte_count)
      VALUES($1,$2,$3,'sha1',$4,$5,'ready',1,'fixture',0,0)`,[sourceSnapshotId,f.installationId,f.repositoryId,'a'.repeat(40),'a'.repeat(64)])
    expect(await f.lifecycle.purgeSourceSnapshot({installationId:f.installationId,snapshotId:sourceSnapshotId,reasonCode:'fixture'})).toEqual({purged:true})
    await noContent()
    expect((await pool.query(`SELECT 1 FROM work_episodes WHERE episode_id=$1`,[f.episodeId])).rowCount).toBe(1)
    await expect(createSkillAdmissionService({pool,context}).schedule({...f.author,candidateKey:'retry',source:{kind:'episode',episodeId:f.episodeId}})).rejects.toMatchObject({code:'skill_snapshot_invalid'})
  })
  test.each(['pending','reviewed'] as const)('purging an old snapshot preserves the %s generation on another snapshot',async state=>{
    const f=await fixture(),snapshotB=randomUUID(),episodeB=randomUUID(),sourceSnapshotId=randomUUID()
    await pool.query(`INSERT INTO repo_snapshots(installation_id,repo_snapshot_id,repository_id,commit_sha,observed_at)
      VALUES($1,$2,$3,$4,NOW())`,[f.installationId,snapshotB,f.repositoryId,'b'.repeat(40)])
    await pool.query(`INSERT INTO work_episodes SELECT (jsonb_populate_record(NULL::work_episodes,to_jsonb(e)||
      jsonb_build_object('episode_id',$2::text,'turn_id',$2::text,'repo_snapshot_id',$3::text))).*
      FROM work_episodes e WHERE e.episode_id=$1`,[f.episodeId,episodeB,snapshotB])
    const next=await createSkillAdmissionService({pool,context}).schedule({...f.author,candidateKey:'method',source:{kind:'episode',episodeId:episodeB}})
    const review=createSkillReviewService({pool,context})
    async function generateNext() {
      const job=(await createJobRepository(pool).claimJobs({workerId:'snapshot-regression',limit:1,leaseMs:30000}))[0]!
      expect(job.job_id).toBe(next.jobId)
      const provider={generateJson:async()=>({ok:true,value:skillFixtureDocument(),usage:{inputTokens:1,outputTokens:1,model:'fixture'}})} as TextGenerator
      await createSkillWorker({pool,context,generator:createSkillGenerator({provider,timeoutMs:100})}).handle(job,new AbortController().signal,
        {fence:{jobId:job.job_id,claimedBy:'snapshot-regression',claimEpoch:job.claim_epoch}})
      return (await pool.query(`SELECT candidate_id FROM memory_skill_candidates WHERE task_id=$1 AND generation=2`,[next.taskId])).rows[0].candidate_id
    }
    let reviewedVersion:string|undefined
    if(state==='reviewed') {
      const candidateId=await generateNext()
      const draft=await review.execute(f.author,{action:'draft',candidateId,expectedRevision:f.draft.revision})
      reviewedVersion=(await review.execute(f.author,{action:'approve',skillId:draft.skillId,expectedRevision:draft.revision})).versionId
    }
    await pool.query(`INSERT INTO memory_source_snapshots(snapshot_id,installation_id,repository_id,git_object_format,commit_sha,manifest_hash,state,generation,parser_matrix_version,file_count,byte_count)
      VALUES($1,$2,$3,'sha1',$4,$5,'ready',1,'fixture',0,0)`,[sourceSnapshotId,f.installationId,f.repositoryId,'a'.repeat(40),'a'.repeat(64)])
    await f.lifecycle.purgeSourceSnapshot({installationId:f.installationId,snapshotId:sourceSnapshotId,reasonCode:'fixture'})
    expect((await pool.query(`SELECT current_generation::int,state FROM memory_skill_tasks WHERE task_id=$1`,[next.taskId])).rows)
      .toEqual([{current_generation:2,state:state==='pending'?'pending':'candidate'}])
    expect((await pool.query(`SELECT 1 FROM memory_skill_archives WHERE repo_snapshot_id=$1`,[f.snapshotId])).rowCount).toBe(0)
    if(state==='pending') {
      expect((await pool.query(`SELECT state FROM memory_jobs WHERE job_id=$1`,[next.jobId])).rows).toEqual([{state:'pending'}])
      await generateNext()
    } else {
      expect((await pool.query(`SELECT current_version_id,state,revision::int FROM memory_skill_heads WHERE skill_id=$1`,[f.draft.skillId])).rows)
        .toEqual([{current_version_id:reviewedVersion,state:'reviewed',revision:3}])
    }
    expect((await pool.query(`SELECT repo_snapshot_id FROM memory_skill_archives WHERE task_id=$1`,[next.taskId])).rows).toEqual([{repo_snapshot_id:snapshotB}])
    await expect(createSkillAdmissionService({pool,context}).schedule({...f.author,candidateKey:'retry',source:{kind:'episode',episodeId:f.episodeId}})).rejects.toMatchObject({code:'skill_snapshot_invalid'})
  })
  test('Claim expiration and supersession clear dependent content',async()=>{
    const f=await fixture('team')
    await pool.query(`UPDATE knowledge_versions SET valid_until=NOW()-interval '1 second' WHERE installation_id=$1`,[f.installationId])
    const before=(await pool.query(`SELECT revision::int FROM knowledge_claims WHERE installation_id=$1`,[f.installationId])).rows[0].revision
    expect(await f.lifecycle.expireSources()).toBe(1)
    await noContent()
    expect((await pool.query(`SELECT revision::int FROM knowledge_claims WHERE installation_id=$1`,[f.installationId])).rows[0].revision).toBe(before+1)
    expect((await pool.query(`SELECT 1 FROM memory_feedback WHERE installation_id=$1 AND action='claim_expired'`,[f.installationId])).rowCount).toBe(1)
    expect(await f.lifecycle.expireSources()).toBe(0)
  })
  test('snapshot purge cancels an in-flight generation and fences late Provider output',async()=>{
    const f=await fixture(),snapshotId=randomUUID()
    await pool.query(`INSERT INTO memory_source_snapshots(snapshot_id,installation_id,repository_id,git_object_format,commit_sha,manifest_hash,state,generation,parser_matrix_version,file_count,byte_count)
      VALUES($1,$2,$3,'sha1',$4,$5,'ready',1,'fixture',0,0)`,[snapshotId,f.installationId,f.repositoryId,'a'.repeat(40),'a'.repeat(64)])
    const task=await createSkillAdmissionService({pool,context}).schedule({...f.author,candidateKey:'in-flight',source:{kind:'episode',episodeId:f.episodeId}})
    const job=(await createJobRepository(pool).claimJobs({workerId:'snapshot-in-flight',limit:1,leaseMs:30000}))[0]!
    const provider={generateJson:async()=>{
      await f.lifecycle.purgeSourceSnapshot({installationId:f.installationId,snapshotId,reasonCode:'fixture'})
      return {ok:true,value:skillFixtureDocument(),usage:{inputTokens:1,outputTokens:1,model:'fixture'}}
    }} as TextGenerator
    const worker=createSkillWorker({pool,context,generator:createSkillGenerator({provider,timeoutMs:100})})
    await expect(worker.handle(job,new AbortController().signal,{fence:{jobId:job.job_id,claimedBy:'snapshot-in-flight',claimEpoch:job.claim_epoch}})).rejects.toThrow()
    await noContent()
    expect((await pool.query(`SELECT state FROM memory_skill_tasks WHERE task_id=$1`,[task.taskId])).rows).toEqual([{state:'cancelled'}])
    expect((await pool.query(`SELECT r.state,g.state AS generation_state FROM memory_skill_task_runs r JOIN memory_generation_runs g ON g.run_id=r.generation_run_id WHERE r.task_id=$1`,[task.taskId])).rows)
      .toEqual([{state:'cancelled',generation_state:'cancelled'}])
    expect((await pool.query(`SELECT state FROM memory_jobs WHERE job_id=$1`,[job.job_id])).rows).toEqual([{state:'completed'}])
  })
  test('removing one governed evidence source invalidates the entire Skill',async()=>{
    await fixture('team')
    await pool.query(`DELETE FROM knowledge_evidence`)
    await noContent()
  })
  test('scope loss while a Provider is running fences late output and a restarted worker',async()=>{
    const f=await fixture('team')
    const source=(await pool.query(`SELECT claim_version_id FROM memory_skill_archives WHERE installation_id=$1`,[f.installationId])).rows[0]
    await createSkillAdmissionService({pool,context}).schedule({...f.author,candidateKey:'second-method',source:{kind:'claim_version',versionId:source.claim_version_id,repositoryId:f.repositoryId,repoSnapshotId:f.snapshotId}})
    const job=(await createJobRepository(pool).claimJobs({workerId:'late-scope',limit:1,leaseMs:30000}))[0]
    const call=vi.fn(async()=>{
      await pool.query(`UPDATE memory_owner_scopes SET state='dissolved',authorization_epoch=2 WHERE installation_id=$1`,[f.installationId])
      return {ok:true as const,value:skillFixtureDocument(),usage:{inputTokens:1,outputTokens:1,model:'fixture'}}
    })
    const worker=()=>createSkillWorker({pool,context,generator:createSkillGenerator({provider:{generateJson:call} as TextGenerator,timeoutMs:1000})})
    const options={fence:{jobId:job.job_id,claimedBy:'late-scope',claimEpoch:job.claim_epoch}}
    await expect(worker().handle(job,new AbortController().signal,options)).rejects.toThrow()
    await expect(worker().handle(job,new AbortController().signal,options)).rejects.toThrow()
    expect(call).toHaveBeenCalledTimes(1)
    await noContent()
  })
  test('dissolution Feed replay after projector restart cannot restore Skill content; ACK sees committed invalidation',async()=>{
    const f=await fixture('team'),lags:number[]=[]
    let items:ExtensionScopeFeedEnvelopeV2[]=[{envelope_version:2,feed_id:'2',topic:'scope.lifecycle.v2',
      owner_scope:{kind:'team',id:f.installationId,authorization_epoch:'2'},source:{kind:'scope_lifecycle',id:f.installationId,recorded_at:new Date().toISOString()},
      subject:{event_type:'scope_dissolved'},classification:{},data:{state:'dissolved'}}]
    const ack=vi.fn(async()=>{await noContent();return 1})
    const factory=()=>createScopeControlProjector({pool,workerId:'fixture-restart',pullScopeControlFeed:async()=>({installation_id:f.installationId,items,next_cursor:'fixture',lease_token:'fixture',lease_expires_at:new Date(Date.now()+30000).toISOString()}),ackScopeControlFeed:ack,onScopeInvalidated:lag=>lags.push(lag)})
    expect(await factory().consumeInstallation(f.installationId)).toMatchObject({projected:1})
    items=[{...items[0],feed_id:'1',owner_scope:{...items[0].owner_scope,authorization_epoch:'1'},subject:{event_type:'scope_resumed'},data:{state:'active'}}]
    expect(await factory().consumeInstallation(f.installationId)).toMatchObject({projected:0,skipped:1})
    await noContent();expect(ack).toHaveBeenCalledTimes(2);expect(lags).toHaveLength(1)
    expect((await pool.query(`SELECT state FROM memory_owner_scopes WHERE installation_id=$1`,[f.installationId])).rows[0].state).toBe('dissolved')
  })
})
