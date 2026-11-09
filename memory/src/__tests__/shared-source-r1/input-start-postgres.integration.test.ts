import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {canonicalPayloadHash,createPostgresSharedSourceReader,encodeArchiveChunk,archiveObjectKey} from '@pocketctl/session-source'
import {inputStartFixture,type InputStartFixture} from './input-start-fixture.js'
const url=process.env.INPUT_START_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('real native publication/start admission through least-privilege Memory SQL',()=>{
 let f:InputStartFixture
 beforeAll(async()=>{f=await inputStartFixture(url!)},60000)
 afterAll(async()=>{await f?.close()})
 test('real Team acceptance publisher runs through the restricted Relay role after repeated schema bootstrap',async()=>{
  // The existing real-service fixture seeds its provider itself; no other
  // installation exists yet in this freshly isolated test database.
  await f.publisher.query("DELETE FROM public.extension_providers WHERE provider_id='pocketctl-memory'")
  const {acceptedDeliveryTransactionFixture}=await f.load('__tests__/fixtures/accepted-delivery-transaction'),t=await acceptedDeliveryTransactionFixture(f.publisher)
  await f.publisher.query("UPDATE public.team_memory_bindings SET installation_id=$2,owner_scope_kind='personal',owner_scope_id=$2 WHERE binding_id=$1",[t.bindingId,t.personal[0]])
  const decision=await t.delivery.decide(t.taskId,t.users[1],t.decision)
  const receipts=(await f.pool.query('SELECT r.source_session_id,p.publication_xid FROM public.team_delivery_memory_sources r JOIN public.native_source_publications p ON p.source_kind=\'team_delivery\' AND p.source_key=r.source_session_id WHERE r.decision_id=$1 ORDER BY r.reader_user_id',[decision.decision_id])).rows
  expect(receipts).toHaveLength(2);expect(receipts[0].publication_xid).toBe(receipts[1].publication_xid)
  await f.pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[t.personal[0]])
  const scope={installationId:t.personal[0],principalUserId:String(t.users[0]),ownerScopeKind:'personal',ownerScopeId:t.personal[0],authorizationRevision:'1',configVersion:'1',modeGeneration:'2',bindingRevision:'1',participantRevision:'1'}
  expect((await f.runtime.query("SELECT shared.read_memory_team_source($1,'team_delivery',$2) AS result_payload",[scope,receipts[0].source_session_id])).rows[0].result_payload.submission.id).toBe(t.submissionId)
  await expect(t.delivery.decide(t.taskId,t.users[0],{...t.decision,request_id:'wrong-actor-runtime'})).rejects.toThrow()
 })
 test('actual from_now native create excludes old event/feed1000 and admits new event/feed1001',async()=>{
  const s=await f.source(),old=await f.event(s);await f.feed(s,old,'1000');const {inst,scope}=await f.install(s);const next=await f.event(s);await f.feed(s,next,'1001')
  expect(inst.start_feed_id).toBe(1000);expect((await f.rows(scope,s)).map(e=>e.id)).toEqual([next])
  expect(await f.rows(scope,s,{ids:[old]})).toEqual([])
 })
 test('source/Feed IDs above 2^53 remain unrelated exact typed strings internally',async()=>{
  const s=await f.source(),old=await f.event(s,{id:'9007199254741097'});await f.feed(s,old,'9007199254740993')
  const {scope,inst}=await f.install(s),next=await f.event(s,{id:'9007199254741099'})
  expect(inst.start_feed_id).toBe('9007199254740993')
  expect((await f.pool.query('SELECT original_feed_id::text FROM public.native_installation_starts WHERE installation_id=$1',[inst.installation_id])).rows[0].original_feed_id).toBe('9007199254740993')
  expect((await f.rows(scope,s)).map(e=>e.id)).toEqual([next])
 })
 test('same body under another ID and wrong owner never inherit original input entitlement',async()=>{
  const s=await f.source(),old=await f.event(s,{text:'same body'}),payload=(await f.pool.query('SELECT payload FROM public.events WHERE id=$1',[old])).rows[0].payload,{scope}=await f.install(s),next=await f.event(s,{payload}),other=await f.source(),wrong=await f.event(other,{payload})
  expect(new Set((await f.pool.query('SELECT canonical_payload_hash FROM public.events WHERE id=ANY($1::bigint[])',[[old,next,wrong]])).rows.map(r=>r.canonical_payload_hash)).size).toBe(1)
  expect((await f.rows(scope,s,{ids:[old,next,wrong]})).map(e=>e.id)).toEqual([next])
 })
 test('retained_history is a separately explicit currently authorized history policy',async()=>{
  const s=await f.source(),old=await f.event(s),{scope}=await f.install(s,'retained_history')
  expect((await f.rows(scope,s)).map(e=>e.id)).toEqual([old])
 })
 test('new no-Feed installation and publication work without transport rows',async()=>{
  const s=await f.source(),old=await f.event(s),{scope}=await f.install(s),next=await f.event(s)
  expect((await f.rows(scope,s)).map(e=>e.id)).toEqual([next]);expect((await f.pool.query("SELECT count(*)::int n FROM public.extension_feed WHERE session_id=$1",[s.session])).rows[0].n).toBe(0)
  expect(await f.rows(scope,s,{ids:[old]})).toEqual([])
 })
 test('pending inserted before start publishes only on actual completed transition afterward',async()=>{
  const s=await f.source(),pending=await f.event(s,{status:'pending'});expect(await f.proof(pending)).toBeUndefined()
  const {scope}=await f.install(s);await f.publisher.query("UPDATE public.events SET effect_status='completed' WHERE id=$1",[pending])
  expect((await f.rows(scope,s)).map(e=>e.id)).toEqual([pending])
 })
 test('allocated smaller ID active at the start snapshot remains eligible when it commits late',async()=>{
  const s=await f.source(),tx=await f.publisher.connect()
  try{await tx.query('BEGIN');const late=await f.event(s,{id:'42',db:tx});const {scope}=await f.install(s);await tx.query('COMMIT');expect((await f.rows(scope,s)).map(e=>e.id)).toEqual([late])}
  finally{await tx.query('ROLLBACK');tx.release()}
 })
 test('old committed large ID is excluded while a later small ID is admitted',async()=>{
  const s=await f.source(),old=await f.event(s,{id:'8000000000000000999'}),{scope}=await f.install(s),next=await f.event(s,{id:'43'})
  expect((await f.rows(scope,s)).map(e=>e.id)).toEqual([next]);expect(old).not.toBe(next)
 })
 test('same top-level transaction distinguishes publication before and after native installation INSERT',async()=>{
  const s=await f.source(),tx=await f.publisher.connect(),id=randomUUID()
  try{await tx.query('BEGIN');const old=await f.event(s,{db:tx});await tx.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory',$2,'active',ARRAY['session:events:read'],ARRAY['session.event.v1'],ARRAY['memory.manage'],'from_now')",[id,s.owner]);const next=await f.event(s,{db:tx});await tx.query('COMMIT')
   await f.pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[id]);const scope={installationId:id,principalUserId:String(s.owner),ownerScopeKind:'personal' as const,ownerScopeId:id,authorizationRevision:'1',configVersion:'1',modeGeneration:'2'}
   expect((await f.rows(scope,s)).map(e=>e.id)).toEqual([next]);const a=await f.proof(old),b=await f.proof(next);expect(a.publication_xid).toBe(b.publication_xid);expect(BigInt(a.publication_order)).toBeLessThan(BigInt(b.publication_order))
  }finally{await tx.query('ROLLBACK');tx.release()}
 })
 test('stale RR and serializable snapshots are explicitly unsupported, without changing caller isolation',async()=>{
  for(const isolation of ['REPEATABLE READ','SERIALIZABLE']){const s=await f.source(),tx=await f.publisher.connect();try{await tx.query('BEGIN ISOLATION LEVEL '+isolation);await tx.query('SELECT txid_current_snapshot()');await f.event(s);await expect(tx.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory',$2,'pending','{}','{}','{}','from_now')",[randomUUID(),s.owner])).rejects.toThrow('native_input_start_isolation_unsupported')}finally{await tx.query('ROLLBACK');tx.release()}}
 })
 test('eligibility filtering precedes LIMIT and explicit IDs cannot restore excluded history',async()=>{
  const s=await f.source(),old=await f.event(s),{scope}=await f.install(s),a=await f.event(s),b=await f.event(s)
  expect((await f.rows(scope,s,{limit:1})).map(e=>e.id)).toEqual([a]);expect((await f.rows(scope,s,{after:a,limit:1})).map(e=>e.id)).toEqual([b]);expect(await f.rows(scope,s,{ids:[old]})).toEqual([])
 })
 test('already processed root and bootstrap cannot broaden a new installation input boundary',async()=>{
  const s=await f.source();await f.event(s);await f.pool.query('UPDATE shared.memory_source_work SET processed_revision=revision WHERE root_key=$1',[f.root(s)])
  const {scope}=await f.install(s);await f.pool.query('SELECT * FROM shared.bootstrap_memory_relay_roots(0,256)');expect(await f.rows(scope,s)).toEqual([])
 })
 test('pause/config/mode changes preserve original start; reinstall gets a new boundary',async()=>{
  const s=await f.source();await f.event(s);const {scope,inst}=await f.install(s),accepted=await f.event(s)
  await f.pool.query("UPDATE public.extension_installations SET status='paused',config_version=2 WHERE installation_id=$1",[inst.installation_id]);await expect(f.rows(scope,s)).rejects.toThrow('source_revoked')
  await f.pool.query("UPDATE public.extension_installations SET status='active',config_version=3 WHERE installation_id=$1",[inst.installation_id]);const resumed={...scope,configVersion:'3'}
  expect((await f.rows(resumed,s)).map(e=>e.id)).toEqual([accepted]);await f.pool.query("UPDATE shared.memory_source_modes SET mode='paused',generation=3 WHERE installation_id=$1",[inst.installation_id]);await expect(f.rows(resumed,s)).rejects.toThrow('source_changed')
  await f.pool.query("UPDATE shared.memory_source_modes SET mode='shared-shadow',generation=4 WHERE installation_id=$1",[inst.installation_id]);expect((await f.rows({...resumed,modeGeneration:'4'},s)).map(e=>e.id)).toEqual([accepted])
  await f.pool.query("UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",[inst.installation_id]);const next=await f.install(s);expect(await f.rows(next.scope,s)).toEqual([])
 })
 test('explicit native Snapshot checkpoint replay does not rewrite original automatic start',async()=>{
  const s=await f.source(),old=await f.event(s),{scope,inst}=await f.install(s),next=await f.event(s)
  const before=(await f.pool.query('SELECT row_to_json(p) AS result_payload FROM public.native_installation_starts p WHERE installation_id=$1',[inst.installation_id])).rows[0].result_payload
  const {resetCheckpointForReplay}=await f.load('extensions/feed-repository');await resetCheckpointForReplay(f.publisher,{installationId:inst.installation_id,ackFeedId:0,startFeedId:0})
  expect((await f.pool.query('SELECT row_to_json(p) AS result_payload FROM public.native_installation_starts p WHERE installation_id=$1',[inst.installation_id])).rows[0].result_payload).toEqual(before)
  expect((await f.rows(scope,s)).map(e=>e.id)).toEqual([next]);expect(await f.rows(scope,s,{ids:[old]})).toEqual([])
 })
 test('native metadata is immutable and inaccessible to runtime writers/readers',async()=>{
  const s=await f.source(),{inst}=await f.install(s),id=await f.event(s)
  expect((await f.publisher.query("SELECT has_schema_privilege(current_user,'memory','USAGE') allowed")).rows[0].allowed).toBe(false)
  await f.native.assertNativeInputStartSchema(f.publisher)
  expect((await f.runtime.query('SELECT shared.memory_input_start_ready() ready')).rows[0].ready).toBe(true)
  expect((await f.publisher.query("SELECT has_function_privilege(current_user,'public.capture_native_event_publication()','EXECUTE') allowed")).rows[0].allowed).toBe(false)
  await expect(f.publisher.query("UPDATE public.native_source_publications SET publication_xid=txid_current() WHERE source_key=$1",[id])).rejects.toMatchObject({code:'42501'})
  await expect(f.runtime.query('SELECT * FROM public.native_installation_starts')).rejects.toMatchObject({code:'42501'})
  await expect(f.publisher.query("SELECT nextval('public.native_input_start_order')")).rejects.toMatchObject({code:'42501'})
  await expect(f.publisher.query("UPDATE public.extension_installations SET start_policy='retained_history' WHERE installation_id=$1",[inst.installation_id])).rejects.toThrow('native_input_start_immutable')
  await expect(f.pool.query("UPDATE public.native_source_publications SET publication_xid=txid_current() WHERE source_key=$1",[id])).rejects.toThrow('native_input_fact_immutable')
  const {prepareMemoryStartup}=await import('../../startup-schema.js'),{assertMemoryNamespace}=await import('../../migrations/shared-db/schema-context.js')
  await expect(f.runtime.query('SELECT * FROM public.native_input_start_contract')).rejects.toMatchObject({code:'42501'})
  await expect(assertMemoryNamespace(f.runtime,'memory')).rejects.toMatchObject({code:'42501'})
  await expect(assertMemoryNamespace(f.runtime,'memory','unknown' as never)).rejects.toThrow('unsupported_memory_schema_intent')
  // Native readiness succeeds; this fixture's existing shadow modes must
  // still hit the independent global consumer cutover gate.
  await expect(prepareMemoryStartup(f.runtime,{databaseNamespace:'memory'})).rejects.toThrow('shared_source_consumers_not_ready')
  await f.pool.query('ALTER TABLE public.native_source_publications DISABLE TRIGGER native_input_immutable')
  try{await expect(prepareMemoryStartup(f.runtime,{databaseNamespace:'memory'})).rejects.toThrow('native_input_start_migrator_required')}
  finally{await f.pool.query('ALTER TABLE public.native_source_publications ENABLE TRIGGER native_input_immutable')}
  await f.pool.query('ALTER TABLE public.native_input_start_contract DISABLE TRIGGER native_input_immutable;UPDATE public.native_input_start_contract SET version=2;ALTER TABLE public.native_input_start_contract ENABLE TRIGGER native_input_immutable')
  try{await expect(prepareMemoryStartup(f.runtime,{databaseNamespace:'memory'})).rejects.toThrow('native_input_start_migrator_required')}
  finally{await f.pool.query('ALTER TABLE public.native_input_start_contract DISABLE TRIGGER native_input_immutable;UPDATE public.native_input_start_contract SET version=1;ALTER TABLE public.native_input_start_contract ENABLE TRIGGER native_input_immutable')}
  // Native readiness succeeds; this fixture's existing shadow modes must
  // still hit the independent global consumer cutover gate.
  await expect(prepareMemoryStartup(f.runtime,{databaseNamespace:'memory'})).rejects.toThrow('shared_source_consumers_not_ready')
 })
 test('installation provider/owner/scope rekey never inherits original boundary',async()=>{
  const s=await f.source(),{scope,inst}=await f.install(s),id=await f.event(s)
  await f.pool.query('UPDATE public.extension_installations SET owner_scope_id=$2 WHERE installation_id=$1',[inst.installation_id,randomUUID()]);await expect(f.rows(scope,s,{ids:[id]})).rejects.toThrow('source_revoked')
  await f.pool.query('UPDATE public.extension_installations SET owner_scope_id=$1 WHERE installation_id=$1',[inst.installation_id]);expect((await f.rows(scope,s)).map(e=>e.id)).toEqual([id])
 })
 test('actual account deletion scrubs A metadata and preserves B; native event/installation IDs cannot resurrect proof',async()=>{
  const a=await f.source(),b=await f.source(),ai=await f.install(a),bi=await f.install(b),ae=await f.event(a),be=await f.event(b),bp=await f.proof(be)
  expect(await f.relay.deleteUserAccount(f.publisher,a.owner)).toBe(true)
  expect(await f.proof(ae)).toMatchObject({retired:true,owner_key:null,source_session_id:null,publication_xid:null,publication_order:null})
  expect(await f.proof(be)).toEqual(bp);expect((await f.rows(bi.scope,b)).map(e=>e.id)).toEqual([be])
  expect((await f.pool.query('SELECT provider_id,owner_user_id,owner_scope_kind,owner_scope_id,retired FROM public.native_installation_starts WHERE installation_id=$1',[ai.inst.installation_id])).rows[0]).toEqual({provider_id:null,owner_user_id:null,owner_scope_kind:null,owner_scope_id:null,retired:true})
  await expect(f.publisher.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory',$2,'pending','{}','{}','{}','from_now')",[ai.inst.installation_id,b.owner])).rejects.toMatchObject({code:'23505'})
  await f.event(b,{id:ae});expect((await f.rows(bi.scope,b)).map(e=>e.id)).toEqual([be])
 })
 test('missing native start and pruned Feed blocks automatic discovery, while an exact already-owned UUID stays explicit only',async()=>{
  const s=await f.source(),old=await f.event(s),{scope,inst}=await f.install(s)
  const e=(await f.pool.query('SELECT payload,canonical_payload_hash,source_sequence::text,source_classification FROM public.events WHERE id=$1',[old])).rows[0],uuid=randomUUID()
  await f.runtime.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,canonical_event_key,session_id,turn_id,event_type,occurred_at,payload,payload_hash,
   source_kind,canonical_key,canonical_session_key,source_version,source_sequence,content_hash,hash_version,mapping_state,adapter_version,source_provenance,classification)
   VALUES($1::uuid,$2,'feed','retained-pruned-'||($1::uuid)::text,$3,$4,'turn','agent_text',NOW(),$5,$6,'relay_event',$7,$4,'{"content":"1","authorization":"1","storage":"1"}',$8,$6,'canonical-json-sha256-v1','verified','feed-v1',$9,$10)`,[uuid,inst.installation_id,'canonical_event:event:'+old,s.session,e.payload,Buffer.from(e.canonical_payload_hash,'hex'),old,e.source_sequence,{memory:e.source_classification.memory_source},e.source_classification])
  await f.pool.query('ALTER TABLE public.native_installation_starts DISABLE TRIGGER native_input_immutable');try{await f.pool.query('DELETE FROM public.native_installation_starts WHERE installation_id=$1',[inst.installation_id])}finally{await f.pool.query('ALTER TABLE public.native_installation_starts ENABLE TRIGGER native_input_immutable')}
  await expect(f.rows(scope,s)).rejects.toThrow('source_input_start_unproven')
  expect((await f.rows(scope,s,{ids:[old]})).map(e=>e.id)).toEqual([old])
  await f.runtime.query("UPDATE source_events SET source_provenance='{}' WHERE source_event_id=$1",[uuid]);await expect(f.rows(scope,s,{ids:[old]})).rejects.toThrow('source_input_start_unproven')
 })
 test('old historical source without publication fact cannot be laundered by a delayed Feed row',async()=>{
  const s=await f.source();await f.pool.query('ALTER TABLE public.events DISABLE TRIGGER native_input_event');let old:string;try{old=await f.event(s)}finally{await f.pool.query('ALTER TABLE public.events ENABLE TRIGGER native_input_event')}
  const {scope}=await f.install(s);await f.feed(s,old,'9007199254741001');await expect(f.rows(scope,s)).rejects.toThrow('source_input_start_unproven');await expect(f.rows(scope,s,{ids:[old]})).rejects.toThrow('source_input_start_unproven')
  const other=await f.source();await f.publisher.query("UPDATE public.extension_feed SET owner_user_id=$2 WHERE source_id=$1",['event:'+old,other.owner])
  await f.publisher.query("INSERT INTO public.extension_feed(feed_id,owner_user_id,topic,source_kind,source_id,session_id,payload) VALUES(9999,$1,'session.event','canonical_event',$2,$3,'{}')",[s.owner,'event:'+old,s.session])
  await expect(f.rows(scope,s)).rejects.toThrow('source_input_start_unproven')

 })
 test('legacy retained_history remains explicit current-authorized history without inventing an MVCC start',async()=>{
  const s=await f.source(),old=await f.event(s),{scope,inst}=await f.install(s,'retained_history')
  await f.pool.query('ALTER TABLE public.native_installation_starts DISABLE TRIGGER native_input_immutable');try{await f.pool.query('DELETE FROM public.native_installation_starts WHERE installation_id=$1',[inst.installation_id])}finally{await f.pool.query('ALTER TABLE public.native_installation_starts ENABLE TRIGGER native_input_immutable')}
  expect((await f.rows(scope,s)).map(e=>e.id)).toEqual([old])
 })
 test('native alias routing keeps original publication/start identity',async()=>{
  const s=await f.source(),old=await f.event(s),{scope}=await f.install(s),next=await f.event(s),before=await f.proof(next),renamed=s.session+'-new'
  await f.relay.renameOwnedDaemonSession(f.publisher,{oldSessionId:s.session,newSessionId:renamed,daemonId:s.daemon,userId:s.owner})
  expect(await f.proof(next)).toEqual(before);expect((await f.rows(scope,{...s,session:renamed})).map(e=>e.id)).toEqual([next]);expect(await f.rows(scope,{...s,session:renamed},{ids:[old]})).toEqual([])
 })
 test('exact already-owned headerless legacy cold ref survives pruning and still verifies archive body hash',async()=>{
  const nativeFixture=await f.load('__tests__/native-session-alias-fixture'),storage=nativeFixture.aliasStorage(),limits=nativeFixture.aliasLimits,s=await f.source(),old=await f.event(s),{scope,inst}=await f.install(s)
  const e=(await f.pool.query('SELECT payload,canonical_payload_hash,source_sequence::text,source_classification FROM public.events WHERE id=$1',[old])).rows[0],uuid=randomUUID()
  await f.runtime.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,canonical_event_key,session_id,turn_id,event_type,occurred_at,payload,payload_hash,
   source_kind,canonical_key,canonical_session_key,source_version,source_sequence,content_hash,hash_version,mapping_state,adapter_version,source_provenance,classification)
   VALUES($1::uuid,$2,'feed','retained-cold-'||($1::uuid)::text,$3,$4,'turn','agent_text',NOW(),$5,$6,'relay_event',$7,$4,'{"content":"1","authorization":"1","storage":"1"}',$8,$6,'canonical-json-sha256-v1','verified','feed-v1',$9,$10)`,[uuid,inst.installation_id,'canonical_event:event:'+old,s.session,e.payload,Buffer.from(e.canonical_payload_hash,'hex'),old,e.source_sequence,{memory:e.source_classification.memory_source},e.source_classification])
  const {enableSessionColdBodies}=await f.load('session-lifecycle/cold-schema');await enableSessionColdBodies(f.pool)
  const manifest=randomUUID(),epoch=String((await f.pool.query('SELECT activity_epoch::text FROM public.sessions WHERE session_id=$1',[s.session])).rows[0].activity_epoch),encoded=await encodeArchiveChunk({userId:s.owner,sessionId:s.session,activityEpoch:epoch,manifestId:manifest,ordinal:0},[{id:old,eventType:'agent_text',payload:e.payload}],limits),m=encoded.manifest,key=archiveObjectKey(manifest,0)
  await storage.put(key,encoded.bytes)
  await f.pool.query("INSERT INTO public.session_archive_manifests(manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,published_at,storage_namespace) VALUES($1,$2,$3,$4,1,'gzip','published',$5,NOW(),$6)",[manifest,s.owner,s.session,epoch,old,storage.namespace])
  await f.pool.query('INSERT INTO public.session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256) VALUES($1,0,$2,$3,$3,1,$4,$5,$6,$7)',[manifest,key,old,m.rawBytes,m.compressedBytes,m.rawSha256,m.compressedSha256])
  await f.pool.query("UPDATE public.events SET body_storage='cold',payload=NULL,body_session_id=$1,body_manifest_id=$2,body_chunk_ordinal=0,body_owner_user_id=$3,body_activity_epoch=$4,source_header_version=NULL,source_sequence=NULL,canonical_payload_hash=NULL,source_classification=NULL WHERE id=$5",[s.session,manifest,s.owner,epoch,old])
  await f.publisher.query("DELETE FROM public.extension_source_outbox WHERE source_kind='canonical_event' AND source_id=$1",['event:'+old])
  expect(await f.rows(scope,s)).toEqual([])
  const reader=createPostgresSharedSourceReader(f.runtime,{storage,limits}),root={kind:'relay_event' as const,key:f.root(s)},page=await reader.getHeads(scope,root,[old])
  expect((await reader.resolveBodies(scope,root,page.heads,page.version))[0].payload).toEqual(e.payload)
  await f.runtime.query("UPDATE source_events SET content_hash=decode(repeat('ff',32),'hex') WHERE source_event_id=$1",[uuid])
  const wrongHash=createPostgresSharedSourceReader(f.runtime,{storage,limits}),wrongPage=await wrongHash.getHeads(scope,root,[old]);await expect(wrongHash.resolveBodies(scope,root,wrongPage.heads,wrongPage.version)).rejects.toThrow()
  await f.runtime.query('UPDATE source_events SET content_hash=$2 WHERE source_event_id=$1',[uuid,Buffer.from(e.canonical_payload_hash,'hex')])
  await storage.put(key,Buffer.from('corrupt archive bytes'))
  const fresh=createPostgresSharedSourceReader(f.runtime,{storage,limits}),freshPage=await fresh.getHeads(scope,root,[old]);await expect(fresh.resolveBodies(scope,root,freshPage.heads,freshPage.version)).rejects.toThrow()
 })
 test('mixed same-owner cold chunk hydrates only admitted heads; old IDs cannot bypass via IO/cache',async()=>{
  const nativeFixture=await f.load('__tests__/native-session-alias-fixture'),storage=nativeFixture.aliasStorage(),limits=nativeFixture.aliasLimits,s=await f.source()
  const old=await f.event(s),{scope}=await f.install(s),next=await f.event(s)
  const {enableSessionColdBodies}=await f.load('session-lifecycle/cold-schema');await enableSessionColdBodies(f.pool)
  const manifest=randomUUID(),epoch=String((await f.pool.query('SELECT activity_epoch::text FROM public.sessions WHERE session_id=$1',[s.session])).rows[0].activity_epoch)
  const events=(await f.pool.query('SELECT id::text,event_type,payload FROM public.events WHERE id=ANY($1::bigint[]) ORDER BY id',[[old,next]])).rows
  const encoded=await encodeArchiveChunk({userId:s.owner,sessionId:s.session,activityEpoch:epoch,manifestId:manifest,ordinal:0},events.map(e=>({id:e.id,eventType:e.event_type,payload:e.payload})),limits),m=encoded.manifest,key=archiveObjectKey(manifest,0)
  await storage.put(key,encoded.bytes)
  await f.pool.query("INSERT INTO public.session_archive_manifests(manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,published_at,storage_namespace) VALUES($1,$2,$3,$4,1,'gzip','published',$5,NOW(),$6)",[manifest,s.owner,s.session,epoch,next,storage.namespace])
  await f.pool.query('INSERT INTO public.session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256) VALUES($1,0,$2,$3,$4,2,$5,$6,$7,$8)',[manifest,key,old,next,m.rawBytes,m.compressedBytes,m.rawSha256,m.compressedSha256])
  await f.pool.query("UPDATE public.events SET body_storage='cold',payload=NULL,body_session_id=$1,body_manifest_id=$2,body_chunk_ordinal=0,body_owner_user_id=$3,body_activity_epoch=$4 WHERE id=ANY($5::bigint[])",[s.session,manifest,s.owner,epoch,[old,next]])
  expect(await f.rows(scope,s,{ids:[old]})).toEqual([])
  expect((await f.pool.query('SELECT shared.read_memory_relay_archive($1,$2,$3,0) manifest',[scope,f.root(s),manifest])).rows[0].manifest.manifest_id).toBe(manifest)
  const reader=createPostgresSharedSourceReader(f.runtime,{storage,limits}),page=await reader.getHeads(scope,{kind:'relay_event',key:f.root(s)},[next])
  const resolved=await reader.resolveBodies(scope,{kind:'relay_event',key:f.root(s)},page.heads,page.version)
  expect(resolved.map(e=>e.head.canonicalKey)).toEqual([next]);expect(resolved[0].payload).toEqual(events.find(e=>e.id===next).payload)
  await expect(reader.getHeads(scope,{kind:'relay_event',key:f.root(s)},[old])).rejects.toThrow()
  expect((await reader.listHeads(scope,{kind:'relay_event',key:f.root(s)},{limit:256})).heads.map(e=>e.canonicalKey)).toEqual([next])
  await f.publisher.query('DELETE FROM public.events WHERE id=$1',[next])
  expect((await f.pool.query('SELECT shared.read_memory_relay_archive($1,$2,$3,0) manifest',[scope,f.root(s),manifest])).rows[0].manifest).toBeNull()
  await expect(reader.resolveBodies(scope,{kind:'relay_event',key:f.root(s)},page.heads,page.version)).rejects.toThrow()
 })
 test('final source fence still excludes native privacy/rename writers until physical COMMIT',async()=>{
  const s=await f.source(),{scope}=await f.install(s);await f.event(s)
  const a=(await f.runtime.query("SELECT * FROM shared.memory_relay_source_authority($1,'relay_event',$2)",[scope,f.root(s)])).rows[0],version={content:a.content_revision,authorization:a.authorization_revision,storage:a.storage_revision},tx=await f.runtime.connect()
  try{await tx.query('BEGIN');expect((await tx.query("SELECT shared.lock_memory_personal_source_commit($1,'relay_event',$2,$3,FALSE) AS source_locked",[scope,f.root(s),version])).rows[0].source_locked).toBe(true)
   await expect(f.publisher.query('INSERT INTO public.deleted_sessions(session_id) VALUES($1)',[s.session])).rejects.toMatchObject({code:'55P03'})
   await expect(f.relay.renameOwnedDaemonSession(f.publisher,{oldSessionId:s.session,newSessionId:s.session+'-blocked',daemonId:s.daemon,userId:s.owner})).rejects.toMatchObject({code:'55P03'})
   await tx.query('COMMIT');expect((await f.rows(scope,s)).length).toBe(1)
  }finally{await tx.query('ROLLBACK');tx.release()}
 })
 test('per-installation cutover rejects missing original from_now proof without successful CAS/work/control side effects',async()=>{
  const s=await f.source(),{inst}=await f.install(s)
  await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  await f.pool.query('ALTER TABLE public.native_installation_starts DISABLE TRIGGER native_input_immutable');try{await f.pool.query('DELETE FROM public.native_installation_starts WHERE installation_id=$1',[inst.installation_id])}finally{await f.pool.query('ALTER TABLE public.native_installation_starts ENABLE TRIGGER native_input_immutable')}
  const before=(await f.pool.query('SELECT row_to_json(m) AS result_payload FROM shared.memory_source_modes m WHERE installation_id=$1',[inst.installation_id])).rows[0].result_payload,work=(await f.pool.query('SELECT count(*)::text n FROM shared.memory_source_work')).rows[0].n
  for(const mode of ['shared-shadow','shared-active'])await expect(f.pool.query('SELECT shared.transition_memory_source_mode($1,2,$2)',[inst.installation_id,mode])).rejects.toThrow('source_input_start_unproven')
  expect((await f.pool.query('SELECT row_to_json(m) AS result_payload FROM shared.memory_source_modes m WHERE installation_id=$1',[inst.installation_id])).rows[0].result_payload).toEqual(before)
  expect((await f.pool.query('SELECT count(*)::text n FROM shared.memory_source_work')).rows[0].n).toBe(work)
  expect((await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'paused')::text generation",[inst.installation_id])).rows[0].generation).toBe('3')
 })
 test('valid new boundary and legacy retained_history can cut over, but original identity/status mismatch cannot',async()=>{
  const s=await f.source(),{inst}=await f.install(s)
  expect((await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')::text generation",[inst.installation_id])).rows[0].generation).toBe('3')
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,3,'paused')",[inst.installation_id])
  await f.pool.query('UPDATE public.extension_installations SET owner_scope_id=$2 WHERE installation_id=$1',[inst.installation_id,randomUUID()])
  await expect(f.pool.query("SELECT shared.transition_memory_source_mode($1,4,'shared-active')",[inst.installation_id])).rejects.toThrow('source_input_start_unproven')
  const old=await f.source(),history=await f.install(old,'retained_history');await f.pool.query('ALTER TABLE public.native_installation_starts DISABLE TRIGGER native_input_immutable');try{await f.pool.query('DELETE FROM public.native_installation_starts WHERE installation_id=$1',[history.inst.installation_id])}finally{await f.pool.query('ALTER TABLE public.native_installation_starts ENABLE TRIGGER native_input_immutable')}
  expect((await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-shadow')::text generation",[history.inst.installation_id])).rows[0].generation).toBe('3')
 })
 test('future shared input version is rejected by explicit migrator before any new contract DDL',async()=>{
  await f.pool.query('UPDATE shared.memory_source_contract SET input_start_version=2');try{const {applySharedSourceContract}=await import('../../migrations/shared-db/contract.js');await expect(applySharedSourceContract(f.pool)).rejects.toThrow('unsupported_shared_input_start_contract')}finally{await f.pool.query('UPDATE shared.memory_source_contract SET input_start_version=1')}
 })
 const nativeDrift=[
  ['ledger','DROP TABLE public.native_source_publications','native_input_start_history_missing'],
  ['column','ALTER TABLE public.native_source_publications DROP COLUMN publication_xid','native_input_start_history_missing'],
  ['sequence','DROP SEQUENCE public.native_input_start_order','native_input_start_history_missing'],
  ['guard','ALTER TABLE public.native_installation_starts DISABLE TRIGGER native_input_immutable','native_input_start_history_missing'],
  ['whole-native-set',`DROP TABLE public.native_source_publications,public.native_installation_starts,public.native_input_start_contract;DROP SEQUENCE public.native_input_start_order;DROP FUNCTION public.capture_native_installation_start() CASCADE`,'native_input_start_history_missing'],
  ['future',`ALTER TABLE public.native_input_start_contract DISABLE TRIGGER native_input_immutable;UPDATE public.native_input_start_contract SET version=2`,'unsupported_native_input_start_contract'],
 ] as const
 for(const entry of ['Memory schema','shared contract'])test.each(nativeDrift)(entry+' refuses %s drift before any schema mutation',async(_name,drift,error)=>{
  const {applyMemorySchema}=await import('../../schema.js'),{applySharedSourceContract}=await import('../../migrations/shared-db/contract.js'),c=await f.pool.connect(),mutations:string[]=[]
  // Actual PostgreSQL reads. The tripwire stops a regressed entry at its first
  // DDL, preserving this owning fixture's mature ledger for later cases.
  const q=async(text:string,values?:unknown[])=>{if(!/^(SELECT|SHOW|BEGIN|COMMIT|ROLLBACK)\b/i.test(text.trim())){mutations.push(text);throw Error('unexpected_schema_mutation_before_refusal')}return c.query(text,values)}
  const db={query:q,connect:async()=>({query:q,release:()=>{}})} as unknown as typeof f.pool
  const memoryState=async()=>JSON.stringify((await c.query("SELECT n.nspname,c.relname,c.oid::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('memory','shared') ORDER BY 1,2")).rows)
  const baseline=await memoryState()
  try{await c.query('BEGIN');await c.query(drift)
   // Semantic capture is part of the already-promised native schema. Its
   // stricter preflight can detect loss before the older input-start audit.
   await expect(entry==='Memory schema'?applyMemorySchema(db,{namespace:'memory'}):applySharedSourceContract(db)).rejects.toThrow(new RegExp('^('+error+'|native_team_semantic_history_missing)$'))
   expect(mutations).toEqual([])
  }finally{await c.query('ROLLBACK');expect(await memoryState()).toBe(baseline);c.release()}
 })
 test('promised semantic history cannot become native0; native1/shared0 and repeated v1 remain valid',async()=>{
  const {assertMemoryNamespace}=await import('../../migrations/shared-db/schema-context.js'),{applySharedSourceContract}=await import('../../migrations/shared-db/contract.js'),c=await f.pool.connect()
  try{await c.query('BEGIN');await c.query('UPDATE shared.memory_source_contract SET input_start_version=0');await c.query(nativeDrift[4][1]);await expect(assertMemoryNamespace(c as unknown as typeof f.pool,'memory')).rejects.toThrow('native_team_semantic_history_missing')}finally{await c.query('ROLLBACK');c.release()}
  await f.pool.query('UPDATE shared.memory_source_contract SET input_start_version=0');await applySharedSourceContract(f.pool);await applySharedSourceContract(f.pool)
  expect((await f.pool.query('SELECT input_start_version FROM shared.memory_source_contract')).rows[0].input_start_version).toBe(1)
 })
 test('current authority revocation still denies a body prepared before IO',async()=>{
  const s=await f.source(),{scope,inst}=await f.install(s),id=await f.event(s),reader=createPostgresSharedSourceReader(f.runtime),root={kind:'relay_event' as const,key:f.root(s)},page=await reader.getHeads(scope,root,[id])
  await f.pool.query("UPDATE public.extension_installations SET status='revoked',authorization_epoch=authorization_epoch+1 WHERE installation_id=$1",[inst.installation_id])
  await expect(reader.resolveBodies(scope,root,page.heads,page.version)).rejects.toThrow()
 })
})
