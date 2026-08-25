import { randomUUID } from 'crypto'
import type pg from 'pg'
import { createSearchService, type SearchInput, type SearchService } from './search-service.js'

/**
 * Deterministic recall bundles (plan §7.1): search picks the claims, then
 * bounded evidence, related episode metadata, conflicts and coverage gaps are
 * assembled without any model call. The response is character-bounded and
 * never contains a ready-to-inject hidden prompt.
 */

export interface RecallInput {
  installationId: string
  query: string
  repositoryId?: string | null
  repoSnapshotId?: string | null
  branch?: string | null
  claimTypes?: readonly string[] | null
  asOf?: Date | null
  maxClaims?: number
  maxEvidencePerClaim?: number
  maxChars?: number
}

export interface RecallEvidence {
  evidenceId: string
  evidenceKind: string
  episodeId: string
  excerpt: string
  occurredAt: Date
  truncated: boolean
}

export interface RecallClaim {
  claimId: string
  versionId: string
  claimType: string
  statement: string
  scopeKind: string
  scopeKey: string
  freshnessAt: Date | null
  authority: string
  evidence: RecallEvidence[]
}

export interface RecallEpisode {
  episodeId: string
  sessionId: string
  turnId: string
  outcome: string | null
  terminalAt: Date | null
}

export interface RecallResult {
  requestId: string
  degradedComponents: string[]
  claims: RecallClaim[]
  conflicts: Array<{ claimId: string; claimType: string; statementExcerpt: string }>
  relatedEpisodes: RecallEpisode[]
  coverageGaps: string[]
  totalChars: number
}

