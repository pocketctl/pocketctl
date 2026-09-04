import type pg from 'pg'
import type { PolicyRepository } from './repository.js'
import type { PolicyResolver, EffectivePolicy } from './resolver.js'
import type { InvalidationService } from '../context/invalidation-service.js'
import {
  diffPolicyDocuments,
  validatePolicyDocument,
  type AnyPolicyDocument,
  type PolicyKind,
  type PolicyLayer,
} from './schemas.js'

/**
 * Policy management orchestration: validated create → CAS activate → cache
 * invalidation → digest-keyed recompile enqueue. Activation never touches
 * active Claims or existing Candidates (ADR-P2-03): recompilation creates
 * new Generation/Extraction Runs keyed by the new effective policy hash.
 */
export function createPolicyService(deps: {
  pool: pg.Pool
  repository: PolicyRepository
  resolver: PolicyResolver
	invalidation?: InvalidationService
}) {
  return {
    async installSystemPolicies(): Promise<void> {
      await deps.repository.ensureSystemPolicies()
    },

    async effective(input: {
      installationId: string
      kind: PolicyKind
      repositoryId?: string | null
    }): Promise<EffectivePolicy> {
      return deps.resolver.resolve(input)
    },

    async createVersion(input: {
      installationId: string
      kind: PolicyKind
      layer: PolicyLayer
      scopeKey: string
      document: unknown
      actor?: { permissions: readonly string[]; ownerScopeKind?: string }
    }) {
      return deps.repository.createVersion(input)
    },

	async listVersions(input: {
		installationId: string
		kind: PolicyKind
		layer: PolicyLayer
		scopeKey: string
	}) {
		return deps.repository.listVersions(input)
	},

    /** Structural diff between the current effective doc and a candidate. */
    async previewDiff(input: {
      installationId: string
      kind: PolicyKind
      document: unknown
    }): Promise<{ ok: true; diff: Array<{ path: string; before: unknown; after: unknown }> } | {
      ok: false
      error: 'invalid_document'
      issues?: string[]
    }> {
      const validated = validatePolicyDocument(input.kind, input.document)
      if (!validated.ok) return { ok: false, error: 'invalid_document', issues: validated.issues }
      const current = await deps.resolver.resolve({
        installationId: input.installationId,
        kind: input.kind,
      })
      return {
        ok: true,
        diff: diffPolicyDocuments(
          current.document as Record<string, unknown>,
          validated.document as Record<string, unknown>,
        ),
      }
    },

    /**
     * Activate a version under CAS. On success: clear the compiled cache and
     * enqueue one digest-keyed recompile per installation.
     */
    async activate(input: {
      installationId: string
      policyVersionId: string
      expectedActiveVersionId: string
      expectedRevision: number
      expectedKind?: PolicyKind
    }): Promise<{ ok: true; revision: number } | { ok: false; error: 'cas_conflict' }> {
      const activated = await deps.repository.activateVersion(input)
      if (!activated) return { ok: false, error: 'cas_conflict' }
      deps.resolver.clearCache()
      const effective = await deps.resolver.resolve({
        installationId: input.installationId,
        kind: await kindForVersion(deps.pool, input.policyVersionId),
      })
      await deps.repository.enqueueRecompile({
        installationId: input.installationId,
        policyHash: effective.effectivePolicyHash,
      })
	  await deps.invalidation?.onConfigurationChange({
		installationId: input.installationId, reason: 'policy_changed',
	  })
      const revision = await deps.repository.headRevisionForVersion({
        installationId: input.installationId,
        policyVersionId: input.policyVersionId,
      })
      return { ok: true, revision: revision ?? input.expectedRevision + 1 }
    },

    /** Rollback = activate an earlier version with the same CAS discipline. */
    async rollback(input: {
      installationId: string
      policyVersionId: string
      expectedActiveVersionId: string
      expectedRevision: number
      expectedKind?: PolicyKind
    }) {
      return this.activate(input)
    },
  }
}

async function kindForVersion(pool: pg.Pool, policyVersionId: string): Promise<PolicyKind> {
  const result = await pool.query<{ policy_kind: PolicyKind }>(`
    SELECT s.policy_kind FROM memory_policy_sets s
    JOIN memory_policy_versions v ON v.policy_id = s.policy_id
    WHERE v.policy_version_id = $1
  `, [policyVersionId])
  return result.rows[0]?.policy_kind ?? 'extraction'
}

export type PolicyService = ReturnType<typeof createPolicyService>
export type { AnyPolicyDocument }
