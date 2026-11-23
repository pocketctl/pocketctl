import {createHash} from 'node:crypto'
import {admitLifecycleSources} from '../episodes/source-admission.js'
import {computeSourceDigest,type PacketSourceEvent} from '../episodes/packet.js'

export type LifecycleDigestEvent=Pick<PacketSourceEvent,'source_event_id'|'payload_hash'|'event_type'|'occurred_at'|'source_provenance'>
export function lifecycleSourceDigest(installationId:string,events:readonly LifecycleDigestEvent[]):Buffer{
 const ordered=[...events].sort((a,b)=>a.source_event_id.localeCompare(b.source_event_id))
 return createHash('sha256').update(computeSourceDigest({installationId:installationId,events:ordered,artifacts:[]}))
  .update(JSON.stringify(ordered.map(e=>({provenance:e.source_provenance??{},event_type:e.event_type,occurred_at:new Date(e.occurred_at).toISOString()})))).digest()
}

export type LifecycleInput = {installationId:string;sessionId:string;turnId:string;events:LifecycleDigestEvent[]}

/** Pure calculation over a complete authenticated input. Keep only the facts
 * needed for publication. The writer still fences the input and policy. */
export function prepareLifecycleTurn(input:LifecycleInput){
 return summarize(input,admitLifecycleSources(input))
}

export function prepareExcludedLifecycleTurn(input:LifecycleInput){
 const admission=admitLifecycleSources(input)
 return admission.events.length ? null : summarize(input,admission)
}

function summarize(input:LifecycleInput,admission:ReturnType<typeof admitLifecycleSources<LifecycleDigestEvent>>){
 const members=admission.events.map(event=>({
  id:event.source_event_id,hash:event.payload_hash,sequence:(event.source_provenance!.memory as {sequence:string}).sequence,
 }))
 return {
  installationId:input.installationId,sessionId:input.sessionId,turnId:input.turnId,
  digest:lifecycleSourceDigest(input.installationId,input.events),members,
  watermark:members.reduce((max,member)=>{const seq=BigInt(member.sequence);return seq>max?seq:max},0n).toString(),
  excluded:input.events.length-members.length,diagnostics:admission.diagnostics,
  unknown:admission.receipts.some(r=>!r.admission.allowed&&r.admission.reason==='provenance_unknown'),
 }
}
