import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createWikiBuildService } from '../wiki/build-service.js'
import { createMemoryMetrics } from '../metrics.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const describeWithDatabase = databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1'
  ? describe
  : describe.skip

interface GraphFixture {
  installationId: string
  repositoryId: string
  snapshotId: string
  graphVersionId: string
  commitSha: string
}

async function insertGraphFixture(pool: pg.Pool, suffix: string): Promise<GraphFixture> {
  const installationId = randomUUID()
  const repositoryId = randomUUID()
  const snapshotId = randomUUID()
  const graphVersionId = randomUUID()
  const blobHash = createHash('sha256').update(`export const ${suffix} = true\n`).digest('hex')
  const contentHash = createHash('sha256').update(`graph:${suffix}`).digest('hex')
  const commitSha = createHash('sha1').update(`commit:${suffix}`).digest('hex')
  await pool.query(`
    INSERT INTO memory_installations
      (installation_id, provider_id, relay_status, local_status, config_version,
       granted_scopes, subscriptions, enabled_services, event_filter)
    VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1,
            '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
  `, [installationId])
  await pool.query(`
    INSERT INTO repositories
      (repository_id, installation_id, repository_key, first_observed_at, last_observed_at)
    VALUES ($1, $2, $3, NOW(), NOW())
  `, [repositoryId, installationId, `fixture/${suffix}`])
  await pool.query(`
    INSERT INTO memory_source_snapshots
      (snapshot_id, installation_id, repository_id, commit_sha, git_object_format,
       manifest_hash, state, generation, parser_matrix_version, file_count, byte_count, completed_at)
    VALUES ($1, $2, $3, $4, 'sha1', $5, 'active', 1, 'phase4-v1', 2, 64, NOW())
  `, [snapshotId, installationId, repositoryId, commitSha, 'b'.repeat(64)])
  await pool.query(`
    INSERT INTO memory_source_blobs (installation_id, blob_hash, byte_count, utf8_content)
    VALUES ($1, $2, 27, $3)
  `, [installationId, blobHash, `export const ${suffix} = true\n`])
  await pool.query(`
    INSERT INTO memory_source_snapshot_entries
      (snapshot_id, installation_id, path, blob_hash, language, capability, byte_count, mode)
    VALUES
      ($1, $2, 'src/index.ts', $3, 'typescript', 'symbols_and_edges', 27, '100644'),
      ($1, $2, 'README.md', $3, 'markdown', 'file_only', 27, '100644')
  `, [snapshotId, installationId, blobHash])
  await pool.query(`
    INSERT INTO memory_code_graph_versions
      (graph_version_id, installation_id, repository_id, snapshot_id, generation,
       parser_version, state, coverage, content_hash, activated_at)
    VALUES ($1, $2, $3, $4, 1, 'typescript-5.7-phase4-v1', 'active', 'partial', $5, NOW())
  `, [graphVersionId, installationId, repositoryId, snapshotId, contentHash])
  await pool.query(`
    INSERT INTO memory_code_graph_heads
      (installation_id, repository_id, active_graph_version_id, revision)
    VALUES ($1, $2, $3, 1)
  `, [installationId, repositoryId, graphVersionId])
  const fileNode = randomUUID()
  const symbolNode = randomUUID()
  await pool.query(`
    INSERT INTO memory_code_nodes
      (graph_version_id, installation_id, node_id, kind, stable_key, path, name,
       symbol_kind, start_line, start_column, end_line, end_column, metadata)
    VALUES
      ($1, $2, $3, 'file', 'file:src/index.ts', 'src/index.ts', 'src/index.ts',
       NULL, NULL, NULL, NULL, NULL, '{"language":"typescript"}'::jsonb),
      ($1, $2, $4, 'symbol', 'symbol:src/index.ts#value:variable:1', 'src/index.ts', 'value',
       'variable', 1, 1, 1, 25, '{}'::jsonb)
  `, [graphVersionId, installationId, fileNode, symbolNode])
  return { installationId, repositoryId, snapshotId, graphVersionId, commitSha }
}

async function claimBuildJob(pool: pg.Pool, runId: string, worker = 'wiki-worker') {
  const job = await pool.query<{
    job_id: string
    installation_id: string
    idempotency_key: string
    payload: Record<string, unknown>
  }>(`
    UPDATE memory_jobs SET state = 'running', claimed_by = $2, claim_epoch = claim_epoch + 1
    WHERE job_type = 'build_wiki' AND payload->>'run_id' = $1
    RETURNING job_id::text, installation_id::text, idempotency_key, payload
  `, [runId, worker])
  const row = job.rows[0]!
  const epoch = await pool.query<{ claim_epoch: string }>(
    `SELECT claim_epoch::text FROM memory_jobs WHERE job_id = $1`, [row.job_id],
  )
  return {
    claim: {
      job_id: row.job_id,
      installation_id: row.installation_id,
      job_type: 'build_wiki' as const,
      idempotency_key: row.idempotency_key,
      payload: row.payload,
      attempts: 1,
      claim_epoch: Number(epoch.rows[0]!.claim_epoch),
    },
    fence: { jobId: row.job_id, claimedBy: worker, claimEpoch: Number(epoch.rows[0]!.claim_epoch) },
  }
}

