import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {prepareCanonicalReferencePage,persistCanonicalReferencePage} from '../../sources/canonical-references.js'
import {withSourceJobExecution} from '../../sources/source-execution.js'

const url=process.env.CONTINUOUS_SOURCE_TEST_DATABASE_URL,suite=url?describe:describe.skip
type Plan={['Node Type']:string;['Relation Name']?:string;['Index Cond']?:string;['Actual Rows']:number;['Actual Loops']:number;['Rows Removed by Filter']?:number;Plans?:Plan[]}
const nodes=(p:Plan):Plan[]=>[p,...(p.Plans??[]).flatMap(nodes)]

suite('canonical mapping guard uses selective historical lookups',()=>{
 let f:DirectLaunchFixture,client:pg.PoolClient,sql:string,installation:string
 beforeAll(async()=>{
  f=await directLaunchFixture(url!)
  const source=await f.source();installation=(await f.install(source,'retained_history')).inst.installation_id
  const key=await f.event(source),root={kind:'relay_event' as const,key:f.root(source)},job=randomUUID()
  await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  const scope=(await f.runtime.query("SELECT source_scope FROM shared.enumerate_memory_source_targets('relay_event',$1,'',64)",[root.key])).rows[0].source_scope
  await f.runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1::uuid,$2,'project_shared_source',$1::text,52,'running','mapping-guard-fixture',1,clock_timestamp()+interval '5 minutes')",[job,installation])
  // Observe the actual opaque-page writer without replacing any query or gate.
  const clients=new Map<pg.PoolClient,pg.PoolClient['query']>()
  const acquire=(c:pg.PoolClient)=>{
   if(clients.has(c))return
   const original=c.query;clients.set(c,original)
   c.query=(async function(...args:any[]){
    const text=typeof args[0]==='string'?args[0]:args[0]?.text??''
    if(text.includes("mapping_state IN('unproven','conflict')"))sql=text
    return (original as any).apply(c,args)
   }) as pg.PoolClient['query']
  }
  f.runtime.on('acquire',acquire)
  try{
   await withSourceJobExecution(f.runtime,{jobId:job,claimedBy:'mapping-guard-fixture',claimEpoch:1},async()=>{
    const page=await prepareCanonicalReferencePage(f.runtime,scope,root,{keys:[key]})
    expect(await persistCanonicalReferencePage(f.runtime,page)).toHaveLength(1)
   })
  }finally{f.runtime.removeListener('acquire',acquire);for(const[c,original]of clients)c.query=original}
  expect(sql!).toBeDefined()
  // Only this disposable database grants TEMP for the synthetic plan fixture;
  // the real writer above ran with the ordinary restricted application role.
  await f.pool.query('GRANT TEMPORARY ON DATABASE shared_direct_launch_memory_test TO direct_launch_memory')
  client=await f.runtime.connect()
  // Session-local synthetic relation: the same two existing partial index
  // shapes, no production/schema migration and no planner switches. Verified
  // rows skew whole-table subject statistics, while historical unproven rows
  // belong to unrelated subjects in the same installation.
  await client.query(`CREATE TEMP TABLE source_events(source_event_id uuid PRIMARY KEY,installation_id uuid NOT NULL,session_id text,canonical_session_key text,mapping_state text NOT NULL);
   CREATE INDEX source_events_unproven_session ON source_events(installation_id,session_id) WHERE mapping_state IN('unproven','conflict');
   CREATE INDEX source_events_unproven_canonical_session ON source_events(installation_id,canonical_session_key) WHERE mapping_state IN('unproven','conflict')`)
  await client.query(`INSERT INTO source_events
   SELECT md5('mapping-noise-'||n)::uuid,$1::uuid,'unrelated-'||(n%2000),NULL,'unproven' FROM generate_series(1,200000)n
   UNION ALL SELECT md5('mapping-verified-'||n)::uuid,$1::uuid,
    CASE WHEN n<=2000 THEN 'verified-hot' ELSE 'verified-unrelated-'||(n%2000) END,
    CASE WHEN n<=2000 THEN 'canonical-hot' END,'verified' FROM generate_series(1,200000)n`,[installation])
  await client.query('ANALYZE source_events')
 },60000)
 afterAll(async()=>{client?.release();await f?.close()})

 test('a no-match guard does not examine historical distractor rows when verified subjects dominate statistics',async()=>{
  const result=await client.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,[installation,['verified-hot','canonical-hot']])
  const plan=result.rows[0]['QUERY PLAN'][0],all=nodes(plan.Plan),sources=all.filter(p=>p['Relation Name']==='source_events')
  console.info('canonical_mapping_guard_plan',JSON.stringify(plan))
  expect(sources.length).toBeGreaterThan(0)
  expect(sources.every(p=>!p['Node Type'].includes('Seq Scan'))).toBe(true)
  for(const subject of ['session_id','canonical_session_key'])expect(all.some(p=>p['Index Cond']?.includes(subject)&&p['Index Cond']?.includes('installation_id'))).toBe(true)
  expect(sources.every(p=>(p['Actual Rows']+(p['Rows Removed by Filter']??0))*p['Actual Loops']<100)).toBe(true)
  expect((await client.query(sql,[installation,['verified-hot','canonical-hot']])).rowCount).toBe(0)
 })

 test('mapping refusal preserves either-column, installation and state semantics with SQL NULLs and duplicate matches',async()=>{
  const other=randomUUID()
  await client.query(`INSERT INTO source_events VALUES
   (md5('guard-session')::uuid,$1,'session-match',NULL,'unproven'),
   (md5('guard-canonical')::uuid,$1,NULL,'canonical-match','conflict'),
   (md5('guard-both')::uuid,$1,'both-match','both-match','unproven'),
   (md5('guard-duplicate')::uuid,$1,'both-match',NULL,'conflict'),
   (md5('guard-foreign')::uuid,$2,'foreign-match','foreign-match','unproven'),
   (md5('guard-null')::uuid,$1,NULL,NULL,'unproven')`,[installation,other])
  const cases:{subjects:(string|null)[]|null;blocked:boolean}[]=[
   {subjects:['session-match'],blocked:true},{subjects:['canonical-match'],blocked:true},
   {subjects:['missing','canonical-match'],blocked:true},{subjects:['session-match','canonical-match'],blocked:true},
   {subjects:['both-match','both-match'],blocked:true},{subjects:['foreign-match'],blocked:false},
   {subjects:['verified-hot','canonical-hot'],blocked:false},{subjects:[],blocked:false},
   {subjects:[null],blocked:false},{subjects:null,blocked:false},{subjects:[null,'canonical-match'],blocked:true},
   {subjects:['missing'],blocked:false},
  ]
  for(const {subjects,blocked}of cases){
   const result=await client.query(sql,[installation,subjects])
   // The writer uses rowCount truthiness; duplicates must still yield at most
   // one witness and never change a negative/positive mapping decision.
   expect({subjects,rows:result.rowCount}).toEqual({subjects,rows:blocked?1:0})
  }
  expect((await client.query(sql,[other,['foreign-match']])).rowCount).toBe(1)
 })
})
