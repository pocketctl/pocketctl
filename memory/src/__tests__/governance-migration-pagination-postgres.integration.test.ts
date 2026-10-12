import pg from 'pg'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {applyMemoryV50Fixture,V50_IDS} from '../testing/fixtures/memory-v50.js'
import {seedMemoryV50UpgradeScenarios} from '../testing/fixtures/memory-v50-upgrade.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {decodeMigrationBaseline} from '../migrations/governance-v2/baseline-snapshot.js'
import {validateGovernanceMigration} from '../migrations/governance-v2/validate.js'
import {startGovernanceBackfill,backfillGovernance,governanceEnvironmentFingerprint,migrationRows} from '../migrations/governance-v2/backfill.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('migration UUID pagination preserves legacy checkpoints and primary-key access',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{
  pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!)
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await applyMemoryV50Fixture(pool,url!);await seedMemoryV50UpgradeScenarios(pool,url!);await applyMemorySchema(pool)
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,event_type,occurred_at,payload,payload_hash)
   SELECT ('00000000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,CASE WHEN n%3=0 THEN $2::uuid ELSE $1::uuid END,'feed',n::text,'test',NOW(),jsonb_build_object('text',repeat('x',512)),decode('aa','hex') FROM generate_series(1,6000) n`,[V50_IDS.personal,V50_IDS.team])
  await pool.query('ANALYZE source_events')
 },60000)
 afterAll(async()=>{await pool?.end()})
 test('UUID page supports primary-key order without sorting JSON payloads',async()=>{
  const c=await pool.connect();let sql='',values:any[]=[]
  try{
   const observed={query:async(q:any,v?:any[])=>{if(typeof q==='string'&&q.includes(' AS id,to_jsonb(t) AS row')){sql=q;values=v??[]}return c.query(q,v)}}
   const rows=await migrationRows(observed as any,'source_events',[V50_IDS.personal],'',200)
   expect(rows).toHaveLength(200)
   // A small fixture may prefer a sequential scan; prove index-order eligibility.
   await c.query('SET enable_seqscan=off')
   const explain=(await c.query('EXPLAIN (FORMAT JSON) '+sql,values)).rows[0]['QUERY PLAN'][0].Plan
   const nodes:string[]=[];const walk=(p:any)=>{nodes.push(p['Node Type']);for(const child of p.Plans??[])walk(child)};walk(explain)
   expect(nodes).not.toContain('Sort');expect(nodes).toContain('Index Scan')
  }finally{await c.query('RESET enable_seqscan');c.release()}
 })
 test('existing JSON-string UUID cursor resumes the same scoped sequence with no duplicates',async()=>{
  const expected=(await pool.query(`SELECT jsonb_build_array(source_event_id::text)::text id FROM source_events WHERE installation_id=$1 ORDER BY jsonb_build_array(source_event_id::text)::text COLLATE "C"`,[V50_IDS.personal])).rows.map(r=>r.id)
  const got:string[]=[];let after=''
  while(true){const rows=await migrationRows(pool as any,'source_events',[V50_IDS.personal],after,200);for(const r of rows){expect(r.row.installation_id).toBe(V50_IDS.personal);got.push(r.id)}if(rows.length<200)break;after=rows.at(-1)!.id}
  expect(got).toEqual(expected);expect(new Set(got).size).toBe(got.length)
  expect((await migrationRows(pool as any,'source_events',[V50_IDS.personal],expected[1999],200)).map(r=>r.id)).toEqual(expected.slice(2000,2200))
 },60000)
 test('compressed database baseline validates every source row and rejects tampering',async()=>{
  const runId=await startGovernanceBackfill(pool,{installationIds:[V50_IDS.personal,V50_IDS.team],environmentFingerprint:await governanceEnvironmentFingerprint(pool)})
  const stored=(await pool.query('SELECT manifest FROM memory_governance_migration_runs WHERE run_id=$1',[runId])).rows[0].manifest
  expect(stored.snapshot.encoding).toBe('gzip-json-v1')
  expect(Object.keys(decodeMigrationBaseline(stored).rows.source_events).length).toBeGreaterThanOrEqual(6000)
  await backfillGovernance(pool,{runId,batchSize:200})
  expect((await validateGovernanceMigration(pool,runId)).violations).toEqual([])
  await pool.query('UPDATE memory_governance_migration_runs SET manifest=$2 WHERE run_id=$1',[runId,{...stored,snapshot:{...stored.snapshot,sha256:'0'.repeat(64)}}])
  await expect(validateGovernanceMigration(pool,runId)).rejects.toThrow('migration_snapshot_integrity')
  await pool.query('UPDATE memory_governance_migration_runs SET manifest=$2 WHERE run_id=$1',[runId,stored])
  expect((await validateGovernanceMigration(pool,runId)).invariants.every(i=>i.passed)).toBe(true)
 },60000)

})
