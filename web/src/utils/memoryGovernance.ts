import type { MemoryGovernanceScope } from '../types/memory'

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
