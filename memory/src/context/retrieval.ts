import type pg from 'pg'
import type { SearchService, SearchHit } from '../retrieval/search-service.js'
import { fuseRanks } from '../retrieval/rrf.js'
import type {
  TrajectoryRepository,
  TrajectoryCandidateInput,
  TrajectoryStageInput,
} from './trajectory-repository.js'
import {
  SYSTEM_RANKING_POLICY_V1,
  type RankingPolicyDocument,
} from '../policies/schemas.js'

/**
 * Replayable context retrieval (plan 7.3/6.3): reuses the Phase 1 search
 * pools verbatim (metadata/lexical/vector with deterministic degradation),
 * then applies the frozen Ranking Policy V1 ordering on top and records a
 * content-free Retrieval Trajectory. `retrieval_failed` is distinct from
 * `empty`; the query text never leaves this call except into the pools.
 */

export interface ContextRankingWeights {
  relevance: number
  authority: number
  freshness: number
  scope: number
  loadout: number
}

export const DEFAULT_CONTEXT_RANKING_WEIGHTS: ContextRankingWeights = {
  relevance: 0.5,
  authority: 0.2,
  freshness: 0.2,
  scope: 0.1,
  loadout: 0.1,
}

export interface ContextRetrievalCandidate {
  versionId: string
  claimId: string
  claimType: string
  statement: string
  scopeKind: string
  scopeKey: string
  authority: string
  repositoryId: string | null
  branch: string | null
  fusedScore: number
  finalOrdinal: number
  reasonCodes: string[]
  freshnessAt?: Date | null
  sourcePools?: string[]
}

export interface ContextRetrievalResult {
  outcome: 'completed' | 'empty' | 'degraded' | 'retrieval_failed'
  degradedComponents: string[]
  candidates: ContextRetrievalCandidate[]
  trajectoryId: string
}

const SCOPE_SPECIFICITY: Record<string, number> = {
  task: 4,
  snapshot: 3,
  branch: 3,
  repository: 2,
  installation: 1,
}

