import type pg from 'pg'
import { createSearchService, type SearchHit } from '../retrieval/search-service.js'
import type { GoldenCase, GoldenDataset } from './schema.js'
import type { EmbeddingProvider } from '../ports/embedding-provider.js'

/**
 * Deterministic Golden Set evaluator. Runs each case's query through the SAME
 * search service as REST/MCP with the case's allowed scope, then scores
 * Top-5 valid hits, evidence coverage, scope leakage, duplicate active
 * claims, latency and empty-result behavior. Output carries opaque ids and
 * aggregate metrics only — never raw private text.
 */

export interface EvalCaseResult {
  id: string
  top5ValidHit: boolean
  expectedClaimFoundAtRank: number | null
  evidenceCoverage: number
  scopeLeak: boolean
  duplicateActiveClaims: number
  latencyMs: number
  emptyResult: boolean
  degradedComponents: string[]
}

export interface EvalReport {
  datasetVersion: string
  runAt: string
  totalCases: number
  top5EvaluatedCases: number
  top5HitRate: number
  evidenceCoverageRate: number
  scopeLeakCount: number
  duplicateClaimCases: number
  emptyResultCases: number
  medianLatencyMs: number
  p95LatencyMs: number
  degradedCases: number
  reviewOutcomes: Record<string, number>
  cases: EvalCaseResult[]
}

export interface EvalRunnerDeps {
  pool: pg.Pool
  recallEmbeddingTimeoutMs?: number
  cursorSigningKey: string
  embed?: EmbeddingProvider & { provider: string; model: string }
  embeddingConsentFingerprint?: string
  now?: () => number
}

export function createEvalRunner(deps: EvalRunnerDeps) {
  const search = createSearchService({
    pool: deps.pool,
    recallEmbeddingTimeoutMs: deps.recallEmbeddingTimeoutMs ?? 500,
    cursorSigningKey: deps.cursorSigningKey,
    ...(deps.embed ? { embed: deps.embed } : {}),
    ...(deps.embeddingConsentFingerprint
      ? { embeddingConsentFingerprint: deps.embeddingConsentFingerprint }
      : {}),
  })

  return {
    async run(dataset: GoldenDataset, limit = 5): Promise<EvalReport> {
      const caseResults: EvalCaseResult[] = []
      const reviewOutcomes: Record<string, number> = {}
      for (const item of dataset.cases) {
        caseResults.push(await runCase(search, deps, item, limit))
        if (item.review_outcome) {
          reviewOutcomes[item.review_outcome] = (reviewOutcomes[item.review_outcome] ?? 0) + 1
        }
      }
      const latencies = caseResults.map(result => result.latencyMs).sort((a, b) => a - b)
      const positiveCaseResults = caseResults.filter((_, index) =>
        dataset.cases[index].expected.claim_ids.length > 0)
      const hit = positiveCaseResults.filter(result => result.top5ValidHit).length
      const covered = caseResults.map(result => result.evidenceCoverage)
      return {
        datasetVersion: dataset.dataset_version,
        runAt: new Date().toISOString(),
        totalCases: caseResults.length,
        top5EvaluatedCases: positiveCaseResults.length,
        top5HitRate: positiveCaseResults.length > 0 ? hit / positiveCaseResults.length : 0,
        evidenceCoverageRate: covered.length > 0
          ? covered.reduce((sum, value) => sum + value, 0) / covered.length
          : 0,
        scopeLeakCount: caseResults.filter(result => result.scopeLeak).length,
        duplicateClaimCases: caseResults.filter(result => result.duplicateActiveClaims > 0).length,
        emptyResultCases: caseResults.filter(result => result.emptyResult).length,
        medianLatencyMs: percentile(latencies, 0.5),
        p95LatencyMs: percentile(latencies, 0.95),
        degradedCases: caseResults.filter(result => result.degradedComponents.length > 0).length,
        reviewOutcomes,
        cases: caseResults,
      }
    },
  }
}

