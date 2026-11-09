import {preparedSourceUnavailable} from '../sources/prepared-sources.js'
import {retainedSourceRead} from '../sources/retained-read.js'
import {guardRetainedVersions,rememberRetainedVersionStatement} from '../sources/retained-versions.js'
import {guardRetainedEvidence,registerRetainedReadCheck} from '../sources/retained-authority.js'
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
  authorityGrant?:SearchInput['authorityGrant']
  installationId: string
  lifecycle?:SearchInput['lifecycle']
  query: string
  repositoryId?: string | null
  repoSnapshotId?: string | null
  branch?: string | null
  taskScopeKey?: string | null
  canonicalRepositoryKey?:string|null
  snapshotCommitSha?:string|null
  requireUniqueCanonicalRepository?:boolean
  repositoryContextValidated?:boolean
  sourceRepositoryContext?:SearchInput['sourceRepositoryContext']
  claimTypes?: readonly string[] | null
  asOf?: Date | null
  maxClaims?: number
  maxEvidencePerClaim?: number
  maxChars?: number
}

export interface RecallEvidence {
  evidenceId: string
  evidenceKind: string
  episodeId: string | null
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
        authorityGrant:input.authorityGrant,
        lifecycle:input.lifecycle,
        query: input.query,
        repositoryId: input.repositoryId,
        repoSnapshotId: input.repoSnapshotId,
        branch: input.branch,
        taskScopeKey: input.taskScopeKey,
        canonicalRepositoryKey:input.canonicalRepositoryKey,snapshotCommitSha:input.snapshotCommitSha,
        requireUniqueCanonicalRepository:input.requireUniqueCanonicalRepository,repositoryContextValidated:input.repositoryContextValidated,
        sourceRepositoryContext:input.sourceRepositoryContext,
        claimTypes: input.claimTypes,
        asOf: input.asOf,
        limit: maxClaims,
      }
      const searched = await search.search(searchInput)

      const accepted=await retainedSourceRead(pool,{installationId:input.installationId,authorityGrant:input.authorityGrant},async db=>{
      await guardRetainedVersions(db,input.installationId,searched.hits.map(hit=>hit.versionId),{expectedStatements:new Map(searched.hits.map(hit=>[hit.versionId,hit.statement])),requireCurrent:!input.asOf,requireAvailable:true,asOf:input.asOf??undefined})
      const claims: RecallClaim[] = []
      const episodeIds = new Set<string>()
      let usedChars = 0
      for (const hit of searched.hits) {
        const evidenceRows = await db.query<{
          evidence_id: string
          evidence_kind: string
          episode_id: string | null
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
          if (row.episode_id) episodeIds.add(row.episode_id)
        }
        const claim:RecallClaim={
          claimId: hit.claimId,
          versionId: hit.versionId,
          claimType: hit.claimType,
          statement,
          scopeKind: hit.scopeKind,
          scopeKey: hit.scopeKey,
          freshnessAt: hit.freshnessAt,
          authority: hit.authority,
          evidence,
        }
        rememberRetainedVersionStatement(claim,hit.statement)
        claims.push(claim)
        if (usedChars >= maxChars) break
      }

      const episodes = episodeIds.size > 0
        ? await db.query<{
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

      const visibleEpisodes:typeof episodes.rows=[]
      for(const row of episodes.rows){
       try{await guardRetainedEvidence(db,input.installationId,[{source_event_id:null,artifact_id:null,episode_id:row.episode_id,evidence_kind:'episode'}]);visibleEpisodes.push(row)}
       catch(error){if(!preparedSourceUnavailable(error))throw error}
      }

      // Conflicts are deterministic validator outcomes explicitly linked to a
      // recalled active claim, never arbitrary claims that merely share a type.
      const conflicts: RecallResult['conflicts'] = []
      if (claims.length > 0) {
        const conflictRows = await db.query<{
          claim_id: string
          claim_type: string
          statement: string
          row_version:string
        }>(`
          SELECT candidate_id::text AS claim_id, claim_type, statement,episode_id::text,xmin::text AS row_version
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
        await guardRetainedEvidence(db,input.installationId,conflictRows.rows.map(row=>({source_event_id:null,artifact_id:null,episode_id:(row as unknown as {episode_id:string|null}).episode_id,evidence_kind:'episode'})))
        if(conflictRows.rows.length){
         const expected=JSON.stringify(conflictRows.rows.map(row=>[row.claim_id,row.row_version])),ids=conflictRows.rows.map(row=>row.claim_id)
         await registerRetainedReadCheck(db,input.installationId,async current=>{
          const fresh=(await current.query('SELECT candidate_id::text AS claim_id,xmin::text AS row_version FROM memory_candidates WHERE installation_id=$1 AND candidate_id=ANY($2::uuid[]) ORDER BY candidate_id FOR SHARE NOWAIT',[input.installationId,ids])).rows
          if(JSON.stringify(fresh.map(row=>[row.claim_id,row.row_version]))!==expected)throw Error('source_reference_changed')
         })
        }
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
        relatedEpisodes: visibleEpisodes.map(row => ({
          episodeId: row.episode_id,
          sessionId: row.session_id,
          turnId: row.turn_id,
          outcome: row.outcome,
          terminalAt: row.terminal_at,
        })),
        coverageGaps,
        totalChars: usedChars,
      }, maxChars)
      })
      return accepted??boundRecallResult({requestId:randomUUID(),degradedComponents:[...new Set([...searched.degradedComponents,'source_unavailable'])],claims:[],conflicts:[],relatedEpisodes:[],coverageGaps:['source_unavailable'],totalChars:0},maxChars)
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
