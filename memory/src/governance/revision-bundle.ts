import type {ClaimRelationships} from '../claims/conflict-classifier.js'
import {createHash} from 'node:crypto'
import type {ScopeKind} from '../claims/types.js'
export interface ClaimApplicability {
 scopeKind:ScopeKind
 canonicalRepositoryKey:string|null
 repositoryId:string|null
 snapshotId:string|null
 branch:string|null
 scopeKey:string
 status:'verified'|'legacy_unknown'|'requires_review'
}
export interface RevisionBundle {
 relationships?:ClaimRelationships
 schemaVersion:2
 statement:string
 structuredContent:Record<string,unknown>
 applicability:ClaimApplicability
 sourceSnapshotCommitSha?:string|null
 sourceRepositoryKey?:string|null
 sourceContentHash:string
 sourceValidFrom:string|null
 sourceValidUntil:string|null
 sourceFreshnessAt:string|null
 evidence:Array<{evidenceId:string;contentHash:string;sourceHash:string;evidenceKind:string;occurredAt:string|null;locator:Record<string,unknown>|null}>
 originPolicyHash:string|null
 reviewPolicyHash:string
}
export interface SharedRevisionEvidence {
 ordinal:number; evidence_kind:string; excerpt:string; excerpt_hash:string
 source_evidence_hash:string; occurred_at:Date|string|null; sanitized_locator:Record<string,unknown>|null
}
export function canonicalBundleJSON(value:unknown):string {
 const normalize=(entry:unknown):unknown=>{
  if(Array.isArray(entry))return entry.map(normalize)
  if(entry!==null&&typeof entry==='object')return Object.fromEntries(Object.entries(entry).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,v])=>[key,normalize(v)]))
  if(entry===undefined || (typeof entry==='number'&&!Number.isFinite(entry)))throw new Error('invalid bundle value')
  return entry
 }
 return JSON.stringify(normalize(value))
}
export function revisionBundleHash(bundle:RevisionBundle):string {
 return createHash('sha256').update(canonicalBundleJSON(bundle),'utf8').digest('hex')
}
export function bundleEvidence(rows:SharedRevisionEvidence[]):RevisionBundle['evidence'] {
 return rows.map(row=>({evidenceId:`shared:${row.ordinal}`,contentHash:row.excerpt_hash,sourceHash:row.source_evidence_hash,
  evidenceKind:row.evidence_kind,occurredAt:row.occurred_at?new Date(row.occurred_at).toISOString():null,locator:row.sanitized_locator}))
}
export function verifyRevisionBundle(input:{revision_bundle:RevisionBundle|null;revision_bundle_hash:string|null;statement:string;structured_content:Record<string,unknown>}, evidence:SharedRevisionEvidence[]):boolean {
 if(input.revision_bundle===null&&input.revision_bundle_hash===null)return true // Legacy bridge; historical remediation is separately gated.
 const bundle=input.revision_bundle
 if(!bundle || !input.revision_bundle_hash || bundle.schemaVersion!==2)return false
 try {
  return revisionBundleHash(bundle)===input.revision_bundle_hash && bundle.statement===input.statement
   && canonicalBundleJSON(bundle.structuredContent)===canonicalBundleJSON(input.structured_content)
   && canonicalBundleJSON(bundle.evidence)===canonicalBundleJSON(bundleEvidence(evidence))
   && evidence.every(row=>createHash('sha256').update(row.excerpt).digest('hex')===row.excerpt_hash)
 } catch {return false}
}
export type AutomationActorKind='automation_executor'
export type AutomationEvaluationOutcome='eligible_auto'|'needs_human'|'deferred'|'invalid'
