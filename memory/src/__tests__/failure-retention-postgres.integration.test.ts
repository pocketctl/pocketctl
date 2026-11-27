import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test,vi} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createJobRepository} from '../jobs/repository.js'
import {failureRetentionSettings,previewFailureRetention,retainFailureBatch,type FailureCursor} from '../maintenance/dead-letters.js'
import * as daily from '../maintenance/daily.js'
import {createDailyMaintenanceWorker} from '../maintenance/worker.js'
import {recordDialogueResult} from '../episodes/dialogue-generation.js'
import {DIALOGUE_GENERATIONS} from '../migrations/shared-db/dialogue-generations.js'

const url=process.env.MEMORY_TEST_DATABASE_URL, suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
const install=randomUUID(), session='session-retention'
const enabled=failureRetentionSettings({MEMORY_FAILURE_RETENTION_MODE:'enabled',MEMORY_FAILURE_RETENTION_SCOPES:install})

suite('generation-bound failure retention',()=>{
  let pool:pg.Pool
  beforeAll(async()=>{
    pool=new pg.Pool({connectionString:url,max:5,options:'-c search_path=public,failure_retention_test,pg_catalog'})
    await assertMemoryTestDatabase(pool,url!)
    await applyMemorySchema(pool)
    // Install the producer's actual receipt definitions inside the isolated fixture.
    await pool.query('DROP SCHEMA IF EXISTS failure_retention_test CASCADE; CREATE SCHEMA failure_retention_test')
    await pool.query('CREATE TABLE failure_retention_test.enrolled(installation_id uuid PRIMARY KEY)')
    for(const ddl of DIALOGUE_GENERATIONS.filter(q=>q.startsWith('CREATE TABLE IF NOT EXISTS memory.memory_dialogue_'))) {
      await pool.query(ddl.replaceAll('memory.memory_dialogue_','failure_retention_test.memory_dialogue_')
        .replace('shared.memory_dialogue_installations','failure_retention_test.enrolled'))
    }
    await pool.query(`CREATE TRIGGER memory_clear_turn_failures AFTER DELETE ON failure_retention_test.memory_dialogue_turns
      FOR EACH ROW EXECUTE FUNCTION memory_forget_turn_failures()`)
  },60000)
  afterAll(async()=>{try{await pool?.query('DROP SCHEMA IF EXISTS failure_retention_test CASCADE')}finally{await pool?.end()}})
  beforeEach(async()=>{
    await pool.query('TRUNCATE failure_retention_test.enrolled,memory_maintenance_runs,memory_installations,memory_jobs,memory_dead_letters,memory_job_failures CASCADE')
    await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[install])
    await pool.query('INSERT INTO failure_retention_test.enrolled VALUES($1)',[install])
  })
  async function key(turn:string) {
    return (await pool.query(`SELECT 'dialogue:'||encode(sha256(convert_to(jsonb_build_array($1::text,$2::text)::text,'UTF8')),'hex') AS k`,[session,turn])).rows[0].k as string
  }
  async function enqueue(turn:string,generation='1') {
    await createJobRepository(pool).enqueueJob({installationId:install,jobType:'compile_episode',idempotencyKey:await key(turn),
      payload:{dialogue_session:session,turn,dialogue_generation:generation}})
  }
  async function fail(turn:string,generation='1'){
    const repo=createJobRepository(pool)
    await enqueue(turn,generation)
    const [claim]=await repo.claimJobs({workerId:'test',limit:1,leaseMs:30_000})
    expect(await repo.rescheduleJob({jobId:claim.job_id,claimEpoch:claim.claim_epoch,claimedBy:'test',errorCode:'example',terminal:true})).toBe(true)
    // Set a historical failure, preserving exact timestamp and digest identity.
    await pool.query(`WITH summary AS (UPDATE memory_dead_letters SET dead_at=now()-interval '40 days'
      WHERE job_id=$1 RETURNING job_id,dead_at), dated AS (
      UPDATE memory_jobs j SET completed_at=s.dead_at FROM summary s WHERE s.job_id=j.job_id)
      UPDATE memory_job_failures f SET dead_at=s.dead_at FROM summary s WHERE s.job_id=f.job_id AND f.claim_epoch=$2`,[claim.job_id,claim.claim_epoch])
    return claim
  }
  async function settle(turn:string,job:string,epoch:number,days:number,status='published') {
    await pool.query(`INSERT INTO memory_dialogue_turns(installation_id,session_id,turn_id,requested_generation)
      VALUES($1,$2,$3,1) ON CONFLICT DO NOTHING`,[install,session,turn])
    await pool.query(`INSERT INTO memory_dialogue_compile_receipts(installation_id,session_id,turn_id,generation,job_id,claim_epoch,status,reason,closed_at)
      VALUES($1,$2,$3,1,$4,$5,$6,CASE WHEN $6='input_gap' THEN 'provenance_unknown' END,now()-$7*interval '1 day')`,
      [install,session,turn,job,epoch,status,days])
  }
  async function batch(settings=enabled,cursor?:FailureCursor) {
    const c=await pool.connect()
    try{await c.query('BEGIN');const r=await retainFailureBatch(c,install,settings,cursor);await c.query('COMMIT');return r}
    catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  }
  test('preview is read-only, confirmed closure starts the clock, and late duplicate delivery is suppressed past audit expiry',async()=>{
    const old=await fail('gap'), recent=await fail('recent')
    await settle('gap',old.job_id,old.claim_epoch,31,'input_gap')
    await settle('recent',recent.job_id,recent.claim_epoch,29)
    await pool.query(`INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,cost_micros,occurred_at,dead_lettered_at,last_error_code)
      VALUES($1,'unsettled','curation',42,now(),now(),'invalid_request')`,[install])
    const audit=()=>pool.query('SELECT usage_id,cost_micros,reported_at,dead_lettered_at FROM memory_usage_outbox WHERE installation_id=$1',[install])
    const fees=(await audit()).rows
    const before=(await pool.query('SELECT turn_id,status FROM memory_dialogue_compile_receipts ORDER BY turn_id')).rows
    expect((await previewFailureRetention(pool,install,enabled)).map(r=>r.reason)).toEqual(['eligible','retention'])
    expect((await batch({...enabled,scopes:[]})).counts).toEqual({failure_eligible:1,failure_retention:1})
    expect((await pool.query('SELECT 1 FROM memory_dead_letters')).rowCount).toBe(2)
    expect((await batch()).counts).toMatchObject({failure_cleaned:1,failure_retention:1})
    expect((await batch()).counts.failure_cleaned).toBeUndefined()
    expect((await pool.query('SELECT removed_job,removed_summary,disposition FROM memory_failure_cleanup_receipts')).rows)
      .toEqual([{removed_job:true,removed_summary:true,disposition:'input_gap'}])
    await pool.query("UPDATE memory_failure_cleanup_receipts SET cleaned_at=now()-interval '91 days'")
    expect((await batch()).counts.failure_receipts_expired).toBe(1)
    await enqueue('gap')
    expect((await pool.query('SELECT 1 FROM memory_jobs WHERE idempotency_key=$1',[await key('gap')])).rowCount).toBe(0)
    await enqueue('gap','2')
    expect((await pool.query('SELECT payload FROM memory_jobs WHERE idempotency_key=$1',[await key('gap')])).rows[0].payload.dialogue_generation).toBe('2')
    expect((await pool.query('SELECT turn_id,status FROM memory_dialogue_compile_receipts ORDER BY turn_id')).rows).toEqual(before)
    expect((await audit()).rows).toEqual(fees)
  })
  test('a locked job yields, a newer execution survives, and separate failure epochs retain distinct digests',async()=>{
    const a=await fail('locked'), b=await fail('reused')
    await settle('locked',a.job_id,a.claim_epoch,32)
    await settle('reused',b.job_id,b.claim_epoch,31)
    await pool.query(`UPDATE memory_jobs SET state='pending',payload=jsonb_set(payload,'{dialogue_generation}','"2"') WHERE job_id=$1`,[b.job_id])
    const c=await pool.connect()
    try{
      await c.query('BEGIN');await c.query('SELECT 1 FROM memory_jobs WHERE job_id=$1 FOR UPDATE',[a.job_id])
      expect((await batch()).counts).toMatchObject({failure_busy:1,failure_active_job:1})
    }finally{await c.query('ROLLBACK');c.release()}
    // Simulate the next daily review after these states changed.
    await pool.query('UPDATE memory_job_failures SET next_review_at=NULL')
    const second=await fail('reused','2')
    expect(second.job_id).toBe(b.job_id)
    expect((await pool.query('SELECT input_generation,claim_epoch FROM memory_job_failures WHERE job_id=$1 ORDER BY claim_epoch',[b.job_id])).rows)
      .toEqual([{input_generation:'1',claim_epoch:'1'},{input_generation:'2',claim_epoch:'2'}])
    expect((await batch()).counts).toMatchObject({failure_cleaned:1,failure_new_failure:1,failure_unresolved:1})
    await pool.query("UPDATE memory_jobs SET state='completed',completed_at=now() WHERE job_id=$1",[b.job_id])
    await pool.query('UPDATE memory_job_failures SET next_review_at=NULL')
    expect((await batch()).counts).toMatchObject({failure_cleaned:1,failure_unresolved:1})
    expect((await pool.query('SELECT claim_epoch FROM memory_dead_letters WHERE job_id=$1',[b.job_id])).rows).toEqual([{claim_epoch:'2'}])
    expect((await pool.query('SELECT claim_epoch FROM memory_jobs WHERE job_id=$1',[b.job_id])).rows).toEqual([{claim_epoch:'2'}])
  })
  test('a duplicate queued while deletion holds the enqueue fence stays deduplicated after commit',async()=>{
    const a=await fail('concurrent')
    await settle('concurrent',a.job_id,a.claim_epoch,31)
    const c=await pool.connect(),sender=await pool.connect()
    let pending:Promise<pg.QueryResult>|undefined
    try{
      await c.query('BEGIN')
      expect((await retainFailureBatch(c,install,enabled)).counts.failure_cleaned).toBe(1)
      const {pid}=(await sender.query('SELECT pg_backend_pid() AS pid')).rows[0]
      pending=sender.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,payload)
        VALUES(gen_random_uuid(),$1,'compile_episode',$2,$3) ON CONFLICT DO NOTHING`,[install,await key('concurrent'),
        {dialogue_session:session,turn:'concurrent',dialogue_generation:'1'}])
      let waiting=false
      for(let i=0;i<50;i++) {
        waiting=(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked
        if(waiting) break
        await new Promise(resolve=>setTimeout(resolve,10))
      }
      expect(waiting).toBe(true)
      await c.query('COMMIT')
      expect((await pending).rowCount).toBe(0)
      expect((await batch()).counts.failure_cleaned).toBeUndefined()
      expect((await pool.query('SELECT 1 FROM memory_failure_cleanup_receipts')).rowCount).toBe(1)
    }finally{await c.query('ROLLBACK');await pending?.catch(()=>undefined);c.release();sender.release()}
  })
  test('historical projection and unsettled paid work remain protected even when their queue row later completes',async()=>{
    const repo=createJobRepository(pool)
    for(const type of ['project_shared_source','consolidate_task'] as const) {
      await repo.enqueueJob({installationId:install,jobType:type,idempotencyKey:type})
      const [claim]=await repo.claimJobs({workerId:'protected',limit:1,leaseMs:30000})
      await repo.rescheduleJob({jobId:claim.job_id,claimEpoch:claim.claim_epoch,claimedBy:'protected',errorCode:'unknown',terminal:true})
    }
    await pool.query("UPDATE memory_jobs SET state='completed',completed_at=now()-interval '8 years'")
    expect((await batch()).counts).toMatchObject({failure_historical_projection:1,failure_provider_or_accounting:1})
    expect((await pool.query('SELECT 1 FROM memory_dead_letters')).rowCount).toBe(2)
  })
  test('daily installation cleanup follows real same-generation recovery and global maintenance protects pending probes',async()=>{
    const old=await fail('recovered')
    await pool.query("UPDATE memory_jobs SET state='pending',completed_at=NULL WHERE job_id=$1",[old.job_id])
    const repo=createJobRepository(pool)
    const [claim]=await repo.claimJobs({workerId:'recovery',limit:1,leaseMs:30000})
    expect(claim.claim_epoch).toBe(old.claim_epoch+1)
    await pool.query('INSERT INTO memory_dialogue_turns(installation_id,session_id,turn_id,requested_generation) VALUES($1,$2,$3,1)',[install,session,'recovered'])
    const fence={jobId:claim.job_id,claimEpoch:claim.claim_epoch,claimedBy:'recovery'}
    await recordDialogueResult(pool,{install,session,turn:'recovered',generation:'1',fence},'published',null,'verified-digest')
    await repo.completeJob(fence)
    await pool.query("UPDATE memory_dialogue_compile_receipts SET closed_at=now()-interval '31 days'")
    const indexJob=randomUUID()
    await pool.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key) VALUES($1,$2,'report_status','stage-probe')`,[indexJob,install])
    await pool.query(`INSERT INTO memory_stage_dispositions(job_id,claim_epoch,installation_id,job_type,object_key,input_digest,status,reason,attempts,processor_revision)
      VALUES($1,0,$2,'report_status','stage-probe','digest','isolated','repair',1,'1')`,[indexJob,install])
    await enqueue('probe')
    const probe=(await pool.query('SELECT job_id FROM memory_jobs WHERE idempotency_key=$1',[await key('probe')])).rows[0].job_id
    await settle('probe',probe,0,3,'failed')
    await pool.query("UPDATE memory_jobs SET state='completed',completed_at=now()-interval '2 days',last_error_code=NULL")
    expect((await previewFailureRetention(pool,install,enabled)).map(r=>r.reason)).toEqual(['eligible'])
    const mock=vi.spyOn(daily,'dailyMaintenanceSlot').mockReturnValue(null)
    const errors:unknown[]=[]
    const worker=createDailyMaintenanceWorker({pool,failures:enabled,signal:new AbortController().signal,
      inbox:{mode:'enabled',bodyDays:7,metadataDays:14,batchSize:1,intervalMs:60000},
      data:{mode:'enabled',bodyDays:30,batchSize:2,intervalMs:86400000},report:async()=>{},onError:e=>errors.push(e)})
    try{
      await pool.query(`INSERT INTO memory_maintenance_runs(scheduled_at,scope_key,installation_id,stage)
        VALUES(date_trunc('second',now())-interval '2 days','global',NULL,3),(date_trunc('second',now())-interval '1 day',$1::uuid::text,$1::uuid,3)`,[install])
      await worker.runOnce()
      expect((await pool.query('SELECT 1 FROM memory_jobs')).rowCount).toBe(3)
      await worker.runOnce()
      expect(errors).toEqual([])
      expect((await pool.query('SELECT counts FROM memory_maintenance_runs WHERE installation_id=$1',[install])).rows[0].counts).toMatchObject({failure_cleaned:1})
      expect((await pool.query('SELECT removed_job FROM memory_failure_cleanup_receipts')).rows).toEqual([{removed_job:true}])
      expect((await pool.query('SELECT job_id FROM memory_jobs')).rows.map(r=>r.job_id).sort()).toEqual([probe,indexJob].sort())
      expect((await pool.query('SELECT count(*)::int n FROM memory_dialogue_compile_receipts')).rows[0].n).toBe(2)
    }finally{await worker.stop();mock.mockRestore()}
  })
  test('orphan summaries require independent legacy linkage and protected entries do not starve other pages',async()=>{
    const orphan=randomUUID()
    await pool.query(`INSERT INTO memory_dead_letters(job_id,installation_id,job_type,attempts,error_code,payload_hash,dead_at)
      VALUES($1,$2,'compile_episode',3,'legacy',sha256('failure'),now()-interval '40 days')`,[orphan,install])
    const old=await fail('old')
    await settle('old',old.job_id,old.claim_epoch,31)
    const tiny={...enabled,batchSize:1}
    const page=await batch(tiny)
    expect(page.counts.failure_unmatched).toBe(1)
    expect((await batch(tiny,page.after)).counts.failure_cleaned).toBe(1)
    await settle('orphan',orphan,7,31,'not_admitted')
    await pool.query(`INSERT INTO memory_dialogue_legacy_failures(job_id,claim_epoch,installation_id,session_id,turn_id,generation,dead_at,payload_hash,attempts,error_code)
      SELECT job_id,6,installation_id,$2,'orphan',1,dead_at,payload_hash,attempts,error_code FROM memory_dead_letters WHERE job_id=$1`,[orphan,session])
    await pool.query('UPDATE memory_job_failures SET next_review_at=NULL')
    expect((await batch()).counts.failure_cleaned).toBe(1)
    await pool.query('DELETE FROM failure_retention_test.enrolled WHERE installation_id=$1',[install])
    expect((await pool.query('SELECT 1 FROM memory_failure_cleanup_receipts')).rowCount).toBe(0)
    expect((await pool.query('SELECT 1 FROM memory_failure_deduplication')).rowCount).toBe(0)
  })
})
