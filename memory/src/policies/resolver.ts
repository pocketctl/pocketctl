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

  type Scope = { installationId: string; repositoryId?: string | null; userScopeKey?: string | null }
  async function resolveKinds(input: Scope, kinds: readonly PolicyKind[]): Promise<EffectivePolicy[]> {
    const headsByKind = await deps.repository.resolveHeadDocuments(input, kinds)
    return kinds.map(kind => {
      const heads = headsByKind.get(kind) ?? []
      const cacheKey = `${input.installationId}:${kind}:${input.repositoryId ?? ''}:${input.userScopeKey ?? 'global'}:` + heads
        .map(head => `${head.policyVersionId}@${head.headRevision}`)
        .join('|')
      const hit = cache.get(cacheKey)
      if (hit) return hit

      const versionIds = heads.map(head => head.policyVersionId)
      let document: AnyPolicyDocument
      if (kind === 'extraction') {
        document = heads
          .map(head => head.document as ExtractionPolicyDocument)
          .reduce((effective, next) => mergeExtractionPolicies(effective, next), SYSTEM_EXTRACTION_POLICY_V1)
      } else if (kind === 'context') {
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
    })
  }

  return {
    clearCache(): void { cache.clear() },
    cacheSize(): number { return cache.size },
    async resolve(input: Scope & { kind: PolicyKind }): Promise<EffectivePolicy> {
      const [policy] = await resolveKinds(input, [input.kind])
      return policy
    },
    async resolveContext(input: Scope): Promise<[EffectivePolicy, EffectivePolicy]> {
      const [context, ranking] = await resolveKinds(input, ['context', 'ranking'])
      return [context, ranking]
    },
  }
}

export type PolicyResolver = ReturnType<typeof createPolicyResolver>
