import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,beforeEach,describe,test,expect} from 'vitest'
import {canonicalPayloadHash,createPostgresSharedSourceReader} from '@pocketctl/session-source'
import {directLaunchFixture} from './direct-launch-fixture.js'
import {bindSourcePool} from '../../sources/pool-context.js'
import * as retirement from '../../migrations/shared-forward/inbox-payload-retirement.js'
const prepare=(retirement as any).prepareInboxPayloadRetirement,apply=(retirement as any).applyInboxPayloadRetirement
const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('fenced target-only exact Inbox duplicate body retirement',()=>{
 let db:pg.Client,installation:string,sourceId:string,input:any,owner:number,canonical:any
 const data={text:'necessary original stays in source_events',turn_id:'t'},classification={},at=new Date('2026-10-01T00:00:00.000Z')
 beforeAll(async()=>{
  const f=await directLaunchFixture(url!);const source=await f.source();owner=source.owner;installation=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("UPDATE shared.memory_source_modes SET mode='shared-active',generation=3 WHERE installation_id=$1",[installation])
  await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  const key=await f.event(source),i=(await f.pool.query('SELECT * FROM public.extension_installations WHERE installation_id=$1',[installation])).rows[0]
  const scope={installationId:installation,principalUserId:String(owner),ownerScopeKind:'personal' as const,ownerScopeId:i.owner_scope_id,authorizationRevision:String(i.authorization_epoch),configVersion:'1',modeGeneration:'3'},root={kind:'relay_event' as const,key:String(owner)+':'+source.session}
  const reader=createPostgresSharedSourceReader(f.runtime),heads=await reader.getHeads(scope,root,[key]),resolved=await reader.resolveBodies(scope,root,heads.heads,heads.version)
  canonical={key,session:source.session,payload:resolved[0].payload,head:resolved[0].head,version:heads.version}
  await f.pool.query('INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,NOW(),NOW())',[installation,source.session])
  const identity=(await f.pool.query('SELECT current_database() AS database_name,d.oid::text AS database_oid,(SELECT system_identifier::text FROM pg_control_system()) AS system_identifier FROM pg_database d WHERE datname=current_database()')).rows[0]
  await f.pool.query('ALTER ROLE direct_launch_memory NOLOGIN');await f.close()
  db=new pg.Client({connectionString:process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL,options:'-c search_path=pg_catalog,memory,shared -c statement_timeout=5000 -c lock_timeout=1000'});await db.connect();bindSourcePool(db,{namespace:'memory'})
  input={installationId:installation,modeGeneration:'3',configVersion:'1',principalUserId:String(owner),runtimeRole:'direct_launch_memory',expectedDatabase:{name:identity.database_name,oid:identity.database_oid,systemIdentifier:identity.system_identifier},feedIds:['1001']}
  await db.query("CREATE TABLE public.inbox_retirement_sentinel(id int PRIMARY KEY,value text);INSERT INTO public.inbox_retirement_sentinel VALUES(1,'before')")
  await db.query("INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'original-session',$2,$2)",[installation,at])
 },60000)
 afterAll(async()=>{await db?.end()})
 beforeEach(async()=>{
  await db.query('DELETE FROM memory_feed_inbox;DELETE FROM source_events;DELETE FROM memory_inbox_checkpoints')
  sourceId=randomUUID();const envelope={envelope_version:1,feed_id:'1001',topic:'session.event.v1',source:{kind:'canonical_event',id:'event:42',recorded_at:at.toISOString()},subject:{session_id:'original-session',turn_id:'t',event_type:'agent_text'},classification,data}
  await db.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload_hash,classification,payload)
   VALUES($1,$2,'feed','1001','original-session','t','agent_text',$3,$4,$5,$6)`,[sourceId,installation,at,canonicalPayloadHash(data),classification,data])
  await db.query(`INSERT INTO memory_feed_inbox(installation_id,feed_id,envelope_version,topic,source_kind,source_id,session_id,turn_id,event_type,recorded_at,classification,data,payload_hash,projection_state,projected_at)
   VALUES($1,1001,1,'session.event.v1','canonical_event','event:42','original-session','t','agent_text',$2,$3,$4,$5,'projected',$2)`,[installation,at,classification,data,canonicalPayloadHash(envelope)])
  await db.query('INSERT INTO memory_inbox_checkpoints(installation_id,last_ack_feed_id) VALUES($1,2000)',[installation])
 })
 const ready=()=>{expect(prepare).toBeTypeOf('function');expect(apply).toBeTypeOf('function')}
 const body=async()=>(await db.query('SELECT data,classification,body_reclaimed_at,payload_hash FROM memory_feed_inbox WHERE installation_id=$1 AND feed_id=1001',[installation])).rows[0]
 test('retires only the exact duplicate, preserving original UUID/body/hash and unknown mapping',async()=>{
  ready();const original=(await db.query('SELECT to_jsonb(s) AS row FROM source_events s WHERE source_event_id=$1',[sourceId])).rows[0].row,wire=(await body()).payload_hash
  const page=await prepare(db,input),receipt=await apply(db,page)
  expect(receipt).toMatchObject({changed:1,normalizedRows:1,controlledReaderRows:0,sourceIdsPreserved:true,provenanceRewritten:false})
  expect(await body()).toMatchObject({data:{},classification:{},body_reclaimed_at:expect.any(Date),payload_hash:wire})
  expect((await db.query('SELECT to_jsonb(s) AS row FROM source_events s WHERE source_event_id=$1',[sourceId])).rows[0].row).toEqual(original)
  expect(JSON.stringify(page)).not.toContain(data.text);expect(JSON.stringify(receipt)).not.toContain(data.text)
 })
 test('an independent text/hash match cannot replace the typed feed origin link',async()=>{
  ready();await db.query("UPDATE source_events SET origin_position='other-identity' WHERE source_event_id=$1",[sourceId])
  await expect(prepare(db,input)).rejects.toThrow('inbox_retirement_source_unproven');expect((await body()).data).toEqual(data)
 })
 test('a forged wire envelope hash is rejected despite equal normalized source bodies',async()=>{
  ready();await db.query("UPDATE memory_feed_inbox SET payload_hash=decode(repeat('00',32),'hex')")
  await expect(prepare(db,input)).rejects.toThrow('inbox_retirement_envelope_unproven');expect((await body()).data).toEqual(data)
 })
 test('classification, source-body changes and stale page tokens cannot authorize clearing',async()=>{
  ready();const page=await prepare(db,input);await db.query("UPDATE source_events SET classification='{\"changed\":true}' WHERE source_event_id=$1",[sourceId])
  await expect(apply(db,page)).rejects.toThrow('inbox_retirement_changed');expect((await body()).data).toEqual(data)
 })
 test('unacknowledged and pending deliveries are never deletion proof',async()=>{
  ready();await db.query('UPDATE memory_inbox_checkpoints SET last_ack_feed_id=1000')
  await expect(prepare(db,input)).rejects.toThrow('inbox_retirement_delivery_unhandled')
  await db.query("UPDATE memory_inbox_checkpoints SET last_ack_feed_id=2000;UPDATE memory_feed_inbox SET projection_state='pending'")
  await expect(prepare(db,input)).rejects.toThrow('inbox_retirement_delivery_unhandled');expect((await body()).data).toEqual(data)
 })
 test('wrong DB/scope/config or a fabricated capability fails before mutation',async()=>{
  ready();await expect(prepare(db,{...input,expectedDatabase:{...input.expectedDatabase,oid:'1'}})).rejects.toThrow('inbox_retirement_identity_mismatch')
  await expect(prepare(db,{...input,configVersion:'2'})).rejects.toThrow('inbox_retirement_scope_changed')
  await expect(apply(db,{token:{}})).rejects.toThrow('inbox_retirement_token_invalid');expect((await body()).data).toEqual(data)
 })
 test('a live writer capability fences both preparation and a prepared apply',async()=>{
  ready();const page=await prepare(db,input);await db.query('ALTER ROLE direct_launch_memory LOGIN')
  try{await expect(apply(db,page)).rejects.toThrow('target_writers_not_fenced');await expect(prepare(db,input)).rejects.toThrow('target_writers_not_fenced')}
  finally{await db.query('ALTER ROLE direct_launch_memory NOLOGIN')}
  expect((await body()).data).toEqual(data)
 })
 const seedCanonicalCopy=async()=>{
  const c=canonical,payload=c.payload,classification=c.head.classification,when=new Date(c.head.occurredAt),turn=payload.turn_id??payload.source_turn_id??null
  const envelope={envelope_version:1,feed_id:'1001',topic:'session.event.v1',source:{kind:'canonical_event',id:'event:'+c.key,recorded_at:when.toISOString()},subject:{session_id:c.session,turn_id:turn,event_type:c.head.eventType},classification,data:payload}
  await db.query(`UPDATE source_events SET payload=NULL,mapping_state='verified',source_kind='relay_event',canonical_key=$2,canonical_session_key=$3,source_version=$4,
   content_hash=$5,hash_version='canonical-json-sha256-v1',adapter_version='original-ref-v1',session_id=$3,turn_id=$6,event_type=$7,occurred_at=$8,classification=$9,payload_hash=$10
   WHERE source_event_id=$1`,[sourceId,c.key,c.session,c.version,Buffer.from(c.head.contentHash,'hex'),turn,c.head.eventType,when,classification,canonicalPayloadHash(payload)])
  await db.query(`UPDATE memory_feed_inbox SET source_id=$2,session_id=$3,turn_id=$4,event_type=$5,recorded_at=$6,classification=$7,data=$8,payload_hash=$9 WHERE installation_id=$1 AND feed_id=1001`,[installation,'event:'+c.key,c.session,turn,c.head.eventType,when,classification,payload,canonicalPayloadHash(envelope)])
 }
 test('a bodyless original is cleared only after the actual least-role reader and commit barrier',async()=>{
  ready();await seedCanonicalCopy()
  const page=await prepare(db,input),receipt=await apply(db,page)
  expect(receipt).toMatchObject({changed:1,normalizedRows:0,controlledReaderRows:1,sourceIdsPreserved:true})
  expect((await body()).data).toEqual({});expect((await db.query('SELECT current_user AS role_name')).rows[0].role_name).toBe('postgres')
 })
 test('a canonical metadata label cannot substitute a different typed event identity',async()=>{
  ready();await seedCanonicalCopy();await db.query("UPDATE source_events SET canonical_key='999999' WHERE source_event_id=$1",[sourceId])
  await expect(prepare(db,input)).rejects.toThrow('inbox_retirement_source_unproven');expect((await body()).data).toEqual(canonical.payload)
 })
 test('revocation after actual body preparation prevents commit and restores the admin role',async()=>{
  ready();await seedCanonicalCopy();const page=await prepare(db,input)
  await db.query('UPDATE public.extension_installations SET authorization_epoch=authorization_epoch+1 WHERE installation_id=$1',[installation])
  await expect(apply(db,page)).rejects.toThrow();expect((await body()).data).toEqual(canonical.payload)
  expect((await db.query('SELECT current_user AS role_name')).rows[0].role_name).toBe('postgres')
 })
 test('an already cancelled operation performs no mutation',async()=>{
  ready();const page=await prepare(db,input),controller=new AbortController();controller.abort()
  await expect(apply(db,page,{signal:controller.signal})).rejects.toThrow('inbox_retirement_aborted');expect((await body()).data).toEqual(data)
 })
 test('the database itself rejects unproven bodyless originals',async()=>{
  ready();await expect(db.query('UPDATE source_events SET payload=NULL WHERE source_event_id=$1',[sourceId])).rejects.toMatchObject({code:'23514'});expect((await body()).data).toEqual(data)
 })
 test('preparation refuses an existing transaction without archive IO or changing its ownership',async()=>{
  ready();await db.query('BEGIN')
  try{await expect(prepare(db,input)).rejects.toThrow('inbox_retirement_idle_connection_required');expect(db.getTransactionStatus()).toBe('T')}
  finally{await db.query('ROLLBACK')}
 })
 test('apply cannot commit unrelated caller mutations from an outer transaction',async()=>{
  ready();const page=await prepare(db,input);await db.query("BEGIN;UPDATE public.inbox_retirement_sentinel SET value='caller'")
  try{await expect(apply(db,page)).rejects.toThrow('inbox_retirement_idle_connection_required');expect(db.getTransactionStatus()).toBe('T');expect((await body()).data).toEqual(data)}
  finally{await db.query('ROLLBACK')}
  expect((await db.query('SELECT value FROM public.inbox_retirement_sentinel')).rows[0].value).toBe('before')
 })
 for(const field of ['data','classification'] as const)test('oversized '+field+' is refused before any body reaches the client',async()=>{
  ready();await db.query('UPDATE memory.memory_feed_inbox SET '+field+"=jsonb_build_object('oversized',repeat('x',33554432))")
  const socket=(db as any).connection.stream,initial=socket.bytesRead
  const error=await prepare(db,input).then(()=>null,(e:Error)=>e.message)
  expect(socket.bytesRead-initial).toBeLessThan(65536);expect(error).toBe('inbox_retirement_page_byte_limit')
  expect((await db.query('SELECT body_reclaimed_at IS NULL AS retained FROM memory.memory_feed_inbox')).rows[0].retained).toBe(true)
 },15000)
 test('oversized Source hash is rejected before its hex encoding crosses the socket',async()=>{
  ready();await db.query("UPDATE memory.source_events SET payload_hash=decode(repeat('ab',33554432),'hex')")
  const socket=(db as any).connection.stream,initial=socket.bytesRead
  const error=await prepare(db,input).then(()=>null,(e:Error)=>e.message)
  expect(socket.bytesRead-initial).toBeLessThan(65536);expect(error).toBe('inbox_retirement_source_unproven')
  expect((await body()).data).toEqual(data)
 },15000)
 test('a hard transaction deadline closes only the owned connection before any deletion',async()=>{
  ready();const page=await prepare(db,input)
  await expect(apply(db,page,{transactionTimeoutMs:1})).rejects.toThrow('inbox_retirement_window_expired')
  await db.end().catch(()=>{});db=new pg.Client({connectionString:process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL,options:'-c search_path=pg_catalog,memory,shared -c statement_timeout=5000 -c lock_timeout=1000'});await db.connect();bindSourcePool(db,{namespace:'memory'})
  expect((await body()).data).toEqual(data)
 })

})
