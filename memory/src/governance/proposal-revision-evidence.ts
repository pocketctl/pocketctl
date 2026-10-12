import {createHash} from 'node:crypto'
import type pg from 'pg'
import {sanitizeText} from '../episodes/content-policy.js'
import {requireCurrentScopePermission,type ValidatedV2Grant} from './authorization.js'
import type {SharedRevisionEvidence} from './revision-bundle.js'
export interface RevisionEvidenceSelection {retainedOrdinals:number[];removedOrdinals:number[];newEvidenceIds:string[]}
/** Explicit replacement plan: every old item is retained or removed, never silently copied. */
export async function prepareRevisionEvidence(input:{client:pg.PoolClient;candidateId:string;sourceInstallationId:string;sourceVersionId:string;previousRevisionId:string;
 selection:RevisionEvidenceSelection|undefined;maxEvidence:number;grant?:ValidatedV2Grant}):Promise<SharedRevisionEvidence[]> {
 const s=input.selection
 if(!s || !Array.isArray(s.retainedOrdinals)||!Array.isArray(s.removedOrdinals)||!Array.isArray(s.newEvidenceIds)
  || [...s.retainedOrdinals,...s.removedOrdinals].some(n=>!Number.isInteger(n)||n<1)
  || s.newEvidenceIds.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id)))throw new Error('explicit evidence selection required')
 const old=(await input.client.query<SharedRevisionEvidence>('SELECT ordinal,evidence_kind,excerpt,excerpt_hash,source_evidence_hash,occurred_at,sanitized_locator FROM memory_promotion_evidence WHERE candidate_revision_id=$1 ORDER BY ordinal FOR SHARE',[input.previousRevisionId])).rows
 const selected=[...s.retainedOrdinals,...s.removedOrdinals]
 if(new Set(selected).size!==selected.length || selected.length!==old.length || selected.some(n=>!old.some(row=>row.ordinal===n))
  || new Set(s.newEvidenceIds).size!==s.newEvidenceIds.length)throw new Error('ambiguous evidence selection')
 const count=s.retainedOrdinals.length+s.newEvidenceIds.length
 if(count<1||count>Math.min(8,input.maxEvidence))throw new Error('evidence selection out of bounds')
 const retained=s.retainedOrdinals.map(n=>old.find(row=>row.ordinal===n)!)
 let added:SharedRevisionEvidence[]=[]
 if(s.newEvidenceIds.length){
  if(!input.grant)throw new Error('new evidence requires source authorization')
  await requireCurrentScopePermission({client:input.client,grant:input.grant,targetInstallationId:input.sourceInstallationId,permission:'read'})
  const rows=(await input.client.query<{evidence_id:string;evidence_kind:string;excerpt:string;excerpt_hash:Buffer;occurred_at:Date|null;locator:Record<string,unknown>}>(`
   SELECT e.evidence_id,e.evidence_kind,e.excerpt,e.excerpt_hash,e.occurred_at,e.locator FROM knowledge_evidence e
   JOIN knowledge_claims c ON c.current_version_id=e.version_id AND c.installation_id=e.installation_id AND c.state='active'
   WHERE e.installation_id=$1 AND e.version_id=$2 AND e.evidence_id=ANY($3::uuid[]) FOR SHARE OF e,c`,[input.sourceInstallationId,input.sourceVersionId,s.newEvidenceIds])).rows
  if(rows.length!==s.newEvidenceIds.length)throw new Error('new evidence not owned by current source')
  added=s.newEvidenceIds.map(id=>{
   const row=rows.find(r=>r.evidence_id===id)!,provenance=row.locator?.source_provenance as Record<string,unknown>|undefined
   if(createHash('sha256').update(row.excerpt).digest('hex')!==row.excerpt_hash.toString('hex'))throw new Error('new evidence source integrity unavailable')
   return {ordinal:0,evidence_kind:row.evidence_kind,excerpt:row.excerpt,excerpt_hash:'',source_evidence_hash:row.excerpt_hash.toString('hex'),occurred_at:row.occurred_at,
    sanitized_locator:provenance?.source_kind==='team_session'?{source_provenance:provenance}:null}
  })
 }
 return [...retained,...added].map((row,i)=>{
  const excerpt=sanitizeText(row.excerpt,4000).text
  if(!excerpt)throw new Error('evidence empty after redaction')
  return {...row,ordinal:i+1,excerpt,excerpt_hash:createHash('sha256').update(excerpt).digest('hex')}
 })
}
