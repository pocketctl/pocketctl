import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,describe,expect,test} from 'vitest'
const url=process.env.TASK8_TEAM_SEMANTIC_NATIVE_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('Task8 native original-fact dependency lifetime through physical transaction',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{
  if(!url||!['/task8_team_semantic_native_green_test','/task8_team_semantic_native_final_test','/task8_team_semantic_native_fix_test'].includes(new URL(url).pathname))throw Error('exact_task8_native_dependency_fixture_required')
  pool=new pg.Pool({connectionString:url,max:4,statement_timeout:5000,lock_timeout:1000})
  expect((await pool.query("SELECT team_semantic_capture_version AS version FROM public.native_input_start_contract")).rows).toEqual([{version:1}])
 })
 afterAll(async()=>{await pool?.end()})
 test.each(['kind','delete'])('S05 event writer first (%s) prevents original birth under its row lock',async mutation=>{
  const call=randomUUID(),goal=randomUUID(),reply=randomUUID(),outcome=randomUUID()
  await pool.query("INSERT INTO public.collaboration_events VALUES($1,'session',1,NULL,'member_message','goal')",[goal])
  await pool.query("INSERT INTO public.collaboration_calls VALUES($1,'session',$2,'dispatched','task','offer',0)",[call,goal])
  await pool.query("INSERT INTO public.collaboration_events VALUES($1,'session',2,$3,'agent_message','reply'),($2,'session',3,$3,'status','completed')",[reply,outcome,call])
  const writer=await pool.connect(),publisher=await pool.connect()
  try{
   await writer.query('BEGIN')
   if(mutation==='kind')await writer.query("UPDATE public.collaboration_events SET kind='status' WHERE event_id=$1",[reply])
   else await writer.query('DELETE FROM public.collaboration_events WHERE event_id=$1',[reply])
   await publisher.query('BEGIN')
   await expect(publisher.query("UPDATE public.collaboration_calls SET state='completed' WHERE call_id=$1",[call])).rejects.toMatchObject({code:'55P03'})
  }finally{await publisher.query('ROLLBACK');await writer.query('ROLLBACK');publisher.release();writer.release()}
 })
 test('S05 original complete goal/reply/outcome cannot be deleted after SAVEPOINT RELEASE and before physical COMMIT',async()=>{
  const call=randomUUID(),goal=randomUUID(),reply=randomUUID(),outcome=randomUUID()
  // Exact owned synthetic seed is committed before racing independent clients;
  // its seed transaction is compensated only within this test's exact IDs.
  await pool.query("INSERT INTO public.collaboration_events VALUES($1,'session',1,NULL,'member_message','goal')",[goal])
  await pool.query("INSERT INTO public.collaboration_calls VALUES($1,'session',$2,'dispatched','task','offer',0)",[call,goal])
  await pool.query("INSERT INTO public.collaboration_events VALUES($1,'session',2,$3,'agent_message','reply'),($2,'session',3,$3,'status','completed')",[reply,outcome,call])
  const publisher=await pool.connect(),eraser=await pool.connect()
  try{
   await publisher.query('BEGIN');await publisher.query('SAVEPOINT native_birth')
   await publisher.query("UPDATE public.collaboration_calls SET state='completed' WHERE call_id=$1",[call])
   await publisher.query('RELEASE SAVEPOINT native_birth')
   expect((await publisher.query('SELECT publication_xid IS NOT NULL AS original FROM public.native_team_semantic_publications WHERE original_business_key=$1',[call])).rows[0].original).toBe(true)
   await eraser.query('BEGIN')
   await expect(eraser.query('DELETE FROM public.collaboration_events WHERE event_id=$1',[reply])).rejects.toMatchObject({code:'55P03'})
  }finally{
   await publisher.query('ROLLBACK');await eraser.query('ROLLBACK');publisher.release();eraser.release()
   // Avoid deleting the committed native seed here: privacy deletion is itself
   // an original-fact behavior and requires the root's exact cleanup authority.
  }
 })
 test('I1 repeatable-read snapshot predating birth cannot mutate a semantic dependency',async()=>{
  const call=randomUUID(),goal=randomUUID(),reply=randomUUID(),outcome=randomUUID()
  await pool.query("INSERT INTO public.collaboration_events VALUES($1,'session',1,NULL,'member_message','goal')",[goal])
  await pool.query("INSERT INTO public.collaboration_calls VALUES($1,'session',$2,'dispatched','task','offer',0)",[call,goal])
  await pool.query("INSERT INTO public.collaboration_events VALUES($1,'session',2,$3,'agent_message','reply'),($2,'session',3,$3,'status','completed')",[reply,outcome,call])
  const stale=await pool.connect()
  try{
   await stale.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
   expect((await stale.query('SELECT count(*)::int AS n FROM public.native_team_semantic_publications WHERE original_business_key=$1',[call])).rows[0].n).toBe(0)
   await pool.query("UPDATE public.collaboration_calls SET state='completed' WHERE call_id=$1",[call])
   await expect(stale.query("UPDATE public.collaboration_events SET kind='status' WHERE event_id=$1",[reply])).rejects.toThrow('native_team_semantic_writer_isolation_unsupported')
  }finally{await stale.query('ROLLBACK');stale.release()}
 })
 test('I1 RC capture locks survive through COMMIT, then a current dependency deletion retires the original fact',async()=>{
  const call=randomUUID(),goal=randomUUID(),reply=randomUUID(),outcome=randomUUID()
  await pool.query("INSERT INTO public.collaboration_events VALUES($1,'session',1,NULL,'member_message','goal')",[goal])
  await pool.query("INSERT INTO public.collaboration_calls VALUES($1,'session',$2,'dispatched','task','offer',0)",[call,goal])
  await pool.query("INSERT INTO public.collaboration_events VALUES($1,'session',2,$3,'agent_message','reply'),($2,'session',3,$3,'status','completed')",[reply,outcome,call])
  const publisher=await pool.connect(),eraser=await pool.connect()
  try{
   await publisher.query('BEGIN')
   await publisher.query("UPDATE public.collaboration_calls SET state='completed' WHERE call_id=$1",[call])
   await eraser.query('BEGIN')
   await expect(eraser.query('DELETE FROM public.collaboration_events WHERE event_id=$1',[reply])).rejects.toMatchObject({code:'55P03'})
   await eraser.query('ROLLBACK')
   await publisher.query('COMMIT')
   await eraser.query('BEGIN')
   await eraser.query('DELETE FROM public.collaboration_events WHERE event_id=$1',[reply])
   expect((await eraser.query("SELECT retired,original_business_key,publication_xid FROM public.native_team_semantic_publications WHERE source_kind='team_collaboration' AND business_key_hash=sha256(convert_to(jsonb_build_array('team_collaboration'::text,$1::text)::text,'UTF8'))",[call])).rows[0]).toEqual({retired:true,original_business_key:null,publication_xid:null})
  }finally{await publisher.query('ROLLBACK');await eraser.query('ROLLBACK');publisher.release();eraser.release()}
 })

})
