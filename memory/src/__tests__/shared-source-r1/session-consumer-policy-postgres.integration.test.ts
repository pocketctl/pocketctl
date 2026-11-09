import {randomUUID} from 'node:crypto'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import Fastify from 'fastify'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
const secret='synthetic-consumer-policy-secret-0123456789',issuer='https://consumer-policy.test.invalid',cursorSecret='synthetic-consumer-policy-cursor-01234567'
suite('versioned canonical body producer and external snapshot compatibility',()=>{
 let f:DirectLaunchFixture,personal:string,source:Awaited<ReturnType<DirectLaunchFixture['source']>>,journal:any,projector:any,auth:any,app:ReturnType<typeof Fastify>
 const load=(name:string)=>import(pathToFileURL(resolve('../relay/dist/'+name+'.js')).href)
 const count=async(id:string)=>(await f.pool.query("SELECT count(*)::int AS n FROM public.extension_source_outbox WHERE source_kind='canonical_event' AND source_id=$1",['event:'+id])).rows[0].n
 async function append(text:string,consumerPolicy=true,s=source){
  const payload={text,turn_id:'consumer-policy-turn'},client=await f.publisher.connect()
  try{await client.query('BEGIN');const id=(await client.query("INSERT INTO public.events(session_id,event_type,payload,event_hash,effect_status,user_id) VALUES($1,'agent_text',$2,$3,'completed',$4) RETURNING id::text",[s.session,payload,randomUUID().replaceAll('-',''),s.owner])).rows[0].id
   const input={sourceEventId:id,ownerUserId:s.owner,sessionId:s.session,eventType:'agent_text',occurredAt:null,payload}
   await journal.createPostgresExtensionJournalSink({sharedHeaders:true,consumerPolicy}).appendCanonicalEvent(client,input);await client.query('COMMIT');return{id,input}
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
 }
 async function external(policy:'from_now'|'retained_history'){
  const provider='external-'+randomUUID();await f.publisher.query("INSERT INTO public.extension_providers(provider_id,manifest_version,manifest,status) VALUES($1,1,'{}','enabled')",[provider])
  const{ExtensionInstallationRepository}=await load('extensions/installation-repository')
  const created=await new ExtensionInstallationRepository(f.publisher).createInstallation({ownerUserId:source.owner,providerId:provider,grantedScopes:['session:events:read','session:snapshot:read'],subscriptions:['session.event.v1'],enabledServices:[],eventFilter:{},startPolicy:policy})
  const id=created.installation_id
  await f.publisher.query("UPDATE public.extension_installations SET status='active',config_version=config_version+1 WHERE installation_id=$1",[id])
  const token=auth.signProviderExtensionToken({providerId:provider,credentialId:randomUUID(),secret,issuer})
  return{id,provider,headers:{authorization:'Bearer '+token},close:()=>f.publisher.query("UPDATE public.extension_installations SET status='revoked',config_version=config_version+1 WHERE installation_id=$1",[id])}
 }
 async function replay(input:unknown){const c=await f.publisher.connect();try{await c.query('BEGIN');await journal.createPostgresExtensionJournalSink({sharedHeaders:true,consumerPolicy:true}).appendCanonicalEvent(c,input);await c.query('COMMIT')}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
 beforeAll(async()=>{
  f=await directLaunchFixture(url!);source=await f.source();personal=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("UPDATE shared.memory_source_modes SET mode='shared-active',generation=3 WHERE installation_id=$1",[personal]);await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  await f.pool.query("UPDATE public.extension_installations SET config_version=2,subscriptions='{}' WHERE installation_id=$1",[personal])
  await f.pool.query("INSERT INTO shared.memory_session_transport_retirements(installation_id,mode_generation,retired_config_version,removed_topics) VALUES($1,3,2,ARRAY['session.event.v1'])",[personal])
  journal=await load('extensions/journal');projector=await load('extensions/feed-projector');auth=await load('extensions/provider-auth')
  app=Fastify();const base={pool:f.publisher,mode:'enabled',providerJwtSecret:secret,issuer,cursorSecret}
  ;(await load('extensions/feed-routes')).registerFeedRoutes(app,{...base,leaseTtlSeconds:30})
  ;(await load('extensions/snapshot-routes')).registerSnapshotRoutes(app,base)
  ;(await load('extensions/provider-installation-routes')).registerProviderInstallationRoutes(app,base)
  await app.ready()
 },60000)
 afterAll(async()=>{await app?.close();await f?.close()})
 test('reviewed single-owner policy keeps native headers but allocates no journal body, including replay',async()=>{
  const first=await append('gated canonical body');expect(await count(first.id)).toBe(0)
  const before=(await f.pool.query('SELECT source_sequence::text,source_header_version,canonical_payload_hash,source_classification FROM public.events WHERE id=$1',[first.id])).rows[0]
  expect(before.source_header_version).toBe(1);expect(before.source_sequence).toMatch(/^[1-9][0-9]*$/)
  await replay(first.input)
  expect((await f.pool.query('SELECT source_sequence::text FROM public.events WHERE id=$1',[first.id])).rows[0].source_sequence).toBe(before.source_sequence)
  expect(await count(first.id)).toBe(0)
 })
 test('legacy producer and unreviewed owners retain their original body contract',async()=>{
  expect(await count((await append('explicit legacy producer',false)).id)).toBe(1)
  const other=await f.source();expect(await count((await append('unreviewed other owner',true,other)).id)).toBe(1)
 })
 test('new from-now external consumers receive future bodies without implicit snapshot/history',async()=>{
  const e=await external('from_now');try{
   expect((await f.pool.query('SELECT snapshot_required_at FROM public.extension_checkpoints WHERE installation_id=$1',[e.id])).rows.every(r=>r.snapshot_required_at===null)).toBe(true)
   expect(await count((await append('external future body')).id)).toBe(1)
  }finally{await e.close()}
 })
 test('new retained-history external consumer uses actual snapshot, reconciliation, Feed and ACK',async()=>{
  const missed=await append('actual snapshot recovery after body gating');expect(await count(missed.id)).toBe(0)
  const e=await external('retained_history');try{
   const blocked=await app.inject({method:'GET',url:'/api/extensions/v1/feed?installation_id='+e.id,headers:e.headers})
   expect(blocked.json()).toMatchObject({error:{code:'cursor_expired',snapshot_required:true}})
   const snapshot=await app.inject({method:'GET',url:'/api/extensions/v1/sessions/'+source.session+'/snapshot?installation_id='+e.id,headers:e.headers})
   expect(snapshot.statusCode).toBe(200);expect(snapshot.json().events.some((v:any)=>String(v.event_id)===missed.id&&v.payload.text===missed.input.payload.text)).toBe(true)
   expect((await app.inject({method:'POST',url:'/api/extensions/v1/provider/installations/'+e.id+'/reconciled',headers:e.headers})).statusCode).toBe(200)
   const current=await append('external current live body');expect(await count(current.id)).toBe(1)
   await projector.projectFeedBatch(f.publisher,{batchSize:128})
   const feed=await app.inject({method:'GET',url:'/api/extensions/v1/feed?installation_id='+e.id,headers:e.headers});expect(feed.statusCode).toBe(200)
   const batch=feed.json();expect(batch.items.some((v:any)=>v.data.text==='external current live body')).toBe(true)
   expect((await app.inject({method:'POST',url:'/api/extensions/v1/feed/ack',headers:e.headers,payload:{installation_id:e.id,cursor:batch.next_cursor,lease_token:batch.lease_token}})).statusCode).toBe(200)
  }finally{await e.close()}
 })
 test('paused external subscribers still retain future bodies for later recovery',async()=>{
  const e=await external('from_now');try{await f.publisher.query("UPDATE public.extension_installations SET status='paused',config_version=config_version+1 WHERE installation_id=$1",[e.id]);expect(await count((await append('paused external custody')).id)).toBe(1)}finally{await e.close()}
 })
 test('native policy read holds the consumer epoch through COMMIT and rejects a concurrent subscription write',async()=>{
  const reader=await f.publisher.connect(),writer=await f.pool.connect(),id=randomUUID(),provider='race-'+randomUUID()
  await f.pool.query("INSERT INTO public.extension_providers(provider_id,manifest_version,manifest,status) VALUES($1,1,'{}','enabled')",[provider])
  try{await reader.query('BEGIN');await reader.query('SELECT shared.session_transport_consumer_policy($1) AS policy',[source.owner]);await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='500ms'")
   await expect(writer.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,$2,$3,'active',ARRAY['session:events:read'],ARRAY['session.event.v1'],'{}','retained_history')",[id,provider,source.owner])).rejects.toMatchObject({code:'55P03'})
  }finally{await writer.query('ROLLBACK');writer.release();await reader.query('ROLLBACK');reader.release()}
  expect((await f.pool.query('SELECT 1 FROM public.extension_installations WHERE installation_id=$1',[id])).rowCount).toBe(0)
 })
 test('a conflicting old journal body cannot hide behind the body-free branch',async()=>{
  const original=await append('strict current canonical original'),sequence=(await f.pool.query('SELECT source_sequence::text FROM public.events WHERE id=$1',[original.id])).rows[0].source_sequence
  await f.publisher.query("INSERT INTO public.extension_source_outbox(source_kind,source_id,owner_user_id,session_id,event_type,payload,source_seq) VALUES('canonical_event',$1,$2,$3,'agent_text',$4,$5::bigint)",['event:'+original.id,source.owner,source.session,{text:'conflicting old body'},sequence])
  try{await expect(replay(original.input)).rejects.toThrow('canonical_source_header_mismatch')}
  finally{await f.publisher.query("DELETE FROM public.extension_source_outbox WHERE source_kind='canonical_event' AND source_id=$1",['event:'+original.id])}
 })
 test('a trusted pre-header legacy journal sequence is reused rather than replaced',async()=>{
  const client=await f.publisher.connect(),payload={text:'pre-header legacy row',turn_id:'legacy-turn'}
  try{await client.query('BEGIN');const id=(await client.query("INSERT INTO public.events(session_id,event_type,payload,event_hash,effect_status,user_id) VALUES($1,'agent_text',$2,$3,'completed',$4) RETURNING id::text",[source.session,payload,randomUUID().replaceAll('-',''),source.owner])).rows[0].id
   const input={sourceEventId:id,ownerUserId:source.owner,sessionId:source.session,eventType:'agent_text',occurredAt:null,payload}
   await journal.createPostgresExtensionJournalSink().appendCanonicalEvent(client,input)
   const old=(await client.query("SELECT source_seq::text FROM public.extension_source_outbox WHERE source_kind='canonical_event' AND source_id=$1",['event:'+id])).rows[0].source_seq
   await journal.createPostgresExtensionJournalSink({sharedHeaders:true,consumerPolicy:true}).appendCanonicalEvent(client,input)
   expect((await client.query('SELECT source_sequence::text FROM public.events WHERE id=$1',[id])).rows[0].source_sequence).toBe(old)
   await client.query('COMMIT');expect(await count(id)).toBe(1)
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
 })
 test('an existing subscriber resuming a body topic after a gap must reconcile again',async()=>{
  const e=await external('retained_history');try{
   expect((await app.inject({method:'POST',url:'/api/extensions/v1/provider/installations/'+e.id+'/reconciled',headers:e.headers})).statusCode).toBe(200)
   await f.publisher.query("UPDATE public.extension_installations SET subscriptions='{}',config_version=config_version+1 WHERE installation_id=$1",[e.id])
   const gap=await append('existing external subscriber gap');expect(await count(gap.id)).toBe(0)
   await f.publisher.query("UPDATE public.extension_installations SET subscriptions=ARRAY['session.event.v1'],config_version=config_version+1 WHERE installation_id=$1",[e.id])
   expect((await app.inject({method:'GET',url:'/api/extensions/v1/feed?installation_id='+e.id,headers:e.headers})).json()).toMatchObject({error:{code:'cursor_expired',snapshot_required:true}})
   const snapshot=await app.inject({method:'GET',url:'/api/extensions/v1/sessions/'+source.session+'/snapshot?installation_id='+e.id,headers:e.headers})
   expect(snapshot.statusCode).toBe(200);expect(snapshot.json().events.some((event:any)=>String(event.event_id)===gap.id)).toBe(true)
  }finally{await e.close()}
 })
 test('a lost consumer capture fence fails producer admission instead of silently omitting a body',async()=>{
  await f.pool.query('ALTER TABLE public.extension_installations DISABLE TRIGGER session_transport_consumers_update')
  try{await expect(append('must not commit without policy capture')).rejects.toThrow('session_transport_consumer_policy_missing')}
  finally{await f.pool.query('ALTER TABLE public.extension_installations ENABLE TRIGGER session_transport_consumers_update')}
  expect((await f.pool.query("SELECT 1 FROM public.events WHERE session_id=$1 AND payload->>'text'='must not commit without policy capture'",[source.session])).rowCount).toBe(0)
 })
})
