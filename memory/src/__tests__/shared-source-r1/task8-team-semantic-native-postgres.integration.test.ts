import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {randomUUID} from 'node:crypto'
import {task8NativeFixture} from './task8-team-semantic-native-fixture.js'
const url=process.env.TASK8_TEAM_SEMANTIC_NATIVE_TEST_DATABASE_URL
const suite=url?describe:describe.skip
suite('Task8 original native Team semantic publication',()=>{
 let f:Awaited<ReturnType<typeof task8NativeFixture>>
 beforeAll(async()=>{if(!url)throw Error('explicit_task8_fixture_required');f=await task8NativeFixture(url)},30000)
 afterAll(async()=>{await f?.pool.end()})
 test('S05 supported terminal transition captures original binding target without a receipt',async()=>{
  const key=await f.call();await f.pool.query("UPDATE public.collaboration_calls SET state='completed' WHERE call_id=$1",[key])
  expect(await f.semantic('team_collaboration',key)).toMatchObject({source_kind:'team_collaboration',business_key:key,team_id:'team',team_session_id:'session',binding_id:'binding',binding_revision:'1',target_installation_id:f.target,target_owner_scope_kind:'team',target_owner_scope_id:f.owner,publication_xid:expect.stringMatching(/^[1-9][0-9]*$/),publication_order:expect.stringMatching(/^[1-9][0-9]*$/),retired:false})
 })
 test('S05 terminal INSERT and later native event completion stay explicitly unproven',async()=>{
  const key=await f.call('completed'),before=await f.semantic('team_collaboration',key)
  expect(before).toMatchObject({publication_xid:null,publication_order:null,retired:false})
  await f.pool.query("UPDATE public.collaboration_events SET content=content||' late' WHERE call_id=$1 AND kind='agent_message'",[key])
  expect(await f.semantic('team_collaboration',key)).toEqual(before)
 })
 test('S06 accepted decision owns group birth; later raw reader receipt keeps a separate later birth',async()=>{
  const a=await f.accepted(),original=await f.semantic('team_delivery',a.decision)
  expect(original).toMatchObject({business_key:a.decision,publication_xid:expect.stringMatching(/^[1-9][0-9]*$/),binding_id:'binding'})
  const later=randomUUID()
  await f.pool.query("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',2,'personal',$1,'active','from_now',0)",[later])
  await f.pool.query("INSERT INTO public.team_delivery_memory_sources VALUES($1,$2,$3,'team','session','binding',1,2,1,NULL,NULL)",['late-'+a.decision,a.decision,a.submission])
  expect(await f.semantic('team_delivery',a.decision)).toEqual(original)
  const raw=(await f.pool.query("SELECT publication_xid::text,publication_order::text FROM public.native_source_publications WHERE source_kind='team_delivery' AND source_key=$1",['late-'+a.decision])).rows[0]
  expect(raw.publication_xid).not.toBe(original.publication_xid)
  const start=(await f.pool.query('SELECT start_xid::text FROM public.native_installation_starts WHERE installation_id=$1',[later])).rows[0]
  expect(BigInt(original.publication_xid)).toBeLessThan(BigInt(start.start_xid));expect(BigInt(raw.publication_xid)).toBeGreaterThan(BigInt(start.start_xid))
 })
 test('S06 incomplete original accepted relationship never upgrades after a late reviewer repair',async()=>{
  const callId=await f.call(),submission=randomUUID(),decision=randomUUID()
  await f.pool.query("INSERT INTO public.team_task_specs VALUES('task',1,1) ON CONFLICT DO NOTHING")
  await f.pool.query("INSERT INTO public.team_task_submissions VALUES($1,'task',1,$2,'offer',0,'published')",[submission,callId])
  await f.pool.query("INSERT INTO public.team_acceptance_decisions VALUES($1,$2,'task',1,2,'accepted')",[decision,submission])
  const original=await f.semantic('team_delivery',decision)
  expect(original).toMatchObject({publication_xid:null,publication_order:null,retired:false})
  await f.pool.query('UPDATE public.team_acceptance_decisions SET reviewer_user_id=1 WHERE decision_id=$1',[decision])
  expect(await f.semantic('team_delivery',decision)).toEqual(original)
 })
 test('S07 original group and receiving start use separate ordinals in the same native transaction',async()=>{
  const key=await f.call(),client=await f.pool.connect(),receiver=randomUUID()
  try{
   await client.query('BEGIN')
   await client.query("UPDATE public.collaboration_calls SET state='completed' WHERE call_id=$1",[key])
   await client.query("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',2,'personal',$1,'active','from_now',0)",[receiver])
   const present=(await client.query("SELECT to_regclass('public.native_team_semantic_publications') IS NOT NULL AS present")).rows[0].present
   expect(present).toBe(true)
   const original=(await client.query("SELECT publication_xid::text,publication_order::text FROM public.native_team_semantic_publications WHERE source_kind='team_collaboration' AND original_business_key=$1",[key])).rows[0]
   const start=(await client.query('SELECT start_xid::text,start_order::text FROM public.native_installation_starts WHERE installation_id=$1',[receiver])).rows[0]
   expect(original.publication_xid).toBe(start.start_xid);expect(BigInt(original.publication_order)).toBeLessThan(BigInt(start.start_order))
  }finally{await client.query('ROLLBACK');client.release()}
 })
 test('S07 deleting and reinserting the same business key cannot reparent its original birth',async()=>{
  const key=await f.call();await f.pool.query("UPDATE public.collaboration_calls SET state='completed' WHERE call_id=$1",[key])
  const original=await f.semantic('team_collaboration',key);expect(original).toBeDefined()
  await f.pool.query('DELETE FROM public.collaboration_calls WHERE call_id=$1',[key])
  expect(await f.semantic('team_collaboration',key)).toMatchObject({retired:true,team_id:null,team_session_id:null,binding_id:null,target_installation_id:null,publication_xid:null,publication_order:null})
  await f.pool.query("INSERT INTO public.collaboration_calls VALUES($1,'session',NULL,'dispatched','task','offer',0)",[key])
  await f.pool.query("UPDATE public.collaboration_calls SET state='completed' WHERE call_id=$1",[key])
  expect(await f.semantic('team_collaboration',key)).toMatchObject({retired:true,publication_xid:null})
 })
})

