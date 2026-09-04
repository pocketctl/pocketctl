import type pg from 'pg'
import type { GrantScopeBinding } from '../governance/authorization.js'
import { DEFAULT_TEAM_REVIEW_POLICY, loadEffectiveReviewPolicySnapshot } from '../governance/review-policy.js'
import { canonicalPayloadHash } from '../inbox/canonical-json.js'
import { loadSkillPublicationPolicy } from './policy-service.js'

/** Shared exact policy identity for review, Replay and later publication gates. */
export async function loadSkillReviewPolicySnapshot(client: pg.PoolClient, installationId: string, binding: GrantScopeBinding, options: { ensure?: boolean } = {}) {
  const snapshot = binding.owner_scope_kind === 'personal'
    ? { scopeKind: 'personal', activeVersionId: null, parentActiveVersionId: null,
      policy: { ...DEFAULT_TEAM_REVIEW_POLICY, require_independent_reviewer: false } }
    : await loadEffectiveReviewPolicySnapshot(client, installationId, { ensure: options.ensure ?? true })
  const publication = await loadSkillPublicationPolicy(client,installationId)
  const bound = { ...snapshot, skillReviewPolicy: 'skill-review.v1', ...(publication.binding?{publicationPolicy:publication.binding}:{}) }
  return { snapshot: bound, hash: canonicalPayloadHash(bound).toString('hex') }
}
