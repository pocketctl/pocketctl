import { describe, expect, test, vi } from 'vitest'
import { createContextRetrieval } from '../context/retrieval.js'
import type { SearchHit } from '../retrieval/search-service.js'
import { SYSTEM_RANKING_POLICY_V1 } from '../policies/schemas.js'

const INSTALLATION = 'cdcdcdcd-cdcd-4ccd-8ccd-cdcdcdcdcdcd'

function hit(overrides: Partial<SearchHit> & Pick<SearchHit, 'versionId' | 'claimId' | 'scopeKind'>): SearchHit {
  return {
    ...overrides,
    versionId: overrides.versionId,
    claimId: overrides.claimId,
    claimType: 'test_invariant',
    statement: 'Run the focused gate first',
    scopeKind: overrides.scopeKind,
    scopeKey: overrides.scopeKind,
    freshnessAt: new Date(),
    authority: 'user_accepted',
    repositoryId: null,
    repoSnapshotId: null,
    branch: null,
    score: 1,
    sources: overrides.sources ?? ['metadata'],
    vectorSimilarity: overrides.vectorSimilarity ?? null,
  }
}

describe('context retrieval scope shadowing', () => {
  test('a more-specific duplicate statement shadows a higher-scored installation claim', async () => {
    const search = {
      search: vi.fn(async () => ({
        hits: [
          hit({ versionId: 'v-general', claimId: 'c-general', scopeKind: 'installation', score: 10,
            sources: ['lexical'] }),
          hit({ versionId: 'v-task', claimId: 'c-task', scopeKind: 'task', score: 0.1,
            statement: '  run   the focused GATE first  ', sources: ['lexical'] }),
        ],
        nextCursor: null, degradedComponents: [], poolSizes: {},
      })),
    }
    const trajectory = { record: vi.fn(async () => 'traj-1') }
    const retrieval = createContextRetrieval({ pool: {} as never, search: search as never, trajectory: trajectory as never })

    const result = await retrieval.retrieve({
      installationId: INSTALLATION,
      query: 'gate',
      requestKey: { keyId: 'k', hmacKey: Buffer.alloc(32, 1) },
    })

    expect(result.candidates.map(candidate => candidate.versionId)).toEqual(['v-task'])
    expect(trajectory.record).toHaveBeenCalledWith(expect.objectContaining({
      candidates: expect.arrayContaining([
        expect.objectContaining({ versionId: 'v-general', decision: 'dropped', reasonCode: 'scope_shadowed' }),
      ]),
    }))
  })

  test('drops weak metadata/vector recall before authority and freshness can promote it', async () => {
    const search = {
      search: vi.fn(async () => ({
        hits: [
          hit({
            versionId: 'v-weak', claimId: 'c-weak', scopeKind: 'repository',
            authority: 'user_corrected', sources: ['metadata', 'vector'],
            vectorSimilarity: SYSTEM_RANKING_POLICY_V1.admission.minimum_vector_similarity - 0.01,
          }),
        ],
        nextCursor: null, degradedComponents: [], poolSizes: {},
      })),
    }
    const trajectory = { record: vi.fn(async () => 'traj-weak') }
    const retrieval = createContextRetrieval({ pool: {} as never, search: search as never, trajectory: trajectory as never })

    const result = await retrieval.retrieve({
      installationId: INSTALLATION,
      query: 'a different engineering concern',
      requestKey: { keyId: 'k', hmacKey: Buffer.alloc(32, 1) },
      rankingPolicy: SYSTEM_RANKING_POLICY_V1,
    })

    expect(result).toMatchObject({ outcome: 'empty', candidates: [] })
    expect(trajectory.record).toHaveBeenCalledWith(expect.objectContaining({
      backendPlan: expect.objectContaining({
        admission: SYSTEM_RANKING_POLICY_V1.admission,
      }),
      candidates: [expect.objectContaining({
        versionId: 'v-weak', decision: 'dropped', reasonCode: 'relevance_below_threshold',
      })],
    }))
  })

  test('keeps lexical recall and vector-only recall at the policy threshold', async () => {
    const search = {
      search: vi.fn(async () => ({
        hits: [
          hit({
            versionId: 'v-lexical', claimId: 'c-lexical', scopeKind: 'repository',
            sources: ['lexical'], vectorSimilarity: null,
          }),
          hit({
            versionId: 'v-vector', claimId: 'c-vector', scopeKind: 'repository',
            sources: ['vector'],
            vectorSimilarity: SYSTEM_RANKING_POLICY_V1.admission.minimum_vector_similarity,
          }),
        ],
        nextCursor: null, degradedComponents: [], poolSizes: {},
      })),
    }
    const trajectory = { record: vi.fn(async () => 'traj-strong') }
    const retrieval = createContextRetrieval({ pool: {} as never, search: search as never, trajectory: trajectory as never })

    const result = await retrieval.retrieve({
      installationId: INSTALLATION,
      query: 'relevant fact',
      requestKey: { keyId: 'k', hmacKey: Buffer.alloc(32, 1) },
      rankingPolicy: SYSTEM_RANKING_POLICY_V1,
    })

    expect(result.outcome).toBe('completed')
    expect(result.candidates.map(candidate => candidate.versionId).sort())
      .toEqual(['v-lexical', 'v-vector'])
  })
})
