import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {task8ConsumerFixture,type Task8ConsumerConfig} from './task8-team-semantic-consumer-fixture.js'
import {provisionSharedDatabase} from '../../migrations/shared-db/namespace.js'
import {preparePagedMetadata,pagedTables} from '../../migrations/shared-forward/paged-cleanup-receipts.js'
import type pg from 'pg'
const configValue=process.env.TASK8_TEAM_SEMANTIC_CONSUMER_CONFIG,suite=configValue?describe:describe.skip
suite('Task8 full native service and semantic consumer closed path',()=>{
 let f:Awaited<ReturnType<typeof task8ConsumerFixture>>
 beforeAll(async()=>{if(!configValue)throw Error('explicit_task8_full_fixture_required');f=await task8ConsumerFixture(JSON.parse(configValue) as Task8ConsumerConfig)},60000)
 afterAll(async()=>{await f?.close()})
 test('actual Team session/dispatch services create a proven original three-role publication',async()=>{
  const g=await f.group({gapBeforeTerminal:true})
  const birth=(await f.admin.query('SELECT original_business_key,publication_xid IS NOT NULL AS proven,target_installation_id::text FROM public.native_team_semantic_publications WHERE original_business_key=$1',[g.call])).rows
  expect(birth).toEqual([{original_business_key:g.call,proven:true,target_installation_id:g.installation}])
  const scopes=await f.scopes(g.installation,g.root)
  expect(scopes.filter(s=>s.state==='current').map(s=>Number(s.scope.principalUserId)).sort()).toEqual(g.users.slice(0,2).sort())
 })
 test('actual restricted LOGIN roles deny direct native history and receive only the controlled metadata capability',async()=>{
  for(const pool of [f.runtime,f.publisher])await expect(pool.query('SELECT original_business_key FROM public.native_team_semantic_publications LIMIT 1')).rejects.toMatchObject({code:'42501'})
  const helper=(await f.admin.query("SELECT to_regprocedure('public.read_native_team_semantic_publication(text,text)') IS NOT NULL AS installed")).rows[0].installed
  expect(helper).toBe(true)
  const rights=(await f.admin.query("SELECT has_function_privilege($1,'public.read_native_team_semantic_publication(text,text)','EXECUTE') AS memory,has_function_privilege($2,'public.read_native_team_semantic_publication(text,text)','EXECUTE') AS relay,has_function_privilege($3,'public.read_native_team_semantic_publication(text,text)','EXECUTE') AS definer",[f.roles.memoryRole,f.roles.relayRole,f.roles.migratorRole])).rows[0]
  expect(rights).toEqual({memory:false,relay:false,definer:true})
 })
 test('S01 actual canonical producer stages the first reader without a raw business turn, then publishes exactly three semantic refs once',async()=>{
  const g=await f.group(),jobs=await f.sourceJobs(g.installation,g.root)
  expect(jobs).toHaveLength(2)
  await f.runSourceJob(jobs[0])
  expect((await f.runtime.query('SELECT count(*)::int AS n FROM source_turns WHERE installation_id=$1',[g.installation])).rows[0].n).toBe(0)
  await f.runSourceJob(jobs[1])
  const refs=(await f.runtime.query('SELECT source_event_id::text,source_kind,payload,source_provenance FROM source_events WHERE installation_id=$1 ORDER BY source_event_id',[g.installation])).rows
  expect(refs.filter(r=>r.source_kind==='team_collaboration')).toHaveLength(6)
  expect(refs.filter(r=>r.source_kind==='team_semantic')).toHaveLength(3)
  expect(refs.every(r=>r.payload===null)).toBe(true)
  expect((await f.runtime.query('SELECT count(*)::int AS n FROM source_turns WHERE installation_id=$1',[g.installation])).rows[0].n).toBe(1)
  const original=refs.map(r=>r.source_event_id)
  for(const job of jobs)await f.runSourceJob(job)
  expect((await f.runtime.query('SELECT source_event_id::text FROM source_events WHERE installation_id=$1 ORDER BY source_event_id',[g.installation])).rows.map(r=>r.source_event_id)).toEqual(original)
 })
 test('valid full target re-provision preserves the four real admin-only Task7 metadata owners, ACLs, definitions and checkpoint state',async()=>{
  const c=await f.admin.connect()
  try{await preparePagedMetadata(c as unknown as pg.Client)}finally{c.release()}
  const names=Object.values(pagedTables)
  await f.admin.query("INSERT INTO shared.memory_forward_cleanup_v4_plans(plan_hash,header,loaded_parts,loaded_hash,sealed) VALUES($1,$2::jsonb,0,$1,false)",['task8-admin-owner-preservation',JSON.stringify({fixture:'task8-admin-owner-preservation',checkpoint:'must-survive'})])
  const read=async()=>{
   const catalog=(await f.admin.query(`SELECT c.relname,c.relowner::regrole::text AS owner,c.relacl::text AS acl,c.reloptions,
    (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attacl::text,a.attgenerated,a.attidentity) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
    (SELECT jsonb_agg(jsonb_build_array(x.conname,pg_get_constraintdef(x.oid),x.convalidated,x.condeferrable,x.condeferred) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid) AS constraints,
    (SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(x.indexrelid),i.relowner::regrole::text,i.relacl::text,x.indisvalid,x.indisready) ORDER BY i.relname) FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid) AS indexes,
    (SELECT jsonb_agg(jsonb_build_array(t.typname,t.typowner::regrole::text,t.typacl::text) ORDER BY t.typname) FROM pg_type t WHERE t.oid=c.reltype OR t.typelem=c.reltype) AS types
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,[names])).rows
   const rows=[]
   for(const name of names)rows.push({name,rows:(await f.admin.query('SELECT to_jsonb(t) AS row FROM shared.'+name+' t ORDER BY to_jsonb(t)::text')).rows})
   return {catalog,rows}
  }
  const before=await read()
  expect(before.catalog).toHaveLength(4)
  expect(before.rows.find(r=>r.name===pagedTables.plans)?.rows).toHaveLength(1)
  await provisionSharedDatabase(f.admin,f.roles)
  expect(await read()).toEqual(before)
  expect((await f.admin.query("SELECT to_regclass('shared.memory_retained_authority_v1_runs') IS NULL AND to_regclass('shared.memory_retained_authority_v1_pages') IS NULL AND to_regclass('shared.memory_retained_authority_v1_items') IS NULL AS absent")).rows[0].absent).toBe(true)
 })
})
