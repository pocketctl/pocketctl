import {canonicalPayloadHash} from './canonical-json.js'
export type OriginalSourceHashVersion='canonical-json-sha256-v1'|'snapshot-envelope-sha256-v1'
export interface OriginalSourceHashInput {
 origin:string;originPosition:string;eventType:string;occurredAt:Date|string;payload:unknown;payloadHash:Buffer|string
}
/** Old snapshot projection stored SHA256(the entire four-field wire event),
 * while Feed projection stored SHA256(payload). Preserve that original digest
 * input. Recognize the old format only by recomputing its exact cryptographic
 * hash, including original event ID/type/time. This proves no owner/provenance
 * or canonical relation, and does not recover missing metadata from body text.
 */
export function verifyOriginalSourceHash(input:OriginalSourceHashInput):OriginalSourceHashVersion|null{
 const expected=Buffer.isBuffer(input.payloadHash)?input.payloadHash.toString('hex'):input.payloadHash
 if(!/^[a-f0-9]{64}$/.test(expected))return null
 if(canonicalPayloadHash(input.payload).toString('hex')===expected)return 'canonical-json-sha256-v1'
 if(input.origin!=='snapshot'||!/^[1-9][0-9]{0,18}$/.test(input.originPosition)||BigInt(input.originPosition)>9223372036854775807n||!input.eventType)return null
 const date=new Date(input.occurredAt);if(!Number.isFinite(date.getTime()))return null
 const iso=date.toISOString(),times=[iso,...(iso.endsWith('.000Z')?[iso.replace('.000Z','Z')]:[])]
 const ids:(number|string)[]=[input.originPosition]
 if(BigInt(input.originPosition)<=BigInt(Number.MAX_SAFE_INTEGER))ids.push(Number(input.originPosition))
 for(const event_id of ids)for(const created_at of times){
  if(canonicalPayloadHash({event_id,event_type:input.eventType,payload:input.payload,created_at}).toString('hex')===expected)return 'snapshot-envelope-sha256-v1'
 }
 return null
}
