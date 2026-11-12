import {createHash} from 'node:crypto'
import {canonicalJsonString,canonicalPayloadHash,verifyOriginalSourceHash,type ResolvedSourceBody,type SourceKind} from '@pocketctl/session-source'
import {parseMemorySourceProvenance} from '../episodes/skill-provenance.js'
export interface LegacyComparisonSource {
 sourceEventId:string;installationId:string;origin:'feed'|'snapshot'|'team';originPosition:string
 sessionId:string;turnId:string|null;eventType:string;occurredAt:string;payload:unknown;payloadHash:string
 classification:Record<string,unknown>;provenance:Record<string,unknown>
 unavailable?:boolean
 links:{kind:SourceKind;key:string;via:'typed-ref'|'inbox'|'snapshot'|'team-adapter';envelopeVerified?:boolean}[]
}
export interface SourcePageComparison {
 schemaVersion:1;matched:string;unproven:string;different:string;unknownProvenance:string
 canonicalDigest:string;legacyDigest:string;fullAcceptanceReady:false
 findings:{canonicalKey:string;reason:'missing_identity_relation'|'duplicate_legacy_identity'|'installation_mismatch'|'source_metadata_mismatch'|'original_hash_mismatch'|'body_hash_mismatch'|'provenance_mismatch'|'canonical_hash_mismatch'|'source_unavailable'}[]
}
function provesIdentity(link:LegacyComparisonSource['links'][number]):boolean{
 return link.via!=='inbox'||link.envelopeVerified===true
}
function legacyProvenance(row:LegacyComparisonSource):Record<string,unknown>{
 if(row.origin==='team')return row.provenance.source_kind==='team_session'?{state:'known',team:row.provenance}:{state:'unknown'}
 const proof=parseMemorySourceProvenance(row.provenance.memory)
 return proof&&proof.session_id===row.sessionId&&proof.turn_id===row.turnId?{state:'known',memory:proof}:{state:'unknown'}
}
function micros(value:string):bigint|null{
 const stamp=Date.parse(value),fraction=value.match(/\.(\d{1,6})(?:Z|[+-]\d{2}:\d{2})$/)?.[1]??''
 if(!Number.isFinite(stamp)||!/T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return null
 return BigInt(stamp)*1000n+BigInt(fraction.padEnd(6,'0').slice(3))
}
/** Pure comparison of explicit identity proofs; never searches for equal text
 * or grants replacement/deletion eligibility. Findings/digests contain no body.
 * Packet/evidence and reverse/full-root coverage are separate acceptance gates. */
export function compareSourcePage(installationId:string,bodies:readonly ResolvedSourceBody[],legacy:readonly LegacyComparisonSource[],options:{maxBytes?:number}={}):SourcePageComparison{
 const maxBytes=options.maxBytes??32*1024*1024
 if(!installationId||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>32*1024*1024||bodies.length>128||legacy.length>256)throw Error('shadow_comparison_limit')
 let bytes=0,matched=0,unproven=0,different=0,unknown=0
 const canonical=createHash('sha256'),old=createHash('sha256'),findings:SourcePageComparison['findings']=[],seen=new Set<string>()
 const identities=new Set(bodies.map(b=>b.head.kind+':'+b.head.canonicalKey)),ambiguous=new Set<string>()
 for(const row of legacy){
  const linked=new Set(row.links.filter(provesIdentity).map(l=>l.kind+':'+l.key).filter(key=>identities.has(key)))
  if(linked.size>1)ambiguous.add(row.sourceEventId)
 }
 const observe=(value:unknown)=>{const json=canonicalJsonString(value);bytes+=Buffer.byteLength(json);if(bytes>maxBytes)throw Error('shadow_comparison_limit');return json}
 for(const body of bodies){
  const head=body.head,key=head.kind+':'+head.canonicalKey
  if(seen.has(key))throw Error('shadow_comparison_duplicate_canonical_identity');seen.add(key)
  const payload=observe(body.payload)
  const fail=(reason:SourcePageComparison['findings'][number]['reason'],missing=false)=>{findings.push({canonicalKey:head.canonicalKey,reason});if(missing)unproven++;else different++}
  if(createHash('sha256').update(payload).digest('hex')!==head.contentHash){fail('canonical_hash_mismatch');continue}
  const rows=legacy.filter(r=>r.links.some(link=>link.kind===head.kind&&link.key===head.canonicalKey))
  const provenRows=rows.filter(row=>row.links.some(link=>link.kind===head.kind&&link.key===head.canonicalKey&&provesIdentity(link)))
  if(provenRows.length>1||provenRows.some(row=>ambiguous.has(row.sourceEventId))){fail('duplicate_legacy_identity',true);continue}
  const row=provenRows[0]??(rows.length===1?rows[0]:undefined)
  if(!row){fail('missing_identity_relation',true);continue}
  if(row.installationId!==installationId){fail('installation_mismatch');continue}
  if(row.unavailable){fail('source_unavailable',true);continue}
  const canonicalTime=micros(head.occurredAt??''),originalTime=micros(row.occurredAt)
  const timeMatches=canonicalTime!==null&&originalTime!==null&&(canonicalTime===originalTime||['feed','snapshot'].includes(row.origin)
   &&originalTime%1000n===0n&&Date.parse(row.occurredAt)===Date.parse(head.occurredAt!))
  if(row.sessionId!==head.sessionKey||row.turnId!==(head.turnKey??null)||row.eventType!==head.eventType||!timeMatches
   ||canonicalJsonString(row.classification)!==canonicalJsonString(head.classification)){fail('source_metadata_mismatch');continue}
  const legacyPayload=observe(row.payload)
  if(!verifyOriginalSourceHash({origin:row.origin,originPosition:row.originPosition,eventType:row.eventType,occurredAt:row.occurredAt,payload:row.payload,payloadHash:row.payloadHash})){fail('original_hash_mismatch');continue}
  if(!provenRows.length){fail('missing_identity_relation',true);continue}
  if(createHash('sha256').update(legacyPayload).digest('hex')!==head.contentHash){fail('body_hash_mismatch');continue}
  const proof=legacyProvenance(row)
  if(canonicalJsonString(proof)!==canonicalJsonString(head.provenance)){fail('provenance_mismatch');continue}
  if(proof.state==='unknown')unknown++
  // Original UUID/time/hash/provenance are the identity contract. The shadow
  // canonical body is substituted under that same proven identity, not minted
  // as a second Memory event or silently normalized into another hash version.
  const identity=[head.kind,head.canonicalKey,row.sourceEventId,row.sessionId,row.turnId,row.eventType,row.occurredAt,row.payloadHash,head.classification,proof]
  canonical.update(canonicalJsonString([identity,canonicalPayloadHash(body.payload).toString('hex')])).update('\n')
  old.update(canonicalJsonString([identity,canonicalPayloadHash(row.payload).toString('hex')])).update('\n')
  matched++
 }
 canonical.update(canonicalJsonString({bodyCount:String(bodies.length)}));old.update(canonicalJsonString({bodyCount:String(matched)}))
 return {schemaVersion:1,matched:String(matched),unproven:String(unproven),different:String(different),unknownProvenance:String(unknown),
  canonicalDigest:canonical.digest('hex'),legacyDigest:old.digest('hex'),fullAcceptanceReady:false,findings}
}
