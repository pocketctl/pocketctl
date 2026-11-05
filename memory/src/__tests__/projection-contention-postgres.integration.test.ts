import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createSourceProjector } from '../projection/source-projector.js'
import { createPurgeRepository } from '../purge/repository.js'

const databaseUrl=process.env.MEMORY_TEST_DATABASE_URL
const suite=databaseUrl&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
const installation='11111111-1111-1111-1111-111111111111'

suite('projector contention and lifecycle locks',()=>{
  let pool:pg.Pool
  beforeAll(async()=>{
    pool=new pg.Pool({connectionString:databaseUrl,max:10,statement_timeout:5000})
    await assertMemoryTestDatabase(pool,databaseUrl!)
    await applyMemorySchema(pool)
  },30000)
  afterAll(async()=>{await pool?.end()})
  beforeEach(async()=>{
    await pool.query('TRUNCATE memory_jobs,memory_feed_inbox,source_artifacts,source_turns,source_events,source_sessions,repositories,repo_snapshots,work_episodes,memory_session_tombstones,memory_purge_receipts,memory_installations CASCADE')
    await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version)
      VALUES($1,'pocketctl-memory','active','ready',1)`,[installation])
    await pool.query(`INSERT INTO memory_feed_inbox(installation_id,feed_id,envelope_version,topic,source_kind,source_id,session_id,event_type,recorded_at,classification,data,payload_hash)
      SELECT $1,n,1,'session.event.v1','canonical_event','e-'||n,'s-'||n,'agent_text',NOW(),'{}',jsonb_build_object('text','fixture-'||n),decode(md5(n::text),'hex')
      FROM generate_series(1,2)n`,[installation])
  })
  async function awaitLockWaiters(count:number){
    const deadline=Date.now()+3000
    while(Date.now()<deadline){
      const rows=await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'`)
      if(rows.rows[0].n>=count)return
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    throw new Error('expected blocked projector transactions')
  }
  test('two queued projectors advance to distinct batches without retrying stale session discovery',async()=>{
    const blocker=await pool.connect()
    const projector=createSourceProjector(pool,{batchSize:1})
    let runs:Array<Promise<{projected:number}>>=[]
    try{
      await blocker.query('BEGIN')
      await blocker.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:session:'||$1||':s-1',0))`,[installation])
      runs=[projector.projectOnce(installation),projector.projectOnce(installation)]
      await awaitLockWaiters(2)
    }finally{await blocker.query('ROLLBACK');blocker.release()}
    const results=await Promise.allSettled(runs)
    expect(results).toEqual([{status:'fulfilled',value:{projected:1}},{status:'fulfilled',value:{projected:1}}])
    expect((await pool.query('SELECT count(*)::int AS n FROM source_events')).rows[0].n).toBe(2)
  })
  test('a session purge and queued projectors finish without deadlock or resurrection',async()=>{
    const blocker=await pool.connect()
    const projector=createSourceProjector(pool,{batchSize:1})
    const purge=createPurgeRepository(pool,{hmacKey:'test-key'})
    let runs:Array<Promise<unknown>>=[]
    try{
      await blocker.query('BEGIN')
      await blocker.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:session:'||$1||':s-1',0))`,[installation])
      runs=[projector.projectOnce(installation),projector.projectOnce(installation)]
      await awaitLockWaiters(2)
      runs.push(purge.purgeSession({installationId:installation,sessionId:'s-1',reason:'user_deleted',sourceFeedId:null}))
      await awaitLockWaiters(3)
    }finally{await blocker.query('ROLLBACK');blocker.release()}
    expect((await Promise.allSettled(runs)).every(row=>row.status==='fulfilled')).toBe(true)
    expect((await pool.query(`SELECT count(*)::int AS n FROM source_events WHERE session_id='s-1'`)).rows[0].n).toBe(0)
    expect((await pool.query(`SELECT count(*)::int AS n FROM memory_session_tombstones WHERE session_id='s-1'`)).rows[0].n).toBe(1)
    await projector.projectOnce(installation)
    expect((await pool.query(`SELECT count(*)::int AS n FROM memory_feed_inbox WHERE projection_state='pending'`)).rows[0].n).toBe(0)
  })
  test('installation purge bypasses the projector mutex and never resurrects its source rows',async()=>{
    const blocker=await pool.connect()
    const projector=createSourceProjector(pool,{batchSize:1})
    const purge=createPurgeRepository(pool,{hmacKey:'test-key'})
    let runs:Array<Promise<unknown>>=[]
    try{
      await blocker.query('BEGIN')
      await blocker.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0))`,[installation])
      runs=[projector.projectOnce(installation),projector.projectOnce(installation)]
      await awaitLockWaiters(2)
      runs.push(purge.purgeInstallation({installationId:installation,requestId:'22222222-2222-4222-8222-222222222222',reason:'user_deleted'}))
      await awaitLockWaiters(3)
    }finally{await blocker.query('ROLLBACK');blocker.release()}
    expect((await Promise.allSettled(runs)).every(row=>row.status==='fulfilled')).toBe(true)
    await projector.projectOnce(installation)
    expect((await pool.query('SELECT count(*)::int AS n FROM source_events')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int AS n FROM memory_feed_inbox')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT local_status FROM memory_installations')).rows[0].local_status).toBe('purged')
  })

})
