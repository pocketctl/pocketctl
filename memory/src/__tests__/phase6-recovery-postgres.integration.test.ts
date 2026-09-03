import pg from 'pg'
import { afterAll,beforeAll,beforeEach,describe,expect,test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { gitExportFixture } from '../testing/phase6-export-fixture.js'
import { attestationFixture } from '../testing/phase6-attestation-fixture.js'
import { createGitExportService } from '../git-sync/export-service.js'
import { createDatabaseAttestationRegistry } from '../git-sync/key-registry.js'
import { createGitInboxService } from '../git-sync/inbox-service.js'
import { createGitSyncWorker } from '../git-sync/worker.js'
import { createJobRepository } from '../jobs/repository.js'
import { loadGitSyncConfig } from '../git-sync/config.js'
import { fixtureGitWriter } from '../testing/phase6-write-fixture.js'
import { fixtureGitServer } from '../testing/phase6-provider-server.js'

const url=process.env.MEMORY_TEST_DATABASE_URL,db=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
db('Phase 6 retained metadata recovery with fresh authority',()=>{
  let pool:pg.Pool
  beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:12});await assertMemoryTestDatabase(pool,url!)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await applyMemorySchema(pool)},60_000)
  beforeEach(async()=>{await pool.query('TRUNCATE memory_installations,memory_git_attestation_keys CASCADE')})
  afterAll(async()=>{await pool?.end()})
  async function setup(provider:'github'|'gitee'='github',loss:'pull'|'file'='pull',purgeAt:'after'|'before'|'during'='after',terminal?:'cancelled'|'dead'|'closed'){
    const f=await gitExportFixture(pool),fixture=attestationFixture(),keys=createDatabaseAttestationRegistry({pool,signer:fixture.registry.signingKey()});await keys.registerSigner()
    await pool.query('UPDATE memory_git_connections SET provider=$2 WHERE connection_id=$1',[f.connectionId,provider])
    const generation=(await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[f.connectionId])).rows[0].generation
    const config=loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'shadow'}),deps={pool,config,keys,skill:{context:f.skill.context,cases:f.skill.cases},scopeMode:async()=> 'shadow' as const,outcomeKind:'fixture' as const}
    const service=createGitExportService(deps),bundle=await service.export(f.grant,{installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:generation,baseCommit:'a'.repeat(40),purpose:'external_export',assets:f.keys.filter(k=>k.kind==='rule')})
    const inbox=createGitInboxService(deps),subject={installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:generation,exportId:bundle.exportId}
    await inbox.enroll(f.grant,subject);const queued=await inbox.receive(subject,{source:'export',eventId:'outgoing',changeNumber:'1'})
    const server=fixtureGitServer(provider),cap=fixtureGitWriter(provider,{providerRepositoryId:'123',owner:'example',repository:'knowledge',private:true,branch:'main'},e=>server.request(e))
    const jobs=createJobRepository(pool)
    async function invoke(worker:ReturnType<typeof createGitSyncWorker>){const [job]=await jobs.claimJobs({workerId:'recovery-test',limit:1,leaseMs:30_000});expect(job).toBeDefined()
      await worker.handle(job,new AbortController().signal,{fence:{jobId:job.job_id,claimedBy:'recovery-test',claimEpoch:job.claim_epoch}})}
    if(purgeAt==='before')await pool.query('DELETE FROM knowledge_evidence WHERE version_id=$1',[f.rule.versionId])
    if(purgeAt==='during')server.afterMutation(async()=>{if(server.pulls.length)await pool.query('DELETE FROM knowledge_evidence WHERE version_id=$1',[f.rule.versionId])})
    server.loseNext(loss)
    if(purgeAt==='before'){
      const job=(await pool.query('SELECT * FROM memory_jobs WHERE job_id=$1',[queued.jobId])).rows[0]
      await createGitSyncWorker({...deps,fixtureWrites:{resolve:async()=>cap}}).handle(job,new AbortController().signal,{fence:{jobId:job.job_id,claimedBy:'old-worker',claimEpoch:job.claim_epoch}})
    }else await invoke(createGitSyncWorker({...deps,fixtureWrites:{resolve:async()=>cap}}))
    expect(server.pulls).toHaveLength(purgeAt==='before'||loss==='file'?0:1)
    if(terminal){
      await pool.query('UPDATE memory_git_runs SET state=$2 WHERE run_id=$1',[queued.runId,terminal])
      await pool.query('UPDATE memory_git_run_receipts SET state=$2,unfinished=$3 WHERE run_id=$1',[queued.runId,terminal==='closed'?'planned':terminal,terminal!=='closed'])
    }
    await pool.query('DELETE FROM knowledge_evidence WHERE version_id=$1',[f.rule.versionId])
    const fresh=await f.skill.actor(['scope_administrator'],['read','contribute','review','publish','scope_admin'])
    const request={...subject,expectedGeneration:(await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[f.connectionId])).rows[0].generation,idempotencyKey:'reconcile-one'}
    const reads={resolve:async()=>({kind:'fixture' as const,provider,target:cap.target,request:cap.request})}
    return {f,deps,queued,server,cap,invoke,request,fresh,reads}
  }
  test('source deletion keeps unknown PR identity and unfinished charged denominator before cascade',async()=>{
    const s=await setup()
    expect((await pool.query('SELECT cleanup_pending,expected_commit,expected_tree,description_hash FROM memory_git_remote_cleanup')).rows[0])
      .toMatchObject({cleanup_pending:true,expected_commit:expect.stringMatching(/^[a-f0-9]{40}$/),expected_tree:expect.stringMatching(/^[a-f0-9]{40}$/),description_hash:expect.stringMatching(/^[a-f0-9]{64}$/)})
    expect((await pool.query('SELECT unfinished,attempts FROM memory_git_run_receipts WHERE run_id=$1',[s.queued.runId])).rows[0]).toMatchObject({unfinished:true,attempts:expect.any(Number)})
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_snapshots')).rows[0].n).toBe(0)
  })
  test.each(['cancelled','dead','closed'] as const)('recovery never revives an old %s run',async terminal=>{
    const s=await setup('github','pull','after',terminal),{createGitRecoveryService}=await import('../git-sync/recovery-service.js')
    const current=await createGitRecoveryService({...s.deps,recoveryReads:s.reads}).admit(s.fresh.grant,s.request)
    await s.invoke(createGitSyncWorker({...s.deps,recoveryReads:s.reads}))
    expect(current.runId).not.toBe(s.queued.runId)
    // The old body-dependent run is physically cascaded, never recreated. Its
    // durable receipt preserves the terminal state/denominator instead.
    expect((await pool.query('SELECT state,grant_facts FROM memory_git_runs WHERE run_id=$1',[s.queued.runId])).rows).toEqual([])
    expect((await pool.query('SELECT state,unfinished FROM memory_git_run_receipts WHERE run_id=$1',[s.queued.runId])).rows[0]).toEqual({state:terminal==='closed'?'planned':terminal,unfinished:terminal!=='closed'})
  })
  test.each(['before','during'] as const)('source purge %s dispatch fences all later content writes',async order=>{
    const s=await setup('github','pull',order),calls=s.server.calls.length
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_snapshot_assets')).rows[0].n).toBe(0)
    if(order==='before')expect(calls).toBe(0)
    else expect((await pool.query('SELECT cleanup_pending FROM memory_git_remote_cleanup')).rows[0].cleanup_pending).toBe(true)
    const old=(await pool.query('SELECT * FROM memory_jobs WHERE job_id=$1',[s.queued.jobId])).rows[0]
    await createGitSyncWorker({...s.deps,fixtureWrites:{resolve:async()=>s.cap}}).handle(old,new AbortController().signal,{fence:{jobId:old.job_id,claimedBy:'old-worker',claimEpoch:old.claim_epoch}})
    expect(s.server.calls).toHaveLength(calls)
  })
  test('partial Gitee write keeps expected per-file hashes after source deletion and does not invent a final commit',async()=>{
    const s=await setup('gitee','file'),before=s.server.calls.length
    const table=(await pool.query("SELECT to_regclass('memory_git_retained_steps') AS name")).rows[0].name
    const rows=table?(await pool.query("SELECT expected_head,expected_blob,expected_content_blob,expected_tree FROM memory_git_retained_steps WHERE operation='file'")).rows:[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({expected_head:expect.stringMatching(/^[a-f0-9]{40}$/),expected_blob:null,expected_content_blob:expect.stringMatching(/^[a-f0-9]{40}$/),expected_tree:expect.stringMatching(/^[a-f0-9]{40}$/)})
    const {createGitRecoveryService}=await import('../git-sync/recovery-service.js')
    await expect(createGitRecoveryService({...s.deps,recoveryReads:s.reads}).admit(s.fresh.grant,s.request)).rejects.toThrow('reconcile_unverifiable')
    expect(s.server.calls).toHaveLength(before)
    expect((await pool.query('SELECT cleanup_pending,expected_commit FROM memory_git_remote_cleanup')).rows[0]).toEqual({cleanup_pending:true,expected_commit:null})
  })
  test('new authorized run recognizes lost PR through five reserved reads without reviving old run or content',async()=>{
    const s=await setup(),before=s.server.calls.length
    const mod=await import('../git-sync/recovery-service.js').catch(()=>null)
    expect(mod?.createGitRecoveryService,'durable recovery admission exists').toBeTypeOf('function')
    const recovery=mod!.createGitRecoveryService({...s.deps,recoveryReads:s.reads})
    const result=await recovery.admit(s.fresh.grant,s.request)
    expect(result.runId).not.toBe(s.queued.runId)
    const worker=createGitSyncWorker({...s.deps,recoveryReads:s.reads})
    await s.invoke(worker)
    expect(s.server.calls.slice(before)).toHaveLength(5)
    expect(s.server.calls.slice(before).every(c=>c.method==='GET')).toBe(true)
    expect((await pool.query('SELECT state,export_id,http_attempts FROM memory_git_runs WHERE run_id=$1',[result.runId])).rows[0]).toEqual({state:'closed',export_id:null,http_attempts:5})
    expect((await pool.query('SELECT state FROM memory_git_run_receipts WHERE run_id=$1',[s.queued.runId])).rows[0].state).toBe('invalidated')
    expect((await pool.query('SELECT cleanup_pending,remote_pr_id,recognized_run_id FROM memory_git_remote_cleanup')).rows[0]).toEqual({cleanup_pending:true,remote_pr_id:'1',recognized_run_id:result.runId})
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_snapshots')).rows[0].n).toBe(0)
    expect(await recovery.admit(s.fresh.grant,s.request)).toMatchObject({runId:result.runId,duplicate:true})
  })
  test.each(['off','state'])('direct %s then re-enable cannot reuse an old-generation reconciliation receipt',async transition=>{
    const s=await setup(),{createGitRecoveryService}=await import('../git-sync/recovery-service.js')
    const recovery=createGitRecoveryService({...s.deps,recoveryReads:s.reads}),old=await recovery.admit(s.fresh.grant,s.request)
    if(transition==='off')await pool.query("UPDATE memory_git_connections SET sync_mode='off' WHERE connection_id=$1",[s.f.connectionId])
    else await pool.query("UPDATE memory_git_connections SET state='disabled' WHERE connection_id=$1",[s.f.connectionId])
    expect((await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation).toBe('3')
    await pool.query("UPDATE memory_git_connections SET sync_mode='shadow',state='active' WHERE connection_id=$1",[s.f.connectionId])
    await expect(recovery.admit(s.fresh.grant,s.request)).rejects.toThrow('git_generation_conflict')
    const generation=(await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation
    const fresh=await recovery.admit(s.fresh.grant,{...s.request,expectedGeneration:generation})
    expect(fresh).toMatchObject({duplicate:false});expect(fresh.runId).not.toBe(old.runId)
    await s.invoke(createGitSyncWorker({...s.deps,recoveryReads:s.reads}))
    expect((await pool.query('SELECT state FROM memory_git_runs WHERE run_id=$1',[old.runId])).rows[0].state).toBe('invalidated')
    expect((await pool.query('SELECT recognized_run_id,cleanup_pending FROM memory_git_remote_cleanup')).rows[0]).toEqual({recognized_run_id:fresh.runId,cleanup_pending:true})
  })
  test('no exact remote proof never reports reconciliation success',async()=>{
    const s=await setup(),{createGitRecoveryService}=await import('../git-sync/recovery-service.js')
    const reads={resolve:async()=>({kind:'fixture' as const,provider:'github' as const,target:s.cap.target,request:async(request:any,signal:AbortSignal)=>
      request.action==='branch'?{status:404,headers:{},body:{}}:s.cap.request(request,signal)})}
    const run=await createGitRecoveryService({...s.deps,recoveryReads:reads}).admit(s.fresh.grant,s.request)
    await s.invoke(createGitSyncWorker({...s.deps,recoveryReads:reads}))
    expect((await pool.query('SELECT reason_code FROM memory_git_run_receipts WHERE run_id=$1',[run.runId])).rows[0].reason_code).toBe('remote_unconfirmed')
    expect((await pool.query('SELECT recognized_at,cleanup_pending FROM memory_git_remote_cleanup')).rows[0]).toEqual({recognized_at:null,cleanup_pending:true})
  })
  test.each(['member','scope','installation','consent'])('missing current %s admits no recovery requests and leaves cleanup pending',async missing=>{
    const s=await setup(),before=s.server.calls.length,mod=await import('../git-sync/recovery-service.js').catch(()=>null)
    expect(mod?.createGitRecoveryService).toBeTypeOf('function')
    if(missing==='member')await pool.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1",[s.fresh.membershipId])
    if(missing==='scope')await pool.query("UPDATE memory_owner_scopes SET state='suspended' WHERE installation_id=$1",[s.f.installationId])
    if(missing==='installation')await pool.query("UPDATE memory_installations SET local_status='purged' WHERE installation_id=$1",[s.f.installationId])
    const service=mod!.createGitRecoveryService({...s.deps,recoveryReads:missing==='consent'?{resolve:async()=>null}:s.reads})
    await expect(service.admit(s.fresh.grant,s.request)).rejects.toThrow()
    expect(s.server.calls).toHaveLength(before)
    expect((await pool.query('SELECT cleanup_pending FROM memory_git_remote_cleanup')).rows[0].cleanup_pending).toBe(true)
  })
  test.each(['consent','lease','generation'])('withdrawn %s during reconciliation prevents proof finalization and body revival',async loss=>{
    const s=await setup(),mod=await import('../git-sync/recovery-service.js'),before=s.server.calls.length
    let consent=true,runId=''
    const reads={resolve:async()=>consent?{kind:'fixture' as const,provider:'github' as const,target:s.cap.target,request:async(request:any,signal:AbortSignal)=>{
      const result=await s.cap.request(request,signal)
      if(request.action==='repository'){
        if(loss==='consent')consent=false
        if(loss==='lease')await pool.query("UPDATE memory_jobs SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=(SELECT job_id FROM memory_git_runs WHERE run_id=$1)",[runId])
        if(loss==='generation')await pool.query('UPDATE memory_git_connections SET generation=generation+1 WHERE connection_id=$1',[s.f.connectionId])
      }
      return result
    }}:null}
    const recovery=mod.createGitRecoveryService({...s.deps,recoveryReads:reads}),run=await recovery.admit(s.fresh.grant,s.request);runId=run.runId
    await s.invoke(createGitSyncWorker({...s.deps,recoveryReads:reads}))
    expect(s.server.calls.slice(before)).toHaveLength(1)
    expect((await pool.query('SELECT recognized_at,cleanup_pending FROM memory_git_remote_cleanup')).rows[0]).toEqual({recognized_at:null,cleanup_pending:true})
    expect((await pool.query('SELECT attempts FROM memory_git_run_receipts WHERE run_id=$1',[runId])).rows[0].attempts).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_snapshot_assets')).rows[0].n).toBe(0)
  })
  test('recovery respects shared dispatcher gate and the existing maximum request budget',async()=>{
    const s=await setup(),mod=await import('../git-sync/recovery-service.js'),before=s.server.calls.length
    const recovery=mod.createGitRecoveryService({...s.deps,recoveryReads:s.reads}),run=await recovery.admit(s.fresh.grant,s.request)
    const gate=await pool.connect();await gate.query("SELECT pg_advisory_lock(hashtextextended('memory:git:dispatcher',0))")
    try{await s.invoke(createGitSyncWorker({...s.deps,recoveryReads:s.reads}));expect(s.server.calls).toHaveLength(before)}
    finally{await gate.query("SELECT pg_advisory_unlock(hashtextextended('memory:git:dispatcher',0))");gate.release()}
    await pool.query('UPDATE memory_git_runs SET http_attempts=128,next_attempt_at=NOW() WHERE run_id=$1',[run.runId])
    await pool.query('UPDATE memory_jobs SET available_at=NOW() WHERE job_id=$1',[run.jobId])
    await s.invoke(createGitSyncWorker({...s.deps,recoveryReads:s.reads}))
    expect(s.server.calls).toHaveLength(before)
    expect((await pool.query('SELECT state FROM memory_git_runs WHERE run_id=$1',[run.runId])).rows[0].state).toBe('dead')
  })
})
