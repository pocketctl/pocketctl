/** PRIVATE fixture rehearsal. Never prints event bodies. The schema must first
 * be restored into the dedicated disposable database; no production URL is accepted. */
import {readFile,writeFile} from 'node:fs/promises'
import assert from 'node:assert/strict'
import pg from 'pg'
import {canonicalPayloadHash} from '@pocketctl/session-source'
import {EventMaterializer} from '../src/materialization/event-materializer.js'
import {createPostgresExtensionJournalSink} from '../src/extensions/journal.js'
import {InboxRepository} from '../src/ingress/inbox-repository.js'
import {RealtimeOutboxWriter} from '../src/materialization/realtime-outbox.js'
import {createInboxWorker,safeMaterializationError} from '../src/inbox-worker.js'
import {planReplayRecovery,applyReplayRecovery,REPLAY_RECOVERY_AUDIT_SQL} from '../src/ops/replay-recovery.js'

const fixture=process.argv[2], output=process.argv[3]
if(!fixture||!output)throw Error('fixture_directory_and_private_output_required')
const adminURL=process.env.REPLAY_FIXTURE_ADMIN_URL!,runtimeURL=process.env.REPLAY_FIXTURE_RUNTIME_URL!
for(const raw of [adminURL,runtimeURL]){
  const u=new URL(raw)
  if(u.hostname!=='127.0.0.1'||u.pathname!=='/pocketctl_replay_fixture_test'||u.search)throw Error('isolated_fixture_database_required')
}
const admin=new pg.Pool({connectionString:adminURL,max:1}),runtime=new pg.Pool({connectionString:runtimeURL,max:2})
try{
 const identity=(await runtime.query("SELECT current_database() AS db,current_user AS role,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS privileged")).rows[0]
 assert.equal(identity.db,'pocketctl_replay_fixture_test');assert.equal(identity.role,'pocketctl_relay_shared_app');assert.equal(identity.privileged,false)
 assert.equal((await admin.query('SELECT count(*) FROM events')).rows[0].count,'0','fixture requires an empty database')
 const minimal=JSON.parse(await readFile(fixture+'/minimal-sample.json','utf8'))
 const duplicate=JSON.parse(await readFile(fixture+'/duplicate-sample.json','utf8'))
 const row={...duplicate.inbox,status:3,attempts:12,last_error:'materialization_failed',claimed_at:null,claimed_by:null,materialized_event_id:null}
 const c=await admin.connect()
 try{
  await c.query('BEGIN');await c.query('SET LOCAL session_replication_role=replica')
  await c.query("INSERT INTO users(id,email,password_hash) VALUES($1,'private-fixture@example.invalid','not-a-login')",[row.user_id])
  const allowed=new Set(['public.daemons','public.sessions','shared.memory_source_contract','public.extension_installations','shared.memory_source_control_clock','shared.session_transport_consumer_clock','shared.memory_session_transport_retirements'])
  for(const [table,rows] of Object.entries(minimal.tables)){
   if(!allowed.has(table))throw Error('unexpected_fixture_table')
   await c.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,[JSON.stringify(rows)])
  }
  await c.query('INSERT INTO events SELECT * FROM jsonb_populate_recordset(NULL::events,$1::jsonb)',[JSON.stringify([duplicate.event])])
  if(duplicate.outbox.length)await c.query('INSERT INTO extension_source_outbox SELECT * FROM jsonb_populate_recordset(NULL::extension_source_outbox,$1::jsonb)',[JSON.stringify(duplicate.outbox)])
  await c.query('INSERT INTO event_inbox SELECT * FROM jsonb_populate_recordset(NULL::event_inbox,$1::jsonb)',[JSON.stringify([row])])
  for(const [table,column] of [['events','id'],['event_inbox','inbox_id']])await c.query(`SELECT setval(pg_get_serial_sequence($1,$2),(SELECT max(${column}) FROM ${table}),true)`,[table,column])
  await c.query('COMMIT')
 }catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
 const owner=row.user_id, daemon=row.daemon_id, generation=String(row.daemon_generation)
 const before=canonicalPayloadHash(duplicate.event.payload).toString('hex')
 const manifest=await planReplayRecovery(runtime,{daemonId:daemon,ownerId:owner,generation},[String(row.inbox_id)])
 assert.equal(manifest.entries.length,1)
 await writeFile(output+'.manifest.json',JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600})
 await admin.query(REPLAY_RECOVERY_AUDIT_SQL)
 const apply=await applyReplayRecovery(admin,manifest,manifest.digest,true)
 assert.equal(apply.applied,1)
 // One later session in the exact same generation proves the old head no longer
 // blocks unrelated bodies. No daemon process or external client is involved.
 const second='replay-rehearsal-second-session'
 await admin.query("INSERT INTO sessions(session_id,daemon_id,user_id,agent_type,status,cwd) VALUES($1,$2,$3,'codex','idle','/synthetic')",[second,daemon,owner])
 const repository=new InboxRepository(runtime)
 await repository.persistBatch([{userId:owner,daemonId:daemon,registrationId:'replay-isolated',daemonGeneration:Number(generation),seq:Number(row.seq)+1,dedupKey:'isolated-second-body',sessionId:second,eventType:'agent_text',priority:'live',payload:{type:'agent_text',session_id:second,event_id:'isolated-second-body',text:'synthetic follow-on body'},materializationContext:{},receivedAt:new Date()}])
 const materializer=new EventMaterializer({pool:runtime,extensionJournalSink:createPostgresExtensionJournalSink({sharedHeaders:true,consumerPolicy:true})})
 const worker=createInboxWorker({repository,materializer,outboxWriter:new RealtimeOutboxWriter(runtime),workerId:'isolated-replay-rehearsal',shardCount:1,shardIndex:0})
 await worker.runOnce()
 const states=(await runtime.query('SELECT status,count(*)::int AS count FROM event_inbox GROUP BY status')).rows
 assert.deepEqual(states,[{status:2,count:2}])
 const saved=(await runtime.query('SELECT payload,source_header_version,source_sequence::text,source_classification FROM events WHERE id=$1',[duplicate.event.id])).rows[0]
 assert.equal(canonicalPayloadHash(saved.payload).toString('hex'),before)
 assert.equal(saved.source_classification.memory_source,undefined)
 const outbox=(await runtime.query('SELECT event_id::text,payload FROM realtime_outbox ORDER BY outbox_id')).rows
 assert.equal(outbox.length,2);assert.equal(outbox[0].event_id,String(duplicate.event.id))
 assert.equal(outbox[0].payload.memory_source,undefined);assert.equal(outbox[0].payload.resync,true)
 assert.equal(outbox[1].payload.text,'synthetic follow-on body')
 await worker.runOnce();assert.equal((await runtime.query('SELECT count(*) FROM realtime_outbox')).rows[0].count,'2')
 const resume=await applyReplayRecovery(admin,manifest,manifest.digest,true);assert.equal(resume.alreadyApplied,1)
 const receipt={database:identity.db,runtimeRole:identity.role,privileged:false,sourceInboxId:String(row.inbox_id),sourceEventId:String(duplicate.event.id),manifestDigest:manifest.digest,apply,resume,states,outboxCount:outbox.length,canonicalBodyUnchanged:true,canonicalProvenanceUnchanged:true,sourceHeaderVersion:saved.source_header_version,sourceSequence:saved.source_sequence,secondSessionBodyVisible:true,clientUIAccepted:false}
 await writeFile(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(receipt))
}catch(error){console.error(JSON.stringify({error:safeMaterializationError(error),kind:error instanceof Error?error.name:'unknown'}));process.exitCode=1}finally{await runtime.end();await admin.end()}
