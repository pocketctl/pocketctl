import pg from 'pg'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {migrationRows} from '../migrations/governance-v2/backfill.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('migration source identity scan PostgreSQL',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:2});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 test('single-owner metadata validation uses a covering access path without source heap reads',async()=>{
  await pool.query('TRUNCATE memory_installations CASCADE')
  const id='96969696-9696-4696-8696-969696969696'
  await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)`,[id])
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,event_type,occurred_at,payload,payload_hash)
   SELECT gen_random_uuid(),$1,'feed',n::text,'agent_text',NOW(),jsonb_build_object('text',repeat('private source content ',100)),decode(md5(n::text),'hex') FROM generate_series(1,10000)n`,[id])
  await pool.query('VACUUM ANALYZE source_events')
  let query='',values:unknown[]=[]
  const connection={query:async(sql:string,params:unknown[])=>{query=sql;values=params;return pool.query(sql,params)}} as Pick<pg.PoolClient,'query'>
  const rows=await migrationRows(connection,'source_events',[id],'["00000000-0000-4000-8000-000000000000"]',200,true)
  expect(rows).toHaveLength(200);expect(rows.every(row=>row.row===null)).toBe(true)
  const plan=(await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query,values)).rows[0]['QUERY PLAN'][0].Plan
  const scans:any[]=[]
  const visit=(node:any)=>{if(node['Relation Name']==='source_events')scans.push(node);for(const child of node.Plans??[])visit(child)};visit(plan)
  expect(scans).toHaveLength(1)
  expect(scans[0]['Node Type']).toBe('Index Only Scan')
  expect(scans[0]['Heap Fetches']).toBe(0)
 })
 test('purge proof lookup reads its sparse captured subset instead of the full change log',async()=>{
  const id='96969696-9696-4696-8696-969696969696'
  await pool.query(`INSERT INTO memory_governance_migration_changes(installation_id,entity_kind,entity_id,operation,transaction_id)
   VALUES($1,'memory_session_tombstones','{"session_id":"proof"}','INSERT',pg_current_xact_id()),($1,'source_events','{"source_event_id":"proof"}','DELETE',pg_current_xact_id())`,[id])
  await pool.query('VACUUM ANALYZE memory_governance_migration_changes')
  for(const [family,operation]of [['memory_session_tombstones','INSERT'],['source_events','DELETE']]){
   const result=await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT transaction_id,entity_id FROM memory_governance_migration_changes
    WHERE installation_id=$1 AND sequence>0 AND entity_kind=$2 AND operation=$3 AND transaction_id IS NOT NULL ORDER BY transaction_id,sequence`,[id,family,operation])
   const plans:any[]=[];const visit=(node:any)=>{if(node['Relation Name']==='memory_governance_migration_changes')plans.push(node);for(const c of node.Plans??[])visit(c)};visit(result.rows[0]['QUERY PLAN'][0].Plan)
   expect(plans).toHaveLength(1);expect(plans[0]['Node Type']).toBe('Index Only Scan');expect(plans[0]['Heap Fetches']).toBe(0)
  }
 })

})
