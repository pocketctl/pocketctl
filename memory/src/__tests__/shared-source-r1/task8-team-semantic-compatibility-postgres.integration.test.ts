import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {assertNativeInputStartCompatible as memoryCompatible} from '../../migrations/shared-db/input-start-contract.js'
const url=process.env.TASK8_TEAM_SEMANTIC_NATIVE_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('Task8 independent native semantic drift and physical capture guards',()=>{
 let pool:pg.Pool,relayCompatible:(db:Pick<pg.Pool,'query'>)=>Promise<void>
 beforeAll(async()=>{
  if(!url||!['/task8_team_semantic_native_green_test','/task8_team_semantic_native_final_test','/task8_team_semantic_native_fix_test'].includes(new URL(url).pathname))throw Error('exact_task8_existing_green_required')
  pool=new pg.Pool({connectionString:url,max:4,statement_timeout:5000,lock_timeout:1000})
  expect((await pool.query("SELECT current_database() AS database_name,(SELECT max(team_semantic_capture_version) FROM public.native_input_start_contract) AS version")).rows[0]).toEqual({database_name:new URL(url).pathname.slice(1),version:1})
  relayCompatible=(await import(new URL('../../../../relay/src/shared-source/input-start.ts',import.meta.url).href)).assertNativeInputStartCompatible
 })
 afterAll(async()=>{await pool?.end()})
 async function refuseAfter(sql:string,code='native_team_semantic_history_missing'){
  const client=await pool.connect()
  try{
   await client.query('BEGIN');await client.query(sql)
   for(const validate of [relayCompatible,memoryCompatible]){
    const statements:string[]=[],observed={query:async(text:string,args?:unknown[])=>{statements.push(text);return client.query(text,args)}}
    await expect(validate(observed as unknown as Pick<pg.Pool,'query'>)).rejects.toThrow(code)
    expect(statements.filter(statement=>/^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REVOKE|GRANT)/i.test(statement))).toEqual([])
   }
  }finally{await client.query('ROLLBACK');client.release()}
 }
 test('S08 both independent migrators reject a missing original ledger before DDL',async()=>{
  await refuseAfter('DROP TABLE public.native_team_semantic_publications CASCADE')
 })
 test('S08 both reject a disabled original capture trigger',async()=>{
  await refuseAfter('ALTER TABLE public.team_acceptance_decisions DISABLE TRIGGER native_team_semantic_after')
 })
 test('S08 both reject future native capability before DDL',async()=>{
  await refuseAfter('ALTER TABLE public.native_input_start_contract DISABLE TRIGGER native_input_immutable;UPDATE public.native_input_start_contract SET team_semantic_capture_version=2;ALTER TABLE public.native_input_start_contract ENABLE TRIGGER native_input_immutable','unsupported_native_team_semantic_contract')
 })
 test('S08 both reject removal of the 32-byte native identity invariant',async()=>{
  await refuseAfter('ALTER TABLE public.native_team_semantic_publications DROP CONSTRAINT native_team_semantic_publications_business_key_hash_check')
 })
 test('S08 same-name forged identity constraint is not an audited invariant',async()=>{
  await refuseAfter('ALTER TABLE public.native_team_semantic_publications DROP CONSTRAINT native_team_semantic_publications_business_key_hash_check;ALTER TABLE public.native_team_semantic_publications ADD CONSTRAINT native_team_semantic_publications_business_key_hash_check CHECK(TRUE)')
 })
 test('S08 nullable retirement marker is not a valid original-fact shape',async()=>{
  await refuseAfter('ALTER TABLE public.native_team_semantic_publications ALTER COLUMN retired DROP NOT NULL')
 })
 test('S08 missing bounded original-binding retirement index refuses readiness',async()=>{
  await refuseAfter('DROP INDEX public.native_team_semantic_binding')
 })
 test('S08 private ledger and capture privilege escalation are rejected',async()=>{
  await refuseAfter('GRANT SELECT ON public.native_team_semantic_publications TO PUBLIC')
  await refuseAfter('GRANT EXECUTE ON FUNCTION public.capture_native_team_semantic_publication() TO PUBLIC')
 })
 test('S05 binding publisher wins first: supported terminal capture rolls back at actual NOWAIT lock',async()=>{
  const call=randomUUID(),goal=randomUUID(),actor=await pool.connect(),writer=await pool.connect()
  try{
   await actor.query('BEGIN')
   await actor.query("INSERT INTO public.collaboration_events VALUES($1,'session',1,NULL,'member_message','goal')",[goal])
   await actor.query("INSERT INTO public.collaboration_calls VALUES($1,'session',$2,'dispatched','task','offer',0)",[call,goal])
   await actor.query("INSERT INTO public.collaboration_events VALUES($1,'session',2,$3,'agent_message','reply'),($2,'session',3,$3,'status','completed')",[randomUUID(),randomUUID(),call])
   await writer.query('BEGIN');await writer.query("SELECT binding_id FROM public.team_memory_bindings WHERE binding_id='binding' FOR UPDATE")
   await actor.query('SAVEPOINT before_capture')
   await expect(actor.query("UPDATE public.collaboration_calls SET state='completed' WHERE call_id=$1",[call])).rejects.toMatchObject({code:'55P03'})
   await actor.query('ROLLBACK TO SAVEPOINT before_capture')
   expect((await actor.query('SELECT state FROM public.collaboration_calls WHERE call_id=$1',[call])).rows[0].state).toBe('dispatched')
   expect((await actor.query("SELECT count(*)::int AS n FROM public.native_team_semantic_publications WHERE original_business_key=$1",[call])).rows[0].n).toBe(0)
   await writer.query('ROLLBACK')
   await actor.query("UPDATE public.collaboration_calls SET state='completed' WHERE call_id=$1",[call])
   expect((await actor.query('SELECT publication_xid IS NOT NULL AS original FROM public.native_team_semantic_publications WHERE original_business_key=$1',[call])).rows[0].original).toBe(true)
  }finally{await actor.query('ROLLBACK');await writer.query('ROLLBACK');actor.release();writer.release()}
 })
})
