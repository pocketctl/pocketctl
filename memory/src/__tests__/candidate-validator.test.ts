import { describe, expect, test } from 'vitest'
import { validateCandidate, type ValidationContext } from '../extraction/validator.js'
import {
  caseInsensitiveClaimKey,
  normalizedClaimKey,
  tokenSimilarity,
  tokenize,
} from '../retrieval/query-normalizer.js'

const HANDLES = new Set(['h0-aaaaaaaa', 'h1-bbbbbbbb'])

function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    manifestHandles: HANDLES,
    episode: { turnId: 'turn-1', repositoryId: null, repoSnapshotId: null, branch: null },
    now: new Date('2026-08-25T00:00:00Z'),
    tombstonedKeys: new Set(),
    activeFamily: [],
    ...overrides,
  }
}

type CandidateOverrides = Partial<import('../extraction/validator.js').CandidateForValidation>

function candidate(overrides: CandidateOverrides = {}) {
  return {
    claimType: 'repository_convention',
    statement: 'Vitest files live next to sources',
    scopeKind: 'installation' as const,
    scopeKey: 'global',
    repositoryId: null,
    repoSnapshotId: null,
    branch: null,
    validUntil: null,
    evidenceHandles: ['h0-aaaaaaaa'],
    normalizedKey: normalizedClaimKey({
      claimType: 'repository_convention',
      scopeKey: 'global',
      statement: 'Vitest files live next to sources',
    }),
    ...overrides,
  }
}

describe('candidate validator', () => {
  test('a clean candidate validates', () => {
    const verdict = validateCandidate(candidate(), context())
    expect(verdict).toMatchObject({ status: 'validated' })
  })

  test('evidence handles must resolve inside the episode manifest', () => {
    const verdict = validateCandidate(
      candidate({ evidenceHandles: ['h0-aaaaaaaa', 'h9-ffffffff'] }),
      context(),
    )
    expect(verdict.status).toBe('rejected_by_validator')
    expect(verdict.validation.codes).toContain('evidence_unresolved')
  })

  test('evidence count must stay within 1..12', () => {
    const tooFew = validateCandidate(candidate({ evidenceHandles: [] }), context())
    expect(tooFew.status).toBe('rejected_by_validator')
    const tooMany = validateCandidate(
      candidate({ evidenceHandles: Array.from({ length: 13 }, () => 'h0-aaaaaaaa') }),
      context(),
    )
    expect(tooMany.status).toBe('rejected_by_validator')
  })

  test('scope may never exceed the episode facts', () => {
    const repositoryScoped = validateCandidate(
      candidate({ scopeKind: 'repository', scopeKey: 'repo-x' }),
      context(),
    )
    expect(repositoryScoped.validation).toMatchObject({ codes: ['scope_exceeds_episode_repository'] })

    const snapshotScoped = validateCandidate(
      candidate({ scopeKind: 'snapshot', scopeKey: 'snap-x' }),
      context(),
    )
    expect(snapshotScoped.validation).toMatchObject({ codes: ['scope_exceeds_episode_snapshot'] })

    const branchScoped = validateCandidate(candidate({ scopeKind: 'branch', scopeKey: 'main' }), context())
    expect(branchScoped.validation).toMatchObject({ codes: ['scope_exceeds_episode_branch'] })
    const inventedBranch = validateCandidate(
      candidate({ scopeKind: 'branch', scopeKey: 'invented', branch: 'invented' }),
      context(),
    )
    expect(inventedBranch.validation).toMatchObject({ codes: ['scope_exceeds_episode_branch'] })

    const branchWithFact = validateCandidate(
      candidate({ scopeKind: 'branch', scopeKey: 'main', branch: 'main' }),
      context({ episode: { turnId: 'turn-1', repositoryId: 'r1', repoSnapshotId: 's1', branch: 'main' } }),
    )
    expect(branchWithFact.status).toBe('validated')
  })

  test('a repository mismatch with the episode facts is rejected', () => {
    const verdict = validateCandidate(
      candidate({ scopeKind: 'repository', scopeKey: 'repo-x', repositoryId: 'r-other' }),
      context({ episode: { turnId: 'turn-1', repositoryId: 'r1', repoSnapshotId: null, branch: null } }),
    )
    expect(verdict.validation).toMatchObject({ codes: ['scope_repository_mismatch'] })
  })

  test('scope identifiers must exactly match the episode facts', () => {
    const episode = { turnId: 'turn-1', repositoryId: 'repo-1', repoSnapshotId: 'snap-1', branch: 'main' }
    expect(validateCandidate(candidate({
      scopeKind: 'repository', scopeKey: 'repo-2', repositoryId: 'repo-2',
    }), context({ episode })).status).toBe('rejected_by_validator')
    expect(validateCandidate(candidate({
      scopeKind: 'snapshot', scopeKey: 'snap-2', repoSnapshotId: 'snap-2',
    }), context({ episode })).status).toBe('rejected_by_validator')
    expect(validateCandidate(candidate({
      scopeKind: 'branch', scopeKey: 'dev', branch: 'dev',
    }), context({ episode })).status).toBe('rejected_by_validator')
    expect(validateCandidate(candidate({
      scopeKind: 'task', scopeKey: 'turn-2',
    }), context({ episode })).status).toBe('rejected_by_validator')
  })

  test('expired applicability windows are rejected', () => {
    const verdict = validateCandidate(
      candidate({ validUntil: new Date('2026-01-01T00:00:00Z') }),
      context(),
    )
    expect(verdict.validation).toMatchObject({ codes: ['validity_window_past'] })
  })

  test('tombstoned identities stay dead', () => {
    const key = normalizedClaimKey({
      claimType: 'repository_convention', scopeKey: 'global',
      statement: 'Vitest files live next to sources',
    })
    const verdict = validateCandidate(candidate(), context({ tombstonedKeys: new Set([key]) }))
    expect(verdict.status).toBe('rejected_by_validator')
    expect(verdict.validation).toMatchObject({ codes: ['tombstoned_identity'] })
  })

  test('near duplicates are marked duplicate and point at the active claim', () => {
    const verdict = validateCandidate(candidate(), context({
      activeFamily: [{ claimId: 'claim-1', statement: 'Vitest files live next to the sources' }],
    }))
    expect(verdict).toMatchObject({ status: 'duplicate', duplicateOfClaimId: 'claim-1' })
  })

  test('mid-band similarity becomes a conflict, never an automatic supersede', () => {
    const verdict = validateCandidate(
      candidate({ statement: 'Vitest test files live next to sources and cover every module' }),
      context({
        activeFamily: [{ claimId: 'claim-2', statement: 'Vitest files live next to sources' }],
      }),
    )
    expect(verdict).toMatchObject({ status: 'conflict', duplicateOfClaimId: 'claim-2' })
  })
})

