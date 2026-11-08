import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
const url=process.env.TASK8_TEAM_SEMANTIC_NATIVE_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('Task8 truthful native writer eligibility metadata',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{
  if(!url||new URL(url).pathname!=='/task8_team_semantic_native_fix_test')throw Error('exact_task8_fresh_header_fixture_required')
  pool=new pg.Pool({connectionString:url,max:3,statement_timeout:5000,lock_timeout:1000})
 })
 afterAll(async()=>{await pool?.end()})
 test('I1 installation performs no original body eligibility backfill',async()=>{
  expect((await pool.query("SELECT native_team_content_eligibility_version AS version,native_team_content_eligible AS eligible FROM public.collaboration_events WHERE event_id=ANY($1::text[]) ORDER BY event_id",[['task8_pre_header_goal','task8_pre_header_reply','task8_pre_header_outcome']])).rows).toEqual([{version:null,eligible:null},{version:null,eligible:null},{version:null,eligible:null}])
  const client=await pool.connect()
  try{
   await client.query('BEGIN')
   await client.query("UPDATE public.collaboration_calls SET state='completed' WHERE call_id='task8_pre_header_call'")
   expect((await client.query("SELECT publication_xid,publication_order FROM public.native_team_semantic_publications WHERE original_business_key='task8_pre_header_call'")).rows[0]).toEqual({publication_xid:null,publication_order:null})
   // Real NEW content writes establish only current header metadata. The old
   // consumed UNKNOWN key cannot acquire an original clock after repair.
   await client.query("UPDATE public.collaboration_events SET content='new writer-supplied body' WHERE event_id=ANY($1::text[])",[['task8_pre_header_goal','task8_pre_header_reply','task8_pre_header_outcome']])
   await client.query("UPDATE public.collaboration_calls SET state='dispatched' WHERE call_id='task8_pre_header_call'")
   await client.query("UPDATE public.collaboration_calls SET state='completed' WHERE call_id='task8_pre_header_call'")
   expect((await client.query("SELECT publication_xid,publication_order FROM public.native_team_semantic_publications WHERE original_business_key='task8_pre_header_call'")).rows[0]).toEqual({publication_xid:null,publication_order:null})
  }finally{await client.query('ROLLBACK');client.release()}
 })
 test('I1 writer NEW body derives versioned nonempty eligibility; direct INSERT header claims do not override it',async()=>{
  const client=await pool.connect(),id=randomUUID()
  try{
   await client.query('BEGIN')
   await client.query("INSERT INTO public.collaboration_events(event_id,team_session_id,event_seq,kind,content,native_team_content_eligibility_version,native_team_content_eligible) VALUES($1,'session',1,'member_message','',1,TRUE)",[id])
   expect((await client.query('SELECT native_team_content_eligibility_version AS version,native_team_content_eligible AS eligible FROM public.collaboration_events WHERE event_id=$1',[id])).rows[0]).toEqual({version:1,eligible:false})
   await client.query("UPDATE public.collaboration_events SET content='real new body' WHERE event_id=$1",[id])
   expect((await client.query('SELECT native_team_content_eligibility_version AS version,native_team_content_eligible AS eligible FROM public.collaboration_events WHERE event_id=$1',[id])).rows[0]).toEqual({version:1,eligible:true})
  }finally{await client.query('ROLLBACK');client.release()}
 })
 test('I1 metadata-only native header forgery is rejected independently of body reads',async()=>{
  const client=await pool.connect(),id=randomUUID()
  try{
   await client.query('BEGIN')
   await client.query("INSERT INTO public.collaboration_events VALUES($1,'session',1,NULL,'member_message','')",[id])
   await client.query('SAVEPOINT before_forgery')
   await expect(client.query('UPDATE public.collaboration_events SET native_team_content_eligible=TRUE WHERE event_id=$1',[id])).rejects.toThrow('native_team_content_header_immutable')
   await client.query('ROLLBACK TO SAVEPOINT before_forgery')
   expect((await client.query('SELECT native_team_content_eligible AS eligible FROM public.collaboration_events WHERE event_id=$1',[id])).rows[0]).toEqual({eligible:false})
  }finally{await client.query('ROLLBACK');client.release()}
 })
})