export function createRecallService(
  pool: pg.Pool,
  search: SearchService,
) {
  return {
    async recall(input: RecallInput): Promise<RecallResult> {
      const maxClaims = Math.min(Math.max(1, input.maxClaims ?? 5), 10)
      const maxEvidencePerClaim = Math.min(Math.max(1, input.maxEvidencePerClaim ?? 2), 5)
      const maxChars = Math.min(Math.max(1_000, input.maxChars ?? 8_000), 12_000)

      const searchInput: SearchInput = {
        installationId: input.installationId,
        query: input.query,
        repositoryId: input.repositoryId,
        repoSnapshotId: input.repoSnapshotId,
        branch: input.branch,
        claimTypes: input.claimTypes,
        asOf: input.asOf,
        limit: maxClaims,
      }
      const searched = await search.search(searchInput)

      const claims: RecallClaim[] = []
      const episodeIds = new Set<string>()
      let usedChars = 0
      for (const hit of searched.hits) {
        const evidenceRows = await pool.query<{
          evidence_id: string
          evidence_kind: string
          episode_id: string
          excerpt: string
          occurred_at: Date
        }>(`
          SELECT evidence_id::text, evidence_kind, episode_id::text, excerpt, occurred_at
          FROM knowledge_evidence
          WHERE installation_id = $1 AND version_id = $2
          ORDER BY ordinal
          LIMIT $3
        `, [input.installationId, hit.versionId, maxEvidencePerClaim])

        const evidence: RecallEvidence[] = []
        const statementBudget = Math.max(200, Math.floor(maxChars / maxClaims) - 400)
        const statement = hit.statement.length > statementBudget
          ? `${hit.statement.slice(0, statementBudget - 1)}…`
          : hit.statement
        usedChars += statement.length
        for (const row of evidenceRows.rows) {
          const remaining = maxChars - usedChars
          if (remaining <= 100) break
          const excerpt = row.excerpt.length > remaining
            ? `${row.excerpt.slice(0, remaining - 1)}…`
            : row.excerpt
          usedChars += excerpt.length
          evidence.push({
            evidenceId: row.evidence_id,
            evidenceKind: row.evidence_kind,
            episodeId: row.episode_id,
            excerpt,
            occurredAt: row.occurred_at,
            truncated: excerpt.length < row.excerpt.length,
          })
          episodeIds.add(row.episode_id)
        }
        claims.push({
          claimId: hit.claimId,
          versionId: hit.versionId,
          claimType: hit.claimType,
          statement,
          scopeKind: hit.scopeKind,
          scopeKey: hit.scopeKey,
          freshnessAt: hit.freshnessAt,
          authority: hit.authority,
          evidence,
        })
        if (usedChars >= maxChars) break
      }

      const episodes = episodeIds.size > 0
        ? await pool.query<{
          episode_id: string
          session_id: string
          turn_id: string
          outcome: string | null
          terminal_at: Date | null
        }>(`
          SELECT episode_id::text, session_id, turn_id, outcome, terminal_at
          FROM work_episodes
          WHERE installation_id = $1 AND episode_id = ANY($2::uuid[])
          ORDER BY terminal_at DESC NULLS LAST, episode_id
          LIMIT 10
        `, [input.installationId, [...episodeIds]])
        : { rows: [] as Array<{ episode_id: string; session_id: string; turn_id: string; outcome: string | null; terminal_at: Date | null }> }

      // Conflicts are deterministic validator outcomes explicitly linked to a
      // recalled active claim, never arbitrary claims that merely share a type.
      const conflicts: RecallResult['conflicts'] = []
      if (claims.length > 0) {
        const conflictRows = await pool.query<{
          claim_id: string
          claim_type: string
          statement: string
        }>(`
          SELECT candidate_id::text AS claim_id, claim_type, statement
          FROM memory_candidates
          WHERE installation_id = $1
            AND status = 'conflict'
            AND duplicate_of_claim_id = ANY($2::uuid[])
          ORDER BY candidate_id
          LIMIT 5
        `, [
          input.installationId,
          claims.map(claim => claim.claimId),
        ])
        for (const row of conflictRows.rows) {
          conflicts.push({
            claimId: row.claim_id,
            claimType: row.claim_type,
            statementExcerpt: row.statement.slice(0, 160),
          })
        }
      }

      const coverageGaps: string[] = []
      if (claims.length === 0) coverageGaps.push('no_matching_active_claims')

      return boundRecallResult({
        requestId: randomUUID(),
        degradedComponents: searched.degradedComponents,
        claims,
        conflicts,
        relatedEpisodes: episodes.rows.map(row => ({
          episodeId: row.episode_id,
          sessionId: row.session_id,
          turnId: row.turn_id,
          outcome: row.outcome,
          terminalAt: row.terminal_at,
        })),
        coverageGaps,
        totalChars: usedChars,
      }, maxChars)
    },
  }
}

export type RecallService = ReturnType<typeof createRecallService>

/** Bound the complete serialized REST/MCP DTO, not only excerpts. */
function boundRecallResult(result: RecallResult, maxChars: number): RecallResult {
  const serializedLength = (): number => {
    let previous = -1
    for (let index = 0; index < 4; index++) {
      const current = JSON.stringify(result).length
      result.totalChars = current
      if (current === previous) break
      previous = current
    }
    return JSON.stringify(result).length
  }

  let truncated = false
  while (serializedLength() > maxChars) {
    if (result.relatedEpisodes.length > 0) {
      result.relatedEpisodes.pop()
    } else if (result.conflicts.length > 0) {
      result.conflicts.pop()
    } else {
      const claimWithEvidence = [...result.claims].reverse().find(claim => claim.evidence.length > 0)
      if (claimWithEvidence) {
        claimWithEvidence.evidence.pop()
      } else if (result.claims.length > 0) {
        result.claims.pop()
      } else if (result.coverageGaps.length > 0) {
        result.coverageGaps.pop()
      } else {
        break
      }
    }
    truncated = true
  }
  if (truncated && !result.coverageGaps.includes('response_truncated')) {
    result.coverageGaps.push('response_truncated')
    if (serializedLength() > maxChars) result.coverageGaps.pop()
  }
  serializedLength()
  return result
}
