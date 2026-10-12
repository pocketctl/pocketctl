import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createJobRepository} from '../jobs/repository.js'
import {assertJobFence,releaseJobFence} from '../generation/fence.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('job commit clock fence',()=>{
 let pool:pg.Pool
 const installation='11111111-1111-4111-8111-111111111111'
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:4});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE');await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installation])})
 test('lease expiry after a fenced generation write rolls back the entire transaction',async()=>{
  const jobs=createJobRepository(pool)
  await jobs.enqueueJob({installationId:installation,jobType:'compile_context_shadow',idempotencyKey:'late-commit'})
  const [job]=await jobs.claimJobs({workerId:'worker',limit:1,leaseMs:250})
  const client=await pool.connect()
  try{
   await client.query('BEGIN');await assertJobFence(client,{jobId:job.job_id,claimedBy:'worker',claimEpoch:job.claim_epoch})
   await client.query(`INSERT INTO memory_generation_runs(run_id,installation_id,operation,subject_kind,subject_key_hash,input_digest,effective_policy_hash,state)
     VALUES(gen_random_uuid(),$1,'compile_context','episode',decode(md5('subject'),'hex'),decode(md5('input'),'hex'),decode(md5('policy'),'hex'),'succeeded')`,[installation])
   await client.query('SELECT pg_sleep(0.3)')
   await expect(client.query('COMMIT')).rejects.toMatchObject({code:'55000'})
  }finally{await client.query('ROLLBACK').catch(()=>undefined);client.release()}
  expect((await pool.query('SELECT count(*)::int n FROM memory_generation_runs')).rows[0].n).toBe(0)
 })
 test.each(['unregistered','expired','epoch_changed'] as const)('released job %s cannot bypass the commit fence',async cause=>{
  const jobs=createJobRepository(pool);await jobs.enqueueJob({installationId:installation,jobType:'compile_context_shadow',idempotencyKey:cause})
  const [job]=await jobs.claimJobs({workerId:'worker',limit:1,leaseMs:cause==='expired'?250:60000}),fence={jobId:job.job_id,claimedBy:'worker',claimEpoch:job.claim_epoch},c=await pool.connect()
  try{await c.query('BEGIN');await assertJobFence(c,fence)
   if(cause!=='unregistered')await releaseJobFence(c,fence,'pending')
   await c.query("UPDATE memory_jobs SET state='pending',claimed_by=NULL,claim_expires_at=NULL,claim_epoch=claim_epoch+$2 WHERE job_id=$1",[job.job_id,cause==='epoch_changed'?1:0])
   if(cause==='expired')await c.query('SELECT pg_sleep(0.3)')
   await expect(c.query('COMMIT')).rejects.toMatchObject({code:'55000'})
  }finally{await c.query('ROLLBACK').catch(()=>undefined);c.release()}
  expect((await pool.query('SELECT state FROM memory_jobs WHERE job_id=$1',[job.job_id])).rows[0].state).toBe('running')
 })

})