describe('claim key normalization', () => {
  test('keys are deterministic and layout-insensitive', () => {
    const a = normalizedClaimKey({ claimType: 'work_method', scopeKey: 'global', statement: 'Always   write\ntests' })
    const b = normalizedClaimKey({ claimType: 'work_method', scopeKey: 'global', statement: 'Always write tests' })
    expect(a).toBe(b)
  })

  test('case-sensitive code identifiers survive tokenization', () => {
    const tokens = tokenize('verifyToken is not verifytoken')
    expect(tokens).toContain('verify')
    expect(tokens).toContain('Token')
    expect(tokenSimilarity('verifyToken', 'verifytoken')).toBeLessThan(1)
    expect(tokenSimilarity('verifyToken helper', 'verifyToken helper')).toBe(1)
  })

  test('case-insensitive keys fold natural language but not identity', () => {
    const upper = caseInsensitiveClaimKey({ claimType: 'c', scopeKey: 's', statement: 'Always Write Tests' })
    const lower = caseInsensitiveClaimKey({ claimType: 'c', scopeKey: 's', statement: 'always write tests' })
    expect(upper).toBe(lower)
  })

  test('long identities keep distinct suffixes without exceeding the column bound', () => {
    const prefix = 'same '.repeat(150)
    const first = normalizedClaimKey({ claimType: 'c', scopeKey: 's', statement: `${prefix}first` })
    const second = normalizedClaimKey({ claimType: 'c', scopeKey: 's', statement: `${prefix}second` })
    expect(first).not.toBe(second)
    expect(Array.from(first)).toHaveLength(512)
    expect(Array.from(second)).toHaveLength(512)
    expect(first).toMatch(/\|sha256:[0-9a-f]{64}$/)
  })

  test('long case-insensitive identities hash the folded text', () => {
    const upper = caseInsensitiveClaimKey({ claimType: 'c', scopeKey: 's', statement: `${'A'.repeat(600)} END` })
    const lower = caseInsensitiveClaimKey({ claimType: 'c', scopeKey: 's', statement: `${'a'.repeat(600)} end` })
    expect(upper).toBe(lower)
  })
})
