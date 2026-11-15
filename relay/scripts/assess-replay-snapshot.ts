/** Assess a private read-only production snapshot offline. Output is a review
 * list, never an apply manifest: online journal/authority must be rechecked. */
import {readFile,writeFile} from 'node:fs/promises'
import {canonicalPayloadHash} from '@pocketctl/session-source'
import {assertReplayCompatible,replayMemoryProducer} from '../src/materialization/replay-compatibility.js'
const [input,output]=process.argv.slice(2)
if(!input||!output)throw Error('private_snapshot_and_output_required')
const snapshot=JSON.parse(await readFile(input,'utf8'))
const entries=[],counts:Record<string,number>={}
for(const item of snapshot.candidates){
 const i=item.inbox,e=item.canonical;let reason='requires_fresh_online_plan'
 try{
  if(!e||!['completed','none'].includes(e.effect_status))throw Error('completed_canonical_required')
  if(item.deleted||item.aliased||item.session_authority?.state!=='current'||item.event_authority?.state!=='current'||e.owner_retired||e.user_id!==i.user_id)throw Error('authority_requires_review')
  if(e.body_storage==='cold'||!e.payload)throw Error('cold_read_required')
  assertReplayCompatible(e.payload,i.payload,replayMemoryProducer({agent_type:item.producer,source:item.source,control_mode:item.control_mode}))
  if(i.payload.resync!==true)throw Error('replay_marker_required')
  if(e.source_header_version!=null&&(e.source_header_version!==1||canonicalPayloadHash(e.payload).toString('hex')!==e.canonical_payload_hash))throw Error('canonical_header_requires_review')
 }catch(error){reason=error instanceof Error?error.message:'assessment_failed'}
 counts[reason]=(counts[reason]??0)+1
 entries.push({inboxId:String(i.inbox_id),eventId:e?String(e.id):null,generation:String(i.daemon_generation),seq:String(i.seq),reason,inboxFingerprint:canonicalPayloadHash(i).toString('hex')})
}
const report={capturedAt:snapshot.captured_at,daemonId:snapshot.daemon_id,executable:false,counts,entries}
await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600})
console.log(JSON.stringify({capturedAt:report.capturedAt,counts,total:entries.length,executable:false}))
