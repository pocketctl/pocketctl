import pg from 'pg'
import {writeFileSync} from 'node:fs'
import {afterAll,beforeAll,describe,expect,test,vi} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createDailyMaintenanceWorker} from '../maintenance/worker.js'
import * as daily from '../maintenance/daily.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_MAINTENANCE_CAPACITY==='1'?describe:describe.skip
suite('daily maintenance isolated capacity',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:4});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)})
 afterAll(async()=>{vi.restoreAllMocks();await pool?.end()})
 test('35,000 old acknowledged inbox rows drain in bounded batches',async()=>{
  const id='71717171-7171-4171-8171-717171717171',slot=new Date('2026-10-30T19:00:00Z'),errors:unknown[]=[],durations:number[]=[],batches:number[]=[]
  vi.spyOn(daily,'dailyMaintenanceSlot').mockReturnValue(slot)
  await pool.query('TRUNCATE memory_maintenance_runs,memory_installations CASCADE')
  await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version,created_at) VALUES($1,'pocketctl-memory','active','ready',1,TIMESTAMPTZ '2026-10-01 00:00:00+00')`,[id])
  await pool.query(`INSERT INTO memory_inbox_checkpoints(installation_id,last_ack_feed_id) VALUES($1,35000)`,[id])
  await pool.query(`INSERT INTO memory_feed_inbox(installation_id,feed_id,envelope_version,recorded_at,topic,source_kind,source_id,event_type,data,payload_hash,projection_state,projected_at)
   SELECT $1,n,1,NOW(),'session.event.v1','canonical_event',n::text,'agent_text',jsonb_build_object('text',repeat('x',1024)),decode(repeat('ab',32),'hex'),'projected',NOW()-INTERVAL '15 days' FROM generate_series(1,35000)n`,[id])
  const worker=createDailyMaintenanceWorker({pool,signal:new AbortController().signal,
   inbox:{mode:'enabled',bodyDays:7,metadataDays:14,batchSize:500,intervalMs:60000},
   data:{mode:'enabled',bodyDays:14,batchSize:500,intervalMs:86400000},report:async()=>{},onError:e=>errors.push(e),
   onResult:r=>{const n=Number((r.counts as Record<string,number>).inbox_metadata??0);if(n)batches.push(n)}})
  try{
   for(let pass=0;pass<100;pass++){
    await pool.query("UPDATE memory_maintenance_runs SET next_attempt_at=NOW()-INTERVAL '1 second'")
    const start=performance.now();await worker.runOnce();durations.push(performance.now()-start)
    if((await pool.query("SELECT count(*)::int n FROM memory_maintenance_runs WHERE state='running'")).rows[0].n===0)break
   }
   expect(errors).toEqual([]);expect(batches).toHaveLength(70);expect(Math.max(...batches)).toBe(500)
   expect((await pool.query('SELECT count(*)::int n FROM memory_feed_inbox')).rows[0].n).toBe(0)
   const sorted=[...durations].sort((a,b)=>a-b)
   const result={scope:'isolated PostgreSQL synthetic inbox, 1 KiB bodies; not production benchmark',rows:35000,batches:70,passes:durations.length,
    processingMs:Math.round(durations.reduce((a,b)=>a+b,0)),passP95Ms:Math.round(sorted[Math.floor(sorted.length*.95)]),
    estimatedWithOneSecondPausesMs:Math.round(durations.reduce((a,b)=>a+b,0)+(durations.length-1)*1000)}
   if(process.env.MEMORY_MAINTENANCE_CAPACITY_REPORT)writeFileSync(process.env.MEMORY_MAINTENANCE_CAPACITY_REPORT,JSON.stringify(result,null,2)+'\n')
  }finally{await worker.stop()}
 },120000)
})
