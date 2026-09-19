import { normalizedClaimKey, tokenSimilarity } from '../retrieval/query-normalizer.js'
import type { ExtractionPolicyDocument } from '../policies/schemas.js'

/**
 * Deterministic candidate validation (plan §8.3 / Task 6). The validator runs
 * after the model proposes candidates: evidence must resolve inside the same
 * episode, scope must not exceed the episode's facts, tombstoned identities
 * stay dead, and duplicates/conflicts are classified without ever touching an
 * active claim. Reason codes are bounded strings only.
 */

export const CONFLICT_THRESHOLD = 0.5

export interface ActiveClaimIdentity {
  claimId: string
  statement: string
}

export interface ValidationContext {
  manifestHandles: ReadonlySet<string>
  episode: {
    turnId: string
    repositoryId: string | null
    repoSnapshotId: string | null
    branch: string | null
    terminalOutcome?: boolean
  }
  now: Date
  /** Tombstoned identity keys (privacy-deleted) that must stay dead. */
  tombstonedKeys: ReadonlySet<string>
  /** Active claims in the same (claim_type, scope) family. */
  activeFamily: readonly ActiveClaimIdentity[]
  policy?: ExtractionPolicyDocument
  /** Different handles can refer to the same source event. */
  evidenceSourceKeys?: ReadonlyMap<string, string>
}

export type CandidateForValidation = {
  claimType: string
  statement: string
  scopeKind: 'installation' | 'repository' | 'snapshot' | 'branch' | 'task'
  scopeKey: string
  repositoryId: string | null
  repoSnapshotId: string | null
  branch: string | null
  validUntil: Date | null
  validFrom?: Date | null
  valueAssessment?: { utility: number; repeatability: number; friction: number }
  evidenceHandles: readonly string[]
  normalizedKey: string
}

export type CandidateVerdict =
  | { status: 'validated'; validation: { codes: string[] } }
  | { status: 'rejected_by_validator'; validation: { codes: string[] } }
  | { status: 'duplicate'; duplicateOfClaimId: string; validation: { codes: string[] } }
  | { status: 'conflict'; duplicateOfClaimId: string | null; validation: { codes: string[] } }

function reject(codes: string[]): CandidateVerdict {
  return { status: 'rejected_by_validator', validation: { codes } }
}

const VERSION_CONTROL_ACTION = /(?:\b(?:git\s+)?(?:commit(?:ted)?|push(?:ed)?|merge[dr]?|tag(?:ged)?|checkout|rebas(?:e|ed)|cherry[- ]?pick(?:ed)?|pull(?:ed)?)\b|提交|推送|合并|标签|分支|工作区)/iu
const VERSION_CONTROL_EVENT = /(?:\b(?:completed|succeeded|successfully|current(?:ly)?|already|skipped|without|clean|this\s+(?:change|task|time))\b|\b[0-9a-f]{7,40}\b|已|完成|成功|本次|这次|刚刚|随后|当前|跳过|未创建|没有创建)/iu
const DURABLE_KNOWLEDGE = /(?:\b(?:must|shall|should|never|always|only|require(?:d)?|convention|policy|root\s+cause|because|caused?|when|if)\b|必须|禁止|只能|始终|每次|默认|固定|约定|规范|前置条件|适用条件|根因|因为|由于|导致|失败时|若|如果|当.{0,24}时|采用.{0,40}(?:策略|流程|规范))/iu

/**
 * Completed VCS operations are audit events, not reusable knowledge. Keep the
 * rule deliberately narrow: a statement with durable policy, causality or
 * conditional guidance remains reviewable even when it mentions Git.
 */
function isEphemeralVersionControlEvent(statement: string): boolean {
  const normalized = statement.trim().replace(/\s+/g, ' ')
  return VERSION_CONTROL_ACTION.test(normalized)
    && VERSION_CONTROL_EVENT.test(normalized)
    && !DURABLE_KNOWLEDGE.test(normalized)
}