suite('Task8 semantic publication compatibility',()=>{
 // The same owned fixture is shared by the ordered file; no second setup or
 // database reset. Compatibility cases use independent rollback windows.
 test('S08 native public runtime cannot query publication facts or invoke capture',async()=>{
  if(!url)throw Error('explicit_task8_fixture_required')
  const {default:pg}=await import('pg'),pool=new pg.Pool({connectionString:url,statement_timeout:5000,lock_timeout:1000})
  try{
   const present=(await pool.query("SELECT to_regclass('public.native_team_semantic_publications') IS NOT NULL AS present")).rows[0].present
   expect(present).toBe(true)
   const acl=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='public.native_team_semantic_publications'::regclass AND a.grantee=0) AS public_table,EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=to_regprocedure('public.capture_native_team_semantic_publication()') AND a.grantee=0) AS public_capture")).rows[0]
   expect(acl).toEqual({public_table:false,public_capture:false})
  }finally{await pool.end()}
 })
 test('S08 promised semantic history loss refuses existing native installer before DDL',async()=>{
  if(!url)throw Error('explicit_task8_fixture_required')
  const {default:pg}=await import('pg'),pool=new pg.Pool({connectionString:url,statement_timeout:5000,lock_timeout:1000}),client=await pool.connect()
  try{
   const marker=(await client.query("SELECT to_jsonb(c)->>'team_semantic_capture_version' AS version FROM public.native_input_start_contract c")).rows[0]?.version
   expect(marker).toBe('1')
   await client.query('BEGIN');await client.query('DROP TABLE public.native_team_semantic_publications CASCADE')
   const sql:string[]=[],observed={query:async(statement:string,args?:unknown[])=>{sql.push(statement);return client.query(statement,args)}}
   const {installNativeInputStart}=await import(new URL('../../../../relay/src/shared-source/input-start.ts',import.meta.url).href)
   await expect(installNativeInputStart(observed)).rejects.toThrow('native_team_semantic_history_missing')
   expect(sql.filter(s=>/^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT|REVOKE)/i.test(s))).toEqual([])
  }finally{await client.query('ROLLBACK');client.release();await pool.end()}
 })
})
