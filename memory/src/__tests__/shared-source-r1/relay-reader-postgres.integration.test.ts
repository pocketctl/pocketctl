import {beginFreshInputFixture} from './input-start-fixture.js'
import {installNativeAliasFixture} from './native-alias-fixture.js'
import pg from 'pg'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {provisionSharedDatabase} from '../../migrations/shared-db/namespace.js'
import {createMemoryPool} from '../../db.js'
import {createPostgresSharedSourceReader,MemoryArchiveStorage,encodeArchiveChunk,canonicalPayloadHash,type ArchiveReadStorage,type SourceScope} from '@pocketctl/session-source'
const url=process.env.SHARED_R1_READER_TEST_DATABASE_URL,suite=url?describe:describe.skip
const inst='10000000-0000-0000-0000-000000000003',manifestId='30000000-0000-0000-0000-000000000003'
const root={kind:'relay_event' as const,key:'1:session'}
const scope:SourceScope={installationId:inst,principalUserId:'1',ownerScopeKind:'personal',ownerScopeId:inst,authorizationRevision:'1',configVersion:'1',modeGeneration:'2'}
const limits={maxRawBytes:1024*1024,maxCompressedBytes:1024*1024,maxRecords:100}
suite('controlled personal Relay source reader',()=>{
 let pool:pg.Pool,runtime:pg.Pool,storage:MemoryArchiveStorage&{namespace:string},bytes:Buffer
 const objectKey=`session-archive/v1/${manifestId}/0.gz`
 beforeAll(async()=>{
  if(!url || !/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url})
  await pool.query('DROP SCHEMA IF EXISTS memory CASCADE; DROP SCHEMA IF EXISTS shared CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const inputFoundation=await beginFreshInputFixture(pool)
  await applyMemorySchema(pool,{namespace:'memory'})
  await pool.query(`CREATE TABLE public.users(id int PRIMARY KEY); INSERT INTO public.users VALUES(1),(2);
   CREATE TABLE public.daemons(daemon_id text,user_id int); INSERT INTO public.daemons VALUES('daemon',1);
   CREATE TABLE public.sessions(session_id text,user_id int,daemon_id text,source text,content_state text,agent_type text,activity_epoch bigint NOT NULL DEFAULT 0,last_business_activity_at timestamptz DEFAULT '2026-11-06T00:00:00Z'); INSERT INTO public.sessions VALUES('session',1,'daemon','codex','cold','codex');
   CREATE TABLE public.extension_providers(provider_id text,status text); INSERT INTO public.extension_providers VALUES('pocketctl-memory','enabled');
   CREATE TABLE public.extension_installations(installation_id uuid,provider_id text,owner_user_id int,owner_scope_kind text,owner_scope_id uuid,status text,authorization_epoch bigint,config_version bigint,granted_scopes text[],enabled_services text[],event_filter jsonb DEFAULT '{}',start_policy text NOT NULL DEFAULT 'retained_history',start_feed_id bigint NOT NULL DEFAULT 0,subscriptions text[] NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
   CREATE TABLE public.extension_organizations(organization_id uuid PRIMARY KEY,state text,authorization_epoch bigint DEFAULT 1);
   CREATE TABLE public.extension_teams(team_id uuid PRIMARY KEY,organization_id uuid,state text,authorization_epoch bigint DEFAULT 1);
   CREATE TABLE public.extension_scope_memberships(membership_id uuid PRIMARY KEY,scope_kind text,scope_id uuid,user_id int,roles text[],state text,membership_revision bigint DEFAULT 1);
   CREATE TABLE public.events(id bigint PRIMARY KEY,session_id text,user_id int,event_type text,payload jsonb,effect_status text,body_storage text,body_manifest_id uuid,body_chunk_ordinal int,body_activity_epoch bigint,body_owner_user_id int,canonical_payload_hash text,source_sequence bigint);
   CREATE TABLE public.extension_checkpoints(installation_id uuid PRIMARY KEY,ack_feed_id bigint NOT NULL DEFAULT 0,snapshot_required_at timestamptz,lease_epoch bigint NOT NULL DEFAULT 0,lease_token_hash bytea,lease_expires_at timestamptz,updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
   CREATE TABLE public.extension_source_outbox(source_seq bigint,source_kind text,source_id text,owner_user_id int,session_id text,event_type text);
   CREATE TABLE public.deleted_sessions(session_id text);
   CREATE TABLE public.session_archive_manifests(manifest_id uuid,user_id int,session_id text,activity_epoch bigint,schema_version int,codec text,state text,storage_namespace text);
   CREATE TABLE public.session_archive_chunks(manifest_id uuid,ordinal int,object_key text,first_event_id bigint,last_event_id bigint,event_count int,raw_bytes bigint,compressed_bytes bigint,raw_sha256 text,compressed_sha256 text);
   DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_reader_memory') THEN CREATE ROLE shared_reader_memory LOGIN PASSWORD 'only-test'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_reader_relay') THEN CREATE ROLE shared_reader_relay NOLOGIN; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_reader_migrator') THEN CREATE ROLE shared_reader_migrator NOLOGIN; END IF;
   END $$;`)
  await applySharedSourceContract(pool)
  await pool.query(`INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,authorization_epoch,config_version,granted_scopes,enabled_services,event_filter) VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}')`,[inst])
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[inst])
  await pool.query("SELECT shared.mark_memory_source_dirty('relay_event','1:session')")
  const cold=[{id:'9007199254740994',eventType:'agent_text',payload:{text:'private cold one',turn_id:'turn-2'}},{id:'9007199254740995',eventType:'agent_text',payload:{text:'private cold two',turn_id:'turn-3'}}]
  const encoded=await encodeArchiveChunk({userId:1,sessionId:'session',activityEpoch:'7',manifestId,ordinal:0},cold,limits);bytes=encoded.bytes
  storage=Object.assign(new MemoryArchiveStorage(),{namespace:'reader-archive'});await storage.put(objectKey,bytes)
  await pool.query(`INSERT INTO public.events VALUES(9007199254740993,'session',1,'agent_text',$1,'completed','hot',NULL,NULL,NULL,NULL,NULL,19)`,[{text:'private hot',turn_id:'turn-1',memory_source:{version:1,producer:'codex'}}])
  for(const [i,c] of cold.entries())await pool.query("INSERT INTO public.events VALUES($1,'session',1,'agent_text',NULL,'completed','cold',$2,0,7,1,$3,$4)",[c.id,manifestId,canonicalPayloadHash(c.payload).toString('hex'),String(i+20)])
  await pool.query(`INSERT INTO public.events VALUES(9007199254740996,'session',1,'agent_text','{"text":"pending hidden"}','pending','hot',NULL,NULL,NULL,NULL,NULL,22)`)
  await pool.query("INSERT INTO public.session_archive_manifests VALUES($1,1,'session',7,1,'gzip','published','reader-archive')",[manifestId])
  const m=encoded.manifest
  await pool.query('INSERT INTO public.session_archive_chunks VALUES($1,0,$2,$3,$4,2,$5,$6,$7,$8)',[manifestId,objectKey,m.firstEventId,m.lastEventId,String(m.rawBytes),String(m.compressedBytes),m.rawSha256,m.compressedSha256])
  await installNativeAliasFixture(pool,{inputPolicy:'retained_history',inputFoundation})
  await provisionSharedDatabase(pool,{memoryRole:'shared_reader_memory',relayRole:'shared_reader_relay',migratorRole:'shared_reader_migrator'})
  const runtimeUrl=new URL(url);runtimeUrl.username='shared_reader_memory';runtimeUrl.password='only-test'
  runtime=createMemoryPool({databaseUrl:runtimeUrl.href,databaseNamespace:'memory',dbPoolMax:3})
 },60000)
 afterAll(async()=>{await runtime?.end();await pool?.end()})
 async function sealRoot(rootKey:string){
  const worker='consumer-admission-fixture'
  // Prior scenarios may have claimed this pending root while testing a
  // different root. Reset only its synthetic lease, never its progress.
  await pool.query("UPDATE shared.memory_source_work SET lease_owner=NULL,lease_token=NULL,lease_until=NULL,claimed_revision=NULL WHERE source_kind='relay_event' AND root_key=$1",[rootKey])
  const claim=(await runtime.query('SELECT root_key,lease_token::text,claimed_revision::text FROM shared.claim_memory_source_work($1,30,128)',[worker])).rows.find(r=>r.root_key===rootKey)
  if(!claim)throw Error('fixture_root_claim_missing')
  // The bounded claim API may return other pending fixture roots too. Leave
  // them unprocessed and available for their own later queue assertions.
  await pool.query("UPDATE shared.memory_source_work SET lease_owner=NULL,lease_token=NULL,lease_until=NULL,claimed_revision=NULL WHERE lease_owner=$1 AND root_key<>$2",[worker,rootKey])
  let page:any=null
  for(let n=0;n<5;n++){
   page=(await runtime.query("SELECT shared.step_memory_source_distribution('relay_event',$1,$2,$3,$4,$5,$6,64) AS page",[rootKey,claim.lease_token,worker,claim.claimed_revision,page?.scanId??null,page?.cursor??''])).rows[0].page
   if(page.state==='sealed')break
  }
  if(page.state!=='sealed')throw Error('fixture_root_seal_missing')
  await runtime.query("SELECT shared.ack_memory_source_work('relay_event',$1,$2,$3,$4)",[rootKey,claim.lease_token,worker,claim.claimed_revision])
 }
 test('personal target pages use current owner and source mode without body or cross-owner fanout',async()=>{
  const extra='10000000-0000-0000-0000-000000000004',foreign='10000000-0000-0000-0000-000000000005'
  await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[inst])
  for(const [id,user]of [[extra,1],[foreign,2]] as const){
   await pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,authorization_epoch,config_version,granted_scopes,enabled_services,event_filter) VALUES($1,'pocketctl-memory',$2,'personal',$1,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}')",[id,user])
   await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[id])
   await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[id])
  }
  const read=(after='')=>runtime.query("SELECT * FROM shared.enumerate_memory_source_targets('relay_event','1:session',$1,1)",[after])
  try{
   const first=(await read()).rows[0],next=(await read(first.cursor_key)).rows[0]
   expect([first.source_scope.installationId,next.source_scope.installationId]).toEqual([inst,extra])
   expect([first.state,next.state]).toEqual(['current','current'])
   expect(next.source_scope.principalUserId).toBe('1')
   expect((await read(next.cursor_key)).rowCount).toBe(0)
   expect(JSON.stringify([first,next])).not.toContain('cold payload')
   await pool.query("UPDATE shared.memory_source_modes SET mode='legacy-feed' WHERE installation_id=$1",[extra])
   expect((await read(first.cursor_key)).rowCount).toBe(0)
  }finally{
   await pool.query('DELETE FROM public.extension_installations WHERE installation_id=ANY($1::uuid[])',[[extra,foreign]])
   await pool.query('DELETE FROM memory.memory_installations WHERE installation_id=ANY($1::uuid[])',[[extra,foreign]])
   await pool.query("UPDATE shared.memory_source_modes SET mode='paused',generation=generation+1 WHERE installation_id=ANY($1::uuid[])",[[extra,foreign]])
   await pool.query('DELETE FROM shared.memory_local_source_rights WHERE installation_id=ANY($1::uuid[])',[[extra,foreign]])
   await pool.query('DELETE FROM memory.memory_installations WHERE installation_id=$1',[inst])
   await pool.query('DELETE FROM shared.memory_local_source_rights WHERE installation_id=$1',[inst])
  }
 })

 test('distribution resumes bounded pages after a crash, seals the complete set, and restarts on control change',async()=>{
  const extra='10000000-0000-0000-0000-000000000006'
  await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1),($2,'pocketctl-memory','active','ready',1)",[inst,extra])
  await pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,authorization_epoch,config_version,granted_scopes,enabled_services,event_filter) VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}')",[extra])
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[extra])
  const claim=async()=>(await runtime.query("SELECT lease_token::text,claimed_revision::text FROM shared.claim_memory_source_work('distributor',30,128)")).rows.find(r=>r.lease_token)!
  const step=async(c:any,page:any=null)=>(await runtime.query("SELECT shared.step_memory_source_distribution('relay_event','1:session',$1,'distributor',$2,$3,$4,1) AS page",[c.lease_token,c.claimed_revision,page?.scanId??null,page?.cursor??''])).rows[0].page
  let c:any
  try{
   c=await claim();await step(c) // COMMIT succeeded; caller loses the response.
   const recover=async()=>(await runtime.query("SELECT shared.resume_memory_source_distribution('relay_event','1:session',$1,'distributor',$2) AS checkpoint",[c.lease_token,c.claimed_revision])).rows[0].checkpoint
   const first=await recover()
   expect(first).toMatchObject({state:'scanning',reset:false,dispatchCursor:'',dispatchComplete:false})
   await expect(runtime.query("SELECT * FROM shared.read_memory_source_context_set('relay_event','1:session',$1,$2,'',128)",[first.scanId,inst])).rejects.toThrow('source_context_set_not_ready')
   await pool.query("UPDATE shared.memory_source_work SET lease_until=clock_timestamp()-interval '1 second' WHERE root_key='1:session'")
   const old=c;c=await claim()
   await expect(step(old,first)).rejects.toThrow('source_lease_lost')
   const second=await step(c,first),tail=await step(c,second)
   expect(second.scanId).toBe(first.scanId);expect(tail.state).toBe('sealed')
   const set=(await runtime.query("SELECT * FROM shared.read_memory_source_context_set('relay_event','1:session',$1,$2,'',128)",[tail.scanId,extra])).rows
   expect(set).toHaveLength(1);expect(set[0].source_scope.installationId).toBe(extra)
   expect(JSON.stringify(set)).not.toMatch(/private hot|private cold/)
   expect((await pool.query("SELECT processed_revision::text FROM shared.memory_source_work WHERE root_key='1:session'")).rows[0].processed_revision).toBe('0')
   const dispatch=async(after='')=>(await runtime.query("SELECT shared.dispatch_memory_source_distribution('relay_event','1:session',$1,'distributor',$2,$3,$4,1) AS page",[c.lease_token,c.claimed_revision,tail.scanId,after])).rows[0].page
   const client=await runtime.connect()
   try{
    await client.query('BEGIN')
    await client.query("SELECT shared.dispatch_memory_source_distribution('relay_event','1:session',$1,'distributor',$2,$3,'',1)",[c.lease_token,c.claimed_revision,tail.scanId])
    await client.query('ROLLBACK')
    expect((await pool.query("SELECT 1 FROM memory.memory_jobs WHERE payload->>'distribution_scan'=$1",[tail.scanId])).rowCount).toBe(0)
   }finally{await client.query('ROLLBACK');client.release()}
   await dispatch() // The durable enqueue response is lost too.
   const recoveredDispatch=await recover(),out2=await dispatch(recoveredDispatch.dispatchCursor)
   expect(recoveredDispatch.dispatchComplete).toBe(false);expect(out2.complete).toBe(false)
   expect((await pool.query("SELECT 1 FROM memory.memory_jobs WHERE payload->>'distribution_scan'=$1",[tail.scanId])).rowCount).toBe(2)
   expect((await pool.query("SELECT 1 FROM shared.memory_source_progress WHERE source_kind='relay_event' AND root_key='1:session'")).rowCount).toBe(0)
   await pool.query("SELECT shared.mark_memory_source_dirty('relay_event','1:session')")
   expect((await dispatch(out2.cursor)).complete).toBe(true)
   expect((await pool.query("SELECT revision::text,processed_revision::text FROM shared.memory_source_work WHERE root_key='1:session'")).rows[0]).toEqual({revision:'2',processed_revision:'1'})
   c=await claim()
   await pool.query("SELECT shared.mark_memory_control_dirty('installation',$1)",[extra])
   await expect(runtime.query("SELECT * FROM shared.read_memory_source_context_set('relay_event','1:session',$1,$2,'',128)",[tail.scanId,inst])).rejects.toThrow('source_context_set_not_ready')
   const reset=await step(c,tail)
   expect(reset).toMatchObject({state:'scanning',cursor:'',reset:true,workRevision:c.claimed_revision})
   expect(reset.scanId).not.toBe(tail.scanId)
   await expect(step(c,tail)).rejects.toThrow('source_distribution_cursor_changed')
   await expect(runtime.query('SELECT * FROM shared.memory_source_distribution_targets')).rejects.toMatchObject({code:'42501'})
   const expiring=await runtime.connect()
   try{
    await pool.query("UPDATE shared.memory_source_work SET lease_until=clock_timestamp()+interval '0.3 seconds' WHERE root_key='1:session'")
    await expiring.query('BEGIN')
    await expiring.query("SELECT shared.step_memory_source_distribution('relay_event','1:session',$1,'distributor',$2,$3,'',1)",[c.lease_token,c.claimed_revision,reset.scanId])
    await expiring.query('SELECT pg_sleep(0.35)')
    await expect(expiring.query('COMMIT')).rejects.toThrow('source_distribution_commit_fence')
    expect((await pool.query("SELECT cursor_key FROM shared.memory_source_distributions WHERE root_key='1:session'")).rows[0].cursor_key).toBe('')
   }finally{await expiring.query('ROLLBACK');expiring.release()}
  }finally{
   await pool.query("UPDATE shared.memory_source_work SET lease_owner=NULL,lease_token=NULL,lease_until=NULL,claimed_revision=NULL WHERE root_key='1:session'")
   await pool.query('DELETE FROM public.extension_installations WHERE installation_id=$1',[extra])
   await pool.query("UPDATE shared.memory_source_modes SET mode='paused',generation=generation+1 WHERE installation_id=$1",[extra])
   await pool.query('DELETE FROM memory.memory_installations WHERE installation_id=ANY($1::uuid[])',[[inst,extra]])
   await pool.query('DELETE FROM shared.memory_local_source_rights WHERE installation_id=ANY($1::uuid[])',[[inst,extra]])
  }
 })

 test('SQL scope keys match canonical JSON hashes for flat scoped identities',async()=>{
  for(const value of [scope,Object.fromEntries(Object.entries(scope).reverse()),{...scope,ownerScopeId:'line\n\"\\unicode-中文'}]){
   expect((await runtime.query('SELECT shared.memory_source_scope_key($1::jsonb) AS key',[JSON.stringify(value)])).rows[0].key).toBe(canonicalPayloadHash(value).toString('hex'))
  }
  await expect(runtime.query('SELECT shared.memory_source_scope_key($1::jsonb)',[JSON.stringify({...scope,extra:{nested:'not a scope string'}})])).rejects.toThrow('invalid_source_scope')
 })

 test('discovery timestamps and poll checkpoints do not invalidate local rights but semantic control changes do',async()=>{
  await runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[inst])
  await runtime.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id,state,authorization_epoch) VALUES($1,'personal',$1,'active',1)",[inst])
  const revision=async()=>(await pool.query('SELECT revision::text FROM shared.memory_local_source_rights WHERE installation_id=$1',[inst])).rows[0].revision
  try{
   const initial=await revision()
   await runtime.query("UPDATE memory_installations SET updated_at=clock_timestamp(),discovery_generation=discovery_generation+1,poll_owner='worker',poll_epoch=poll_epoch+1,poll_expires_at=clock_timestamp()+interval '30 seconds',last_feed_id=last_feed_id+1,last_pull_at=now(),last_ack_at=now(),last_error_code=NULL WHERE installation_id=$1",[inst])
   await runtime.query('UPDATE memory_owner_scopes SET updated_at=clock_timestamp(),last_feed_id=last_feed_id+1 WHERE installation_id=$1',[inst])
   expect(await revision()).toBe(initial)
   await runtime.query("UPDATE memory_installations SET local_status='purging' WHERE installation_id=$1",[inst])
   expect(BigInt(await revision())).toBe(BigInt(initial)+1n)
   await runtime.query("UPDATE memory_owner_scopes SET state='suspended',authorization_epoch=authorization_epoch+1 WHERE installation_id=$1",[inst])
   expect(BigInt(await revision())).toBe(BigInt(initial)+2n)
   await runtime.query('UPDATE memory_installations SET config_version=config_version+1 WHERE installation_id=$1',[inst])
   expect(BigInt(await revision())).toBe(BigInt(initial)+3n)
  }finally{
   await runtime.query('DELETE FROM memory_owner_scopes WHERE installation_id=$1',[inst])
   await runtime.query('DELETE FROM memory_installations WHERE installation_id=$1',[inst])
   await pool.query('DELETE FROM shared.memory_local_source_rights WHERE installation_id=$1',[inst])
  }
 })

 test('grants no raw public reads, but returns scoped hot/cold heads, stable sequences and one decoded chunk',async()=>{
  await expect(runtime.query('SELECT payload FROM public.events')).rejects.toMatchObject({code:'42501'})
  let reads=0
  const readStorage:ArchiveReadStorage={namespace:storage.namespace,read:async key=>{
   reads++;expect((await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n).toBe(0)
   return storage.read(key)
  }}
  const reader=createPostgresSharedSourceReader(runtime,{storage:readStorage,limits}),page=await reader.listHeads(scope,root)
  expect(page.heads).toHaveLength(3);expect(page.heads[0].sourceSequence).toBe('19');expect(page.heads[0].provenance).toEqual({state:'unknown'})
  expect(JSON.stringify(page)).not.toContain('private hot');expect(JSON.stringify(page)).not.toContain('private cold')
  const resolved=await reader.resolveBodies(scope,root,page.heads,page.version)
  expect(resolved.map(r=>(r.payload as any).text)).toEqual(['private hot','private cold one','private cold two']);expect(reads).toBe(1)
  const one=await reader.listHeads(scope,root,{limit:1}),two=await reader.listHeads(scope,root,{limit:1,cursor:one.nextCursor!})
  expect(two.heads[0].canonicalKey).toBe('9007199254740994')
  await expect(reader.listHeads({...scope,principalUserId:'2'},root)).rejects.toMatchObject({code:'revoked'})
 })
 test('historical cold heads derive missing canonical hashes from verified archive once without promoting provenance',async()=>{
  const saved=(await pool.query("SELECT id::text,canonical_payload_hash FROM public.events WHERE body_storage='cold' ORDER BY id")).rows
  await pool.query("UPDATE public.events SET canonical_payload_hash=NULL WHERE body_storage='cold'")
  let reads=0
  const reader=createPostgresSharedSourceReader(runtime,{storage:{namespace:storage.namespace,read:async key=>{reads++;return storage.read(key)}},limits})
  try{
   const page=await reader.listHeads(scope,root)
   expect(page.heads.filter(h=>h.storage==='cold').map(h=>h.contentHash)).toEqual(saved.map(r=>r.canonical_payload_hash))
   expect(page.heads.every(h=>h.provenance.state==='unknown')).toBe(true)
   expect(JSON.stringify(page)).not.toContain('private cold')
   await reader.resolveBodies(scope,root,page.heads,page.version);expect(reads).toBe(1)
   await pool.query('UPDATE public.extension_installations SET authorization_epoch=2')
   await expect(reader.resolveBodies(scope,root,page.heads,page.version)).rejects.toMatchObject({code:'revoked'})
  }finally{for(const r of saved)await pool.query('UPDATE public.events SET canonical_payload_hash=$1 WHERE id=$2',[r.canonical_payload_hash,r.id]);await pool.query('UPDATE public.extension_installations SET authorization_epoch=1')}
 })
 test('provider disable and installation filters deny out-of-scope reads before and after IO',async()=>{
  const reader=createPostgresSharedSourceReader(runtime,{storage,limits}),page=await reader.listHeads(scope,root)
  await pool.query("UPDATE public.extension_providers SET status='disabled'")
  await expect(reader.listHeads(scope,root)).rejects.toMatchObject({code:'revoked'})
  await expect(reader.resolveBodies(scope,root,page.heads,page.version)).rejects.toMatchObject({code:'revoked'})
  await pool.query("UPDATE public.extension_providers SET status='enabled'")
  for(const filter of [{daemon_ids:['other']},{agent_types:['claude']},{unknown:['codex']},{daemon_ids:'daemon'},null]){
   await pool.query('UPDATE public.extension_installations SET event_filter=$1::jsonb',[JSON.stringify(filter)])
   await expect(reader.listHeads(scope,root)).rejects.toMatchObject({code:'revoked'})
  }
  for(const filter of [{daemon_ids:['daemon'],agent_types:['codex']},{daemon_ids:[],agent_types:[]},{}]){
   await pool.query('UPDATE public.extension_installations SET event_filter=$1::jsonb',[JSON.stringify(filter)])
   expect((await reader.listHeads(scope,root)).heads).toHaveLength(3)
  }
 })
 test('rechecks authoritative revocation after cold IO and rejects storage revision races',async()=>{
  let change:'revoke'|'storage'='revoke'
  const readStorage:ArchiveReadStorage={namespace:storage.namespace,read:async key=>{
   if(change==='revoke')await pool.query('UPDATE public.extension_installations SET authorization_epoch=2')
   else await pool.query("UPDATE shared.memory_source_work SET storage_revision=storage_revision+1 WHERE root_key='1:session'")
   return storage.read(key)
  }}
  const page=await createPostgresSharedSourceReader(runtime,{storage,limits}).listHeads(scope,root)
  const reader=createPostgresSharedSourceReader(runtime,{storage:readStorage,limits})
  await expect(reader.resolveBodies(scope,root,page.heads,page.version)).rejects.toMatchObject({code:'revoked'})
  await pool.query('UPDATE public.extension_installations SET authorization_epoch=1');change='storage'
  await expect(reader.resolveBodies(scope,root,page.heads,page.version)).rejects.toMatchObject({code:'changed'})
 })
 test('retention committed during cold IO invalidates the raw page without touching Relay',async()=>{
  await runtime.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1) ON CONFLICT DO NOTHING`,[inst])
  const normal=createPostgresSharedSourceReader(runtime,{storage,limits})
  const page=await normal.getHeads(scope,root,['9007199254740994'])
  const before=(await pool.query('SELECT payload,body_storage FROM public.events WHERE id=9007199254740994')).rows[0]
  const reader=createPostgresSharedSourceReader(runtime,{storage:{namespace:storage.namespace,read:async key=>{
   await runtime.query(`INSERT INTO memory_source_retention_receipts(installation_id,session_id,turn_id,episode_id,source_digest,compiler_version,extraction_completed_at,state)
    VALUES($1,'session','turn-2',NULL,$2,'lifecycle-v1',now(),'reclaiming')`,[inst,Buffer.alloc(32)])
   return storage.read(key)
  }},limits})
  try{
   await expect(reader.resolveBodies(scope,root,page.heads,page.version)).rejects.toMatchObject({code:'changed'})
   expect((await normal.checkAuthority(scope,root)).state).toBe('current')
   expect((await pool.query('SELECT payload,body_storage FROM public.events WHERE id=9007199254740994')).rows[0]).toEqual(before)
  }finally{await runtime.query('DELETE FROM memory_installations WHERE installation_id=$1',[inst])}
 })
 test('namespace/hash corruption and current tombstone fail closed',async()=>{
  const reader=createPostgresSharedSourceReader(runtime,{storage,limits}),page=await reader.listHeads(scope,root)
  await storage.put(objectKey,Buffer.from('invalid gzip'))
  await expect(createPostgresSharedSourceReader(runtime,{storage,limits}).resolveBodies(scope,root,page.heads,page.version)).rejects.toMatchObject({code:'archive_unavailable'})
  await storage.put(objectKey,bytes)
  const wrong=createPostgresSharedSourceReader(runtime,{storage:{namespace:'wrong',read:key=>storage.read(key)},limits})
  await expect(wrong.resolveBodies(scope,root,page.heads,page.version)).rejects.toMatchObject({code:'archive_namespace_mismatch'})
  await pool.query("INSERT INTO public.deleted_sessions VALUES('session')")
  await expect(reader.resolveBodies(scope,root,page.heads,page.version)).rejects.toMatchObject({code:'deleted'})
  await pool.query('DELETE FROM public.deleted_sessions')
 })
 test('Memory-only privacy purge blocks current checks and stale hot/cold heads while Relay retains canonical content',async()=>{
  const reader=createPostgresSharedSourceReader(runtime,{storage,limits}),page=await reader.listHeads(scope,root)
  await pool.query("INSERT INTO memory.memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,'session','privacy',NOW())",[inst])
  try{
   expect((await reader.checkCurrent(scope,root,page.version)).state).toBe('deleted')
   await expect(reader.listHeads(scope,root)).rejects.toMatchObject({code:'deleted'})
   await expect(reader.resolveBodies(scope,root,page.heads,page.version)).rejects.toMatchObject({code:'deleted'})
   expect((await pool.query('SELECT count(*)::int n FROM public.events')).rows[0].n).toBe(4)
  }finally{await pool.query('DELETE FROM memory.memory_session_tombstones')}
 })
 test('cold body-owner header must match current owner even if a valid decoded chunk is cached',async()=>{
  const reader=createPostgresSharedSourceReader(runtime,{storage,limits}),page=await reader.listHeads(scope,root)
  await pool.query("UPDATE public.events SET body_owner_user_id=2 WHERE body_storage='cold'")
  try{await expect(reader.resolveBodies(scope,root,page.heads,page.version)).rejects.toMatchObject({code:'archive_binding_invalid'})}
  finally{await pool.query("UPDATE public.events SET body_owner_user_id=1 WHERE body_storage='cold'")}
 })
 test('trusted published headers resolve fresh provenance after Journal pruning without promoting raw payload proofs',async()=>{
  await pool.query(`ALTER TABLE public.events ADD COLUMN source_header_version smallint,ADD COLUMN source_classification jsonb;
   ALTER TABLE public.extension_source_outbox ADD COLUMN payload jsonb,ADD COLUMN occurred_at timestamptz,ADD COLUMN created_at timestamptz DEFAULT now();
   CREATE SEQUENCE public.header_journal_sequence START WITH 9007199254741100;
   ALTER TABLE public.extension_source_outbox ALTER COLUMN source_seq SET DEFAULT nextval('public.header_journal_sequence');
   CREATE UNIQUE INDEX header_journal_identity ON public.extension_source_outbox(source_kind,source_id);`)
  const proof={version:1,producer:'codex',session_id:'session',turn_id:'fresh',event_id:'daemon-fresh',sequence:'3',invocation_id:'fresh-invocation',source_role:'assistant',skill_state:'unknown',lineage_complete:false,derived_from_event_ids:[]}
  const payload={text:'fresh canonical body',turn_id:'fresh',actor_scope:'assistant',memory_source:proof},id='9007199254741000'
  const rawId='9007199254741001'
  await pool.query(`INSERT INTO public.events(id,session_id,user_id,event_type,payload,effect_status,body_storage) VALUES($1,'session',1,'agent_text',$2,'completed','hot'),($3,'session',1,'agent_text',$2,'completed','hot')`,[id,payload,rawId])
  const {createExtensionJournalSinkFromEnv}=await import(new URL('../../../../relay/src/extensions/journal.ts',import.meta.url).href)
  await createExtensionJournalSinkFromEnv({RELAY_EXTENSIONS:'enabled',RELAY_SHARED_SOURCE_HEADERS:'enabled'})!.appendCanonicalEvent(pool,{sourceEventId:id,ownerUserId:1,sessionId:'session',eventType:'agent_text',occurredAt:null,payload})
  await pool.query('DELETE FROM public.extension_source_outbox')
  const reader=createPostgresSharedSourceReader(runtime,{storage,limits}),page=await reader.listHeads(scope,root)
  const head=page.heads.find(h=>h.canonicalKey===id)!,raw=page.heads.find(h=>h.canonicalKey===rawId)!
  expect(head.provenance).toEqual({state:'known',memory:{...proof,sequence:'9007199254741100'}})
  expect(head.classification).toMatchObject({actor_scope:'assistant',memory_source:{sequence:'9007199254741100'}})
  expect(raw.provenance).toEqual({state:'unknown'})
  expect((await reader.resolveBodies(scope,root,[head],page.version))[0].payload).toEqual(payload)
  const freshManifest='30000000-0000-0000-0000-000000000004',freshKey=`session-archive/v1/${freshManifest}/0.gz`
  const encoded=await encodeArchiveChunk({userId:1,sessionId:'session',activityEpoch:'8',manifestId:freshManifest,ordinal:0},[{id,eventType:'agent_text',payload}],limits)
  await storage.put(freshKey,encoded.bytes)
  const m=encoded.manifest
  await pool.query("INSERT INTO public.session_archive_manifests VALUES($1,1,'session',8,1,'gzip','published','reader-archive')",[freshManifest])
  await pool.query('INSERT INTO public.session_archive_chunks VALUES($1,0,$2,$3,$3,1,$4,$5,$6,$7)',[freshManifest,freshKey,id,String(m.rawBytes),String(m.compressedBytes),m.rawSha256,m.compressedSha256])
  await pool.query("UPDATE public.events SET payload=NULL,body_storage='cold',body_manifest_id=$2,body_chunk_ordinal=0,body_activity_epoch=8,body_owner_user_id=1 WHERE id=$1",[id,freshManifest])
  await pool.query("UPDATE shared.memory_source_work SET storage_revision=storage_revision+1 WHERE root_key='1:session'")
  const coldPage=await reader.listHeads(scope,root),coldHead=coldPage.heads.find(h=>h.canonicalKey===id)!
  expect(coldHead.storage).toBe('cold');expect(coldHead.provenance).toEqual(head.provenance)
  expect((await reader.resolveBodies(scope,root,[coldHead],coldPage.version))[0].payload).toEqual(payload)
  // A previously persisted unknown must remain unknown, even when the new
  // canonical header carries a shape-valid proof. Metadata conflicts block.
  await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[inst])
  await pool.query(`INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,
    classification,source_kind,canonical_key,canonical_session_key,source_version,source_sequence,content_hash,hash_version,mapping_state,adapter_version)
    SELECT '90000000-0000-0000-0000-000000000001',$1,'feed','frozen-unknown','session','fresh','agent_text',now(),$3::jsonb,decode(canonical_payload_hash,'hex'),
     source_classification,'relay_event',id::text,'session','{"content":"1","authorization":"1","storage":"0"}',source_sequence,decode(canonical_payload_hash,'hex'),'canonical-json-sha256-v1','verified','v1'
     FROM public.events WHERE id=$2`,[inst,id,JSON.stringify(payload)])
  expect((await reader.listHeads(scope,root)).heads.find(h=>h.canonicalKey===id)!.provenance).toEqual({state:'unknown'})
  await pool.query("UPDATE memory.source_events SET classification='{}' WHERE origin_position='frozen-unknown'")
  await expect(reader.listHeads(scope,root)).rejects.toMatchObject({code:'source_metadata_conflict'})
  await pool.query("DELETE FROM memory.source_events WHERE origin_position='frozen-unknown'")
  await pool.query('UPDATE public.events SET source_header_version=2 WHERE id=$1',[id])
  await expect(reader.listHeads(scope,root)).rejects.toMatchObject({code:'source_header_version_unsupported'})
  await pool.query('UPDATE public.events SET source_header_version=1 WHERE id=$1',[id])
  await pool.query('DELETE FROM public.events WHERE id IN($1,$2)',[id,rawId])
 })

 test('eligible enumeration skips an expired prefix before LIMIT and denied cold keys perform no archive IO',async()=>{
  const manifest='30000000-0000-0000-0000-000000000097',id='9007199254741269',key=`session-archive/v1/${manifest}/0.gz`
  const proof={version:1,producer:'codex',session_id:'session',turn_id:'new-eligible-turn',event_id:'new-native-event',sequence:'55',invocation_id:'new-native-invocation',source_role:'assistant',skill_state:'unknown',lineage_complete:false,derived_from_event_ids:[]}
  const payload={text:'new eligible cold source',turn_id:'new-eligible-turn',memory_source:proof}
  const encoded=await encodeArchiveChunk({userId:1,sessionId:'session',activityEpoch:'9',manifestId:manifest,ordinal:0},[{id,eventType:'agent_text',payload}],limits)
  await storage.put(key,encoded.bytes)
  await pool.query("INSERT INTO public.session_archive_manifests VALUES($1,1,'session',9,1,'gzip','published','reader-archive')",[manifest])
  await pool.query('INSERT INTO public.session_archive_chunks VALUES($1,0,$2,$3,$3,1,$4,$5,$6,$7)',[manifest,key,id,String(encoded.manifest.rawBytes),String(encoded.manifest.compressedBytes),encoded.manifest.rawSha256,encoded.manifest.compressedSha256])
  await pool.query("INSERT INTO public.events(id,session_id,user_id,event_type,payload,effect_status,body_storage,body_manifest_id,body_chunk_ordinal,body_activity_epoch,body_owner_user_id,canonical_payload_hash,source_sequence,source_header_version,source_classification) VALUES($1,'session',1,'agent_text',NULL,'completed','cold',$2,0,9,1,$3,55,1,$4)",[id,manifest,canonicalPayloadHash(payload).toString('hex'),{memory_source:proof}])
  await runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1) ON CONFLICT DO NOTHING",[inst])
  const expired=await createPostgresSharedSourceReader(runtime,{storage,limits}).getHeads(scope,root,['9007199254740994'])
  let reads=0
  const reader=createPostgresSharedSourceReader(runtime,{storage:{namespace:storage.namespace,read:async k=>{reads++;return storage.read(k)}},limits})
  try{
   await runtime.query("INSERT INTO memory_source_retention_receipts(installation_id,session_id,turn_id,episode_id,source_digest,compiler_version,extraction_completed_at,state) VALUES($1,'session','turn-1',NULL,$2,'lifecycle-v1',now(),'reclaiming')",[inst,Buffer.alloc(32)])
   const page=await reader.listHeads(scope,root,{limit:1})
   expect(page.heads.map(h=>h.canonicalKey)).toEqual([id])
   expect(page.nextCursor).toBeTruthy();expect(reads).toBe(0)
   await expect(reader.getHeads(scope,root,['9007199254740994'])).rejects.toMatchObject({code:'source_body_reclaimed'})
   expect(reads).toBe(0)
   const current=await reader.checkCurrent(scope,root)
   await expect(reader.resolveBodies(scope,root,expired.heads,current.version)).rejects.toMatchObject({code:'source_body_reclaimed'})
   expect(reads).toBe(0)
   const fresh=await reader.getHeads(scope,root,[id]);expect(reads).toBe(0)
   expect((await reader.resolveBodies(scope,root,fresh.heads,fresh.version))[0].payload).toEqual(payload)
   expect(reads).toBe(1)
  }finally{
   await runtime.query("DELETE FROM memory_source_retention_receipts WHERE installation_id=$1 AND turn_id='turn-1'",[inst])
   await pool.query('DELETE FROM public.events WHERE id=$1',[id])
   await pool.query('DELETE FROM public.session_archive_chunks WHERE manifest_id=$1',[manifest])
   await pool.query('DELETE FROM public.session_archive_manifests WHERE manifest_id=$1',[manifest])
  }
 })

 test('stable UUID preparation resolves canonical bodies outside transactions and rejects ref/auth/mode changes',async()=>{
  const {prepareSourceReferences}=await import('../../sources/prepared-sources.js')
  const sourceId='90000000-0000-0000-0000-000000000002',id='9007199254740993'
  const payload=(await pool.query('SELECT payload FROM public.events WHERE id=$1',[id])).rows[0].payload
  await pool.query(`INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,classification,
   source_kind,canonical_key,canonical_session_key,source_version,content_hash,hash_version,mapping_state,adapter_version)
   VALUES($1,$2,'feed','prepared-ref','session','turn-1','agent_text',now(),'{"compatibility_body":"must never be read"}',$3,'{}','relay_event',$4,'session','{"content":"1","authorization":"1","storage":"0"}',$3,'canonical-json-sha256-v1','verified','v1')`,[sourceId,inst,canonicalPayloadHash(payload),id])
  const prepared=await prepareSourceReferences(runtime,inst,[sourceId])
  expect(prepared.events[0].source_event_id).toBe(sourceId);expect(prepared.events[0].payload).toEqual(payload)
  const tx=await runtime.connect();try{await tx.query('BEGIN');await prepared.assertCurrent(tx);await tx.query('COMMIT')}finally{tx.release()}
  await pool.query('UPDATE public.extension_installations SET authorization_epoch=2')
  await expect(prepared.assertCurrent(runtime as never)).rejects.toThrow('source_reference_changed')
  await pool.query('UPDATE public.extension_installations SET authorization_epoch=1')
  await pool.query("UPDATE memory.source_events SET occurred_at=occurred_at+interval '1 second' WHERE source_event_id=$1",[sourceId])
  await expect(prepared.assertCurrent(runtime as never)).rejects.toThrow('source_reference_changed')
  await pool.query("UPDATE shared.memory_source_modes SET mode='paused' WHERE installation_id=$1",[inst])
  await expect(prepareSourceReferences(runtime,inst,[sourceId])).rejects.toThrow('source_mode_paused')
  await pool.query("UPDATE shared.memory_source_modes SET mode='shared-shadow' WHERE installation_id=$1",[inst])
  await pool.query('DELETE FROM memory.source_events WHERE source_event_id=$1',[sourceId])
 })

 test('shared episode compilation consumes prepared canonical bodies and never selects compatibility payloads',async()=>{
  const {createEpisodeRepository}=await import('../../episodes/repository.js')
  const sourceId='90000000-0000-0000-0000-000000000003',id='9007199254740993'
  const payload=(await pool.query('SELECT payload FROM public.events WHERE id=$1',[id])).rows[0].payload
  await pool.query(`INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'session',now(),now());
   `,[inst])
  await pool.query(`INSERT INTO memory.source_turns(installation_id,turn_id,session_id,state,started_at,terminal_at,event_count) VALUES($1,'turn-1','session','completed',now(),now(),1)`,[inst])
  await pool.query(`INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,classification,
   source_kind,canonical_key,canonical_session_key,source_version,content_hash,hash_version,mapping_state,adapter_version)
   VALUES($1,$2,'feed','prepared-episode','session','turn-1','agent_text',now(),'{"text":"wrong compatibility body"}',$3,'{}','relay_event',$4,'session','{"content":"1","authorization":"1","storage":"0"}',$3,'canonical-json-sha256-v1','verified','v1')`,[sourceId,inst,canonicalPayloadHash(payload),id])
  const originalConnect=runtime.connect.bind(runtime)
  const guardedConnect=async()=>{const c=await originalConnect(),originalQuery=c.query,release=c.release,query=c.query.bind(c);c.release=((...args:any[])=>{c.query=originalQuery;c.release=release;return (release as any)(...args)}) as any;c.query=((sql:any,...args:any[])=>{if(typeof sql==='string'&&/\bsource_events\b/.test(sql)&&(/(?:\b(?:s|e|event)\.payload\b|(?<!\.)\bpayload\b)/.test(sql)||sql.includes('to_jsonb(s)')))throw Error('compatibility_payload_read');return (query as any)(sql,...args)}) as any;return c}
  const observed=Object.create(runtime);observed.connect=guardedConnect;observed.query=runtime.query.bind(runtime)
  const {bindSourcePool,sourcePoolContext}=await import('../../sources/pool-context.js');bindSourcePool(observed,sourcePoolContext(runtime))
  await createEpisodeRepository(observed,{stabilizationMs:0}).compileTurn(inst,'turn-1')
  const episode=(await pool.query("SELECT summary,document FROM memory.work_episodes WHERE installation_id=$1 AND turn_id='turn-1'",[inst])).rows[0]
  expect(episode).toBeDefined();expect(JSON.stringify(episode)).not.toContain('wrong compatibility body')
  let archiveReads=0
  bindSourcePool(observed,{...sourcePoolContext(runtime),archive:{limits,storage:{namespace:storage.namespace,read:async key=>{
   archiveReads++;expect((await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n).toBe(0)
   return storage.read(key)
  }}}})
  const coldSource='90000000-0000-0000-0000-000000000005',coldPayload={text:'private cold one',turn_id:'turn-2'}
  await pool.query("INSERT INTO memory.source_turns(installation_id,turn_id,session_id,state,started_at,terminal_at,event_count) VALUES($1,'turn-2','session','completed',now(),now(),1)",[inst])
  await pool.query(`INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,classification,source_kind,canonical_key,canonical_session_key,source_version,content_hash,hash_version,mapping_state,adapter_version)
   VALUES($1,$2,'feed','prepared-cold','session','turn-2','agent_text',now(),'{}',$3,'{}','relay_event','9007199254740994','session','{"content":"1","authorization":"1","storage":"0"}',$3,'canonical-json-sha256-v1','verified','v1')`,[coldSource,inst,canonicalPayloadHash(coldPayload)])
  await createEpisodeRepository(observed,{stabilizationMs:0}).compileTurn(inst,'turn-2')
  expect(archiveReads).toBeGreaterThan(0)
  expect((await pool.query("SELECT event_count FROM memory.work_episodes WHERE installation_id=$1 AND turn_id='turn-2'",[inst])).rows[0].event_count).toBe('1')
  const {prepareSourceReferences}=await import('../../sources/prepared-sources.js'),{lifecycleSourceDigest,loadCurrentLifecycleSources}=await import('../../curation/task-repository.js'),{curationTransaction}=await import('../../curation/worker.js')
  const prepared=await prepareSourceReferences(runtime,inst,[sourceId]),bundleId=(await import('node:crypto')).randomUUID()
  await pool.query("INSERT INTO memory.memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark) VALUES($1,$2,'session','source:turn-1',$3,1)",[inst,bundleId,lifecycleSourceDigest(inst,prepared.events)])
  const current=await curationTransaction(observed,inst,bundleId,async(c,bundle)=>loadCurrentLifecycleSources(c,inst,bundle))
  expect(current!.events.map(e=>e.payload.text)).toEqual(['private hot'])
  expect(current!.unknown).toBe(true)
  await expect(curationTransaction(observed,inst,bundleId,async(c)=>{
   await c.query("UPDATE memory_task_bundles SET state='completed' WHERE installation_id=$1 AND bundle_id=$2",[inst,bundleId])
   await pool.query('UPDATE public.extension_installations SET authorization_epoch=2 WHERE installation_id=$1',[inst])
  })).rejects.toThrow('source_reference_changed')
  expect((await pool.query('SELECT state FROM memory.memory_task_bundles WHERE bundle_id=$1',[bundleId])).rows[0].state).toBe('pending')
  await pool.query('UPDATE public.extension_installations SET authorization_epoch=1 WHERE installation_id=$1',[inst])
  const {lifecycleSourceRetentionProof}=await import('../../retention/task-state.js'),retentionClient=await observed.connect()
  try{await retentionClient.query('BEGIN');expect(await lifecycleSourceRetentionProof(retentionClient,{installationId:inst,sessionId:'session',turnId:'turn-1',bodyDays:14})).toBeNull();await retentionClient.query('COMMIT')}finally{await retentionClient.query('ROLLBACK');retentionClient.release()}


 })

 test('runtime source health exposes only aggregate modes, work and allocated copy bytes',async()=>{
  const c=await runtime.connect()
  try{
   await c.query('BEGIN READ ONLY')
   const health=(await c.query('SELECT shared.memory_source_health() AS health')).rows[0].health
   expect(health.ready).toBe(false);expect(health.modes).toContainEqual({mode:'shared-shadow',count:'1'})
   expect(health.roots.some((r:any)=>r.kind==='relay_event'&&r.state==='pending')).toBe(true)
   expect(health.copies.some((r:any)=>r.table==='source_events'&&BigInt(r.bytes)>0n)).toBe(true)
   expect(JSON.stringify(health)).not.toMatch(/private hot|session|10000000-0000/)
   await c.query('COMMIT')
  }finally{await c.query('ROLLBACK');c.release()}
 })

 test('contended source health cancels and preserves the last observed values',async()=>{
  const {Registry}=await import('prom-client'),{createSourceMetrics,createSourceGaugeCollector}=await import('../../sources/metrics.js')
  const registry=new Registry(),metrics=createSourceMetrics(registry),collect=createSourceGaugeCollector(runtime,metrics,{intervalMs:0})
  await collect();const initial=await registry.metrics(),blocker=await pool.connect()
  try{
   await blocker.query('BEGIN');await blocker.query('LOCK TABLE shared.memory_source_work IN ACCESS EXCLUSIVE MODE')
   await expect(collect()).rejects.toMatchObject({code:'55P03'})
   expect(await registry.metrics()).toBe(initial)
  }finally{await blocker.query('ROLLBACK');blocker.release()}
  expect((await runtime.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0')
  expect((await runtime.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('0')
  await collect()
 })

 test('current Relay authority locks serialize config changes and fail closed without lock-order waits',async()=>{
  const reader=await runtime.connect(),writer=await pool.connect()
  try{
   await reader.query('BEGIN')
   expect((await reader.query('SELECT shared.lock_memory_grant_authority($1::uuid[],$2::uuid[]) AS locked',[[inst],[]])).rows[0].locked).toBe(true)
   await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'")
   await expect(writer.query('UPDATE public.extension_installations SET config_version=config_version+1 WHERE installation_id=$1',[inst])).rejects.toMatchObject({code:'55P03'})
   await writer.query('ROLLBACK');await reader.query('COMMIT')
   await writer.query('BEGIN');await writer.query('SELECT 1 FROM public.users WHERE id=1 FOR UPDATE')
   await reader.query('BEGIN')
   expect((await reader.query('SELECT shared.lock_memory_grant_authority($1::uuid[],$2::uuid[]) AS locked',[[inst],[]])).rows[0].locked).toBe(false)
   // All partial locks are released on contention.
   await writer.query("SET LOCAL lock_timeout='100ms'")
   await writer.query('UPDATE public.extension_installations SET config_version=config_version WHERE installation_id=$1',[inst])
   await writer.query('ROLLBACK');await reader.query('ROLLBACK')
   await expect(runtime.query('UPDATE public.extension_installations SET config_version=2 WHERE installation_id=$1',[inst])).rejects.toMatchObject({code:'42501'})
  }finally{await reader.query('ROLLBACK');await writer.query('ROLLBACK');reader.release();writer.release()}
 })

 test('two v1 personal reads share the installation fence without an exclusive upgrade',async()=>{
  await runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1) ON CONFLICT DO NOTHING",[inst])
  const {retainedSourceRead}=await import('../../sources/retained-read.js'),other=await runtime.connect()
  try{
   await other.query('BEGIN');await other.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[inst])
   expect(await retainedSourceRead(runtime,{installationId:inst,authorityGrant:{installationId:inst,configVersion:'1',userId:1}},async()=>true)).toBe(true)
  }finally{await other.query('ROLLBACK');other.release()}
 })

 test('shared API evidence material resolves canonical text instead of the retired compatibility copy',async()=>{
  const {governanceFixture}=await import('../../testing/governance-fixture.js'),{createEvidenceService}=await import('../../claims/evidence-service.js')
  const seed=createMemoryPool({databaseUrl:url!,databaseNamespace:'memory',dbPoolMax:2}),readApps:import('fastify').FastifyInstance[]=[]
  try{
   const f=await governanceFixture(seed),event='90000000-0000-0000-0000-000000000004',canonical='9007199254740993'
   const payload=(await pool.query('SELECT payload FROM public.events WHERE id=$1',[canonical])).rows[0].payload
   await pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,authorization_epoch,config_version,granted_scopes,enabled_services,event_filter) VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}')",[f.personal])
   await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[f.personal])
   const org=(await import('node:crypto')).randomUUID()
   await pool.query("INSERT INTO public.extension_organizations VALUES($1,'active',1)",[org])
   await pool.query("INSERT INTO public.extension_teams VALUES($1,$2,'active',1)",[f.team,org])
   await pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,authorization_epoch,config_version,granted_scopes,enabled_services,event_filter) VALUES($1,'pocketctl-memory',NULL,'team',$1,'active',1,1,ARRAY['scope:control:read'],ARRAY['memory.manage'],'{}')",[f.team])
   await pool.query("INSERT INTO public.extension_scope_memberships VALUES($1,'team',$2,1,ARRAY['scope_administrator'],'active',1)",[f.publisher,f.team])
   await seed.query("INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'session',now(),now())",[f.personal])
   await seed.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,classification,
    source_kind,canonical_key,canonical_session_key,source_version,content_hash,hash_version,mapping_state,adapter_version)
    VALUES($1,$2,'feed','api-ref','session','turn-1','agent_text',now(),'{"text":"wrong raw fallback"}',$3,'{}','relay_event',$4,'session','{"content":"1","authorization":"1","storage":"0"}',$3,'canonical-json-sha256-v1','verified','v1')`,[event,f.personal,canonicalPayloadHash(payload),canonical])
   await seed.query("UPDATE knowledge_evidence SET source_event_id=$2,evidence_kind='event' WHERE evidence_id=$1",[f.evidence,event])
   const service=createEvidenceService(runtime),input={installationId:f.personal,evidenceId:f.evidence,scopeGrant:{...f.grant(f.publisher,['read']),userId:1}}
   const summary=await service.summary(input) as {reference:{source_hash:string;excerpt_hash:string}}|null
   expect(summary).toBeTruthy();expect(summary!.reference.source_hash).toBe((await import('node:crypto')).createHash('sha256').update(payload.text).digest('hex'))
   const {createReviewService}=await import('../../claims/review-service.js'),{randomUUID:reviewUuid,createHash:reviewHash}=await import('node:crypto')
   const reviewEpisode=reviewUuid(),reviewRun=reviewUuid(),reviewCandidate=reviewUuid(),reviewDigest=Buffer.alloc(32,11)
   const reviewText='Retained review packet',reviewHandle='h-review'
   await seed.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,document,evidence_manifest,compiled_at,source_digest)
    VALUES($1,$2,'session','turn-1','ready','fixture',$3,$4,NOW(),$5)`,[f.personal,reviewEpisode,{final_outcome:{text:reviewText,evidence_handle:reviewHandle}},
     {[reviewHandle]:{kind:'event',source_event_id:event,excerpt_length:reviewText.length,excerpt_hash:reviewHash('sha256').update(reviewText).digest('hex').slice(0,16)}},reviewDigest])
   await seed.query(`INSERT INTO memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model)
    VALUES($1,$2,$3,$4,'fixture','fixture',$4,$4,'enabled','succeeded','fixture','fixture')`,[reviewRun,f.personal,reviewEpisode,reviewDigest])
   await seed.query(`INSERT INTO memory_candidates(candidate_id,installation_id,run_id,episode_id,ordinal,claim_type,statement,normalized_key,scope_kind,scope_key,confidence,freshness_at,evidence_handles,status)
    VALUES($1,$2,$3,$4,0,'work_method','Review candidate','review-candidate','installation','global',1,NOW(),$5,'validated')`,[reviewCandidate,f.personal,reviewRun,reviewEpisode,JSON.stringify([reviewHandle])])
   const {createMemoryReadService}=await import('../../retrieval/read-service.js')
   const ordinaryEvidence=createMemoryReadService(runtime,'fixture-key')
   expect(await ordinaryEvidence.getEvidence(f.personal,f.evidence,input.scopeGrant)).toBeTruthy()
   expect((await ordinaryEvidence.listActiveClaims(f.personal,{authorityGrant:input.scopeGrant} as any)).claims).toHaveLength(1)
   expect(await ordinaryEvidence.getClaim(f.personal,f.claim,{authorityGrant:input.scopeGrant} as any)).toBeTruthy()
   const {createSearchService}=await import('../../retrieval/search-service.js'),{createRecallService}=await import('../../retrieval/recall-service.js')
   const search=createSearchService({pool:runtime,cursorSigningKey:'fixture',recallEmbeddingTimeoutMs:100}),searchInput={installationId:f.personal,query:'transactional fixture',authorityGrant:input.scopeGrant}
   expect((await search.search(searchInput)).hits).toHaveLength(1)
   const recall=createRecallService(runtime,search)
   expect((await recall.recall(searchInput)).claims).toHaveLength(1)
   const {assertRetainedVersionResponse}=await import('../../sources/retained-versions.js')
   const extraClaim=reviewUuid(),extraVersion=reviewUuid()
   await seed.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1) ON CONFLICT DO NOTHING",[inst])
   await seed.query("INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2,'test_invariant','installation','','manual-reader-fence','active')",[extraClaim,inst])
   await seed.query("INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,1,'Independent accepted knowledge','user_accepted',1)",[extraVersion,inst,extraClaim])
   await seed.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[extraClaim,extraVersion])
   await seed.query(`WITH capsule AS(INSERT INTO knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash)
    VALUES(gen_random_uuid(),$1,$2,'user_accepted',sha256(convert_to('manual','UTF8'))) RETURNING capsule_id)
    INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at)
    SELECT gen_random_uuid(),$1,$2,capsule_id,1,'accepted_excerpt','manual',sha256(convert_to('manual','UTF8')),now() FROM capsule`,[inst,extraVersion])
   const multiGrant={...input.scopeGrant,scopeBindings:[...input.scopeGrant.scopeBindings,{installation_id:inst,owner_scope_kind:'personal' as const,owner_scope_id:inst,membership_id:null,membership_revision:'0',authorization_epoch:'1',permissions:['read']}]}
   const selections=[{installationId:f.personal,versionId:f.version,statement:'Transactional fixture invariant'},{installationId:inst,versionId:extraVersion,statement:'Independent accepted knowledge'}]
   await expect(assertRetainedVersionResponse(runtime,multiGrant,selections)).resolves.toBeUndefined()
   const sideSession='conflict-only-'+reviewUuid(),sideSource=reviewUuid(),sideEpisode=reviewUuid(),sideRun=reviewUuid(),sideCandidate=reviewUuid(),sideEvent='9007199254741590',sideBody={text:'Independent conflict source',turn_id:'conflict-only'}
   await pool.query("INSERT INTO public.sessions VALUES($1,1,'daemon','codex','hot','codex')",[sideSession])
   await pool.query("INSERT INTO public.events(id,user_id,session_id,event_type,payload,effect_status,body_storage) VALUES($1,1,$2,'agent_text',$3,'completed','hot')",[sideEvent,sideSession,sideBody])
   await pool.query("SELECT shared.mark_memory_source_dirty('relay_event',$1)",['1:'+sideSession])
   await seed.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,classification,
    source_kind,canonical_key,canonical_session_key,source_version,content_hash,hash_version,mapping_state,adapter_version)
    VALUES($1,$2,'feed','conflict-only',$3,'conflict-only','agent_text',now(),'{}',$4,'{}','relay_event',$5,$3,'{"content":"1","authorization":"1","storage":"0"}',$4,'canonical-json-sha256-v1','verified','v1')`,[sideSource,inst,sideSession,canonicalPayloadHash(sideBody),sideEvent])
   await seed.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,evidence_manifest,source_digest)
    VALUES($1,$2,$3,'conflict-only','ready','fixture',$4,$5)`,[inst,sideEpisode,sideSession,{side:{source_event_id:sideSource}},reviewDigest])
   await seed.query(`INSERT INTO memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model)
    VALUES($1,$2,$3,$4,'fixture','fixture',$4,$4,'enabled','succeeded','fixture','fixture')`,[sideRun,inst,sideEpisode,reviewDigest])
   await seed.query(`INSERT INTO memory_candidates(candidate_id,installation_id,run_id,episode_id,ordinal,claim_type,statement,normalized_key,scope_kind,scope_key,confidence,freshness_at,evidence_handles,status,duplicate_of_claim_id)
    VALUES($1,$2,$3,$4,0,'test_invariant','Independent conflict excerpt','manual-reader-conflict','installation','global',1,now(),'[]','conflict',$5)`,[sideCandidate,inst,sideRun,sideEpisode,extraClaim])
   let sideRecall=await recall.recall({installationId:inst,query:'Independent accepted knowledge',authorityGrant:multiGrant})
   expect(sideRecall.conflicts.map(conflict=>conflict.claimId)).toContain(sideCandidate)
   const sideSelections=sideRecall.claims.map(claim=>({installationId:inst,versionId:claim.versionId,witness:claim}))
   await pool.query('INSERT INTO public.deleted_sessions VALUES($1)',[sideSession])
   try{
    // The selected accepted capsule is still valid. The additional conflict
    // dependency is why the actual merged endpoint must carry the read proof.
    await expect(assertRetainedVersionResponse(runtime,multiGrant,sideSelections)).resolves.toBeUndefined()
    await expect(assertRetainedVersionResponse(runtime,multiGrant,sideSelections,{retainedReads:[{installationId:inst,result:sideRecall}]})).rejects.toThrow('source_reference_changed')
   }finally{await pool.query('DELETE FROM public.deleted_sessions WHERE session_id=$1',[sideSession])}
   sideRecall=await recall.recall({installationId:inst,query:'Independent accepted knowledge',authorityGrant:multiGrant})
   await seed.query("UPDATE memory_candidates SET statement='[content reclaimed]',status='expired',body_reclaimed_at=now(),revision=revision+1 WHERE candidate_id=$1",[sideCandidate])
   await expect(assertRetainedVersionResponse(runtime,multiGrant,sideSelections)).resolves.toBeUndefined()
   await expect(assertRetainedVersionResponse(runtime,multiGrant,sideSelections,{retainedReads:[{installationId:inst,result:sideRecall}]})).rejects.toThrow('source_reference_changed')


   const lostEvidence=(await seed.query('DELETE FROM knowledge_evidence e WHERE evidence_id=$1 RETURNING row_to_json(e)::text AS original',[f.evidence])).rows[0].original
   try{await expect(assertRetainedVersionResponse(runtime,multiGrant,selections)).rejects.toThrow('source_reference_changed')}
   finally{await seed.query('INSERT INTO knowledge_evidence SELECT * FROM jsonb_populate_record(NULL::memory.knowledge_evidence,$1::jsonb)',[lostEvidence])}
   await seed.query('UPDATE knowledge_claims SET current_version_id=NULL WHERE claim_id=$1',[f.claim])
   try{await expect(assertRetainedVersionResponse(runtime,multiGrant,selections)).rejects.toThrow('source_reference_changed')}
   finally{await seed.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[f.claim,f.version])}
   await seed.query("UPDATE knowledge_claims SET state='revoked' WHERE claim_id=$1",[f.claim])
   try{await expect((assertRetainedVersionResponse as any)(runtime,multiGrant,selections,{requireCurrent:false})).rejects.toThrow('source_reference_changed')}
   finally{await seed.query("UPDATE knowledge_claims SET state='active' WHERE claim_id=$1",[f.claim])}

   await seed.query("UPDATE knowledge_versions SET valid_until=clock_timestamp()-interval '1 second' WHERE version_id=$1",[f.version])
   try{await expect(assertRetainedVersionResponse(runtime,multiGrant,selections)).rejects.toThrow('source_reference_changed')}
   finally{await seed.query('UPDATE knowledge_versions SET valid_until=NULL WHERE version_id=$1',[f.version])}
   await seed.query("UPDATE knowledge_versions SET statement='changed after search' WHERE version_id=$1",[f.version])
   try{await expect(assertRetainedVersionResponse(runtime,multiGrant,selections)).rejects.toThrow('source_reference_changed')}
   finally{await seed.query("UPDATE knowledge_versions SET statement='Transactional fixture invariant' WHERE version_id=$1",[f.version])}


   const review=createReviewService(runtime,{} as never),reviewInput={installationId:f.personal,authorityGrant:input.scopeGrant}
   expect((await review.reviewQueuePage(reviewInput as any)).candidates[0].evidence[0].excerpt).toBe(reviewText)
   const {default:Fastify}=await import('fastify'),{registerReadRoutes}=await import('../../api/read-routes.js'),{registerMcpRoute}=await import('../../mcp/server.js'),{createCorsHostPolicy}=await import('../../auth/cors-host-policy.js')
   const verifiedGrant={...input.scopeGrant,primaryInstallationId:f.personal,installationId:f.personal,version:'v2',services:['memory.search','memory.recall'],callerType:'web'}
   const routeDeps={pool:runtime,guard:{guard:async()=>verifiedGrant,guardV2:async()=>verifiedGrant,guardMcp:async()=>verifiedGrant} as never,
    policy:createCorsHostPolicy({allowedHosts:['localhost'],allowedOrigins:[],isProduction:false}),sharedScopesEnabled:true,recallEmbeddingTimeoutMs:100,cursorSigningKey:'read-probe'}
   const api=Fastify(),mcp=Fastify();readApps.push(api,mcp);registerReadRoutes(api,routeDeps);registerMcpRoute(mcp,{...routeDeps,providerVersion:'synthetic-source-fence'})
   const transportProbe=async(available:boolean)=>{
    for(const route of ['search','recall'])for(const scoped of [false,true]){
     const body={query:'transactional fixture',...(scoped?{scope_installation_ids:[f.personal]}:{})}
     const rest=await api.inject({method:'POST',url:'/api/v1/memory/'+route,headers:{authorization:'Bearer verified-fixture'},payload:body})
     expect(rest.statusCode,rest.body).toBe(200);expect(rest.body.includes('Transactional fixture invariant')).toBe(available)
     const rpc=await mcp.inject({method:'POST',url:'/mcp',headers:{authorization:'Bearer verified-fixture','content-type':'application/json'},payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'memory_'+route,arguments:body}}})
     expect(rpc.statusCode,rpc.body).toBe(200);expect(rpc.body.includes('Transactional fixture invariant')).toBe(available)
    }
    const listed=await api.inject({url:'/api/v1/memory/claims',headers:{authorization:'Bearer verified-fixture'}})
    expect(listed.statusCode,listed.body).toBe(200);expect(listed.body.includes('Transactional fixture invariant')).toBe(available)
    const detail=await api.inject({url:'/api/v1/memory/claims/'+f.claim,headers:{authorization:'Bearer verified-fixture'}})
    expect(detail.statusCode,detail.body).toBe(available?200:404);expect(detail.body.includes('Transactional fixture invariant')).toBe(available)
   }
   await transportProbe(true)
   await pool.query("INSERT INTO public.deleted_sessions VALUES('session')")
   try{
    await transportProbe(false)
    const after={listed:(await ordinaryEvidence.listActiveClaims(f.personal,{authorityGrant:input.scopeGrant} as any)).claims,detail:await ordinaryEvidence.getClaim(f.personal,f.claim,{authorityGrant:input.scopeGrant} as any),searched:(await search.search(searchInput)).hits,recalled:(await recall.recall(searchInput)).claims}
    expect(after).toEqual({listed:[],detail:null,searched:[],recalled:[]})
    await expect(assertRetainedVersionResponse(runtime,multiGrant,selections)).rejects.toThrow('source_reference_changed')
    expect((await review.reviewQueuePage(reviewInput as any)).candidates).toEqual([]);expect(await service.evidenceForVersion({installationId:f.personal,versionId:f.version,authorityGrant:input.scopeGrant} as any)).toEqual([]);expect(await ordinaryEvidence.getEvidence(f.personal,f.evidence,input.scopeGrant)).toBeNull()
    const {createClaimRepository}=await import('../../claims/repository.js')
    expect(await createClaimRepository(runtime).acceptCandidate({installationId:f.personal,candidateId:reviewCandidate,expectedRevision:1})).toMatchObject({ok:false,error:{code:'candidate_evidence_stale'}})
   }
   finally{await pool.query("DELETE FROM public.deleted_sessions WHERE session_id='session'")}
   const read=await service.readBound({...input,versionId:f.version,excerptHash:summary!.reference.excerpt_hash,sourceHash:summary!.reference.source_hash!,sourceVersion:event})
   expect(read!.content).toBe(payload.text);expect(JSON.stringify(read)).not.toContain('wrong raw fallback')
   await pool.query('UPDATE public.extension_installations SET granted_scopes=ARRAY[]::text[] WHERE installation_id=$1',[f.personal])
   try{
    const excerptOnly=await service.summary(input) as {source_available:boolean;excerpt:string;reference:{source_hash:string|null}}|null
    expect(excerptOnly?.excerpt).toBe('The fixture verifies transaction boundaries.');expect(excerptOnly?.source_available).toBe(false);expect(excerptOnly?.reference.source_hash).toBeNull()
   }finally{await pool.query("UPDATE public.extension_installations SET granted_scopes=ARRAY['session:events:read'] WHERE installation_id=$1",[f.personal])}
   const {randomUUID:shadowId}=await import('node:crypto'),{shadowReviewQueue}=await import('../../claims/shadow-review.js')
   const parent=shadowId(),child=shadowId(),run=shadowId(),candidate=shadowId(),digest=Buffer.alloc(32,8)
   await seed.query("INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark) VALUES($1,$2,'session','source:turn-1',$3,1)",[f.personal,parent,digest])
   await seed.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark,bundle_kind,parent_bundle_id,parent_revision,spans)
    VALUES($1,$2::uuid,'session',$2::text,$3,1,'task',$4,1,$5)`,[f.personal,child,digest,parent,JSON.stringify([{event_id:event,start:0,end:7}])])
   await seed.query("INSERT INTO memory_task_bundle_sources(installation_id,bundle_id,source_event_id,source_digest,source_sequence) VALUES($1,$2,$3,$4,1)",[f.personal,child,event,canonicalPayloadHash(payload)])
   await seed.query(`INSERT INTO memory_curation_runs(installation_id,run_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state)
    VALUES($1,$2,$3,1,$4,1,$5,$5,'shadow','completed')`,[f.personal,run,child,digest,'a'.repeat(64)])
   await seed.query(`INSERT INTO memory_candidates(candidate_id,installation_id,ordinal,claim_type,statement,structured_content,normalized_key,scope_kind,scope_key,confidence,freshness_at,status,source_kind,bundle_id,curation_run_id,bundle_revision)
    VALUES($1::uuid,$2,0,'work_method','shadow statement','{}',$1::text,'installation','global',1,now(),'shadow','task_bundle',$3,$4,1)`,[candidate,f.personal,child,run])
   const shadowInput={installationId:f.personal,authorityGrant:{installationId:f.personal,configVersion:'1'}}
   const queue=await shadowReviewQueue(runtime,shadowInput)
   expect(queue.candidates[0].evidence_state).toBe('available');expect(queue.candidates[0].evidence[0].excerpt).toBe('private')
   const {bindSourcePool:bindShadow,sourcePoolContext:shadowContext}=await import('../../sources/pool-context.js')
   let reached=0,parallelReading=true,releaseBarrier!:()=>void
   const barrier=new Promise<void>(resolve=>{releaseBarrier=resolve}),parallelPool=Object.create(runtime)
   parallelPool.query=runtime.query.bind(runtime)
   parallelPool.connect=async()=>{
    const client=await runtime.connect(),originalQuery=client.query,release=client.release,query=client.query.bind(client)
    client.release=((...args:any[])=>{client.query=originalQuery;client.release=release;return (release as any)(...args)}) as any
    client.query=(async(sql:any,...args:any[])=>{
     const result=await (query as any)(sql,...args)
     if(parallelReading&&typeof sql==='string'&&sql.includes("pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'")){
      reached++;if(reached===2)releaseBarrier();await barrier
     }
     return result
    }) as any
    return client
   }
   bindShadow(parallelPool,shadowContext(runtime))
   let simultaneous
   try{simultaneous=await Promise.all([shadowReviewQueue(parallelPool,shadowInput),shadowReviewQueue(parallelPool,shadowInput)])}finally{parallelReading=false;releaseBarrier()}
   expect(simultaneous.map(q=>q.candidates[0]?.evidence_state)).toEqual(['available','available'])
   await pool.query('UPDATE public.extension_installations SET config_version=2 WHERE installation_id=$1',[f.personal])
   expect((await shadowReviewQueue(runtime,shadowInput)).total_count).toBe(0)
   await pool.query('UPDATE public.extension_installations SET config_version=1 WHERE installation_id=$1',[f.personal])

   const {createPackRepository}=await import('../../context/pack-repository.js'),{randomUUID}=await import('node:crypto')
   const packInput:import('../../context/pack-repository.js').PersistPackInput={authorityGrant:input.scopeGrant,installationId:f.personal,generationRunId:null,trajectoryId:null,sessionId:'shared-evidence-pack',clientRequestId:randomUUID(),agent:'codex',repositoryId:null,mode:'enabled',
    effectivePolicyHash:Buffer.alloc(32,1),settingsFingerprint:Buffer.alloc(32,2),loadoutFingerprint:Buffer.alloc(32,3),inputDigest:Buffer.alloc(32,4),policyRevision:1,settingsRevision:1,loadoutRevision:1,state:'ready',
    items:[{itemId:randomUUID(),claimId:f.claim,versionId:f.version,claimType:'test_invariant',layer:'L2',section:'stable',representation:'on_demand',statement:'Transaction boundaries',scopeKind:'installation',reasonCodes:['selected'],evidenceIds:[f.evidence]}]}
   const packs=createPackRepository(runtime),packId=await packs.persist(packInput)
   expect((await seed.query('SELECT source_hash FROM memory_context_pack_evidence WHERE pack_id=$1',[packId])).rows[0].source_hash).toBe(summary!.reference.source_hash)
   const {createIdempotencyStore}=await import('../../api/idempotency.js'),{createTransactionBoundPool}=await import('../../api/transaction-bound-pool.js')
   let nestedAttempts=0
   const nestedInput={...packInput,clientRequestId:randomUUID(),inputDigest:Buffer.alloc(32,6)}
   const nested=await createIdempotencyStore(runtime).execute({installationId:f.personal,operation:'shared-context-proof',key:'nested',requestCanonical:'{}',run:async client=>{
    nestedAttempts++
    const id=await createPackRepository(createTransactionBoundPool(client)).persist(nestedInput)
    return {ok:true,metadata:{packId:id}}
   }})
   expect(nested.kind).toBe('completed');expect(nestedAttempts).toBe(2)
   if(nested.kind!=='completed')throw Error('nested_context_failed')
   expect((await seed.query('SELECT source_hash FROM memory_context_pack_evidence WHERE pack_id=$1',[nested.metadata.packId])).rows[0].source_hash).toBe(summary!.reference.source_hash)
   let rejectedPack:string|undefined
   try{
    await expect(createIdempotencyStore(runtime).execute({installationId:f.personal,operation:'shared-context-proof',key:'stale',requestCanonical:'{}',run:async client=>{
     rejectedPack=await createPackRepository(createTransactionBoundPool(client)).persist({...packInput,clientRequestId:randomUUID(),inputDigest:Buffer.alloc(32,7)})
     return {ok:true,metadata:{packId:rejectedPack}}
    },beforeCommit:async()=>{await pool.query('UPDATE shared.memory_source_modes SET generation=generation+1 WHERE installation_id=$1',[f.personal])}})).rejects.toThrow('source_reference_changed')
    expect((await seed.query('SELECT count(*)::text AS n FROM memory_context_packs WHERE pack_id=$1',[rejectedPack])).rows[0].n).toBe('0')
    expect((await seed.query("SELECT count(*)::text AS n FROM memory_idempotency_keys WHERE installation_id=$1 AND operation='shared-context-proof'",[f.personal])).rows[0].n).toBe('1')
   }finally{await pool.query('UPDATE shared.memory_source_modes SET generation=generation-1 WHERE installation_id=$1',[f.personal])}

   await seed.query(`INSERT INTO memory_source_retention_receipts(installation_id,turn_id,session_id,episode_id,source_digest,compiler_version,extraction_completed_at,state,finished_at)
    VALUES($1,'turn-1','session',gen_random_uuid(),decode(repeat('ab',32),'hex'),'fixture',now(),'reclaimed',now())`,[f.personal])
   const retained=await service.summary(input) as {reference:{source_hash:string|null};source_available:boolean;excerpt:string}|null
   expect(retained).toBeTruthy();expect(retained!.reference.source_hash).toBeNull();expect(retained!.source_available).toBe(false)
   expect(retained!.excerpt).toBe('The fixture verifies transaction boundaries.')
   const personalInput={installationId:f.personal,evidenceId:f.evidence,configVersion:'1'}
   expect(await service.summary(personalInput)).toBeTruthy()
   await pool.query('UPDATE public.extension_installations SET config_version=2 WHERE installation_id=$1',[f.personal])
   expect(await service.summary(personalInput)).toBeNull()
   await pool.query('UPDATE public.extension_installations SET config_version=1,granted_scopes=ARRAY[]::text[] WHERE installation_id=$1',[f.personal])
   // Stopping raw collection preserves already retained knowledge access.
   expect(await service.summary(personalInput)).toBeTruthy()
   await expect(createPostgresSharedSourceReader(runtime).listHeads({...scope,installationId:f.personal,ownerScopeId:f.personal},root)).rejects.toMatchObject({code:'revoked'})
   await pool.query("UPDATE public.extension_installations SET granted_scopes=ARRAY['session:events:read'] WHERE installation_id=$1",[f.personal])
   const {requireCurrentScopePermission,assertCurrentGrantClock}=await import('../../governance/authorization.js')
   await pool.query("UPDATE public.extension_teams SET state='dissolving' WHERE team_id=$1",[f.team])
   const disposition=await runtime.connect()
   try{
    await disposition.query('BEGIN')
    await expect(requireCurrentScopePermission({client:disposition,grant:input.scopeGrant,targetInstallationId:f.personal,permission:'read'})).rejects.toThrow('scope authority is stale')
    await disposition.query('ROLLBACK');await disposition.query('BEGIN')
    await requireCurrentScopePermission({client:disposition,grant:input.scopeGrant,targetInstallationId:f.personal,permission:'read',allowedPrimarySharedStates:['active','dissolving']})
    await assertCurrentGrantClock(disposition,input.scopeGrant,[f.personal],{allowedPrimarySharedStates:['active','dissolving']})
    await disposition.query('COMMIT')
   }finally{await disposition.query('ROLLBACK');disposition.release();await pool.query("UPDATE public.extension_teams SET state='active' WHERE team_id=$1",[f.team])}
   await pool.query('UPDATE public.extension_scope_memberships SET user_id=2 WHERE membership_id=$1',[f.publisher])
   try{expect(await service.summary(input)).toBeNull()}finally{await pool.query('UPDATE public.extension_scope_memberships SET user_id=1 WHERE membership_id=$1',[f.publisher])}
   await pool.query("UPDATE public.extension_scope_memberships SET state='revoked' WHERE membership_id=$1",[f.publisher])
   expect((await seed.query('SELECT state FROM memory_scope_memberships WHERE membership_id=$1',[f.publisher])).rows[0].state).toBe('active')
   expect(await service.summary(input)).toBeNull()
   const count=(await seed.query('SELECT count(*)::text n FROM memory_context_packs WHERE installation_id=$1',[f.personal])).rows[0].n
   await expect(packs.persist({...packInput,clientRequestId:randomUUID(),inputDigest:Buffer.alloc(32,5)})).rejects.toThrow('context_consumption_changed')
   expect((await seed.query('SELECT count(*)::text n FROM memory_context_packs WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(count)

   await pool.query("UPDATE public.extension_providers SET status='disabled'")
   try{expect(await service.summary(personalInput)).toBeNull()}finally{await pool.query("UPDATE public.extension_providers SET status='enabled'")}




  }finally{for(const app of readApps)await app.close();await seed.end()}
 })

 test('Context repository fallback resolves canonical observations instead of compatibility body',async()=>{
  const {randomUUID}=await import('node:crypto'),{createScopeResolver}=await import('../../context/scope-resolver.js'),{bindSourcePool,sourcePoolContext}=await import('../../sources/pool-context.js')
  const canonicalRepo=randomUUID(),wrongRepo=randomUUID(),source=randomUUID(),id='9007199254741200',payload={repository_id:'canonical-repo',text:'canonical repository observation'}
  await pool.query("INSERT INTO memory.repositories(repository_id,installation_id,repository_key,first_observed_at,last_observed_at) VALUES($1,$3,'canonical-repo',now(),now()),($2,$3,'wrong-repo',now(),now())",[canonicalRepo,wrongRepo,inst])
  await pool.query("INSERT INTO public.events(id,user_id,session_id,event_type,payload,effect_status,body_storage) VALUES($1,1,'session','session_discovered',$2,'completed','hot')",[id,payload])
  await pool.query(`INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash,classification,source_kind,canonical_key,canonical_session_key,source_version,content_hash,hash_version,mapping_state,adapter_version)
   VALUES($1,$2,'feed','scope-canonical','session','session_discovered',now()+interval '1 minute','{"repository_id":"wrong-repo"}',$3,'{}','relay_event',$4,'session','{"content":"1","authorization":"1","storage":"0"}',$3,'canonical-json-sha256-v1','verified','v1')`,[source,inst,canonicalPayloadHash(payload),id])
  bindSourcePool(runtime,{...sourcePoolContext(runtime),archive:{storage,limits}})
  expect((await createScopeResolver(runtime).resolve({installationId:inst,sessionId:'session'})).repositoryId).toBe(canonicalRepo)
 })

 test('shared compilation preserves legacy packet bytes, source UUIDs and digest across non-UUID event order and artifacts',async()=>{
  const {randomUUID}=await import('node:crypto'),{createEpisodeRepository}=await import('../../episodes/repository.js'),{bindSourcePool}=await import('../../sources/pool-context.js')
  const installation=randomUUID(),artifact=randomUUID(),seed=createMemoryPool({databaseUrl:url!,databaseNamespace:'memory',dbPoolMax:2})
  try{
   await pool.query("INSERT INTO public.sessions VALUES('packet-order',1,'daemon','codex','hot','codex')")
   await pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,authorization_epoch,config_version,granted_scopes,enabled_services,event_filter) VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}')",[installation])
   await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installation])
   await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-active',2)",[installation])
   await pool.query("SELECT shared.mark_memory_source_dirty('relay_event','1:packet-order')")
   await seed.query("INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'packet-order',now(),now())",[installation])
   await seed.query("INSERT INTO source_turns(installation_id,turn_id,session_id,state,started_at,terminal_at,event_count) VALUES($1,'packet-turn','packet-order','completed','2026-10-01T00:00:00Z','2026-10-01T00:00:10Z',3)",[installation])
   const events=[
    {id:'90000000-0000-0000-0000-000000000309',canonical:'9007199254741301',type:'user_text',at:'2026-10-01T00:00:01Z',body:{text:'Preserve the packet transaction boundary.',turn_id:'packet-turn'}},
    {id:'90000000-0000-0000-0000-000000000305',canonical:'9007199254741302',type:'tool_result',at:'2026-10-01T00:00:02Z',body:{text:'Canonical tool result.',turn_id:'packet-turn',call_id:'packet-call',tool:'bash',status:'passed'}},
    {id:'90000000-0000-0000-0000-000000000301',canonical:'9007199254741303',type:'agent_text',at:'2026-10-01T00:00:03Z',body:{text:'The transaction boundary is preserved.',turn_id:'packet-turn'}},
   ]
   for(const e of events){
    await pool.query("INSERT INTO public.events(id,user_id,session_id,event_type,payload,effect_status,body_storage) VALUES($1,1,'packet-order',$2,$3,'completed','hot')",[e.canonical,e.type,e.body])
    await seed.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,classification,
     source_kind,canonical_key,canonical_session_key,source_version,content_hash,hash_version,mapping_state,adapter_version)
     VALUES($1::uuid,$2,'feed',$1::text,'packet-order','packet-turn',$3,$4,$5,$6,'{}','relay_event',$7,'packet-order','{"content":"1","authorization":"1","storage":"0"}',$6,'canonical-json-sha256-v1','verified','v1')`,[e.id,installation,e.type,e.at,e.body,canonicalPayloadHash(e.body),e.canonical])
   }
   await seed.query(`INSERT INTO source_artifacts(artifact_id,installation_id,session_id,turn_id,source_event_id,artifact_type,identity_key,call_id,status,details,occurred_at)
    VALUES($1,$2,'packet-order','packet-turn',$3,'tool_result','packet-call','packet-call','passed','{"tool":"bash"}','2026-10-01T00:00:02Z')`,[artifact,installation,events[1].id])
   // Same isolated Memory schema, explicitly execute the untouched legacy read branch.
   bindSourcePool(seed,{namespace:'public'})
   await createEpisodeRepository(seed,{stabilizationMs:0}).compileTurn(installation,'packet-turn')
   const packet=async()=>(await seed.query("SELECT document,evidence_manifest,encode(source_digest,'hex') AS digest FROM work_episodes WHERE installation_id=$1 AND turn_id='packet-turn'",[installation])).rows[0]
   const before=await packet(),jobs=(await seed.query('SELECT count(*)::text n FROM memory_jobs WHERE installation_id=$1',[installation])).rows[0].n
   expect(before).toBeDefined()
   await seed.query('UPDATE source_events SET payload=$2 WHERE installation_id=$1',[installation,{text:'wrong compatibility body'}])
   await seed.query('UPDATE source_artifacts SET details=$2 WHERE installation_id=$1',[installation,{tool:'wrong tool copy'}])
   await createEpisodeRepository(runtime,{stabilizationMs:0}).compileTurn(installation,'packet-turn')
   expect(await packet()).toEqual(before)
   expect((await seed.query('SELECT count(*)::text n FROM memory_jobs WHERE installation_id=$1',[installation])).rows[0].n).toBe(jobs)
   expect((await seed.query('SELECT source_event_id::text FROM source_events WHERE installation_id=$1 ORDER BY source_event_id',[installation])).rows.map(r=>r.source_event_id)).toEqual(events.map(e=>e.id).sort())
  }finally{await seed.end()}
 })

 test('retained consumer guards use metadata only and reject revoke/mode changes before the final boundary',async()=>{
  const {guardRetainedEvidence,assertRetainedSourceGuards}=await import('../../sources/retained-authority.js')
  const sourceId='90000000-0000-0000-0000-000000000003'
  await pool.query('UPDATE memory.source_events SET body_reclaimed_at=NOW() WHERE source_event_id=$1',[sourceId])
  const client=await runtime.connect(),query=client.query.bind(client),sql:string[]=[]
  client.query=(async(text:any,...args:any[])=>{if(typeof text==='string')sql.push(text);return (query as any)(text,...args)}) as any
  try{
   await client.query('BEGIN')
   await guardRetainedEvidence(client,inst,[{source_event_id:sourceId,artifact_id:null},{source_event_id:'90000000-0000-0000-0000-000000000005',artifact_id:null}])
   await assertRetainedSourceGuards(client)
   expect(sql.filter(statement=>statement.includes('shared.memory_retained_relay_authority')).length).toBe(3)
   expect(sql.join(' ')).not.toMatch(/read_memory_relay_sources|read_memory_relay_archive|\bpayload\b|\bdetails\b/)
   const writer=await pool.connect()
   try{
    await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='50ms'")
    await expect(writer.query("UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",[inst])).rejects.toMatchObject({code:'55P03'})
   }finally{await writer.query('ROLLBACK');writer.release()}
   await client.query('ROLLBACK')
   // A new request observes revocation that wins before its final barrier.
   const {detachRetainedSourceGuards}=await import('../../sources/retained-authority.js');detachRetainedSourceGuards(client)
   await client.query('BEGIN');await guardRetainedEvidence(client,inst,[{source_event_id:sourceId,artifact_id:null}])
   await pool.query("UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",[inst])
   await expect(assertRetainedSourceGuards(client)).rejects.toThrow('source_reference_changed')
   await client.query('ROLLBACK')
   await pool.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=$1",[inst])
  }finally{client.query=query;await client.query('ROLLBACK');client.release();await pool.query('UPDATE memory.source_events SET body_reclaimed_at=NULL WHERE source_event_id=$1',[sourceId])}
  // Reacquiring a connection clears the previous request's observations.
  const next=await runtime.connect()
  try{
   await assertRetainedSourceGuards(next)
   await next.query('BEGIN')
   const {createTransactionBoundPool}=await import('../../api/transaction-bound-pool.js')
   const bound=createTransactionBoundPool(next),inner=await bound.connect()
   await inner.query('BEGIN')
   await guardRetainedEvidence(inner,inst,[{source_event_id:sourceId,artifact_id:null}])
   await inner.query('COMMIT')
   inner.release()
   await pool.query('UPDATE shared.memory_source_modes SET generation=generation+1 WHERE installation_id=$1',[inst])
   await expect(assertRetainedSourceGuards(next)).rejects.toThrow('source_reference_changed')
   await next.query('ROLLBACK')
   await pool.query('UPDATE shared.memory_source_modes SET generation=generation-1 WHERE installation_id=$1',[inst])
  }finally{await next.query('ROLLBACK');next.release()}
 })

 test('episode-only retained evidence follows explicit manifest UUIDs and cannot bypass current Relay revocation',async()=>{
  const {guardRetainedEvidence}=await import('../../sources/retained-authority.js')
  const episode=(await pool.query("SELECT episode_id::text FROM memory.work_episodes WHERE installation_id=$1 AND turn_id='turn-1'",[inst])).rows[0].episode_id
  const client=await runtime.connect()
  try{
   await client.query('BEGIN')
   await pool.query("UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",[inst])
   await expect(guardRetainedEvidence(client,inst,[{source_event_id:null,artifact_id:null,episode_id:episode,evidence_kind:'episode'}] as any)).rejects.toThrow()
  }finally{await client.query('ROLLBACK');client.release();await pool.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=$1",[inst])}
 })

 test('idempotent nested source preparation rolls back and releases locks before cold IO, then commits once',async()=>{
  const {createIdempotencyStore}=await import('../../api/idempotency.js')
  const {createTransactionBoundPool}=await import('../../api/transaction-bound-pool.js')
  const {prepareSourceReferences}=await import('../../sources/prepared-sources.js')
  const {bindSourcePool,sourcePoolContext}=await import('../../sources/pool-context.js')
  const prior=sourcePoolContext(runtime);let reads=0,attempts=0,revokeDuringIO=false
  bindSourcePool(runtime,{...prior,archive:{limits,storage:{namespace:storage.namespace,read:async key=>{
   reads++
   expect((await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n).toBe(0)
   if(revokeDuringIO)await pool.query("UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",[inst])
   return storage.read(key)
  }}}})
  const job='90000000-0000-0000-0000-000000000097',source='90000000-0000-0000-0000-000000000005'
  const input={installationId:inst,operation:'shared-nested-io',key:'one',requestCanonical:'{}',run:async(client:pg.PoolClient)=>{
   attempts++
   await client.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload)
    VALUES($1,$2,'compile_episode','deferred-source-probe',70,'{}')`,[job,inst])
   const bound=createTransactionBoundPool(client),prepared=await prepareSourceReferences(bound,inst,[source])
   const nested=await bound.connect()
   try{await nested.query('BEGIN');await prepared.assertCurrent(nested);await nested.query('COMMIT')}finally{nested.release()}
   expect(prepared.events[0].payload.text).toBe('private cold one')
   return {ok:true as const,metadata:{jobId:job}}
  }}
  try{
   const store=createIdempotencyStore(runtime)
   expect(await store.execute(input)).toMatchObject({kind:'completed'})
   expect(attempts).toBe(2);expect(reads).toBe(1)
   expect((await runtime.query('SELECT count(*)::text AS n FROM memory_jobs WHERE job_id=$1',[job])).rows[0].n).toBe('1')
   expect(await store.execute(input)).toMatchObject({kind:'replayed'})
   expect(attempts).toBe(2);expect(reads).toBe(1)
   await runtime.query('DELETE FROM memory_jobs WHERE job_id=$1',[job])
   revokeDuringIO=true
   await expect(store.execute({...input,key:'revoke-during-io'})).rejects.toMatchObject({name:'SourceUnavailableError'})
   expect((await runtime.query('SELECT count(*)::text AS n FROM memory_jobs WHERE job_id=$1',[job])).rows[0].n).toBe('0')
   expect((await runtime.query("SELECT count(*)::text AS n FROM memory_idempotency_keys WHERE installation_id=$1 AND operation='shared-nested-io'",[inst])).rows[0].n).toBe('1')
  }finally{bindSourcePool(runtime,prior);await pool.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=$1",[inst]);await runtime.query('DELETE FROM memory_jobs WHERE job_id=$1',[job])}
 })

 test('shared Skill admission consumes retained canonical evidence, deduplicates and rejects a new schedule after Relay deletion',async()=>{
  const {randomUUID,createHash}=await import('node:crypto'),{createSkillAdmissionService}=await import('../../skills/admission-service.js'),{loadSkillConfig}=await import('../../skills/config.js')
  const installation=randomUUID(),repository=randomUUID(),snapshot=randomUUID(),episode=randomUUID(),source=randomUUID(),session='skill-'+randomUUID(),id='9007199254741400'
  const seed=createMemoryPool({databaseUrl:url!,databaseNamespace:'memory',dbPoolMax:2}),excerpt='tests passed',body={text:excerpt,turn_id:episode},hash=createHash('sha256').update(excerpt).digest('hex').slice(0,16)
  try{
   await pool.query("INSERT INTO public.sessions VALUES($1,1,'daemon','codex','hot','codex')",[session])
   await pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,authorization_epoch,config_version,granted_scopes,enabled_services,event_filter) VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}')",[installation])
   await pool.query("INSERT INTO public.events(id,user_id,session_id,event_type,payload,effect_status,body_storage) VALUES($1,1,$2,'tool_result',$3,'completed','hot')",[id,session,body])
   await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-active',2)",[installation])
   await pool.query("SELECT shared.mark_memory_source_dirty('relay_event',$1)",['1:'+session])
   await seed.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installation])
   await seed.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)",[installation])
   await seed.query('INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,now(),now())',[installation,session])
   await seed.query('INSERT INTO repositories(installation_id,repository_id,repository_key,first_observed_at,last_observed_at) VALUES($1,$2,$2::uuid::text,now(),now())',[installation,repository])
   await seed.query("INSERT INTO repo_snapshots(installation_id,repo_snapshot_id,repository_id,commit_sha,observed_at) VALUES($1,$2,$3,$4,now())",[installation,snapshot,repository,'a'.repeat(40)])
   await seed.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,classification,
    source_kind,canonical_key,canonical_session_key,source_version,content_hash,hash_version,mapping_state,adapter_version)
    VALUES($1,$2,'feed','skill-original',$3,$4,'tool_result',now(),'{}',$5,'{}','relay_event',$6,$3,'{"content":"1","authorization":"1","storage":"0"}',$5,'canonical-json-sha256-v1','verified','v1')`,[source,installation,session,episode,canonicalPayloadHash(body),id])
   await seed.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,outcome,ready_at,compiler_version,repository_id,repo_snapshot_id,source_digest,document,evidence_manifest,document_compiler_version,compiled_at)
    VALUES($1,$2,$3,$2::uuid::text,'ready','completed',now()-interval '1 second','fixture',$4,$5,decode($6,'hex'),$7,$8,'v1',now())`,[installation,episode,session,repository,snapshot,'a'.repeat(64),{tests:[{status:'passed',text:excerpt,evidence_handle:'e1'}]},{e1:{kind:'episode',source_event_id:source,excerpt_hash:hash,excerpt_length:excerpt.length,truncated:false}}])
   const grant={primaryInstallationId:installation,configVersion:'1',userId:1,scopeBindings:[{installation_id:installation,owner_scope_kind:'personal',owner_scope_id:installation,membership_id:null,membership_revision:'0',authorization_epoch:'1',permissions:['read','contribute','review']}]} as import('../../governance/authorization.js').V2GrantFacts
   const service=createSkillAdmissionService({pool:runtime,context:{globalMode:'enabled',sharedMode:'shadow',config:loadSkillConfig({MEMORY_SKILL_MODE:'shadow'})}}),request={installationId:installation,grant,candidateKey:'shared-positive',source:{kind:'episode',episodeId:episode}}
   const admitted=await service.schedule(request)
   expect(admitted.deduplicated).toBe(false)
   expect(await service.schedule(request)).toMatchObject({taskId:admitted.taskId,runId:admitted.runId,deduplicated:true})
   const {scheduleExtractionRetry}=await import('../../extraction/recovery.js'),{recoverRuntime}=await import('../../maintenance/recover-runtime.js')
   const retryRun=randomUUID(),unknownRun=randomUUID()
   await seed.query("INSERT INTO memory_feature_settings(installation_id,extraction_mode,extraction_consent_fingerprint) VALUES($1,'shadow','fixture-consent')",[installation])
   const failure=async(run:string,state:string,code:string,version:string,age:string)=>seed.query(`INSERT INTO memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model,error_code,started_at,completed_at)
    VALUES($1,$2,$3,decode(repeat('a',64),'hex'),$4,'v1','x'::bytea,'x'::bytea,'shadow',$5,'fixture','fixture',$6,now()-$7::interval,now()-$7::interval)`,[run,installation,episode,version,state,code,age])
   await failure(retryRun,'quarantined','invalid_output:fixture','v1','10 minutes')
   const retry=async()=>{const client=await runtime.connect();try{await client.query('BEGIN');const result=await scheduleExtractionRetry(client,{installationId:installation,runId:retryRun,consentFingerprint:'fixture-consent'});await client.query('COMMIT');return result}catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}}
   expect(await retry()).toMatchObject({state:'pending'})
   await failure(unknownRun,'failed','provider_result_unknown','v2','5 minutes')
   expect(await recoverRuntime(runtime,{installationId:installation,failedRunIds:[unknownRun],apply:false})).toMatchObject({applied:false,scheduledEpisodes:[episode]})
   const jobs=(await seed.query('SELECT count(*)::text n FROM memory_jobs WHERE installation_id=$1',[installation])).rows[0].n
   await pool.query('INSERT INTO public.deleted_sessions VALUES($1)',[session])
   await expect(retry()).rejects.toThrow('extraction source unavailable')
   await expect(recoverRuntime(runtime,{installationId:installation,failedRunIds:[unknownRun],apply:true})).rejects.toThrow('recovery_source_unavailable')
   await expect(service.schedule({...request,candidateKey:'after-delete'})).rejects.toThrow('skill_source_invalid')
   expect((await seed.query('SELECT count(*)::text n FROM memory_jobs WHERE installation_id=$1',[installation])).rows[0].n).toBe(jobs)
   expect((await seed.query("SELECT 1 FROM memory_skill_tasks WHERE installation_id=$1 AND candidate_key='after-delete'",[installation])).rowCount).toBe(0)
  }finally{await seed.end()}
 })

 test('personal commit fence holds root, current control and Session identity until commit without granting public or shared row access',async()=>{
  const reader=createPostgresSharedSourceReader(runtime),current=await reader.checkAuthority(scope,root)
  expect(current.state).toBe('current')
  const c=await runtime.connect(),writer=await pool.connect()
  const lock=async(expected=current.version)=>(await c.query('SELECT shared.lock_memory_personal_source_commit($1::jsonb,$2,$3,$4::jsonb,true) AS locked',[JSON.stringify(scope),root.kind,root.key,JSON.stringify(expected)])).rows[0].locked
  try{
   await c.query('BEGIN');expect(await lock()).toBe(true)
   await expect(c.query('SELECT * FROM shared.memory_source_work FOR SHARE')).rejects.toMatchObject({code:'42501'})
   await c.query('ROLLBACK');await c.query('BEGIN');expect(await lock()).toBe(true)
   for(const sql of ["UPDATE shared.memory_source_work SET revision=revision+1 WHERE source_kind='relay_event' AND root_key='1:session'","UPDATE shared.memory_source_modes SET generation=generation+1 WHERE installation_id='10000000-0000-0000-0000-000000000003'","UPDATE public.extension_installations SET status='paused' WHERE installation_id='10000000-0000-0000-0000-000000000003'"]){
    await writer.query("BEGIN;SET LOCAL lock_timeout='50ms'")
    try{await expect(writer.query(sql)).rejects.toMatchObject({code:'55P03'})}finally{await writer.query('ROLLBACK')}
   }
   for(const sql of ["INSERT INTO memory.memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,'session','privacy',now())", "UPDATE memory.memory_installations SET local_status='purging' WHERE installation_id=$1"]){
    await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='50ms'")
    try{await expect(writer.query(sql,[inst])).rejects.toMatchObject({code:'55P03'})}finally{await writer.query('ROLLBACK')}
   }
   await writer.query('BEGIN')
   expect((await writer.query("SELECT pg_try_advisory_xact_lock(1885566061,hashtext('session')) AS locked")).rows[0].locked).toBe(false)
   expect((await writer.query("SELECT pg_try_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0)) AS locked",[inst])).rows[0].locked).toBe(false)
   await writer.query('ROLLBACK');await c.query('COMMIT')
   await writer.query('BEGIN');expect((await writer.query("SELECT pg_try_advisory_xact_lock(1885566061,hashtext('session')) AS locked")).rows[0].locked).toBe(true);await writer.query('ROLLBACK')
   await c.query('BEGIN');expect(await lock({...current.version,content:'999999'})).toBe(false)
   // A rejected check cannot leave partial owner/mode/Session locks behind.
   await writer.query("BEGIN;SET LOCAL lock_timeout='50ms'")
   await writer.query("UPDATE shared.memory_source_modes SET generation=generation WHERE installation_id=$1",[inst]);await writer.query('ROLLBACK')
   await writer.query('BEGIN');expect((await writer.query("SELECT pg_try_advisory_xact_lock(1885566061,hashtext('session')) AS locked")).rows[0].locked).toBe(true);await writer.query('ROLLBACK')
   await c.query('ROLLBACK')
   await writer.query('BEGIN');await writer.query("SELECT pg_advisory_xact_lock(1885566061,hashtext('session'))")
   await c.query('BEGIN');expect(await lock()).toBe(false);await c.query('ROLLBACK');await writer.query('ROLLBACK')
  }finally{await c.query('ROLLBACK');await writer.query('ROLLBACK');c.release();writer.release()}
 })

 test('canonical head metadata preserves native event timestamp precision for body-free refs',async()=>{
  await pool.query('ALTER TABLE public.events ADD COLUMN IF NOT EXISTS created_at timestamptz')
  const session='metadata-time',id='9007199254741244',native='2026-11-06T12:34:56.123456Z'
  await pool.query("INSERT INTO public.sessions VALUES($1,1,'daemon','codex','hot','codex')",[session])
  await pool.query("SELECT shared.mark_memory_source_dirty('relay_event',$1)",['1:'+session])
  await pool.query("INSERT INTO public.events(id,session_id,user_id,event_type,payload,effect_status,body_storage,created_at) VALUES($1,$2,1,'agent_text','{\"text\":\"new canonical source\"}','completed','hot',$3::timestamptz)",[id,session,native])
  const reader=createPostgresSharedSourceReader(runtime,{storage,limits}),page=await reader.getHeads(scope,{kind:'relay_event',key:'1:'+session},[id])
  expect((page.heads[0] as unknown as{occurredAt:string}).occurredAt).toBe('2026-11-06T12:34:56.123456+00:00')
  expect(JSON.stringify(page)).not.toContain('new canonical source')
 })
 test('canonical shadow records only comparisons, waits for explicit legacy links and preserves the active source',async()=>{
  const {createCanonicalProjectionHandler}=await import('../../sources/canonical-projection-worker.js')
  const {withSourceJobExecution}=await import('../../sources/source-execution.js')
  const {createSourceProjector}=await import('../../projection/source-projector.js')
  const session='metadata-time',target={kind:'relay_event' as const,key:'1:'+session},body={text:'new canonical source'},feed='991',legacyJob='70000000-0000-0000-0000-000000000098',shadowJob='70000000-0000-0000-0000-000000000099'
  await runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1) ON CONFLICT(installation_id) DO UPDATE SET relay_status='active',local_status='ready'",[inst])
  await runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1,$3,'project_feed','shadow-legacy-test',50,'running','shadow-test',1,clock_timestamp()+interval '5 minutes'),($2,$3,'project_shared_source','shadow-canonical-test',52,'running','shadow-test',1,clock_timestamp()+interval '5 minutes')",[legacyJob,shadowJob,inst])
  await runtime.query(`INSERT INTO memory_feed_inbox(installation_id,feed_id,envelope_version,topic,source_kind,source_id,session_id,event_type,recorded_at,data,payload_hash)
   VALUES($1,$2,1,'session.event.v1','canonical_event','event:9007199254741244',$3,'agent_text','2026-11-06T12:34:56.123Z',$4,$5)`,[inst,feed,session,body,canonicalPayloadHash(body)])
  const claim=(await runtime.query("SELECT source_kind,root_key,lease_token::text,claimed_revision::text FROM shared.claim_memory_source_work('shadow-distributor',30,128)")).rows.find(r=>r.source_kind===target.kind&&r.root_key===target.key)!
  let page:any=null
  for(let n=0;n<5;n++){page=(await runtime.query('SELECT shared.step_memory_source_distribution($1,$2,$3,$4,$5,$6,$7,64) AS page',[target.kind,target.key,claim.lease_token,'shadow-distributor',claim.claimed_revision,page?.scanId??null,page?.cursor??''])).rows[0].page;if(page.state==='sealed')break}
  const payload={scope,root:target,distribution_scan:page.scanId,target_cursor:inst}
  const handler=createCanonicalProjectionHandler(runtime,{pageSize:64,deferMs:0})
  let epoch=1
  const run=async()=>withSourceJobExecution(runtime,{jobId:shadowJob,claimedBy:'shadow-test',claimEpoch:epoch},()=>handler({job_id:shadowJob,installation_id:inst,job_type:'project_shared_source',payload} as any,new AbortController().signal),{branch:'canonical-shadow'})
  const progress=async()=>(await runtime.query('SELECT shared.read_memory_source_shadow_progress($1,$2,$3,$4,$5) AS progress',[inst,target.kind,target.key,page.scanId,canonicalPayloadHash(scope).toString('hex')])).rows[0].progress
  const budgetBefore=(await runtime.query('SELECT count(*)::text n FROM memory_provider_budget_reservations')).rows[0].n
  try{
   await expect(run()).rejects.toMatchObject({name:'JobDeferredError'})
   expect(await progress()).toMatchObject({state:'waiting',matched:'0',fullAcceptanceReady:false})
   await withSourceJobExecution(runtime,{jobId:legacyJob,claimedBy:'shadow-test',claimEpoch:1},()=>createSourceProjector(runtime).projectOnce(inst))
   const original=(await runtime.query("SELECT source_event_id::text,payload_hash,origin,payload FROM source_events WHERE installation_id=$1 AND origin='feed' AND origin_position=$2",[inst,feed])).rows[0]
   await run()
   expect(await progress()).toMatchObject({state:'body_identity_ready',matched:'1',different:'0',unproven:'0',unknownProvenance:'1',fullAcceptanceReady:false})
   expect((await runtime.query('SELECT source_event_id::text,payload_hash,origin,payload FROM source_events WHERE source_event_id=$1',[original.source_event_id])).rows[0]).toEqual(original)
   expect((await pool.query('SELECT 1 FROM shared.memory_source_progress WHERE installation_id=$1',[inst])).rowCount).toBe(0)
   expect((await runtime.query('SELECT count(*)::text n FROM memory_provider_budget_reservations')).rows[0].n).toBe(budgetBefore)
   await runtime.query("UPDATE source_events SET payload='{}' WHERE source_event_id=$1",[original.source_event_id])
   await runtime.query('UPDATE memory_jobs SET claim_epoch=2 WHERE job_id=$1',[shadowJob]);epoch=2
   await run()
   expect(await progress()).toMatchObject({state:'different',different:'1',fullAcceptanceReady:false})
   await pool.query("INSERT INTO public.events(id,session_id,user_id,event_type,payload,effect_status,body_storage,created_at) VALUES(9007199254741257,$1,1,'agent_text',$2,'completed','hot','2026-11-06T12:34:57.456789Z')",[session,{text:'second shadow source'}])
   await pool.query('SELECT shared.mark_memory_source_dirty($1,$2)',[target.kind,target.key])
   await runtime.query('SELECT shared.ack_memory_source_work($1,$2,$3,$4,$5)',[target.kind,target.key,claim.lease_token,'shadow-distributor',claim.claimed_revision])
   const nextClaim=(await runtime.query("SELECT source_kind,root_key,lease_token::text,claimed_revision::text FROM shared.claim_memory_source_work('shadow-distributor',30,128)")).rows.find(r=>r.source_kind===target.kind&&r.root_key===target.key)!
   page=null
   for(let n=0;n<5;n++){page=(await runtime.query('SELECT shared.step_memory_source_distribution($1,$2,$3,$4,$5,$6,$7,64) AS page',[target.kind,target.key,nextClaim.lease_token,'shadow-distributor',nextClaim.claimed_revision,page?.scanId??null,page?.cursor??''])).rows[0].page;if(page.state==='sealed')break}
   payload.distribution_scan=page.scanId
   await expect(run()).rejects.toMatchObject({name:'JobDeferredError'})
   expect(await progress()).toMatchObject({state:'waiting',unproven:'1',observedDifferent:'1'})
   const firstFindings=(await progress()).firstFindings
   await runtime.query('UPDATE source_events SET payload=$2 WHERE source_event_id=$1',[original.source_event_id,body])
   await expect(run()).rejects.toMatchObject({name:'JobDeferredError'})
   expect(await progress()).toMatchObject({state:'waiting',observedDifferent:'1',firstFindings})
   await runtime.query(`INSERT INTO memory_feed_inbox(installation_id,feed_id,envelope_version,topic,source_kind,source_id,session_id,event_type,recorded_at,data,payload_hash)
    VALUES($1,992,1,'session.event.v1','canonical_event','event:9007199254741257',$2,'agent_text','2026-11-06T12:34:57.456Z',$3,$4)`,[inst,session,{text:'second shadow source'},canonicalPayloadHash({text:'second shadow source'})])
   await withSourceJobExecution(runtime,{jobId:legacyJob,claimedBy:'shadow-test',claimEpoch:1},()=>createSourceProjector(runtime).projectOnce(inst))
   await run()
   expect(await progress()).toMatchObject({state:'body_identity_ready',matched:'2',different:'0',unproven:'0',observedDifferent:'1',firstFindings})
  }finally{
   await runtime.query("DELETE FROM source_events WHERE installation_id=$1 AND origin='feed' AND origin_position=ANY($2::text[])",[inst,[feed,'992']])
   await runtime.query('DELETE FROM memory_feed_inbox WHERE installation_id=$1 AND feed_id=ANY($2::bigint[])',[inst,[feed,'992']])
   await runtime.query('DELETE FROM source_sessions WHERE installation_id=$1 AND session_id=$2',[inst,session])
   await pool.query('DELETE FROM public.events WHERE id=9007199254741257')
  }
 })

 test('canonical references contain no body and resolve through the authority reader',async()=>{
  const id='9007199254741244',session='metadata-time',reader=createPostgresSharedSourceReader(runtime,{storage,limits})
  const page=await reader.getHeads(scope,{kind:'relay_event',key:'1:'+session},[id]),head=page.heads[0],source='60000000-0000-0000-0000-000000000091'
  await runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1) ON CONFLICT(installation_id) DO UPDATE SET relay_status='active',local_status='ready'",[inst])
  await runtime.query('INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,now(),now())',[inst,session])
  await runtime.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash,classification,source_provenance,
   source_kind,canonical_key,canonical_session_key,source_version,content_hash,hash_version,mapping_state,adapter_version)
   VALUES($1,$2,'canonical',$3,$4,'agent_text',$5::timestamptz,NULL,$6,$7::jsonb,$8::jsonb,'relay_event',$9,$4,$10::jsonb,$6,'canonical-json-sha256-v1','verified','canonical-ref-v1')`,
   [source,inst,'relay_event:'+id,session,head.occurredAt,Buffer.from(head.contentHash,'hex'),JSON.stringify(head.classification),JSON.stringify(head.provenance),id,JSON.stringify(page.version)])
  const {prepareSourceReferences}=await import('../../sources/prepared-sources.js')
  const prepared=await prepareSourceReferences(runtime,inst,[source])
  expect(prepared.events[0].payload).toEqual({text:'new canonical source'})
  expect((await runtime.query('SELECT payload,to_jsonb(s)->>\'occurred_at\' AS native_time FROM source_events s WHERE source_event_id=$1',[source])).rows).toEqual([{payload:null,native_time:'2026-11-06T12:34:56.123456+00:00'}])
  await expect(runtime.query("UPDATE source_events SET payload='{\"text\":\"copied body\"}' WHERE source_event_id=$1",[source])).rejects.toMatchObject({code:'23514'})
  await expect(runtime.query("UPDATE source_events SET mapping_state='unproven' WHERE source_event_id=$1",[source])).rejects.toMatchObject({code:'23514'})
  await expect(runtime.query("UPDATE source_events SET source_kind=NULL,mapping_state='revoked' WHERE source_event_id=$1",[source])).rejects.toMatchObject({code:'23514'})
 })
 test('the opaque page writer reuses proven UUIDs, stores only new metadata and rejects an old mode',async()=>{
  const {withSourceJobExecution}=await import('../../sources/source-execution.js')
  const {prepareCanonicalReferencePage,persistCanonicalReferencePage}=await import('../../sources/canonical-references.js')
  const old='60000000-0000-0000-0000-000000000091',job='70000000-0000-0000-0000-000000000091',session='metadata-time'
  await runtime.query("UPDATE source_events SET origin='feed',origin_position='mapped-feed-91',adapter_version='mapped-feed-v1',occurred_at=date_trunc('milliseconds',occurred_at),payload=$2::jsonb WHERE source_event_id=$1",[old,JSON.stringify({text:'new canonical source'})])
  await pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  await pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[inst])
  await runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1,$2,'project_shared_source','canonical-test-91',52,'running','canonical-test',1,clock_timestamp()+interval '5 minutes')",[job,inst])
  const target={kind:'relay_event' as const,key:'1:'+session},currentScope={...scope,modeGeneration:'3'}
  await withSourceJobExecution(runtime,{jobId:job,claimedBy:'canonical-test',claimEpoch:1},async()=>{
   const first=await prepareCanonicalReferencePage(runtime,currentScope,target,{keys:['9007199254741244']})
   expect(JSON.stringify(first)).not.toContain('new canonical source')
   expect(await persistCanonicalReferencePage(runtime,first)).toEqual([{sourceEventId:old,canonicalKey:'9007199254741244',sessionId:session,created:false}])
   expect((await runtime.query('SELECT origin,payload FROM source_events WHERE source_event_id=$1',[old])).rows).toEqual([{origin:'feed',payload:{text:'new canonical source'}}])
   expect((await runtime.query("SELECT to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS original_time FROM source_events WHERE source_event_id=$1",[old])).rows[0].original_time).toBe('2026-11-06 12:34:56.123000')
   await runtime.query("UPDATE source_events SET occurred_at=occurred_at+interval '1 second' WHERE source_event_id=$1",[old])
   try{await expect(persistCanonicalReferencePage(runtime,first)).rejects.toThrow('canonical_reference_conflict')}
   finally{await runtime.query("UPDATE source_events SET occurred_at=occurred_at-interval '1 second' WHERE source_event_id=$1",[old])}
   const key='9007199254741245',body={text:'fresh source stays canonical',turn_id:'canonical-turn-91'}
   await pool.query("INSERT INTO public.events(id,session_id,user_id,event_type,payload,effect_status,body_storage,created_at) VALUES($1,$2,1,'agent_text',$3,'completed','hot','2026-11-06T12:35:56.987654Z')",[key,session,body])
   await pool.query("SELECT shared.mark_memory_source_dirty('relay_event',$1)",[target.key])
   const next=await prepareCanonicalReferencePage(runtime,currentScope,target,{keys:[key]})
   const inserted=await persistCanonicalReferencePage(runtime,next)
   expect(inserted).toHaveLength(1);expect(inserted[0]).toMatchObject({canonicalKey:key,sessionId:session,created:true})
   expect((await runtime.query('SELECT payload,origin,turn_id,to_jsonb(s)->>\'occurred_at\' AS native_time FROM source_events s WHERE source_event_id=$1',[inserted[0].sourceEventId])).rows).toEqual([{payload:null,origin:'canonical',turn_id:'canonical-turn-91',native_time:'2026-11-06T12:35:56.987654+00:00'}])
   const reused=await persistCanonicalReferencePage(runtime,next);expect(reused[0]).toEqual({...inserted[0],created:false})
   await runtime.query("UPDATE source_events SET occurred_at=date_trunc('milliseconds',occurred_at) WHERE source_event_id=$1",[inserted[0].sourceEventId])
   try{await expect(persistCanonicalReferencePage(runtime,next)).rejects.toThrow('canonical_reference_conflict')}
   finally{await runtime.query("UPDATE source_events SET occurred_at='2026-11-06T12:35:56.987654Z'::timestamptz WHERE source_event_id=$1",[inserted[0].sourceEventId])}
   await expect(persistCanonicalReferencePage(runtime,{token:{},count:1,hasMore:false})).rejects.toThrow('canonical_reference_token_invalid')
   const stale=await prepareCanonicalReferencePage(runtime,currentScope,target,{keys:[key]})
   await pool.query("SELECT shared.transition_memory_source_mode($1,3,'paused')",[inst]);await pool.query("SELECT shared.transition_memory_source_mode($1,4,'shared-active')",[inst])
   await expect(persistCanonicalReferencePage(runtime,stale)).rejects.toThrow('source_execution_generation_changed')
  })
 })
 test('canonical pages block unresolved history and roll back a whole conflicting batch',async()=>{
  const {withSourceJobExecution}=await import('../../sources/source-execution.js')
  const {prepareCanonicalReferencePage,persistCanonicalReferencePage}=await import('../../sources/canonical-references.js')
  const job='70000000-0000-0000-0000-000000000091',old='60000000-0000-0000-0000-000000000091',unknown='60000000-0000-0000-0000-000000000092',session='metadata-time'
  await runtime.query("UPDATE memory_jobs SET claim_epoch=2,claim_expires_at=clock_timestamp()+interval '5 minutes' WHERE job_id=$1",[job])
  const currentScope={...scope,modeGeneration:'5'},target={kind:'relay_event' as const,key:'1:'+session}
  await withSourceJobExecution(runtime,{jobId:job,claimedBy:'canonical-test',claimEpoch:2},async()=>{
   await runtime.query("INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash) VALUES($1,$2,'feed','unknown-history-91',$3,'agent_text',now(),'{\"text\":\"unresolved\"}',$4)",[unknown,inst,session,canonicalPayloadHash({text:'unresolved'})])
   try{
    const blocked=await prepareCanonicalReferencePage(runtime,currentScope,target,{keys:['9007199254741244']})
    await expect(persistCanonicalReferencePage(runtime,blocked)).rejects.toThrow('canonical_reference_mapping_required')
   }finally{await runtime.query('DELETE FROM source_events WHERE source_event_id=$1',[unknown])}
   const stale=await prepareCanonicalReferencePage(runtime,currentScope,target,{keys:['9007199254741244']})
   await pool.query("SELECT shared.mark_memory_source_dirty('relay_event',$1)",[target.key])
   await expect(persistCanonicalReferencePage(runtime,stale)).rejects.toThrow('canonical_reference_changed')
   const key='9007199254741246',body={text:'atomic batch prefix'}
   await pool.query("INSERT INTO public.events(id,session_id,user_id,event_type,payload,effect_status,body_storage,created_at) VALUES($1,$2,1,'agent_text',$3,'completed','hot','2026-11-06T12:36:56.123456Z')",[key,session,body])
   await pool.query("SELECT shared.mark_memory_source_dirty('relay_event',$1)",[target.key])
   const batch=await prepareCanonicalReferencePage(runtime,currentScope,target,{keys:[key,'9007199254741244']})
   const saved=(await runtime.query('SELECT classification FROM source_events WHERE source_event_id=$1',[old])).rows[0].classification
   try{
    await runtime.query("UPDATE source_events SET classification='{\"content_class\":\"conflict\"}' WHERE source_event_id=$1",[old])
    await expect(persistCanonicalReferencePage(runtime,batch)).rejects.toThrow(/canonical_reference_(conflict|changed)/)
    expect((await runtime.query('SELECT 1 FROM source_events WHERE installation_id=$1 AND canonical_key=$2',[inst,key])).rowCount).toBe(0)
   }finally{await runtime.query('UPDATE source_events SET classification=$2 WHERE source_event_id=$1',[old,saved])}
   const first=await prepareCanonicalReferencePage(runtime,currentScope,target,{limit:1})
   expect(first.count).toBe(1);expect(first.nextCursor).toEqual(expect.any(String));expect(first.hasMore).toBe(true)
   let cursor=first.nextCursor,total=first.count
   for(let n=0;n<10&&cursor;n++){
    const page=await prepareCanonicalReferencePage(runtime,currentScope,target,{limit:1,cursor})
    total+=page.count;expect(page.hasMore).toBe(typeof page.nextCursor==='string');cursor=page.nextCursor
   }
   expect(total).toBe(3);expect(cursor).toBeUndefined()
   await runtime.query('INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,now(),now())',[inst,session+'-wrong'])
   for(const changed of ['session','turn']){
    const page=await prepareCanonicalReferencePage(runtime,currentScope,target,{keys:['9007199254741244']})
    try{
     if(changed==='session')await runtime.query('UPDATE source_events SET session_id=$2 WHERE source_event_id=$1',[old,session+'-wrong'])
     else await runtime.query("UPDATE source_events SET turn_id='wrong-turn' WHERE source_event_id=$1",[old])
     await expect(persistCanonicalReferencePage(runtime,page)).rejects.toThrow('canonical_reference_conflict')
    }finally{await runtime.query('UPDATE source_events SET session_id=$2,turn_id=NULL WHERE source_event_id=$1',[old,session])}
   }
  })
 })
 test('canonical page checkpoints reject skipped pages and advance atomically with derived facts',async()=>{
  const {withSourceJobExecution}=await import('../../sources/source-execution.js')
  const {prepareCanonicalReferencePage,persistCanonicalReferencePage}=await import('../../sources/canonical-references.js')
  const job='70000000-0000-0000-0000-000000000091',session='checkpoint-92',root={kind:'relay_event' as const,key:'1:checkpoint-92'},currentScope={...scope,modeGeneration:'5'}
  await runtime.query("UPDATE memory_jobs SET claim_epoch=3,claim_expires_at=clock_timestamp()+interval '5 minutes' WHERE job_id=$1",[job])
  await pool.query("INSERT INTO public.sessions VALUES($1,1,'daemon','codex','hot','codex')",[session])
  for(const [i,id]of ['9007199254741250','9007199254741251'].entries())await pool.query("INSERT INTO public.events(id,session_id,user_id,event_type,payload,effect_status,body_storage,created_at) VALUES($1,$2,1,'agent_text',$3,'completed','hot',$4)",[id,session,{text:'bounded fixture '+i,turn_id:'checkpoint-turn-92'},new Date()])
  await pool.query("SELECT shared.mark_memory_source_dirty('relay_event',$1)",[root.key])
  await withSourceJobExecution(runtime,{jobId:job,claimedBy:'canonical-test',claimEpoch:3},async()=>{
   const first=await prepareCanonicalReferencePage(runtime,currentScope,root,{limit:1}),last=await prepareCanonicalReferencePage(runtime,currentScope,root,{limit:1,cursor:first.nextCursor})
   const progress=async()=>(await runtime.query('SELECT source_version,next_cursor,state FROM memory_canonical_projection_progress WHERE installation_id=$1 AND root_key=$2',[inst,root.key])).rows
   await expect(persistCanonicalReferencePage(runtime,last,{project:true,checkpoint:true})).rejects.toThrow('canonical_reference_cursor_changed')
   expect(await progress()).toEqual([])
   await persistCanonicalReferencePage(runtime,first,{project:true,checkpoint:true})
   expect(await progress()).toEqual([{source_version:expect.any(Object),next_cursor:first.nextCursor,state:'scanning'}])
   await persistCanonicalReferencePage(runtime,first,{project:true,checkpoint:true})
   expect((await runtime.query('SELECT event_count::text FROM source_turns WHERE installation_id=$1 AND turn_id=$2',[inst,'checkpoint-turn-92'])).rows[0].event_count).toBe('1')
   // Old mapped Feed UUIDs must obey the same complete-root admission as
   // newly canonical refs: a proved identity is not a catch-up receipt.
   const firstSource=(await runtime.query('SELECT source_event_id::text FROM source_events WHERE installation_id=$1 AND canonical_key=$2',[inst,'9007199254741250'])).rows[0].source_event_id
   await runtime.query("UPDATE source_events SET origin='feed',origin_position='checkpoint-mapped-old',payload=$2 WHERE source_event_id=$1",[firstSource,{text:'bounded fixture 0',turn_id:'checkpoint-turn-92'}])
   const {prepareSourceReferences}=await import('../../sources/prepared-sources.js')
   await expect(prepareSourceReferences(runtime,inst,[firstSource])).rejects.toThrow('source_not_ready')
   const {prepareEpisodeSources}=await import('../../sources/prepared-sources.js')
   await expect(prepareEpisodeSources(runtime,inst,'checkpoint-turn-92')).rejects.toThrow('source_not_ready')
   // A metadata conflict must not commit either the second fact or its cursor.
   await runtime.query("INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,classification,payload,payload_hash) VALUES(gen_random_uuid(),$1,'feed','checkpoint-unproven',$2,'agent_text',now(),'{}','{}',sha256(convert_to('{}','UTF8')))",[inst,session])
   await expect(persistCanonicalReferencePage(runtime,last,{project:true,checkpoint:true})).rejects.toThrow('canonical_reference_mapping_required')
   expect((await progress())[0].state).toBe('scanning')
   expect((await runtime.query("SELECT 1 FROM source_events WHERE installation_id=$1 AND canonical_key='9007199254741251'",[inst])).rowCount).toBe(0)
   await runtime.query("DELETE FROM source_events WHERE installation_id=$1 AND origin_position='checkpoint-unproven'",[inst])
   const refreshed=await prepareCanonicalReferencePage(runtime,currentScope,root,{limit:1})
   await persistCanonicalReferencePage(runtime,refreshed,{project:true,checkpoint:true})
   const refreshedLast=await prepareCanonicalReferencePage(runtime,currentScope,root,{limit:1,cursor:refreshed.nextCursor})
   await persistCanonicalReferencePage(runtime,refreshedLast,{project:true,checkpoint:true})
   await persistCanonicalReferencePage(runtime,refreshedLast,{project:true,checkpoint:true})
   const exhausted=await prepareCanonicalReferencePage(runtime,currentScope,root,{limit:1,cursor:refreshedLast.nextCursor})
   expect(exhausted.count).toBe(0)
   await persistCanonicalReferencePage(runtime,exhausted,{project:true,checkpoint:true})
   expect((await progress())[0]).toMatchObject({next_cursor:null,state:'ready'})
   expect((await runtime.query('SELECT event_count::text FROM source_turns WHERE installation_id=$1 AND turn_id=$2',[inst,'checkpoint-turn-92'])).rows[0].event_count).toBe('2')
   await sealRoot(root.key)
   await expect(prepareEpisodeSources(runtime,inst,'checkpoint-turn-92')).resolves.toHaveProperty('bodyBytes')
   await expect(persistCanonicalReferencePage(runtime,refreshed,{project:true,checkpoint:true})).rejects.toThrow('canonical_reference_cursor_changed')
  })
 })

 test('canonical queue rejects an unsealed or caller-selected context set before body work',async()=>{
  const {createCanonicalProjectionHandler}=await import('../../sources/canonical-projection-worker.js')
  await expect(createCanonicalProjectionHandler(runtime)({job_type:'project_shared_source',installation_id:inst,payload:{scope,root}} as any,new AbortController().signal))
   .rejects.toMatchObject({errorCode:'invalid_source_context_set'})
 })

 test('the real canonical queue resumes persisted page state across separate claims',async()=>{
  // This late queue case enters the explicit selected API. Install the real
  // modern marker/capture and authenticated Journal publisher prerequisites.
  // Earlier cases intentionally retain malformed historical partial headers;
  // NOT VALID preserves those old negative fixtures while enforcing every new
  // row/update here. No historical body/hash/provenance backfill is performed.
  const {RELAY_SOURCE_HEADER_SQL}=await import(new URL('../../../../relay/dist/shared-source/header-contract.js',import.meta.url).href)
  const {RELAY_SOURCE_CAPTURE_SQL}=await import(new URL('../../../../relay/dist/shared-source/capture-contract.js',import.meta.url).href)
  for(const sql of RELAY_SOURCE_HEADER_SQL)await pool.query(sql.replace('));\n  END IF;', ')) NOT VALID;\n  END IF;'))
  for(const sql of RELAY_SOURCE_CAPTURE_SQL)await pool.query(sql)
  const {createPostgresExtensionJournalSink}=await import(new URL('../../../../relay/dist/extensions/journal.js',import.meta.url).href)
  const publishHeader=async(id:string,session:string,eventType:string,payload:Record<string,unknown>)=>createPostgresExtensionJournalSink({sharedHeaders:true}).appendCanonicalEvent(pool,{sourceEventId:id,ownerUserId:1,sessionId:session,eventType,occurredAt:null,payload})
  const {createCanonicalProjectionHandler}=await import('../../sources/canonical-projection-worker.js')
  const {createJobRepository}=await import('../../jobs/repository.js'),{createJobWorker}=await import('../../jobs/worker.js')
  const session='canonical-queue-92',turn='canonical-queue-turn-92',jobs=createJobRepository(runtime),payload:Record<string,any>={scope:{...scope,modeGeneration:'5'},root:{kind:'relay_event',key:'1:'+session}}
  await runtime.query("UPDATE memory_jobs SET state='completed',claim_expires_at=NULL WHERE state='pending'")
  await pool.query("INSERT INTO public.sessions VALUES($1,1,'daemon','codex','hot','codex')",[session])
  for(const [i,id]of ['9007199254741260','9007199254741261'].entries()){
   const body=i===0?{text:'queue fixture 0',turn_id:turn}:{turn_status:'completed',turn_id:turn},type=i===0?'agent_text':'turn_status'
   await pool.query("INSERT INTO public.events(id,session_id,user_id,event_type,payload,effect_status,body_storage,created_at) VALUES($1,$2,1,$5,$3,'completed','hot',$4)",[id,session,body,new Date(),type])
   await publishHeader(id,session,type,body)
   const header=(await pool.query('SELECT source_header_version,source_sequence::text,canonical_payload_hash,source_classification,source_body_change_revision::text FROM public.events WHERE id=$1',[id])).rows[0]
   expect(header.source_header_version).toBe(1);expect(BigInt(header.source_sequence)).toBeGreaterThan(0n);expect(header.canonical_payload_hash).toBe(canonicalPayloadHash(body).toString('hex'));expect(header.source_classification).toEqual(expect.any(Object));expect(header.source_body_change_revision).toMatch(/^[0-9]+$/)
  }
  await pool.query("SELECT shared.mark_memory_source_dirty('relay_event',$1)",[payload.root.key])
  const refreshSeal=async()=>{
   const claim=(await runtime.query("SELECT root_key,lease_token::text,claimed_revision::text FROM shared.claim_memory_source_work('queue-distributor',30,128)")).rows.find(r=>r.root_key===payload.root.key)!
   let page:any=null
   for(let n=0;n<5;n++){
    page=(await runtime.query("SELECT shared.step_memory_source_distribution('relay_event',$1,$2,'queue-distributor',$3,$4,$5,64) AS page",[payload.root.key,claim.lease_token,claim.claimed_revision,page?.scanId??null,page?.cursor??''])).rows[0].page
    if(page.state==='sealed')break
   }
   const target=(await runtime.query("SELECT * FROM shared.read_memory_source_context_set('relay_event',$1,$2,$3,'',64)",[payload.root.key,page.scanId,inst])).rows[0]
   payload.distribution_scan=page.scanId;payload.target_cursor=target.cursor_key
   await runtime.query('SELECT shared.record_memory_source_dispatch($1,$2,$3,$4,$5,$6,$7)',[inst,payload.scope.modeGeneration,payload.root.kind,payload.root.key,claim.claimed_revision,(await pool.query('SELECT content_revision FROM shared.memory_relay_source_authority($1::jsonb,$2,$3)',[JSON.stringify(payload.scope),payload.root.kind,payload.root.key])).rows[0].content_revision,payload.scope.authorizationRevision])
   await runtime.query("SELECT shared.ack_memory_source_work('relay_event',$1,$2,'queue-distributor',$3)",[payload.root.key,claim.lease_token,claim.claimed_revision])
  }
  await refreshSeal()
  let expectedRevision=(await pool.query('SELECT revision::text FROM shared.memory_source_work WHERE root_key=$1',[payload.root.key])).rows[0].revision
  await jobs.enqueueJob({installationId:inst,jobType:'project_shared_source',idempotencyKey:session,payload})
  const errors:string[]=[],queue=createJobWorker({pool:runtime,jobs,workerId:'canonical-page-worker',signal:new AbortController().signal,onError:e=>errors.push(String(e))})
  queue.register('project_shared_source',createCanonicalProjectionHandler(runtime,{pageSize:1,deferMs:0}),{branch:'canonical'})
  try{
   await queue.tick()
   expect((await runtime.query('SELECT state,claim_epoch::text FROM memory_jobs WHERE installation_id=$1 AND idempotency_key=$2',[inst,session])).rows).toEqual([{state:'pending',claim_epoch:'1'}])
   expect((await runtime.query('SELECT state FROM memory_canonical_projection_progress WHERE installation_id=$1 AND root_key=$2',[inst,payload.root.key])).rows).toEqual([{state:'scanning'}])
   expect((await pool.query('SELECT dispatched_revision::text,processed_revision::text FROM shared.memory_source_progress WHERE installation_id=$1 AND root_key=$2',[inst,payload.root.key])).rows[0]).toEqual({dispatched_revision:expectedRevision,processed_revision:'0'})
   await runtime.query('UPDATE memory_jobs SET available_at=clock_timestamp() WHERE installation_id=$1 AND idempotency_key=$2',[inst,session])
   await queue.tick()
   expect((await runtime.query('SELECT state,claim_epoch::text FROM memory_jobs WHERE installation_id=$1 AND idempotency_key=$2',[inst,session])).rows).toEqual([{state:'completed',claim_epoch:'2'}])
   expect((await runtime.query('SELECT state FROM memory_canonical_projection_progress WHERE installation_id=$1 AND root_key=$2',[inst,payload.root.key])).rows).toEqual([{state:'ready'}])
   expect((await pool.query('SELECT dispatched_revision::text,processed_revision::text FROM shared.memory_source_progress WHERE installation_id=$1 AND root_key=$2',[inst,payload.root.key])).rows[0]).toEqual({dispatched_revision:expectedRevision,processed_revision:expectedRevision})
   expect((await runtime.query('SELECT event_count::text FROM source_turns WHERE installation_id=$1 AND turn_id=$2',[inst,turn])).rows).toEqual([{event_count:'2'}])
   // Simulate loss of the worker after final page COMMIT but before its job
   // completion was durable. A new claim must complete without a page restart.
   await runtime.query("UPDATE memory_jobs SET state='pending',completed_at=NULL,available_at=clock_timestamp() WHERE installation_id=$1 AND idempotency_key=$2",[inst,session])
   await queue.tick()
   expect((await runtime.query('SELECT state,claim_epoch::text FROM memory_jobs WHERE installation_id=$1 AND idempotency_key=$2',[inst,session])).rows).toEqual([{state:'completed',claim_epoch:'3'}])
   expect((await runtime.query('SELECT event_count::text FROM source_turns WHERE installation_id=$1 AND turn_id=$2',[inst,turn])).rows).toEqual([{event_count:'2'}])
   // Cooling changes only storage, with no new dirty revision or job. The
   // completed content projection remains usable, while real cold IO still
   // validates the new full storage proof rather than old compatibility text.
   const coldManifest='30000000-0000-0000-0000-000000000096',coldKey=`session-archive/v1/${coldManifest}/0.gz`,coldPayload={text:'queue fixture 0',turn_id:turn}
   const cold=await encodeArchiveChunk({userId:1,sessionId:session,activityEpoch:'42',manifestId:coldManifest,ordinal:0},[{id:'9007199254741260',eventType:'agent_text',payload:coldPayload}],limits)
   await storage.put(coldKey,cold.bytes)
   await pool.query("INSERT INTO public.session_archive_manifests VALUES($1,1,$2,42,1,'gzip','published','reader-archive')",[coldManifest,session])
   await pool.query('INSERT INTO public.session_archive_chunks VALUES($1,0,$2,$3,$3,1,$4,$5,$6,$7)',[coldManifest,coldKey,'9007199254741260',String(cold.manifest.rawBytes),String(cold.manifest.compressedBytes),cold.manifest.rawSha256,cold.manifest.compressedSha256])
   await pool.query("UPDATE public.events SET payload=NULL,body_storage='cold',body_manifest_id=$1,body_chunk_ordinal=0,body_activity_epoch=42,body_owner_user_id=1,canonical_payload_hash=$2 WHERE id=9007199254741260",[coldManifest,canonicalPayloadHash(coldPayload).toString('hex')])
   const beforeStorage=(await pool.query('SELECT revision::text,processed_revision::text FROM shared.memory_source_work WHERE root_key=$1',[payload.root.key])).rows[0]
   await pool.query('UPDATE shared.memory_source_work SET storage_revision=storage_revision+1 WHERE root_key=$1',[payload.root.key])
   expect((await pool.query('SELECT revision::text,processed_revision::text FROM shared.memory_source_work WHERE root_key=$1',[payload.root.key])).rows[0]).toEqual(beforeStorage)
   const {bindSourcePool}=await import('../../sources/pool-context.js')
   let coldReads=0
   bindSourcePool(runtime,{namespace:'memory',archive:{storage:{namespace:storage.namespace,read:async key=>{coldReads++;return storage.read(key)}},limits}})
   await runtime.query("UPDATE memory_jobs SET state='pending',completed_at=NULL,available_at=clock_timestamp() WHERE installation_id=$1 AND idempotency_key=$2",[inst,session])
   await queue.tick()
   expect((await runtime.query('SELECT state,claim_epoch::text FROM memory_jobs WHERE installation_id=$1 AND idempotency_key=$2',[inst,session])).rows).toEqual([{state:'completed',claim_epoch:'4'}])
   expect(coldReads).toBe(0)
   const {createEpisodeRepository}=await import('../../episodes/repository.js')
   queue.register('compile_episode',createEpisodeRepository(runtime,{stabilizationMs:0}).handleCompileEpisode)
   await runtime.query("UPDATE memory_jobs SET available_at=clock_timestamp() WHERE installation_id=$1 AND job_type='compile_episode'",[inst])
   await queue.tick()
   expect(coldReads).toBeGreaterThan(0)
   expect((await runtime.query('SELECT document_compiler_version FROM work_episodes WHERE installation_id=$1 AND turn_id=$2',[inst,turn])).rows).toEqual([{document_compiler_version:'memory-episode-packet-v6'}])
   await storage.put(coldKey,Buffer.from('corrupt canonical archive'))
   try{await expect(createEpisodeRepository(runtime).compileTurn(inst,turn)).rejects.toMatchObject({code:'archive_unavailable'})}
   finally{await storage.put(coldKey,cold.bytes)}
   await pool.query("INSERT INTO public.events(id,session_id,user_id,event_type,payload,effect_status,body_storage,created_at) VALUES('9007199254741262',$1,1,'agent_text',$2,'completed','hot',now())",[session,{text:'newer committed revision',turn_id:turn}])
   await publishHeader('9007199254741262',session,'agent_text',{text:'newer committed revision',turn_id:turn})
   await pool.query("SELECT shared.mark_memory_source_dirty('relay_event',$1)",[payload.root.key])
   await refreshSeal()
   expectedRevision=(await pool.query('SELECT revision::text FROM shared.memory_source_work WHERE root_key=$1',[payload.root.key])).rows[0].revision
   await runtime.query('UPDATE memory_jobs SET payload=$3::jsonb WHERE installation_id=$1 AND idempotency_key=$2',[inst,session,JSON.stringify(payload)])
   await runtime.query("UPDATE memory_jobs SET state='pending',completed_at=NULL,available_at=clock_timestamp() WHERE installation_id=$1 AND idempotency_key=$2",[inst,session])
   for(let n=0;n<4;n++){
    await queue.tick()
    await runtime.query('UPDATE memory_jobs SET available_at=clock_timestamp() WHERE installation_id=$1 AND idempotency_key=$2',[inst,session])
   }
   expect((await runtime.query('SELECT state,claim_epoch::text FROM memory_jobs WHERE installation_id=$1 AND idempotency_key=$2',[inst,session])).rows).toEqual([{state:'completed',claim_epoch:'7'}])
   expect((await runtime.query('SELECT event_count::text FROM source_turns WHERE installation_id=$1 AND turn_id=$2',[inst,turn])).rows).toEqual([{event_count:'3'}])
   expect((await pool.query('SELECT dispatched_revision::text,processed_revision::text FROM shared.memory_source_progress WHERE installation_id=$1 AND root_key=$2',[inst,payload.root.key])).rows[0]).toEqual({dispatched_revision:expectedRevision,processed_revision:expectedRevision})
   expect(errors).toEqual([])
  }finally{await queue.stop()}
 })

 test('canonical projection atomically derives turns/artifacts/jobs without Feed copies or repeated effects',async()=>{
  const {withSourceJobExecution}=await import('../../sources/source-execution.js')
  const {prepareCanonicalReferencePage,persistCanonicalReferencePage}=await import('../../sources/canonical-references.js')
  const job='70000000-0000-0000-0000-000000000091',session='metadata-time',turn='canonical-turn-92'
  await runtime.query("UPDATE memory_jobs SET claim_epoch=3,claim_expires_at=clock_timestamp()+interval '5 minutes' WHERE job_id=$1",[job])
  const events=[
   {id:'9007199254741247',type:'user_goal',body:{text:'canonical fact body',turn_id:turn,repository_id:'github.com/fixture/canonical-92',commit_sha:'a'.repeat(40),branch:'main'}},
   {id:'9007199254741248',type:'test_result',body:{text:'canonical test evidence',turn_id:turn,test_run_id:'canonical-run-92',status:'passed'}},
   {id:'9007199254741249',type:'turn_status',body:{turn_id:turn,turn_status:'completed'}},
  ]
  for(const [i,e]of events.entries())await pool.query("INSERT INTO public.events(id,session_id,user_id,event_type,payload,effect_status,body_storage,created_at) VALUES($1,$2,1,$3,$4,'completed','hot',$5::timestamptz)",[e.id,session,e.type,e.body,`2026-11-06T12:4${i}:56.123456Z`])
  await pool.query("SELECT shared.mark_memory_source_dirty('relay_event',$1)",['1:'+session])
  const inbox=Number((await runtime.query('SELECT count(*) AS n FROM memory_feed_inbox')).rows[0].n)
  await withSourceJobExecution(runtime,{jobId:job,claimedBy:'canonical-test',claimEpoch:3},async()=>{
   const page=await prepareCanonicalReferencePage(runtime,{...scope,modeGeneration:'5'},{kind:'relay_event',key:'1:'+session},{limit:256})
   await persistCanonicalReferencePage(runtime,page,{project:true,checkpoint:true,stabilizationMs:0})
   await persistCanonicalReferencePage(runtime,page,{project:true,checkpoint:true,stabilizationMs:0})
  })
  expect((await runtime.query('SELECT state,event_count::text FROM source_turns WHERE installation_id=$1 AND turn_id=$2',[inst,turn])).rows).toEqual([{state:'completed',event_count:'3'}])
  expect((await runtime.query('SELECT artifact_type FROM source_artifacts WHERE installation_id=$1 AND turn_id=$2',[inst,turn])).rows).toEqual([{artifact_type:'test_result'}])
  expect((await runtime.query("SELECT 1 FROM memory_jobs WHERE installation_id=$1 AND job_type='compile_episode' AND idempotency_key=$2",[inst,'compile_episode:'+turn])).rowCount).toBe(1)
  expect((await runtime.query("SELECT payload,origin FROM source_events WHERE installation_id=$1 AND canonical_key=ANY($2::text[]) ORDER BY canonical_key",[inst,events.map(e=>e.id)])).rows).toEqual(events.map(()=>({payload:null,origin:'canonical'})))
  expect(Number((await runtime.query('SELECT count(*) AS n FROM memory_feed_inbox')).rows[0].n)).toBe(inbox)
  expect((await runtime.query('SELECT last_feed_id FROM source_sessions WHERE installation_id=$1 AND session_id=$2',[inst,session])).rows[0].last_feed_id).toBeNull()
  await sealRoot('1:'+session)
  const {createJobRepository}=await import('../../jobs/repository.js'),{createJobWorker}=await import('../../jobs/worker.js'),{createEpisodeRepository}=await import('../../episodes/repository.js')
  await runtime.query("UPDATE memory_jobs SET state='completed',claim_expires_at=NULL WHERE state='pending' AND NOT(installation_id=$1 AND job_type='compile_episode' AND idempotency_key=$2)",[inst,'compile_episode:'+turn])
  const errors:string[]=[],queue=createJobWorker({pool:runtime,jobs:createJobRepository(runtime),workerId:'canonical-compiler',signal:new AbortController().signal,onError:error=>errors.push(error instanceof Error?error.message:'unknown')})
  queue.register('compile_episode',createEpisodeRepository(runtime).handleCompileEpisode)
  try{await queue.tick()}finally{await queue.stop()}
  expect(errors).toEqual([])
  expect((await runtime.query('SELECT document_compiler_version FROM work_episodes WHERE installation_id=$1 AND turn_id=$2',[inst,turn])).rows).toEqual([{document_compiler_version:'memory-episode-packet-v6'}])
  expect((await runtime.query('SELECT count(*)::text AS n FROM memory_provider_budget_reservations')).rows[0].n).toBe('0')
 })
 test('the native API pool retains its bounded warm connections across idle expiry',async()=>{
  const {setTimeout:wait}=await import('node:timers/promises')
  const nativeUrl=new URL(url!)
  nativeUrl.username='shared_reader_memory'
  nativeUrl.password='only-test'
  const warm=createMemoryPool({databaseUrl:nativeUrl.href,databaseNamespace:'memory',dbPoolMax:3},{retainIdleConnections:3})
  const identities=async()=>(await Promise.all(Array.from({length:3},async()=>(
   await warm.query<{pid:number}>('SELECT pg_backend_pid() AS pid')
  ).rows[0].pid))).sort((a,b)=>a-b)
  try{
   const first=await identities()
   expect(new Set(first).size).toBe(3)
   await wait(10_500)
   expect(warm.idleCount).toBe(3)
   expect(await identities()).toEqual(first)
  }finally{await warm.end()}
 },20_000)

 test('native Context delivers two accepted excerpts within the shared turn budget',async()=>{
  const {randomUUID}=await import('node:crypto')
  const {governanceFixture}=await import('../../testing/governance-fixture.js')
  const {readContextCorpusFingerprint}=await import('../../context/compiler.js')
  const {originContextFixture,contextDeliveryClient,measureContextDelivery}=await import('../helpers/origin-context-fixture.js')
  const {personal:installation,claim,version,evidence:firstEvidence}=await governanceFixture(runtime)
  const repository=randomUUID(),snapshot=randomUUID(),space=randomUUID(),secondEvidence=randomUUID(),commit='f'.repeat(40)
  const statement='Memory job migration requires an exact installation watermark.'
  await pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,authorization_epoch,config_version,granted_scopes,enabled_services) VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage','memory.search'])",[installation])
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[installation])
  await runtime.query("INSERT INTO memory_curation_policies(installation_id,mode,consume_mode) VALUES($1,'enabled','enabled')",[installation])
  await runtime.query("INSERT INTO repositories(repository_id,installation_id,repository_key,first_observed_at,last_observed_at) VALUES($1,$2,'context-budget',now(),now())",[repository,installation])
  await runtime.query("INSERT INTO repo_snapshots(installation_id,repository_id,repo_snapshot_id,commit_sha,branch,observed_at) VALUES($1,$2,$3,$4,'main',now())",[installation,repository,snapshot,commit])
  await runtime.query("INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'work','Migration',ARRAY['personal'])",[installation,space])
  await runtime.query("UPDATE knowledge_claims SET scope_kind='repository',scope_key=$2 WHERE claim_id=$1",[claim,repository])
  await runtime.query("UPDATE knowledge_versions SET statement=$2,repository_id=$3,repo_snapshot_id=$4 WHERE version_id=$1",[version,statement,repository,snapshot])
  await runtime.query('DELETE FROM knowledge_evidence WHERE evidence_id=$1',[firstEvidence])
  await runtime.query(`WITH capsule AS(
    INSERT INTO knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash)
    VALUES(gen_random_uuid(),$1,$2,'user_accepted',sha256(convert_to($3,'UTF8'))) RETURNING capsule_id)
   INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at)
   SELECT id,$1,$2,capsule_id,ordinal,'accepted_excerpt',$3,sha256(convert_to($3,'UTF8')),now()
   FROM capsule CROSS JOIN unnest($4::uuid[]) WITH ORDINALITY AS e(id,ordinal)`,[installation,version,statement,[firstEvidence,secondEvidence]])
  // Match the observed corpus size while keeping a single relevant version.
  await runtime.query(`WITH distractors AS MATERIALIZED(
    SELECT gen_random_uuid() AS claim_id,gen_random_uuid() AS version_id,n FROM generate_series(1,31) n
   ), claims AS (
    INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state)
    SELECT claim_id,$1,'test_invariant','repository',$2::uuid::text,'fixture-unrelated-'||n,'active' FROM distractors
   ), versions AS (
    INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,repository_id,repo_snapshot_id)
    SELECT version_id,$1,claim_id,1,'Recipe: roast zucchini with olive oil.','user_accepted',1,$2,$3 FROM distractors
    RETURNING version_id
   ), capsules AS (
    INSERT INTO knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash)
    SELECT gen_random_uuid(),$1,version_id,'user_accepted',sha256(convert_to('fixture','UTF8')) FROM versions
    RETURNING version_id,capsule_id
   )
   INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at)
   SELECT gen_random_uuid(),$1,version_id,capsule_id,1,'accepted_excerpt','fixture',sha256(convert_to('fixture','UTF8')),now() FROM capsules`,[installation,repository,snapshot])
  await runtime.query(`UPDATE knowledge_claims c SET current_version_id=v.version_id
   FROM knowledge_versions v WHERE c.installation_id=$1 AND c.current_version_id IS NULL
   AND v.installation_id=c.installation_id AND v.claim_id=c.claim_id`,[installation])
  const context=await originContextFixture(runtime,installation,{authorityGrant:{installationId:installation,configVersion:'1',userId:1},sceneId:space,query:statement,repositoryId:repository,commitSha:commit})
  const client=await contextDeliveryClient(runtime,context,installation)
  const deliver=async(request:string,phase:<T>(name:string,run:()=>Promise<T>)=>Promise<T>,options:{
   queryText?:string;withProvenEvidence?:boolean;configVersion?:string;verifyRetry?:boolean
  }={})=>{
   const {queryText=statement,withProvenEvidence=true,configVersion='1',verifyRetry=false}=options
   const signal=AbortSignal.timeout(750)
   const grant=client.issueGrant(configVersion)
   const transportDelay=Number(process.env.CONTEXT_TEST_TRANSPORT_DELAY_MS??0)
   if(transportDelay>0)await new Promise(resolve=>setTimeout(resolve,transportDelay))
   const http=async(path:string,body?:Record<string,unknown>)=>{
    const headers:Record<string,string>={authorization:'Bearer '+grant}
    if(body)headers['content-type']='application/json'
    const response=await fetch(client.url+path,{headers,method:body?'POST':'GET',body:body?JSON.stringify(body):undefined,signal})
    const data=await response.json()
    if(!response.ok)throw Error(path.split('?')[0]+': '+response.status+' '+JSON.stringify(data))
    return data
   }
   const turn={session_id:context.sessionId,client_request_id:request,agent:'codex'}
   const pack=await phase('compile',()=>http('/compile',{
    ...turn,schema_version:1,adapter_capability:'native_hidden_v1',query:queryText,
    repository_hint:{repository_id:repository,commit_sha:commit},evidence_read_capability:'on_demand_v1',
   }))
   expect(pack.outcome).toBe('ready')
   expect(pack.evidence_read_capability).toBe(withProvenEvidence?'on_demand_v1':'bounded_excerpt_v1')
   expect(pack.pack.item_count).toBe(1)
   if(!withProvenEvidence)return pack.pack.pack_id as string
   const path='/packs/'+pack.pack.pack_id
   const admit=()=>http(path+'/admit',{...turn,adapter:'codex-app-server'})
   const admission=await phase('admit',()=>verifyRetry?Promise.all([admit(),admit()]):admit().then(value=>[value]))
   const ticket=admission.find(value=>value.nonce)
   if(verifyRetry){
    expect(admission.filter(value=>value.nonce)).toHaveLength(1)
    expect(admission.find(value=>value.existing)).toMatchObject({injection_id:ticket.injection_id,state:'admitted'})
   }
   const query=new URLSearchParams({session_id:context.sessionId,injection_id:ticket.injection_id,nonce:ticket.nonce})
   const consumed=await phase('consume',()=>http(path+'/text?'+query.toString()))
   expect(consumed.dynamic_text).toContain(statement)
   for(const id of [firstEvidence,secondEvidence])expect(consumed.dynamic_text).toContain(id)
   expect(consumed.pack_id).toBe(pack.pack.pack_id)
   if(verifyRetry)await expect(http(path+'/text?'+query.toString())).rejects.toThrow('409')
  }
  try{
   await deliver('warmup',(_name,run)=>run())
   const samples=Number(process.env.CONTEXT_TEST_SAMPLES??1)
   for(let n=0;n<samples;n++){
    const result=await measureContextDelivery(
     async phase=>{await deliver('measured-'+n,phase,{queryText:n%2===0?statement:'installation watermark？引用证据号。'})},
     Number(process.env.CONTEXT_TEST_DB_DELAY_MS??0),
    )
    if(process.env.CONTEXT_TEST_TIMING)console.info(JSON.stringify(result))
    const [compile,admit,consume]=result.phases
    // Native scene writes acquire the authority fence before the fresh
    // snapshot. The transport still uses the original end-to-end deadline.
    expect(compile.queries.length).toBeLessThanOrEqual(44)
    expect(admit.queries.length).toBeLessThanOrEqual(18)
    expect(consume.queries.length).toBeLessThanOrEqual(7)
    if(process.env.CONTEXT_TEST_DB_DELAY_MS){
     expect(compile.ms).toBeLessThan(500)
     expect(result.ms).toBeLessThan(710)
    }
   }
   // The signed current Relay version must work while the local discovery row
   // still holds the previous version. The old signed grant must still fail.
   await pool.query("UPDATE public.extension_installations SET config_version=2 WHERE installation_id=$1",[installation])
   try{
    await expect.soft(deliver('native-current-admit',(_name,run)=>run(),{configVersion:'2',verifyRetry:true})).resolves.toBeUndefined()
    await expect.soft(deliver('native-stale-token',(_name,run)=>run())).rejects.toThrow('401')
   }finally{await pool.query("UPDATE public.extension_installations SET config_version=1 WHERE installation_id=$1",[installation])}

   const evidenceUrl=new URL('/api/v1/memory/evidence/'+firstEvidence+'/reference',client.url)
   evidenceUrl.search=new URLSearchParams({repository_id:repository,repo_snapshot_id:snapshot}).toString()
   const readReference=()=>fetch(evidenceUrl,{headers:{authorization:'Bearer '+client.issueGrant('1','memory.search')},signal:AbortSignal.timeout(2500)})
   const original=await readReference()
   expect(original.status).toBe(200)
   const originalBody=await original.json()
   expect(originalBody.reference.evidence_id).toBe(firstEvidence)
   await runtime.query("UPDATE memory_installations SET relay_status='revoked' WHERE installation_id=$1",[installation])
   try{
    const stillAuthorized=await readReference()
    expect.soft(stillAuthorized.status).toBe(200)
    expect.soft(await stillAuthorized.json()).toEqual(originalBody)
   }finally{await runtime.query("UPDATE memory_installations SET relay_status='active' WHERE installation_id=$1",[installation])}
   await runtime.query("UPDATE memory_installations SET local_status='integrity_error' WHERE installation_id=$1",[installation])
   try{expect((await readReference()).status).toBe(401)}
   finally{await runtime.query("UPDATE memory_installations SET local_status='ready' WHERE installation_id=$1",[installation])}
   // The guard has already accepted the signed grant when this second
   // connection disables the provider. No discovery Worker runs in the fixture.
   let disabledBeforeConsume=false
   client.beforeNextConsume(async()=>{
    await pool.query("UPDATE public.extension_providers SET status='disabled' WHERE provider_id='pocketctl-memory'")
    disabledBeforeConsume=true
   })
   try{
    await expect.soft(deliver('native-revoked-before-text',(_name,run)=>run())).rejects.toThrow(/text: (404|410)/)
    expect.soft(disabledBeforeConsume).toBe(true)
    const injection=(await runtime.query("SELECT state FROM memory_context_injections WHERE installation_id=$1 AND client_request_id='native-revoked-before-text'",[installation])).rows[0]
    expect.soft(injection?.state).not.toBe('prepared')
   }finally{await pool.query("UPDATE public.extension_providers SET status='enabled' WHERE provider_id='pocketctl-memory'")}
   const {resolveLifecycleReadFrame,resolveLifecycleFrame}=await import('../../context/lifecycle-frame.js')
   const scenesUrl=new URL('/api/v1/memory/scenes',client.url)
   const readScenes=()=>fetch(scenesUrl,{headers:{authorization:'Bearer '+client.issueGrant('1','memory.search')},signal:AbortSignal.timeout(2500)})
   await pool.query('UPDATE public.extension_installations SET authorization_epoch=2 WHERE installation_id=$1',[installation])
   try{
    await runtime.query("UPDATE memory_owner_scopes SET state='suspended' WHERE installation_id=$1",[installation])
    try{
     const response=await readScenes()
     expect(response.status).toBe(200)
     expect.soft(await response.json()).toMatchObject({scenes:[{id:space}],has_more:false})
     expect.soft(await resolveLifecycleReadFrame(runtime,{installationId:installation,spaceId:space,repositoryId:repository,mode:'enabled'}))
      .toMatchObject({spaceId:space,authorizationEpoch:'2'})
    }finally{await runtime.query("UPDATE memory_owner_scopes SET state='active' WHERE installation_id=$1",[installation])}

    await runtime.query("UPDATE memory_installations SET local_status='integrity_error' WHERE installation_id=$1",[installation])
    try{
     expect((await readScenes()).status).toBe(401)
     expect(await resolveLifecycleReadFrame(runtime,{installationId:installation,spaceId:space,repositoryId:repository,mode:'enabled'})).toBeUndefined()
    }finally{await runtime.query("UPDATE memory_installations SET local_status='ready' WHERE installation_id=$1",[installation])}

    const staleGrant={installationId:installation,configVersion:'1',userId:1}
    await pool.query('UPDATE public.extension_installations SET config_version=2 WHERE installation_id=$1',[installation])
    try{
     const frame=await resolveLifecycleFrame(runtime,{installationId:installation,sessionId:context.sessionId,repositoryId:repository,spaceId:space,mode:'enabled',authorityGrant:staleGrant})
     expect.soft(frame).toBeUndefined()
    }finally{await pool.query('UPDATE public.extension_installations SET config_version=1 WHERE installation_id=$1',[installation])}

    expect(await resolveLifecycleFrame(runtime,{
     installationId:installation,sessionId:context.sessionId,repositoryId:repository,spaceId:space,mode:'enabled',
     authorityGrant:{...staleGrant,expiresAt:Math.floor(Date.now()/1000)-1},
    })).toBeUndefined()

    const collisionSession='native-scene-frame-clock-race'
    const holder=await runtime.connect()
    try{
     await holder.query('BEGIN')
     await holder.query('INSERT INTO memory_session_scene_frames(installation_id,session_id,binding) VALUES($1,$2,$3)',[installation,collisionSession,'b'.repeat(64)])
     const expiresAt=Date.now()/1000+0.45
     const attempted=resolveLifecycleFrame(runtime,{
      installationId:installation,sessionId:collisionSession,repositoryId:repository,spaceId:space,mode:'enabled',
      authorityGrant:{...staleGrant,expiresAt},
     })
     const {setTimeout:delay}=await import('node:timers/promises')
     let waiting=false
     for(let n=0;n<40&&!waiting;n++){
      const observed=await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
       WHERE pid<>pg_backend_pid() AND query LIKE 'INSERT INTO memory_session_scene_frames(%' AND wait_event_type='Lock') AS waiting`)
      waiting=observed.rows[0].waiting
      if(!waiting)await delay(5)
     }
     expect.soft(waiting).toBe(true)
     await delay(Math.max(0,expiresAt*1000-Date.now()+15))
     await holder.query('ROLLBACK')
     expect.soft(await attempted).toBeUndefined()
     const inserted=await runtime.query('SELECT 1 FROM memory_session_scene_frames WHERE installation_id=$1 AND session_id=$2',[installation,collisionSession])
     expect.soft(inserted.rowCount).toBe(0)
    }finally{
     await holder.query('ROLLBACK')
     holder.release()
    }

    const {createSearchService}=await import('../../retrieval/search-service.js')
    const {createRecallService}=await import('../../retrieval/recall-service.js')
    const entity=randomUUID()
    await runtime.query("INSERT INTO memory_entities(installation_id,space_id,entity_id,kind,name) VALUES($1,$2,$3,'service','fixture')",[installation,space,entity])
    await runtime.query(`INSERT INTO memory_logical_claims(installation_id,space_id,subject_entity_id,logical_key,predicate_id,cardinality,claim_id)
     VALUES($1,$2,$3,repeat('a',64),'service.timeout','single',$4)`,[installation,space,entity,claim])
    try{
     const lifecycle=await resolveLifecycleReadFrame(runtime,{installationId:installation,spaceId:space,repositoryId:repository,mode:'enabled'})
     const search=createSearchService({pool:runtime,recallEmbeddingTimeoutMs:100,cursorSigningKey:'native-scene-fixture'})
     const input={installationId:installation,authorityGrant:staleGrant,query:statement,repositoryId:repository,repoSnapshotId:snapshot,lifecycle}
     const valid=await search.search(input)
     expect(valid.hits.map(hit=>hit.versionId)).toContain(version)
     await pool.query('UPDATE public.extension_installations SET authorization_epoch=3 WHERE installation_id=$1',[installation])
     expect.soft((await search.search(input)).hits).toEqual([])
     const recall=createRecallService(runtime,{...search,search:async()=>valid})
     expect.soft((await recall.recall(input)).claims).toEqual([])
    }finally{
     await pool.query('UPDATE public.extension_installations SET authorization_epoch=2 WHERE installation_id=$1',[installation])
     await runtime.query('DELETE FROM memory_logical_claims WHERE installation_id=$1 AND claim_id=$2',[installation,claim])
    }

    let advancedBeforeConsume=false
    client.beforeNextConsume(async()=>{
     await pool.query('UPDATE public.extension_installations SET authorization_epoch=3 WHERE installation_id=$1',[installation])
     advancedBeforeConsume=true
    })
    await expect.soft(deliver('native-scene-epoch-before-text',(_name,run)=>run())).rejects.toThrow(/text: (404|410)/)
    expect.soft(advancedBeforeConsume).toBe(true)
    const frozen=(await runtime.query(`SELECT p.query_context->'lifecycle'->>'authorizationEpoch' AS epoch,j.state
     FROM memory_context_packs p JOIN memory_context_injections j USING(installation_id,pack_id)
     WHERE p.installation_id=$1 AND p.client_request_id='native-scene-epoch-before-text'`,[installation])).rows[0]
    expect.soft(frozen?.epoch).toBe('2')
    expect.soft(frozen?.state).not.toBe('prepared')
   }finally{await pool.query('UPDATE public.extension_installations SET authorization_epoch=1 WHERE installation_id=$1',[installation])}
   await runtime.query("UPDATE knowledge_evidence SET excerpt_hash=decode(repeat('00',32),'hex') WHERE installation_id=$1 AND evidence_id=$2",[installation,secondEvidence])
   const unproven=await deliver('corrupt-hash',(_name,run)=>run(),{withProvenEvidence:false})
   const proof=(await runtime.query(`SELECT evidence_version_id,excerpt_hash,source_version
     FROM memory_context_pack_evidence WHERE pack_id=$1 AND evidence_id=$2`,[unproven,secondEvidence])).rows[0]
   expect(proof).toEqual({evidence_version_id:null,excerpt_hash:null,source_version:null})
  }finally{await client.close()}
  const legacyFingerprint=async()=>(await runtime.query<{fingerprint:string}>(`
   SELECT md5(COALESCE(string_agg(
    c.claim_id::text||':'||c.state||':'||COALESCE(c.current_version_id::text,'')
     ||':'||memory_delivery_version_available(c.installation_id,c.current_version_id)::text
     ||':'||COALESCE((SELECT md5(string_agg(e.evidence_id::text,',' ORDER BY e.evidence_id))
      FROM knowledge_evidence e WHERE e.installation_id=c.installation_id AND e.version_id=c.current_version_id),''),
    ',' ORDER BY c.claim_id),'')) AS fingerprint
   FROM knowledge_claims c WHERE c.installation_id=$1
  `,[installation])).rows[0].fingerprint
  const before=await legacyFingerprint()
  expect(await readContextCorpusFingerprint(runtime,installation)).toBe(before)
  const teamId=randomUUID(),teamSessionId=randomUUID(),submissionId=randomUUID(),decisionId=randomUUID()
  await runtime.query("UPDATE knowledge_evidence SET locator=$3 WHERE installation_id=$1 AND evidence_id=$2",[
   installation,firstEvidence,{source_provenance:{source_kind:'team_session',source_version:'2',team_id:teamId,team_session_id:teamSessionId,
    accepted_delivery:{submission_id:submissionId,decision_id:decisionId}}},
  ])
  await runtime.query("INSERT INTO memory_team_delivery_withdrawals(team_id,team_session_id,submission_id,decision_id) VALUES($1,$2,$3,$4)",[
   teamId,teamSessionId,submissionId,decisionId,
  ])
  const withdrawn=await legacyFingerprint()
  expect(withdrawn).not.toBe(before)
  expect(await readContextCorpusFingerprint(runtime,installation)).toBe(withdrawn)
 },30000)

 test('machine-concluded claims and excerpts retain current source authority after automatic publication',async()=>{
  const {randomUUID}=await import('node:crypto')
  const {writeLifecycleConclusion}=await import('../../curation/writer.js')
  const {createMemoryReadService}=await import('../../retrieval/read-service.js')
  const {createEvidenceService}=await import('../../claims/evidence-service.js')
  const {createSearchService}=await import('../../retrieval/search-service.js')
  const {assertRetainedVersionResponse}=await import('../../sources/retained-versions.js')
  const installation=randomUUID(),space=randomUUID(),subject=randomUUID(),source=randomUUID(),bundle=randomUUID(),run=randomUUID(),candidate=randomUUID()
  const session='automated-retained-'+source,canonical='9007199254741751',statement='The migration must retain original source UUIDs.'
  const payload={text:statement,turn_id:'machine-turn'},digest=canonicalPayloadHash(payload),at=new Date()
  await pool.query("INSERT INTO public.sessions VALUES($1,1,'daemon','codex','hot','codex')",[session])
  await pool.query("INSERT INTO public.events(id,user_id,session_id,event_type,payload,effect_status,body_storage) VALUES($1,1,$2,'agent_text',$3,'completed','hot')",[canonical,session,payload])
  await pool.query("SELECT shared.mark_memory_source_dirty('relay_event',$1)",['1:'+session])
  await pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,authorization_epoch,config_version,granted_scopes,enabled_services) VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage','memory.search'])",[installation])
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[installation])
  await runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installation])
  await runtime.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)",[installation])
  await runtime.query("INSERT INTO memory_curation_policies(installation_id,mode,consume_mode) VALUES($1,'enabled','enabled')",[installation])
  await runtime.query("INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'work','Migration',ARRAY['personal'])",[installation,space])
  await runtime.query("INSERT INTO memory_entities(installation_id,space_id,entity_id,kind,name) VALUES($1,$2,$3,'project','Migration')",[installation,space,subject])
  await runtime.query("INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,$3,$3)",[installation,session,at])
  await runtime.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,classification,
   source_kind,canonical_key,canonical_session_key,source_version,content_hash,hash_version,mapping_state,adapter_version)
   VALUES($1,$2,'feed',$3,$4,'machine-turn','agent_text',$5,NULL,$6,'{}','relay_event',$3,$4,'{"content":"1","authorization":"1","storage":"0"}',$6,'canonical-json-sha256-v1','verified','v1')`,
  [source,installation,canonical,session,at,digest])
  await runtime.query("INSERT INTO memory_task_bundles(installation_id,bundle_id,task_key,session_id,space_id,source_digest,watermark,bundle_kind) VALUES($1,$2,'machine-task',$3,$4,$5,1,'task')",[installation,bundle,session,space,digest])
  await runtime.query('INSERT INTO memory_task_bundle_sources(installation_id,bundle_id,source_event_id,source_digest,source_sequence) VALUES($1,$2,$3,$4,1)',[installation,bundle,source,digest])
  await runtime.query("INSERT INTO memory_curation_runs(installation_id,run_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state) VALUES($1,$2,$3,1,$4,1,repeat('a',64),repeat('b',64),'enabled','completed')",[installation,run,bundle,digest])
  await runtime.query(`INSERT INTO memory_candidates(candidate_id,installation_id,ordinal,claim_type,statement,normalized_key,scope_kind,scope_key,confidence,freshness_at,evidence_handles,status,source_kind,bundle_id,curation_run_id,bundle_revision)
   VALUES($1,$2,0,'work_method',$3,'machine-fixture','task','machine-task',1,$4,'[]','validated','task_bundle',$5,$6,1)`,[candidate,installation,statement,at,bundle,run])
  const client=await runtime.connect()
  let result:Awaited<ReturnType<typeof writeLifecycleConclusion>>
  try{
   await client.query('BEGIN')
   result=await writeLifecycleConclusion(client,{installationId:installation,candidateId:candidate,runId:run,bundleId:bundle,candidateRevision:1,
    conclusion:{kind:'constraint',assertion_mode:'user_asserted',subject:'Migration',predicate:'workflow.constraint',value:'retain original source UUIDs',conditions:{},fact_at:null,valid_until:null,statement,confirmed:true,evidence:{subject:[source],predicate:[source],value:[source]}},
    identity:{installationId:installation,spaceId:space,subjectEntityId:subject,predicateId:'workflow.constraint',cardinality:'single'},logicalKey:'a'.repeat(64),
    relation:{action:'create',reason:'new_logical_identity',differences:[]},target:null,
    evidence:[{id:source,text:statement,role:'user',occurredAt:at,digest}],tombstoneKeys:[]})
   await client.query('COMMIT')
  }finally{await client.query('ROLLBACK');client.release()}
  const claimId=result.claimId!,versionId=result.versionId!
  const row=(await runtime.query("SELECT e.evidence_id,cap.retention_basis FROM knowledge_evidence e JOIN knowledge_evidence_capsules cap USING(installation_id,capsule_id) WHERE e.installation_id=$1 AND e.version_id=$2",[installation,versionId])).rows[0]
  expect(row.retention_basis).toBe('automation_conclusion')
  const authorityGrant={installationId:installation,configVersion:'1',userId:1}
  const reads=createMemoryReadService(runtime,'fixture')
  const evidence=createEvidenceService(runtime)
  const search=createSearchService({pool:runtime,cursorSigningKey:'fixture',recallEmbeddingTimeoutMs:100})
  const select=()=>assertRetainedVersionResponse(runtime,authorityGrant,[{installationId:installation,versionId,statement}])
  const query=()=>search.search({installationId:installation,query:'retain original source UUIDs',authorityGrant,lifecycle:{spaceId:space,spaceRevision:'1',destination:'personal',policyRevision:'1',authorizationEpoch:'1',consume:true}})
  expect((await reads.listActiveClaims(installation,{authorityGrant})).claims).toMatchObject([{claim_id:claimId,authority:'machine_concluded'}])
  expect(await reads.getClaim(installation,claimId,{authorityGrant})).toMatchObject({claim:{current_version_id:versionId}})
  expect(await evidence.evidenceForVersion({installationId:installation,versionId,authorityGrant})).toMatchObject([{excerpt:statement,locator:{source_event_id:source}}])
  expect(await reads.getEvidence(installation,row.evidence_id,authorityGrant)).toMatchObject({excerpt:statement})
  await expect(select()).resolves.toBeUndefined()
  expect((await query()).hits).toMatchObject([{versionId}])
  await pool.query("UPDATE shared.memory_source_modes SET mode='legacy-feed' WHERE installation_id=$1",[installation])
  expect(await reads.getEvidence(installation,row.evidence_id,authorityGrant)).toBeNull()
  await pool.query("UPDATE shared.memory_source_modes SET mode='shared-shadow' WHERE installation_id=$1",[installation])
  await runtime.query("UPDATE memory_task_bundle_sources SET source_digest=decode(repeat('f',64),'hex') WHERE installation_id=$1 AND bundle_id=$2",[installation,bundle])
  expect(await reads.getClaim(installation,claimId,{authorityGrant})).toBeNull()
  expect(await reads.getEvidence(installation,row.evidence_id,authorityGrant)).toBeNull()
  await runtime.query('UPDATE memory_task_bundle_sources SET source_digest=$3 WHERE installation_id=$1 AND bundle_id=$2',[installation,bundle,digest])
  const {originContextFixture}=await import('../helpers/origin-context-fixture.js')
  const {createPackRepository}=await import('../../context/pack-repository.js')
  const context=await originContextFixture(runtime,installation,{authorityGrant,sceneId:space,query:statement})
  const firstPack=await context.compile('machine-authorized')
  if(firstPack.kind!=='ready')throw Error('machine_compile:'+JSON.stringify(firstPack))
  const firstTicket=await context.admit(firstPack.packId,'machine-authorized')
  if(!firstTicket.ok||!('nonce'in firstTicket))throw Error('machine_admit:'+JSON.stringify(firstTicket))
  const consumed=await context.consume(firstPack.packId,firstTicket.injectionId,firstTicket.nonce)
  if(!consumed.ok)throw Error('machine_consume:'+JSON.stringify(consumed))
  expect(consumed.pack.stableText+consumed.pack.dynamicText).toContain(statement)
  const staleGrantPack=await context.compile('machine-grant-race')
  if(staleGrantPack.kind!=='ready')throw Error('machine_grant_compile:'+JSON.stringify(staleGrantPack))
  const staleGrantTicket=await context.admit(staleGrantPack.packId,'machine-grant-race')
  if(!staleGrantTicket.ok||!('nonce'in staleGrantTicket))throw Error('machine_grant_admit:'+JSON.stringify(staleGrantTicket))
  await pool.query('UPDATE public.extension_installations SET config_version=2 WHERE installation_id=$1',[installation])
  expect(await context.consume(staleGrantPack.packId,staleGrantTicket.injectionId,staleGrantTicket.nonce)).toEqual({ok:false,error:'expired'})
  await pool.query('UPDATE public.extension_installations SET config_version=1 WHERE installation_id=$1',[installation])
  const secondPack=await context.compile('machine-race')
  if(secondPack.kind!=='ready')throw Error('machine_second_compile:'+JSON.stringify(secondPack))
  const secondTicket=await context.admit(secondPack.packId,'machine-race')
  if(!secondTicket.ok||!('nonce'in secondTicket))throw Error('machine_second_admit:'+JSON.stringify(secondTicket))
  const thirdPack=await context.compile('machine-late-admit')
  if(thirdPack.kind!=='ready')throw Error('machine_third_compile:'+JSON.stringify(thirdPack))
  const list=()=>createPackRepository(runtime).listForSession({installationId:installation,sessionId:context.sessionId,authorityGrant})
  expect((await list()).some(pack=>pack.dynamic_text.includes(statement)||pack.stable_text.includes(statement))).toBe(true)
  const {prepareEvidenceSources}=await import('../../sources/evidence-sources.js')
  const prepared=await prepareEvidenceSources(runtime,installation,[row.evidence_id])
  const reading=await runtime.connect()
  try{
   await reading.query('BEGIN')
   await prepared.assertCurrent(reading)
   await pool.query('INSERT INTO public.deleted_sessions(session_id) VALUES($1)',[session])
   await expect(prepared.assertCurrent(reading,{forCommit:true})).rejects.toThrow('source_reference_changed')
  }finally{await reading.query('ROLLBACK');reading.release()}
  expect(await context.consume(secondPack.packId,secondTicket.injectionId,secondTicket.nonce)).toEqual({ok:false,error:'expired'})
  expect(await context.admit(thirdPack.packId,'machine-late-admit')).toEqual({ok:false,error:'claim_invalid'})
  const stalePacks=await list()
  expect(stalePacks).toHaveLength(4)
  expect(stalePacks.every(pack=>pack.state==='invalidated'&&!pack.stable_text&&!pack.dynamic_text&&!pack.items.length)).toBe(true)
  expect((await runtime.query('SELECT state FROM memory_context_injections WHERE injection_id=$1',[secondTicket.injectionId])).rows[0].state).toBe('expired')
  expect(await reads.getClaim(installation,claimId,{authorityGrant})).toBeNull()
  expect(await evidence.evidenceForVersion({installationId:installation,versionId,authorityGrant})).toEqual([])
  expect((await query()).hits).toEqual([])
  await expect(select()).rejects.toThrow('source_reference_changed')
  await runtime.query('DELETE FROM knowledge_claims WHERE installation_id=$1 AND claim_id=$2',[installation,claimId])
  expect((await runtime.query('SELECT 1 FROM memory_context_pack_items WHERE installation_id=$1',[installation])).rowCount).toBe(0)
  expect((await list()).every(pack=>pack.state==='invalidated'&&!pack.stable_text&&!pack.dynamic_text)).toBe(true)
 })


})
