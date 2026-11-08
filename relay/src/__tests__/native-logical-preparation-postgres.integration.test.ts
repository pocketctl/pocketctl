import pg from 'pg'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {planNativeLogicalPreparation,prepareNativeLogicalSessions} from '../session-alias/logical-preparation.js'
const url=process.env.NATIVE_LOGICAL_PREPARATION_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('bounded forward preparation of original logical Session IDs',()=>{
 let db:pg.Client,plan:Awaited<ReturnType<typeof planNativeLogicalPreparation>>,original:string,initialBytes:number
 beforeAll(async()=>{
  if(!url||new URL(url).pathname!=='/native_logical_prep_test'||new URL(url).username!=='postgres')throw Error('dedicated_native_preparation_fixture_required')
  db=new pg.Client({connectionString:url});await db.connect()
  if(!(await db.query("SELECT to_regclass('public.events') IS NULL AS fresh")).rows[0].fresh)throw Error('fresh_native_preparation_fixture_required')
  await db.query("CREATE TABLE public.events(id bigint PRIMARY KEY,session_id varchar(128) NOT NULL,payload jsonb NOT NULL,event_hash text NOT NULL);CREATE INDEX events_hash_test ON public.events(event_hash)")
  await db.query("INSERT INTO public.events SELECT n,'original-'||(n%7),jsonb_build_object('integer',9007199254740993::bigint,'body',repeat(md5(n::text),24)),md5(n::text) FROM generate_series(1,12001) n")
  original=(await db.query("SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(e) ORDER BY id)::text,'UTF8')),'hex') AS hash FROM public.events e")).rows[0].hash
  initialBytes=Number((await db.query("SELECT pg_table_size('public.events')::text AS bytes")).rows[0].bytes)
  plan=await planNativeLogicalPreparation(db,{batchRows:2048})
 },30000)
 afterAll(async()=>{await db?.end()})
 test('does not admit a live writer role, even when NOINHERIT can SET ROLE to it',async()=>{
  await db.query('CREATE ROLE native_prep_writer NOLOGIN;CREATE ROLE native_prep_peer LOGIN NOINHERIT;GRANT native_prep_writer TO native_prep_peer;GRANT UPDATE ON public.events TO native_prep_writer')
  try{await expect(prepareNativeLogicalSessions(db,plan)).rejects.toThrow('native_preparation_writers_not_fenced')}
  finally{await db.query('REVOKE UPDATE ON public.events FROM native_prep_writer;REVOKE native_prep_writer FROM native_prep_peer;DROP ROLE native_prep_peer;DROP ROLE native_prep_writer')}
  expect((await db.query("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.events'::regclass AND attname='logical_source_session_id') AS present")).rows[0].present).toBe(false)
 })
 test('rejects a different exact database/table plan before mutation',async()=>{
  await expect(prepareNativeLogicalSessions(db,{...plan,databaseOid:'1'})).rejects.toThrow('native_preparation_plan_changed')
  await db.query('BEGIN')
  try{await expect(prepareNativeLogicalSessions(db,plan)).rejects.toThrow('native_preparation_standalone_required')}
  finally{await db.query('ROLLBACK')}
 })
 test('interruption keeps committed original IDs and resumes remaining rows without overwriting history',async()=>{
  let batches=0
  const originalTimeout=(await db.query("SHOW statement_timeout")).rows[0].statement_timeout
  await expect(prepareNativeLogicalSessions(db,plan,{afterStage:p=>{if(p.phase==='update-committed'&&++batches===2)throw Error('injected_native_prep_stop')}})).rejects.toThrow('injected_native_prep_stop')
  expect((await db.query('SELECT count(*)::int AS n FROM public.events WHERE logical_source_session_id IS NOT NULL')).rows[0].n).toBe(4096)
  expect((await db.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe(originalTimeout)
  const peaks:number[]=[],phases:string[]=[]
  const receipt=await prepareNativeLogicalSessions(db,plan,{afterStage:p=>{phases.push(p.phase)},afterBatch:p=>{peaks.push(Number(p.tableBytes))}})
  expect(phases.slice(0,2)).toEqual(['resume-vacuum-started','resume-vacuum-complete'])
  expect(phases.indexOf('update-committed')).toBeGreaterThan(1)
  expect(peaks.length).toBeGreaterThan(2)
  expect(Math.max(...peaks)).toBeLessThan(initialBytes*1.5+1024*1024)
  expect(receipt).toMatchObject({remainingRows:'0',updatedRows:'7905',readyForNativeMigration:true,nativeAuthorityInstalled:false,backupCreated:false})
  expect((await db.query("SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(e)-'logical_source_session_id' ORDER BY id)::text,'UTF8')),'hex') AS hash FROM public.events e")).rows[0].hash).toBe(original)
  expect((await db.query("SELECT to_regprocedure('public.native_session_authority(text,integer,text)') IS NULL AS absent")).rows[0].absent).toBe(true)
  expect((await prepareNativeLogicalSessions(db,plan)).updatedRows).toBe('0')
 },30000)
 test('ordinary vacuum waits a finite interval for a competing maintenance lock without losing the committed batch',async()=>{
  let release:Promise<void>|undefined,waitStarted=0
  const receipt=await prepareNativeLogicalSessions(db,plan,{afterStage:async p=>{
   if(p.phase==='resume-vacuum-started'){
    // Inject a real competing maintenance lock after the entry isolation
    // check; it never writes data and is released before the next fence.
    const holder=new pg.Client({connectionString:url});await holder.connect()
    await holder.query('BEGIN;LOCK TABLE public.events IN SHARE UPDATE EXCLUSIVE MODE')
    waitStarted=Date.now()
    release=new Promise<void>((resolve,reject)=>setTimeout(()=>{void holder.query('ROLLBACK').then(()=>holder.end()).then(resolve,reject)},1500))
   }
   if(p.phase==='resume-vacuum-complete'){
    await release;expect(Date.now()-waitStarted).toBeGreaterThanOrEqual(1300)
    expect((await db.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('1s')
   }
  }}).finally(async()=>{await release})
  expect(receipt.updatedRows).toBe('0')
  expect((await db.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0')
 },15000)
 test('contradictory partial identity, UPDATE triggers and native authority never get repaired by guessing',async()=>{
  await db.query("UPDATE public.events SET logical_source_session_id='different' WHERE id=1")
  try{await expect(prepareNativeLogicalSessions(db,plan)).rejects.toThrow('native_preparation_identity_conflict')}
  finally{await db.query('UPDATE public.events SET logical_source_session_id=session_id WHERE id=1')}
  await db.query("CREATE FUNCTION public.prep_side_effect()RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW;END$$;CREATE TRIGGER prep_side_effect BEFORE UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.prep_side_effect()")
  try{await expect(prepareNativeLogicalSessions(db,plan)).rejects.toThrow('native_preparation_update_trigger_unreviewed')}
  finally{await db.query('DROP TRIGGER prep_side_effect ON public.events;DROP FUNCTION public.prep_side_effect()')}
  await db.query('CREATE TABLE public.session_aliases(old_session_id text)')
  try{await expect(prepareNativeLogicalSessions(db,plan)).rejects.toThrow('native_preparation_existing_authority')}
  finally{await db.query('DROP TABLE public.session_aliases')}
 })
})
