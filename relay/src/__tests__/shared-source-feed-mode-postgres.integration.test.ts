import pg from 'pg'
import Fastify,{type FastifyInstance} from 'fastify'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {registerFeedRoutes} from '../extensions/feed-routes.js'
import {signProviderExtensionToken} from '../extensions/provider-auth.js'
import {encodeFeedCursor,filterHashForInstallation,leaseBindingHash} from '../extensions/cursor.js'
const url=process.env.RELAY_FEED_MODE_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('native Memory Feed mode and original cursor generation',()=>{
 let pool:pg.Pool,app:FastifyInstance
 const inst='10000000-0000-0000-0000-000000000095',external='20000000-0000-0000-0000-000000000095'
 const secret='synthetic-feed-mode-secret-0123456789',issuer='https://relay.example.test',lease='synthetic-feed-lease'
 beforeAll(async()=>{
  if(!url||!/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url,max:4})
  await pool.query(`DROP SCHEMA IF EXISTS memory CASCADE;DROP SCHEMA IF EXISTS shared CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public;
   CREATE TABLE public.extension_providers(provider_id text PRIMARY KEY,status text);
   CREATE TABLE public.extension_installations(installation_id uuid PRIMARY KEY,provider_id text,owner_user_id int,owner_scope_kind text,status text,
    granted_scopes text[],subscriptions text[],event_filter jsonb,start_feed_id bigint,config_version bigint,updated_at timestamptz,owner_scope_id uuid,start_policy text NOT NULL DEFAULT 'retained_history',enabled_services text[] NOT NULL DEFAULT ARRAY['memory.manage']);
   CREATE TABLE public.extension_checkpoints(installation_id uuid PRIMARY KEY,ack_feed_id bigint NOT NULL DEFAULT 0,lease_epoch bigint NOT NULL DEFAULT 0,
    lease_token_hash bytea,lease_expires_at timestamptz,snapshot_required_at timestamptz,updated_at timestamptz DEFAULT now());`)
  const {beginFreshInputFixture,installRetainedInputStartFixture}=await import(new URL('../../../memory/src/__tests__/shared-source-r1/input-start-fixture.ts',import.meta.url).href)
  const inputFoundation=await beginFreshInputFixture(pool)
  const {applyMemorySchema}=await import(new URL('../../../memory/src/schema.ts',import.meta.url).href),{applySharedSourceContract}=await import(new URL('../../../memory/src/migrations/shared-db/contract.ts',import.meta.url).href)
  await applyMemorySchema(pool,{namespace:'memory'});await applySharedSourceContract(pool);await installRetainedInputStartFixture(pool,'retained_history',inputFoundation)
  await pool.query('INSERT INTO public.users(id) VALUES(1)')
  await pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  await pool.query("INSERT INTO public.extension_providers VALUES('pocketctl-memory','enabled'),('external','enabled')")
  for(const [id,provider]of [[inst,'pocketctl-memory'],[external,'external']])await pool.query("INSERT INTO public.extension_installations VALUES($1,$2,1,'personal','active',ARRAY['session:events:read'],ARRAY['session.event.v1'],'{}',0,1,now(),$1,'retained_history',ARRAY['memory.manage'])",[id,provider])
  app=Fastify();registerFeedRoutes(app,{pool,mode:'enabled',providerJwtSecret:secret,issuer,cursorSecret:secret,leaseTtlSeconds:60})
 },30000)
 beforeEach(async()=>{
  await pool.query('TRUNCATE shared.memory_source_modes,public.extension_checkpoints')
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id) VALUES($1),($2)",[inst,external])
  for(const id of [inst,external])await pool.query("INSERT INTO public.extension_checkpoints(installation_id,lease_epoch,lease_token_hash,lease_expires_at) VALUES($1,1,$2,clock_timestamp()+interval '5 minutes')",[id,leaseBindingHash({installationId:id,leaseEpoch:1,leaseToken:lease,cursorFeedId:100})])
 })
 afterAll(async()=>{await app?.close();await pool?.end()})
 const ack=async(generation?:string,id=inst,provider='pocketctl-memory')=>{
  const cursor=encodeFeedCursor({v:1,installation_id:id,feed_id:'100',lease_epoch:'1',config_version:'1',filter_hash:filterHashForInstallation({}),exp:Math.floor(Date.now()/1000)+300,...(generation?{source_mode_generation:generation}:{})},secret)
  return app.inject({method:'POST',url:'/api/extensions/v1/feed/ack',headers:{authorization:'Bearer '+signProviderExtensionToken({providerId:provider,credentialId:'synthetic',secret,issuer})},payload:{installation_id:id,cursor,lease_token:lease}})
 }
 const position=async()=>(await pool.query('SELECT ack_feed_id::text FROM public.extension_checkpoints WHERE installation_id=$1',[inst])).rows[0].ack_feed_id
 const transition=async(mode:string)=>{
  const generation=(await pool.query('SELECT generation::text FROM shared.memory_source_modes WHERE installation_id=$1',[inst])).rows[0]?.generation??'1'
  await pool.query('SELECT shared.transition_memory_source_mode($1,$2::bigint,$3)',[inst,generation,mode])
 }
 test('legacy accepts an issued generation and old cursors only in the original generation',async()=>{
  expect((await ack()).statusCode).toBe(200)
  expect(await position()).toBe('100')
 })
 test.each(['shared-active','paused'])('%s rejects an old in-flight ACK at the native database boundary',async mode=>{
  await transition(mode)
  expect((await ack('1')).statusCode).toBe(409)
  expect(await position()).toBe('0')
 })
 test('pause/resume cannot revive an old cursor even when the visible mode is legacy again',async()=>{
  await transition('paused');await transition('legacy-feed')
  expect((await ack('1')).statusCode).toBe(410)
  expect((await ack()).statusCode).toBe(410)
  expect(await position()).toBe('0')
  await expect(pool.query('DELETE FROM shared.memory_source_modes WHERE installation_id=$1',[inst])).rejects.toThrow('source_mode_record_is_durable')
  expect((await ack('1')).statusCode).toBe(410)
  expect((await ack('3')).statusCode).toBe(200)
 })
 test('other Providers keep their original cursor and ACK contract',async()=>{
  await pool.query("UPDATE shared.memory_source_modes SET mode='shared-active' WHERE installation_id=$1",[external])
  expect((await ack(undefined,external,'external')).statusCode).toBe(200)
 })
 test('native admission compares large generations exactly',async()=>{
  await pool.query('UPDATE shared.memory_source_modes SET generation=9007199254740993 WHERE installation_id=$1',[inst])
  expect((await ack('9007199254740992')).statusCode).toBe(410)
  expect(await position()).toBe('0')
  expect((await ack('9007199254740993')).statusCode).toBe(200)
 })
 test('a live admission serializes a mode switch, including an absent mode row',async()=>{
  const reader=await pool.connect(),writer=await pool.connect()
  try{
   for(const missing of [false,true]){
    const id=missing?'30000000-0000-0000-0000-000000000095':inst
    if(missing)await pool.query("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'personal','active',ARRAY['session:events:read'],ARRAY['session.event.v1'],'{}',0,1,now(),$1,'retained_history',ARRAY['memory.manage'])",[id])
    await reader.query('BEGIN')
    expect((await reader.query('SELECT shared.lock_memory_feed_source_mode($1) AS policy',[id])).rows[0].policy).toMatchObject({mode:'legacy-feed',generation:'1',allowed:true})
    await writer.query('BEGIN');await writer.query("SET LOCAL statement_timeout='200ms'")
    await expect(writer.query("SELECT shared.transition_memory_source_mode($1,1,'shared-active')",[id])).rejects.toMatchObject({code:'55P03'})
    await writer.query('ROLLBACK');await reader.query('ROLLBACK')
   }
  }finally{await reader.query('ROLLBACK');await writer.query('ROLLBACK');reader.release();writer.release()}
 })
})
