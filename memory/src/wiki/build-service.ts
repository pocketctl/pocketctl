import type pg from 'pg'

import type { JobClaim, JobFence } from '../jobs/types.js'
import { WikiCandidateDocumentSchema, type WikiCoverage } from './types.js'
import { createWikiRepository } from './repository.js'
import { buildDeterministicWikiSkeleton, wikiCandidateContentHash } from './skeleton-builder.js'
import {
  generateWikiCandidateOrFallback,
  WIKI_PROMPT_VERSION,
  type WikiGenerator,
} from './generator.js'
import type { Phase4Metrics } from '../metrics.js'

export class WikiBuildFenceError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

interface LockedBuildRun {
  run_id: string
  wiki_id: string
  repository_id: string
  generation: string
  current_generation: string
  source_snapshot_id: string
  graph_version_id: string
  generation_run_id: string | null
  state: string
  commit_sha: string
  graph_coverage: WikiCoverage
  graph_state: string
  snapshot_state: string
  active_graph_version_id: string | null
  repository_tombstoned: boolean
  snapshot_tombstoned: boolean
}

/** Serialized, fenced Wiki build execution. Publication is a later service. */
export function createWikiBuildService(deps: {
  pool: pg.Pool
  generator?: WikiGenerator
  maxSections?: number
  metrics?: Phase4Metrics
  mode?: 'shadow' | 'enabled'
}) {
  const pool = deps.pool
  const repository = createWikiRepository(pool)

  async function recheckFence(client: pg.PoolClient, fence: JobFence): Promise<void> {
    const result = await client.query<{
      state: string
      claimed_by: string | null
      claim_epoch: string
    }>(`
      SELECT state, claimed_by, claim_epoch::text
      FROM memory_jobs WHERE job_id = $1
    `, [fence.jobId])
    const row = result.rows[0]
    if (!row || row.state !== 'running' || row.claimed_by !== fence.claimedBy
      || Number(row.claim_epoch) !== fence.claimEpoch) {
      throw new WikiBuildFenceError('job_fence_lost')
    }
  }

  async function lockRun(client: pg.PoolClient, input: {
    installationId: string
    runId: string
  }): Promise<LockedBuildRun> {
    const result = await client.query<LockedBuildRun>(`
      SELECT r.run_id::text, r.wiki_id::text, w.repository_id::text,
             r.generation::text, w.generation::text AS current_generation,
             r.source_snapshot_id::text, r.graph_version_id::text,
             r.generation_run_id::text, r.state, s.commit_sha,
             g.coverage AS graph_coverage, g.state AS graph_state,
             s.state AS snapshot_state,
             h.active_graph_version_id::text,
             EXISTS (
               SELECT 1 FROM memory_repository_tombstones rt
               WHERE rt.installation_id = r.installation_id
                 AND rt.repository_id = w.repository_id
             ) AS repository_tombstoned,
             EXISTS (
               SELECT 1 FROM memory_source_snapshot_tombstones st
               WHERE st.installation_id = r.installation_id
                 AND st.snapshot_id = r.source_snapshot_id
             ) AS snapshot_tombstoned
      FROM memory_wiki_build_runs r
      JOIN memory_wikis w
        ON w.installation_id = r.installation_id AND w.wiki_id = r.wiki_id
      JOIN memory_source_snapshots s
        ON s.installation_id = r.installation_id AND s.snapshot_id = r.source_snapshot_id
      JOIN memory_code_graph_versions g
        ON g.installation_id = r.installation_id AND g.graph_version_id = r.graph_version_id
      LEFT JOIN memory_code_graph_heads h
        ON h.installation_id = r.installation_id AND h.repository_id = w.repository_id
      WHERE r.installation_id = $1 AND r.run_id = $2
      FOR UPDATE OF r, w
    `, [input.installationId, input.runId])
    const row = result.rows[0]
    if (!row) throw new WikiBuildFenceError('wiki_build_not_found')
    return row
  }

  function isStale(row: LockedBuildRun): boolean {
    return Number(row.generation) !== Number(row.current_generation)
      || row.active_graph_version_id !== row.graph_version_id
      || row.graph_state !== 'active'
      || row.snapshot_state !== 'active'
      || row.repository_tombstoned
      || row.snapshot_tombstoned
  }

  async function markStale(client: pg.PoolClient, row: LockedBuildRun): Promise<void> {
    await client.query(`
      UPDATE memory_wiki_build_runs
      SET state = 'stale_generation', error_code = 'stale_generation', completed_at = NOW()
      WHERE run_id = $1
    `, [row.run_id])
    if (row.generation_run_id) {
      await client.query(`
        UPDATE memory_generation_runs
        SET state = 'superseded', error_code = 'stale_generation', completed_at = NOW()
        WHERE run_id = $1 AND state IN ('queued','running')
      `, [row.generation_run_id])
    }
  }

  return {
    scheduleBuild: repository.scheduleBuild,

    async handleBuildWiki(
      claim: JobClaim,
      signal: AbortSignal,
      ctx?: { fence: JobFence },
    ): Promise<void> {
      const mode = deps.mode ?? 'shadow'
      try {
        const fence = ctx?.fence
        if (!fence) throw new WikiBuildFenceError('job_fence_missing')
        if (!claim.installation_id) throw new WikiBuildFenceError('installation_missing')
        if (signal.aborted) throw new WikiBuildFenceError('wiki_build_aborted')
        const runId = typeof claim.payload?.run_id === 'string' ? claim.payload.run_id : null
        if (!runId) throw new WikiBuildFenceError('payload_missing')

        let run: LockedBuildRun
        const start = await pool.connect()
        try {
        await start.query('BEGIN')
        await recheckFence(start, fence)
        run = await lockRun(start, { installationId: claim.installation_id, runId })
        if (run.state === 'candidate' || run.state === 'published'
          || run.state === 'superseded' || run.state === 'stale_generation') {
          await start.query('COMMIT')
          deps.metrics?.wikiBuilds.inc({ mode, result: 'skipped' })
          return
        }
        if (run.state === 'cancelled') {
          if (run.generation_run_id) {
            await start.query(`
              UPDATE memory_generation_runs SET state = 'cancelled', completed_at = NOW()
              WHERE run_id = $1 AND state IN ('queued','running')
            `, [run.generation_run_id])
          }
          await start.query('COMMIT')
          deps.metrics?.wikiBuilds.inc({ mode, result: 'cancelled' })
          return
        }
        if (isStale(run)) {
          await markStale(start, run)
          await start.query('COMMIT')
          deps.metrics?.wikiBuilds.inc({ mode, result: 'stale_generation' })
          return
        }
        await start.query(`
          UPDATE memory_wiki_build_runs
          SET state = 'running', started_at = COALESCE(started_at, NOW()), error_code = NULL
          WHERE run_id = $1
        `, [runId])
        if (run.generation_run_id) {
          await start.query(`
            UPDATE memory_generation_runs SET state = 'running'
            WHERE run_id = $1 AND state = 'queued'
          `, [run.generation_run_id])
        }
        await start.query('COMMIT')
        } catch (error) {
          await start.query('ROLLBACK').catch(() => undefined)
          throw error
        } finally {
          start.release()
        }

      if (signal.aborted) throw new WikiBuildFenceError('wiki_build_aborted')
      const sources = await repository.captureSources({
        installationId: claim.installation_id,
        graphVersionId: run.graph_version_id,
        snapshotId: run.source_snapshot_id,
      })
      const skeleton = WikiCandidateDocumentSchema.parse(buildDeterministicWikiSkeleton({
        coverage: run.graph_coverage,
        commitSha: run.commit_sha,
        sources,
        maxSections: deps.maxSections,
      }))
      const generation = await generateWikiCandidateOrFallback({
        generator: deps.generator,
        skeleton,
        sources,
        coverage: run.graph_coverage,
        commitSha: run.commit_sha,
        snapshotId: run.source_snapshot_id,
        signal,
      })
      const candidate = generation.document
      const contentHash = wikiCandidateContentHash(candidate)

      const publishCandidate = await pool.connect()
      try {
        await publishCandidate.query('BEGIN')
        await recheckFence(publishCandidate, fence)
        const current = await lockRun(publishCandidate, {
          installationId: claim.installation_id,
          runId,
        })
        if (current.state === 'cancelled') {
          await publishCandidate.query('COMMIT')
          deps.metrics?.wikiBuilds.inc({ mode, result: 'cancelled' })
          return
        }
        if (current.state === 'candidate' || current.state === 'published') {
          await publishCandidate.query('COMMIT')
          deps.metrics?.wikiBuilds.inc({ mode, result: 'skipped' })
          return
        }
        if (isStale(current)) {
          await markStale(publishCandidate, current)
          await publishCandidate.query('COMMIT')
          deps.metrics?.wikiBuilds.inc({ mode, result: 'stale_generation' })
          return
        }
        await publishCandidate.query(`
          UPDATE memory_wiki_build_runs SET state = 'validating' WHERE run_id = $1
        `, [runId])
        await publishCandidate.query(`DELETE FROM memory_wiki_build_sources WHERE run_id = $1`, [runId])
        for (const source of sources) {
          await publishCandidate.query(`
            INSERT INTO memory_wiki_build_sources
              (run_id, installation_id, source_token, ordinal, source_kind,
               stable_key, source_ref_id, source_snapshot_id, commit_sha, path,
               content_hash, excerpt)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `, [runId, claim.installation_id, source.sourceToken, source.ordinal,
            source.sourceKind, source.stableKey, source.sourceRefId,
            source.sourceSnapshotId, source.commitSha, source.path,
            source.contentHash, source.excerpt])
        }
        await publishCandidate.query(`
          INSERT INTO memory_wiki_build_candidates
            (run_id, installation_id, wiki_id, document, content_hash, validated_at)
          VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
          ON CONFLICT (run_id) DO UPDATE
          SET document = EXCLUDED.document, content_hash = EXCLUDED.content_hash,
              validated_at = EXCLUDED.validated_at
        `, [runId, claim.installation_id, current.wiki_id,
          JSON.stringify(candidate), contentHash])
        await publishCandidate.query(`
          UPDATE memory_wiki_build_runs
          SET state = 'candidate', completed_at = NOW(),
              prompt_version = $2, model_version = $3, error_code = $4,
              budget_reservation_id = COALESCE($5, budget_reservation_id)
          WHERE run_id = $1
        `, [runId, deps.generator ? WIKI_PROMPT_VERSION : null,
          generation.usage?.model ?? null,
          generation.failureCode ? `model_fallback_${generation.failureCode}`.slice(0, 64) : null,
          generation.budgetReservationId ?? null])
        if (current.generation_run_id) {
          await publishCandidate.query(`
            UPDATE memory_generation_runs
            SET state = 'succeeded', output_kind = 'wiki_candidate', output_id = $2,
                provider = CASE WHEN $3::text IS NULL THEN provider ELSE 'text' END,
                model = COALESCE($3, model), input_tokens = COALESCE($4, input_tokens),
                output_tokens = COALESCE($5, output_tokens),
                cost_micros = COALESCE($6, cost_micros), completed_at = NOW()
            WHERE run_id = $1 AND state IN ('queued','running')
          `, [current.generation_run_id, runId, generation.usage?.model ?? null,
            generation.usage?.inputTokens ?? null, generation.usage?.outputTokens ?? null,
            generation.usage?.costMicros ?? null])
        }
        await publishCandidate.query('COMMIT')
        deps.metrics?.wikiBuilds.inc({ mode, result: 'succeeded' })
      } catch (error) {
        await publishCandidate.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        publishCandidate.release()
      }
      } catch (error) {
        deps.metrics?.wikiBuilds.inc({
          mode,
          result: signal.aborted || (error instanceof WikiBuildFenceError && error.code === 'wiki_build_aborted')
            ? 'cancelled' : 'failed',
        })
        throw error
      }
    },
  }
}

export type WikiBuildService = ReturnType<typeof createWikiBuildService>
