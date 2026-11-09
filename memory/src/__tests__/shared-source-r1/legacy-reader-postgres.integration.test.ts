import pg from 'pg'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {provisionSharedDatabase} from '../../migrations/shared-db/namespace.js'
import {createMemoryPool} from '../../db.js'
import {createPostgresSharedSourceReader,canonicalPayloadHash,type SourceScope} from '@pocketctl/session-source'
const url=process.env.SHARED_R1_LEGACY_TEST_DATABASE_URL,suite=url?describe:describe.skip
const inst='10000000-0000-0000-0000-000000000099',a='20000000-0000-0000-0000-000000000001',b='20000000-0000-0000-0000-000000000002'
const root={kind:'legacy_archive' as const,key:'1:legacy-session'},scope:SourceScope={installationId:inst,principalUserId:'1',ownerScopeKind:'personal',ownerScopeId:inst,authorizationRevision:'1',configVersion:'1',modeGeneration:'2'}
const payload={text:'necessary historical material',turn_id:'legacy-turn'}
const originalProof={version:1,producer:'codex',session_id:'legacy-session',turn_id:'legacy-turn',event_id:'historical-user-event',sequence:'9007199254740994',invocation_id:'historical-invocation',source_role:'user',skill_state:'unknown',lineage_complete:false,derived_from_event_ids:[]}
suite('explicit proven historical source archive',()=>{
 let pool:pg.Pool,runtime:pg.Pool
 beforeAll(async()=>{
  if(!url||!/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url})
  await pool.query('DROP SCHEMA IF EXISTS memory CASCADE;DROP SCHEMA IF EXISTS shared CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public')
  await applyMemorySchema(pool,{namespace:'memory'});await applySharedSourceContract(pool)
  await pool.query(`CREATE TABLE public.users(id int PRIMARY KEY);INSERT INTO public.users VALUES(1),(2);
   CREATE TABLE public.daemons(daemon_id text,user_id int);
   CREATE TABLE public.sessions(session_id text,user_id int,daemon_id text,source text,content_state text,agent_type text);
   CREATE TABLE public.deleted_sessions(session_id text);
   CREATE TABLE public.extension_providers(provider_id text,status text);INSERT INTO public.extension_providers VALUES('pocketctl-memory','enabled');
   CREATE TABLE public.extension_installations(installation_id uuid,provider_id text,owner_user_id int,owner_scope_kind text,owner_scope_id uuid,status text,authorization_epoch bigint,config_version bigint,granted_scopes text[],enabled_services text[],event_filter jsonb DEFAULT '{}');
   DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_legacy_memory') THEN CREATE ROLE shared_legacy_memory LOGIN PASSWORD 'only-test';END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_legacy_relay') THEN CREATE ROLE shared_legacy_relay NOLOGIN;END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_legacy_migrator') THEN CREATE ROLE shared_legacy_migrator NOLOGIN;END IF;
   END $$;`)
  await pool.query("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}')",[inst])
  await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[inst])
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-active',2)",[inst])
  for(const [id,seq,type] of [[a,'9007199254740993','agent_text'],[b,'9007199254740994','user_text']])await pool.query(`INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,classification,source_provenance,
   source_kind,canonical_key,canonical_session_key,source_version,source_sequence,content_hash,hash_version,mapping_state,adapter_version,legacy_owner_user_id,legacy_manifest_hash)
   VALUES($1::uuid,$2,'snapshot',$1::text,'legacy-session','legacy-turn',$3,now(),$4,$5,'{}',$8::jsonb,'legacy_archive',$1::text,'legacy-session','{"content":"1","authorization":"1","storage":"0"}',$6,$5,'canonical-json-sha256-v1','verified','legacy-archive-v1',1,$7)`,[id,inst,type,payload,canonicalPayloadHash(payload),seq,'a'.repeat(64),id===b?{memory:originalProof}:{}])
  await provisionSharedDatabase(pool,{memoryRole:'shared_legacy_memory',relayRole:'shared_legacy_relay',migratorRole:'shared_legacy_migrator'})
  const r=new URL(url);r.username='shared_legacy_memory';r.password='only-test';runtime=createMemoryPool({databaseUrl:r.href,databaseNamespace:'memory',dbPoolMax:3})
 },60000)
 afterAll(async()=>{await runtime?.end();await pool?.end()})
 test('preserves exact UUID, event identity, large old sequence and original provenance without text matching',async()=>{
  const reader=createPostgresSharedSourceReader(runtime),page=await reader.listHeads(scope,root)
  expect(page.heads.map(h=>h.canonicalKey)).toEqual([a,b]);expect(page.heads.map(h=>h.eventType)).toEqual(['agent_text','user_text'])
  expect(page.heads.map(h=>h.sourceSequence)).toEqual(['9007199254740993','9007199254740994'])
  expect(page.heads.map(h=>h.provenance.state)).toEqual(['unknown','known']);expect(page.heads.every(h=>h.storage==='legacy')).toBe(true)
  expect(page.heads[1].provenance.memory).toEqual(originalProof)
  expect(JSON.stringify(page)).not.toContain(payload.text)
  expect((await reader.resolveBodies(scope,root,page.heads,page.version)).map(r=>r.payload)).toEqual([payload,payload])
  expect((await reader.getHeads(scope,root,[b,a])).heads.map(h=>h.canonicalKey)).toEqual([b,a])
 })
 test('snapshot envelope hashes remain original digest inputs while canonical body hashes are checked independently',async()=>{
  const before=(await runtime.query('SELECT origin_position,occurred_at,payload_hash FROM source_events WHERE source_event_id=$1',[a])).rows[0]
  const at='2026-11-06T00:00:00Z',original=canonicalPayloadHash({event_id:123,event_type:'agent_text',payload,created_at:at})
  await runtime.query('UPDATE source_events SET origin_position=$2,occurred_at=$3,payload_hash=$4 WHERE source_event_id=$1',[a,'123',at,original])
  try{
   const reader=createPostgresSharedSourceReader(runtime),page=await reader.getHeads(scope,root,[a])
   expect(page.heads[0].contentHash).toBe(canonicalPayloadHash(payload).toString('hex'))
   expect(page.heads[0].provenance).toEqual({state:'unknown'})
   expect((await reader.resolveBodies(scope,root,page.heads,page.version))[0].payload).toEqual(payload)
   const {prepareSourceReferences}=await import('../../sources/prepared-sources.js')
   const prepared=await prepareSourceReferences(runtime,inst,[a])
   expect(prepared.events[0].payload_hash).toEqual(original);expect(prepared.events[0].source_event_id).toBe(a)
   await runtime.query('UPDATE source_events SET payload_hash=$2 WHERE source_event_id=$1',[a,Buffer.alloc(32,7)])
   const corrupt=await reader.getHeads(scope,root,[a])
   await expect(reader.resolveBodies(scope,root,corrupt.heads,corrupt.version)).rejects.toMatchObject({code:'hash_mismatch'})
  }finally{await runtime.query('UPDATE source_events SET origin_position=$2,occurred_at=$3,payload_hash=$4 WHERE source_event_id=$1',[a,before.origin_position,before.occurred_at,before.payload_hash])}
 })
 test('renamed/removed and cross-owner historical identities cannot be resurrected as missing Sessions',async()=>{
  const reader=createPostgresSharedSourceReader(runtime),page=await reader.listHeads(scope,root)
  await pool.query("INSERT INTO shared.memory_source_session_barriers(owner_user_id,session_id,canonical_session_id,reason) VALUES(1,'legacy-session','new-session','renamed')")
  try{
   expect((await reader.checkAuthority(scope,root,page.version)).state).toBe('deleted')
   await expect(reader.resolveBodies(scope,root,page.heads,page.version)).rejects.toMatchObject({code:'deleted'})
   await pool.query("UPDATE shared.memory_source_session_barriers SET reason='owner_changed',canonical_session_id=NULL")
   expect((await reader.checkAuthority(scope,root,page.version)).state).toBe('deleted')
  }finally{await pool.query('DELETE FROM shared.memory_source_session_barriers')}
 })
 test('current owner, provider and privacy tombstones still apply after the original Session disappeared',async()=>{
  const reader=createPostgresSharedSourceReader(runtime),page=await reader.listHeads(scope,root)
  await expect(reader.listHeads({...scope,principalUserId:'2'},root)).rejects.toMatchObject({code:'revoked'})
  await pool.query("INSERT INTO public.deleted_sessions VALUES('legacy-session')")
  try{expect((await reader.checkAuthority(scope,root,page.version)).state).toBe('deleted');await expect(reader.resolveBodies(scope,root,page.heads,page.version)).rejects.toMatchObject({code:'deleted'})}finally{await pool.query('DELETE FROM public.deleted_sessions')}
  await pool.query("UPDATE public.extension_providers SET status='disabled'")
  try{await expect(reader.listHeads(scope,root)).rejects.toMatchObject({code:'revoked'})}finally{await pool.query("UPDATE public.extension_providers SET status='enabled'")}
 })
 test('manifest/body mutations invalidate old versions and corrupt bodies fail canonical hash verification',async()=>{
  const reader=createPostgresSharedSourceReader(runtime),page=await reader.listHeads(scope,root)
  await pool.query('UPDATE memory.source_events SET legacy_manifest_hash=$1 WHERE source_event_id=$2',['b'.repeat(64),a])
  expect((await reader.checkCurrent(scope,root,page.version)).state).toBe('changed')
  await pool.query("UPDATE memory.source_events SET payload='{\"text\":\"tampered\"}' WHERE source_event_id=$1",[a])
  try{const current=await reader.getHeads(scope,root,[a]);await expect(reader.resolveBodies(scope,root,current.heads,current.version)).rejects.toMatchObject({code:'hash_mismatch'})}finally{await pool.query('UPDATE memory.source_events SET payload=$1,legacy_manifest_hash=$2 WHERE source_event_id=$3',[payload,'a'.repeat(64),a])}
 })
 test('unproven, missing ownership, future adapter and Team downgrade cannot become an archive fallback',async()=>{
  await expect(pool.query('UPDATE memory.source_events SET legacy_owner_user_id=NULL WHERE source_event_id=$1',[a])).rejects.toMatchObject({code:'23514'})
  await expect(pool.query("UPDATE memory.source_events SET adapter_version='legacy-archive-v2' WHERE source_event_id=$1",[a])).rejects.toMatchObject({code:'23514'})
  await expect(pool.query("UPDATE memory.source_events SET origin='team' WHERE source_event_id=$1",[a])).rejects.toMatchObject({code:'23514'})
  await expect(pool.query("UPDATE memory.source_events SET session_id='team_unproven',canonical_session_key='team_unproven' WHERE source_event_id=$1",[a])).rejects.toMatchObject({code:'23514'})
  await pool.query("UPDATE memory.source_events SET mapping_state='unproven' WHERE source_event_id=$1",[a])
  try{await expect(createPostgresSharedSourceReader(runtime).getHeads(scope,root,[a])).rejects.toMatchObject({code:'body_set_mismatch'})}finally{await pool.query("UPDATE memory.source_events SET mapping_state='verified' WHERE source_event_id=$1",[a])}
 })
 test('typed preparation keeps original UUID/provenance and retained authority does not grant raw collection access',async()=>{
  const {prepareSourceReferences}=await import('../../sources/prepared-sources.js'),prepared=await prepareSourceReferences(runtime,inst,[a])
  expect(prepared.events[0].source_event_id).toBe(a);expect(prepared.events[0].payload).toEqual(payload);expect(prepared.events[0].source_provenance).toEqual({})
  const c=await runtime.connect();try{await c.query('BEGIN');await prepared.assertCurrent(c);await c.query('COMMIT')}finally{await c.query('ROLLBACK');c.release()}
  expect((await prepareSourceReferences(runtime,inst,[b])).events[0].source_provenance).toEqual({memory:originalProof})
  await pool.query('UPDATE public.extension_installations SET granted_scopes=ARRAY[]::text[]')
  try{const reader=createPostgresSharedSourceReader(runtime);expect((await reader.checkAuthority(scope,root)).state).toBe('current');await expect(reader.listHeads(scope,root)).rejects.toMatchObject({code:'revoked'})}finally{await pool.query("UPDATE public.extension_installations SET granted_scopes=ARRAY['session:events:read']")}
 })
 test('ordinary retention preserves sole archive bodies and can finish; privacy deletion still removes them',async()=>{
  const {reclaimReceiptBatch}=await import('../../retention/source.js')
  const {createPurgeRepository}=await import('../../purge/repository.js')
  const {randomUUID}=await import('node:crypto'),redundant=randomUUID(),canonical=randomUUID()
  await runtime.query("INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'legacy-session',now(),now())",[inst])
  await runtime.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash)
   VALUES($1,$2,'feed','redundant-use-copy','legacy-session','legacy-turn','agent_text',now(),$3,$4)`,[redundant,inst,payload,canonicalPayloadHash(payload)])
  await runtime.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,
   source_kind,canonical_key,canonical_session_key,source_version,content_hash,hash_version,mapping_state,adapter_version)
   VALUES($1,$2,'canonical','relay_event:42','legacy-session','legacy-turn','agent_text',now(),NULL,$3,
   'relay_event','42','legacy-session','{"content":"1","authorization":"1","storage":"0"}',$3,'canonical-json-sha256-v1','verified','canonical-ref-v1')`,[canonical,inst,canonicalPayloadHash(payload)])
  // A session-level historical source is denied by any Session receipt,
  // not only by an equality on a non-NULL turn ID.
  await runtime.query('UPDATE source_events SET turn_id=NULL WHERE source_event_id=$1',[b])
  const receipt=(await runtime.query(`INSERT INTO memory_source_retention_receipts(installation_id,session_id,turn_id,episode_id,source_digest,compiler_version,extraction_completed_at,state)
   VALUES($1,'legacy-session','legacy-turn',NULL,'x'::bytea,'lifecycle-v1',now(),'reclaiming') RETURNING *`,[inst])).rows[0]
  const client=await runtime.connect()
  try{
   await client.query('BEGIN')
   const first=await reclaimReceiptBatch(client,receipt,10)
   expect(first).toMatchObject({events:2,finished:true})
   expect(await reclaimReceiptBatch(client,receipt,10)).toMatchObject({events:0,finished:true})
   await client.query('COMMIT')
  }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  const sole=async()=>(await runtime.query('SELECT payload,body_reclaimed_at FROM source_events WHERE source_event_id=ANY($1::uuid[]) ORDER BY source_event_id',[[a,b]])).rows
  expect(await sole()).toEqual([{payload,body_reclaimed_at:null},{payload,body_reclaimed_at:null}])
  // Metadata maintenance after the receipt must not let the old row guard
  // erase a canonical historical body indirectly.
  await runtime.query('UPDATE source_events SET source_sequence=source_sequence WHERE source_event_id=ANY($1::uuid[])',[[a,b]])
  expect(await sole()).toEqual([{payload,body_reclaimed_at:null},{payload,body_reclaimed_at:null}])
  // Retention still revokes Memory body use. Storage custody is not consent.
  await expect(runtime.query('UPDATE source_events SET payload_hash=$2 WHERE source_event_id=$1',[a,Buffer.alloc(32,7)])).rejects.toThrow('retained_source_hash_changed')
  await expect(runtime.query("UPDATE source_events SET turn_id='unreceipted-turn' WHERE source_event_id=$1",[a])).rejects.toThrow('retained_source_identity_changed')
  await expect(runtime.query("UPDATE source_events SET turn_id='unreceipted-turn',payload_hash=$2 WHERE source_event_id=$1",[a,Buffer.alloc(32,7)])).rejects.toThrow('retained_source_identity_changed')
  await expect(runtime.query("UPDATE source_events SET session_id='unreceipted-session',canonical_session_key='unreceipted-session' WHERE source_event_id=$1",[a])).rejects.toThrow('retained_source_identity_changed')
  await expect(runtime.query("UPDATE source_events SET body_reclaimed_at=now(),turn_id='unreceipted-turn',payload_hash=$2 WHERE source_event_id=$1",[a,Buffer.alloc(32,7)])).rejects.toThrow('retained_source_identity_changed')
  await expect(runtime.query('UPDATE source_events SET body_reclaimed_at=now(),payload_hash=$2 WHERE source_event_id=$1',[a,Buffer.alloc(32,7)])).rejects.toThrow('retained_source_hash_changed')
  await expect(runtime.query("UPDATE source_events SET turn_id='unreceipted-turn' WHERE source_event_id=$1",[b])).rejects.toThrow('retained_source_identity_changed')
  const reader=createPostgresSharedSourceReader(runtime)
  await expect(reader.getHeads(scope,root,[a])).rejects.toMatchObject({code:'source_body_reclaimed'})
  await createPurgeRepository(runtime,{hmacKey:'synthetic-only'}).purgeSession({installationId:inst,sessionId:'legacy-session',sourceFeedId:null,reason:'user_requested'})
  expect((await runtime.query('SELECT 1 FROM source_events WHERE installation_id=$1',[inst])).rowCount).toBe(0)
  expect((await reader.checkAuthority(scope,root)).state).toBe('deleted')
 })

})
