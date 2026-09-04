import { describe, expect, test } from 'vitest'

import { promotionTargetsForSource } from '../memoryGovernance'
import type { MemoryGovernanceScope } from '../../types/memory'

const personal: MemoryGovernanceScope = {
  installation_id: 'personal', owner_scope_kind: 'personal', owner_scope_id: 'personal',
  authorization_epoch: '1', permissions: ['read'], state: 'active',
}
const team: MemoryGovernanceScope = {
  installation_id: 'team', owner_scope_kind: 'team', owner_scope_id: 'team-scope',
  parent_organization_id: 'org-scope', authorization_epoch: '1',
  permissions: ['read', 'contribute'], state: 'active',
}
const organization: MemoryGovernanceScope = {
  installation_id: 'org', owner_scope_kind: 'organization', owner_scope_id: 'org-scope',
  authorization_epoch: '1', permissions: ['read', 'contribute'], state: 'active',
}
const otherOrganization: MemoryGovernanceScope = {
  ...organization, installation_id: 'other-org', owner_scope_id: 'other-org-scope',
}

describe('promotionTargetsForSource', () => {
  test('allows only Personal to Team and Team to its parent Organization', () => {
    const scopes = [personal, team, organization, otherOrganization]
    expect(promotionTargetsForSource(scopes, personal.installation_id).map(scope => scope.installation_id))
      .toEqual(['team'])
    expect(promotionTargetsForSource(scopes, team.installation_id).map(scope => scope.installation_id))
      .toEqual(['org'])
    expect(promotionTargetsForSource(scopes, organization.installation_id)).toEqual([])
  })
})
