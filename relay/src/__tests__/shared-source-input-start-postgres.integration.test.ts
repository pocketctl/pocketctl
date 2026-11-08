import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {initDB} from '../db.js'
import {ExtensionInstallationRepository} from '../extensions/installation-repository.js'
import {installNativeInputStart,assertNativeInputStartSchema} from '../shared-source/input-start.js'
import {applyRelaySourceCapture} from '../shared-source/capture.js'
import {applyRelayTeamSourceCapture} from '../shared-source/team-capture.js'
import {acceptedDeliveryTransactionFixture} from './fixtures/accepted-delivery-transaction.js'
import {projectAcceptedDeliveryMemory} from '../team/delivery-memory-projector.js'
import {TeamDispatchRepository} from '../team/dispatch-repository.js'
const url=process.env.INPUT_START_RELAY_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('native durable publication and original installation boundaries',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{
  const u=new URL(url!);if(u.search||u.hash||u.pathname!=='/shared_input_start_relay_test'||u.username!=='shared_input_start_relay_test'||!['127.0.0.1','localhost','host.docker.internal'].includes(u.hostname))throw Error('dedicated_input_start_relay_fixture_required')
  pool=new pg.Pool({connectionString:url,max:6,statement_timeout:10000,lock_timeout:1000})
  expect((await pool.query('SELECT current_database() AS database_name,current_user AS role_name,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0]).toEqual({database_name:'shared_input_start_relay_test',role_name:'shared_input_start_relay_test',superuser:false})
  await pool.query('DROP SCHEMA IF EXISTS memory CASCADE;DROP SCHEMA IF EXISTS shared CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public')
  await initDB(pool)
  const {applyMemorySchema}=await import(new URL('../../../memory/src/schema.ts',import.meta.url).href),{applySharedSourceContract}=await import(new URL('../../../memory/src/migrations/shared-db/contract.ts',import.meta.url).href)
  await applyMemorySchema(pool,{namespace:'memory'});await applySharedSourceContract(pool);await applyRelaySourceCapture(pool);await applyRelayTeamSourceCapture(pool)
 },60000)
 afterAll(async()=>{await pool?.end()})
 const repository=()=>new ExtensionInstallationRepository(pool)
 async function source(){const k=randomUUID().slice(0,8),owner=(await pool.query("INSERT INTO public.users(email,password_hash) VALUES($1,'x') RETURNING id",[k+'@input.test'])).rows[0].id as number;await pool.query("INSERT INTO public.daemons(daemon_id,user_id) VALUES($1,$2)",['d-'+k,owner]);await pool.query("INSERT INTO public.sessions(session_id,daemon_id,user_id,agent_type,source,status) VALUES($1,$2,$3,'codex','terminal','running')",['s-'+k,'d-'+k,owner]);return {owner,session:'s-'+k}}
 const install=async(s:{owner:number})=>repository().createInstallation({ownerUserId:s.owner,providerId:'pocketctl-memory',grantedScopes:['session:events:read'],subscriptions:['session.event.v1'],enabledServices:['memory.manage'],eventFilter:{},startPolicy:'from_now'})
 const event=async(s:{owner:number;session:string},status='completed',db:Pick<pg.Pool,'query'>=pool)=>(await db.query("INSERT INTO public.events(session_id,event_type,payload,event_hash,effect_status,user_id) VALUES($1,'agent_text','{\"text\":\"synthetic\"}',$2,$3,$4) RETURNING id::text",[s.session,randomUUID().replaceAll('-',''),status,s.owner])).rows[0].id as string
 const fact=async(id:string)=>(await pool.query("SELECT * FROM public.native_source_publications WHERE source_kind='relay_event' AND source_key=$1",[id])).rows[0]
 const admission=async(inst:string,s:{owner:number;session:string},id:string)=>(await pool.query("SELECT shared.memory_input_start_admission($1,'relay_event',$2,$3,$4) state",[inst,id,String(s.owner),s.session])).rows[0].state
 test('real accepted-delivery service publishes original receipts atomically, exported projector later adds a genuinely new raw reader',async()=>{
  const f=await acceptedDeliveryTransactionFixture(pool)
  // Select an actual personal binding for current raw source authority.
  await pool.query("UPDATE public.team_memory_bindings SET installation_id=$2,owner_scope_kind='personal',owner_scope_id=$2 WHERE binding_id=$1",[f.bindingId,f.personal[0]])
  for(const id of f.personal)await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[id])
  const decision=await f.delivery.decide(f.taskId,f.users[1],f.decision)
  const originals=(await pool.query('SELECT r.*,p.publication_xid,p.publication_order FROM public.team_delivery_memory_sources r JOIN public.native_source_publications p ON p.source_kind=\'team_delivery\' AND p.source_key=r.source_session_id WHERE decision_id=$1 ORDER BY reader_user_id',[decision.decision_id])).rows
  expect(originals).toHaveLength(2);expect(originals[0].publication_xid).toBe(originals[1].publication_xid)
  const scope=(user:number,inst:string)=>({installationId:inst,principalUserId:String(user),ownerScopeKind:'personal',ownerScopeId:inst,authorizationRevision:'1',configVersion:'1',modeGeneration:'2',bindingRevision:'1',participantRevision:'1'})
  expect((await pool.query("SELECT shared.read_memory_team_source($1,'team_delivery',$2) AS result_payload",[scope(f.users[0],f.personal[0]),originals[0].source_session_id])).rows[0].result_payload.submission.id).toBe(f.submissionId)
  const later=await install({owner:f.users[2]});await pool.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=$1",[later.installation_id]);await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[later.installation_id])
  const tx=await pool.connect();try{await tx.query('BEGIN');await projectAcceptedDeliveryMemory(tx,decision.decision_id,f.teamId);await tx.query('COMMIT')}finally{await tx.query('ROLLBACK');tx.release()}
  const added=(await pool.query('SELECT source_session_id FROM public.team_delivery_memory_sources WHERE decision_id=$1 AND reader_user_id=$2',[decision.decision_id,f.users[2]])).rows[0]
  expect(added).toBeTruthy();expect((await pool.query("SELECT shared.read_memory_team_source($1,'team_delivery',$2) AS result_payload",[scope(f.users[2],later.installation_id),added.source_session_id])).rows[0].result_payload.submission.id).toBe(f.submissionId)
  expect((await pool.query('SELECT r.*,p.publication_xid,p.publication_order FROM public.team_delivery_memory_sources r JOIN public.native_source_publications p ON p.source_kind=\'team_delivery\' AND p.source_key=r.source_session_id WHERE decision_id=$1 AND reader_user_id=$2',[decision.decision_id,f.users[0]])).rows[0]).toEqual(originals[0])
  const call=(await pool.query('SELECT c.native_session_id,o.daemon_id,o.owner_user_id FROM public.collaboration_calls c JOIN public.team_agent_offers o USING(offer_id) WHERE call_id=$1',[f.call])).rows[0]
  const count=(await pool.query('SELECT count(*)::int n FROM public.collaboration_events WHERE call_id=$1',[f.call])).rows[0].n
  const dispatch=new TeamDispatchRepository(pool)
  expect(await dispatch.projectDaemonEvent(call.daemon_id,call.owner_user_id,{session_id:call.native_session_id,type:'agent_text',text:'late terminal replay',seq:991})).toBeNull()
  expect(await dispatch.projectDaemonEvent(call.daemon_id,call.owner_user_id,{session_id:call.native_session_id,type:'turn_status',turn_status:'completed',seq:992})).toBeNull()
  expect((await pool.query('SELECT count(*)::int n FROM public.collaboration_events WHERE call_id=$1',[f.call])).rows[0].n).toBe(count)
  const freshGoal=await f.send('fresh native collaboration'),freshCall='input-call-'+randomUUID(),freshSession='input-native-'+randomUUID(),offer=(await pool.query('SELECT offer_id FROM public.collaboration_calls WHERE call_id=$1',[f.call])).rows[0].offer_id
  await pool.query("INSERT INTO public.collaboration_calls(call_id,team_session_id,event_id,offer_id,native_session_id,state,dispatched_at) VALUES($1,$2,$3,$4,$5,'accepted',NOW())",[freshCall,f.session.id,freshGoal.event.id,offer,freshSession])
  expect(await dispatch.projectDaemonEvent(call.daemon_id,call.owner_user_id,{session_id:freshSession,type:'agent_text',text:'real new raw answer',seq:993})).toBeTruthy()
  expect((await pool.query("SELECT * FROM public.native_source_publications WHERE source_kind='team_collaboration' AND source_key=$1",[freshCall])).rows).toHaveLength(0)
  expect(await dispatch.projectDaemonEvent(call.daemon_id,call.owner_user_id,{session_id:freshSession,type:'turn_status',turn_status:'completed',seq:994})).toBeTruthy()
  const originalCall=(await pool.query("SELECT * FROM public.native_source_publications WHERE source_kind='team_collaboration' AND source_key=$1",[freshCall])).rows[0]
  expect(originalCall.publication_xid).toBeTruthy()
  expect((await pool.query("SELECT shared.read_memory_team_source($1,'team_collaboration',$2) AS result_payload",[scope(f.users[2],later.installation_id),freshCall])).rows[0].result_payload.replies).toHaveLength(1)
  expect(await dispatch.projectDaemonEvent(call.daemon_id,call.owner_user_id,{session_id:freshSession,type:'agent_text',text:'late new raw must be rejected',seq:995})).toBeNull()
  expect((await pool.query("SELECT * FROM public.native_source_publications WHERE source_kind='team_collaboration' AND source_key=$1",[freshCall])).rows[0]).toEqual(originalCall)
  await pool.query("UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",[f.personal[1]])
  const after=await install({owner:f.users[1]});await pool.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=$1",[after.installation_id]);await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[after.installation_id])
  await expect(pool.query("SELECT shared.read_memory_team_source($1,'team_collaboration',$2)",[scope(f.users[1],after.installation_id),freshCall])).rejects.toThrow('source_input_start_denied')
  await expect(pool.query("SELECT shared.read_memory_team_source($1,'team_delivery',$2)",[scope(f.users[1],after.installation_id),originals[1].source_session_id])).rejects.toThrow('source_input_start_denied')
  await pool.query('DELETE FROM public.collaboration_calls WHERE call_id=$1',[freshCall])
  expect((await pool.query("SELECT * FROM public.native_source_publications WHERE source_kind='team_collaboration' AND source_key=$1",[freshCall])).rows[0])
   .toMatchObject({retired:true,owner_key:null,source_session_id:null,publication_xid:null,publication_order:null})
 })
 test.each(['reply','status'])('already-terminal call missing %s cannot publish through late direct SQL events',async(missing)=>{
  const {humanTeamFixture}=await import('./fixtures/team-v2.js'),f=await humanTeamFixture(pool),goal=await f.send('terminal incomplete '+missing)
  const target=await install({owner:f.users[0]});await pool.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=$1",[target.installation_id])
  const daemon='late-'+randomUUID(),offer='late-'+randomUUID(),call='late-'+randomUUID()
  await pool.query("INSERT INTO public.daemons(daemon_id,user_id) VALUES($1,$2)",[daemon,f.users[0]])
  await pool.query("INSERT INTO public.team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider) VALUES($1,$2,$3,$4,'codex')",[offer,f.teamId,f.users[0],daemon])
  await pool.query("INSERT INTO public.team_memory_bindings(binding_id,team_id,owner_scope_kind,owner_scope_id,installation_id,revision,created_by_user_id) VALUES($1,$2,'personal',$3,$3,1,$4)",['late-'+randomUUID(),f.teamId,target.installation_id,f.users[0]])
  // Historical terminal row with genuinely absent capture, not an UNKNOWN
  // marker planted by the new terminal trigger before the installation.
  await pool.query('ALTER TABLE public.collaboration_calls DISABLE TRIGGER native_input_team_before;ALTER TABLE public.collaboration_calls DISABLE TRIGGER native_input_team_after')
  try{await pool.query("INSERT INTO public.collaboration_calls(call_id,team_session_id,event_id,offer_id,state,finished_at) VALUES($1,$2,$3,$4,'completed',NOW())",[call,f.session.id,goal.event.id,offer])}
  finally{await pool.query('ALTER TABLE public.collaboration_calls ENABLE TRIGGER native_input_team_before;ALTER TABLE public.collaboration_calls ENABLE TRIGGER native_input_team_after')}
  const add=async(kind:string,seq:number)=>pool.query("INSERT INTO public.collaboration_events(event_id,team_session_id,event_seq,kind,author_offer_id,call_id,content) VALUES($1,$2,$3,$4,$5,$6,$7)",['late-'+randomUUID(),f.session.id,seq,kind,offer,call,kind==='status'?'completed':'late reply'])
  await add(missing==='reply'?'status':'agent_message',missing==='reply'?100:99)
  expect((await pool.query("SELECT * FROM public.native_source_publications WHERE source_kind='team_collaboration' AND source_key=$1",[call])).rows).toHaveLength(0)
  const reader=await install({owner:f.users[1]});await pool.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=$1",[reader.installation_id]);await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[reader.installation_id])
  await add(missing==='reply'?'agent_message':'status',missing==='reply'?99:100)
  if(missing==='reply')await add('status',101)
  const scope={installationId:reader.installation_id,principalUserId:String(f.users[1]),ownerScopeKind:'personal',ownerScopeId:reader.installation_id,authorizationRevision:'1',configVersion:'1',modeGeneration:'2',bindingRevision:'1',participantRevision:'1'}
  expect((await pool.query("SELECT state FROM shared.memory_team_source_authority($1,'team_collaboration',$2)",[scope,call])).rows[0].state).toBe('current')
  const proof=(await pool.query("SELECT publication_xid,publication_order FROM public.native_source_publications WHERE source_kind='team_collaboration' AND source_key=$1",[call])).rows[0]
  expect(proof).toMatchObject({publication_xid:null,publication_order:null})
  let denial='';try{await pool.query("SELECT shared.read_memory_team_source($1,'team_collaboration',$2)",[scope,call])}catch(e){denial=(e as Error).message}
  expect({freshProof:Boolean(proof?.publication_xid||proof?.publication_order),denial}).toEqual({freshProof:false,denial:'source_input_start_unproven'})
 })
 test('deleting a complete historical factless call leaves an irreversible scrubbed tombstone across native ID reuse',async()=>{
  const {humanTeamFixture}=await import('./fixtures/team-v2.js'),f=await humanTeamFixture(pool),goal=await f.send('historical complete raw')
  const target=await install({owner:f.users[0]});await pool.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=$1",[target.installation_id])
  const daemon='reuse-'+randomUUID(),offer='reuse-'+randomUUID(),call='reuse-'+randomUUID(),nativeSession='reuse-native-'+randomUUID()
  await pool.query("INSERT INTO public.daemons(daemon_id,user_id) VALUES($1,$2)",[daemon,f.users[0]])
  await pool.query("INSERT INTO public.team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider) VALUES($1,$2,$3,$4,'codex')",[offer,f.teamId,f.users[0],daemon])
  await pool.query("INSERT INTO public.team_memory_bindings(binding_id,team_id,owner_scope_kind,owner_scope_id,installation_id,revision,created_by_user_id) VALUES($1,$2,'personal',$3,$3,1,$4)",['reuse-'+randomUUID(),f.teamId,target.installation_id,f.users[0]])
  await pool.query('ALTER TABLE public.collaboration_calls DISABLE TRIGGER native_input_team_before;ALTER TABLE public.collaboration_calls DISABLE TRIGGER native_input_team_after;ALTER TABLE public.collaboration_events DISABLE TRIGGER native_input_team_before;ALTER TABLE public.collaboration_events DISABLE TRIGGER native_input_team_after')
  try{
   await pool.query("INSERT INTO public.collaboration_calls(call_id,team_session_id,event_id,offer_id,state,finished_at) VALUES($1,$2,$3,$4,'completed',NOW())",[call,f.session.id,goal.event.id,offer])
   for(const [kind,seq,content] of [['agent_message',99,'original historical reply'],['status',100,'completed']])await pool.query("INSERT INTO public.collaboration_events(event_id,team_session_id,event_seq,kind,author_offer_id,call_id,content) VALUES($1,$2,$3,$4,$5,$6,$7)",['reuse-'+randomUUID(),f.session.id,seq,kind,offer,call,content])
   await pool.query('UPDATE public.collaboration_sessions SET latest_event_seq=100 WHERE team_session_id=$1',[f.session.id])
  }finally{await pool.query('ALTER TABLE public.collaboration_calls ENABLE TRIGGER native_input_team_before;ALTER TABLE public.collaboration_calls ENABLE TRIGGER native_input_team_after;ALTER TABLE public.collaboration_events ENABLE TRIGGER native_input_team_before;ALTER TABLE public.collaboration_events ENABLE TRIGGER native_input_team_after')}
  const proof=async()=>(await pool.query("SELECT * FROM public.native_source_publications WHERE source_kind='team_collaboration' AND source_key=$1",[call])).rows[0]
  expect(await proof()).toBeUndefined()
  expect((await pool.query("SELECT * FROM public.native_team_publication_identity('team_collaboration',$1)",[call])).rows).toHaveLength(1)
  await pool.query('DELETE FROM public.collaboration_calls WHERE call_id=$1',[call])
  const deleted=await proof()
  expect((await pool.query('SELECT count(*)::int n FROM public.collaboration_events WHERE call_id=$1',[call])).rows[0].n).toBe(2)
  const reader=await install({owner:f.users[1]});await pool.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=$1",[reader.installation_id]);await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[reader.installation_id])
  const newGoal=await f.send('new raw flow with retired call key')
  await pool.query("INSERT INTO public.collaboration_calls(call_id,team_session_id,event_id,offer_id,native_session_id,state,dispatched_at) VALUES($1,$2,$3,$4,$5,'accepted',NOW())",[call,f.session.id,newGoal.event.id,offer,nativeSession])
  const dispatch=new TeamDispatchRepository(pool)
  expect(await dispatch.projectDaemonEvent(daemon,f.users[0],{session_id:nativeSession,type:'agent_text',text:'valid new native reply',seq:1000})).toBeTruthy()
  expect(await dispatch.projectDaemonEvent(daemon,f.users[0],{session_id:nativeSession,type:'turn_status',turn_status:'completed',seq:1001})).toBeTruthy()
  const scope={installationId:reader.installation_id,principalUserId:String(f.users[1]),ownerScopeKind:'personal',ownerScopeId:reader.installation_id,authorizationRevision:'1',configVersion:'1',modeGeneration:'2',bindingRevision:'1',participantRevision:'1'}
  expect((await pool.query("SELECT state FROM shared.memory_team_source_authority($1,'team_collaboration',$2)",[scope,call])).rows[0].state).toBe('current')
  const reused=await proof();let denial='';try{await pool.query("SELECT shared.read_memory_team_source($1,'team_collaboration',$2)",[scope,call])}catch(e){denial=(e as Error).message}
  expect({deleted:deleted&&{retired:deleted.retired,owner:deleted.owner_key,session:deleted.source_session_id,xid:deleted.publication_xid,ordinal:deleted.publication_order},freshProof:Boolean(reused?.publication_xid||reused?.publication_order),denial})
   .toEqual({deleted:{retired:true,owner:null,session:null,xid:null,ordinal:null},freshProof:false,denial:'source_input_start_denied'})
  expect(reused).toEqual(deleted)
  // Repeated DELETE preserves the same scrubbed immutable stub.
  await pool.query('DELETE FROM public.collaboration_calls WHERE call_id=$1',[call]);expect(await proof()).toEqual(deleted)
 })
 test('other Providers preserve RR/serializable creation and native recovery; provider rekey cannot borrow Memory start',async()=>{
  const provider='input-start-external';await pool.query("INSERT INTO public.extension_providers(provider_id,manifest_version,manifest,status) VALUES($1,1,'{}','enabled')",[provider])
  const {resetCheckpointForReplay}=await import('../extensions/feed-repository.js')
  for(const isolation of ['REPEATABLE READ','SERIALIZABLE']){
   const s=await source();await pool.query("INSERT INTO public.extension_feed(owner_user_id,topic,source_kind,source_id,session_id,payload) VALUES($1,'session.event.v1','canonical_event',$2,$3,'{}')",[s.owner,'event:external-'+randomUUID(),s.session])
   const c=await pool.connect();let id='';try{await c.query('BEGIN ISOLATION LEVEL '+isolation);await c.query('SELECT txid_current_snapshot()')
    const repo=new ExtensionInstallationRepository({query:c.query.bind(c),connect:pool.connect.bind(pool)} as Pick<pg.Pool,'query'|'connect'>)
    const i=await repo.createInstallation({ownerUserId:s.owner,providerId:provider,grantedScopes:['session:events:read'],subscriptions:['session.event.v1'],enabledServices:['memory.manage'],eventFilter:{},startPolicy:'from_now'});id=i.installation_id
    await c.query('INSERT INTO public.extension_checkpoints(installation_id,ack_feed_id) VALUES($1,$2)',[id,i.start_feed_id])
    await c.query("UPDATE public.extension_installations SET start_policy='retained_history' WHERE installation_id=$1",[id])
    await resetCheckpointForReplay(c,{installationId:id,ackFeedId:0,startFeedId:0})
    expect((await c.query('SELECT start_feed_id::text,start_policy FROM public.extension_installations WHERE installation_id=$1',[id])).rows[0]).toEqual({start_feed_id:'0',start_policy:'retained_history'})
    expect((await c.query('SELECT count(*)::int n FROM public.native_installation_starts WHERE installation_id=$1',[id])).rows[0].n).toBe(0)
    await c.query('COMMIT')
   }finally{await c.query('ROLLBACK');c.release()}
   await expect(pool.query("UPDATE public.extension_installations SET provider_id='pocketctl-memory' WHERE installation_id=$1",[id])).rejects.toThrow('native_input_start_provider_rekey_unsupported')
   expect((await pool.query('SELECT provider_id FROM public.extension_installations WHERE installation_id=$1',[id])).rows[0].provider_id).toBe(provider)
  }
  const s=await source(),i=await install(s);await pool.query("UPDATE public.extension_installations SET provider_id=$2,start_policy='retained_history' WHERE installation_id=$1",[i.installation_id,provider])
  expect((await pool.query('SELECT retired,provider_id,owner_user_id FROM public.native_installation_starts WHERE installation_id=$1',[i.installation_id])).rows[0]).toEqual({retired:true,provider_id:null,owner_user_id:null})
  await expect(pool.query("UPDATE public.extension_installations SET provider_id='pocketctl-memory' WHERE installation_id=$1",[i.installation_id])).rejects.toThrow('native_input_start_provider_rekey_unsupported')
 })
 test('native schema is installed independently of shared runtime flags and validates exact capture hooks',async()=>{await assertNativeInputStartSchema(pool);expect((await pool.query('SELECT count(*)::int n FROM public.native_input_start_contract')).rows[0].n).toBe(1)})
 test('captured original policy/provider/owner/scope and Feed checkpoint are server-derived',async()=>{
  const s=await source(),i=await install(s),b=(await pool.query('SELECT * FROM public.native_installation_starts WHERE installation_id=$1',[i.installation_id])).rows[0]
  expect(b).toMatchObject({provider_id:'pocketctl-memory',owner_user_id:s.owner,owner_scope_kind:'personal',owner_scope_id:i.installation_id,original_policy:'from_now',retired:false});expect(typeof b.start_snapshot).toBe('string')
 })
 test('pending/abandoned inserts are not publication; completion freezes original proof across body/route storage updates',async()=>{
  const s=await source(),id=await event(s,'pending'),i=await install(s);expect(await fact(id)).toBeUndefined();await pool.query("UPDATE public.events SET effect_status='completed' WHERE id=$1",[id]);const original=await fact(id);expect(await admission(i.installation_id,s,id)).toBe('eligible');await pool.query('UPDATE public.events SET payload=payload,effect_step=effect_step+1 WHERE id=$1',[id]);expect(await fact(id)).toEqual(original);expect(await fact(await event(s,'abandoned'))).toBeUndefined()
 })
 test('cross-transaction snapshot visibility rejects committed old and admits a smaller allocated-XID late commit',async()=>{
  const s=await source(),old=await event(s),tx=await pool.connect();try{await tx.query('BEGIN');const late=await event(s,'completed',tx),i=await install(s);expect(await admission(i.installation_id,s,old)).toBe('before');await tx.query('COMMIT');expect(await admission(i.installation_id,s,late)).toBe('eligible')}finally{await tx.query('ROLLBACK');tx.release()}
 })
 test('historical eligible update/ABA stays UNKNOWN instead of becoming newly published',async()=>{
  const s=await source();await pool.query('ALTER TABLE public.events DISABLE TRIGGER native_input_event');let id:string;try{id=await event(s)}finally{await pool.query('ALTER TABLE public.events ENABLE TRIGGER native_input_event')}
  const i=await install(s);await pool.query("UPDATE public.events SET effect_status='pending' WHERE id=$1",[id]);await pool.query("UPDATE public.events SET effect_status='completed' WHERE id=$1",[id]);expect(await fact(id)).toMatchObject({publication_xid:null,publication_order:null,retired:false});expect(await admission(i.installation_id,s,id)).toBe('unproven')
 })
 test('unproved legacy start cannot borrow a current mutable replay checkpoint',async()=>{
  const s=await source(),id=await event(s),i=await install(s);await pool.query('ALTER TABLE public.native_installation_starts DISABLE TRIGGER native_input_immutable');try{await pool.query('DELETE FROM public.native_installation_starts WHERE installation_id=$1',[i.installation_id])}finally{await pool.query('ALTER TABLE public.native_installation_starts ENABLE TRIGGER native_input_immutable')}
  await pool.query("INSERT INTO public.extension_feed(owner_user_id,topic,source_kind,source_id,session_id,payload) VALUES($1,'session.event.v1','canonical_event',$2,$3,'{}')",[s.owner,'event:'+id,s.session]);expect(await admission(i.installation_id,s,id)).toBe('unproven')
 })
 test('deleting canonical source scrubs its associations and reusing its ID cannot publish again',async()=>{
  const s=await source(),id=await event(s);await pool.query('DELETE FROM public.events WHERE id=$1',[id]);expect(await fact(id)).toMatchObject({retired:true,owner_key:null,source_session_id:null,publication_xid:null,publication_order:null});await pool.query("INSERT INTO public.events(id,session_id,event_type,payload,event_hash,effect_status,user_id) VALUES($1,$2,'agent_text','{}',$3,'completed',$4)",[id,s.session,randomUUID().replaceAll('-',''),s.owner]);expect((await fact(id)).retired).toBe(true)
 })
 test('deleting installation scrubs association while retaining a non-reusable UUID tombstone',async()=>{
  const s=await source(),i=await install(s);await pool.query('DELETE FROM public.extension_installations WHERE installation_id=$1',[i.installation_id]);expect((await pool.query('SELECT retired,provider_id,owner_user_id,owner_scope_kind,owner_scope_id FROM public.native_installation_starts WHERE installation_id=$1',[i.installation_id])).rows[0]).toEqual({retired:true,provider_id:null,owner_user_id:null,owner_scope_kind:null,owner_scope_id:null});await expect(pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory',$2,'pending','{}','{}','{}','from_now')",[i.installation_id,s.owner])).rejects.toMatchObject({code:'23505'})
 })
 test('native capture readiness rejects a missing/disabled publication hook',async()=>{
  await pool.query('ALTER TABLE public.events DISABLE TRIGGER native_input_event');try{await expect(assertNativeInputStartSchema(pool)).rejects.toThrow('native_input_start_history_missing')}finally{await pool.query('ALTER TABLE public.events ENABLE TRIGGER native_input_event')}
 })
 test('existing v1 missing ledger/column/sequence/guard is never silently rebuilt by migration',async()=>{
  const s=await source(),id=await event(s),original=await fact(id)
  for(const sql of ['DROP TABLE public.native_source_publications','ALTER TABLE public.native_source_publications DROP COLUMN publication_xid','DROP SEQUENCE public.native_input_start_order','ALTER TABLE public.native_source_publications DROP CONSTRAINT native_source_publications_pkey','ALTER TABLE public.native_installation_starts DISABLE TRIGGER native_input_immutable','DROP TABLE public.native_input_start_contract']){
   const c=await pool.connect();try{await c.query('BEGIN');await c.query(sql);await expect(installNativeInputStart(c as unknown as Pick<pg.Pool,'query'>)).rejects.toThrow(/^(native_input_start_history_missing|native_team_semantic_history_missing)$/)}finally{await c.query('ROLLBACK');c.release()}
   expect(await fact(id)).toEqual(original)
  }
  await installNativeInputStart(pool);expect(await fact(id)).toEqual(original)
 })
 test('shared input v1 is durable history evidence when the entire native ledger set disappears',async()=>{
  const c=await pool.connect();try{await c.query('BEGIN');await c.query(`DROP TABLE public.native_source_publications,public.native_installation_starts,public.native_input_start_contract;
   DROP SEQUENCE public.native_input_start_order;
   DROP FUNCTION public.capture_native_installation_start() CASCADE;`)
   expect((await c.query("SELECT to_regclass('public.native_input_start_contract') IS NULL AND to_regclass('public.native_source_publications') IS NULL AND to_regclass('public.native_installation_starts') IS NULL AND to_regclass('public.native_input_start_order') IS NULL AND to_regprocedure('public.capture_native_installation_start()') IS NULL AS absent")).rows[0].absent).toBe(true)
   await expect(installNativeInputStart(c as unknown as Pick<pg.Pool,'query'>)).rejects.toThrow(/^(native_input_start_history_missing|native_team_semantic_history_missing)$/)
  }finally{await c.query('ROLLBACK');c.release()}
 })
 test('future native version is rejected before native migration can alter facts',async()=>{
  await pool.query('ALTER TABLE public.native_input_start_contract DISABLE TRIGGER native_input_immutable');await pool.query('UPDATE public.native_input_start_contract SET version=2');try{await expect(installNativeInputStart(pool)).rejects.toThrow('unsupported_native_input_start_contract')}finally{await pool.query('UPDATE public.native_input_start_contract SET version=1');await pool.query('ALTER TABLE public.native_input_start_contract ENABLE TRIGGER native_input_immutable')}
 })
})
