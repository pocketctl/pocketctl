import pg from 'pg'
import { afterAll,beforeAll,beforeEach,describe,expect,test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { gitExportFixture } from '../testing/phase6-export-fixture.js'
import { attestationFixture } from '../testing/phase6-attestation-fixture.js'
import { changeMetadata } from '../testing/phase6-fixtures.js'
import { createGitExportService } from '../git-sync/export-service.js'
import { createGitInboxService } from '../git-sync/inbox-service.js'
import { createGitSyncWorker } from '../git-sync/worker.js'
import { createJobRepository } from '../jobs/repository.js'
import { createJobWorker } from '../jobs/worker.js'
import { randomUUID } from 'node:crypto'
import { loadGitSyncConfig } from '../git-sync/config.js'
import type { GitReadCapability } from '../git-sync/provider.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const db=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
db('Phase 6 bounded Git worker',()=>{
  let pool:pg.Pool
  beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:12});await assertMemoryTestDatabase(pool,url!)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await applyMemorySchema(pool)},60_000)
  beforeEach(async()=>{await pool.query('TRUNCATE memory_installations,memory_git_attestation_keys,memory_jobs CASCADE')})
  afterAll(async()=>{await pool?.end()})
  async function setup(env:Record<string,string>={}) {
    const f=await gitExportFixture(pool),key=attestationFixture(),config=loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'shadow',...env})
    const deps={pool,config,scopeMode:async()=> 'enabled' as const,keys:key.registry,skill:{context:f.skill.context,cases:f.skill.cases}}
    const bundle=await createGitExportService(deps).export(f.grant,{installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',baseCommit:'a'.repeat(40),purpose:'external_export',assets:f.keys.filter(k=>k.kind==='rule')})
    const subject={installationId:f.installationId,connectionId:f.connectionId,exportId:bundle.exportId,expectedGeneration:'1'},inbox=createGitInboxService(deps)
    await inbox.enroll(f.grant,subject)
    const queued=await inbox.receive(subject,{source:'webhook',eventId:'delivery-1',changeNumber:'7'})
    const files=bundle.files.map(file=>file.path.endsWith('/manifest.yaml')?file:changeMetadata([file],v=>{if(v.key)v.editable.statement='Edited on Git'})[0])
    const requests:any[]=[]
    const response=(request:any):any=>({status:200,body:request.operation==='merge'?{providerRepositoryId:'123',number:request.number,baseBranch:'main',merged:true,mergeCommit:'b'.repeat(40),exportId:bundle.exportId,actorId:'external-author'}
      :request.operation==='commit'?{sha:'b'.repeat(40),tree:'c'.repeat(40)}
      :request.operation==='poll'?{providerRepositoryId:'123',branch:'main',changes:[{number:'7'}],nextCursor:null}
      :{commit:'b'.repeat(40),tree:'c'.repeat(40),files,nextCursor:null}})
    const target={provider:'github' as const,providerRepositoryId:'123',branch:'main',origin:'https://api.github.com'}
    let request:(r:any,s:AbortSignal)=>Promise<any>=async r=>response(r)
    const capability:GitReadCapability={kind:'fixture',target,request:async(r:any,signal:AbortSignal)=>{requests.push(r);return request(r,signal)}}
    const worker=()=>createGitSyncWorker({...deps,reads:{resolve:async()=>capability}})
    const jobs=createJobRepository(pool)
    const claim=async()=>{const [job]=await jobs.claimJobs({workerId:'git-test',limit:1,leaseMs:30_000});expect(job).toBeDefined();return job}
    const invoke=async(w=worker(),signal=new AbortController().signal)=>{const job=await claim();await w.handle(job,signal,{fence:{jobId:job.job_id,claimedBy:'git-test',claimEpoch:job.claim_epoch}});return job}
    const stored=async()=> (await pool.query('SELECT state,http_attempts,failure_count,error_code,merge_commit,tree_sha FROM memory_git_runs WHERE run_id=$1',[queued.runId])).rows[0]
    return {f,key,deps,bundle,files,subject,inbox,queued,requests,response,capability,worker,claim,invoke,stored,setRequest:(fn:typeof request)=>{request=fn}}
  }
  test('reserves each fixed-target read before dispatch and atomically commits automatic proposal/run/job',async()=>{
    const s=await setup()
    s.setRequest(async r=>{
      expect((await pool.query('SELECT count(*)::int n FROM memory_git_request_reservations')).rows[0].n).toBe(s.requests.length)
      expect(r).not.toHaveProperty('url');return s.response(r)
    })
    await s.invoke()
    expect(await s.stored()).toMatchObject({state:'planned',http_attempts:3,failure_count:0,merge_commit:'b'.repeat(40),tree_sha:'c'.repeat(40)})
    expect((await pool.query('SELECT state FROM memory_jobs WHERE job_id=$1',[s.queued.jobId])).rows).toEqual([{state:'completed'}])
    expect((await pool.query('SELECT state,run_id,provider_actor_id,membership_id FROM memory_git_import_proposals')).rows).toEqual([
      {state:'awaiting_review',run_id:s.queued.runId,provider_actor_id:'external-author',membership_id:s.f.membershipId}])
    expect((await pool.query('SELECT statement FROM knowledge_versions WHERE version_id=$1',[s.f.rule.versionId])).rows[0].statement).toBe('Synthetic statement')
    expect((await pool.query('SELECT state,eligible,unfinished,attempts FROM memory_git_run_receipts')).rows).toEqual([{state:'planned',eligible:true,unfinished:false,attempts:3}])
    expect((await pool.query('SELECT sum(response_bytes)::int bytes FROM memory_git_request_reservations')).rows[0].bytes).toBe(s.files.reduce((n,f)=>n+f.bytes.byteLength,0))
  })
  test('budget exhausted before dispatch performs zero provider calls',async()=>{
    const s=await setup({MEMORY_GIT_MAX_HTTP_ATTEMPTS:'1'})
    await pool.query('UPDATE memory_git_runs SET http_attempts=1 WHERE run_id=$1',[s.queued.runId])
    await s.invoke();expect(s.requests).toHaveLength(0)
    expect(await s.stored()).toMatchObject({state:'dead',error_code:'request_budget_exhausted'})
  })
  test('actual attempts persist limits and duration for failed retry and success metrics after purge',async()=>{
    const s=await setup({MEMORY_GIT_MAX_HTTP_ATTEMPTS:'4',MEMORY_GIT_MAX_TOTAL_BYTES:'65536'})
    const {createPhase6Metrics,updatePhase6Gauges}=await import('../metrics.js'),{Registry}=await import('prom-client')
    const snapshot=async()=>{const registry=new Registry(),metrics=createPhase6Metrics(registry);await updatePhase6Gauges(pool,metrics);return registry.getMetricsAsJSON()}
    const value=(rows:any[],name:string,labels:Record<string,string>)=>rows.find(r=>r.name===`pocketctl_memory_git_${name}`)?.values.find((v:any)=>Object.entries(labels).every(([k,x])=>v.labels[k]===x))?.value
    s.setRequest(async()=>({status:503,receivedBytes:17,retryAfterMs:1000}))
    await s.invoke()
    let rows=await snapshot()
    expect(value(rows,'request_rows',{operation:'merge',state:'failed'})).toBe(1)
    expect(value(rows,'response_bytes',{operation:'merge',state:'failed'})).toBe(17)
    expect(value(rows,'request_duration_seconds_count',{operation:'merge',state:'failed'})).toBe(1)
    expect(value(rows,'request_duration_seconds_sum',{operation:'merge',state:'failed'})).toBeGreaterThan(0)
    expect(value(rows,'budget_remaining',{unit:'requests'})).toBe(3)
    expect(value(rows,'budget_remaining',{unit:'bytes'})).toBe(65519)
    await pool.query('UPDATE memory_jobs SET available_at=NOW() WHERE job_id=$1',[s.queued.jobId])
    await pool.query('UPDATE memory_git_runs SET next_attempt_at=NOW() WHERE run_id=$1',[s.queued.runId])
    s.setRequest(async r=>({...s.response(r),receivedBytes:20}))
    await s.invoke()
    rows=await snapshot()
    expect(value(rows,'request_rows',{operation:'merge',state:'responded'})).toBe(1)
    expect(value(rows,'run_attempts',{})).toBe(4)
    expect(value(rows,'run_failures',{})).toBe(1)
    expect(value(rows,'retry_attempts',{})).toBe(1)
    const records=(await pool.query('SELECT duration_seconds,request_limit,byte_limit::int FROM memory_git_request_reservations ORDER BY attempt')).rows
    expect(records).toHaveLength(4)
    expect(records.every(r=>r.duration_seconds>0&&r.request_limit===4&&r.byte_limit===65536)).toBe(true)
    await pool.query('DELETE FROM knowledge_evidence WHERE version_id=$1',[s.f.rule.versionId])
    const retained=await snapshot()
    expect(value(retained,'run_attempts',{})).toBe(4)
    expect(value(retained,'response_bytes',{operation:'merge',state:'failed'})).toBe(17)
    expect(value(retained,'request_duration_seconds_count',{operation:'merge',state:'failed'})).toBe(1)
    expect(JSON.stringify(retained)).not.toContain(s.f.installationId)
    expect(JSON.stringify(retained)).not.toContain(s.f.connectionId)
  })
  test('last recorded headroom does not authorize a restarted worker with a tighter limit',async()=>{
    const s=await setup({MEMORY_GIT_MAX_HTTP_ATTEMPTS:'4'})
    s.setRequest(async()=>({status:503,receivedBytes:17,retryAfterMs:1000}));await s.invoke()
    const {createPhase6Metrics,updatePhase6Gauges}=await import('../metrics.js'),{Registry}=await import('prom-client')
    const registry=new Registry(),metrics=createPhase6Metrics(registry)
    await updatePhase6Gauges(pool,metrics)
    expect(await registry.metrics()).toContain('pocketctl_memory_git_budget_remaining{unit="requests"} 3')
    await pool.query("UPDATE memory_jobs SET available_at=NOW()-INTERVAL '1 second' WHERE job_id=$1",[s.queued.jobId])
    await pool.query("UPDATE memory_git_runs SET next_attempt_at=NOW()-INTERVAL '1 second' WHERE run_id=$1",[s.queued.runId])
    const tightened=createGitSyncWorker({...s.deps,config:loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'shadow',MEMORY_GIT_MAX_HTTP_ATTEMPTS:'1'}),reads:{resolve:async()=>s.capability}})
    await s.invoke(tightened)
    expect(s.requests).toHaveLength(1)
    expect(await s.stored()).toMatchObject({state:'dead',error_code:'request_budget_exhausted'})
    expect((await pool.query('SELECT request_limit FROM memory_git_request_reservations')).rows).toEqual([{request_limit:4}])
    // A prior scrape is explicitly as-of the reservation, not current capacity;
    // refresh removes terminal runs instead of inventing a new limit sample.
    await updatePhase6Gauges(pool,metrics)
    expect((await registry.getMetricsAsJSON()).find(row=>row.name==='pocketctl_memory_git_budget_remaining')?.values).toEqual([])
  })
  test('late aborted response bytes supplement accounting without replacing first terminal duration',async()=>{
    const s=await setup({MEMORY_GIT_REQUEST_TIMEOUT_MS:'20'}),{GitReadError}=await import('../git-sync/provider.js')
    let rejectLate:(reason:Error)=>void=()=>{throw new Error('request did not start')}
    s.setRequest(()=>new Promise((_resolve,reject)=>{rejectLate=reject}))
    await s.invoke()
    const first=(await pool.query('SELECT duration_seconds,state,response_bytes::int FROM memory_git_request_reservations')).rows[0]
    expect(first).toMatchObject({state:'aborted',response_bytes:0})
    expect(first.duration_seconds).toBeGreaterThan(0)
    rejectLate(new GitReadError('request_aborted',false,1000,123))
    let latest=first
    for(let i=0;i<100;i++){
      latest=(await pool.query('SELECT duration_seconds,state,response_bytes::int FROM memory_git_request_reservations')).rows[0]
      if(latest.response_bytes===123)break
      await pool.query('SELECT pg_sleep(0.01)')
    }
    expect(latest).toEqual({...first,response_bytes:123})
  })
  test('counts pagination and exactly five total failures across worker restarts, never dispatches a sixth',async()=>{
    const s=await setup();s.setRequest(async()=>({status:429,retryAfterMs:60_000}))
    for(let i=1;i<=5;i++){
      await s.invoke(s.worker());expect(await s.stored()).toMatchObject({failure_count:i,http_attempts:i,state:i===5?'dead':'received'})
      if(i<5){expect((await pool.query('SELECT available_at>NOW() AS deferred FROM memory_jobs WHERE job_id=$1',[s.queued.jobId])).rows[0].deferred).toBe(true)
        await pool.query("UPDATE memory_jobs SET available_at=NOW()-interval '1 second' WHERE job_id=$1",[s.queued.jobId])
        await pool.query('UPDATE memory_git_runs SET next_attempt_at=NOW() WHERE run_id=$1',[s.queued.runId])}
    }
    expect(s.requests).toHaveLength(5)
    expect(await createJobRepository(pool).claimJobs({workerId:'after-terminal',limit:1,leaseMs:30_000})).toHaveLength(0)
  })
  test('every tree page uses its own persistent reservation',async()=>{
    const s=await setup()
    s.setRequest(async r=>r.operation==='tree'?{status:200,body:{commit:'b'.repeat(40),tree:'c'.repeat(40),files:r.cursor?s.files.slice(1):s.files.slice(0,1),nextCursor:r.cursor?null:'second'}}:s.response(r))
    await s.invoke();expect(await s.stored()).toMatchObject({state:'planned',http_attempts:4})
    expect(s.requests.filter(r=>r.operation==='tree').map(r=>r.cursor)).toEqual([null,'second'])
  })
  test.each(['wrong_repo','missing_commit','wrong_commit','wrong_tree'])('untrusted %s provider facts cannot plan any proposal',async variant=>{
    const s=await setup();s.setRequest(async r=>{const v=s.response(r)
      if(r.operation==='merge'){if(variant==='wrong_repo')v.body.providerRepositoryId='other';if(variant==='missing_commit')delete v.body.mergeCommit}
      if(r.operation==='commit'&&variant==='wrong_commit')v.body.sha='d'.repeat(40)
      if(r.operation==='tree'&&variant==='wrong_tree')v.body.tree='d'.repeat(40)
      return v})
    await s.invoke();expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_proposals')).rows[0].n).toBe(0)
    expect((await s.stored()).state).toBe('dead')
  })
  test.each(['closed','membership','lease','abort'])('aborts in-flight request on %s and cannot finalize output',async cause=>{
    const s=await setup(),controller=new AbortController();let aborted=false
    s.setRequest(async(_r,signal)=>new Promise((resolve,reject)=>{
      signal.addEventListener('abort',()=>{aborted=true;reject(new Error('raw-provider-sensitive-error'))},{once:true})
      void (async()=>{if(cause==='closed')await pool.query("UPDATE memory_git_connections SET state='disabled' WHERE connection_id=$1",[s.f.connectionId])
        if(cause==='membership')await pool.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1",[s.f.membershipId])
        if(cause==='lease')await pool.query('UPDATE memory_jobs SET claim_epoch=claim_epoch+1 WHERE job_id=$1',[s.queued.jobId])
        if(cause==='abort')controller.abort()})().catch(reject)
    }))
    await s.invoke(s.worker(),controller.signal);expect(aborted).toBe(true)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_proposals')).rows[0].n).toBe(0)
    expect(JSON.stringify((await pool.query('SELECT error_code FROM memory_git_runs')).rows)).not.toContain('sensitive')
  })
  test('shadow refuses a live read capability and unavailable production composition stays network-free',async()=>{
    const s=await setup();s.capability.kind='live'
    await s.invoke();expect(s.requests).toHaveLength(0);expect((await s.stored()).state).toBe('dead')
  })
  test('same exact merge commit converges after a distinct delivery/change and source purge retains denominator',async()=>{
    const s=await setup();await s.invoke()
    await s.inbox.receive(s.subject,{source:'poll',eventId:'poll-another',changeNumber:'8'});await s.invoke()
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_proposals')).rows[0].n).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_merge_receipts')).rows[0].n).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_runs')).rows[0].n).toBe(1)
    await pool.query('DELETE FROM memory_git_snapshots WHERE export_id=$1',[s.bundle.exportId])
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_run_receipts')).rows[0].n).toBe(2)
  })
  test('a lost SQL dispatcher connection cancels an outstanding request',async()=>{
    const s=await setup();let aborted=false
    s.setRequest(async(_r,signal)=>new Promise((_resolve,reject)=>{
      signal.addEventListener('abort',()=>{aborted=true;reject(new Error('socket closed'))},{once:true})
      void pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database()
        AND pid<>pg_backend_pid() AND query='LISTEN memory_git_cancel'`).catch(reject)
    }))
    await s.invoke();expect(aborted).toBe(true)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_proposals')).rows[0].n).toBe(0)
  })
  test('shared dispatcher serializes separate workers and busy claims do not consume failure budget',async()=>{
    const s=await setup();let release!:()=>void,entered!:()=>void
    const started=new Promise<void>(resolve=>{entered=resolve}),block=new Promise<void>(resolve=>{release=resolve})
    s.setRequest(async r=>{if(s.requests.length===1){entered();await block}return s.response(r)})
    const a=s.invoke();await started
    const second=await s.inbox.receive(s.subject,{source:'webhook',eventId:'parallel-2',changeNumber:'8'})
    await s.invoke(s.worker());expect(s.requests).toHaveLength(1)
    expect((await pool.query('SELECT failure_count,http_attempts FROM memory_git_runs WHERE run_id=$1',[second.runId])).rows[0]).toEqual({failure_count:0,http_attempts:0})
    release();await a
  })
  test('deadline and expired lease deny dispatch, even when the epoch was not reclaimed',async()=>{
    const s=await setup();await pool.query("UPDATE memory_git_runs SET expires_at=clock_timestamp()-interval '1 second' WHERE run_id=$1",[s.queued.runId])
    await s.invoke();expect(s.requests).toHaveLength(0);expect((await s.stored()).error_code).toBe('run_expired')
    const second=await setup(),claim=await second.claim()
    await pool.query("UPDATE memory_jobs SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",[claim.job_id])
    await second.worker().handle(claim,new AbortController().signal,{fence:{jobId:claim.job_id,claimedBy:'git-test',claimEpoch:claim.claim_epoch}})
    expect(second.requests).toHaveLength(0)
    expect(await createJobRepository(pool).completeJob({jobId:claim.job_id,claimedBy:'git-test',claimEpoch:claim.claim_epoch})).toBe(false)
    expect((await pool.query('SELECT state FROM memory_jobs WHERE job_id=$1',[claim.job_id])).rows[0].state).toBe('pending')
  })
  test('bounded timeout aborts even an adapter that ignores its AbortSignal',async()=>{
    const s=await setup({MEMORY_GIT_REQUEST_TIMEOUT_MS:'25'});let signal:AbortSignal|undefined
    s.setRequest(async(_r,incoming)=>{signal=incoming;return new Promise(()=>undefined)})
    await s.invoke();expect(signal?.aborted).toBe(true)
    expect(await s.stored()).toMatchObject({failure_count:1,http_attempts:1,error_code:'request_timeout'})
  })
  test('crash after remote response before final commit leaves no partial proposal and restart retains request charges',async()=>{
    const s=await setup()
    await pool.query(`CREATE FUNCTION fail_git_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.job_type='git_ingest' AND NEW.state='completed' THEN RAISE EXCEPTION 'fixture_commit_crash'; END IF;RETURN NEW;END $$`)
    await pool.query('CREATE TRIGGER fail_git_complete BEFORE UPDATE ON memory_jobs FOR EACH ROW EXECUTE FUNCTION fail_git_complete()')
    try{await s.invoke()}finally{await pool.query('DROP TRIGGER fail_git_complete ON memory_jobs; DROP FUNCTION fail_git_complete()')}
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_proposals')).rows[0].n).toBe(0)
    // Exact merge identity is durable before tree/planning; output still rolls back.
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_merge_receipts')).rows[0].n).toBe(1)
    expect(await s.stored()).toMatchObject({http_attempts:3,failure_count:1})
    await pool.query('UPDATE memory_jobs SET available_at=NOW() WHERE job_id=$1',[s.queued.jobId]);await pool.query('UPDATE memory_git_runs SET next_attempt_at=NOW() WHERE run_id=$1',[s.queued.runId])
    await s.invoke(s.worker());expect(await s.stored()).toMatchObject({http_attempts:6,state:'planned'})
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_proposals')).rows[0].n).toBe(1)
  })
  test('resume preserves a committed reservation from a crash before dispatch',async()=>{
    const s=await setup({MEMORY_GIT_MAX_HTTP_ATTEMPTS:'1'})
    await pool.query(`INSERT INTO memory_git_request_reservations(reservation_id,installation_id,run_id,attempt,job_id,claim_epoch,operation)
      VALUES(gen_random_uuid(),$1,$2,1,$3,1,'merge')`,[s.f.installationId,s.queued.runId,s.queued.jobId])
    await pool.query('UPDATE memory_git_runs SET http_attempts=1 WHERE run_id=$1',[s.queued.runId])
    await pool.query('UPDATE memory_git_run_receipts SET attempts=1 WHERE run_id=$1',[s.queued.runId])
    await s.invoke(s.worker());expect(s.requests).toHaveLength(0)
    expect((await pool.query('SELECT state,attempt FROM memory_git_request_reservations')).rows).toEqual([{state:'reserved',attempt:1}])
    expect((await s.stored()).state).toBe('dead')
  })
  test('poll checkpoint and child admission commit together and restart starts from saved cursor',async()=>{
    const s=await setup();await s.invoke()
    await s.inbox.poll(s.subject)
    let round=0
    s.setRequest(async r=>{if(r.operation!=='poll')return r.operation==='merge'&&r.number==='8'
      ?{status:200,body:{providerRepositoryId:'123',number:'8',baseBranch:'main',merged:false,exportId:s.bundle.exportId,actorId:null}}:s.response(r)
      round++;if(round===1)return {status:200,body:{providerRepositoryId:'123',branch:'main',changes:[{number:'8'}],nextCursor:'checkpoint-2'}}
      if(round===2)return {status:503}
      return {status:200,body:{providerRepositoryId:'123',branch:'main',changes:[{number:'8'}],nextCursor:null}}
    })
    await s.invoke()
    expect((await pool.query('SELECT cursor FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].cursor).toBe('checkpoint-2')
    expect((await pool.query("SELECT count(*)::int n FROM memory_git_runs WHERE change_number='8'")).rows[0].n).toBe(1)
    await s.invoke() // Child observes not merged while the poll run is backing off.
    expect((await pool.query("SELECT state FROM memory_git_runs WHERE change_number='8'")).rows[0].state).toBe('closed')
    await pool.query("UPDATE memory_jobs SET available_at=NOW()+interval '1 hour' WHERE job_type='git_ingest' AND state='pending'")
    await pool.query("UPDATE memory_jobs SET available_at=NOW() WHERE job_type='git_reconcile'");await pool.query("UPDATE memory_git_runs SET next_attempt_at=NOW() WHERE change_number IS NULL")
    await s.invoke(s.worker())
    expect(s.requests.filter(r=>r.operation==='poll').map(r=>r.cursor)).toEqual([null,'checkpoint-2','checkpoint-2'])
    expect((await pool.query('SELECT state FROM memory_git_runs WHERE change_number IS NULL')).rows[0].state).toBe('planned')
    expect((await pool.query("SELECT count(*)::int n FROM memory_git_runs WHERE change_number='8'")).rows[0].n).toBe(1)
  })
  test('verified eligible failure stays in the denominator when source content is purged',async()=>{
    const s=await setup();s.setRequest(async r=>r.operation==='tree'?{status:503}:s.response(r));await s.invoke()
    expect((await pool.query('SELECT eligible,unfinished,failures FROM memory_git_run_receipts')).rows[0]).toEqual({eligible:true,unfinished:true,failures:1})
    await pool.query('DELETE FROM memory_git_snapshots WHERE export_id=$1',[s.bundle.exportId])
    expect((await pool.query('SELECT eligible,unfinished,failures FROM memory_git_run_receipts')).rows[0]).toEqual({eligible:true,unfinished:true,failures:1})
  })
  test('export job creates only a registered local preview and makes no provider requests',async()=>{
    const s=await setup();await s.invoke();s.requests.length=0
    await s.inbox.receive(s.subject,{source:'export',eventId:'export-preview',changeNumber:'7'})
    await s.invoke();expect(s.requests).toHaveLength(0)
    expect((await pool.query("SELECT state FROM memory_git_runs WHERE direction='export'")).rows).toEqual([{state:'planned'}])
  })
  test('normal premerge observations end without blocking a later exact merge delivery',async()=>{
    const s=await setup();s.setRequest(async r=>r.operation==='merge'?{status:200,body:{providerRepositoryId:'123',number:'7',baseBranch:'main',merged:false,exportId:s.bundle.exportId,actorId:null}}:s.response(r))
    await s.invoke();expect(await s.stored()).toMatchObject({state:'closed',failure_count:0,http_attempts:1})
    await pool.query('DELETE FROM memory_jobs WHERE job_id=$1',[s.queued.jobId])
    expect((await s.inbox.receive(s.subject,{source:'webhook',eventId:'delivery-1',changeNumber:'7'})).duplicate).toBe(true)
    const next=await s.inbox.receive(s.subject,{source:'webhook',eventId:'merged-later',changeNumber:'7'})
    expect(next.duplicate).toBe(false);expect(next.runId).not.toBe(s.queued.runId)
    s.setRequest(async r=>s.response(r));await s.invoke()
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_proposals')).rows[0].n).toBe(1)
    expect((await pool.query('SELECT count(*) FILTER(WHERE eligible)::int eligible,sum(attempts)::int attempts FROM memory_git_run_receipts')).rows[0]).toEqual({eligible:1,attempts:4})
  })
  test('in-flight unreclaimed lease expiry cannot become generic completed and remains recoverable',async()=>{
    const s=await setup();s.setRequest(async(_r,signal)=>new Promise((_resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(new Error('adapter-aborted')),{once:true})
      void pool.query("UPDATE memory_jobs SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",[s.queued.jobId]).catch(reject)
    }))
    const claim=await s.invoke()
    expect(await createJobRepository(pool).completeJob({jobId:claim.job_id,claimedBy:'git-test',claimEpoch:claim.claim_epoch})).toBe(false)
    expect((await pool.query('SELECT state FROM memory_jobs WHERE job_id=$1',[claim.job_id])).rows[0].state).toBe('pending')
    s.setRequest(async r=>s.response(r));await s.invoke(s.worker())
    expect((await s.stored()).state).toBe('planned')
  })
  test('one-off failure persistence SQL error propagates to generic retry without losing request failure evidence',async()=>{
    const s=await setup();s.setRequest(async()=>({status:503}))
    await pool.query('CREATE SEQUENCE fixture_fail_once')
    await pool.query(`CREATE FUNCTION fixture_failure_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.error_code='provider_failure' THEN IF nextval('fixture_fail_once')=1 THEN RAISE EXCEPTION 'PRIVATE_SQL_ERROR'; END IF;END IF;RETURN NEW;END $$`)
    await pool.query('CREATE TRIGGER fixture_failure_update BEFORE UPDATE ON memory_git_runs FOR EACH ROW EXECUTE FUNCTION fixture_failure_update()')
    const errors:unknown[]=[],jobs=createJobRepository(pool),worker=createJobWorker({pool,jobs,workerId:'generic-git',signal:new AbortController().signal,onError:e=>errors.push(e)})
    worker.register('git_ingest',s.worker().handle)
    try{
      await worker.tick()
      expect((await pool.query('SELECT state FROM memory_jobs WHERE job_id=$1',[s.queued.jobId])).rows[0].state).toBe('pending')
      expect((await pool.query('SELECT state FROM memory_git_request_reservations')).rows).toEqual([{state:'failed'}])
      expect(errors.map(e=>String(e)).join(' ')).not.toContain('PRIVATE_SQL_ERROR')
      await pool.query('UPDATE memory_jobs SET available_at=NOW() WHERE job_id=$1',[s.queued.jobId]);await worker.tick()
      expect({run:await s.stored(),requests:s.requests.length,errors:errors.map(e=>String(e))}).toMatchObject({run:{failure_count:2,http_attempts:2,error_code:'provider_failure'},requests:2,errors:['Error: failure_persistence_failed']})
      for(let failures=3;failures<=5;failures++){
        await pool.query('UPDATE memory_jobs SET available_at=NOW() WHERE job_id=$1',[s.queued.jobId]);await pool.query('UPDATE memory_git_runs SET next_attempt_at=NOW() WHERE run_id=$1',[s.queued.runId])
        await worker.tick();expect((await s.stored()).failure_count).toBe(failures)
      }
      await worker.tick();expect(s.requests).toHaveLength(5);expect((await s.stored()).state).toBe('dead')
    }finally{await pool.query('DROP TRIGGER fixture_failure_update ON memory_git_runs; DROP FUNCTION fixture_failure_update(); DROP SEQUENCE fixture_fail_once')}
  })
  test('fifth-failure SQL rollback recovers monotone terminal counts without a sixth dispatch',async()=>{
    const s=await setup();s.setRequest(async()=>({status:503}))
    await pool.query('CREATE SEQUENCE fixture_fifth_failure_once')
    await pool.query(`CREATE FUNCTION fixture_fifth_failure_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.failure_count=5 AND NEW.error_code='provider_failure' THEN
        IF nextval('fixture_fifth_failure_once')=1 THEN RAISE EXCEPTION 'PRIVATE_FIFTH_FAILURE'; END IF;
      END IF;RETURN NEW;END $$`)
    await pool.query('CREATE TRIGGER fixture_fifth_failure_update BEFORE UPDATE ON memory_git_runs FOR EACH ROW EXECUTE FUNCTION fixture_fifth_failure_update()')
    const errors:unknown[]=[],jobs=createJobRepository(pool)
    const worker=createJobWorker({pool,jobs,workerId:'fifth-failure',signal:new AbortController().signal,onError:e=>errors.push(e)})
    worker.register('git_ingest',s.worker().handle)
    try{
      for(let attempt=1;attempt<=5;attempt++){
        await pool.query("UPDATE memory_jobs SET available_at=NOW()-interval '1 second' WHERE job_id=$1",[s.queued.jobId])
        await pool.query("UPDATE memory_git_runs SET next_attempt_at=NOW()-interval '1 second' WHERE run_id=$1",[s.queued.runId])
        await worker.tick()
      }
      expect({requests:s.requests.length,run:await s.stored(),errors:errors.map(e=>String(e))})
        .toMatchObject({requests:5,run:{state:'received',failure_count:4,http_attempts:5,error_code:'provider_failure'},errors:['Error: failure_persistence_failed']})
      expect((await pool.query('SELECT failures,unfinished FROM memory_git_run_receipts WHERE run_id=$1',[s.queued.runId])).rows[0]).toEqual({failures:5,unfinished:true})
      expect((await pool.query('SELECT state FROM memory_jobs WHERE job_id=$1',[s.queued.jobId])).rows[0].state).toBe('pending')
      expect(errors.map(e=>String(e))).toEqual(['Error: failure_persistence_failed'])
      const restarted=createJobWorker({pool,jobs,workerId:'fifth-restarted',signal:new AbortController().signal})
      restarted.register('git_ingest',s.worker().handle)
      await pool.query('UPDATE memory_jobs SET available_at=NOW() WHERE job_id=$1',[s.queued.jobId]);await restarted.tick()
      expect(s.requests).toHaveLength(5)
      expect(await s.stored()).toMatchObject({state:'dead',failure_count:5,http_attempts:5})
      expect((await pool.query('SELECT state FROM memory_jobs WHERE job_id=$1',[s.queued.jobId])).rows[0].state).toBe('dead')
      expect((await pool.query('SELECT failures,attempts FROM memory_git_run_receipts WHERE run_id=$1',[s.queued.runId])).rows[0]).toEqual({failures:5,attempts:5})
      expect((await pool.query("SELECT count(*)::int n FROM memory_git_request_reservations WHERE run_id=$1 AND state='failed' AND counts_failure",[s.queued.runId])).rows[0].n).toBe(5)
      await restarted.tick();expect(s.requests).toHaveLength(5)
    }finally{await pool.query('DROP TRIGGER fixture_fifth_failure_update ON memory_git_runs; DROP FUNCTION fixture_fifth_failure_update(); DROP SEQUENCE fixture_fifth_failure_once')}
  })
  test('changing an unrelated member does not abort the requester while requester revocation still cancels',async()=>{
    const s=await setup(),other=randomUUID();await pool.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles) VALUES($1,$2,ARRAY['reader'])",[s.f.installationId,other])
    let aborted=false
    s.setRequest(async(r,signal)=>{signal.addEventListener('abort',()=>{aborted=true},{once:true})
      if(r.operation==='merge'){await pool.query('UPDATE memory_scope_memberships SET membership_revision=membership_revision+1 WHERE membership_id=$1',[other]);await new Promise(resolve=>setTimeout(resolve,150))}
      return s.response(r)})
    await s.invoke();expect(aborted).toBe(false);expect((await s.stored()).state).toBe('planned')
  })
  test('small-pool cross-type handlers from the same and different workers make bounded progress',async()=>{
    const s=await setup();await s.inbox.receive(s.subject,{source:'export',eventId:'small-export',changeNumber:'7'});await s.inbox.poll(s.subject)
    const small=new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:400})
    const workers=[createGitSyncWorker({...s.deps,pool:small,reads:{resolve:async()=>s.capability}}),createGitSyncWorker({...s.deps,pool:small,reads:{resolve:async()=>s.capability}})]
    const jobs=createJobRepository(small),claims=await jobs.claimJobs({workerId:'small',limit:3,leaseMs:30_000})
    try{
      const all=Promise.all(claims.map((c,i)=>workers[i%2].handle(c,new AbortController().signal,{fence:{jobId:c.job_id,claimedBy:'small',claimEpoch:c.claim_epoch}})))
      await expect(Promise.race([all,new Promise((_,reject)=>setTimeout(()=>reject(new Error('bounded_pool_progress_timeout')),2000))])).resolves.toBeDefined()
      expect((await pool.query("SELECT count(*)::int n FROM memory_jobs WHERE state='completed'")).rows[0].n).toBeGreaterThan(0)
    }finally{await small.end()}
  })
  test('active Git rejects pool one at construction, while off can settle a queued job without a gate',async()=>{
    const s=await setup(),small=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:200})
    try{
      expect(()=>createGitSyncWorker({...s.deps,pool:small})).toThrow('git_pool_capacity')
      const off=createGitSyncWorker({...s.deps,pool:small,config:loadGitSyncConfig({})}),job=await s.claim()
      await off.handle(job,new AbortController().signal,{fence:{jobId:job.job_id,claimedBy:'git-test',claimEpoch:job.claim_epoch}})
      expect((await s.stored()).state).toBe('dead')
    }finally{await small.end()}
  })
  test('same-commit duplicate skips a failing tree and never adds eligible denominator after purge',async()=>{
    const s=await setup();await s.invoke()
    const duplicate=await s.inbox.receive(s.subject,{source:'poll',eventId:'duplicate-observation',changeNumber:'8'});s.requests.length=0
    s.setRequest(async()=>({status:503}));await s.invoke()
    await pool.query('UPDATE memory_jobs SET available_at=NOW() WHERE job_id=$1',[duplicate.jobId]);await pool.query('UPDATE memory_git_runs SET next_attempt_at=NOW() WHERE run_id=$1',[duplicate.runId])
    s.setRequest(async r=>r.operation==='tree'?{status:503}:s.response(r));await s.invoke()
    expect(s.requests.map(r=>r.operation)).toEqual(['merge','merge','commit'])
    expect((await pool.query('SELECT eligible,unfinished,attempts,failures FROM memory_git_run_receipts WHERE run_id=$1',[duplicate.runId])).rows[0])
      .toEqual({eligible:false,unfinished:false,attempts:3,failures:1})
    await pool.query('DELETE FROM memory_git_snapshots WHERE export_id=$1',[s.bundle.exportId])
    expect((await pool.query('SELECT count(*) FILTER(WHERE eligible)::int n FROM memory_git_run_receipts')).rows[0].n).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_request_reservations')).rows[0].n).toBe(6)
  })
  test('a same-instance dispatcher waiter reacts to abort before the active request ends',async()=>{
    const s=await setup(),worker=s.worker();let release!:()=>void,entered!:()=>void
    const started=new Promise<void>(resolve=>{entered=resolve}),block=new Promise<void>(resolve=>{release=resolve})
    s.setRequest(async r=>{if(s.requests.length===1){entered();await block}return s.response(r)})
    const first=s.invoke(worker);await started
    const queued=await s.inbox.receive(s.subject,{source:'export',eventId:'queued-abort',changeNumber:'7'}),job=await s.claim(),controller=new AbortController()
    const waiting=worker.handle(job,controller.signal,{fence:{jobId:job.job_id,claimedBy:'git-test',claimEpoch:job.claim_epoch}})
    controller.abort()
    try{await Promise.race([waiting,new Promise((_,reject)=>setTimeout(()=>reject(new Error('waiter_abort_timeout')),500))])
      expect((await pool.query('SELECT state FROM memory_jobs WHERE job_id=$1',[queued.jobId])).rows[0].state).toBe('dead')
      expect(s.requests).toHaveLength(1)
    }finally{release();await first}
  })
})