export function validateCandidate(
  candidate: CandidateForValidation,
  context: ValidationContext,
): CandidateVerdict {
  const codes: string[] = []

  // Evidence coverage: 1..12 handles, all resolving in this episode's
  // manifest — a handle from anywhere else is unresolvable.
  if (candidate.evidenceHandles.length < 1 || candidate.evidenceHandles.length > 12) {
    codes.push('evidence_count_out_of_bounds')
  }
  const unresolved = candidate.evidenceHandles.filter(handle => !context.manifestHandles.has(handle))
  if (unresolved.length > 0) codes.push('evidence_unresolved')
  if (new Set(candidate.evidenceHandles).size !== candidate.evidenceHandles.length) {
    codes.push('evidence_handles_repeated')
  }
  if (context.policy) {
    const policy = context.policy
    if (!policy.focus.claim_types.includes(candidate.claimType)) codes.push('policy_claim_type_excluded')
    const sources = new Set(candidate.evidenceHandles.map(handle => context.evidenceSourceKeys?.get(handle) ?? handle))
    if (sources.size < policy.evidence.min_items) codes.push('policy_evidence_min_items')
    if (policy.evidence.require_terminal_outcome && !context.episode.terminalOutcome) {
      codes.push('policy_terminal_outcome_required')
    }
    // Extraction currently operates on one turn, never invent cross-turn coverage.
    if (policy.evidence.require_distinct_turns > 1) codes.push('policy_distinct_turns_unavailable')
    const filter = policy.value_filter
    const value = candidate.valueAssessment
    if (!value && (filter.min_utility > 0 || filter.min_repeatability > 0 || filter.max_friction < 1)) {
      codes.push('policy_value_assessment_required')
    } else if (value) {
      if (value.utility < filter.min_utility) codes.push('policy_utility_below_minimum')
      if (value.repeatability < filter.min_repeatability) codes.push('policy_repeatability_below_minimum')
      if (value.friction > filter.max_friction) codes.push('policy_friction_above_maximum')
    }
  }

  // Scope must not exceed the episode's recorded facts.
  if (candidate.scopeKind === 'repository' && !context.episode.repositoryId) {
    codes.push('scope_exceeds_episode_repository')
  }
  if (candidate.scopeKind === 'snapshot' && !context.episode.repoSnapshotId) {
    codes.push('scope_exceeds_episode_snapshot')
  }
  if (candidate.scopeKind === 'branch' && !context.episode.branch) {
    codes.push('scope_exceeds_episode_branch')
  }
  if (candidate.scopeKind === 'repository'
    && context.episode.repositoryId
    && (candidate.repositoryId !== context.episode.repositoryId
      || candidate.scopeKey !== context.episode.repositoryId)) {
    codes.push('scope_repository_mismatch')
  }
  if (candidate.scopeKind === 'snapshot'
    && context.episode.repoSnapshotId
    && (candidate.repoSnapshotId !== context.episode.repoSnapshotId
      || candidate.scopeKey !== context.episode.repoSnapshotId)) {
    codes.push('scope_snapshot_mismatch')
  }
  if (candidate.scopeKind === 'branch'
    && context.episode.branch
    && (candidate.branch !== context.episode.branch
      || candidate.scopeKey !== context.episode.branch)) {
    codes.push('scope_branch_mismatch')
  }
  if (candidate.scopeKind === 'task' && candidate.scopeKey !== context.episode.turnId) {
    codes.push('scope_task_mismatch')
  }
  if (candidate.scopeKind === 'installation' && candidate.scopeKey !== 'global') codes.push('scope_installation_mismatch')
  if (candidate.scopeKind !== 'repository' && candidate.repositoryId
    && candidate.repositoryId !== context.episode.repositoryId) codes.push('scope_repository_mismatch')
  if (candidate.scopeKind !== 'snapshot' && candidate.repoSnapshotId
    && candidate.repoSnapshotId !== context.episode.repoSnapshotId) codes.push('scope_snapshot_mismatch')
  if (candidate.scopeKind !== 'branch' && candidate.branch
    && candidate.branch !== context.episode.branch) codes.push('scope_branch_mismatch')

  // Expired applicability is dead on arrival.
  if (candidate.validUntil && candidate.validUntil.getTime() <= context.now.getTime()) {
    codes.push('validity_window_past')
  }
  if (candidate.validFrom && candidate.validUntil && candidate.validFrom >= candidate.validUntil) {
    codes.push('validity_window_inverted')
  }

  // Privacy-deleted identities can never come back.
  if (context.tombstonedKeys.has(candidate.normalizedKey)) {
    codes.push('tombstoned_identity')
  }

  if (isEphemeralVersionControlEvent(candidate.statement)) {
    codes.push('ephemeral_vcs_operation')
  }

  if (codes.length > 0) return reject(codes.slice(0, 8))

  // Duplicate / conflict classification against the active family — never a
  // mutation of the existing claim.
  // Exact identity wins irrespective of family order. Near matches remain
  // reviewable conflicts: lexical overlap cannot distinguish negation or a
  // changed condition, particularly in code and Chinese text.
  const identity = normalizedClaimKey({ claimType: candidate.claimType, scopeKey: candidate.scopeKey, statement: candidate.statement })
  const exact = context.activeFamily.find(active => normalizedClaimKey({
    claimType: candidate.claimType, scopeKey: candidate.scopeKey, statement: active.statement,
  }) === identity)
  if (exact) return {
    status: 'duplicate', duplicateOfClaimId: exact.claimId,
    validation: { codes: ['exact_duplicate'] },
  }
  let best: { claimId: string; similarity: number } | undefined
  for (const active of context.activeFamily) {
    const similarity = tokenSimilarity(candidate.statement, active.statement)
    if (similarity >= CONFLICT_THRESHOLD && (!best || similarity > best.similarity)) {
      best = { claimId: active.claimId, similarity }
    }
  }
  if (best) return {
    status: 'conflict', duplicateOfClaimId: best.claimId,
    validation: { codes: [`possible_conflict:${best.similarity.toFixed(2)}`] },
  }

  return { status: 'validated', validation: { codes: [] } }
}
