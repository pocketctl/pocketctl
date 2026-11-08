import {fingerprint} from '../../migrations/shared-source/report.js'
import pg from 'pg'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {canonicalPayloadHash} from '../../inbox/canonical-json.js'
import {adaptTeamSource} from '../../episodes/team-source-adapter.js'
import {relayPureModule} from '../../migrations/shared-source/archive.js'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { openSnapshot, type DatabaseConfig } from '../../migrations/shared-source/database.js'
import { inventoryDatabase } from '../../migrations/shared-source/inventory.js'
import { scanMapping,countSourceRows } from '../../migrations/shared-source/scanner.js'
const url=process.env.SHARED_SOURCE_TEST_DATABASE_URL
const suite=url?describe:describe.skip
suite('independent read-only maintenance snapshot',()=>{
 let pool:pg.Pool, config:DatabaseConfig
 beforeAll(async()=>{
  pool=new pg.Pool({connectionString:url})
  const identity=(await pool.query(`SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort"`)).rows[0]
  if(!/(^|_)test(_|$)/.test(identity.database))throw Error('isolated test database required')
  config={connectionString:url!,expected:{...identity,mode:'isolated-restore'}}
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE TABLE public.source_events (source_event_id uuid PRIMARY KEY,installation_id uuid NOT NULL,origin text,origin_position text,canonical_event_key text,session_id text,turn_id text,event_type text,occurred_at timestamptz,payload jsonb,payload_hash bytea,source_provenance jsonb,classification jsonb,body_reclaimed_at timestamptz);
   CREATE TABLE public.memory_feed_inbox(installation_id uuid,feed_id bigint,source_kind text,source_id text,session_id text,turn_id text,event_type text,data jsonb,classification jsonb);
   CREATE TABLE public.memory_snapshot_events(installation_id uuid,session_id text,relay_event_id bigint,event_type text,payload jsonb);
   CREATE TABLE public.extension_installations(installation_id uuid,owner_user_id int,status text,provider_id text DEFAULT 'pocketctl-memory');
   CREATE TABLE public.extension_providers(provider_id text PRIMARY KEY,status text);INSERT INTO public.extension_providers VALUES('pocketctl-memory','enabled');
   CREATE TABLE public.events(id bigint PRIMARY KEY,session_id text,event_type text,payload jsonb,user_id int,body_storage text);
   CREATE TABLE public.extension_source_outbox(source_seq bigint,source_kind text,source_id text,owner_user_id int,session_id text,event_type text,payload jsonb);
   CREATE TABLE public.extension_feed(feed_id bigint,source_kind text,source_id text,owner_user_id int,session_id text,payload jsonb);
   CREATE TABLE public.deleted_sessions(session_id text, user_id int);
   CREATE SEQUENCE public.inventory_counter;
   CREATE INDEX inventory_events_session ON public.events(session_id);
   CREATE FUNCTION public.inventory_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
   CREATE TRIGGER inventory_event_insert BEFORE INSERT ON public.events FOR EACH ROW EXECUTE FUNCTION public.inventory_trigger();
   ALTER TABLE public.memory_snapshot_events ADD CONSTRAINT snapshot_event_fk FOREIGN KEY(relay_event_id) REFERENCES public.events(id);
   DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_source_denied') THEN CREATE ROLE shared_source_denied; END IF; END $$;
   GRANT CONNECT ON DATABASE shared_source_test TO shared_source_denied;
  `)
  const {canonicalPayloadHash}=await import('../../inbox/canonical-json.js')
  const proof={version:1,producer:'codex',session_id:'session',turn_id:'turn',event_id:'wire-1',sequence:'19',invocation_id:'inv-1',source_role:'assistant',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}
  const payload={text:'DO NOT EXPORT',event_id:'wire-1',turn_id:'turn',memory_source:proof}
  for(let i=1;i<=3;i++){
   const id=`00000000-0000-0000-0000-${String(i).padStart(12,'0')}`
   await pool.query(`INSERT INTO source_events VALUES($1,$2,'feed',$3,'event_id:wire-1','session','turn','agent_text',NOW(),$4,$5,$6,$7,NULL)`,[id,'10000000-0000-0000-0000-000000000001',String(i),payload,canonicalPayloadHash(payload),{memory:proof},{memory_source:proof}])
   await pool.query(`INSERT INTO memory_feed_inbox VALUES($1,$2,'canonical_event','event:9007199254740993','session','turn','agent_text',$3,$4)`,['10000000-0000-0000-0000-000000000001',String(i),payload,{memory_source:proof}])
  }
  await pool.query(`INSERT INTO extension_installations(installation_id,owner_user_id,status) VALUES('10000000-0000-0000-0000-000000000001',1,'active')`)
  await pool.query(`INSERT INTO events VALUES(9007199254740993,'session','agent_text',$1,1,'hot')`,[payload])
  await pool.query(`INSERT INTO extension_source_outbox VALUES(19,'canonical_event','event:9007199254740993',1,'session','agent_text',$1)`,[payload])
 })
 afterAll(async()=>{await pool?.end()})
 test('exact UUID refinements remain explicitly partial even when every selected row is proved',async()=>{
  const ids=(await pool.query('SELECT source_event_id::text FROM public.source_events ORDER BY source_event_id')).rows.map(r=>r.source_event_id)
  const scan=async(sourceIds:string[])=>{const a=await openSnapshot(config),b=await openSnapshot(config);try{return await scanMapping(a,b,{sourceIds,onDetail:async()=>{}})}finally{await a.close();await b.close()}}
  expect(await scan([ids[0]])).toMatchObject({total:'3',scanned:'1',fullMappingExecuted:false,selectedMappingExecuted:true,selectedProofsComplete:true,selectedMissingRows:'0',migrationReady:false})
  expect(await scan(ids)).toMatchObject({scanned:'3',fullMappingExecuted:false,selectedMappingExecuted:true,mappingProofsComplete:false})
  expect(await scan([ids[0],'ffffffff-ffff-ffff-ffff-ffffffffffff'])).toMatchObject({scanned:'1',fullMappingExecuted:false,selectedMappingExecuted:false,selectedProofsComplete:false,selectedMissingRows:'1'})
  await expect(scan([ids[0],ids[0]])).rejects.toThrow('invalid_source_selection')
 })
 test('a surviving exact Relay v1 Feed envelope proves original sequence after Journal retention without promoting unknown provenance',async()=>{
  const original=(await pool.query('SELECT payload FROM public.events LIMIT 1')).rows[0].payload
  const payload={...original,memory_source:{...original.memory_source,sequence:'1'}}
  const envelope={envelope_version:1,source:{kind:'canonical_event',id:'event:9007199254740993'},subject:{session_id:'session',turn_id:'turn',event_type:'agent_text'},classification:{memory_source:original.memory_source},data:payload}
  const scan=async()=>{const a=await openSnapshot(config),b=await openSnapshot(config);try{return await scanMapping(a,b,{onDetail:async()=>{}})}finally{await a.close();await b.close()}}
  try{
   await pool.query('UPDATE public.events SET payload=$1',[payload])
   await pool.query('UPDATE public.source_events SET payload=$1,payload_hash=$2',[payload,canonicalPayloadHash(payload)])
   await pool.query('UPDATE public.memory_feed_inbox SET data=$1',[payload])
   await pool.query('DELETE FROM public.extension_source_outbox')
   for(let n=1;n<=3;n++)await pool.query("INSERT INTO public.extension_feed VALUES($1,'canonical_event','event:9007199254740993',1,'session',$2)",[n,envelope])
   expect((await scan()).counts['unique-hot']).toBe('3')
   for(const bad of [{...envelope,envelope_version:2},{...envelope,subject:{...envelope.subject,event_type:'different'}},{...envelope,classification:{memory_source:{...original.memory_source,sequence:'20'}}}]){
    await pool.query('UPDATE public.extension_feed SET payload=$1',[bad])
    expect((await scan()).counts['unique-hot']).toBe('0')
   }
   await pool.query('UPDATE public.extension_feed SET payload=$1',[envelope])
   await pool.query("UPDATE public.source_events SET source_provenance='{}'")
   expect((await scan()).counts.unproven).toBe('3')
  }finally{
   await pool.query('DELETE FROM public.extension_feed WHERE feed_id IN(1,2,3)')
   await pool.query('UPDATE public.events SET payload=$1',[original])
   await pool.query('UPDATE public.source_events SET payload=$1,payload_hash=$2,source_provenance=$3',[original,canonicalPayloadHash(original),{memory:original.memory_source}])
   await pool.query('UPDATE public.memory_feed_inbox SET data=$1',[original])
   await pool.query("INSERT INTO public.extension_source_outbox VALUES(19,'canonical_event','event:9007199254740993',1,'session','agent_text',$1)",[original])
  }
 })
 test('exact retained transport proves unknown original identity without manufacturing lineage or order',async()=>{
  const id='70000000-0000-0000-0000-000000000099',installation='10000000-0000-0000-0000-000000000001',at='2026-11-08T13:49:18.126Z'
  const payload={event_id:'synthetic-ingress-42',turn_id:'unknown-turn',tool:'synthetic',input:'DO NOT EXPORT',seq:71,actor_scope:'assistant'},classification={actor_scope:'assistant'}
  const envelope={envelope_version:1,source:{kind:'canonical_event',id:'event:42'},subject:{session_id:'unknown-session',turn_id:'unknown-turn',event_type:'tool_call'},classification,data:payload}
  await pool.query(`ALTER TABLE public.events ADD COLUMN created_at timestamptz;
   ALTER TABLE public.extension_installations ADD COLUMN owner_scope_kind text DEFAULT 'personal',ADD COLUMN owner_scope_id text DEFAULT 'scope',ADD COLUMN authorization_epoch bigint DEFAULT 1,ADD COLUMN config_version bigint DEFAULT 1;
   CREATE TABLE public.memory_owner_scopes(installation_id uuid,owner_scope_kind text,owner_scope_id text,state text,authorization_epoch bigint);
   CREATE TABLE public.memory_installations(installation_id uuid,provider_id text,config_version bigint);
   CREATE TABLE public.sessions(session_id text,user_id int,daemon_id text);CREATE TABLE public.daemons(daemon_id text,user_id int);
   INSERT INTO public.sessions VALUES('unknown-session',1,'unknown-daemon');INSERT INTO public.daemons VALUES('unknown-daemon',1);`)
  await pool.query("INSERT INTO public.memory_owner_scopes VALUES($1,'personal','scope','active',1);",[installation])
  await pool.query("INSERT INTO public.memory_installations VALUES($1,'pocketctl-memory',1)",[installation])
  await pool.query("INSERT INTO public.events(id,session_id,event_type,payload,user_id,body_storage,created_at) VALUES(42,'unknown-session','tool_call',$1,1,'hot',$2)",[payload,at])
  await pool.query("INSERT INTO public.source_events VALUES($1,$2,'feed','42','original-wire','unknown-session','unknown-turn','tool_call',$3,$4,$5,'{}',$6,NULL)",[id,installation,at,payload,canonicalPayloadHash(payload),classification])
  await pool.query("INSERT INTO public.memory_feed_inbox VALUES($1,42,'canonical_event','event:42','unknown-session','unknown-turn','tool_call',$2,$3)",[installation,payload,classification])
  await pool.query("INSERT INTO public.extension_feed VALUES(42,'canonical_event','event:42',1,'unknown-session',$1)",[envelope])
  let archive:{directory:string;namespace:string}|undefined
  const scan=async(preNativeLogicalPreparation=false)=>{const a=await openSnapshot(config),b=await openSnapshot(config),details:any[]=[];try{await scanMapping(a,b,{preNativeLogicalPreparation,archive,sourceIds:[id],onDetail:async row=>{details.push(row)}});return details[0]}finally{await a.close();await b.close()}}
  try{
   const mapped=await scan()
   expect(mapped).toMatchObject({sourceEventId:id,state:'unique-hot',canonicalId:'42',provenanceState:'unknown',replacementProven:true,deletionEligible:false,originalIdentityManifest:{kind:'retained-feed-v1-original-identity',sourceSequence:null,journalOrderProven:false,runtimeAuthorizationGranted:false}})
   expect(mapped.sourceSequence).toBeUndefined();expect(mapped.sourceVersion).toBeUndefined();expect(mapped.originalIdentityManifestHash).toMatch(/^[a-f0-9]{64}$/)
   expect(JSON.stringify(mapped)).not.toContain('DO NOT EXPORT')
   // Planning may reuse metadata only inside these same immutable RR
   // snapshots. A new snapshot must observe changed control facts; neither
   // result is a current native/runtime authorization grant.
   const a=await openSnapshot(config),b=await openSnapshot(config)
   let localScopeQueries=0;const query=a.client.query.bind(a.client)
   a.client.query=((...args:any[])=>{if(String(args[0]).includes('FROM public.memory_owner_scopes'))localScopeQueries++;return (query as any)(...args)}) as typeof a.client.query
   try{
    const run=async()=>{const details:any[]=[];await scanMapping(a,b,{sourceIds:[id],onDetail:async row=>{details.push(row)}});return details[0]}
    expect(await run()).toMatchObject({state:'unique-hot',originalIdentityManifest:{configVersion:'1',runtimeAuthorizationGranted:false}});expect(localScopeQueries).toBe(1)
    await pool.query('UPDATE public.extension_installations SET config_version=2 WHERE installation_id=$1',[installation])
    expect(await run()).toMatchObject({state:'unique-hot',originalIdentityManifest:{configVersion:'1',runtimeAuthorizationGranted:false}});expect(localScopeQueries).toBe(1)
    expect((await scan()).replacementProven).toBe(false)
   }finally{await a.close();await b.close();await pool.query('UPDATE public.extension_installations SET config_version=1 WHERE installation_id=$1',[installation])}
   // The original immutable Inbox hash survives transport body retention.
   // A pruned Feed is proved only by reconstructing that exact wire envelope.
   await pool.query('ALTER TABLE public.memory_feed_inbox ADD COLUMN envelope_version integer,ADD COLUMN topic text,ADD COLUMN recorded_at timestamptz,ADD COLUMN payload_hash bytea,ADD COLUMN body_reclaimed_at timestamptz')
   const wire={...envelope,feed_id:'42',topic:'session.event.v1',source:{...envelope.source,recorded_at:at}}
   await pool.query('UPDATE public.memory_feed_inbox SET envelope_version=1,topic=$1,recorded_at=$2,payload_hash=$3 WHERE feed_id=42',[wire.topic,at,canonicalPayloadHash(wire)])
   await pool.query('DELETE FROM public.extension_feed WHERE feed_id=42')
   expect(await scan()).toMatchObject({state:'unique-hot',provenanceState:'unknown',originalIdentityManifest:{kind:'retained-inbox-v1-original-identity',sourceSequence:null,journalOrderProven:false,inboxBodyReclaimed:false}})
   await pool.query("UPDATE public.memory_feed_inbox SET data='{}',classification='{}',body_reclaimed_at=NOW() WHERE feed_id=42")
   expect(await scan()).toMatchObject({state:'unique-hot',provenanceState:'unknown',originalIdentityManifest:{kind:'retained-inbox-v1-original-identity',inboxBodyReclaimed:true}})
   for(const [change,restore] of [
    ["UPDATE public.memory_feed_inbox SET payload_hash=decode(repeat('00',32),'hex') WHERE feed_id=42",'hash'],
    ["UPDATE public.memory_feed_inbox SET source_id='event:43' WHERE feed_id=42","UPDATE public.memory_feed_inbox SET source_id='event:42' WHERE feed_id=42"],
    ["UPDATE public.memory_feed_inbox SET body_reclaimed_at=NULL WHERE feed_id=42","UPDATE public.memory_feed_inbox SET body_reclaimed_at=NOW() WHERE feed_id=42"],
    ["UPDATE public.memory_feed_inbox SET classification='{\"actor_scope\":\"assistant\"}' WHERE feed_id=42","UPDATE public.memory_feed_inbox SET classification='{}' WHERE feed_id=42"],
   ]){await pool.query(change);try{expect((await scan()).replacementProven).toBe(false)}finally{if(restore==='hash')await pool.query('UPDATE public.memory_feed_inbox SET payload_hash=$1 WHERE feed_id=42',[canonicalPayloadHash(wire)]);else await pool.query(restore)}}
   const retained=await scan();expect(retained.sourceSequence).toBeUndefined();expect(retained.sourceVersion).toBeUndefined();expect(JSON.stringify(retained)).not.toContain('DO NOT EXPORT')
   await pool.query('UPDATE public.memory_feed_inbox SET data=$1,classification=$2,body_reclaimed_at=NULL WHERE feed_id=42',[payload,classification])
   await pool.query("INSERT INTO public.extension_feed VALUES(42,'canonical_event','event:42',1,'unknown-session',$1)",[envelope])
   for(const bad of [{...envelope,envelope_version:2},{...envelope,source:{...envelope.source,id:'event:43'}},{...envelope,subject:{...envelope.subject,turn_id:'wrong'}},{...envelope,classification:{}},{...envelope,data:{...payload,input:'wrong'}}]){
    await pool.query('UPDATE public.extension_feed SET payload=$1 WHERE feed_id=42',[bad]);expect((await scan()).replacementProven).toBe(false)
   }
   await pool.query('UPDATE public.extension_feed SET payload=$1 WHERE feed_id=42',[envelope])
   for(const [change,restore] of [
    ["UPDATE public.events SET created_at=created_at+interval '1 millisecond' WHERE id=42","UPDATE public.events SET created_at=created_at-interval '1 millisecond' WHERE id=42"],
    ["UPDATE public.daemons SET user_id=2","UPDATE public.daemons SET user_id=1"],
    ["UPDATE public.sessions SET user_id=2","UPDATE public.sessions SET user_id=1"],
    ["UPDATE public.memory_owner_scopes SET authorization_epoch=2","UPDATE public.memory_owner_scopes SET authorization_epoch=1"],
    ["UPDATE public.memory_installations SET config_version=2","UPDATE public.memory_installations SET config_version=1"],
    ["UPDATE public.extension_feed SET owner_user_id=2 WHERE feed_id=42","UPDATE public.extension_feed SET owner_user_id=1 WHERE feed_id=42"],
    ["UPDATE public.memory_feed_inbox SET classification='{}' WHERE feed_id=42",`UPDATE public.memory_feed_inbox SET classification='{"actor_scope":"assistant"}' WHERE feed_id=42`],
    ["UPDATE public.source_events SET source_provenance='{\"memory\":{\"bad\":true}}' WHERE origin_position='42'","UPDATE public.source_events SET source_provenance='{}' WHERE origin_position='42'"],
   ]){await pool.query(change);try{expect((await scan()).replacementProven).toBe(false)}finally{await pool.query(restore)}}
   expect((await scan()).state).toBe('unique-hot')
   // Feed v1 omits an absent optional turn. SQL stores that absence as NULL.
   // Producer-looking payload metadata remains opaque, even when its shape
   // happens to be valid; only the original transport identity is proved.
   for(const raw of [undefined,{version:99,skill_state:'non_skill'},
    {version:1,producer:'codex',session_id:'unknown-session',turn_id:'unknown-turn',event_id:'opaque-event',sequence:'99',invocation_id:'opaque-call',source_role:'assistant',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}]){
    const {turn_id,...withoutTurn}=payload
    const nextPayload=raw===undefined?withoutTurn:{...payload,memory_source:raw},nextTurn=raw===undefined?null:payload.turn_id
    const nextEnvelope={...envelope,subject:{session_id:'unknown-session',event_type:'tool_call',...(nextTurn?{turn_id:nextTurn}:{})},data:nextPayload}
    await pool.query('UPDATE public.events SET payload=$1 WHERE id=42',[nextPayload])
    await pool.query("UPDATE public.source_events SET turn_id=$1,payload=$2,payload_hash=$3 WHERE origin_position='42'",[nextTurn,nextPayload,canonicalPayloadHash(nextPayload)])
    await pool.query('UPDATE public.memory_feed_inbox SET turn_id=$1,data=$2 WHERE feed_id=42',[nextTurn,nextPayload])
    await pool.query('UPDATE public.extension_feed SET payload=$1 WHERE feed_id=42',[nextEnvelope])
    const originalIdentity=await scan()
    expect(originalIdentity).toMatchObject({state:'unique-hot',provenanceState:'unknown',replacementProven:true,originalIdentityManifest:{sourceSequence:null,journalOrderProven:false,turnId:nextTurn,producerPayloadMetadataPresent:raw!==undefined}})
    expect(originalIdentity.sourceSequence).toBeUndefined();expect(originalIdentity.sourceVersion).toBeUndefined()
    expect((await pool.query("SELECT source_provenance FROM public.source_events WHERE origin_position='42'")).rows[0].source_provenance).toEqual({})
    const recorded_at=at.replace('18.126Z','19Z'),retainedWire={...nextEnvelope,feed_id:'42',topic:'session.event.v1',source:{...nextEnvelope.source,recorded_at}}
    await pool.query('UPDATE public.memory_feed_inbox SET recorded_at=$1,payload_hash=$2 WHERE feed_id=42',[recorded_at,canonicalPayloadHash(retainedWire)])
    await pool.query('DELETE FROM public.extension_feed WHERE feed_id=42')
    expect(await scan()).toMatchObject({state:'unique-hot',provenanceState:'unknown',originalIdentityManifest:{kind:'retained-inbox-v1-original-identity',sourceSequence:null,journalOrderProven:false,turnId:nextTurn}})
    await pool.query("INSERT INTO public.extension_feed VALUES(42,'canonical_event','event:42',1,'unknown-session',$1)",[nextEnvelope])
   }
   await pool.query('ALTER TABLE public.events ADD COLUMN logical_source_session_id varchar(128)')
   expect((await scan(true)).state).toBe('unique-hot')
   await pool.query("UPDATE public.events SET logical_source_session_id='different-original' WHERE id=42")
   expect((await scan(true)).replacementProven).toBe(false)
   await pool.query('UPDATE public.events SET logical_source_session_id=session_id WHERE id=42')
   expect((await scan(true)).state).toBe('unique-hot')
   await pool.query("CREATE FUNCTION public.native_session_authority(text,integer,text) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$")
   try{await expect(scan(true)).rejects.toThrow('pre_native_preparation_state_required')}finally{await pool.query('DROP FUNCTION public.native_session_authority(text,integer,text)')}
   await pool.query('ALTER TABLE public.events DROP COLUMN logical_source_session_id')
   await pool.query('DELETE FROM public.memory_feed_inbox WHERE feed_id=42');expect((await scan()).replacementProven).toBe(false)
   await pool.query('DELETE FROM public.extension_feed WHERE feed_id=42')
   await pool.query("ALTER TABLE public.events ADD COLUMN event_hash varchar(32);CREATE UNIQUE INDEX idx_events_dedup ON public.events(session_id,event_hash)")
   await pool.query("UPDATE public.events SET event_hash=substr(md5(session_id||':'||event_type||':event:'||(payload->>'event_id')),1,16) WHERE id=42")
   await pool.query("UPDATE public.source_events SET canonical_event_key='event_id:synthetic-ingress-42' WHERE origin_position='42'")
   expect(await scan()).toMatchObject({state:'unique-hot',canonicalId:'42',provenanceState:'unknown',originalIdentityManifest:{kind:'retained-ingress-key-v1-original-identity',sourceSequence:null,journalOrderProven:false}})
   for(const [change,restore]of[
    ["UPDATE public.source_events SET canonical_event_key='event_id:wrong' WHERE origin_position='42'","UPDATE public.source_events SET canonical_event_key='event_id:synthetic-ingress-42' WHERE origin_position='42'"],
    ["UPDATE public.events SET event_hash='wrong' WHERE id=42","UPDATE public.events SET event_hash=substr(md5(session_id||':'||event_type||':event:'||(payload->>'event_id')),1,16) WHERE id=42"],
    ["DROP INDEX public.idx_events_dedup;CREATE INDEX idx_events_dedup ON public.events(session_id,event_hash)","DROP INDEX public.idx_events_dedup;CREATE UNIQUE INDEX idx_events_dedup ON public.events(session_id,event_hash)"],
    ["UPDATE public.events SET created_at=created_at+interval '1 millisecond' WHERE id=42","UPDATE public.events SET created_at=created_at-interval '1 millisecond' WHERE id=42"],
    ["UPDATE public.daemons SET user_id=2","UPDATE public.daemons SET user_id=1"],
    ["UPDATE public.events SET payload=jsonb_set(payload,'{event_id}','\"wrong\"') WHERE id=42","UPDATE public.events SET payload=jsonb_set(payload,'{event_id}','\"synthetic-ingress-42\"') WHERE id=42"],
    ["UPDATE public.source_events SET source_provenance='{\"memory\":{\"bad\":true}}' WHERE origin_position='42'","UPDATE public.source_events SET source_provenance='{}' WHERE origin_position='42'"],
   ]){await pool.query(change);try{expect((await scan()).replacementProven).toBe(false)}finally{await pool.query(restore)}}
   // The same original ingress witness also needs real cold-byte integrity,
   // namespace and owner/epoch validation. No synthetic hydrated-body shortcut.
   const coldPayload=(await pool.query('SELECT payload FROM public.events WHERE id=42')).rows[0].payload
   const manifestId='30000000-0000-0000-0000-000000000042',binding={userId:1,sessionId:'unknown-session',activityEpoch:'7',manifestId,ordinal:0}
   const {encodeArchiveChunk}=await relayPureModule('codec'),encoded=await encodeArchiveChunk(binding,[{id:'42',eventType:'tool_call',payload:coldPayload}],{maxRawBytes:1024*1024,maxCompressedBytes:1024*1024,maxRecords:100})
   archive={directory:await mkdtemp(join(tmpdir(),'ingress-cold-proof-')),namespace:'synthetic-ingress-archive'}
   const objectKey=`session-archive/v1/${manifestId}/0.gz`,file=join(archive.directory,objectKey)
   await mkdir(join(archive.directory,'session-archive/v1',manifestId),{recursive:true});await writeFile(file,encoded.bytes)
   await pool.query(`CREATE TABLE public.session_archive_manifests(manifest_id uuid PRIMARY KEY,user_id int,session_id text,activity_epoch bigint,schema_version int,codec text,state text,storage_namespace text);
    CREATE TABLE public.session_archive_chunks(manifest_id uuid,ordinal int,object_key text,first_event_id bigint,last_event_id bigint,event_count int,raw_bytes bigint,compressed_bytes bigint,raw_sha256 text,compressed_sha256 text);
    ALTER TABLE public.events ADD COLUMN body_manifest_id uuid,ADD COLUMN body_chunk_ordinal int,ADD COLUMN body_activity_epoch bigint,ADD COLUMN body_owner_user_id int`)
   await pool.query("INSERT INTO public.session_archive_manifests VALUES($1,1,'unknown-session',7,1,'gzip','published',$2)",[manifestId,archive.namespace])
   const z=encoded.manifest
   await pool.query("INSERT INTO public.session_archive_chunks VALUES($1,0,$2,42,42,1,$3,$4,$5,$6)",[manifestId,objectKey,String(z.rawBytes),String(z.compressedBytes),z.rawSha256,z.compressedSha256])
   await pool.query("UPDATE public.events SET payload=NULL,body_storage='cold',body_manifest_id=$1,body_chunk_ordinal=0,body_activity_epoch=7,body_owner_user_id=1 WHERE id=42",[manifestId])
   const cold=await scan();expect(cold).toMatchObject({state:'unique-cold',provenanceState:'unknown',originalIdentityManifest:{kind:'retained-ingress-key-v1-original-identity',archiveVerified:true,sourceSequence:null,journalOrderProven:false}})
   expect(cold.sourceSequence).toBeUndefined();expect(JSON.stringify(cold)).not.toContain('synthetic-ingress-42')
   await writeFile(file,Buffer.from('corrupt'));expect((await scan()).replacementProven).toBe(false);await writeFile(file,encoded.bytes)
   archive.namespace='wrong';expect((await scan()).replacementProven).toBe(false);archive.namespace='synthetic-ingress-archive'
   await pool.query('UPDATE public.events SET body_owner_user_id=2 WHERE id=42');expect((await scan()).replacementProven).toBe(false)
  }finally{
   await pool.query('DELETE FROM public.source_events WHERE source_event_id=$1',[id]);await pool.query('DELETE FROM public.memory_feed_inbox WHERE feed_id=42');await pool.query('DELETE FROM public.extension_feed WHERE feed_id=42');await pool.query('DELETE FROM public.events WHERE id=42')
   await pool.query(`DROP TABLE public.memory_owner_scopes,public.memory_installations,public.sessions,public.daemons;ALTER TABLE public.events DROP COLUMN created_at;
    ALTER TABLE public.extension_installations DROP COLUMN owner_scope_kind,DROP COLUMN owner_scope_id,DROP COLUMN authorization_epoch,DROP COLUMN config_version`)
   await pool.query('ALTER TABLE public.memory_feed_inbox DROP COLUMN IF EXISTS envelope_version,DROP COLUMN IF EXISTS topic,DROP COLUMN IF EXISTS recorded_at,DROP COLUMN IF EXISTS payload_hash,DROP COLUMN IF EXISTS body_reclaimed_at')
   await pool.query('ALTER TABLE public.events DROP COLUMN IF EXISTS logical_source_session_id')
   await pool.query('DROP INDEX IF EXISTS public.idx_events_dedup;ALTER TABLE public.events DROP COLUMN IF EXISTS event_hash')
   await pool.query('DROP TABLE IF EXISTS public.session_archive_chunks,public.session_archive_manifests;ALTER TABLE public.events DROP COLUMN IF EXISTS body_manifest_id,DROP COLUMN IF EXISTS body_chunk_ordinal,DROP COLUMN IF EXISTS body_activity_epoch,DROP COLUMN IF EXISTS body_owner_user_id')
   if(archive)await rm(archive.directory,{recursive:true,force:true})
  }
 })
 test('snapshot metadata is fetched per page and missing retired transport is not queried per source',async()=>{
  const a=await openSnapshot(config),b=await openSnapshot(config),queries:string[]=[]
  const observe=(snapshot:typeof a)=>({...snapshot,client:{query:async(sql:string,args?:unknown[])=>{
   queries.push(sql);return snapshot.client.query(sql,args)
  }} as unknown as typeof a.client})
  try{
   const result=await scanMapping(observe(a),observe(b),{pageSize:2,onDetail:async()=>{}})
   expect(result).toMatchObject({scanned:'3',fullMappingExecuted:true,counts:{'unique-hot':'3'}})
   expect(queries.filter(sql=>sql.includes('WHERE installation_id=$1')&&sql.includes('FROM public.extension_installations'))).toHaveLength(0)
   expect(queries.filter(sql=>sql.includes('FROM public.extension_feed WHERE feed_id=$1'))).toHaveLength(0)
   expect(queries.filter(sql=>sql.includes('FROM public.deleted_sessions WHERE session_id=$1'))).toHaveLength(0)
  }finally{await a.close();await b.close()}
 })
 test('body pages keep native UUID keyset order without a whole-table text sort',async()=>{
  const a=await openSnapshot(config),b=await openSnapshot(config),plans:unknown[]=[]
  const query=a.client.query.bind(a.client)
  await query('SET LOCAL enable_seqscan=off')
  const observed={...a,client:{query:async(sql:string,args?:unknown[])=>{
   if(sql.includes('FROM public.source_events s '))plans.push((await query('EXPLAIN (FORMAT JSON) '+sql,args)).rows[0]['QUERY PLAN'])
   return query(sql,args)
  }} as unknown as typeof a.client}
  try{
   expect((await scanMapping(observed,b,{pageSize:2,onDetail:async()=>{}})).fullMappingExecuted).toBe(true)
   expect(plans).toHaveLength(2)
   expect(JSON.stringify(plans)).not.toContain('"Node Type":"Sort"')
   expect(JSON.stringify(plans)).toContain('source_events_pkey')
  }finally{await a.close();await b.close()}
 })
 test('exact source count uses bounded keyset pages including the zero UUID in one frozen snapshot',async()=>{
  const zero='00000000-0000-0000-0000-000000000000'
  await pool.query(`INSERT INTO public.source_events SELECT $1::uuid,installation_id,origin,origin_position,canonical_event_key,session_id,turn_id,event_type,occurred_at,payload,payload_hash,source_provenance,classification,body_reclaimed_at FROM public.source_events ORDER BY source_event_id LIMIT 1`,[zero])
  const a=await openSnapshot(config),b=await openSnapshot(config)
  try{
   expect(await countSourceRows(a,{pageSize:2})).toBe(4n)
   await pool.query('DELETE FROM public.source_events WHERE source_event_id=$1',[zero])
   expect(await countSourceRows(a,{pageSize:2})).toBe(4n)
   const ids:string[]=[]
   const report=await scanMapping(a,b,{pageSize:2,onDetail:async row=>{ids.push(row.sourceEventId)}})
   expect(ids).toContain(zero)
   expect(report).toMatchObject({total:'4',scanned:'4',fullMappingExecuted:true})
  }finally{await a.close();await b.close();await pool.query('DELETE FROM public.source_events WHERE source_event_id=$1',[zero])}
 })
 test('rejects wrong DB or server without exposing actual identity',async()=>{
  await expect(openSnapshot({...config,expected:{...config.expected,database:'production'}})).rejects.toThrow('database_identity_mismatch')
  await expect(openSnapshot({...config,expected:{...config.expected,serverPort:'1'}})).rejects.toThrow('database_identity_mismatch')
 })
 test('rejects writes, enforces timeout, and labels distinct snapshots',async()=>{
  const a=await openSnapshot(config),b=await openSnapshot(config)
  try{
   expect(a.identity.snapshotId).not.toBe(b.identity.snapshotId)
   expect(a.identity.crossDatabaseAtomic).toBe(false)
   expect((await a.client.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('5s')
   expect((await a.client.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('1s')
   await expect(a.client.query('INSERT INTO public.events(id) VALUES(1)')).rejects.toMatchObject({code:'25006'})
   await expect(b.client.query('SELECT pg_sleep(6)')).rejects.toMatchObject({code:'57014'})
  }finally{await a.close();await b.close()}
 },10000)
 test('lock wait times out without a write or abandoned connection',async()=>{
  const blocker=await pool.connect();await blocker.query('BEGIN;LOCK TABLE public.events IN ACCESS EXCLUSIVE MODE')
  const snapshot=await openSnapshot(config)
  try{await expect(snapshot.client.query('SELECT id FROM public.events')).rejects.toMatchObject({code:'55P03'})}
  finally{await snapshot.close();await blocker.query('ROLLBACK');blocker.release()}
 })
 test('catalog includes all object classes and new objects block; no schema or DML effects',async()=>{
  const before=await pool.query(`SELECT (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace)::text objects,(SELECT count(*) FROM public.source_events)::text row_count,(SELECT last_value::text FROM public.inventory_counter) seq`)
  const snapshot=await openSnapshot(config)
  try{
   const report=await inventoryDatabase(snapshot,'memory',{})
   for(const kind of ['table','function','trigger','index','foreign-key','sequence','schema','permission','role','extension'])expect(report.objects.some(o=>o.kind===kind)).toBe(true)
   expect(report.objects.find(o=>o.key==='table:public.source_events')?.classification.action).toBe('transform')
   expect(report.objects.some(o=>o.kind==='trigger' && o.internal===true)).toBe(true)
   expect(report.blockers.length).toBeGreaterThan(0)
   expect(JSON.stringify(report)).not.toContain(url)
   expect(JSON.stringify(report)).not.toContain('DO NOT EXPORT')
  }finally{await snapshot.close()}
  expect((await pool.query(`SELECT (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace)::text objects,(SELECT count(*) FROM public.source_events)::text row_count,(SELECT last_value::text FROM public.inventory_counter) seq`)).rows).toEqual(before.rows)
 })
 test('permission identities preserve full overloaded function signatures beyond PostgreSQL NAME length',async()=>{
  await pool.query(`CREATE FUNCTION public.inventory_long_permission_signature(text,text,text,text,text,text,text,text,integer) RETURNS text LANGUAGE SQL AS $$ SELECT 'static'::text $$;
   CREATE FUNCTION public.inventory_long_permission_signature(text,text,text,text,text,text,text,text,bigint) RETURNS text LANGUAGE SQL AS $$ SELECT 'static'::text $$`)
  const snapshot=await openSnapshot(config)
  try{
   const report=await inventoryDatabase(snapshot,'memory',{}),permissions=report.objects.filter(o=>o.kind==='permission'&&o.name.startsWith('inventory_long_permission_signature('))
   expect(permissions).toHaveLength(2);expect(new Set(permissions.map(o=>o.key)).size).toBe(2)
   expect(permissions.every(o=>o.name.endsWith(')')&&o.name.length>63)).toBe(true)
   expect(permissions.some(o=>o.name.endsWith('bigint)'))).toBe(true)
  }finally{await snapshot.close();await pool.query('DROP FUNCTION public.inventory_long_permission_signature(text,text,text,text,text,text,text,text,integer);DROP FUNCTION public.inventory_long_permission_signature(text,text,text,text,text,text,text,text,bigint)')}
 })
 test('quoted identifier collisions cannot be approved through one apparently matching object-plan key',async()=>{
  await pool.query('CREATE SCHEMA "public.inventory";CREATE TABLE "public.inventory".duplicate(id int);CREATE TABLE public."inventory.duplicate"(id int)')
  const first=await openSnapshot(config)
  let definitionHash:string
  try{definitionHash=(await inventoryDatabase(first,'memory',{})).objects.find(o=>o.key==='table:public.inventory.duplicate')!.definitionHash}finally{await first.close()}
  const snapshot=await openSnapshot(config)
  try{
   const report=await inventoryDatabase(snapshot,'memory',{'table:public.inventory.duplicate':{action:'migrate-as-is',definitionHash}})
   const collisions=report.objects.filter(o=>o.key==='table:public.inventory.duplicate')
   expect(collisions).toHaveLength(2);expect(collisions.every(o=>o.classification.blocked)).toBe(true)
   expect(report.blockers).toContain('catalog_identity_collision:table:public.inventory.duplicate')
  }finally{await snapshot.close();await pool.query('DROP TABLE public."inventory.duplicate";DROP SCHEMA "public.inventory" CASCADE')}
 })
 test('inventory distinguishes uncalled bigint sequence state from unreadable state',async()=>{
  const read=async(c:DatabaseConfig=config)=>{const a=await openSnapshot(c);try{return await inventoryDatabase(a,'memory',{})}finally{await a.close()}}
  const initial=(await read()).objects.find(o=>o.key==='sequence-state:public.inventory_counter')!
  expect(initial).toMatchObject({lastValue:'1',isCalled:false,stateReadable:true})
  try{
   await pool.query("SELECT setval('public.inventory_counter',9007199254740993,false)")
   expect((await read()).objects.find(o=>o.key===initial.key)).toMatchObject({lastValue:'9007199254740993',isCalled:false,stateReadable:true})
   await pool.query("ALTER ROLE shared_source_denied LOGIN PASSWORD 'only-test';GRANT USAGE ON SCHEMA public TO shared_source_denied;GRANT SELECT ON ALL TABLES IN SCHEMA public TO shared_source_denied")
   const raw=new URL(url!);raw.username='shared_source_denied';raw.password='only-test'
   const report=await read({...config,connectionString:raw.href,expected:{...config.expected,role:'shared_source_denied'}})
   expect(report.objects.find(o=>o.key===initial.key)).toMatchObject({lastValue:null,isCalled:null,stateReadable:false})
   expect(report.blockers).toContain('sequence_state_unavailable:sequence-state:public.inventory_counter')
  }finally{await pool.query("SELECT setval('public.inventory_counter',1,false)");await pool.query('REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM shared_source_denied')}
 })
 test('role audit exposes inheritance/replication flags but fingerprints private role settings',async()=>{
  await pool.query(`CREATE ROLE shared_inventory_role_flags NOLOGIN NOINHERIT REPLICATION;ALTER ROLE shared_inventory_role_flags SET application_name='PRIVATE_ROLE_SETTING_MUST_NOT_EXPORT'`)
  try{
   const snapshot=await openSnapshot(config)
   try{
    const report=await inventoryDatabase(snapshot,'memory',{})
    const role=report.objects.find(o=>o.key==='role:*.'+fingerprint('shared_inventory_role_flags'))!
    expect(role).toMatchObject({replication:true,inherit:false,settingsFingerprint:expect.stringMatching(/^[a-f0-9]{64}$/)})
    expect(JSON.stringify(report)).not.toContain('PRIVATE_ROLE_SETTING_MUST_NOT_EXPORT')
   }finally{await snapshot.close()}
  }finally{await pool.query('DROP ROLE shared_inventory_role_flags')}
 })
 test('JSON column audit lists typed containers without exporting default literals or bodies',async()=>{
  await pool.query(`ALTER TABLE public.source_events ADD COLUMN private_json jsonb DEFAULT '{"secret":"NEVER_EXPORT_DEFAULT"}'::jsonb`)
  const snapshot=await openSnapshot(config)
  try{
   const report=await inventoryDatabase(snapshot,'memory',{})
   const column=report.objects.find(o=>o.key==='json-column:public.source_events.private_json')
   expect(column).toMatchObject({parent:'source_events',columnName:'private_json',dataType:'jsonb',classification:{blocked:true}})
   expect(report.objects.some(o=>o.key==='json-column:public.source_events.payload')).toBe(true)
   expect(JSON.stringify(report)).not.toContain('NEVER_EXPORT_DEFAULT');expect(JSON.stringify(report)).not.toContain('DO NOT EXPORT')
  }finally{await snapshot.close();await pool.query('ALTER TABLE public.source_events DROP COLUMN private_json')}
 })
 test('reviewed catalog hashes reject changed RLS, trigger state and domain/composite definitions',async()=>{
  await pool.query(`CREATE DOMAIN public.positive_counter AS int CHECK(VALUE>0); CREATE TYPE public.inventory_pair AS (left_id bigint,right_id bigint)`)
  const read=async(plan:any={})=>{const a=await openSnapshot(config);try{return await inventoryDatabase(a,'memory',plan)}finally{await a.close()}}
  const before=await read(), table=before.objects.find(o=>o.key==='table:public.events')!,trigger=before.objects.find(o=>o.key==='trigger:public.events.inventory_event_insert')!,domain=before.objects.find(o=>o.key==='type:public.positive_counter')!
  expect(before.objects.some(o=>o.key==='type:public.inventory_pair')).toBe(true)
  const plan=Object.fromEntries([table,trigger,domain].map(o=>[o.key,{action:'migrate-as-is',definitionHash:o.definitionHash}]))
  await pool.query(`ALTER TABLE public.events ENABLE ROW LEVEL SECURITY; ALTER TABLE public.events FORCE ROW LEVEL SECURITY;
   ALTER TABLE public.events DISABLE TRIGGER inventory_event_insert; ALTER DOMAIN public.positive_counter DROP CONSTRAINT positive_counter_check; ALTER DOMAIN public.positive_counter ADD CHECK(VALUE>10)`)
  const after=await read(plan)
  for(const o of [table,trigger,domain])expect(after.objects.find(a=>a.key===o.key)?.classification.blocked).toBe(true)
  await pool.query('ALTER TABLE public.events DISABLE ROW LEVEL SECURITY; ALTER TABLE public.events NO FORCE ROW LEVEL SECURITY; ALTER TABLE public.events ENABLE TRIGGER inventory_event_insert')
 })
 test('type ACL and membership administration changes invalidate permission reviews',async()=>{
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_source_parent') THEN CREATE ROLE shared_source_parent; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_source_member') THEN CREATE ROLE shared_source_member; END IF;
   END $$; GRANT shared_source_parent TO shared_source_member`)
  const read=async(plan:any={})=>{const a=await openSnapshot(config);try{return await inventoryDatabase(a,'memory',plan)}finally{await a.close()}}
  const before=await read(),type=before.objects.find(o=>o.key==='permission:public.type.positive_counter')!
  expect(type).toBeDefined()
  const {fingerprint}=await import('../../migrations/shared-source/report.js')
  const role=before.objects.find(o=>o.key==='role:*.'+fingerprint('shared_source_member'))!
  const plan=Object.fromEntries([type,role].map(o=>[o.key,{action:'migrate-as-is',definitionHash:o.definitionHash}]))
  await pool.query('GRANT USAGE ON TYPE public.positive_counter TO shared_source_member; GRANT shared_source_parent TO shared_source_member WITH ADMIN OPTION')
  const after=await read(plan)
  for(const o of [type,role])expect(after.objects.find(a=>a.key===o.key)?.classification.blocked).toBe(true)
  expect(after.objects.find(a=>a.key===role.key)?.memberships).toEqual(expect.arrayContaining([expect.objectContaining({adminOption:true})]))
  await pool.query('REVOKE ADMIN OPTION FOR shared_source_parent FROM shared_source_member')
 })
 test('mapping uses keyset pages, keeps UUIDs and never emits bodies',async()=>{
  const a=await openSnapshot(config),b=await openSnapshot(config),details:unknown[]=[]
  try{
   const report=await scanMapping(a,b,{pageSize:2,onDetail:async row=>{details.push(row)}})
   expect(report.scanned).toBe('3')
   expect(report.counts['unique-hot']).toBe('3')
   expect(report.fullMappingExecuted).toBe(true)
   expect(report.migrationReady).toBe(false)
   expect(JSON.stringify(details)).not.toContain('DO NOT EXPORT')
   expect(details).toHaveLength(3)
  }finally{await a.close();await b.close()}
 })
 test('snapshot envelope hashes are verified separately from canonical body hashes without promoting unknown provenance',async()=>{
  const base=(await pool.query("SELECT * FROM public.source_events WHERE origin_position='1'")).rows[0]
  const at='2026-11-06T00:00:00Z',id='9007199254740993',known='00000000-0000-0000-0000-000000000004',unknown='00000000-0000-0000-0000-000000000005'
  const original=canonicalPayloadHash({event_id:id,event_type:base.event_type,payload:base.payload,created_at:at})
  await pool.query("INSERT INTO public.memory_snapshot_events VALUES($1,'session',$2,'agent_text',$3)",[base.installation_id,id,base.payload])
  for(const key of [known,unknown])await pool.query(`INSERT INTO public.source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,source_provenance,classification)
   VALUES($1,$2,'snapshot',$3,'session','turn','agent_text',$4,$5,$6,$7,$8)`,[key,base.installation_id,id,at,base.payload,original,key===known?base.source_provenance:{},base.classification])
  const a=await openSnapshot(config),b=await openSnapshot(config)
  try{
   const details:any[]=[]
   await scanMapping(a,b,{onDetail:async value=>{details.push(value)}})
   expect(details.find(r=>r.sourceEventId===known)).toMatchObject({state:'unique-hot',originalSourceHash:original.toString('hex'),originalHashVersion:'snapshot-envelope-sha256-v1',contentHash:base.payload_hash.toString('hex')})
   expect(details.find(r=>r.sourceEventId===unknown)).toMatchObject({state:'unproven',provenanceState:'unknown',deletionEligible:false})
   expect(JSON.stringify(details)).not.toContain('DO NOT EXPORT')
  }finally{await a.close();await b.close();await pool.query('DELETE FROM public.source_events WHERE source_event_id=ANY($1::uuid[])',[[known,unknown]]);await pool.query('DELETE FROM public.memory_snapshot_events WHERE installation_id=$1 AND relay_event_id=$2',[base.installation_id,id])}
 })
 test.skipIf(!process.env.SHARED_SOURCE_FROZEN_TEST_DATABASE_URL)('no-backup live mapping requires a genuinely frozen Memory source, including hidden other-user backends',async()=>{
  const frozenUrl=process.env.SHARED_SOURCE_FROZEN_TEST_DATABASE_URL!,admin=new pg.Pool({connectionString:frozenUrl})
  const identity=(await admin.query(`SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort"`)).rows[0]
  if(!/^[a-z_][a-z0-9_]*_test$/.test(identity.database))throw Error('isolated_test_required')
  await admin.query(`DROP SCHEMA public CASCADE;CREATE SCHEMA public;
   CREATE TABLE public.source_events(source_event_id uuid PRIMARY KEY,installation_id uuid,origin text,origin_position text,canonical_event_key text,session_id text,turn_id text,event_type text,occurred_at timestamptz,payload jsonb,payload_hash bytea,source_provenance jsonb,classification jsonb,body_reclaimed_at timestamptz);
   CREATE TABLE public.memory_feed_inbox(installation_id uuid,feed_id bigint,source_kind text,source_id text,session_id text,turn_id text,event_type text,data jsonb,classification jsonb);
   CREATE TABLE public.memory_snapshot_events(installation_id uuid,session_id text,relay_event_id bigint,event_type text,payload jsonb);
   DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_frozen_reader') THEN CREATE ROLE shared_frozen_reader LOGIN PASSWORD 'only-test';END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_frozen_writer') THEN CREATE ROLE shared_frozen_writer LOGIN PASSWORD 'only-test';ELSE ALTER ROLE shared_frozen_writer LOGIN;END IF;
   END $$;
   REVOKE CONNECT ON DATABASE ${identity.database} FROM PUBLIC;
   GRANT CONNECT ON DATABASE ${identity.database} TO shared_frozen_reader,shared_frozen_writer;
   GRANT USAGE ON SCHEMA public TO shared_frozen_reader,shared_frozen_writer;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO shared_frozen_reader;`)
  for(const table of ['source_events','memory_feed_inbox','memory_snapshot_events']){
   const records=(await pool.query('SELECT row_to_json(r)::text AS record FROM public.'+table+' r')).rows
   for(const row of records)await admin.query('INSERT INTO public.'+table+' SELECT * FROM json_populate_record(NULL::public.'+table+',$1::json)',[row.record])
  }
  const readerUrl=new URL(frozenUrl),writerUrl=new URL(frozenUrl)
  readerUrl.username='shared_frozen_reader';readerUrl.password='only-test';writerUrl.username='shared_frozen_writer';writerUrl.password='only-test'
  const frozen:DatabaseConfig={connectionString:readerUrl.href,expected:{...identity,role:'shared_frozen_reader',mode:'frozen-maintenance',maintenanceWindowId:'owned-test-window'}}
  const writer=new pg.Client({connectionString:writerUrl.href});await writer.connect()
  await admin.query('ALTER ROLE shared_frozen_writer NOLOGIN');await admin.end()
  try{
   const probe=new pg.Client({connectionString:readerUrl.href});await probe.connect()
   try{expect((await probe.query("SELECT backend_type FROM pg_stat_activity WHERE usename='shared_frozen_writer' AND datname=current_database()")).rows[0].backend_type).toBeNull()}finally{await probe.end()}
   await expect(openSnapshot(frozen)).rejects.toThrow('source_not_drained')
  }finally{await writer.end()}
  const memory=await openSnapshot(frozen),relay=await openSnapshot({...config,expected:{...config.expected,mode:'live-readonly',maintenanceWindowId:'owned-test-window'}})
  try{
   const details:any[]=[],report=await scanMapping(memory,relay,{pageSize:2,onDetail:async row=>{details.push(row)}})
   expect(report).toMatchObject({fullMappingExecuted:true,backupRequired:false,rollbackSupported:false,crossDatabaseAtomic:false,migrationReady:false})
   expect(report.counts['unique-hot']).toBe('3');expect(details).toHaveLength(3);expect(JSON.stringify(details)).not.toContain('DO NOT EXPORT')
   await expect(memory.client.query('DELETE FROM public.source_events')).rejects.toMatchObject({code:'25006'})
   await expect(scanMapping(memory,{...relay,identity:{...relay.identity,maintenanceWindowId:'different-window'}},{onDetail:async()=>{}})).rejects.toThrow('maintenance_mapping_scope_mismatch')
  }finally{await memory.close();await relay.close()}
 },30000)
 test('missing Feed and Inbox can use persisted trusted Journal identity, but not equal text',async()=>{
  await pool.query('DELETE FROM public.memory_feed_inbox WHERE feed_id=2')
  const a=await openSnapshot(config),b=await openSnapshot(config)
  try{expect((await scanMapping(a,b,{onDetail:async()=>{}})).counts['unique-hot']).toBe('3')}
  finally{await a.close();await b.close()}
  await pool.query(`UPDATE public.source_events SET source_provenance='{}' WHERE origin_position='2'`)
  const c=await openSnapshot(config),d=await openSnapshot(config)
  try{
   const report=await scanMapping(c,d,{onDetail:async()=>{}})
   expect(report.counts.unproven).toBe('1')
   expect(report.counts['unique-hot']).toBe('2')
  }finally{await c.close();await d.close()}
  await pool.query(`UPDATE public.source_events SET source_provenance=(SELECT source_provenance FROM public.source_events WHERE origin_position='1') WHERE origin_position='2'`)
 })
 test('persisted and payload provenance must bind their actual session and turn even with Inbox links',async()=>{
  const sources=(await pool.query('SELECT * FROM public.source_events')).rows
  const events=(await pool.query('SELECT * FROM public.events')).rows
  const inbox=(await pool.query('SELECT * FROM public.memory_feed_inbox')).rows
  try{
   for(const field of ['session_id','turn_id']){
    for(const r of sources){
     const payload=structuredClone(r.payload);payload.memory_source[field]='other'
     const provenance=structuredClone(r.source_provenance);provenance.memory[field]='other'
     await pool.query("UPDATE public.source_events SET payload=$1,payload_hash=$2,source_provenance=$3,classification='{}' WHERE source_event_id=$4",[payload,canonicalPayloadHash(payload),provenance,r.source_event_id])
    }
    for(const r of events){const payload=structuredClone(r.payload);payload.memory_source[field]='other';await pool.query('UPDATE public.events SET payload=$1 WHERE id=$2',[payload,r.id])}
    for(const r of inbox){const payload=structuredClone(r.data);payload.memory_source[field]='other';await pool.query('UPDATE public.memory_feed_inbox SET data=$1 WHERE feed_id=$2',[payload,r.feed_id])}
    const a=await openSnapshot(config),b=await openSnapshot(config),details:any[]=[]
    try{await scanMapping(a,b,{onDetail:async row=>{details.push(row)}});expect(details).toHaveLength(3);expect(details.every(r=>r.state==='unproven'&&!r.replacementProven&&r.provenanceState==='unknown')).toBe(true)}
    finally{await a.close();await b.close()}
   }
  }finally{
   for(const r of sources)await pool.query('UPDATE public.source_events SET payload=$1,payload_hash=$2,source_provenance=$3,classification=$4 WHERE source_event_id=$5',[r.payload,r.payload_hash,r.source_provenance,r.classification,r.source_event_id])
   for(const r of events)await pool.query('UPDATE public.events SET payload=$1 WHERE id=$2',[r.payload,r.id])
   for(const r of inbox)await pool.query('UPDATE public.memory_feed_inbox SET data=$1 WHERE feed_id=$2',[r.data,r.feed_id])
  }
 })
 test('canonical owner mismatch conflicts and duplicate explicit candidates are ambiguous',async()=>{
  await pool.query('UPDATE public.events SET user_id=2')
  const a=await openSnapshot(config),b=await openSnapshot(config)
  try{expect((await scanMapping(a,b,{onDetail:async()=>{}})).counts.conflict).toBe('3')}
  finally{await a.close();await b.close();await pool.query('UPDATE public.events SET user_id=1')}
  await pool.query(`INSERT INTO public.events SELECT 9007199254740994,session_id,event_type,payload,user_id,body_storage FROM public.events WHERE id=9007199254740993`)
  await pool.query(`INSERT INTO public.extension_source_outbox SELECT 19,source_kind,'event:9007199254740994',owner_user_id,session_id,event_type,payload FROM public.extension_source_outbox LIMIT 1`)
  const c=await openSnapshot(config),d=await openSnapshot(config)
  try{expect((await scanMapping(c,d,{onDetail:async()=>{}})).counts.ambiguous).toBe('3')}
  finally{await c.close();await d.close();await pool.query('DELETE FROM public.events WHERE id=9007199254740994');await pool.query("DELETE FROM public.extension_source_outbox WHERE source_id='event:9007199254740994'")}
 })
 test('cold mapping reuses real codec and fails on namespace, integrity and owner/epoch binding',async()=>{
  const root=await mkdtemp(join(tmpdir(),'shared-source-archive-')),manifestId='30000000-0000-0000-0000-000000000001'
  const payload=(await pool.query('SELECT payload FROM public.events LIMIT 1')).rows[0].payload
  const {encodeArchiveChunk}=await relayPureModule('codec')
  const binding={userId:1,sessionId:'session',activityEpoch:'7',manifestId,ordinal:0}
  const {bytes,manifest}=await encodeArchiveChunk(binding,[{id:'9007199254740993',eventType:'agent_text',payload}],{maxRawBytes:1024*1024,maxCompressedBytes:1024*1024,maxRecords:100})
  const dir=join(root,'session-archive/v1',manifestId),file=join(dir,'0.gz')
  await mkdir(dir,{recursive:true});await writeFile(file,bytes)
  await pool.query(`CREATE TABLE public.session_archive_manifests(manifest_id uuid PRIMARY KEY,user_id int,session_id text,activity_epoch bigint,schema_version int,codec text,state text,storage_namespace text);
   CREATE TABLE public.session_archive_chunks(manifest_id uuid,ordinal int,object_key text,first_event_id bigint,last_event_id bigint,event_count int,raw_bytes bigint,compressed_bytes bigint,raw_sha256 text,compressed_sha256 text);
   ALTER TABLE public.events ADD COLUMN body_manifest_id uuid,ADD COLUMN body_chunk_ordinal int,ADD COLUMN body_activity_epoch bigint,ADD COLUMN body_owner_user_id int`)
  await pool.query(`INSERT INTO public.session_archive_manifests VALUES($1,1,'session',7,1,'gzip','published','test-archive')`,[manifestId])
  await pool.query('INSERT INTO public.session_archive_chunks VALUES($1,0,$2,$3,$3,1,$4,$5,$6,$7)',[manifestId,`session-archive/v1/${manifestId}/0.gz`,'9007199254740993',String(manifest.rawBytes),String(manifest.compressedBytes),manifest.rawSha256,manifest.compressedSha256])
  await pool.query(`UPDATE public.events SET payload=NULL,body_storage='cold',body_manifest_id=$1,body_chunk_ordinal=0,body_activity_epoch=7,body_owner_user_id=1`,[manifestId])
  const scan=async(namespace:string)=>{
   const a=await openSnapshot(config),b=await openSnapshot(config)
   try{return await scanMapping(a,b,{archive:{directory:root,namespace},onDetail:async()=>{}})}finally{await a.close();await b.close()}
  }
  expect(await scan('test-archive')).toMatchObject({counts:{'unique-cold':'3'}})
  expect((await scan('wrong')).counts.unproven).toBe('3')
  await writeFile(file,Buffer.from('corrupt archive'))
  expect((await scan('test-archive')).counts.unproven).toBe('3')
  await writeFile(file,bytes)
  await pool.query('UPDATE public.events SET body_activity_epoch=8')
  expect((await scan('test-archive')).counts.unproven).toBe('3')
  await pool.query(`UPDATE public.events SET payload=$1,body_storage='hot',body_manifest_id=NULL,body_chunk_ordinal=NULL,body_activity_epoch=NULL,body_owner_user_id=NULL`,[payload])
 })
 test('truncated scans explicitly fail full coverage and legal deletion is never inferred from absence',async()=>{
  const a=await openSnapshot(config),b=await openSnapshot(config)
  try{
   const report=await scanMapping(a,b,{maxRows:1,onDetail:async()=>{}})
   expect(report).toMatchObject({scanned:'1',fullMappingExecuted:false,migrationReady:false})
   expect(report.blockers).toContain('full_mapping_not_executed')
  }finally{await a.close();await b.close()}
  await pool.query("INSERT INTO public.deleted_sessions(session_id,user_id) VALUES('session',1)")
  await pool.query("UPDATE public.events SET session_id='other-session'")
  const x=await openSnapshot(config),y=await openSnapshot(config)
  try{expect((await scanMapping(x,y,{onDetail:async()=>{}})).counts.conflict).toBe('3')}finally{await x.close();await y.close();await pool.query("UPDATE public.events SET session_id='session'")}
  const c=await openSnapshot(config),d=await openSnapshot(config)
  try{expect((await scanMapping(c,d,{onDetail:async()=>{}})).counts['known-deleted']).toBe('3')}
  finally{await c.close();await d.close();await pool.query('DELETE FROM public.deleted_sessions')}
 })
 test('Team delivery and collaboration are independently proved against original authority',async()=>{
  await pool.query(`ALTER TABLE public.extension_installations ADD COLUMN owner_scope_kind text, ADD COLUMN owner_scope_id uuid;
   UPDATE public.extension_installations SET owner_scope_kind='personal',owner_scope_id=installation_id;
   INSERT INTO public.extension_installations(installation_id,owner_user_id,status,owner_scope_kind,owner_scope_id) VALUES('20000000-0000-0000-0000-000000000001',NULL,'active','team','40000000-0000-0000-0000-000000000001');
   CREATE TABLE public.extension_organizations(organization_id uuid,state text);
   INSERT INTO public.extension_organizations VALUES('80000000-0000-0000-0000-000000000001','active');
   CREATE TABLE public.extension_teams(team_id uuid,organization_id uuid,state text);
   INSERT INTO public.extension_teams VALUES('40000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000001','active');
   CREATE TABLE public.extension_scope_memberships(scope_kind text,scope_id uuid,user_id int,state text,roles text[]);
   INSERT INTO public.extension_scope_memberships VALUES('team','40000000-0000-0000-0000-000000000001',1,'active',ARRAY['reader']);
   CREATE TABLE public.team_memory_bindings(binding_id text,revision bigint,installation_id uuid,owner_scope_kind text,owner_scope_id uuid,state text,team_id text);
   INSERT INTO public.team_memory_bindings VALUES('binding',1,'20000000-0000-0000-0000-000000000001','team','40000000-0000-0000-0000-000000000001','active','team');
   CREATE TABLE public.collaboration_sessions(team_id text,team_session_id text,state text);
   INSERT INTO public.collaboration_sessions VALUES('team','team-session','active');
   CREATE TABLE public.collaboration_teams(team_id text,state text);
   INSERT INTO public.collaboration_teams VALUES('team','active');
   CREATE TABLE public.collaboration_calls(call_id text,team_session_id text,context_version bigint,event_id text,state text,task_id text,offer_id text);
   INSERT INTO public.collaboration_calls VALUES('call','team-session',0,'goal','completed','task','offer');
   CREATE TABLE public.collaboration_session_participants(team_session_id text,user_id int,revision bigint,state text);
   INSERT INTO public.collaboration_session_participants VALUES('team-session',1,1,'active');
   CREATE TABLE public.collaboration_team_memberships(team_id text,user_id int,state text);
   INSERT INTO public.collaboration_team_memberships VALUES('team',1,'active');
   CREATE TABLE public.users(id int,team_enabled boolean);
   INSERT INTO public.users VALUES(1,true);
   CREATE TABLE public.team_delivery_memory_sources(source_session_id text,decision_id uuid,submission_id uuid,binding_id text,reader_user_id int,team_session_id text,team_id text,binding_revision bigint,participant_revision bigint,revoked_at timestamptz,withdrawn_at timestamptz);
   CREATE TABLE public.team_acceptance_decisions(decision_id uuid,submission_id uuid,task_id text,spec_revision bigint,decision text,created_at timestamptz,reviewer_user_id int);
   CREATE TABLE public.team_task_submissions(submission_id uuid,task_id text,spec_revision bigint,version bigint,summary text,manifest_sha256 text,source_call_id text,source_offer_id text,context_version bigint,published_at timestamptz,state text);
   CREATE TABLE public.team_task_specs(task_id text,revision bigint,reviewer_user_id int,goal text,acceptance text,created_by_user_id int,created_at timestamptz);
   CREATE TABLE public.team_artifact_revocations(submission_id uuid);
   CREATE TABLE public.collaboration_events(event_id text,event_seq bigint,kind text,author_user_id int,author_offer_id text,call_id text,content text,created_at timestamptz,team_session_id text);
   INSERT INTO public.collaboration_events VALUES('goal',1,'member_message',1,NULL,NULL,'private goal','2026-01-01T00:00:00Z','team-session'),
    ('reply',2,'agent_message',NULL,'offer','call','private reply','2026-01-01T00:00:01Z','team-session'),
    ('outcome',3,'status',NULL,'offer','call','completed','2026-01-01T00:00:02Z','team-session');
  `)
  const submissionId='50000000-0000-0000-0000-000000000001',decisionId='60000000-0000-0000-0000-000000000001'
  await pool.query(`INSERT INTO public.team_acceptance_decisions VALUES($1,$2,'task',1,'accepted','2026-01-01T00:00:02Z',1)`,[decisionId,submissionId])
  await pool.query(`INSERT INTO public.team_task_submissions VALUES($1,'task',1,1,'private reply',$2,'call','offer',0,'2026-01-01T00:00:01Z','published')`,[submissionId,'a'.repeat(64)])
  await pool.query(`INSERT INTO public.team_task_specs VALUES('task',1,1,'private goal','verified',1,'2026-01-01T00:00:00Z')`)
  const {buildAcceptedDeliveryMemorySourceRecords}=await relayPureModule('delivery')
  const records=buildAcceptedDeliveryMemorySourceRecords({teamId:'team',teamSessionId:'team-session',callId:'call',taskId:'task',contextVersion:0,
   binding:{id:'binding',revision:1,installationId:'20000000-0000-0000-0000-000000000001',ownerScopeKind:'team',ownerScopeId:'40000000-0000-0000-0000-000000000001'},
   readers:[{userId:1,participantRevision:1}],spec:{revision:1,goal:'private goal',acceptance:'verified',authorUserId:1,createdAt:new Date('2026-01-01T00:00:00Z')},
   submission:{id:submissionId,version:1,summary:'private reply',manifestSha256:'a'.repeat(64),authorOfferId:'offer',publishedAt:new Date('2026-01-01T00:00:01Z')},
   decision:{id:decisionId,decision:'accepted',reviewerUserId:1,createdAt:new Date('2026-01-01T00:00:02Z')}})
  await pool.query(`INSERT INTO public.team_delivery_memory_sources VALUES($1,$2,$3,'binding',1,'team-session','team',1,1,NULL,NULL)`,[records[0].sessionId,decisionId,submissionId])
  let n=10
  const insert=async(record:any)=>{
   const adapted=adaptTeamSource({source_kind:'team_collaboration_event',source_id:record.sourceId,session_id:record.sessionId,turn_id:record.payload.turn_id,event_type:'team_source',recorded_at:record.occurredAt,classification:{},data:record.payload})!
   await pool.query(`INSERT INTO public.source_events VALUES($1,$2,'team',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL)`,[
    `00000000-0000-0000-0000-${String(n++).padStart(12,'0')}`,'10000000-0000-0000-0000-000000000001',record.sourceId,adapted.canonicalEventKey,adapted.sessionId,adapted.turnId,adapted.eventType,adapted.occurredAt,adapted.payload,canonicalPayloadHash(adapted.payload),adapted.provenance,adapted.classification])
  }
  for(const record of records)await insert(record)
  const scope=records[0].payload.read_scope
  const {createHash}=await import('node:crypto')
  const teamSession='team_'+createHash('sha256').update(JSON.stringify(['team-source-binding-v1','team-session','binding',1,1])).digest('hex').slice(0,32)
  for(const [i,role] of ['goal','reply','outcome'].entries()){
   const payload={original_source_id:'team:team:team-session:call',reader_projection_id:'binding:1:1:1',team_source_version:1,team_id:'team',team_session_id:'team-session',team_call_id:'call',context_version:0,turn_id:'team-call:call',read_scope:scope,
    source_role:role,team_event_ids:[role],team_event_seqs:[i+1],occurred_at:`2026-01-01T00:00:0${i}.000Z`,
    ...(role==='goal'?{text:'private goal',author_user_id:1}:role==='reply'?{text:'private reply',author_offer_id:'offer',final:true}:{status:'completed'})}
   await insert({sourceId:`team:call:${role}:u1:b1:v1`,sessionId:teamSession,payload,occurredAt:new Date(payload.occurred_at)})
  }
  const scan=async()=>{const a=await openSnapshot(config),b=await openSnapshot(config);try{return await scanMapping(a,b,{pageSize:2,onDetail:async()=>{}})}finally{await a.close();await b.close()}}
  expect((await scan()).counts).toMatchObject({'accepted-delivery':'3','team-collaboration':'3','unique-hot':'3'})
  await pool.query("UPDATE public.collaboration_calls SET task_id='foreign-task'")
  try{expect((await scan()).counts.conflict).toBe('3')}finally{await pool.query("UPDATE public.collaboration_calls SET task_id='task'")}
  await pool.query("UPDATE public.collaboration_calls SET offer_id='foreign-offer'")
  try{expect(BigInt((await scan()).counts.conflict??'0')).toBeGreaterThanOrEqual(3n)}finally{await pool.query("UPDATE public.collaboration_calls SET offer_id='offer'")}
  await pool.query("UPDATE public.source_events SET session_id='fabricated-session' WHERE origin='team' AND event_type='agent_text' AND source_provenance->>'source_version'='1'")
  expect((await scan()).counts.conflict).toBe('1')
  await pool.query("UPDATE public.source_events SET session_id=$1 WHERE origin='team' AND session_id='fabricated-session'",[teamSession])
  await pool.query('UPDATE public.team_delivery_memory_sources SET revoked_at=NOW()')
  expect((await scan()).counts).toMatchObject({revoked:'3','team-collaboration':'3'})
  await pool.query('UPDATE public.collaboration_session_participants SET revision=2')
  expect((await scan()).counts).toMatchObject({conflict:'6'})
  await pool.query('UPDATE public.collaboration_session_participants SET revision=1;UPDATE public.team_delivery_memory_sources SET revoked_at=NULL')
  await pool.query(`INSERT INTO public.source_events SELECT gen_random_uuid(),'20000000-0000-0000-0000-000000000001'::uuid,origin,origin_position,canonical_event_key,session_id,turn_id,event_type,occurred_at,payload,payload_hash,source_provenance,classification,body_reclaimed_at FROM public.source_events WHERE origin='team'`)
  expect((await scan()).counts).toMatchObject({'accepted-delivery':'6','team-collaboration':'6'})
  await pool.query("UPDATE public.extension_scope_memberships SET roles=ARRAY['policy_administrator']")
  expect((await scan()).counts).toMatchObject({'accepted-delivery':'3','team-collaboration':'3',unproven:'6'})
  await pool.query("UPDATE public.extension_scope_memberships SET roles=ARRAY['reader'];UPDATE public.extension_organizations SET state='suspended'")
  expect((await scan()).counts).toMatchObject({'accepted-delivery':'0','team-collaboration':'0',unproven:'12'})
  await pool.query("UPDATE public.extension_organizations SET state='active'")
  await pool.query("DELETE FROM public.source_events WHERE origin='team'")
 })
 test('missing columns and denied SELECT fail closed',async()=>{
  await pool.query(`ALTER TABLE public.source_events RENAME COLUMN payload_hash TO saved_hash`)
  const a=await openSnapshot(config),b=await openSnapshot(config)
  try{await expect(scanMapping(a,b,{onDetail:async()=>{}})).rejects.toThrow('schema_contract_missing')}
  finally{await a.close();await b.close();await pool.query('ALTER TABLE public.source_events RENAME COLUMN saved_hash TO payload_hash')}
  await pool.query(`ALTER ROLE shared_source_denied LOGIN PASSWORD 'only-test';`)
  const deniedUrl=new URL(url!);deniedUrl.username='shared_source_denied';deniedUrl.password='only-test'
  const c=await openSnapshot({...config,connectionString:deniedUrl.href,expected:{...config.expected,role:'shared_source_denied'}})
  const d=await openSnapshot(config)
  try{await expect(scanMapping(c,d,{onDetail:async()=>{}})).rejects.toMatchObject({code:'42501'})}finally{await c.close();await d.close()}
 })
 test('mapping keeps frozen canonical header sequence after Journal pruning and rejects conflicting metadata',async()=>{
  await pool.query(`ALTER TABLE public.events ADD COLUMN source_header_version int,ADD COLUMN source_sequence bigint,ADD COLUMN canonical_payload_hash text,ADD COLUMN source_classification jsonb;
   UPDATE public.events SET source_header_version=1,source_sequence=19,canonical_payload_hash=(SELECT encode(payload_hash,'hex') FROM public.source_events WHERE origin_position='1'),source_classification=(SELECT classification FROM public.source_events WHERE origin_position='1') WHERE id=9007199254740993;
   DELETE FROM public.extension_source_outbox WHERE source_kind='canonical_event'`)
  const scan=async()=>{const a=await openSnapshot(config),b=await openSnapshot(config);try{return await scanMapping(a,b,{onDetail:async()=>{}})}finally{await a.close();await b.close()}}
  expect((await scan()).counts['unique-hot']).toBe('3')
  await pool.query('UPDATE public.events SET source_header_version=2 WHERE id=9007199254740993')
  expect((await scan()).counts.unproven).toBe('3')
  await pool.query("UPDATE public.events SET source_header_version=1,canonical_payload_hash=repeat('0',64) WHERE id=9007199254740993")
  expect((await scan()).counts.conflict).toBe('3')
 })

 test('in-place legacy planning requires explicit original identity and owner custody, preserves unknown provenance and never exports or removes the body',async()=>{
  const installation='10000000-0000-0000-0000-000000000001',known='70000000-0000-0000-0000-000000000071',unknown='70000000-0000-0000-0000-000000000072',session='legacy-custody-session'
  await pool.query(`ALTER TABLE public.extension_installations ADD COLUMN IF NOT EXISTS owner_scope_kind text,ADD COLUMN IF NOT EXISTS owner_scope_id uuid,
   ADD COLUMN IF NOT EXISTS authorization_epoch bigint DEFAULT 1,ADD COLUMN IF NOT EXISTS config_version bigint DEFAULT 1,ADD COLUMN IF NOT EXISTS provider_id text DEFAULT 'pocketctl-memory';
   CREATE TABLE public.memory_installations(installation_id uuid PRIMARY KEY,provider_id text,config_version bigint);
   CREATE TABLE public.memory_owner_scopes(installation_id uuid PRIMARY KEY,owner_scope_kind text,owner_scope_id uuid,state text,authorization_epoch bigint);
   CREATE TABLE public.sessions(session_id text PRIMARY KEY,user_id int);`)
  await pool.query("UPDATE public.extension_installations SET owner_scope_kind='personal',owner_scope_id=$1 WHERE installation_id=$1",[installation])
  await pool.query("INSERT INTO public.memory_installations VALUES($1,'pocketctl-memory',1)",[installation]);await pool.query("INSERT INTO public.memory_owner_scopes VALUES($1,'personal',$1,'active',1)",[installation]);await pool.query('INSERT INTO public.sessions VALUES($1,1)',[session])
  const proof={version:1,producer:'codex',session_id:session,turn_id:'legacy-turn',event_id:'legacy-wire',sequence:'19',invocation_id:'legacy-invocation',source_role:'assistant',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}
  const bodies=[{text:'PRIVATE LEGACY BODY MUST NOT EXPORT',turn_id:'legacy-turn',memory_source:proof},{text:'PRIVATE UNKNOWN BODY MUST NOT EXPORT',turn_id:'legacy-turn'}]
  for(const [n,id] of [known,unknown].entries()){
   const payload=bodies[n],classification=n===0?{memory_source:proof}:{},provenance=n===0?{memory:proof}:{}
   await pool.query(`INSERT INTO public.source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,source_provenance,classification)
    VALUES($1,$2,'feed',$3,$4,'legacy-turn','agent_text',now(),$5,$6,$7,$8)`,[id,installation,String(171+n),session,payload,canonicalPayloadHash(payload),provenance,classification])
   await pool.query("INSERT INTO public.memory_feed_inbox VALUES($1,$2,'canonical_event',$3,$4,'legacy-turn','agent_text',$5,$6)",[installation,String(171+n),'event:'+(n===0?'9007199254741999':'9007199254741998'),session,payload,classification])
  }
  // The FK above is inventory test data; real Memory/Relay databases cannot
  // have this cross-database FK, including for a historical missing event.
  await pool.query('ALTER TABLE public.memory_snapshot_events DROP CONSTRAINT snapshot_event_fk')
  const snapshotSource='70000000-0000-0000-0000-000000000073',snapshotCanonical='9007199254741996',snapshotBody={text:'PRIVATE SNAPSHOT BODY MUST NOT EXPORT',turn_id:'legacy-turn'},recorded='2026-11-01T00:00:00.000Z'
  const envelopeHash=canonicalPayloadHash({event_id:snapshotCanonical,event_type:'agent_text',created_at:recorded,payload:snapshotBody})
  await pool.query(`INSERT INTO public.source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,source_provenance,classification)
   VALUES($1,$2,'snapshot',$3,$4,'legacy-turn','agent_text',$5,$6,$7,'{}','{}')`,[snapshotSource,installation,snapshotCanonical,session,recorded,snapshotBody,envelopeHash])
  await pool.query("INSERT INTO public.memory_snapshot_events VALUES($1,$2,$3,'agent_text',$4)",[installation,session,snapshotCanonical,snapshotBody])
  let summary:any
  const evaluate=async(enabled=true)=>{const m=await openSnapshot(config),r=await openSnapshot(config),details:any[]=[];try{summary=await scanMapping(m,r,{legacyInPlace:enabled,pageSize:1,onDetail:async row=>{details.push(row)}});return details.filter(row=>[known,unknown,snapshotSource].includes(row.sourceEventId))}finally{await m.close();await r.close()}}
  expect((await evaluate(false))[0].state).toBe('unproven')
  const planned=await evaluate()
  for(const row of planned){expect(row.state).toBe('verified-legacy-only');expect(row.sourceKind).toBe('legacy_archive');expect(row.canonicalId).toBe(row.sourceEventId);expect(row.legacyManifestHash).toMatch(/^[a-f0-9]{64}$/);expect(row.legacyCustody.bodyDisposition).toBe('retain-in-place');expect(row.deletionEligible).toBe(false)}
  expect(planned.find(row=>row.sourceEventId===known).legacyCustody.originalCanonicalKey).toBe('9007199254741999')
  expect(planned.find(row=>row.sourceEventId===unknown).provenanceState).toBe('unknown')
  expect(planned.find(row=>row.sourceEventId===unknown).reasons).toContain('provenance_unknown')
  expect(planned.find(row=>row.sourceEventId===snapshotSource)).toMatchObject({originalSourceHash:envelopeHash.toString('hex'),originalHashVersion:'snapshot-envelope-sha256-v1',contentHash:canonicalPayloadHash(snapshotBody).toString('hex'),provenanceState:'unknown'})
  expect(Object.keys(summary.counts).sort()).toEqual(['unique-hot','unique-cold','team-collaboration','accepted-delivery','known-deleted','revoked','verified-legacy-only','conflict','ambiguous','unproven'].sort())
  expect(Object.values(summary.counts).reduce((sum:bigint,n:any)=>sum+BigInt(n),0n)).toBe(BigInt(summary.scanned))
  expect(summary).toMatchObject({fullMappingExecuted:true,mappingProofsComplete:false,legacyInPlacePlanning:true,migrationReady:false,deletionAuthorized:false})
  expect(summary.blockers).toContain('source_identity_proofs_incomplete')
  expect(JSON.stringify(planned)).not.toMatch(/PRIVATE LEGACY|PRIVATE UNKNOWN|PRIVATE SNAPSHOT|postgres:\/\//)
  expect((await evaluate()).map(row=>row.legacyManifestHash)).not.toEqual(planned.map(row=>row.legacyManifestHash)) // new independent snapshot identities
  await pool.query("UPDATE public.extension_installations SET provider_id='other' WHERE installation_id=$1",[installation]);expect((await evaluate())[0].state).toBe('conflict');await pool.query("UPDATE public.extension_installations SET provider_id='pocketctl-memory' WHERE installation_id=$1",[installation])
  await pool.query("UPDATE public.memory_owner_scopes SET owner_scope_id='10000000-0000-0000-0000-000000000099'")
  expect((await evaluate())[0].state).toBe('conflict');await pool.query('UPDATE public.memory_owner_scopes SET owner_scope_id=$1',[installation])
  await pool.query('UPDATE public.sessions SET user_id=2 WHERE session_id=$1',[session]);expect((await evaluate())[0].state).toBe('conflict');await pool.query('UPDATE public.sessions SET user_id=1 WHERE session_id=$1',[session])
  await pool.query('DELETE FROM public.memory_feed_inbox WHERE feed_id=172')
  expect((await evaluate()).find(row=>row.sourceEventId===unknown).state).toBe('unproven')
  await pool.query("INSERT INTO public.events(id,session_id,event_type,payload,user_id,body_storage) VALUES(9007199254741999,$1,'agent_text',$2,1,'hot')",[session,bodies[0]])
  expect((await evaluate())[0].state).not.toBe('verified-legacy-only')
  await pool.query('DELETE FROM public.events WHERE id=9007199254741999');await pool.query('INSERT INTO public.deleted_sessions VALUES($1,1)',[session])
  expect((await evaluate())[0].state).toBe('known-deleted')
  const original=(await pool.query('SELECT payload,encode(payload_hash,\'hex\') AS hash FROM public.source_events WHERE source_event_id=$1',[known])).rows[0]
  expect(original.payload).toEqual(bodies[0]);expect(original.hash).toBe(canonicalPayloadHash(bodies[0]).toString('hex'))
 })

})