describeWithDatabase('phase4 deterministic Wiki builds', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 6 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
  })

  afterAll(async () => pool?.end())

  beforeEach(async () => {
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`)
    await applyMemorySchema(pool)
  }, 120_000)

  test('serializes one active run per Wiki while allowing a different Wiki', async () => {
    const first = await insertGraphFixture(pool, 'first')
    const second = await insertGraphFixture(pool, 'second')
    const service = createWikiBuildService({ pool })

    const [a, duplicate] = await Promise.all([
      service.scheduleBuild({ installationId: first.installationId, repositoryId: first.repositoryId }),
      service.scheduleBuild({ installationId: first.installationId, repositoryId: first.repositoryId }),
    ])
    const b = await service.scheduleBuild({
      installationId: second.installationId,
      repositoryId: second.repositoryId,
    })

    expect(duplicate.runId).toBe(a.runId)
    expect(b.runId).not.toBe(a.runId)
    const active = await pool.query<{ wiki_id: string; count: number }>(`
      SELECT wiki_id::text, COUNT(*)::int AS count FROM memory_wiki_build_runs
      WHERE state IN ('queued','running','validating') GROUP BY wiki_id ORDER BY wiki_id
    `)
    expect(active.rows).toHaveLength(2)
    expect(active.rows.every(row => row.count === 1)).toBe(true)
  })

  test('captures exact graph sources and persists one deterministic candidate without a model', async () => {
    const fixture = await insertGraphFixture(pool, 'candidate')
    const metrics = createMemoryMetrics()
    const service = createWikiBuildService({ pool, metrics: metrics.phase4, mode: 'shadow' })
    const scheduled = await service.scheduleBuild({
      installationId: fixture.installationId,
      repositoryId: fixture.repositoryId,
    })
    const { claim, fence } = await claimBuildJob(pool, scheduled.runId)

    await service.handleBuildWiki(claim, new AbortController().signal, { fence })

    const run = await pool.query<{ state: string; graph_version_id: string; source_snapshot_id: string }>(`
      SELECT state, graph_version_id::text, source_snapshot_id::text
      FROM memory_wiki_build_runs WHERE run_id = $1
    `, [scheduled.runId])
    expect(run.rows[0]).toEqual({
      state: 'candidate',
      graph_version_id: fixture.graphVersionId,
      source_snapshot_id: fixture.snapshotId,
    })
    const candidate = await pool.query<{ document: Record<string, unknown>; content_hash: string }>(`
      SELECT document, content_hash FROM memory_wiki_build_candidates WHERE run_id = $1
    `, [scheduled.runId])
    expect(candidate.rows).toHaveLength(1)
    expect(candidate.rows[0]!.document).toMatchObject({
      schema_version: 'wiki-candidate.v1',
      pages: [{ page_key: 'repository-overview' }],
    })
    expect(candidate.rows[0]!.content_hash).toMatch(/^[0-9a-f]{64}$/)
    const sources = await pool.query<{ source_kind: string; stable_key: string; commit_sha: string }>(`
      SELECT source_kind, stable_key, commit_sha
      FROM memory_wiki_build_sources WHERE run_id = $1 ORDER BY ordinal
    `, [scheduled.runId])
    expect(sources.rows).toEqual([
      { source_kind: 'file', stable_key: 'file:src/index.ts', commit_sha: fixture.commitSha },
      { source_kind: 'symbol', stable_key: 'symbol:src/index.ts#value:variable:1', commit_sha: fixture.commitSha },
    ])
    expect(await metrics.registry.metrics()).toContain(
      'pocketctl_memory_wiki_builds_total{mode="shadow",result="succeeded"} 1',
    )
  })

  test('lost lease, cancellation, and a newer generation cannot create a candidate or replace the active head', async () => {
    const fixture = await insertGraphFixture(pool, 'fenced')
    const service = createWikiBuildService({ pool })
    const scheduled = await service.scheduleBuild({
      installationId: fixture.installationId,
      repositoryId: fixture.repositoryId,
    })
    const { claim, fence } = await claimBuildJob(pool, scheduled.runId)
    await expect(service.handleBuildWiki(claim, new AbortController().signal, {
      fence: { ...fence, claimEpoch: fence.claimEpoch - 1 },
    })).rejects.toThrow(/job_fence_lost/)
    expect((await pool.query(`SELECT 1 FROM memory_wiki_build_candidates WHERE run_id = $1`, [scheduled.runId])).rowCount).toBe(0)

    await pool.query(`UPDATE memory_wiki_build_runs SET state = 'cancelled' WHERE run_id = $1`, [scheduled.runId])
    await service.handleBuildWiki(claim, new AbortController().signal, { fence })
    expect((await pool.query(`SELECT 1 FROM memory_wiki_build_candidates WHERE run_id = $1`, [scheduled.runId])).rowCount).toBe(0)

    const next = await service.scheduleBuild({
      installationId: fixture.installationId,
      repositoryId: fixture.repositoryId,
    })
    const nextJob = await claimBuildJob(pool, next.runId, 'wiki-worker-2')
    await pool.query(`UPDATE memory_wikis SET generation = generation + 1 WHERE wiki_id = $1`, [next.wikiId])
    await service.handleBuildWiki(nextJob.claim, new AbortController().signal, { fence: nextJob.fence })
    const state = await pool.query<{ state: string }>(
      `SELECT state FROM memory_wiki_build_runs WHERE run_id = $1`, [next.runId],
    )
    expect(state.rows[0]!.state).toBe('stale_generation')
    expect((await pool.query(`SELECT 1 FROM memory_wiki_build_candidates WHERE run_id = $1`, [next.runId])).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM memory_wiki_heads WHERE wiki_id = $1`, [next.wikiId])).rowCount).toBe(0)
  })
})
