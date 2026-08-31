import type pg from 'pg'
import type { PolicyRepository } from './repository.js'
import {
  canonicalPolicyHash,
  mergeContextPolicies,
  mergeExtractionPolicies,
  SYSTEM_CONTEXT_POLICY_V1,
  SYSTEM_EXTRACTION_POLICY_V1,
  type AnyPolicyDocument,
  type ContextPolicyDocument,
  type ExtractionPolicyDocument,
  type PolicyKind,
} from './schemas.js'

export interface EffectivePolicy {
  document: AnyPolicyDocument
  /** Ordered contributing version ids, system layer first. */
  policyVersionIds: string[]
  effectivePolicyHash: Buffer
  /** Monotonic sum of contributing head revisions, persisted for audit. */
  policyRevision: number
}

/**
 * Layered policy resolution (ADR-P2-07): system head first, then
 * installation-scoped repository/user heads in creation order, each merged
 * monotonically (narrow-only). The compiled result is cached in memory keyed
 * by the contributing head revisions and invalidated by the service on any
 * activation.
 */
export function createPolicyResolver(deps: { pool: pg.Pool; repository: PolicyRepository }) {
  const cache = new Map<string, EffectivePolicy>()

  return {
    /** Test/maintenance hook: drop compiled-policy cache entries. */
    clearCache(): void {
      cache.clear()
    },

    cacheSize(): number {
      return cache.size
    },

    async resolve(input: {
      installationId: string
      kind: PolicyKind
      repositoryId?: string | null
      userScopeKey?: string | null
    }): Promise<EffectivePolicy> {
      await deps.repository.ensureSystemPolicies()
      // Phase 3: shared layers resolve across the owner-scope chain. The
      // organization layer comes from the parent Organization's installation
      // (unique mirror row per shared scope); the team layer attaches to this
      // installation only when it owns a team scope.
      let organizationInstallationId: string | null = null
      let ownsTeamScope = false
      const scopeRow = await deps.pool.query<{
        owner_scope_kind: string
        parent_organization_id: string | null
      }>(`
        SELECT owner_scope_kind, parent_organization_id::text
        FROM memory_owner_scopes WHERE installation_id = $1
      `, [input.installationId])
      if (scopeRow.rows[0]?.owner_scope_kind === 'team') {
        ownsTeamScope = true
        const parentId = scopeRow.rows[0].parent_organization_id
        if (parentId) {
          const orgInstallation = await deps.pool.query<{ installation_id: string }>(`
            SELECT installation_id::text FROM memory_owner_scopes
            WHERE owner_scope_kind = 'organization' AND owner_scope_id = $1
          `, [parentId])
          organizationInstallationId = orgInstallation.rows[0]?.installation_id ?? null
        }
      }
      const heads = await deps.repository.listHeadDocuments({
        installationId: input.installationId,
        kind: input.kind,
        repositoryId: input.repositoryId ?? null,
        userScopeKey: input.userScopeKey ?? 'global',
        organizationInstallationId,
        includeTeamLayer: ownsTeamScope,
      })
      const cacheKey = `${input.installationId}:${input.kind}:${input.repositoryId ?? ''}:${input.userScopeKey ?? 'global'}:` + heads
        .map(head => `${head.policyVersionId}@${head.headRevision}`)
        .join('|')
      const hit = cache.get(cacheKey)
      if (hit) return hit

      const versionIds = heads.map(head => head.policyVersionId)
      let document: AnyPolicyDocument
      if (input.kind === 'extraction') {
        document = heads
          .map(head => head.document as ExtractionPolicyDocument)
          .reduce((effective, next) => mergeExtractionPolicies(effective, next), SYSTEM_EXTRACTION_POLICY_V1)
      } else if (input.kind === 'context') {
        document = heads
          .map(head => head.document as ContextPolicyDocument)
          .reduce((effective, next) => mergeContextPolicies(effective, next), SYSTEM_CONTEXT_POLICY_V1)
      } else {
        // Ranking V1 weights are code-owned; only the system head applies.
        document = heads[0]?.document ?? SYSTEM_CONTEXT_POLICY_V1
        versionIds.length = Math.min(1, heads.length)
        versionIds[0] = heads[0]?.policyVersionId ?? ''
      }
      const effective: EffectivePolicy = {
        document,
        policyVersionIds: versionIds,
        effectivePolicyHash: canonicalPolicyHash(document),
        policyRevision: Math.max(1, heads.reduce((sum, head) => sum + head.headRevision, 0)),
      }
      cache.set(cacheKey, effective)
      return effective
    },
  }
}

export type PolicyResolver = ReturnType<typeof createPolicyResolver>
