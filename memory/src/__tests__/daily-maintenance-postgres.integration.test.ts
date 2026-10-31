import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test,vi} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createDailyMaintenanceWorker} from '../maintenance/worker.js'
import * as daily from '../maintenance/daily.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
const id='71717171-7171-4171-8171-717171717171'
suite('durable daily maintenance PostgreSQL',()=>{
 let pool:pg.Pool
 const reports:Array<Record<string,any>>=[],errors:unknown[]=[]
 const inbox={mode:'enabled' as const,bodyDays:7,metadataDays:14,batchSize:2,intervalMs:60000}
 const data={mode:'enabled' as const,bodyDays:14,batchSize:2,intervalMs:86400000}
 const slot=new Date('2026-10-30T19:00:00Z')
 const make=(report=async(r:Record<string,any>)=>{reports.push(r)})=>createDailyMaintenanceWorker({pool,inbox,data,signal:new AbortController().signal,report,onError:e=>errors.push(e)})
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:6});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)})
 afterAll(async()=>{vi.restoreAllMocks();await pool?.end()})
 beforeEach(async()=>{
  vi.restoreAllMocks();vi.spyOn(daily,'dailyMaintenanceSlot').mockReturnValue(slot)
  await pool.query('TRUNCATE memory_maintenance_runs,memory_installations CASCADE')
  await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version,created_at) VALUES($1,'pocketctl-memory','active','ready',1,TIMESTAMPTZ '2026-10-01 00:00:00+00')`,[id])
  await pool.query(`INSERT INTO memory_inbox_checkpoints(installation_id,last_ack_feed_id) VALUES($1,10)`,[id])
  await pool.query(`INSERT INTO memory_feed_inbox(installation_id,feed_id,envelope_version,recorded_at,topic,source_kind,source_id,session_id,event_type,data,classification,payload_hash,projection_state,projected_at)
   SELECT $1,n,1,NOW(),'session.event.v1','canonical_event',n::text,'s','agent_text','{"text":"private"}','{}',decode(repeat('ab',32),'hex'),'projected',NOW()-INTERVAL '15 days' FROM generate_series(1,5) n`,[id])
  reports.length=0;errors.length=0
 })
 async function step(){await pool.query("UPDATE memory_maintenance_runs SET next_attempt_at=NOW()-INTERVAL '1 second'");const w=make();try{await w.runOnce()}finally{await w.stop()}}
 test('restart drains more than one batch, only once per day, with atomic counters and bounded deletion',async()=>{
  for(let i=0;i<20;i++)await step()
  expect(errors).toEqual([])
  expect((await pool.query('SELECT count(*)::int n FROM memory_feed_inbox')).rows[0].n).toBe(0)
  const rows=(await pool.query('SELECT * FROM memory_maintenance_runs ORDER BY scope_key')).rows
  expect(rows).toHaveLength(2);expect(rows.every(r=>r.state==='completed')).toBe(true)
  expect(rows.find(r=>r.installation_id===id).counts).toMatchObject({inbox_body:5,inbox_metadata:5})
  await step();expect((await pool.query('SELECT count(*)::int n FROM memory_maintenance_runs')).rows[0].n).toBe(2)
  expect(reports.some(r=>r.state==='completed'&&r.counts.inbox_body===5)).toBe(true)
 })
 test('before 03:00 no new cycle starts, but an unfinished old cycle resumes',async()=>{
  vi.mocked(daily.dailyMaintenanceSlot).mockReturnValue(null)
  await step();expect((await pool.query('SELECT count(*)::int n FROM memory_maintenance_runs')).rows[0].n).toBe(0)
  vi.mocked(daily.dailyMaintenanceSlot).mockReturnValue(slot);await step()
  vi.mocked(daily.dailyMaintenanceSlot).mockReturnValue(null);await step()
  expect((await pool.query("SELECT counts FROM memory_maintenance_runs WHERE installation_id IS NOT NULL")).rows[0].counts.inbox_metadata).toBeGreaterThan(0)
 })
 test('counter persistence failure rolls back destructive work and GC floor',async()=>{
  await step()
  await pool.query(`UPDATE memory_maintenance_runs SET stage=1,next_attempt_at=NOW()-INTERVAL '1 second' WHERE installation_id=$1`,[id])
  await pool.query("UPDATE memory_maintenance_runs SET state='completed' WHERE scope_key='global'")
  await pool.query(`CREATE FUNCTION maintenance_fail_counts() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.counts ? 'inbox_body' THEN RAISE EXCEPTION 'fixture';END IF;RETURN NEW;END $$;
   CREATE TRIGGER maintenance_fail_counts BEFORE UPDATE ON memory_maintenance_runs FOR EACH ROW EXECUTE FUNCTION maintenance_fail_counts()`)
  try{await step();expect(errors).toHaveLength(1)
   expect((await pool.query('SELECT count(*)::int n FROM memory_feed_inbox')).rows[0].n).toBe(5)
   expect((await pool.query('SELECT gc_feed_id::int n FROM memory_inbox_checkpoints')).rows[0].n).toBe(0)
  }finally{await pool.query('DROP TRIGGER maintenance_fail_counts ON memory_maintenance_runs;DROP FUNCTION maintenance_fail_counts()')}
 })
 test('report delivery failure remains retryable without rerunning committed cleanup',async()=>{
  const w=make(async()=>{throw new Error('offline')});await w.runOnce();await w.stop()
  expect(errors.length).toBeGreaterThan(0)
  expect((await pool.query('SELECT count(*)::int n FROM memory_maintenance_runs WHERE installation_id IS NOT NULL AND revision>reported_revision')).rows[0].n).toBe(1)
  await pool.query("UPDATE memory_maintenance_runs SET report_retry_at=NOW()-INTERVAL '1 second'")
  await step();expect(reports.length).toBeGreaterThan(0)
 })
 test('concurrent workers cannot count or delete the same batch twice',async()=>{
  await step();await pool.query("UPDATE memory_maintenance_runs SET state='completed' WHERE scope_key='global'")
  await pool.query("UPDATE memory_maintenance_runs SET stage=1,next_attempt_at=NOW()-INTERVAL '1 second' WHERE installation_id IS NOT NULL")
  const a=make(),b=make();await Promise.all([a.runOnce(),b.runOnce()]);await a.stop();await b.stop()
  const r=(await pool.query('SELECT counts FROM memory_maintenance_runs WHERE installation_id IS NOT NULL')).rows[0]
  expect(r.counts.inbox_metadata).toBe(2);expect(errors).toEqual([])
 })
})
