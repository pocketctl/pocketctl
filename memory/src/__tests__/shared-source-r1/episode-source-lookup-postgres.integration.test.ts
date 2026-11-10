import pg from 'pg'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {canonicalPayloadHash} from '@pocketctl/session-source'
import {applyMemorySchema,MEMORY_MIGRATIONS} from '../../schema.js'
import {prepareEpisodeSources} from '../../sources/prepared-sources.js'

const url=process.env.EPISODE_LOOKUP_TEST_DATABASE_URL,suite=url?describe:describe.skip
const installation='10000000-0000-0000-0000-000000000104',other='10000000-0000-0000-0000-000000000105'
const at='2026-11-10T00:00:00Z',id=(n:number)=>`40000000-0000-0000-0000-${String(n).padStart(12,'0')}`
const oldQuery=`SELECT s.source_event_id::text FROM source_events s JOIN source_turns t ON t.installation_id=s.installation_id AND t.turn_id=$2
 WHERE s.installation_id=$1 AND(s.turn_id=$2 OR(s.turn_id IS NULL AND s.session_id=t.session_id AND s.event_type IN('session_created','session_discovered') AND s.occurred_at<=t.terminal_at))
 ORDER BY s.source_event_id LIMIT 4097`
type Plan={['Node Type']:string;['Relation Name']?:string;['Index Name']?:string;['Index Cond']?:string;['Rows Removed by Filter']?:number;['Actual Rows']:number;Plans?:Plan[]}
const nodes=(p:Plan):Plan[]=>[p,...(p.Plans??[]).flatMap(nodes)]

