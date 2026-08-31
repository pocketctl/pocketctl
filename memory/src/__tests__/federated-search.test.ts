import { describe, expect, test } from 'vitest'

import {
  FederatedScopeSelectionError,
  defaultReadInstallationId,
  MAX_FEDERATED_SCOPES,
  buildFederatedRecallResult,
  mergeFederatedRrf,
  encodeFederatedCursor,
  resolveFederatedCursor,
  selectFederatedScopes,
  type RrfHitInput,
  type SelectedScope,
} from '../retrieval/federated-search-service.js'
import type { RecallClaim, RecallResult } from '../retrieval/recall-service.js'
import type { ValidatedV2Grant } from '../governance/authorization.js'

const PERSONAL = '12345678-1234-4123-8123-123456789001'
const TEAM = '12345678-1234-4123-8123-123456789002'
const TEAM_2 = '12345678-1234-4123-8123-123456789003'

function grant(): ValidatedV2Grant {
  return {
    primaryInstallationId: PERSONAL,
    configVersion: '1',
    scopeBindings: [
      {
        installation_id: PERSONAL,
        owner_scope_kind: 'personal',
        owner_scope_id: PERSONAL,
        membership_id: null,
        membership_revision: '0',
        authorization_epoch: '1',
        permissions: ['read'],
      },
      {
        installation_id: TEAM,
        owner_scope_kind: 'team',
        owner_scope_id: '12345678-1234-4123-8123-123456789011',
        membership_id: '12345678-1234-4123-8123-123456789021',
        membership_revision: '2',
        authorization_epoch: '3',
        permissions: ['read'],
      },
      {
        installation_id: TEAM_2,
        owner_scope_kind: 'team',
        owner_scope_id: '12345678-1234-4123-8123-123456789012',
        membership_id: '12345678-1234-4123-8123-123456789022',
        membership_revision: '1',
        authorization_epoch: '1',
        permissions: ['read'],
      },
    ],
  }
}

function scope(installationId: string, kind: SelectedScope['ownerScopeKind'] = 'team'): SelectedScope {
  return {
    installationId,
    ownerScopeKind: kind,
    ownerScopeId: installationId,
    authorizationEpoch: '1',
  }
}

describe('federated scope selection', () => {
  test('defaults to the primary personal installation only', () => {
    const selected = selectFederatedScopes({
      grant: grant(), requestedInstallationIds: null, sharedScopesEnabled: false,
    })
    expect(selected.map(entry => entry.installationId)).toEqual([PERSONAL])
  })

  test('never implicitly broadens a shared-primary grant', () => {
    const sharedPrimary = grant()
    sharedPrimary.primaryInstallationId = TEAM
    expect(selectFederatedScopes({
      grant: sharedPrimary, requestedInstallationIds: null, sharedScopesEnabled: true,
    })).toEqual([])
    expect(() => defaultReadInstallationId({
      ...sharedPrimary,
      version: 'v2',
      installationId: TEAM,
      primaryInstallationId: TEAM,
      services: ['memory.search'],
      callerType: 'web',
    })).toThrow(/explicit scope selection/)
  })

  test('validates explicit selections against the grant bindings', () => {
    const selected = selectFederatedScopes({
      grant: grant(),
      requestedInstallationIds: [PERSONAL, TEAM],
      sharedScopesEnabled: true,
    })
    expect(selected.map(entry => entry.ownerScopeKind)).toEqual(['personal', 'team'])

    expect(() => selectFederatedScopes({
      grant: grant(), requestedInstallationIds: ['99999999-9999-4999-8999-999999999999'],
      sharedScopesEnabled: true,
    })).toThrowError(FederatedScopeSelectionError)

    expect(() => selectFederatedScopes({
      grant: grant(), requestedInstallationIds: [TEAM, TEAM],
      sharedScopesEnabled: true,
    })).toThrowError(/unique/)

    expect(() => selectFederatedScopes({
      grant: grant(),
      requestedInstallationIds: Array.from({ length: MAX_FEDERATED_SCOPES + 1 },
        () => PERSONAL),
      sharedScopesEnabled: true,
    })).toThrowError(/16/)

    // Shared scopes require the feature flag.
    expect(() => selectFederatedScopes({
      grant: grant(), requestedInstallationIds: [TEAM], sharedScopesEnabled: false,
    })).toThrowError(/MEMORY_SHARED_SCOPES/)
  })
})