async function runCase(
  search: ReturnType<typeof createSearchService>,
  deps: EvalRunnerDeps,
  item: GoldenCase,
  limit: number,
): Promise<EvalCaseResult> {
  const started = deps.now?.() ?? Date.now()
  const result = await searchAllowedScopes(search, item, limit)
  const latencyMs = (deps.now?.() ?? Date.now()) - started

  const ranks = result.hits
    .map((hit, index) => ({ hit, rank: index + 1 }))
    .filter(entry => isValidExpectedHit(entry.hit, item))
  const bestRank = ranks.length > 0 ? Math.min(...ranks.map(entry => entry.rank)) : null

  // Gate coverage against every active current Version in the installation,
  // not only claims that happened to appear in this query's result set.
  const coverage = await deps.pool.query<{ total: string; covered: string }>(`
    WITH target_claims AS (
      SELECT claim_id
      FROM knowledge_claims
      WHERE installation_id = $1 AND state = 'active'
        AND current_version_id IS NOT NULL
      UNION
      SELECT unnest($2::uuid[]) AS claim_id
    )
    SELECT COUNT(*)::text AS total,
           COUNT(*) FILTER (
             WHERE c.state = 'active' AND c.current_version_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM knowledge_evidence e
                 WHERE e.installation_id = c.installation_id
                   AND e.version_id = c.current_version_id
               )
           )::text AS covered
    FROM target_claims t
    LEFT JOIN knowledge_claims c
      ON c.installation_id = $1 AND c.claim_id = t.claim_id
  `, [item.installation_id, item.expected.evidence_claim_ids])
  const totalRequired = Number(coverage.rows[0]?.total ?? '0')
  const coveredRequired = Number(coverage.rows[0]?.covered ?? '0')

  // Scope leakage: any hit outside the case's allowed repository/snapshot/
  // branch sets (when the case constrains them).
  const scopeLeak = result.hits.some(hit => isScopeLeak(hit, item.allowed))

  // Duplicate active claims sharing an identical normalized identity.
  const duplicates = await deps.pool.query<{ count: string }>(`
          SELECT COUNT(*)::text AS count FROM (
          SELECT claim_type, scope_key, normalized_key
          FROM knowledge_claims
          WHERE installation_id = $1 AND state = 'active'
          GROUP BY claim_type, scope_key, normalized_key HAVING COUNT(*) > 1
        ) d
      `, [item.installation_id])

  return {
    id: item.id,
    top5ValidHit: item.expected.claim_ids.length > 0
      ? bestRank !== null
      : result.hits.length === 0,
    expectedClaimFoundAtRank: bestRank,
    evidenceCoverage: totalRequired > 0 ? coveredRequired / totalRequired : 1,
    scopeLeak,
    duplicateActiveClaims: Number(duplicates.rows[0]?.count ?? '0'),
    latencyMs,
    emptyResult: result.hits.length === 0,
    degradedComponents: result.degradedComponents,
  }
}

async function searchAllowedScopes(
  search: ReturnType<typeof createSearchService>,
  item: GoldenCase,
  limit: number,
): Promise<{ hits: SearchHit[]; degradedComponents: string[] }> {
  const repositoryIds: Array<string | undefined> = item.allowed.repository_ids.length > 0
    ? [...new Set(item.allowed.repository_ids)]
    : [undefined]
  const snapshotIds: Array<string | undefined> = item.allowed.repo_snapshot_ids.length > 0
    ? [...new Set(item.allowed.repo_snapshot_ids)]
    : [undefined]
  const branches: Array<string | undefined> = item.allowed.branches.length > 0
    ? [...new Set(item.allowed.branches)]
    : [undefined]
  const accumulated = new Map<string, { hit: SearchHit; score: number }>()
  const degraded = new Set<string>()

  for (const repositoryId of repositoryIds) {
    for (const repoSnapshotId of snapshotIds) {
      for (const branch of branches) {
        const result = await search.search({
          installationId: item.installation_id,
          query: item.query,
          limit,
          ...(repositoryId ? { repositoryId } : {}),
          ...(repoSnapshotId ? { repoSnapshotId } : {}),
          ...(branch ? { branch } : {}),
        })
        for (const component of result.degradedComponents) degraded.add(component)
        for (const [index, hit] of result.hits.entries()) {
          const score = 1 / (60 + index + 1)
          const previous = accumulated.get(hit.versionId)
          if (previous) previous.score += score
          else accumulated.set(hit.versionId, { hit, score })
        }
      }
    }
  }

  return {
    hits: [...accumulated.values()]
      .sort((a, b) => b.score - a.score || (a.hit.versionId < b.hit.versionId ? -1 : 1))
      .slice(0, limit)
      .map(entry => entry.hit),
    degradedComponents: [...degraded].sort(),
  }
}

export function isScopeLeak(
  hit: { repositoryId: string | null; repoSnapshotId: string | null; branch: string | null },
  allowed: { repository_ids: readonly string[]; repo_snapshot_ids: readonly string[]; branches: readonly string[] },
): boolean {
  const repositorySet = new Set(allowed.repository_ids)
  const snapshotSet = new Set(allowed.repo_snapshot_ids)
  const branchSet = new Set(allowed.branches)
  if (repositorySet.size > 0 && (!hit.repositoryId || !repositorySet.has(hit.repositoryId))) return true
  if (snapshotSet.size > 0 && (!hit.repoSnapshotId || !snapshotSet.has(hit.repoSnapshotId))) return true
  if (branchSet.size > 0 && (!hit.branch || !branchSet.has(hit.branch))) return true
  return false
}

export function isValidExpectedHit(
  hit: { claimId: string; repositoryId: string | null; repoSnapshotId: string | null; branch: string | null },
  item: Pick<GoldenCase, 'expected' | 'allowed'>,
): boolean {
  return item.expected.claim_ids.includes(hit.claimId) && !isScopeLeak(hit, item.allowed)
}

/** Test-visible percentile helper (median/p95 over sorted values). */
export function percentileOf(sorted: number[], fraction: number): number {
  return percentile(sorted, fraction)
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  return sorted[index]
}
