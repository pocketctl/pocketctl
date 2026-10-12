import type { MemoryGovernanceScope,MemoryGovernanceQueueEntry } from '../types/memory'

/** The only product-supported promotion edges are Personal -> Team and Team -> parent Organization. */
export function promotionTargetsForSource(
  scopes: MemoryGovernanceScope[],
  sourceInstallationId: string | null,
): MemoryGovernanceScope[] {
  const source = scopes.find(scope => scope.installation_id === sourceInstallationId)
  if (!source) return []
  if (source.owner_scope_kind === 'personal') {
    return scopes.filter(scope => scope.owner_scope_kind === 'team'
      && scope.state !== 'suspended' && scope.state !== 'dissolving' && scope.state !== 'dissolved'
      && scope.permissions.includes('contribute'))
  }
  if (source.owner_scope_kind === 'team' && source.parent_organization_id) {
    return scopes.filter(scope => scope.owner_scope_kind === 'organization'
      && scope.owner_scope_id === source.parent_organization_id
      && scope.state === 'active'
      && scope.permissions.includes('contribute'))
  }
  return []
}

export function governanceEvidenceNeeds(entry:MemoryGovernanceQueueEntry):boolean{
 return !entry.current_revision?.bundle_hash||(entry.evidence!==undefined&&entry.evidence.length===0)||entry.automation_advice?.reason==='no_evidence'
}
export function boundedReviewDuration(start:number,now=performance.now()):number{return Math.min(86400000,Math.max(0,Math.round(now-start)))}
