/** Native RED scaffold. Run only after root releases an isolated fresh *_test
 * database; source presence/skip is not verification or acceptance. */
import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,rename} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {beforeAll,beforeEach,afterAll,describe,test,expect,vi} from 'vitest'
import {createPagedFixture,pagedInstallation,pagedProbe,pagedMaintenanceTestLifecycle} from './paged-cleanup-fixture.js'
import {preparePagedCleanupVerification,verifyPagedCleanupCurrent} from '../../migrations/shared-forward/paged-cleanup.js'
import {pagedWindow} from '../../migrations/shared-forward/paged-cleanup-authority.js'
import {hash} from '../../migrations/shared-forward/source-maintenance-common.js'
const {planPagedCleanup,applyPagedCleanup,verifyPagedCleanup}=pagedMaintenanceTestLifecycle()
const url=process.env.SHARED_W4_PAGED_TEST_DATABASE_URL,suite=url?describe:describe.skip

suite('G2 v4 current verification on the caller physical transaction',()=>{
 let f:Awaited<ReturnType<typeof createPagedFixture>>,directory:string,signal:AbortSignal
 beforeAll(async()=>{f=await createPagedFixture(url!);directory=await mkdtemp(join(tmpdir(),'retained-v4-current-'))},120000)
 beforeEach(context=>{signal=context.signal})
 afterAll(async()=>{if(directory)await rm(directory,{recursive:true,force:true})})
 const options=()=>({probe:pagedProbe,signal})
 async function completed(label:string,seed?:(session:string)=>Promise<void>){
  const session='g2-'+label;await f.source(session,1);if(seed)await seed(session)
  const original=(await f.sql('SELECT source_event_id::text AS id FROM memory.source_events WHERE session_id=$1',[session])).rows[0].id as string
  const target=join(directory,label),header=await planPagedCleanup(f.config,[{installationId:pagedInstallation,sessionId:session}],target,options())
  expect((await applyPagedCleanup(f.config,target,options())).privacyCatchupReadyForReopen).toBe(true)
  return {session,target,header,original}
 }
 async function current(capability:Awaited<ReturnType<typeof preparePagedCleanupVerification>>){
  return pagedWindow(f.config,options(),false,(c,identity)=>verifyPagedCleanupCurrent(c,identity,f.config,capability))
 }
 test('uses the same backend with no nested connection or file IO and holds native locks through outer COMMIT',async()=>{
  const plan=await completed('same-client'),capability=await preparePagedCleanupVerification(f.config,plan.target,options())
  const moved=plan.target+'-offline';await rename(plan.target,moved)
  try{
   await pagedWindow(f.config,options(),false,async(c,identity)=>{
    const before=(await c.query('SELECT pg_backend_pid()::text AS pid,transaction_timestamp()::text AS started')).rows[0]
    await c.query('SAVEPOINT g2_check')
    const connect=vi.spyOn(pg.Client.prototype,'connect').mockImplementation(()=>{throw Error('unexpected_nested_connection')})
    const query=c.query.bind(c);let originalReadFenced=false
    c.query=((...args:unknown[])=>{
     const statement=typeof args[0]==='string'?args[0]:''
     if(statement.includes("i.original->'references'?'accounting_hash'"))return (async()=>{
      const held=(await query("SELECT count(DISTINCT relation)::int AS count FROM pg_locks WHERE pid=pg_backend_pid() AND granted AND mode='ShareRowExclusiveLock' AND relation=ANY(ARRAY['memory.memory_generation_runs'::regclass,'memory.memory_governance_migration_changes'::regclass])")).rows[0].count
      expect(held).toBe(2);originalReadFenced=true
      return Reflect.apply(query,c,args)
     })()
     return Reflect.apply(query,c,args)
    }) as pg.Client['query']
    let result:Awaited<ReturnType<typeof verifyPagedCleanupCurrent>>
    try{result=await verifyPagedCleanupCurrent(c,identity,f.config,capability)}finally{c.query=query;connect.mockRestore()}
    expect(originalReadFenced).toBe(true)
    expect(result!).toMatchObject({schemaVersion:4,privacyCatchupReadyForReopen:true,globalRetainedAuthorityVerified:false,reopeningReady:false,activationAuthorized:false})
    expect(c.getTransactionStatus()).toBe('T')
    expect((await c.query('SELECT pg_backend_pid()::text AS pid,transaction_timestamp()::text AS started')).rows[0]).toEqual(before)
    await c.query('RELEASE SAVEPOINT g2_check')
    const contender=new pg.Client({connectionString:url});await contender.connect()
    try{expect((await contender.query('SELECT pg_try_advisory_xact_lock(1::bigint) AS held')).rows[0].held).toBe(false)}finally{await contender.end()}
   })
   const after=new pg.Client({connectionString:url});await after.connect()
   try{expect((await after.query('SELECT pg_try_advisory_xact_lock(1::bigint) AS held')).rows[0].held).toBe(true)}finally{await after.end()}
  }finally{await rename(moved,plan.target)}
 },120000)
 test('keeps the public read-only incomplete receipt false while strict preparation refuses incomplete work',async()=>{
  const session='g2-incomplete';await f.source(session,1)
  const target=join(directory,'incomplete'),header=await planPagedCleanup(f.config,[{installationId:pagedInstallation,sessionId:session}],target,options())
  expect(BigInt(header.partCount)).toBeGreaterThan(1n)
  await expect(applyPagedCleanup(f.config,target,{...options(),afterCommit:async()=>{throw Error('fixture_pause')}})).rejects.toThrow('fixture_pause')
  expect(await verifyPagedCleanup(f.config,target,options())).toMatchObject({schemaVersion:4,privacyCatchupReadyForReopen:false,globalRetainedAuthorityVerified:false,reopeningReady:false,activationAuthorized:false})
  await expect(preparePagedCleanupVerification(f.config,target,options())).rejects.toThrow('paged_current_cleanup_incomplete')
 },120000)
 test('refuses idle, failed, read-only, stale-isolation and unbounded caller transactions',async()=>{
  const plan=await completed('transaction-guard'),capability=await preparePagedCleanupVerification(f.config,plan.target,options()),identity=hash(f.config.database.expected)
  const c=new pg.Client({connectionString:url});await c.connect()
  try{
   await expect(verifyPagedCleanupCurrent(c,identity,f.config,capability)).rejects.toThrow('paged_current_transaction_required')
   await c.query('BEGIN');await expect(c.query('SELECT 1/0')).rejects.toMatchObject({code:'22012'})
   await expect(verifyPagedCleanupCurrent(c,identity,f.config,capability)).rejects.toThrow('paged_current_transaction_required');await c.query('ROLLBACK')
   await c.query('BEGIN READ ONLY');await expect(verifyPagedCleanupCurrent(c,identity,f.config,capability)).rejects.toThrow('paged_current_transaction_contract');await c.query('ROLLBACK')
   await c.query('BEGIN');await expect(verifyPagedCleanupCurrent(c,identity,f.config,capability)).rejects.toThrow('paged_current_transaction_contract');await c.query('ROLLBACK')
   for(const isolation of ['REPEATABLE READ','SERIALIZABLE']){
    await c.query('BEGIN ISOLATION LEVEL '+isolation)
    await c.query("SET LOCAL search_path=pg_catalog;SET LOCAL row_security=off;SET LOCAL timezone='UTC';SET LOCAL statement_timeout=5000;SET LOCAL lock_timeout=1000")
    await expect(verifyPagedCleanupCurrent(c,identity,f.config,capability)).rejects.toThrow('paged_current_transaction_contract');await c.query('ROLLBACK')
   }
  }finally{await c.query('ROLLBACK').catch(()=>{});await c.end()}
 },120000)
 test('does not expose keys and binds an immutable preparation snapshot rather than caller-mutated config or JSON',async()=>{
  const plan=await completed('opaque'),config=structuredClone(f.config),capability=await preparePagedCleanupVerification(config,plan.target,options())
  expect(Object.isFrozen(capability)).toBe(true)
  expect(JSON.stringify(capability)).not.toContain(f.config.database.url)
  expect(JSON.stringify(capability)).not.toContain(f.config.tombstoneHmacKeys[0].key)
  config.database.expected.database='changed';config.units.api='changed.service';config.tombstoneHmacKeys[0].key='changed'
  expect((await current(capability)).privacyCatchupReadyForReopen).toBe(true)
  await pagedWindow(f.config,options(),false,async(c,identity)=>{
   await expect(verifyPagedCleanupCurrent(c,identity,config,capability)).rejects.toThrow('paged_current_preparation_binding_drift')
   await expect(verifyPagedCleanupCurrent(c,'b'.repeat(64),f.config,capability)).rejects.toThrow('paged_current_preparation_binding_drift')
   await expect(verifyPagedCleanupCurrent(c,identity,f.config,JSON.parse(JSON.stringify(capability)))).rejects.toThrow('paged_current_preparation_required')
  })
 },120000)
 test('rejects a co-tampered stored page and state hash after actual file preparation',async()=>{
  const plan=await completed('page-state'),capability=await preparePagedCleanupVerification(f.config,plan.target,options())
  await f.sql("UPDATE shared.memory_forward_cleanup_v4_pages SET page=jsonb_set(page,'{componentHash}',to_jsonb(repeat('b',64))),page_state_hash=encode(sha256(convert_to(jsonb_set(page,'{componentHash}',to_jsonb(repeat('b',64)))::text,'UTF8')),'hex') WHERE plan_hash=$1 AND ordinal=0",[plan.header.manifestHash])
  await expect(current(capability)).rejects.toThrow('paged_stored_page_state_drift')
 },120000)
 test('rejects changed native output after preparation and never trusts the earlier complete receipt',async()=>{
  const plan=await completed('native-output'),capability=await preparePagedCleanupVerification(f.config,plan.target,options())
  const outputs=(await f.sql("SELECT o FROM shared.memory_forward_cleanup_v4_receipts r CROSS JOIN LATERAL jsonb_array_elements(r.outputs) o WHERE r.plan_hash=$1 AND o->>'kind'='native_governance'",[plan.header.manifestHash])).rows
  expect(outputs.length).toBeGreaterThan(0)
  await f.sql("UPDATE memory.memory_governance_migration_changes SET source_revision='unexpected' WHERE sequence=$1",[outputs[0].o.actual.key.sequence])
  await expect(current(capability)).rejects.toThrow('paged_native_output_drift')
 },120000)
 test('rejects fee/unknown accounting drift after preparation',async()=>{
  const run=randomUUID(),plan=await completed('accounting',async(session)=>{
   await f.sql("INSERT INTO memory.memory_generation_runs(run_id,installation_id,operation,subject_kind,subject_key_hash,input_digest,effective_policy_hash,state,provider,model,input_tokens,output_tokens,cost_micros,error_code) VALUES($1,$2,'compile_context','session',decode(md5($3),'hex'),decode(repeat('a',64),'hex'),decode(repeat('b',64),'hex'),'failed','text','synthetic',37,19,23,'provider_result_unknown')",[run,pagedInstallation,session])
  }),capability=await preparePagedCleanupVerification(f.config,plan.target,options())
  await f.sql('UPDATE memory.memory_generation_runs SET cost_micros=0 WHERE run_id=$1',[run])
  await expect(current(capability)).rejects.toThrow('paged_accounting_invariant_drift')
 },120000)
 test('rejects a late declared JSON edge to an original UUID after its parent was deleted',async()=>{
  const plan=await completed('late-original'),capability=await preparePagedCleanupVerification(f.config,plan.target,options())
  const outside='g2-outside-original';await f.source(outside,1)
  await f.sql("UPDATE memory.source_events SET source_provenance=jsonb_build_object('source_event_ids',jsonb_build_array($1::text)) WHERE session_id=$2",[plan.original,outside])
  await expect(current(capability)).rejects.toThrow('paged_original_json_reference_drift')
 },120000)
 test('rechecks current native restriction on every capability invocation',async()=>{
  const plan=await completed('current-authority'),capability=await preparePagedCleanupVerification(f.config,plan.target,options())
  expect((await current(capability)).privacyCatchupReadyForReopen).toBe(true)
  await f.sql('DELETE FROM public.deleted_sessions WHERE session_id=$1',[plan.session])
  await expect(current(capability)).rejects.toThrow(/paged_(current_privacy_authority_required|authority_drift)/)
 },120000)
})
