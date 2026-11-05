import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createMemoryMetrics } from '../metrics.js'
import { createInboxGaugeUpdater, createWorkerGaugeCollector } from '../worker-gauges.js'
const databaseUrl=process.env.MEMORY_TEST_DATABASE_URL
const suite=databaseUrl&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('inbox active and historical gauge cadence',()=>{
  let pool:pg.Pool
  beforeAll(async()=>{pool=new pg.Pool({connectionString:databaseUrl});await assertMemoryTestDatabase(pool,databaseUrl!);await applyMemorySchema(pool)},30000)
  afterAll(async()=>{await pool?.end()})
  beforeEach(async()=>{
    await pool.query('TRUNCATE memory_installations,memory_feed_inbox CASCADE')
    await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version)
      VALUES('11111111-1111-1111-1111-111111111111','pocketctl-memory','active','ready',1)`)
  })
  test('pending and quarantine refresh promptly while historical totals wait for their cadence',async()=>{
    await pool.query(`INSERT INTO memory_feed_inbox(installation_id,feed_id,envelope_version,topic,source_kind,source_id,event_type,recorded_at,classification,data,payload_hash,projection_state)
      SELECT '11111111-1111-1111-1111-111111111111',n,1,'session.event.v1','canonical_event','e-'||n,'agent_text',NOW(),'{}','{}',decode(md5(n::text),'hex'),
        CASE n WHEN 1 THEN 'pending' WHEN 2 THEN 'quarantined' ELSE 'projected' END FROM generate_series(1,4)n`)
    const metrics=createMemoryMetrics()
    let now=0
    const update=createInboxGaugeUpdater(metrics.inboxRows,{now:()=>now,historyIntervalMs:1000})
    await update(pool)
    const values=async()=>Object.fromEntries((await metrics.inboxRows.get()).values.map(v=>[String(v.labels.state),v.value]))
    expect(await values()).toMatchObject({pending:1,quarantined:1,projected:2,purged:0})
    await pool.query("UPDATE memory_feed_inbox SET projection_state='projected' WHERE feed_id=1")
    now=500
    await update(pool)
    expect(await values()).toMatchObject({pending:0,quarantined:1,projected:2})
    now=1000
    await update(pool)
    expect(await values()).toMatchObject({pending:0,quarantined:1,projected:3})
  })
  test('blocked gauge queries are cancelled and release the connection without inventing history totals',async()=>{
    const blocker=await pool.connect()
    const metrics=createMemoryMetrics()
    const collect=createWorkerGaugeCollector(pool,metrics,false)
    try{
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE memory_feed_inbox IN ACCESS EXCLUSIVE MODE')
      await expect(collect()).rejects.toMatchObject({code:'57014'})
      expect((await metrics.inboxRows.get()).values).toEqual([])
    }finally{await blocker.query('ROLLBACK');blocker.release()}
    await collect()
    expect((await metrics.jobs.get()).values.some(v=>v.labels.type==='index_shared_claim')).toBe(true)
    expect((await metrics.inboxRows.get()).values.some(v=>v.labels.state==='projected')).toBe(true)
    expect((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('0')
  },10000)

  test('a timed out history measurement remains absent and waits a full cadence before retry',async()=>{
    const metrics=createMemoryMetrics()
    const blocker=await pool.connect()
    const reader=await pool.connect()
    let now=0
    const update=createInboxGaugeUpdater(metrics.inboxRows,{now:()=>now,historyIntervalMs:1000})
    try{
      await reader.query("SET statement_timeout='100ms'")
      await blocker.query('BEGIN')
      // Active rows are read first, then history alone encounters real contention.
      const adapter={query:async(text:string)=>{
        if(text.includes("'projected','purged'"))await blocker.query('LOCK TABLE memory_feed_inbox IN ACCESS EXCLUSIVE MODE')
        return reader.query(text)
      }} as Pick<pg.Pool,'query'>
      await expect(update(adapter)).rejects.toMatchObject({code:'57014'})
      await blocker.query('ROLLBACK')
      expect((await metrics.inboxRows.get()).values.some(v=>v.labels.state==='projected')).toBe(false)
      now=500
      await update(reader)
      expect((await metrics.inboxRows.get()).values.some(v=>v.labels.state==='projected')).toBe(false)
      now=1000
      await update(reader)
      expect((await metrics.inboxRows.get()).values.some(v=>v.labels.state==='projected')).toBe(true)
    }finally{
      await blocker.query('ROLLBACK');blocker.release()
      await reader.query('SET statement_timeout=0');reader.release()
    }
  })

})