suite('bounded episode source lookup',()=>{
 let pool:pg.Pool
 const insert=async(n:number,turn:string|null,session:string|null='current-session',type='agent_text',occurred=at,inst=installation,payload:Record<string,unknown>={text:'exact source body'})=>{
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash)
   VALUES($1::uuid,$2,'feed',$1::text,$3,$4,$5,$6,$7,$8)`,[id(n),inst,session,turn,type,occurred,payload,canonicalPayloadHash(payload)])
 }
 // Capture the SQL actually executed by the preparation/final membership reader.
 const observe=()=>{
  const calls:{sql:string;args:unknown[];ids:string[]}[]=[]
  const db={async query(sql:string,args:unknown[]){const result=await pool.query(sql,args);if(sql.includes('LIMIT 4097'))calls.push({sql,args,ids:result.rows.map(r=>r.source_event_id)});return result}}
  return {db:db as unknown as pg.Pool,calls}
 }
 beforeAll(async()=>{
  if(!url||new URL(url).pathname!=='/episode_lookup_test')throw Error('isolated_episode_lookup_test_required')
  pool=new pg.Pool({connectionString:url})
  await applyMemorySchema(pool)
  for(const inst of [installation,other]){
   await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[inst])
   await pool.query("INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'current-session',$2,$2)",[inst,at])
  }
  await pool.query("INSERT INTO source_turns(installation_id,turn_id,session_id,state,terminal_at) VALUES($1,'target-turn','current-session','completed',$2),($1,'null-terminal','current-session','running',NULL)",[installation,at])
  await insert(9,'target-turn');await insert(2,'target-turn','old-alias');await insert(5,'target-turn','other-session');await insert(8,'target-turn',null)
  await insert(1,null,'current-session','session_created','2026-11-09T23:59:59Z')
  await insert(3,null,'current-session','session_discovered')
  await insert(4,null,'current-session','session_created','2026-11-10T00:00:00.001Z')
  await insert(6,null,'old-alias','session_created');await insert(7,null,'current-session','agent_text')
  await insert(10,'different-turn','current-session','session_created');await insert(11,'target-turn','current-session','agent_text',at,other)
  await insert(12,'missing-turn');await insert(13,'null-terminal')
  // Same installation, unrelated sessions/turns, mixed reclaimed/live rows.
  // Enough cardinality and real statistics to reveal an installation-wide scan.
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,body_reclaimed_at)
   SELECT md5('episode-lookup-noise-'||n)::uuid,$1,'feed','noise-'||n,'unrelated-'||(n%2000),CASE WHEN n%3=0 THEN NULL ELSE 'noise-turn-'||n END,'agent_text',$2,'{}',decode(repeat('00',32),'hex'),CASE WHEN n%2=0 THEN now() END
   FROM generate_series(1,200000)n`,[installation,at])
  await pool.query('ANALYZE source_events;ANALYZE source_turns')
 },60000)
 afterAll(async()=>{await pool?.end()})
 test('additive schema 100 has a full turn index and retains the partial retention index',async()=>{
  expect(MEMORY_MIGRATIONS.find(m=>m.version===100)?.statements).toHaveLength(1)
  const indexes=(await pool.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='source_events'")).rows
  expect(indexes.find(r=>r.indexname==='source_events_installation_turn_event_idx')?.indexdef).toMatch(/\(installation_id, turn_id, source_event_id\)$/)
  expect(indexes.find(r=>r.indexname==='source_events_installation_turn_event_idx')?.indexdef).not.toContain('UNIQUE')
  expect(indexes.find(r=>r.indexname==='memory_source_body_retention_idx')?.indexdef).toContain('WHERE (body_reclaimed_at IS NULL)')
  // Model schema 99 with the exact full index already staged by an operator.
  // Activation and repeated migrations must retain that physical index.
  const before=(await pool.query("SELECT 'source_events_installation_turn_event_idx'::regclass::oid AS oid")).rows[0].oid
  await pool.query('DELETE FROM memory_schema_migrations WHERE version=100')
  await applyMemorySchema(pool);await applyMemorySchema(pool)
  expect((await pool.query("SELECT 'source_events_installation_turn_event_idx'::regclass::oid AS oid")).rows[0].oid).toBe(before)
  expect((await pool.query('SELECT max(version)::int AS schema_version FROM memory_schema_migrations')).rows[0].schema_version).toBe(100)
 })
 test('membership equals the original query, preserving same-turn aliases, disjoint metadata and UUID order',async()=>{
  const {db,calls}=observe(),prepared=await prepareEpisodeSources(db,installation,'target-turn')
  const original=(await pool.query(oldQuery,[installation,'target-turn'])).rows.map(r=>r.source_event_id)
  expect(calls[0].ids).toEqual([1,2,3,5,8,9].map(id));expect(calls[0].ids).toEqual(original)
  expect(new Set(calls[0].ids).size).toBe(calls[0].ids.length)
  expect(prepared.events.map(e=>e.source_event_id)).toEqual([1,2,3,5,8,9].map(id))
  expect(prepared.events.every(e=>canonicalPayloadHash(e.payload).equals(e.payload_hash))).toBe(true)
  await prepared.assertCurrent(db)
  expect(calls[1].ids).toEqual(original)
 })
 test('missing source_turns rows yield no refs and NULL terminal excludes all session metadata',async()=>{
  for(const [turn,expected] of [['missing-turn',[]],['null-terminal',[id(13)]]] as const){
   const {db,calls}=observe(),prepared=await prepareEpisodeSources(db,installation,turn)
   expect(calls[0].ids).toEqual(expected);expect(calls[0].ids).toEqual((await pool.query(oldQuery,[installation,turn])).rows.map(r=>r.source_event_id))
   expect(prepared.events.map(e=>e.source_event_id)).toEqual(expected)
  }
 })
 test('reclaimed same-turn aliases stay in membership and fail closed',async()=>{
  await insert(17,'target-turn','reclaimed-alias')
  await pool.query('UPDATE source_events SET body_reclaimed_at=now() WHERE source_event_id=$1',[id(17)])
  try{
   const {db,calls}=observe()
   await expect(prepareEpisodeSources(db,installation,'target-turn')).rejects.toThrow('source_reference_reclaimed')
   expect(calls[0].ids).toContain(id(17))
  }finally{await pool.query('DELETE FROM source_events WHERE source_event_id=$1',[id(17)])}
 })
 test('initial and final membership use bounded source indexes even when refs are reclaimed',async()=>{
  await insert(18,'target-turn','plan-reclaimed-alias')
  const {db,calls}=observe(),prepared=await prepareEpisodeSources(db,installation,'target-turn');await prepared.assertCurrent(db)
  await pool.query('UPDATE source_events SET body_reclaimed_at=now() WHERE source_event_id=$1',[id(18)])
  try{
   for(const call of calls){
    const result=await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+call.sql,call.args),plan=result.rows[0]['QUERY PLAN'][0]
    console.log('episode_lookup_plan',JSON.stringify(plan))
    const all=nodes(plan.Plan),source=all.filter(p=>p['Relation Name']==='source_events')
    expect(source.some(p=>p['Node Type'].includes('Seq Scan'))).toBe(false)
    expect(all.some(p=>p['Index Name']==='source_events_installation_turn_event_idx'&&p['Index Cond']?.includes('turn_id'))).toBe(true)
    expect(all.some(p=>p['Index Name']==='idx_source_events_session_time'&&p['Index Cond']?.includes('session_id'))).toBe(true)
    expect(source.every(p=>p['Actual Rows']+(p['Rows Removed by Filter']??0)<100)).toBe(true)
    expect((await pool.query(call.sql,call.args)).rows.map(r=>r.source_event_id)).toContain(id(18))
   }
  }finally{await pool.query('DELETE FROM source_events WHERE source_event_id=$1',[id(18)])}
 })
 test('final membership rejects newly arrived cross-session refs and metadata',async()=>{
  for(const [n,turn,session,type] of [[14,'target-turn','another-alias','agent_text'],[15,null,'current-session','session_discovered']] as const){
   const prepared=await prepareEpisodeSources(pool,installation,'target-turn')
   await insert(n,turn,session,type)
   try{await expect(prepared.assertCurrent(pool)).rejects.toThrow('source_reference_changed')}finally{await pool.query('DELETE FROM source_events WHERE source_event_id=$1',[id(n)])}
  }
 })
 test('4097 ordered members reject before any body batch is prepared',async()=>{
  await pool.query("INSERT INTO source_turns(installation_id,turn_id,session_id,state,terminal_at) VALUES($1,'oversize-turn','current-session','completed',$2)",[installation,at])
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash)
   SELECT md5('episode-lookup-cap-'||n)::uuid,$1,'feed','cap-'||n,'old-alias','oversize-turn','agent_text',$2,'{}',decode(repeat('00',32),'hex') FROM generate_series(1,4100)n`,[installation,at])
  const {db,calls}=observe();await expect(prepareEpisodeSources(db,installation,'oversize-turn')).rejects.toThrow('source_reference_limit')
  expect(calls[0].ids).toHaveLength(4097);expect(calls[0].ids).toEqual([...calls[0].ids].sort())
  expect(calls[0].ids).toEqual((await pool.query(oldQuery,[installation,'oversize-turn'])).rows.map(r=>r.source_event_id))
 })
 test('32 MiB body bound and original hash validation still apply to episode preparation',async()=>{
  await pool.query("INSERT INTO source_turns(installation_id,turn_id,session_id,state,terminal_at) VALUES($1,'large-turn','current-session','completed',$2)",[installation,at])
  await insert(16,'large-turn','old-alias','agent_text',at,installation,{text:'x'.repeat(32*1024*1024)})
  try{await expect(prepareEpisodeSources(pool,installation,'large-turn')).rejects.toThrow('source_reference_byte_limit')}finally{await pool.query('DELETE FROM source_events WHERE source_event_id=$1',[id(16)])}
  await pool.query("UPDATE source_events SET payload='{\"text\":\"tampered\"}' WHERE source_event_id=$1",[id(9)])
  try{await expect(prepareEpisodeSources(pool,installation,'target-turn')).rejects.toThrow('source_reference_hash_mismatch')}finally{await pool.query('UPDATE source_events SET payload=$2 WHERE source_event_id=$1',[id(9),{text:'exact source body'}])}
 },30000)
})