describe('federated RRF merge', () => {
  function hit(claimId: string, authority: string, freshness: string,
    repositoryApplicable = true): RrfHitInput<{ claimId: string }> {
    return {
      scope: scope(TEAM),
      claimId,
      authority,
      freshnessAt: new Date(freshness),
      repositoryApplicable,
      hit: { claimId },
    }
  }

  test('merges per-scope ranks deterministically with the frozen tie-break', () => {
    const merged = mergeFederatedRrf([
      { ...hit('claim-a', 'user_accepted', '2026-08-01T00:00:00Z'), scope: scope(PERSONAL, 'personal') },
      { ...hit('claim-b', 'team_published', '2026-08-20T00:00:00Z'), scope: scope(TEAM) },
      { ...hit('claim-c', 'team_published', '2026-08-10T00:00:00Z'), scope: scope(TEAM_2) },
    ], 10)
    // A claim present in two scopes outranks single-scope hits.
    const ids = merged.map(entry => entry.hit.claimId)
    expect(ids).toContain('claim-a')
    expect(merged.length).toBe(3)
    // Determinism: identical inputs give identical outputs.
    const again = mergeFederatedRrf([
      { ...hit('claim-a', 'user_accepted', '2026-08-01T00:00:00Z'), scope: scope(PERSONAL, 'personal') },
      { ...hit('claim-b', 'team_published', '2026-08-20T00:00:00Z'), scope: scope(TEAM) },
      { ...hit('claim-c', 'team_published', '2026-08-10T00:00:00Z'), scope: scope(TEAM_2) },
    ], 10)
    expect(again.map(entry => entry.hit.claimId)).toEqual(ids)

    // Equal RRF scores (same rank, distinct scopes) fall through to
    // applicability, correction, authority, freshness, then ids.
    const tieBreak = mergeFederatedRrf([
      { ...hit('claim-x', 'team_published', '2026-08-01T00:00:00Z'), scope: scope(PERSONAL, 'personal') },
      { ...hit('claim-y', 'team_published', '2026-08-02T00:00:00Z'), scope: scope(TEAM) },
      { ...hit('claim-z', 'user_corrected', '2026-07-01T00:00:00Z', false), scope: scope(TEAM_2) },
    ], 10)
    // All three hold rank 1 in their scope (equal RRF); applicability puts
    // the non-applicable z last; freshness ranks y over x.
    expect(tieBreak.map(entry => entry.hit.claimId)).toEqual(['claim-y', 'claim-x', 'claim-z'])
  })

  test('limits the merged result set', () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      hit(`claim-${index}`, 'user_accepted', '2026-08-01T00:00:00Z'))
    expect(mergeFederatedRrf(many, 5)).toHaveLength(5)
  })

  test('decorates shared Recall variants and exposes their conflict group', () => {
    const team = scope(TEAM)
    const claim = (claimId: string, statement: string): RecallClaim => ({
      claimId,
      versionId: `${claimId}-version`,
      claimType: 'work_method',
      statement,
      scopeKind: 'installation',
      scopeKey: 'global',
      freshnessAt: new Date('2026-08-31T00:00:00Z'),
      authority: 'team_published',
      evidence: [],
    })
    const left = claim('claim-left', 'use thinking disabled')
    const right = claim('claim-right', 'keep thinking enabled')
    const result = buildFederatedRecallResult(
      [{
        scope: team,
        result: {
          requestId: 'request-1', degradedComponents: [], claims: [left, right],
          conflicts: [], relatedEpisodes: [], coverageGaps: [], totalChars: 0,
        } satisfies RecallResult,
      }],
      mergeFederatedRrf([left, right].map(hit => ({
        scope: team, hit, claimId: hit.claimId,
        authority: hit.authority, repositoryApplicable: true, freshnessAt: hit.freshnessAt,
      })), 10),
      8_000,
      new Map([
        [`${TEAM}:claim-left`, { ownerScopeKind: 'team', ownerScopeId: TEAM, conflictGroupId: 'group-1', conflictVariant: 0 }],
        [`${TEAM}:claim-right`, { ownerScopeKind: 'team', ownerScopeId: TEAM, conflictGroupId: 'group-1', conflictVariant: 1 }],
      ]),
    )

    expect(result.claims.map(entry => ({
      claimId: entry.claimId,
      conflictGroupId: entry.conflictGroupId,
      conflictVariant: entry.conflictVariant,
    }))).toEqual([
      { claimId: 'claim-left', conflictGroupId: 'group-1', conflictVariant: 0 },
      { claimId: 'claim-right', conflictGroupId: 'group-1', conflictVariant: 1 },
    ])
    expect(result.conflicts.map(entry => entry.claimId)).toEqual(['claim-left', 'claim-right'])
  })

  test('does not collapse identical claim ids from different installations', () => {
    const merged = mergeFederatedRrf([
      { ...hit('same-claim', 'team_published', '2026-08-01T00:00:00Z'), scope: scope(TEAM) },
      { ...hit('same-claim', 'organization_published', '2026-08-02T00:00:00Z'), scope: scope(TEAM_2) },
    ], 10)
    expect(merged).toHaveLength(2)
    expect(merged.map(entry => entry.scope.installationId).sort()).toEqual([TEAM, TEAM_2].sort())
  })

  test('signed cursors bind the query and every selected authorization epoch', () => {
    const context = { scopes: [scope(TEAM)], query: 'relay failure' }
    const asOf = new Date('2026-08-30T00:00:00.000Z')
    const cursor = encodeFederatedCursor({ offset: 10, asOf, context, key: 'cursor-key' })
    expect(resolveFederatedCursor({ cursor, context, key: 'cursor-key' })).toEqual({ offset: 10, asOf })
    expect(() => resolveFederatedCursor({
      cursor,
      context: { ...context, scopes: [{ ...context.scopes[0], authorizationEpoch: '999' }] },
      key: 'cursor-key',
    })).toThrow('invalid federated cursor')
    expect(() => resolveFederatedCursor({
      cursor, context: { ...context, query: 'different' }, key: 'cursor-key',
    })).toThrow('invalid federated cursor')
    expect(() => encodeFederatedCursor({
      offset: 120, asOf, context, key: 'cursor-key',
    })).toThrow('invalid federated cursor offset')
  })
})
