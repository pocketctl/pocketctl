import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createNativeInstallationDiscovery} from '../../installations/native-discovery.js'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {directLaunchFixture} from './direct-launch-fixture.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {provisionSharedDatabase} from '../../migrations/shared-db/namespace.js'
import {bindSourcePool} from '../../sources/pool-context.js'
import {retireLegacyTransport} from '../../migrations/shared-forward/legacy-transport-retirement.js'
import {readLegacySourceInputGeneration} from '../../sources/input-mode.js'
import {assertTransportMetadataContract} from '../../sources/transport-state.js'
const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('explicit physical legacy transport retirement',()=>{
 let db:pg.Client,input:any,installation:string,sourceBefore:any,organization:string,organizationBefore:any,orgLocalBefore:any,orgObservationBefore:any
 const present=async()=>(await db.query("SELECT to_regclass('memory.memory_feed_inbox') IS NOT NULL AS raw,to_regclass('memory.memory_source_delivery_receipts') IS NOT NULL AS receipts,(SELECT legacy_transport_retired FROM shared.memory_source_contract) AS retired")).rows[0]
 beforeAll(async()=>{
  const f=await directLaunchFixture(url!)
  const controls=await import(pathToFileURL(resolve('../relay/dist/shared-source/control-capture.js')).href);await controls.applyRelayControlCapture(f.pool)
  const source=await f.source();installation=(await f.install(source,'retained_history')).inst.installation_id
  organization=randomUUID();const orgScope=randomUUID()
  await f.pool.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,'preserved synthetic organization')",[orgScope])
  await f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory','organization',$2,'active','{}',ARRAY['scope.lifecycle.v2','scope.membership.v2','scope.installation.v2'],ARRAY['memory.search','memory.manage'],'from_now')",[organization,orgScope])

  await f.pool.query("UPDATE shared.memory_source_modes SET mode='legacy-feed' WHERE installation_id=$1",[installation]);await applySharedSourceContract(f.pool,{targetProfile:'personal-relay-only',preservedInstallations:[installation,organization]});await provisionSharedDatabase(f.pool,{memoryRole:'direct_launch_memory',relayRole:'direct_launch_relay',migratorRole:'direct_launch_definer'});await f.pool.query("UPDATE shared.memory_source_modes SET mode='shared-active',generation=3 WHERE installation_id=$1",[installation]);await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  const discovery=createNativeInstallationDiscovery({pool:f.runtime,signal:new AbortController().signal,installationAllowlist:new Set([installation,organization])})
  try{expect(await discovery.discoverOnce()).toBe(2)}finally{await discovery.stop()}
  organizationBefore=(await f.pool.query('SELECT to_jsonb(i) AS row FROM public.extension_installations i WHERE installation_id=$1',[organization])).rows[0].row
  orgLocalBefore=(await f.pool.query('SELECT to_jsonb(i) AS row FROM memory.memory_installations i WHERE installation_id=$1',[organization])).rows[0].row
  orgObservationBefore=(await f.pool.query('SELECT to_jsonb(i) AS row FROM memory.memory_native_control_observations i WHERE installation_id=$1',[organization])).rows[0].row
  await f.pool.query(`INSERT INTO memory.source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'kept',NOW(),NOW());`,[installation])
  await f.pool.query(`INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload_hash,payload,classification) VALUES(gen_random_uuid(),$1,'feed','1001','kept','agent_text',NOW(),decode(repeat('ab',32),'hex'),' {"necessary":"original"}','{}')`,[installation])
  sourceBefore=(await f.pool.query('SELECT to_jsonb(s) AS row FROM memory.source_events s')).rows
  await f.pool.query(`INSERT INTO memory.memory_feed_inbox(installation_id,feed_id,envelope_version,topic,source_kind,source_id,session_id,event_type,recorded_at,data,classification,payload_hash,projection_state,projected_at,body_reclaimed_at)
   SELECT $1,x,1,'session.event.v1','canonical_event','event:'||x,'kept','agent_text',NOW(),'{}','{}',decode(repeat('ab',32),'hex'),'projected',NOW(),NOW() FROM generate_series(1001,1002) x`,[installation])
  await f.pool.query('INSERT INTO memory.memory_inbox_checkpoints(installation_id,last_ack_feed_id) VALUES($1,1002)',[installation])
  const identity=(await f.pool.query('SELECT current_database() AS name,d.oid::text AS oid,(SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier" FROM pg_database d WHERE datname=current_database()')).rows[0]
  await f.pool.query('ALTER ROLE direct_launch_memory NOLOGIN');await f.close()
  db=new pg.Client({connectionString:process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL,options:'-c search_path=pg_catalog,memory,shared -c statement_timeout=5000 -c lock_timeout=1000'});await db.connect();bindSourcePool(db,{namespace:'memory'})
  input={installationId:installation,modeGeneration:'3',configVersion:'2',principalUserId:String(source.owner),runtimeRole:'direct_launch_memory',migratorRole:'direct_launch_definer',preservedInstallationIds:[installation,organization],expectedDatabase:identity,expected:{deliveryRows:'2',minFeedId:'1001',maxFeedId:'1002',lastAckFeedId:'1002'},bodyProofManifestHash:'a'.repeat(64),sourceCommit:'b'.repeat(40)}
 },60000)
 afterAll(async()=>{await db?.end()})
 test('requires the durable actual subscription retirement before deleting storage',async()=>{
  await db.query("UPDATE public.extension_installations SET config_version=2,subscriptions='{}' WHERE installation_id=$1",[installation])
  await expect(retireLegacyTransport(db,input)).rejects.toThrow('legacy_transport_input_not_retired');expect(await present()).toEqual({raw:true,receipts:false,retired:false})
  await db.query('INSERT INTO shared.memory_session_transport_retirements(installation_id,mode_generation,retired_config_version,removed_topics) VALUES($1,3,2,ARRAY[\'session.event.v1\'])',[installation]);await db.query("UPDATE public.extension_installations SET subscriptions='{}' WHERE installation_id=$1",[installation])
 })
 test('refuses any body whose individual retirement has not completed',async()=>{
  await db.query("UPDATE memory_feed_inbox SET data='{\"still\":\"raw\"}',body_reclaimed_at=NULL WHERE feed_id=1001")
  try{await expect(retireLegacyTransport(db,input)).rejects.toThrow('legacy_transport_body_or_gap_remaining')}
  finally{await db.query("UPDATE memory_feed_inbox SET data='{}',body_reclaimed_at=NOW() WHERE feed_id=1001")}
  expect(await present()).toEqual({raw:true,receipts:false,retired:false})
 })
 test('retains unhandled/error delivery gaps instead of discarding them',async()=>{
  await db.query("UPDATE memory_feed_inbox SET projection_state='quarantined',error_code='oversized_content' WHERE feed_id=1001")
  try{await expect(retireLegacyTransport(db,input)).rejects.toThrow('legacy_transport_body_or_gap_remaining')}
  finally{await db.query("UPDATE memory_feed_inbox SET projection_state='projected',error_code=NULL WHERE feed_id=1001")}
 })
 test('requires the fixed complete set and acknowledged terminal Feed',async()=>{
  await expect(retireLegacyTransport(db,{...input,expected:{...input.expected,deliveryRows:'1'}})).rejects.toThrow('legacy_transport_frozen_set_changed')
  await db.query('UPDATE memory_inbox_checkpoints SET last_ack_feed_id=1001')
  try{await expect(retireLegacyTransport(db,input)).rejects.toThrow('legacy_transport_frozen_set_changed')}
  finally{await db.query('UPDATE memory_inbox_checkpoints SET last_ack_feed_id=1002')}
 })
 test('never discards a unique old Snapshot body',async()=>{
  await db.query("INSERT INTO memory_snapshot_events(installation_id,session_id,relay_event_id,event_type,payload,payload_hash,created_at,generation) VALUES($1,'unique-snapshot',999,'agent_text','{\"unique\":true}',decode(repeat('ab',32),'hex'),NOW(),1)",[installation])
  try{await expect(retireLegacyTransport(db,input)).rejects.toThrow('legacy_transport_snapshot_storage_remaining');expect(await present()).toEqual({raw:true,receipts:false,retired:false})}
  finally{await db.query('DELETE FROM memory_snapshot_events WHERE relay_event_id=999')}
 })
 test('rejects caller transactions and live writer capability',async()=>{
  await db.query('BEGIN');try{await expect(retireLegacyTransport(db,input)).rejects.toThrow('inbox_retirement_idle_connection_required');expect(db.getTransactionStatus()).toBe('T')}finally{await db.query('ROLLBACK')}
  await db.query('ALTER ROLE direct_launch_memory LOGIN');try{await expect(retireLegacyTransport(db,input)).rejects.toThrow('target_writers_not_fenced')}finally{await db.query('ALTER ROLE direct_launch_memory NOLOGIN')}
 })
 test('a second legacy consumer without any transport rows cannot be disabled by a global marker',async()=>{
  const peer='01234567-89ab-4cde-8123-456789abcdef'
  await db.query('SET search_path=pg_catalog,public,memory,shared')
  const owner=(await db.query("INSERT INTO public.users(email,password_hash) VALUES('second@test.invalid','x') RETURNING id")).rows[0].id
  await db.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,subscriptions,granted_scopes,enabled_services,event_filter,config_version,start_policy) VALUES($1,'pocketctl-memory',$2::int,'personal',$1::uuid,'active',ARRAY['session.event.v1'],ARRAY['session:events:read'],ARRAY['memory.manage'],'{}',1,'retained_history')",[peer,owner])
  try{await expect(retireLegacyTransport(db,input)).rejects.toThrow('legacy_transport_global_consumer_scope_changed');expect(await present()).toEqual({raw:true,receipts:false,retired:false})}
  finally{await db.query('DELETE FROM public.extension_installations WHERE installation_id=$1',[peer]);await db.query('DELETE FROM public.users WHERE id=$1',[owner]);await db.query('SET search_path=pg_catalog,memory,shared')}
 })
 test('RESTRICT preserves the old tables and marker atomically when any unreviewed dependency exists',async()=>{
  await db.query('CREATE TABLE public.unreviewed_transport_fk(installation_id uuid,feed_id bigint,FOREIGN KEY(installation_id,feed_id) REFERENCES memory.memory_feed_inbox(installation_id,feed_id))')
  try{await expect(retireLegacyTransport(db,input)).rejects.toMatchObject({code:'2BP01'});expect(await present()).toEqual({raw:true,receipts:false,retired:false})}
  finally{await db.query('DROP TABLE public.unreviewed_transport_fk')}
 })
 test('physically drops only transport, retaining exact content-free identity and least-role purge/read access',async()=>{
  const before=(await db.query('SELECT to_jsonb(f) AS row FROM memory_source_delivery_facts f ORDER BY feed_id')).rows
  await db.query('CREATE ROLE unexpected_transport_reader NOLOGIN;ALTER DEFAULT PRIVILEGES IN SCHEMA memory GRANT SELECT ON TABLES TO unexpected_transport_reader;GRANT SELECT(source_id) ON memory.memory_source_delivery_facts TO unexpected_transport_reader')
  const result=await retireLegacyTransport(db,input)
  const leaks=(await db.query("SELECT has_table_privilege('unexpected_transport_reader',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege('unexpected_transport_reader',c.oid,'SELECT,INSERT,UPDATE,REFERENCES') AS unsafe FROM pg_class c WHERE c.oid=ANY(ARRAY['memory.memory_source_delivery_receipts'::regclass,'memory.memory_source_snapshot_receipts'::regclass,'memory.memory_source_delivery_facts'::regclass,'memory.memory_source_snapshot_facts'::regclass])")).rows
  expect(leaks.every(r=>!r.unsafe)).toBe(true)
  expect(result).toMatchObject({deliveryRows:'2',snapshotRows:'0',oldPhysicalTablesRemoved:4,sourceIdsPreserved:true,rawBodiesSaved:false})
  expect(await present()).toEqual({raw:false,receipts:true,retired:true});await assertTransportMetadataContract(db)
  expect((await db.query('SELECT to_jsonb(f) AS row FROM memory_source_delivery_facts f ORDER BY feed_id')).rows).toEqual(before)
  expect((await db.query('SELECT to_jsonb(s) AS row FROM source_events s')).rows).toEqual(sourceBefore)
  expect((await db.query('SELECT to_jsonb(i) AS row FROM public.extension_installations i WHERE installation_id=$1',[organization])).rows[0].row).toEqual(organizationBefore)
  expect((await db.query('SELECT to_jsonb(i) AS row FROM memory_installations i WHERE installation_id=$1',[organization])).rows[0].row).toEqual(orgLocalBefore)
  expect((await db.query('SELECT to_jsonb(i) AS row FROM memory_native_control_observations i WHERE installation_id=$1',[organization])).rows[0].row).toEqual(orgObservationBefore)
  expect((await db.query('SELECT DISTINCT installation_id::text FROM memory_source_delivery_receipts')).rows).toEqual([{installation_id:installation}])
  // A later real native control change stays readable after raw transport is
  // gone. This synthetic revision does not activate any Team/body source.
  await db.query('UPDATE public.extension_installations SET config_version=config_version+1 WHERE installation_id=$1',[organization])
  await db.query('BEGIN;SET LOCAL ROLE direct_launch_memory')
  try{
   const page=(await db.query('SELECT shared.memory_installation_inventory_page(NULL,128,NULL) AS page')).rows[0].page
   expect(page.installations.find((i:any)=>i.installation_id===organization)).toMatchObject({config_version:'2',subscriptions:organizationBefore.subscriptions})
   expect(await readLegacySourceInputGeneration(db as unknown as pg.Pool,organization)).toBeNull()
  }finally{await db.query('ROLLBACK')}
  expect((await db.query("SELECT attname FROM pg_attribute WHERE attrelid='memory.memory_source_delivery_receipts'::regclass AND attnum>0 AND NOT attisdropped")).rows.some(r=>['data','classification','payload'].includes(r.attname))).toBe(false)
  await db.query('BEGIN;SET LOCAL ROLE direct_launch_memory');try{
   expect((await db.query('SELECT count(*)::text AS count FROM memory_source_delivery_facts')).rows[0].count).toBe('2')
   await expect(db.query("SELECT shared.lock_memory_legacy_input($1,NULL)",[installation])).rejects.toThrow('legacy_transport_retired')
  }finally{await db.query('ROLLBACK')}
  await db.query('BEGIN;SET LOCAL ROLE direct_launch_memory');try{await db.query("DELETE FROM memory_source_delivery_facts WHERE session_id='kept'")}finally{await db.query('ROLLBACK')}
  await expect(retireLegacyTransport(db,input)).rejects.toThrow('inbox_retirement_scope_changed')
 })
})
