import {createServer,type Server} from 'node:http'
import {generateKeyPairSync,randomUUID} from 'node:crypto'
import {once} from 'node:events'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import jwt from 'jsonwebtoken'
import {afterAll,afterEach,beforeAll,describe,expect,test} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {requireCurrentInstallationAuthority,requireCurrentScopePermission} from '../../governance/authorization.js'
import {requireGitPermission} from '../../git-sync/authorization.js'
import {createGrantGuard} from '../../auth/grant-guard.js'
import {createNativeInstallationDiscovery} from '../../installations/native-discovery.js'
import {provisionSharedDatabase} from '../../migrations/shared-db/namespace.js'
const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('signed grants separate current native authority from Memory local state',()=>{
 let f:DirectLaunchFixture,server:Server,issuer:string,guard:ReturnType<typeof createGrantGuard>,personal:string,organization:string,scope:string,member:string,owner:number
 const keys=generateKeyPairSync('rsa',{modulusLength:2048}),kid='native-guard-'+randomUUID()
 const binding=(installation:string,kind:'personal'|'organization',revision='1',permissions=['read'])=>({installation_id:installation,owner_scope_kind:kind,owner_scope_id:kind==='personal'?personal:scope,membership_id:kind==='personal'?null:member,membership_revision:kind==='personal'?'0':revision,authorization_epoch:'1',permissions})
 function token(kind:'v1'|'v2',installation=personal,config='1',revision='1',permissions=['read'],user=owner){
  return jwt.sign({token_type:kind==='v1'?'extension_capability':'extension_capability_v2',provider_id:'pocketctl-memory',caller_type:'web',services:['memory.search'],config_version:config,...(kind==='v1'?{installation_id:installation}:{primary_installation_id:installation,scope_bindings:[binding(installation,installation===personal?'personal':'organization',revision,permissions)]})},keys.privateKey,{algorithm:'RS256',keyid:kid,issuer,audience:'pocketctl-memory',subject:'user:'+user,expiresIn:kind==='v1'?120:60,jwtid:randomUUID()})
 }
 const v1=(signed=token('v1'))=>guard.guard({authorization:'Bearer '+signed,requiredService:'memory.search'})
 const v2=(signed=token('v2'))=>guard.guardV2({authorization:'Bearer '+signed,requiredService:'memory.search'})
 beforeAll(async()=>{
  f=await directLaunchFixture(url!)
  const controls=await import(pathToFileURL(resolve('../relay/dist/shared-source/control-capture.js')).href)
  await controls.applyRelayControlCapture(f.pool)
  await provisionSharedDatabase(f.pool,{memoryRole:'direct_launch_memory',relayRole:'direct_launch_relay',migratorRole:'direct_launch_definer'})
  const source=await f.source();owner=source.owner;personal=(await f.install(source,'retained_history')).inst.installation_id
  organization=randomUUID();scope=randomUUID();member=randomUUID()
  await f.pool.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,'native grant synthetic')",[scope])
  await f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory','organization',$2,'active','{}',ARRAY['scope.lifecycle.v2'],'{}','from_now')",[organization,scope])
  await f.pool.query("INSERT INTO public.extension_scope_memberships(membership_id,scope_kind,scope_id,user_id,roles) VALUES($1,'organization',$2,$3,ARRAY['contributor'])",[member,scope,owner])
  const discovery=createNativeInstallationDiscovery({pool:f.runtime,signal:new AbortController().signal})
  try{expect(await discovery.discoverOnce()).toBe(2)}finally{await discovery.stop()}
  const jwk={...keys.publicKey.export({format:'jwk'}),alg:'RS256',use:'sig',kid}
  server=createServer((req,res)=>{if(req.url!=='/.well-known/pocketctl-extension-jwks.json'){res.writeHead(404);res.end();return}res.setHeader('content-type','application/json');res.end(JSON.stringify({keys:[jwk]}))})
  server.listen(0,'127.0.0.1');await once(server,'listening');issuer='http://127.0.0.1:'+((server.address() as {port:number}).port)
  guard=createGrantGuard({pool:f.runtime,relayUrl:issuer,relayIssuer:issuer})
 },60000)
 afterEach(async()=>{
  if(!f)return
  await f.pool.query("UPDATE public.extension_installations SET config_version=1,status='active' WHERE installation_id=ANY($1::uuid[])",[[personal,organization]])
  await f.pool.query("UPDATE public.extension_scope_memberships SET membership_revision=1,state='active',roles=ARRAY['contributor'] WHERE membership_id=$1",[member])
  await f.pool.query("UPDATE public.extension_providers SET status='enabled' WHERE provider_id='pocketctl-memory'")
  await f.runtime.query("UPDATE memory_installations SET local_status='ready' WHERE installation_id=ANY($1::uuid[])",[[personal,organization]])
  await f.runtime.query('UPDATE memory_scope_memberships SET valid_until=NULL WHERE membership_id=$1',[member])
 })
 afterAll(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));await f?.close()})
 test('real RS256/JWKS signatures authorize current v1 and v2 personal grants',async()=>{
  expect(await v1()).toMatchObject({installationId:personal,userId:owner})
  expect(await v2()).toMatchObject({installationId:personal,userId:owner})
 })
 test('a changed JWT signature and a foreign signed subject are rejected',async()=>{
  const signed=token('v1'),parts=signed.split('.');parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1)
  await expect(v1(parts.join('.'))).rejects.toMatchObject({code:'unauthorized'})
  await expect(v1(token('v1',personal,'1','1',['read'],owner+100000))).rejects.toMatchObject({code:'unauthorized'})
 })
 test('native config is authoritative for new v2 grants before local discovery refresh',async()=>{
  await f.pool.query('UPDATE public.extension_installations SET config_version=2 WHERE installation_id=$1',[personal])
  expect((await f.runtime.query('SELECT config_version::text FROM memory_installations WHERE installation_id=$1',[personal])).rows[0].config_version).toBe('1')
  await expect(v2()).rejects.toMatchObject({code:'unauthorized'})
  expect(await v1(token('v1',personal,'2'))).toMatchObject({configVersion:'2'})
  expect(await v2(token('v2',personal,'2'))).toMatchObject({configVersion:'2'})
 })
 test('new native membership revision and permissions do not depend on a stale local role mirror',async()=>{
  await f.pool.query("UPDATE public.extension_scope_memberships SET membership_revision=2,roles=ARRAY['publisher'] WHERE membership_id=$1",[member])
  expect((await f.runtime.query('SELECT roles,membership_revision::text FROM memory_scope_memberships WHERE membership_id=$1',[member])).rows[0]).toEqual({roles:['contributor'],membership_revision:'1'})
  expect(await v2(token('v2',organization,'1','2',['read','publish']))).toMatchObject({scopeBindings:[{membership_revision:'2',permissions:['read','publish']}]})
 })
 test('personal management uses native config while retaining its physical authority lock',async()=>{
  await f.pool.query('UPDATE public.extension_installations SET config_version=2 WHERE installation_id=$1',[personal])
  const grant=await v1(token('v1',personal,'2')),client=await f.runtime.connect(),writer=await f.pool.connect()
  try{
   await client.query('BEGIN');await requireCurrentInstallationAuthority(client,grant)
   await writer.query('BEGIN');await expect(writer.query('SELECT 1 FROM public.extension_installations WHERE installation_id=$1 FOR UPDATE NOWAIT',[personal])).rejects.toMatchObject({code:'55P03'})
  }finally{await writer.query('ROLLBACK');writer.release();await client.query('ROLLBACK');client.release()}
 })
 test('shared mutation permission uses the same current native facts on its physical client',async()=>{
  await f.pool.query("UPDATE public.extension_scope_memberships SET membership_revision=2,roles=ARRAY['publisher'] WHERE membership_id=$1",[member])
  const grant=await v2(token('v2',organization,'1','2',['read','publish'])),client=await f.runtime.connect(),writer=await f.pool.connect()
  try{
   await client.query('BEGIN');expect(await requireCurrentScopePermission({client,grant,targetInstallationId:organization,permission:'publish'})).toMatchObject({membership_revision:'2'})
   await writer.query('BEGIN');await expect(writer.query('SELECT 1 FROM public.extension_scope_memberships WHERE membership_id=$1 FOR UPDATE NOWAIT',[member])).rejects.toMatchObject({code:'55P03'})
  }finally{await writer.query('ROLLBACK');writer.release();await client.query('ROLLBACK');client.release()}
 })
 test('local privacy tombstones still deny current native authority',async()=>{
  await f.runtime.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('organization',$1,1,'synthetic-privacy')",[scope])
  try{await expect(v2(token('v2',organization))).rejects.toMatchObject({code:'unauthorized'})}finally{await f.runtime.query("DELETE FROM memory_scope_tombstones WHERE owner_scope_kind='organization' AND owner_scope_id=$1",[scope])}
 })
 test('privacy tombstone follows signed native owner identity even when the local scope identity is stale',async()=>{
  await f.runtime.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('organization',$1,1,'synthetic-privacy')",[scope])
  await f.runtime.query('UPDATE memory_owner_scopes SET owner_scope_id=$2 WHERE installation_id=$1',[organization,randomUUID()])
  try{await expect(v2(token('v2',organization))).rejects.toMatchObject({code:'unauthorized'})}finally{
   await f.runtime.query('UPDATE memory_owner_scopes SET owner_scope_id=$2 WHERE installation_id=$1',[organization,scope])
   await f.runtime.query("DELETE FROM memory_scope_tombstones WHERE owner_scope_kind='organization' AND owner_scope_id=$1",[scope])
  }
 })
 test('native reactivation is consistent across signed reads and physically locked mutations',async()=>{
  await f.runtime.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1",[member])
  const client=await f.runtime.connect()
  try{
   const grant=await v2(token('v2',organization));await client.query('BEGIN')
   expect(await requireCurrentScopePermission({client,grant,targetInstallationId:organization,permission:'read'})).toMatchObject({membership_id:member})
  }finally{await client.query('ROLLBACK');client.release();await f.runtime.query("UPDATE memory_scope_memberships SET state='active' WHERE membership_id=$1",[member])}
 })
 test('a native membership without a local mirror has no local validity override',async()=>{
  const row=(await f.runtime.query('SELECT to_jsonb(m) AS record FROM memory_scope_memberships m WHERE membership_id=$1',[member])).rows[0].record
  await f.runtime.query('DELETE FROM memory_scope_memberships WHERE membership_id=$1',[member]);const client=await f.runtime.connect()
  try{
   const grant=await v2(token('v2',organization));await client.query('BEGIN')
   expect(await requireCurrentScopePermission({client,grant,targetInstallationId:organization,permission:'read'})).toMatchObject({membership_id:member})
  }finally{await client.query('ROLLBACK');client.release();await f.runtime.query('INSERT INTO memory_scope_memberships SELECT * FROM jsonb_populate_record(NULL::memory_scope_memberships,$1::jsonb)',[JSON.stringify(row)])}
 })
 test('Git route stamps retain the current native config and role revisions of a signed grant',async()=>{
  await f.pool.query('UPDATE public.extension_installations SET config_version=2 WHERE installation_id=$1',[organization])
  await f.pool.query("UPDATE public.extension_scope_memberships SET membership_revision=2,roles=ARRAY['publisher'] WHERE membership_id=$1",[member])
  const grant=await v2(token('v2',organization,'2','2',['read','publish'])),client=await f.runtime.connect()
  try{await client.query('BEGIN');expect(await requireGitPermission(client,grant,organization,'publish')).toMatchObject({configVersion:'2',membershipRevision:'2'})}finally{await client.query('ROLLBACK');client.release()}
 })
 test('native revocation defeats a still-active local membership',async()=>{
  await f.pool.query("UPDATE public.extension_scope_memberships SET membership_revision=2,state='revoked' WHERE membership_id=$1",[member])
  await expect(v2(token('v2',organization))).rejects.toMatchObject({code:'unauthorized'})
 })
 test('local integrity and purge state remain independent deny gates',async()=>{
  for(const state of ['integrity_error','purging','purged']){
   await f.runtime.query('UPDATE memory_installations SET local_status=$2 WHERE installation_id=$1',[personal,state])
   await expect(v2()).rejects.toMatchObject({code:'unauthorized'})
  }
 })
 test('local membership validity is retained independently of native roles',async()=>{
  await f.runtime.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()-interval '1 second' WHERE membership_id=$1",[member])
  await expect(v2(token('v2',organization))).rejects.toMatchObject({code:'unauthorized'})
 })
 test('disabled native provider rejects both grant versions despite ready local state',async()=>{
  await f.pool.query("UPDATE public.extension_providers SET status='disabled' WHERE provider_id='pocketctl-memory'")
  await expect(v1()).rejects.toMatchObject({code:'unauthorized'});await expect(v2()).rejects.toMatchObject({code:'unauthorized'})
 })
})
