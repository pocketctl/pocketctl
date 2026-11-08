import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {assertNativeInputStartCompatible as memoryCompatible} from '../../migrations/shared-db/input-start-contract.js'
const url=process.env.TASK8_TEAM_SEMANTIC_NATIVE_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('Task8 native independent-review fail-closed reproductions',()=>{
 let pool:pg.Pool,relayCompatible:(db:Pick<pg.Pool,'query'>)=>Promise<void>
 beforeAll(async()=>{
  if(!url||!['/task8_team_semantic_native_final_test','/task8_team_semantic_native_fix_test'].includes(new URL(url).pathname))throw Error('exact_task8_native_review_fixture_required')
  pool=new pg.Pool({connectionString:url,max:3,statement_timeout:5000,lock_timeout:1000})
  relayCompatible=(await import(new URL('../../../../relay/src/shared-source/input-start.ts',import.meta.url).href)).assertNativeInputStartCompatible
  await relayCompatible(pool);await memoryCompatible(pool)
 })
 afterAll(async()=>{await pool?.end()})
 async function refuseAfter(sql:string,role?:string,probe?:'column'|'owner'){
  const client=await pool.connect()
  try{
   await client.query('BEGIN');await client.query(sql)
   if(role&&probe){
    await client.query(`SET LOCAL ROLE ${role}`)
    await expect(client.query(probe==='column'?'SELECT original_business_key,target_owner_scope_id FROM public.native_team_semantic_publications LIMIT 1':'SELECT count(*) FROM public.native_team_semantic_publications')).resolves.toHaveProperty('rows')
    await client.query('RESET ROLE')
   }
   const outcomes:unknown[]=[],statements:string[]=[]
   for(const validate of [relayCompatible,memoryCompatible]){
    const observed={query:async(text:string,args?:unknown[])=>{statements.push(text);return client.query(text,args)}}
    try{await validate(observed as unknown as Pick<pg.Pool,'query'>);outcomes.push('accepted')}
    catch(error){outcomes.push(error instanceof Error?error.message:String(error))}
   }
   expect(outcomes).toEqual(['native_team_semantic_history_missing','native_team_semantic_history_missing'])
   expect(statements.filter(text=>/^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT|REVOKE)/i.test(text))).toEqual([])
  }finally{await client.query('ROLLBACK');client.release()}
 }
 const after=(qualification:string,args='')=>`DROP TRIGGER native_team_semantic_after ON public.team_acceptance_decisions;
  CREATE TRIGGER native_team_semantic_after AFTER INSERT OR UPDATE OR DELETE ON public.team_acceptance_decisions FOR EACH ROW ${qualification} EXECUTE FUNCTION public.capture_native_team_semantic_publication(${args})`
 test('I2 same-name WHEN false capture refuses both independent gates',async()=>refuseAfter(after('WHEN (false)')))
 test('I2 same-name UPDATE OF column capture refuses both independent gates',async()=>refuseAfter(`DROP TRIGGER native_team_semantic_after ON public.team_acceptance_decisions;CREATE TRIGGER native_team_semantic_after AFTER INSERT OR UPDATE OF decision OR DELETE ON public.team_acceptance_decisions FOR EACH ROW EXECUTE FUNCTION public.capture_native_team_semantic_publication()`))
 test('I2 unexpected native trigger arguments refuse both independent gates',async()=>refuseAfter(after('',"'unexpected'")))
 test('I2 unexpected deferred constraint capture refuses both independent gates',async()=>refuseAfter(`DROP TRIGGER native_team_semantic_after ON public.team_acceptance_decisions;CREATE CONSTRAINT TRIGGER native_team_semantic_after AFTER INSERT OR UPDATE OR DELETE ON public.team_acceptance_decisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.capture_native_team_semantic_publication()`))
 test('I2 same-name WHEN false immutable guard refuses both independent gates',async()=>refuseAfter(`DROP TRIGGER native_team_semantic_immutable ON public.native_team_semantic_publications;CREATE TRIGGER native_team_semantic_immutable BEFORE UPDATE OR DELETE ON public.native_team_semantic_publications FOR EACH ROW WHEN(false) EXECUTE FUNCTION public.guard_native_team_semantic_fact()`))
 test('I3 PUBLIC direct original-column access refuses both gates',async()=>refuseAfter('GRANT SELECT(original_business_key,target_owner_scope_id) ON public.native_team_semantic_publications TO PUBLIC'))
 test('I3 restricted-role direct original-column access refuses both gates',async()=>{
  const role='task8_column_'+randomUUID().replaceAll('-','')
  await refuseAfter(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;GRANT SELECT(original_business_key,target_owner_scope_id) ON public.native_team_semantic_publications TO ${role}`,role,'column')
 })
 test('I4 native ledger owner swap to a restricted role refuses both gates',async()=>{
  const role='task8_owner_'+randomUUID().replaceAll('-','')
  await refuseAfter(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;ALTER TABLE public.native_team_semantic_publications OWNER TO ${role}`,role,'owner')
 })
 test('I4 private capture definer owner swap refuses both gates',async()=>{
  const role='task8_definer_'+randomUUID().replaceAll('-','')
  await refuseAfter(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;ALTER FUNCTION public.capture_native_team_semantic_publication() OWNER TO ${role}`)
 })
})
