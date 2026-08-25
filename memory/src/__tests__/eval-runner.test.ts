import { describe, expect, test } from 'vitest'
import { GoldenDatasetSchema } from '../eval/schema.js'
import { isScopeLeak, isValidExpectedHit, percentileOf } from '../eval/runner.js'

const SYNTHETIC = {
  schema_version: 1 as const,
  dataset_version: 'synthetic-v1',
  created_at: '2026-08-25T00:00:00Z',
  cases: [
    {
      id: 'case-login-flake',
      schema_version: 1 as const,
      query: 'login flake root cause clock skew',
      installation_id: '11111111-1111-4111-8111-111111111111',
      allowed: { repository_ids: [], repo_snapshot_ids: [], branches: [] },
      expected: {
        claim_ids: ['22222222-2222-4222-8222-222222222222'],
        evidence_claim_ids: ['22222222-2222-4222-8222-222222222222'],
      },
      review_outcome: 'accepted_as_is' as const,
    },
    {
      id: 'case-vitest-convention',
      schema_version: 1 as const,
      query: 'where do vitest files live',
      installation_id: '11111111-1111-4111-8111-111111111111',
      allowed: { repository_ids: [], repo_snapshot_ids: [], branches: [] },
      expected: { claim_ids: [], evidence_claim_ids: [] },
      review_outcome: 'light_edit' as const,
    },
  ],
}

describe('golden dataset schema', () => {
  test('parses the versioned JSONL-record shape strictly', () => {
    const parsed = GoldenDatasetSchema.safeParse(SYNTHETIC)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.cases.length).toBe(2)
    expect(parsed.data.cases[0].review_outcome).toBe('accepted_as_is')
  })

  test('rejects unknown keys and non-uuid installations', () => {
    expect(GoldenDatasetSchema.safeParse({
      ...SYNTHETIC,
      cases: [{ ...SYNTHETIC.cases[0], extra: 1 }],
    }).success).toBe(false)
    expect(GoldenDatasetSchema.safeParse({
      ...SYNTHETIC,
      cases: [{ ...SYNTHETIC.cases[0], installation_id: 'not-a-uuid' }],
    }).success).toBe(false)
  })
})

describe('eval percentile helper', () => {
  test('median and p95 over sorted latencies', () => {
    expect(percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(6)
    expect(percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10)
    expect(percentileOf([], 0.5)).toBe(0)
  })
})

describe('eval scope leakage', () => {
  test('a missing scope value leaks from a constrained case', () => {
    expect(isScopeLeak(
      { repositoryId: null, repoSnapshotId: null, branch: null },
      {
        repository_ids: ['11111111-1111-4111-8111-111111111111'],
        repo_snapshot_ids: [],
        branches: [],
      },
    )).toBe(true)
  })

  test('an expected claim outside the allowed scope is not a valid Top-5 hit', () => {
    expect(isValidExpectedHit({
      claimId: '22222222-2222-4222-8222-222222222222',
      repositoryId: null, repoSnapshotId: null, branch: null,
    }, SYNTHETIC.cases[0])).toBe(true)
    expect(isValidExpectedHit({
      claimId: '22222222-2222-4222-8222-222222222222',
      repositoryId: null, repoSnapshotId: null, branch: null,
    }, {
      ...SYNTHETIC.cases[0],
      allowed: {
        repository_ids: ['33333333-3333-4333-8333-333333333333'],
        repo_snapshot_ids: [], branches: [],
      },
    })).toBe(false)
  })
})
