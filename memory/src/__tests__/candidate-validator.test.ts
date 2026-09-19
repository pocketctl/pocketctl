import { describe, expect, test } from 'vitest'
import { validateCandidate, type ValidationContext } from '../extraction/validator.js'
import { SYSTEM_EXTRACTION_POLICY_V1 } from '../policies/schemas.js'
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
  test('CJK antonyms are not discarded as duplicates', () => {
    const verdict = validateCandidate(candidate({ statement: 'Memory 应关闭缓存' }), context({
      activeFamily: [{ claimId: 'opposite', statement: 'Memory 应开启缓存' }],
    }))
    expect(verdict.status).toBe('conflict')
    expect(tokenSimilarity('Memory 应关闭缓存', 'Memory 应开启缓存')).toBeLessThan(1)
    expect(tokenSimilarity('应开启缓存', '应开启缓存')).toBe(1)
  })

  test('an exact match wins over earlier weaker family matches', () => {
    expect(validateCandidate(candidate(), context({ activeFamily: [
      { claimId: 'weaker', statement: 'Vitest files live next to sources and cover every module' },
      { claimId: 'exact', statement: candidate().statement },
    ] }))).toMatchObject({ status: 'duplicate', duplicateOfClaimId: 'exact' })
  })

  test('policy counts independent sources, not multiple handles for the same event', () => {
    const verdict = validateCandidate(candidate({ evidenceHandles: [...HANDLES] }), context({
      policy: { ...SYSTEM_EXTRACTION_POLICY_V1, evidence: { min_items: 2, require_terminal_outcome: true, require_distinct_turns: 2 } },
      evidenceSourceKeys: new Map([...HANDLES].map(handle => [handle, 'same-event'])),
    }))
    expect(verdict.validation.codes).toEqual(expect.arrayContaining([
      'policy_evidence_min_items', 'policy_terminal_outcome_required', 'policy_distinct_turns_unavailable',
    ]))
  })

  test('value thresholds are independent of confidence and fail closed without assessments', () => {
    const ctx = context({ policy: { ...SYSTEM_EXTRACTION_POLICY_V1,
      value_filter: { min_utility: 0.8, min_repeatability: 0.8, max_friction: 0.2 },
    } })
    expect(validateCandidate(candidate(), ctx).validation.codes).toContain('policy_value_assessment_required')
    expect(validateCandidate(candidate({ valueAssessment: { utility: 0.4, repeatability: 0.5, friction: 0.9 } }), ctx)
      .validation.codes).toEqual(expect.arrayContaining(['policy_utility_below_minimum', 'policy_repeatability_below_minimum', 'policy_friction_above_maximum']))
    expect(validateCandidate(candidate({ valueAssessment: { utility: 0.9, repeatability: 0.9, friction: 0.1 } }), ctx).status).toBe('validated')
  })

  test('task and installation scopes cannot attach invented repository metadata', () => {
    expect(validateCandidate(candidate({ scopeKind: 'task', scopeKey: 'turn-1', repositoryId: 'unknown' }), context()).validation.codes)
      .toContain('scope_repository_mismatch')
    expect(validateCandidate(candidate({ scopeKey: 'not-global' }), context()).status).toBe('rejected_by_validator')
  })

  test('a clean candidate validates', () => {
    const verdict = validateCandidate(candidate(), context())
    expect(verdict).toMatchObject({ status: 'validated' })
  })

  test.each([
    '代码已提交为 5fd4c4c9，并推送到 develop 后合并到 master，本次跳过 tag。',
    'Committed 5fd4c4c9, pushed develop, and successfully merged it into master without a tag.',
    '当前工作区 clean，分支已推送。',
  ])('rejects routine version-control audit events: %s', statement => {
    const verdict = validateCandidate(candidate({ statement }), context())
    expect(verdict).toMatchObject({
      status: 'rejected_by_validator',
      validation: { codes: expect.arrayContaining(['ephemeral_vcs_operation']) },
    })
  })

  test.each([
    ['repository_convention', '发布必须先将 develop 合并到 master，并且只有发布构建通过后才能创建 tag。'],
    ['operational_runbook', 'When a git push fails because the remote is not a fast-forward, fetch and rebase before retrying.'],
    ['bug_root_cause', '合并失败的根因是远端 master 已包含本地缺失的提交，rebase 后问题解决。'],
  ])('keeps durable version-control knowledge reviewable for %s', (claimType, statement) => {
    expect(validateCandidate(candidate({ claimType, statement }), context()).status).toBe('validated')
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

  test('near matches stay reviewable because lexical overlap does not establish equivalence', () => {
    const verdict = validateCandidate(candidate(), context({
      activeFamily: [{ claimId: 'claim-1', statement: 'Vitest files live next to the sources' }],
    }))
    expect(verdict).toMatchObject({ status: 'conflict', duplicateOfClaimId: 'claim-1' })
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
