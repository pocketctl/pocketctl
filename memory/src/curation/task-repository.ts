import type pg from 'pg'
import {createHash} from 'node:crypto'
import {admitLifecycleSources,LIFECYCLE_SOURCE_POLICY} from '../episodes/source-admission.js'
import {computeSourceDigest,type PacketSourceEvent} from '../episodes/packet.js'
import type {CurationPolicy} from './policy.js'
import {canonicalPayloadHash} from '../inbox/canonical-json.js'
/** Stage an admitted, bounded source revision. No model or Claim write here.
 * Caller holds session/installation purge locks and the policy owner fence. */
export async function stageLifecycleTurn(client:Pick<pg.PoolClient,'query'>,input:{installationId:string;sessionId:string;turnId:string;events:PacketSourceEvent[]},policy:CurationPolicy){
 const admitted=admitLifecycleSources(input)
 const digest=lifecycleSourceDigest(input.installationId,input.events)
 const unknown=admitted.receipts.some(r=>!r.admission.allowed&&r.admission.reason==='provenance_unknown')
 if(!admitted.events.length){
  await client.query(`INSERT INTO memory_source_processing_receipts(installation_id,session_id,turn_id,source_digest,policy_version,disposition,allowed_count,excluded_count,complete)
   VALUES($1,$2,$3,$4,$5,$6,0,$7,$8) ON CONFLICT DO NOTHING`,[input.installationId,input.sessionId,input.turnId,digest,LIFECYCLE_SOURCE_POLICY,unknown?'provenance_unknown':'skipped_policy',input.events.length,!unknown])
  return
 }
 const changed=(await client.query(`INSERT INTO memory_task_bundles(installation_id,session_id,task_key,source_digest,watermark)
 VALUES($1,$2,$3,$4,$5) ON CONFLICT(installation_id,session_id,task_key) DO UPDATE SET
 source_digest=EXCLUDED.source_digest,watermark=EXCLUDED.watermark,revision=memory_task_bundles.revision+1,state='pending',updated_at=clock_timestamp()
 WHERE memory_task_bundles.source_digest<>EXCLUDED.source_digest AND memory_task_bundles.body_state='present'
 RETURNING bundle_id::text,revision`,[input.installationId,input.sessionId,`source:${input.turnId}`,digest,
 admitted.events.reduce((m,e)=>{const n=BigInt((e.source_provenance!.memory as any).sequence);return n>m?n:m},0n).toString()])).rows[0]
 if(!changed)return
 await client.query('DELETE FROM memory_task_bundle_sources WHERE installation_id=$1 AND bundle_id=$2',[input.installationId,changed.bundle_id])
 for(const event of admitted.events){
  await client.query(`INSERT INTO memory_task_bundle_sources(installation_id,bundle_id,source_event_id,source_digest,source_sequence) VALUES($1,$2,$3,$4,$5)`,
   [input.installationId,changed.bundle_id,event.source_event_id,event.payload_hash,(event.source_provenance!.memory as any).sequence])
 }
 await client.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload)
 VALUES(gen_random_uuid(),$1,'consolidate_task',$2,84,$3::jsonb) ON CONFLICT DO NOTHING`,[input.installationId,`consolidate:${changed.bundle_id}:${changed.revision}`,
 JSON.stringify({bundle_id:changed.bundle_id,bundle_revision:Number(changed.revision),mode:policy.mode,policy_revision:policy.revision,authorization_epoch:policy.authorizationEpoch})])
}

export function lifecycleSourceDigest(installationId:string,events:readonly PacketSourceEvent[]):Buffer{
 const ordered=[...events].sort((a,b)=>a.source_event_id.localeCompare(b.source_event_id))
 return createHash('sha256').update(computeSourceDigest({installationId:installationId,events:ordered,artifacts:[]}))
  .update(JSON.stringify(ordered.map(e=>({provenance:e.source_provenance??{},event_type:e.event_type,occurred_at:new Date(e.occurred_at).toISOString()})))).digest()
}

/** Requires the caller's session/installation purge fence. Re-admit the whole
 * turn, including excluded siblings, so changed lineage cannot escape through
 * the previous subset of admitted members. */
export async function loadCurrentLifecycleSources(client:Pick<pg.PoolClient,'query'>,installationId:string,bundle:{bundle_id:string;session_id:string;task_key:string;source_digest:Buffer}){
 if(!bundle.task_key.startsWith('source:'))throw new Error('curation_source_changed')
 const turnId=bundle.task_key.slice(7)
 const events=(await client.query<PacketSourceEvent & {body_reclaimed_at:Date|null}>(`SELECT source_event_id::text,event_type,occurred_at,payload_hash,payload,classification,source_provenance,body_reclaimed_at
  FROM source_events WHERE installation_id=$1 AND session_id=$2 AND turn_id=$3 ORDER BY source_event_id FOR SHARE`,[installationId,bundle.session_id,turnId])).rows
 if(!events.length||events.some(e=>e.body_reclaimed_at||!canonicalPayloadHash(e.payload).equals(e.payload_hash))||!lifecycleSourceDigest(installationId,events).equals(bundle.source_digest))throw new Error('curation_source_changed')
 const admission=admitLifecycleSources({sessionId:bundle.session_id,turnId,events})
 const members=(await client.query<{source_event_id:string;source_digest:Buffer}>('SELECT source_event_id::text,source_digest FROM memory_task_bundle_sources WHERE installation_id=$1 AND bundle_id=$2',[installationId,bundle.bundle_id])).rows
 if(members.length!==admission.events.length||members.some(m=>!admission.events.some(e=>e.source_event_id===m.source_event_id&&e.payload_hash.equals(m.source_digest))))throw new Error('curation_source_unavailable')
 return {events,admitted:admission.events,turnId,unknown:admission.receipts.some(r=>!r.admission.allowed&&r.admission.reason==='provenance_unknown')}
}

/** Called after consolidation and after each child decision in the same
 * transaction. An audit row is not success until every current candidate has
 * a terminal decision; operational/semantic work stays protected. */
export async function refreshLifecycleProcessingReceipt(client:Pick<pg.PoolClient,'query'>,input:{installationId:string;parentBundleId:string}):Promise<void>{
 const parent=(await client.query('SELECT * FROM memory_task_bundles WHERE installation_id=$1 AND bundle_id=$2 FOR SHARE',[input.installationId,input.parentBundleId])).rows[0]
 if(!parent||parent.bundle_kind!=='intake'||parent.body_state!=='present')return
 const source=await loadCurrentLifecycleSources(client,input.installationId,parent)
 const state=(await client.query(`SELECT count(*)::int AS candidates,
  count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM memory_curation_decisions d WHERE d.installation_id=c.installation_id AND d.candidate_id=c.candidate_id AND d.state IN('committed','skipped') AND d.action<>'defer'))::int AS unresolved
  FROM memory_candidates c JOIN memory_task_bundles b USING(installation_id,bundle_id)
  WHERE b.installation_id=$1 AND b.parent_bundle_id=$2 AND b.parent_revision=$3 AND c.bundle_revision=b.revision`,[input.installationId,input.parentBundleId,parent.revision])).rows[0]
 const enabled=(await client.query(`SELECT 1 FROM memory_curation_runs r JOIN memory_curation_policies p USING(installation_id)
  WHERE r.installation_id=$1 AND r.bundle_id=$2 AND r.bundle_revision=$3 AND r.source_digest=$4 AND r.state='completed'
   AND r.mode='enabled' AND p.mode='enabled' AND r.policy_revision=p.revision LIMIT 1`,[input.installationId,input.parentBundleId,parent.revision,parent.source_digest])).rowCount
 const complete=!!enabled&&!source.unknown&&['completed','skipped_unresolved'].includes(parent.state)&&state.unresolved===0
 const disposition=source.unknown?'provenance_unknown':state.candidates?'concluded':'no_durable_conclusion'
 await client.query(`INSERT INTO memory_source_processing_receipts(installation_id,session_id,turn_id,source_digest,policy_version,disposition,allowed_count,excluded_count,complete)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(installation_id,turn_id,source_digest,policy_version) DO UPDATE SET
   disposition=EXCLUDED.disposition,allowed_count=EXCLUDED.allowed_count,excluded_count=EXCLUDED.excluded_count,complete=EXCLUDED.complete,created_at=clock_timestamp()`,
 [input.installationId,parent.session_id,source.turnId,parent.source_digest,LIFECYCLE_SOURCE_POLICY,disposition,source.admitted.length,source.events.length-source.admitted.length,complete])
}
