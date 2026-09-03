import pg from 'pg'
import { afterAll,beforeAll,beforeEach,describe,expect,test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { attestationFixture } from '../testing/phase6-attestation-fixture.js'
import { gitExportFixture } from '../testing/phase6-export-fixture.js'
import { createGitExportService } from '../git-sync/export-service.js'
import { createDatabaseAttestationRegistry } from '../git-sync/key-registry.js'
import { createGitInboxService } from '../git-sync/inbox-service.js'
import { createGitSyncWorker } from '../git-sync/worker.js'
import { createJobRepository } from '../jobs/repository.js'
import { loadGitSyncConfig } from '../git-sync/config.js'
import { fixtureGitWriter } from '../testing/phase6-write-fixture.js'
import { fixtureGitServer } from '../testing/phase6-provider-server.js'
import { randomUUID } from 'node:crypto'
import { createGitPollingScheduler } from '../git-sync/runtime.js'
import { recognizeGitRemoteOperation,type GitRemoteMetadata } from '../git-sync/remote-recognition.js'
import { createGitRequestExecutor } from '../git-sync/request-executor.js'
import { gitQueueTransaction } from '../git-sync/inbox-service.js'
import { requireCurrentGitAuthorization } from '../git-sync/authorization.js'
import { lockGitConnection } from '../git-sync/repository.js'
import { createGitHubReadCapability } from '../git-sync/github.js'
import { createGitTransport } from '../git-sync/transport.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const db=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
db('Phase 6 current signing keys and durable outbox',()=>{
  let pool:pg.Pool
  beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:12});await assertMemoryTestDatabase(pool,url!)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await applyMemorySchema(pool)},60_000)
  beforeEach(async()=>{await pool.query('TRUNCATE memory_installations,memory_git_attestation_keys,memory_jobs CASCADE')})
  afterAll(async()=>{await pool?.end()})
  async function setup(statement?:string){const f=await gitExportFixture(pool),fixture=attestationFixture(),signer=fixture.registry.signingKey()
    if(statement)await pool.query('UPDATE knowledge_versions SET statement=$2 WHERE version_id=$1',[f.rule.versionId,statement])
    const keys=createDatabaseAttestationRegistry({pool,signer});await keys.registerSigner()
    const service=createGitExportService({pool,keys,skill:{context:f.skill.context,cases:f.skill.cases}})
    const request={installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',baseCommit:'a'.repeat(40),purpose:'external_export',assets:f.keys.filter(k=>k.kind==='rule')}
    const bundle=await service.export(f.grant,request),subject={installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',exportId:bundle.exportId}
    return {f,fixture,keys,service,request,bundle,subject}}
  test('binds a DB-registered Ed25519 public key in the same immutable snapshot transaction',async()=>{
    const s=await setup()
    expect((await pool.query('SELECT key_id,state,octet_length(public_key_spki) n FROM memory_git_attestation_keys')).rows).toEqual([{key_id:'test-1',state:'active',n:44}])
    expect((await pool.query('SELECT export_id,key_id FROM memory_git_snapshot_keys')).rows).toEqual([{export_id:s.bundle.exportId,key_id:'test-1'}])
    expect((await s.service.loadRegisteredBase(s.f.grant,s.subject)).exportId).toBe(s.bundle.exportId)
  })
  test('same process observes revocation on next base validation, never cached indefinitely',async()=>{
    const s=await setup();await s.keys.transition('test-1','revoked')
    await expect(s.service.loadRegisteredBase(s.f.grant,s.subject)).rejects.toThrow('git_export_unregistered')
    await expect(s.service.export(s.f.grant,{...s.request,expectedGeneration:(await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation})).rejects.toThrow('git_attestation_key_invalid')
  })
  test('unbound legacy snapshot cannot acquire trust by late binding; re-export is required',async()=>{
    const f=await gitExportFixture(pool),fixture=attestationFixture(),skill={context:f.skill.context,cases:f.skill.cases}
    const request={installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',baseCommit:'a'.repeat(40),purpose:'external_export',assets:f.keys.filter(k=>k.kind==='rule')}
    const legacy=await createGitExportService({pool,keys:fixture.registry,skill}).export(f.grant,request)
    const keys=createDatabaseAttestationRegistry({pool,signer:fixture.registry.signingKey()});await keys.registerSigner()
    const service=createGitExportService({pool,keys,skill})
    await expect(service.loadRegisteredBase(f.grant,{installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',exportId:legacy.exportId})).rejects.toThrow('git_export_unbound')
    expect((await service.export(f.grant,request)).exportId).not.toBe(legacy.exportId)
  })
  test('revocation waits for early shared key gate without holding key row ahead of reader connection locks',async()=>{
    const s=await setup(),client=await pool.connect();await client.query('BEGIN')
    await s.keys.transactionView(client)
    let finished=false;const revoke=s.keys.transition('test-1','revoked').then(()=>{finished=true})
    await client.query(`SELECT pg_sleep(0.03)`);expect(finished).toBe(false)
    await client.query('SELECT 1 FROM memory_git_connections WHERE connection_id=$1 FOR UPDATE',[s.f.connectionId])
    await client.query('COMMIT');client.release();await revoke
    await expect(s.service.loadRegisteredBase(s.f.grant,s.subject)).rejects.toThrow('git_export_unregistered')
  })
  test('direct SQL revocation blocks BEFORE key row locks while two exports share the key gate',async()=>{
    const s=await setup(),a=await pool.connect(),b=await pool.connect(),writer=await pool.connect()
    try {
      await a.query('BEGIN');await b.query('BEGIN');await s.keys.transactionView(a);await s.keys.transactionView(b)
      let finished=false;const revoke=writer.query("UPDATE memory_git_attestation_keys SET state='revoked' WHERE key_id='test-1'").then(()=>{finished=true})
      await a.query('SELECT pg_sleep(0.03)');expect(finished).toBe(false)
      await a.query("SET LOCAL lock_timeout='200ms'")
      await a.query("SELECT 1 FROM memory_git_attestation_keys WHERE key_id='test-1' FOR SHARE")
      await a.query('COMMIT');await b.query('COMMIT');await revoke
      await expect(s.service.loadRegisteredBase(s.f.grant,s.subject)).rejects.toThrow('git_export_unregistered')
    }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();writer.release()}
  })
  test('two concurrent export transactions drain before direct revoke and a later export rereads revoked state',async()=>{
    const s=await setup(),blocker=await pool.connect(),writer=await pool.connect()
    await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM memory_git_connections WHERE connection_id=$1 FOR UPDATE',[s.f.connectionId])
    const exports=Promise.all([s.service.export(s.f.grant,{...s.request,baseCommit:'b'.repeat(40)}),s.service.export(s.f.grant,{...s.request,baseCommit:'c'.repeat(40)})])
    let revoke:Promise<unknown>|undefined
    try{
      // Both export transactions have the early shared gate. One may wait on
      // an earlier source lock owned by the other, before the connection row.
      let waiting=0
      for(let i=0;i<100&&waiting<2;i++){
        waiting=Number((await writer.query(`SELECT count(*) n FROM pg_locks WHERE locktype='advisory' AND mode='ShareLock' AND granted
          AND objid=(hashtextextended('memory:git:attestation-keys',0)&4294967295)::oid
          AND classid=((hashtextextended('memory:git:attestation-keys',0)>>32)&4294967295)::oid`)).rows[0].n)
        if(waiting<2)await writer.query('SELECT pg_sleep(0.01)')
      }
      expect(waiting).toBeGreaterThanOrEqual(2)
      revoke=writer.query("UPDATE memory_git_attestation_keys SET state='revoked' WHERE key_id='test-1'")
      await blocker.query('COMMIT');expect(await exports).toHaveLength(2);await revoke
      await expect(s.service.export(s.f.grant,{...s.request,expectedGeneration:(await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation,baseCommit:'d'.repeat(40)})).rejects.toThrow('git_attestation_key_invalid')
    }finally{await blocker.query('ROLLBACK');await exports.catch(()=>undefined);await revoke?.catch(()=>undefined);blocker.release();writer.release()}
  })
  async function outgoing(provider:'github'|'gitee'='github',statement?:string) {
    const s=await setup(statement);await pool.query('UPDATE memory_git_connections SET provider=$2 WHERE connection_id=$1',[s.f.connectionId,provider])
    const generation=(await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation
    if(generation!==s.subject.expectedGeneration){
      s.request.expectedGeneration=generation;s.bundle=await s.service.export(s.f.grant,s.request)
      s.subject={...s.subject,expectedGeneration:generation,exportId:s.bundle.exportId}
    }
    const config=loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'shadow'}),deps={pool,config,scopeMode:async()=> 'shadow' as const,keys:s.keys,skill:{context:s.f.skill.context,cases:s.f.skill.cases},outcomeKind:'fixture' as const}
    const inbox=createGitInboxService(deps);await inbox.enroll(s.f.grant,s.subject)
    const queued=await inbox.receive(s.subject,{source:'export',eventId:'outgoing-export',changeNumber:'1'})
    const server=fixtureGitServer(provider),cap=fixtureGitWriter(provider,{providerRepositoryId:'123',owner:'example',repository:'knowledge',private:true,branch:'main'},async(e)=>{
      expect((await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n).toBe(0)
      expect((await pool.query('SELECT count(*)::int n FROM memory_git_request_reservations WHERE installation_id=$1',[s.f.installationId])).rows[0].n).toBe(server.calls.length+1)
      return server.request(e)
    })
    const worker=()=>createGitSyncWorker({...deps,fixtureWrites:{resolve:async()=>cap}}),jobs=createJobRepository(pool)
    const invoke=async()=>{const [job]=await jobs.claimJobs({workerId:'outbox-test',limit:1,leaseMs:30_000});expect(job).toBeDefined()
      await worker().handle(job,new AbortController().signal,{fence:{jobId:job.job_id,claimedBy:'outbox-test',claimEpoch:job.claim_epoch}})}
    const retry=async()=>{await pool.query('UPDATE memory_jobs SET available_at=NOW() WHERE job_id=$1',[queued.jobId]);await pool.query('UPDATE memory_git_runs SET next_attempt_at=NOW() WHERE run_id=$1',[queued.runId]);await invoke()}
    return {...s,queued,server,invoke,retry,worker,deps,cap,inbox}
  }
  test.each(['github','gitee'] as const)('%s persists signed export steps and exactly one draft without changing target branch',async provider=>{
    const s=await outgoing(provider);await s.invoke()
    expect(s.server.pulls).toHaveLength(1);expect(s.server.pulls[0].draft).toBe(true);expect(s.server.branches.get('main')).toBe('a'.repeat(40))
    expect((await pool.query('SELECT state FROM memory_git_outbox')).rows).toEqual([{state:'completed'},{state:'completed'},{state:'completed'}])
    const operations=(await pool.query('SELECT operation FROM memory_git_request_reservations')).rows.map(r=>r.operation)
    expect(operations).toContain(provider==='github'?'write_tree':'write_file');expect(operations).toContain('write_pull_request')
    expect(JSON.stringify((await pool.query('SELECT * FROM memory_git_outbox_steps')).rows)).not.toContain('Synthetic statement')
  })
  test.each(['tree','commit','branch','pull'])('GitHub lost %s response reconciles exact object before retry without duplicate writes',async action=>{
    const s=await outgoing();s.server.loseNext(action);await s.invoke()
    expect((await pool.query("SELECT count(*)::int n FROM memory_git_outbox_steps WHERE state='reconciling'")).rows[0].n).toBe(1)
    await s.retry();expect({pulls:s.server.pulls.length,run:(await pool.query('SELECT state,error_code,http_attempts FROM memory_git_runs WHERE run_id=$1',[s.queued.runId])).rows[0]}).toMatchObject({pulls:1,run:{state:'planned',error_code:null}})
    expect((await pool.query('SELECT state FROM memory_git_runs WHERE run_id=$1',[s.queued.runId])).rows[0].state).toBe('planned')
  })
  test('Gitee lost file response verifies exact parent/tree then continues the bounded sequence',async()=>{
    const s=await outgoing('gitee');s.server.loseNext('file');await s.invoke();await s.retry()
    expect(s.server.pulls).toHaveLength(1)
    expect(s.server.calls.filter(e=>e.method!=='GET'&&e.segments[3]==='contents')).toHaveLength(s.bundle.files.length)
  })
  test('Gitee concurrent branch movement after a Contents write stops before another write or PR',async()=>{
    const s=await outgoing('gitee'),branch=`pocketctl/export/${s.bundle.exportId}`
    s.server.afterMutation(()=>{if(s.server.calls.at(-1)?.segments[3]==='contents')s.server.branches.set(branch,'d'.repeat(40))})
    await s.invoke();expect(s.server.pulls).toHaveLength(0)
    expect(s.server.calls.filter(e=>e.method!=='GET'&&e.segments[3]==='contents')).toHaveLength(1)
    expect(s.server.branches.get(branch)).toBe('d'.repeat(40))
  })
  test('changed preexisting unique export branch is rejected without modifying it',async()=>{
    const s=await outgoing();s.server.branches.set(`pocketctl/export/${s.bundle.exportId}`,'d'.repeat(40));await s.invoke()
    expect(s.server.pulls).toHaveLength(0);expect(s.server.branches.get(`pocketctl/export/${s.bundle.exportId}`)).toBe('d'.repeat(40))
    expect((await pool.query('SELECT error_code FROM memory_git_runs WHERE run_id=$1',[s.queued.runId])).rows[0].error_code).toBe('provider_conflict')
  })
  test('secret-bearing signed content is rejected before any outbox row or provider request',async()=>{
    const s=await outgoing('github','token=TEST_ONLY_SECRET_MUST_NOT_EXPORT');await s.invoke()
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_outbox')).rows[0].n).toBe(0);expect(s.server.calls).toHaveLength(0)
    expect((await pool.query('SELECT error_code FROM memory_git_runs WHERE run_id=$1',[s.queued.runId])).rows[0].error_code).toBe('secret_detected')
  })
  test.each([401,403,409,429,500])('outbox status %s preserves bounded failure policy and retries only transient responses',async status=>{
    const s=await outgoing();s.server.statusNext(status);await s.invoke()
    const row=(await pool.query('SELECT state,http_attempts FROM memory_git_runs WHERE run_id=$1',[s.queued.runId])).rows[0]
    expect(row).toEqual({state:status>=500||status===429?'received':'dead',http_attempts:1})
    expect(s.server.pulls).toHaveLength(0)
    if(status>=500||status===429){await s.retry();expect(s.server.pulls).toHaveLength(1)}
  })
  test('revoke during an uncertain remote step aborts later mutations without holding DB locks over HTTP',async()=>{
    const s=await outgoing();s.server.afterMutation(()=>s.keys.transition('test-1','revoked'));await s.invoke()
    expect(s.server.calls.filter(e=>e.method!=='GET')).toHaveLength(1);expect(s.server.pulls).toHaveLength(0)
    expect((await pool.query('SELECT cleanup_pending FROM memory_git_remote_cleanup')).rows[0].cleanup_pending).toBe(true)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_outbox_steps')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT sum(response_bytes)::int n FROM memory_git_request_reservations')).rows[0].n).toBeGreaterThan(0)
  })
  test('bounded poll scheduler admits once; concrete export hints fan out only to exact enrolled current principals',async()=>{
    const s=await setup(),second=await s.service.export(s.f.grant,{...s.request,baseCommit:'b'.repeat(40)}),third=await s.service.export(s.f.grant,{...s.request,baseCommit:'c'.repeat(40)})
    const deps={pool,config:loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'shadow'}),scopeMode:async()=> 'shadow' as const,keys:s.keys,skill:{context:s.f.skill.context,cases:s.f.skill.cases}}
    const inbox=createGitInboxService(deps);await inbox.enroll(s.f.grant,s.subject);await inbox.enroll(s.f.grant,{...s.subject,exportId:second.exportId})
    const scheduler=createGitPollingScheduler({...deps,signal:new AbortController().signal});await scheduler.tick();await scheduler.tick()
    expect((await pool.query("SELECT count(*)::int n FROM memory_git_runs WHERE trigger_source='poll'")).rows[0].n).toBe(1)
    const stale=await s.service.export(s.f.grant,{...s.request,baseCommit:'d'.repeat(40)});await inbox.enroll(s.f.grant,{...s.subject,exportId:stale.exportId})
    await pool.query('UPDATE memory_git_sync_principals SET generation=2 WHERE export_id=$1',[stale.exportId])
    const cross=await setup();await inbox.enroll(cross.f.grant,cross.subject)
    const worker=createGitSyncWorker({...deps,reads:{resolve:async()=>({kind:'fixture',target:{provider:'github',providerRepositoryId:'123',branch:'main',origin:'https://api.github.com'},
      request:async()=>({status:200,receivedBytes:100,body:{providerRepositoryId:'123',branch:'main',changes:[{number:'7',exportId:s.bundle.exportId},{number:'8',exportId:second.exportId},
        {number:'9',exportId:third.exportId},{number:'10',exportId:randomUUID()},{number:'11',exportId:stale.exportId},{number:'12',exportId:cross.bundle.exportId}],nextCursor:null}})})}})
    const [job]=await createJobRepository(pool).claimJobs({workerId:'poll-test',limit:1,leaseMs:30_000})
    await worker.handle(job,new AbortController().signal,{fence:{jobId:job.job_id,claimedBy:'poll-test',claimEpoch:job.claim_epoch}})
    expect((await pool.query('SELECT export_id,change_number FROM memory_git_runs WHERE change_number IS NOT NULL ORDER BY change_number')).rows)
      .toEqual([{export_id:s.bundle.exportId,change_number:'7'},{export_id:second.exportId,change_number:'8'}])
  })
  test.each(['revoked','revision','expired','role'])('scheduler bypasses a %s newest principal and admits the older valid principal using its own facts',async invalidity=>{
    const s=await setup(),newest=await s.service.export(s.f.grant,{...s.request,baseCommit:'b'.repeat(40)})
    const other=await s.f.skill.actor(['scope_administrator'],['read','contribute','review','publish','scope_admin'])
    const deps={pool,config:loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'shadow'}),scopeMode:async()=> 'shadow' as const}
    const inbox=createGitInboxService(deps),newSubject={...s.subject,exportId:newest.exportId}
    await inbox.enroll(s.f.grant,s.subject);await inbox.enroll(other.grant,newSubject)
    const change={revoked:"state='revoked'",revision:'membership_revision=membership_revision+1',expired:"valid_until=clock_timestamp()-interval '1 second'",role:"roles=ARRAY['reader']::text[]"}[invalidity]!
    await pool.query(`UPDATE memory_scope_memberships SET ${change} WHERE installation_id=$1 AND membership_id=$2`,[s.f.installationId,other.membershipId])
    await expect(inbox.poll(newSubject)).rejects.toThrow('git_principal_missing')
    const generation=(await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation
    const refreshed=await s.service.export(s.f.grant,{...s.request,expectedGeneration:generation})
    await inbox.enroll(s.f.grant,{...s.subject,exportId:refreshed.exportId,expectedGeneration:generation})
    await createGitPollingScheduler({...deps,signal:new AbortController().signal}).tick()
    expect((await pool.query('SELECT export_id,membership_id,grant_facts FROM memory_git_runs')).rows)
      .toEqual([{export_id:refreshed.exportId,membership_id:s.f.membershipId,grant_facts:s.f.grant}])
  })
  test('scheduler durably advances beyond 32 denied connections after a fresh scheduler instance starts',async()=>{
    const subjects:Awaited<ReturnType<typeof setup>>[]=[]
    for(let i=0;i<33;i++)subjects.push(await setup())
    subjects.sort((a,b)=>a.f.connectionId.localeCompare(b.f.connectionId))
    const allowed=subjects[32],config=loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'shadow'})
    const inbox=createGitInboxService({pool,config,scopeMode:async()=> 'shadow'})
    for(const s of subjects)await inbox.enroll(s.f.grant,s.subject)
    const attempted:string[]=[],deps={pool,config,scopeMode:async(c:{connectionId:string})=>{attempted.push(c.connectionId);return c.connectionId===allowed.f.connectionId?'shadow' as const:'off' as const}}
    await createGitPollingScheduler({...deps,signal:new AbortController().signal}).tick()
    expect(attempted).toHaveLength(32);expect((await pool.query('SELECT count(*)::int n FROM memory_git_runs')).rows[0].n).toBe(0)
    // No instance-local scan position survives this restart.
    await createGitPollingScheduler({...deps,signal:new AbortController().signal}).tick()
    expect(attempted).toHaveLength(33)
    expect((await pool.query('SELECT connection_id,export_id FROM memory_git_runs')).rows).toEqual([{connection_id:allowed.f.connectionId,export_id:allowed.bundle.exportId}])
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_connections WHERE next_poll_at>clock_timestamp()')).rows[0].n).toBe(33)
  },60_000)
  test('scheduler backs off a connection with no current principal without attempting admission',async()=>{
    const s=await setup(),config=loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'shadow'})
    await createGitInboxService({pool,config,scopeMode:async()=> 'shadow'}).enroll(s.f.grant,s.subject)
    await pool.query('UPDATE memory_scope_memberships SET membership_revision=membership_revision+1 WHERE installation_id=$1',[s.f.installationId])
    let attempts=0;const errors:string[]=[]
    await createGitPollingScheduler({pool,config,scopeMode:async()=>{attempts++;return 'shadow'},signal:new AbortController().signal,onError:code=>errors.push(code)}).tick()
    expect(attempts).toBe(0);expect(errors).toEqual([])
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_sync_principals')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_runs')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_snapshots')).rows[0].n).toBe(0)
  })
  test.each(['revoke','admit','generation'])('scheduler revalidates selected principal and preserves a concurrent %s boundary',async race=>{
    const s=await setup(),config=loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'shadow'}),inbox=createGitInboxService({pool,config,scopeMode:async()=> 'shadow'})
    await inbox.enroll(s.f.grant,s.subject)
    let selected=false,concurrentSlot:string|null=null
    const query=async(sql:string,parameters?:unknown[])=>{
      const result=await pool.query(sql,parameters)
      if(sql.startsWith('WITH due AS MATERIALIZED')){
        selected=true;expect(result.rows[0].exportId).toBe(s.bundle.exportId)
        if(race==='revoke')await pool.query("UPDATE memory_scope_memberships SET state='revoked' WHERE installation_id=$1",[s.f.installationId])
        else if(race==='generation')await pool.query('UPDATE memory_git_connections SET generation=generation+1 WHERE connection_id=$1',[s.f.connectionId])
        else {await inbox.poll(s.subject);concurrentSlot=(await pool.query('SELECT next_poll_at::text AS slot FROM memory_git_connections')).rows[0].slot}
      }
      return result
    }
    const selectedPool={query,connect:pool.connect.bind(pool)} as unknown as pg.Pool
    await createGitPollingScheduler({pool:selectedPool,config,scopeMode:async()=> 'shadow',signal:new AbortController().signal}).tick()
    expect(selected).toBe(true)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_runs')).rows[0].n).toBe(race==='admit'?1:0)
    const state=(await pool.query('SELECT generation::text,next_poll_at::text AS slot,next_poll_at>clock_timestamp() AS delayed FROM memory_git_connections')).rows[0]
    if(race==='revoke'){expect(BigInt(state.generation)).toBeGreaterThan(1n);expect(state.delayed).toBeNull()}
    else if(race==='admit')expect(state.slot).toBe(concurrentSlot)
    else expect(state).toEqual({generation:'2',slot:null,delayed:null})
  })
  test.each([false,true])('concrete live read stub charges repository verification before empty poll; reassigned=%s',async reassigned=>{
    const s=await setup();await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1",[s.f.connectionId])
    const deps={pool,config:loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'enabled'}),scopeMode:async()=> 'enabled' as const,keys:s.keys,skill:{context:s.f.skill.context,cases:s.f.skill.cases}}
    const inbox=createGitInboxService(deps);await inbox.enroll(s.f.grant,s.subject);const queued=await inbox.poll(s.subject),paths:string[]=[]
    const cap=createGitHubReadCapability({target:{providerRepositoryId:'123',owner:'example',repository:'knowledge',private:true,branch:'main'},
      transport:createGitTransport({provider:'github',token:'TEST_ONLY_TOKEN',maxResponseBytes:4096,fetch:async(url)=>{
        paths.push(new URL(url.toString()).pathname)
        expect((await pool.query('SELECT count(*)::int n FROM memory_git_request_reservations WHERE run_id=$1',[queued.runId])).rows[0].n).toBe(paths.length)
        return Response.json(paths.length===1?{id:reassigned?456:123,full_name:'example/knowledge',private:true}:[])
      }})})
    const [job]=await createJobRepository(pool).claimJobs({workerId:'live-stub-test',limit:1,leaseMs:30_000})
    await createGitSyncWorker({...deps,reads:{resolve:async()=>cap}}).handle(job,new AbortController().signal,{fence:{jobId:job.job_id,claimedBy:'live-stub-test',claimEpoch:job.claim_epoch}})
    expect(paths).toEqual(reassigned?['/repos/example/knowledge']:['/repos/example/knowledge','/repos/example/knowledge/pulls'])
    expect((await pool.query('SELECT state,http_attempts FROM memory_git_runs WHERE run_id=$1',[queued.runId])).rows[0]).toEqual({state:reassigned?'dead':'planned',http_attempts:reassigned?1:2})
  })
  test('cancelled old run never dispatches again; a new fenced read run recognizes only persisted metadata after snapshot removal',async()=>{
    const s=await outgoing();s.server.loseNext('pull');await s.invoke()
    const stored=(await pool.query(`SELECT expected_commit,expected_tree,description_hash,remote_branch FROM memory_git_outbox WHERE run_id=$1 AND operation='pull_request'`,[s.queued.runId])).rows[0]
    expect(stored.expected_commit).toMatch(/^[a-f0-9]{40}$/);expect(stored.expected_tree).toMatch(/^[a-f0-9]{40}$/)
    const metadata:GitRemoteMetadata={oldRunId:s.queued.runId,installationId:s.f.installationId,connectionId:s.f.connectionId,exportId:s.bundle.exportId,
      provider:'github',target:s.cap.target,branch:stored.remote_branch,commit:stored.expected_commit,tree:stored.expected_tree,descriptionHash:stored.description_hash}
    await pool.query("UPDATE memory_git_runs SET state='cancelled' WHERE run_id=$1",[s.queued.runId]);await pool.query("UPDATE memory_jobs SET state='dead' WHERE job_id=$1",[s.queued.jobId])
    const oldJob=(await pool.query('SELECT * FROM memory_jobs WHERE job_id=$1',[s.queued.jobId])).rows[0],before=s.server.calls.length
    await s.worker().handle(oldJob,new AbortController().signal,{fence:{jobId:oldJob.job_id,claimedBy:'outbox-test',claimEpoch:oldJob.claim_epoch}})
    expect(s.server.calls).toHaveLength(before)
    await pool.query('DELETE FROM memory_git_snapshots WHERE export_id=$1',[s.bundle.exportId])
    const {createGitRecoveryService}=await import('../git-sync/recovery-service.js')
    const actor=await s.f.skill.actor(['scope_administrator'],['read','contribute','review','publish','scope_admin'])
    const recoveryReads={resolve:async()=>({kind:'fixture' as const,provider:'github' as const,target:s.cap.target,request:s.cap.request})}
    const recovery=createGitRecoveryService({...s.deps,recoveryReads})
    const queued=await recovery.admit(actor.grant,{...s.subject,expectedGeneration:(await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation,idempotencyKey:'explicit-new-read'})
    const [job]=await createJobRepository(pool).claimJobs({workerId:'recognition-test',limit:1,leaseMs:30_000})
    await createGitSyncWorker({...s.deps,recoveryReads}).handle(job,new AbortController().signal,{fence:{jobId:job.job_id,claimedBy:'recognition-test',claimEpoch:job.claim_epoch}})
    expect(s.server.calls.slice(before).every(e=>e.method==='GET')).toBe(true)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_request_reservations WHERE run_id=$1',[queued.runId])).rows[0].n).toBe(5)
    expect((await pool.query('SELECT remote_pr_id,recognized_run_id FROM memory_git_remote_cleanup')).rows[0]).toEqual({remote_pr_id:'1',recognized_run_id:queued.runId})
    await expect(recognizeGitRemoteOperation(metadata,{currentRunId:metadata.oldRunId,execute:async()=>{throw new Error('no request')},read:s.cap.request,record:async()=>undefined})).rejects.toThrow('reconcile_not_authorized')
  })
})
