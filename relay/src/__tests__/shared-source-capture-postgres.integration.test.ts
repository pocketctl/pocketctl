import pg from 'pg'
import {initDB} from '../db.js'
import {assertNativeSessionAliasSchema} from '../session-alias/schema.js'
import {assertNativeInputStartSchema} from '../shared-source/input-start.js'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {createExtensionJournalSinkFromEnv} from '../extensions/journal.js'
import {buildStoredFeedPayload} from '../extensions/envelope.js'
import {canonicalPayloadHash} from '@pocketctl/session-source'
import {applyRelaySourceCapture,bootstrapRelaySourceRoots} from '../shared-source/capture.js'
const url=process.env.RELAY_CAPTURE_TEST_DATABASE_URL,suite=url?describe:describe.skip
async function assertCaptureFixture(pool:pg.Pool):Promise<void>{
  if(!url)throw Error('isolated_test_required')
  const target=new URL(url)
  if(!['postgres:','postgresql:'].includes(target.protocol)||target.pathname!=='/relay_capture_test'
   ||!['127.0.0.1','localhost','host.docker.internal','[::1]'].includes(target.hostname)||target.search||target.hash)throw Error('dedicated_native_capture_fixture_required')
  const identity=(await pool.query(`SELECT current_database() AS database_name,current_user AS role_name,
   (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0]
  if(identity.database_name!=='relay_capture_test'||!(identity.role_name==='postgres'&&identity.superuser===true
   ||identity.role_name==='relay_capture_test'&&identity.superuser===false))throw Error('dedicated_native_capture_fixture_required')
}
suite('low-level transactional body-free canonical capture',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{
  pool=new pg.Pool({connectionString:url,max:4})
  await assertCaptureFixture(pool)
  await pool.query(`DROP SCHEMA IF EXISTS memory CASCADE; DROP SCHEMA IF EXISTS shared CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;
   CREATE TABLE public.sessions(id bigserial PRIMARY KEY,session_id text UNIQUE,user_id int,source text,content_state text DEFAULT 'hot');
   CREATE TABLE public.events(id bigint PRIMARY KEY,user_id int,session_id text,event_type text,payload jsonb,effect_status text,
    created_at timestamptz DEFAULT now(),effect_step int DEFAULT 0,body_storage text DEFAULT 'hot',body_manifest_id uuid,body_chunk_ordinal int,body_activity_epoch bigint,body_owner_user_id int);
   CREATE TABLE public.deleted_sessions(session_id text);
   CREATE TABLE public.extension_source_outbox(source_seq bigserial PRIMARY KEY,source_kind text,source_id text,owner_user_id int,session_id text,event_type text,occurred_at timestamptz,payload jsonb,created_at timestamptz DEFAULT now(),UNIQUE(source_kind,source_id));`)
  const {beginFreshInputFixture,declareFreshInputFoundation}=await import(new URL('../../../memory/src/__tests__/shared-source-r1/input-start-fixture.ts',import.meta.url).href)
  const inputFoundation=await beginFreshInputFixture(pool)
  const {applySharedSourceContract}=await import(new URL('../../../memory/src/migrations/shared-db/contract.ts',import.meta.url).href)
  const {applyMemorySchema}=await import(new URL('../../../memory/src/schema.ts',import.meta.url).href);await applyMemorySchema(pool,{namespace:'memory'})
  await applySharedSourceContract(pool);await declareFreshInputFoundation(pool,inputFoundation);await applyRelaySourceCapture(pool);await applyRelaySourceCapture(pool)
 },60000)
 beforeEach(async()=>{
  await pool.query(`TRUNCATE public.events,public.sessions,public.deleted_sessions,public.extension_source_outbox RESTART IDENTITY;
   TRUNCATE shared.memory_source_work CASCADE;
   INSERT INTO public.sessions(session_id,user_id,source) VALUES('s',1,'codex'),('second',2,'codex'),('app-review-demo-x',1,'app_review_demo'),('pending-x',1,'codex');`)
 })
 afterAll(async()=>{await pool?.end()})
 const work=async(root='1:s')=>(await pool.query("SELECT revision::text,storage_revision::text FROM shared.memory_source_work WHERE source_kind='relay_event' AND root_key=$1",[root])).rows[0]
 test('pending/abandoned are excluded and trusted completion is atomic with the root revision',async()=>{
  await pool.query(`INSERT INTO public.events(id,user_id,session_id,event_type,payload,effect_status) VALUES(1,1,'s','agent_text','{"text":"private"}','pending')`)
  expect(await work()).toBeUndefined()
  await pool.query('UPDATE public.events SET effect_step=1 WHERE id=1');expect(await work()).toBeUndefined()
  await pool.query("UPDATE public.events SET effect_status='completed' WHERE id=1");expect(await work()).toMatchObject({revision:'1'})
  await pool.query('UPDATE public.events SET effect_step=2 WHERE id=1');expect(await work()).toMatchObject({revision:'1'})
  const tx=await pool.connect();try{await tx.query('BEGIN');await tx.query("INSERT INTO public.events(id,user_id,session_id,event_type,payload,effect_status) VALUES(2,2,'second','agent_text','{}','none')");expect(await work('2:second')).toBeUndefined();await tx.query('ROLLBACK')}finally{try{await tx.query('ROLLBACK')}finally{tx.release()}}
  expect(await work('2:second')).toBeUndefined()
  await pool.query("INSERT INTO public.events(id,user_id,session_id,event_type,payload,effect_status) VALUES(2,1,'s','agent_text','{}','abandoned'),(3,1,'app-review-demo-x','agent_text','{}','none'),(4,1,'pending-x','agent_text','{}','completed'),(5,NULL,'s','agent_text','{}','none')")
  expect((await pool.query('SELECT count(*)::int n FROM shared.memory_source_work')).rows[0].n).toBe(1)
  expect(JSON.stringify((await pool.query('SELECT * FROM shared.memory_source_work')).rows)).not.toContain('private')
 })
 test('batch replay and owned SQL writes dirty once per root/statement; rename dirties both roots',async()=>{
  await pool.query("INSERT INTO public.events(id,user_id,session_id,event_type,payload,effect_status) SELECT n,1,'s','agent_text','{}','none' FROM generate_series(1,100) n")
  expect(await work()).toMatchObject({revision:'1'})
  await pool.query('UPDATE public.events SET payload=payload');expect(await work()).toMatchObject({revision:'2'})
  await pool.query("UPDATE public.events SET payload='{\"text\":\"new\"}'");expect(await work()).toMatchObject({revision:'3'})
  await pool.query("UPDATE public.events SET session_id='second',user_id=2")
  expect(await work()).toMatchObject({revision:'4'});expect(await work('2:second')).toMatchObject({revision:'1'})
  await pool.query('DELETE FROM public.events');expect(await work('2:second')).toMatchObject({revision:'2'})
 })
 test('ordering timestamp changes dirty the source even when the body and trusted header are unchanged',async()=>{
  await pool.query("INSERT INTO public.events(id,user_id,session_id,event_type,payload,effect_status) VALUES(1,1,'s','agent_text','{}','none')")
  expect(await work()).toMatchObject({revision:'1'})
  await pool.query("UPDATE public.events SET created_at=created_at+interval '1 second' WHERE id=1")
  expect(await work()).toMatchObject({revision:'2'})
 })
 test('cooling changes storage version while preserving content revision',async()=>{
  await pool.query("INSERT INTO public.events(id,user_id,session_id,event_type,payload,effect_status) VALUES(1,1,'s','agent_text','{}','none')")
  await pool.query("UPDATE public.events SET body_storage='cold',payload=NULL,body_manifest_id='10000000-0000-0000-0000-000000000001',body_chunk_ordinal=0,body_activity_epoch=7,body_owner_user_id=1")
  expect(await work()).toEqual({revision:'1',storage_revision:'1'})
  await pool.query('UPDATE public.events SET body_activity_epoch=8');expect(await work()).toEqual({revision:'1',storage_revision:'2'})
  await pool.query('UPDATE public.events SET body_owner_user_id=2');expect(await work()).toEqual({revision:'1',storage_revision:'3'})
 })
 test('capture precedes bounded bootstrap and a smaller ID committed late remains pending',async()=>{
  const early=await pool.connect()
  try{
   await early.query('BEGIN');await early.query("INSERT INTO public.events(id,user_id,session_id,event_type,payload,effect_status) VALUES(1,2,'second','agent_text','{}','none')")
   await pool.query("INSERT INTO public.events(id,user_id,session_id,event_type,payload,effect_status) VALUES(99,1,'s','agent_text','{}','none')")
   // Avoid waiting on the uncommitted second root; first page observes s only.
   const page=await bootstrapRelaySourceRoots(pool,{afterSessionRowId:'0',limit:1})
   expect(page.roots.map(r=>r.rootKey)).toEqual(['1:s']);expect(page.nextAfterSessionRowId).toBe('1')
   await early.query('COMMIT');expect(await work('2:second')).toMatchObject({revision:'1'})
   expect((await bootstrapRelaySourceRoots(pool,{afterSessionRowId:'1',limit:10})).roots.map(r=>r.rootKey)).toEqual(['2:second'])
  }finally{await early.query('ROLLBACK');early.release()}
  await expect(bootstrapRelaySourceRoots(pool,{afterSessionRowId:'-1',limit:1})).rejects.toThrow('invalid_source_bootstrap')
 })
 test('future capture subcontract is rejected before replacing functions or downgrading its marker',async()=>{
  const before=(await pool.query("SELECT md5(pg_get_functiondef('shared.capture_memory_relay_events()'::regprocedure)) hash")).rows[0].hash
  await pool.query('UPDATE shared.memory_source_contract SET capture_version=3')
  try{
   await expect(applyRelaySourceCapture(pool)).rejects.toThrow('unsupported_shared_capture_contract')
   expect((await pool.query('SELECT capture_version FROM shared.memory_source_contract')).rows[0].capture_version).toBe(3)
   expect((await pool.query("SELECT md5(pg_get_functiondef('shared.capture_memory_relay_events()'::regprocedure)) hash")).rows[0].hash).toBe(before)
  }finally{await pool.query('UPDATE shared.memory_source_contract SET capture_version=2')}
 })
 test('Session rename, owner/control changes and deletion dirty the old and new identities without reading bodies',async()=>{
  await pool.query("INSERT INTO public.events(id,user_id,session_id,event_type,payload,effect_status) VALUES(1,1,'s','agent_text','{}','none')")
  await pool.query("UPDATE public.sessions SET content_state='deleting' WHERE session_id='s'")
  expect(await work()).toMatchObject({revision:'2'})
  await pool.query("UPDATE public.sessions SET session_id='renamed' WHERE session_id='s'")
  expect(await work()).toMatchObject({revision:'3'});expect(await work('1:renamed')).toMatchObject({revision:'1'})
  expect((await pool.query("SELECT canonical_session_id FROM shared.memory_source_session_barriers WHERE owner_user_id=1 AND session_id='s'")).rows[0]).toEqual({canonical_session_id:'renamed'})
  await pool.query("INSERT INTO public.deleted_sessions VALUES('renamed')")
  expect(await work('1:renamed')).toMatchObject({revision:'2'})
 })
 test('a missing historical Session and tombstone share the stable exclusive privacy fence',async()=>{
  const reader=await pool.connect(),writer=await pool.connect()
  try{
   await reader.query('BEGIN');await reader.query("SELECT pg_advisory_xact_lock_shared(1885566061,hashtext('missing'))")
   for(const sql of ["INSERT INTO public.deleted_sessions VALUES('missing')","INSERT INTO public.sessions(session_id,user_id,source) VALUES('missing',1,'codex')"]){
    await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'")
    await expect(writer.query(sql)).rejects.toMatchObject({code:'55P03'});await writer.query('ROLLBACK')
   }
   await reader.query('COMMIT');await writer.query("INSERT INTO public.deleted_sessions VALUES('missing')")
  }finally{await reader.query('ROLLBACK');await writer.query('ROLLBACK');reader.release();writer.release()}
 })
 test('capture projects explicit metadata without serializing event bodies',async()=>{
  const definition=(await pool.query("SELECT pg_get_functiondef('shared.capture_memory_relay_events()'::regprocedure) AS definition")).rows[0].definition
  expect(definition).not.toMatch(/to_jsonb\s*\(/i)
  expect(definition).not.toMatch(/->\s*'payload'|\.payload\b/i)
 })
 test('payload target writes advance a scalar marker, including equal-body replay without reading it',async()=>{
  await pool.query(`INSERT INTO public.events(id,user_id,session_id,event_type,payload,effect_status)
   VALUES(1,1,'s','agent_text',jsonb_build_object('text',repeat('private',100000)),'none')`)
  await pool.query('UPDATE public.events SET payload=payload WHERE id=1')
  expect((await pool.query('SELECT source_body_change_revision::text AS marker FROM public.events WHERE id=1')).rows[0].marker).toBe('1')
  expect(await work()).toMatchObject({revision:'2'})
  await pool.query('UPDATE public.events SET effect_step=2 WHERE id=1')
  expect(await work()).toMatchObject({revision:'2'})
 })
 test('bootstrap rejects an absent body marker trigger before observing roots',async()=>{
  await pool.query('DROP TRIGGER IF EXISTS memory_source_capture_body_marker ON public.events')
  try{await expect(bootstrapRelaySourceRoots(pool,{afterSessionRowId:'0',limit:10})).rejects.toThrow('source_capture_required_before_bootstrap')}
  finally{await applyRelaySourceCapture(pool)}
 })
})

// The cases above exercise capture's low-level SQL metadata deltas, including
// owner/locator rewrites that native v3 intentionally rejects. Journal contracts
// must instead run against the real native alias, body and input-start schema.
suite('transactional canonical Journal on the supported native schema',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{
  pool=new pg.Pool({connectionString:url,max:4})
  await assertCaptureFixture(pool)
 })
 beforeEach(async()=>{
  // Each case owns a fresh synthetic namespace. Never disable native immutable
  // proof/alias guards to reuse IDs, and never downgrade a mature contract.
  await assertCaptureFixture(pool)
  await pool.query('DROP SCHEMA IF EXISTS memory CASCADE; DROP SCHEMA IF EXISTS shared CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await initDB(pool)
  const {applySharedSourceContract}=await import(new URL('../../../memory/src/migrations/shared-db/contract.ts',import.meta.url).href)
  const {applyMemorySchema}=await import(new URL('../../../memory/src/schema.ts',import.meta.url).href);await applyMemorySchema(pool,{namespace:'memory'})
  await applySharedSourceContract(pool);await applyRelaySourceCapture(pool);await applyRelaySourceCapture(pool)
  await assertNativeSessionAliasSchema(pool);await assertNativeInputStartSchema(pool)
  await pool.query(`INSERT INTO public.users(id,email,password_hash) VALUES(1,'capture-owner@test.invalid','synthetic');
   INSERT INTO public.daemons(daemon_id,user_id,hostname,status) VALUES('capture-daemon',1,'synthetic','online');
   INSERT INTO public.sessions(session_id,daemon_id,user_id,agent_type,source,status)
    VALUES('s','capture-daemon',1,'codex','terminal','running')`)
  expect((await pool.query("SELECT public.native_session_authority('s',1,'capture-daemon')->>'state' AS authority")).rows[0].authority).toBe('current')
 })
 afterAll(async()=>{await pool?.end()})
 const work=async()=>(await pool.query("SELECT revision::text,storage_revision::text FROM shared.memory_source_work WHERE source_kind='relay_event' AND root_key='1:s'")).rows[0]
 test('trusted journal header retains server sequence and Feed classification after the journal is pruned',async()=>{
  const payload={text:'body must not enter metadata',turn_id:'turn',actor_scope:'assistant',memory_source:{version:1,producer:'codex',session_id:'s',turn_id:'turn',event_id:'daemon-event',sequence:'9',invocation_id:'invocation',source_role:'assistant',skill_state:'unknown',lineage_complete:false,derived_from_event_ids:[]}}
  await pool.query("ALTER SEQUENCE public.extension_source_outbox_source_seq_seq RESTART WITH 9007199254740993")
  await pool.query("INSERT INTO public.events(id,user_id,session_id,event_type,payload,effect_status) VALUES(1,1,'s','agent_text',$1,'pending')",[payload])
  const sink=createExtensionJournalSinkFromEnv({RELAY_EXTENSIONS:'enabled',RELAY_SHARED_SOURCE_HEADERS:'enabled'})!
  const input={sourceEventId:1,ownerUserId:1,sessionId:'s',eventType:'agent_text',occurredAt:null,payload}
  await sink.appendCanonicalEvent(pool,input)
  const header=(await pool.query('SELECT source_sequence::text,source_header_version,source_classification,canonical_payload_hash FROM public.events WHERE id=1')).rows[0]
  const journal=(await pool.query('SELECT * FROM public.extension_source_outbox')).rows[0]
  expect(header.source_sequence).toBe('9007199254740993')
  expect(header.source_header_version).toBe(1)
  expect(header.source_classification).toEqual(buildStoredFeedPayload(journal).classification)
  expect(header.source_classification.memory_source.sequence).toBe(header.source_sequence)
  expect(header.canonical_payload_hash).toBe(canonicalPayloadHash(payload).toString('hex'))
  expect(JSON.stringify(header)).not.toContain(payload.text)
  await sink.appendCanonicalEvent(pool,input)
  expect((await pool.query('SELECT source_sequence::text FROM public.events WHERE id=1')).rows[0].source_sequence).toBe(header.source_sequence)
  await expect(sink.appendCanonicalEvent(pool,{...input,payload:{...payload,text:'different'}})).rejects.toThrow('canonical_source_header_mismatch')
  await pool.query('DELETE FROM public.extension_source_outbox')
  await sink.appendCanonicalEvent(pool,input)
  expect((await pool.query('SELECT source_seq::text FROM public.extension_source_outbox')).rows[0].source_seq).toBe(header.source_sequence)
  expect((await pool.query('SELECT source_sequence::text FROM public.events WHERE id=1')).rows[0].source_sequence).toBe(header.source_sequence)
  expect(await work()).toBeUndefined()
  await pool.query("UPDATE public.events SET effect_status='completed' WHERE id=1")
  expect(await work()).toBeDefined()
 })
 test('journal/header writes roll back with the caller transaction and missing canonical identity is rejected',async()=>{
  const sink=createExtensionJournalSinkFromEnv({RELAY_EXTENSIONS:'enabled',RELAY_SHARED_SOURCE_HEADERS:'enabled'})!
  const tx=await pool.connect(),input={sourceEventId:2,ownerUserId:1,sessionId:'s',eventType:'agent_text',occurredAt:null,payload:{turn_id:'t',text:'atomic'}}
  try{
   await tx.query('BEGIN');await tx.query("INSERT INTO public.events(id,user_id,session_id,event_type,payload,effect_status) VALUES(2,1,'s','agent_text',$1,'none')",[input.payload])
   await sink.appendCanonicalEvent(tx,input);await tx.query('ROLLBACK')
  }finally{try{await tx.query('ROLLBACK')}finally{tx.release()}}
  expect((await pool.query('SELECT count(*)::int n FROM public.extension_source_outbox')).rows[0].n).toBe(0)
  expect(await work()).toBeUndefined()
  // The sink requires the caller's transaction, so this failing append is rolled back by its owner.
  const bad=await pool.connect();try{await bad.query('BEGIN');await expect(sink.appendCanonicalEvent(bad,input)).rejects.toThrow('canonical_source_header_mismatch');await bad.query('ROLLBACK')}finally{try{await bad.query('ROLLBACK')}finally{bad.release()}}
  expect(()=>createExtensionJournalSinkFromEnv({RELAY_EXTENSIONS:'off',RELAY_SHARED_SOURCE_HEADERS:'enabled'})).toThrow()
  expect(()=>createExtensionJournalSinkFromEnv({RELAY_EXTENSIONS:'enabled',RELAY_SHARED_SOURCE_HEADERS:'typo'})).toThrow()
 })

 test('header future version cannot be downgraded by the explicit migrator',async()=>{
  await pool.query('UPDATE shared.memory_source_contract SET header_version=2')
  try{await expect(applyRelaySourceCapture(pool)).rejects.toThrow('unsupported_shared_header_contract');expect((await pool.query('SELECT header_version FROM shared.memory_source_contract')).rows[0].header_version).toBe(2)}
  finally{await pool.query('UPDATE shared.memory_source_contract SET header_version=1')}
 })

})
