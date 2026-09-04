import { tokenSimilarity } from '../retrieval/query-normalizer.js'

/**
 * Deterministic candidate validation (plan §8.3 / Task 6). The validator runs
 * after the model proposes candidates: evidence must resolve inside the same
 * episode, scope must not exceed the episode's facts, tombstoned identities
 * stay dead, and duplicates/conflicts are classified without ever touching an
 * active claim. Reason codes are bounded strings only.
 */

export const NEAR_DUPLICATE_THRESHOLD = 0.85
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
  }
  now: Date
  /** Tombstoned identity keys (privacy-deleted) that must stay dead. */
  tombstonedKeys: ReadonlySet<string>
  /** Active claims in the same (claim_type, scope) family. */
  activeFamily: readonly ActiveClaimIdentity[]
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

  // Expired applicability is dead on arrival.
  if (candidate.validUntil && candidate.validUntil.getTime() <= context.now.getTime()) {
    codes.push('validity_window_past')
  }

  // Privacy-deleted identities can never come back.
  if (context.tombstonedKeys.has(candidate.normalizedKey)) {
    codes.push('tombstoned_identity')
  }

  if (codes.length > 0) return reject(codes.slice(0, 8))

  // Duplicate / conflict classification against the active family — never a
  // mutation of the existing claim.
  for (const active of context.activeFamily) {
    const similarity = tokenSimilarity(candidate.statement, active.statement)
    if (similarity >= NEAR_DUPLICATE_THRESHOLD) {
      return {
        status: 'duplicate',
        duplicateOfClaimId: active.claimId,
        validation: { codes: [`near_duplicate:${similarity.toFixed(2)}`] },
      }
    }
    if (similarity >= CONFLICT_THRESHOLD) {
      return {
        status: 'conflict',
        duplicateOfClaimId: active.claimId,
        validation: { codes: [`possible_conflict:${similarity.toFixed(2)}`] },
      }
    }
  }

  return { status: 'validated', validation: { codes: [] } }
}