export function createContextRetrieval(deps: {
  pool: pg.Pool
  search: SearchService
  trajectory: TrajectoryRepository
}) {
  return {
    async retrieve(input: {
      installationId: string
      query: string
      repositoryId?: string | null
      branch?: string | null
      limit?: number
      claimTypes?: readonly string[] | null
      pinnedVersionIds?: readonly string[]
      requestKey: { keyId: string; hmacKey: Buffer }
      rankingPolicyVersionId?: string | null
      rankingPolicy?: RankingPolicyDocument
    }): Promise<ContextRetrievalResult> {
      const limit = input.limit ?? 10
      const rankingPolicy = input.rankingPolicy ?? SYSTEM_RANKING_POLICY_V1
      const weights = rankingPolicy.weights
      const stages: TrajectoryStageInput[] = []
      const started = Date.now()

      let hits: SearchHit[]
      let degradedComponents: string[]
      let failed = false
      try {
        const searched = await deps.search.search({
          installationId: input.installationId,
          query: input.query,
          repositoryId: input.repositoryId ?? null,
          branch: input.branch ?? null,
          claimTypes: input.claimTypes ?? null,
          limit: 50,
        })
        hits = searched.hits
        degradedComponents = searched.degradedComponents
        stages.push(
          { stage: 'pools', outcome: 'ok', candidateCount: hits.length, durationMs: Date.now() - started,
            degradedReason: degradedComponents.length > 0 ? degradedComponents.join('|') : null },
          // Phase 2 ships flat comparison; hierarchical navigation is a
          // later optional narrowing that must co-record a flat sample.
          { stage: 'hierarchy', outcome: 'flat_comparison_recorded', candidateCount: hits.length, durationMs: 0, degradedReason: null },
        )
      } catch {
        failed = true
        hits = []
        degradedComponents = ['retrieval']
        stages.push({ stage: 'pools', outcome: 'error', candidateCount: 0,
          durationMs: Date.now() - started, degradedReason: 'retrieval_failed' })
      }

      const byVersion = new Map(hits.map(hit => [hit.versionId, hit]))
      const metadataPool = hits
        .filter(hit => hit.sources.includes('metadata'))
        .map(hit => hit.versionId)
      const lexicalPool = hits
        .filter(hit => hit.sources.includes('lexical'))
        .map(hit => hit.versionId)
      const vectorPool = hits
        .filter(hit => hit.sources.includes('vector'))
        .map(hit => hit.versionId)
      const rankOf = (pool: string[]) => new Map(pool.map((id, index) => [id, index + 1]))
      const metadataRank = rankOf(metadataPool)
      const lexicalRank = rankOf(lexicalPool)
      const vectorRank = rankOf(vectorPool)

      const fused = fuseRanks([
        { name: 'metadata', ranked: metadataPool },
        { name: 'lexical', ranked: lexicalPool },
        { name: 'vector', ranked: vectorPool },
      ], 200)

      const pinned = new Set(input.pinnedVersionIds ?? [])
      const scored = fused.map(entry => {
        const hit = byVersion.get(entry.versionId)!
        const authorityScore = hit.authority === 'user_corrected'
          ? 1 : hit.authority === 'user_accepted' ? 0.5 : 0
        const ageDays = hit.freshnessAt
          ? Math.max(0, (Date.now() - hit.freshnessAt.getTime()) / 86_400_000)
          : 3650
        const freshnessScore = Math.max(0, 1 - ageDays / 365)
        const scopeScore = (SCOPE_SPECIFICITY[hit.scopeKind] ?? 0) / 4
        const loadoutScore = pinned.has(entry.versionId) ? 1 : 0
        const relevanceAdmitted = loadoutScore > 0
          || hit.sources.includes('lexical')
          || (hit.vectorSimilarity ?? -1) >= rankingPolicy.admission.minimum_vector_similarity
        const relevanceScore = entry.score > 0 ? Math.min(1, entry.score * 60) : 0
        const composite =
          weights.relevance * relevanceScore
          + weights.authority * authorityScore
          + weights.freshness * freshnessScore
          + weights.scope * scopeScore
          + weights.loadout * loadoutScore
        return {
          entry,
          hit,
          authorityScore,
          freshnessScore,
          scopeScore,
          loadoutScore,
          relevanceAdmitted,
          composite,
        }
      })

      // Frozen order (plan 6.3): authorization/scope already filtered by the
      // pools; then authority, fused relevance, freshness, loadout bonus
      // (capped below any hard filter), stable version_id tie-break.
      scored.sort((a, b) =>
        b.composite - a.composite
        || b.authorityScore - a.authorityScore
        || b.entry.score - a.entry.score
        || (a.entry.versionId < b.entry.versionId ? -1 : 1))

      // More-specific scope shadows the same normalized statement from a
      // general scope even when relevance scoring placed the general row
      // first. Shadowing is an applicability rule, not a ranking bonus.
      const statementKey = (statement: string) => statement.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
      const maxSpecificity = new Map<string, number>()
      for (const item of scored) {
        if (!item.relevanceAdmitted) continue
        const key = statementKey(item.hit.statement)
        maxSpecificity.set(key, Math.max(
          maxSpecificity.get(key) ?? 0,
          SCOPE_SPECIFICITY[item.hit.scopeKind] ?? 0,
        ))
      }
      const candidates: ContextRetrievalCandidate[] = []
      const trajectoryCandidates: TrajectoryCandidateInput[] = []
      for (const item of scored) {
        if (!item.relevanceAdmitted) {
          trajectoryCandidates.push({
            versionId: item.entry.versionId,
            metadataRank: metadataRank.get(item.entry.versionId) ?? null,
            lexicalRank: lexicalRank.get(item.entry.versionId) ?? null,
            vectorRank: vectorRank.get(item.entry.versionId) ?? null,
            fusedScore: item.composite,
            authorityScore: item.authorityScore,
            freshnessScore: item.freshnessScore,
            scopeScore: item.scopeScore,
            loadoutScore: item.loadoutScore,
            estimatedTokens: Math.ceil(item.hit.statement.length / 4),
            decision: 'dropped',
            reasonCode: 'relevance_below_threshold',
            finalOrdinal: null,
          })
          continue
        }
        const specificity = SCOPE_SPECIFICITY[item.hit.scopeKind] ?? 0
        if (specificity < (maxSpecificity.get(statementKey(item.hit.statement)) ?? 0)) {
          trajectoryCandidates.push({
            versionId: item.entry.versionId,
            metadataRank: metadataRank.get(item.entry.versionId) ?? null,
            lexicalRank: lexicalRank.get(item.entry.versionId) ?? null,
            vectorRank: vectorRank.get(item.entry.versionId) ?? null,
            fusedScore: item.composite,
            authorityScore: item.authorityScore,
            freshnessScore: item.freshnessScore,
            scopeScore: item.scopeScore,
            loadoutScore: item.loadoutScore,
            estimatedTokens: Math.ceil(item.hit.statement.length / 4),
            decision: 'dropped',
            reasonCode: 'scope_shadowed',
            finalOrdinal: null,
          })
          continue
        }
        const reasonCodes: string[] = ['ranked']
        if (item.loadoutScore > 0) reasonCodes.push('loadout_pinned')
        if (candidates.length < limit) {
          candidates.push({
            versionId: item.entry.versionId,
            claimId: item.hit.claimId,
            claimType: item.hit.claimType,
            statement: item.hit.statement,
            scopeKind: item.hit.scopeKind,
            scopeKey: item.hit.scopeKey,
            authority: item.hit.authority,
            repositoryId: item.hit.repositoryId,
            branch: item.hit.branch,
            fusedScore: item.composite,
            finalOrdinal: candidates.length,
            reasonCodes,
            freshnessAt: item.hit.freshnessAt,
            sourcePools: [...item.hit.sources],
          })
          trajectoryCandidates.push({
            versionId: item.entry.versionId,
            metadataRank: metadataRank.get(item.entry.versionId) ?? null,
            lexicalRank: lexicalRank.get(item.entry.versionId) ?? null,
            vectorRank: vectorRank.get(item.entry.versionId) ?? null,
            fusedScore: item.composite,
            authorityScore: item.authorityScore,
            freshnessScore: item.freshnessScore,
            scopeScore: item.scopeScore,
            loadoutScore: item.loadoutScore,
            estimatedTokens: Math.ceil(item.hit.statement.length / 4),
            decision: 'selected',
            reasonCode: reasonCodes.join('|'),
            finalOrdinal: candidates.length - 1,
          })
        } else {
          trajectoryCandidates.push({
            versionId: item.entry.versionId,
            metadataRank: metadataRank.get(item.entry.versionId) ?? null,
            lexicalRank: lexicalRank.get(item.entry.versionId) ?? null,
            vectorRank: vectorRank.get(item.entry.versionId) ?? null,
            fusedScore: item.composite,
            authorityScore: item.authorityScore,
            freshnessScore: item.freshnessScore,
            scopeScore: item.scopeScore,
            loadoutScore: item.loadoutScore,
            estimatedTokens: Math.ceil(item.hit.statement.length / 4),
            decision: 'dropped',
            reasonCode: 'beyond_limit',
            finalOrdinal: null,
          })
        }
      }

      const outcome: ContextRetrievalResult['outcome'] = failed
        ? 'retrieval_failed'
        : candidates.length === 0 ? 'empty'
        : degradedComponents.length > 0 ? 'degraded'
        : 'completed'

      const trajectoryId = await deps.trajectory.record({
        installationId: input.installationId,
        requestKey: input.requestKey,
        query: input.query,
        repositoryId: input.repositoryId ?? null,
        branch: input.branch ?? null,
        rankingPolicyVersionId: input.rankingPolicyVersionId ?? null,
        backendPlan: {
          pools: ['metadata', 'lexical', ...(degradedComponents.includes('embedding') ? [] : ['vector'])],
          degraded: degradedComponents,
          limit,
          admission: rankingPolicy.admission,
        },
        resultState: outcome,
        degradedComponents,
        stages,
        candidates: trajectoryCandidates,
      })

      return { outcome, degradedComponents, candidates, trajectoryId }
    },
  }
}

export type ContextRetrieval = ReturnType<typeof createContextRetrieval>
