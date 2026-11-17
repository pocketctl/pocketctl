import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {randomUUID} from 'node:crypto'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {planUsageRepair,applyUsageRepair} from '../reporting/usage-repair.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('usage repair never repeats model work',()=>{
 let m:pg.Client,r:pg.Client
 const installation=randomUUID(),at=new Date('2026-11-15T00:00:00Z')
 beforeAll(async()=>{
  m=new pg.Client({connectionString:url});r=new pg.Client({connectionString:url});await m.connect();await r.connect();await assertMemoryTestDatabase(m,url!)
  const facts=`installation_id uuid,usage_id text,operation text,model text,input_tokens bigint,output_tokens bigint,embedding_tokens bigint,cached_tokens bigint,cost_micros bigint,occurred_at timestamptz,PRIMARY KEY(installation_id,usage_id)`
  await m.query(`CREATE TEMP TABLE memory_usage_outbox(${facts},attempts integer,dead_lettered_at timestamptz,reported_at timestamptz,last_error_code text)`)
  await r.query(`CREATE TEMP TABLE extension_provider_usage_facts(${facts})`)
 })
 afterAll(async()=>{await m?.end();await r?.end()})
 beforeEach(async()=>{await m.query('TRUNCATE memory_usage_outbox');await r.query('TRUNCATE extension_provider_usage_facts')})
 async function seed(id:string,ledger=false){
  const args=[installation,id,'curation','synthetic',10,2,0,0,0,at]
  await m.query("INSERT INTO memory_usage_outbox VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,10,clock_timestamp(),NULL,'invalid_request')",args)
  if(ledger)await r.query('INSERT INTO extension_provider_usage_facts VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',args)
  return {installationId:installation,usageId:id}
 }
 test('frozen facts reconcile existing ledger and requeue absent facts idempotently',async()=>{
  const keys=[await seed('missing'),await seed('present',true)]
  await seed('outside')
  await m.query('BEGIN READ ONLY');await r.query('BEGIN READ ONLY')
  const manifest=await planUsageRepair(m,r,keys)
  await m.query('COMMIT');await r.query('COMMIT')
  await m.query('BEGIN');const result=await applyUsageRepair(m,r,manifest);await m.query('COMMIT')
  expect(result.map(x=>x.state)).toEqual(['requeued','reconciled'])
  expect((await m.query("SELECT attempts,dead_lettered_at FROM memory_usage_outbox WHERE usage_id='outside'")).rows[0]).toMatchObject({attempts:10,dead_lettered_at:expect.any(Date)})
  await m.query('BEGIN');expect((await applyUsageRepair(m,r,manifest)).map(x=>x.state)).toEqual(['already_requeued','already_reported']);await m.query('COMMIT')
  expect((await m.query('SELECT sum(input_tokens)::int n FROM memory_usage_outbox')).rows[0].n).toBe(30)
 })
 test('immutable changes refuse and roll back an earlier repaired row',async()=>{
  const manifest=await planUsageRepair(m,r,[await seed('a'),await seed('z')])
  await m.query("UPDATE memory_usage_outbox SET input_tokens=11 WHERE usage_id='z'")
  await m.query('BEGIN');await expect(applyUsageRepair(m,r,manifest)).rejects.toThrow('usage_fact_changed');await m.query('ROLLBACK')
  expect((await m.query('SELECT count(*)::int n FROM memory_usage_outbox WHERE dead_lettered_at IS NOT NULL')).rows[0].n).toBe(2)
 })
 test('conflicting Relay ledger or wrong database identity refuses',async()=>{
  const manifest=await planUsageRepair(m,r,[await seed('same',true)])
  await r.query('UPDATE extension_provider_usage_facts SET output_tokens=99')
  await expect(applyUsageRepair(m,r,manifest)).rejects.toThrow('usage_ledger_conflict')
  await expect(applyUsageRepair(m,r,{...manifest,database:{database:'different'}})).rejects.toThrow('usage_database_identity_changed')
 })
 test('unknown provider outcomes are not eligible for accounting retry',async()=>{
  const key=await seed('unknown');await m.query("UPDATE memory_usage_outbox SET last_error_code='provider_result_unknown'")
  await expect(planUsageRepair(m,r,[key])).rejects.toThrow('usage_repair_not_eligible')
 })
})
