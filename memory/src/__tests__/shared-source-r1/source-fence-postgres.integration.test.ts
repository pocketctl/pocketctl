import pg from 'pg'
import {applyMemorySchema} from '../../schema.js'
import {afterAll,beforeAll,describe,expect,test,vi} from 'vitest'
import {planSourceFence,applySourceFence,verifySourceFence,type SourceFenceConfig,type DrainEvidence} from '../../migrations/shared-forward/source-fence.js'
const url=process.env.SHARED_W4_FENCE_TEST_DATABASE_URL
const suite=url?describe:describe.skip
suite('actual dedicated source role/ACL/backend fence',()=>{
 let admin:pg.Client,config:SourceFenceConfig,old:string,dbName:string
 const units={api:'synthetic-api.service',worker:'synthetic-worker.service',freshInstall:false}
 const probe=async():Promise<DrainEvidence>=>({api:{LoadState:'loaded',ActiveState:'inactive',SubState:'dead',MainPID:'0'},worker:{LoadState:'loaded',ActiveState:'inactive',SubState:'dead',MainPID:'0'},observedAt:new Date().toISOString()})
 const options={probe}
 async function sql(text:string){const c=new pg.Client({connectionString:url});await c.connect();try{return await c.query(text)}finally{await c.end()}}
 beforeAll(async()=>{
  if(!url||!new URL(url).pathname.endsWith('_test'))throw Error('isolated_test_required')
  const schemaPool=new pg.Pool({connectionString:url});await applyMemorySchema(schemaPool);await schemaPool.end()
  admin=new pg.Client({connectionString:url});await admin.connect();dbName=new URL(url).pathname.slice(1);old=dbName+'_old_'+process.pid
  await admin.query('CREATE ROLE '+old+" LOGIN PASSWORD 'synthetic-only'")
  await admin.query('GRANT CONNECT ON DATABASE '+dbName+' TO '+old)
  await admin.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO '+old);await admin.query('GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO '+old)
  await admin.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES('10000000-0000-0000-0000-000000000064','pocketctl-memory','active','ready',1)`)
  await admin.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES('10000000-0000-0000-0000-000000000064','source-sentinel',now(),now())`)
  await admin.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash,source_sequence,source_provenance) VALUES(gen_random_uuid(),'10000000-0000-0000-0000-000000000064','feed','9007199254740993','source-sentinel','agent_text',now(),'{"text":"source body unchanged"}',decode(repeat('ab',32),'hex'),9007199254740994,'{"state":"unknown"}')`)
  const expected=(await admin.query(`SELECT current_database() AS database,current_user AS role,d.oid::text AS "databaseOid",inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort" FROM pg_database d WHERE datname=current_database()`)).rows[0]
  config={database:{url,expected},oldMemoryRole:old,targetRoles:['synthetic_target_role'],reviewedConnectRoles:[old],units}
  await admin.end()
 },60000)
 afterAll(async()=>{if(!config)return;admin=new pg.Client({connectionString:url});await admin.connect();await admin.query('REVOKE ALL ON DATABASE '+dbName+' FROM '+old);await admin.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM '+old);await admin.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM '+old);await admin.query('DROP ROLE '+old);await admin.end()})
 test('read-only plan binds identity, and stop evidence precedes any role/ACL mutation',async()=>{
  await expect(planSourceFence({...config,targetRoles:[old]},options)).rejects.toThrow('unsafe_old_memory_role')
  const p=await planSourceFence(config,options);expect(p.role.login).toBe(true);expect(p.role.oid).toMatch(/^\d+$/)
  await expect(planSourceFence({...config,database:{...config.database,expected:{...config.database.expected,database:'wrong_test'}}},options)).rejects.toThrow('database_identity_mismatch')
  await expect(applySourceFence(config,p,{probe:async()=>({...await probe(),worker:{LoadState:'loaded',ActiveState:'active',SubState:'running',MainPID:'99'}})})).rejects.toThrow('memory_service_not_drained')
  expect((await planSourceFence(config,options)).role.login).toBe(true)
 })
 test('unknown peers and active old writers are refused',async()=>{
  const peer=new pg.Client({connectionString:url});await peer.connect()
  await expect(planSourceFence(config,options)).rejects.toThrow('unknown_source_peer');await peer.end()
  const oldUrl=new URL(url!);oldUrl.username=old;oldUrl.password='synthetic-only';const writer=new pg.Client({connectionString:oldUrl.toString()});await writer.connect();writer.on('error',()=>{})
  try{await writer.query('BEGIN');await writer.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash) VALUES(gen_random_uuid(),'10000000-0000-0000-0000-000000000064','feed','9007199254740995','source-sentinel','agent_text',now(),'{"text":"uncommitted writer"}',decode(repeat('ab',32),'hex'))`)
  await expect(planSourceFence(config,options)).rejects.toThrow('active_source_backend');}finally{await writer.query('ROLLBACK').catch(()=>{});await writer.end()}
 })
 test('role and ACL drift abort instead of accepting a new review',async()=>{
  const p=await planSourceFence(config,options),c=new pg.Client({connectionString:url});await c.connect();await c.query('ALTER ROLE '+old+' CREATEDB');await c.end()
  await expect(applySourceFence(config,p,options)).rejects.toThrow('unsafe_old_memory_role')
  const restore=new pg.Client({connectionString:url});await restore.connect();await restore.query('ALTER ROLE '+old+' NOCREATEDB');await restore.query('GRANT TEMPORARY ON DATABASE '+dbName+' TO PUBLIC');await restore.query('REVOKE CREATE ON DATABASE '+dbName+' FROM PUBLIC');await restore.query('REVOKE TEMPORARY ON DATABASE '+dbName+' FROM PUBLIC');await restore.end()
  await expect(applySourceFence(config,p,options)).rejects.toThrow('source_fence_acl_drift')
 })
 test('new backends, unknown ACL grantees and role membership changes require a new review',async()=>{
  const p=await planSourceFence(config,options),oldUrl=new URL(url!);oldUrl.username=old;oldUrl.password='synthetic-only'
  const unexpected=new pg.Client({connectionString:oldUrl.toString()});unexpected.on('error',()=>{});await unexpected.connect();await unexpected.query('SELECT 1')
  try{await expect(applySourceFence(config,p,options)).rejects.toThrow('source_fence_backend_drift')}finally{await unexpected.end()}
  const c=new pg.Client({connectionString:url});await c.connect();await c.query('GRANT pg_monitor TO '+old);await c.end()
  try{await expect(applySourceFence(config,p,options)).rejects.toThrow('old_memory_role_has_memberships')}finally{await sql('REVOKE pg_monitor FROM '+old)}
  const unknown=old+'_peer';await sql('CREATE ROLE '+unknown+' NOLOGIN');await sql('GRANT CONNECT ON DATABASE '+dbName+' TO '+unknown)
  try{await expect(applySourceFence(config,p,options)).rejects.toThrow('unreviewed_source_connect_grantee')}finally{await sql('REVOKE ALL ON DATABASE '+dbName+' FROM '+unknown);await sql('DROP ROLE '+unknown)}
 })
 test('cross-database PUBLIC business access and privileged routines refuse global NOLOGIN before mutation',async()=>{
  const peerDatabase=dbName.replace(/_test$/,'_peer_test'),creatorUrl=new URL(url!);creatorUrl.pathname='/postgres'
  const creator=new pg.Client({connectionString:creatorUrl.toString()});await creator.connect();await creator.query('CREATE DATABASE '+peerDatabase);await creator.end()
  const peerUrl=new URL(url!);peerUrl.pathname='/'+peerDatabase
  const peer=new pg.Client({connectionString:peerUrl.toString()});await peer.connect();await peer.query('CREATE TABLE public.other_service(id int);GRANT SELECT ON public.other_service TO PUBLIC')
  const oldUrl=new URL(peerUrl);oldUrl.username=old;oldUrl.password='synthetic-only';const service=new pg.Client({connectionString:oldUrl.toString()});await service.connect();await service.query('SELECT * FROM other_service');await service.end()
  try{
   await expect(planSourceFence(config,options)).rejects.toThrow('old_memory_role_cross_database_public_capability')
   expect((await sql("SELECT rolcanlogin FROM pg_roles WHERE rolname='"+old+"'")).rows[0].rolcanlogin).toBe(true)
   await peer.query('REVOKE SELECT ON public.other_service FROM PUBLIC')
   const reviewed=await planSourceFence(config,options)
   await peer.query('CREATE FUNCTION public.other_service_api() RETURNS int LANGUAGE SQL SECURITY DEFINER AS \'SELECT 1\'')
   await expect(applySourceFence(config,reviewed,options)).rejects.toThrow('old_memory_role_cross_database_public_capability')
   expect((await sql("SELECT rolcanlogin FROM pg_roles WHERE rolname='"+old+"'")).rows[0].rolcanlogin).toBe(true)
   const stillWorks=new pg.Client({connectionString:oldUrl.toString()});await stillWorks.connect();expect((await stillWorks.query('SELECT other_service_api() AS n')).rows[0].n).toBe(1);await stillWorks.end()
  }finally{await peer.query('REVOKE ALL ON public.other_service FROM PUBLIC;DROP FUNCTION IF EXISTS public.other_service_api()');await peer.end()}
 })
 test('already cancelled operations and delayed stop probes cannot begin mutations',async()=>{
  const p=await planSourceFence(config,options),controller=new AbortController();controller.abort()
  await expect(applySourceFence(config,p,{...options,signal:controller.signal})).rejects.toThrow('maintenance_interrupted')
  await expect(applySourceFence(config,p,{probe:async()=>({...await probe(),observedAt:new Date(Date.now()-60000).toISOString()})})).rejects.toThrow('stale_systemd_evidence')
  expect((await planSourceFence(config,options)).role.login).toBe(true)
 })
 test('exact idle backend is drained only after NOLOGIN/CONNECT commit, then apply/verify repeat safely',async()=>{
  const oldUrl=new URL(url!);oldUrl.username=old;oldUrl.password='synthetic-only';const idle=new pg.Client({connectionString:oldUrl.toString(),application_name:'reviewed-old-memory'});idle.on('error',()=>{});await idle.connect();await idle.query('SELECT 1')
  const p=await planSourceFence(config,options);expect(p.backends).toHaveLength(1)
  const controller=new AbortController(),query=pg.Client.prototype.query
  const wire=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:any[]):any{
   const result=(query as any).apply(this,args)
   if(String(args[0])==='COMMIT')return result.then((r:any)=>{controller.abort();return r})
   return result
  } as any)
  try{await expect(applySourceFence(config,p,{...options,signal:controller.signal})).rejects.toThrow('maintenance_interrupted')}finally{wire.mockRestore()}
  expect((await sql("SELECT rolcanlogin FROM pg_roles WHERE rolname='"+old+"'")).rows[0].rolcanlogin).toBe(false)
  const result=await applySourceFence(config,p,options);expect(result.sourceFrozen).toBe(true)
  await idle.end().catch(()=>{});expect((await verifySourceFence(config,p,options)).sourceFrozen).toBe(true)
  expect((await applySourceFence(config,p,options)).sourceFrozen).toBe(true)
  const denied=new pg.Client({connectionString:oldUrl.toString()});await expect(denied.connect()).rejects.toMatchObject({code:'28000'});await denied.end().catch(()=>{})
  const connectRole='w4_connect_probe_'+process.pid;await sql('CREATE ROLE '+connectRole+" LOGIN PASSWORD 'synthetic-only'");const probeUrl=new URL(url!);probeUrl.username=connectRole;probeUrl.password='synthetic-only';const connectProbe=new pg.Client({connectionString:probeUrl.toString()})
  try{await expect(connectProbe.connect()).rejects.toMatchObject({code:'42501'})}finally{await connectProbe.end().catch(()=>{});await sql('DROP ROLE '+connectRole)}
  const c=new pg.Client({connectionString:url});await c.connect();expect((await c.query('SELECT origin_position::text,payload FROM source_events')).rows).toEqual([{origin_position:'9007199254740993',payload:{text:'source body unchanged'}}]);expect((await c.query("SELECT has_database_privilege('public',current_database(),'CONNECT') AS can_connect")).rows[0].can_connect).toBe(false);await c.end()
 })
})
