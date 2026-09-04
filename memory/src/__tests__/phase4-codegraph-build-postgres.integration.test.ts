import { createHash, randomUUID } from 'crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createSourceIngestService } from '../codegraph/ingest-service.js'
import { createCodeGraphBuildService } from '../codegraph/build-service.js'
import { loadFixtureFiles, PARSER_VERSION } from '../codegraph/typescript-parser.js'
import { languageCapabilityFor } from '../codegraph/types.js'
import { computeManifestHash } from '../codegraph/source-repository.js'
import { createMemoryMetrics, type Phase4Metrics } from '../metrics.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const FIXTURE = loadFixtureFiles(
  `${process.cwd()}/fixtures/phase4-codegraph/commit-a`,
).filter(file => languageCapabilityFor(file.path) !== 'unsupported')

interface Ctx {
  pool: pg.Pool
  installationId: string
  repositoryId: string
  snapshotId: string
  jobId: string
}

async function ingestFixture(pool: pg.Pool, installationId: string, suffix: string): Promise<{
  snapshotId: string
  jobId: string
}> {
  const service = createSourceIngestService(pool)
  const manifest = computeManifestHash(FIXTURE.map(file => ({
    path: file.path,
    gitMode: '100644',
    language: languageForEntry(file.path),
    capability: capabilityForEntry(file.path),
    blobSha256: sha256(file.content),
    byteCount: Buffer.byteLength(file.content),
  })))
  const start = await service.startSnapshot({
    installationId,
    repository: { repository_key: `github.com/fixture/${suffix}` },
    gitObjectFormat: 'sha1',
    commitSha: 'a'.repeat(40),
    manifestSha256: manifest,
    expectedFileCount: FIXTURE.length,
    expectedByteCount: FIXTURE.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
    idempotencyKey: `idem-${suffix}`,
  })
  await service.uploadBatch({
    installationId,
    snapshotId: start.snapshotId,
    batchIndex: 0,
    entries: FIXTURE.map(file => ({
      path: file.path,
      git_mode: '100644',
      language: languageForEntry(file.path),
      capability: capabilityForEntry(file.path),
      blob_sha256: sha256(file.content),
      byte_count: Buffer.byteLength(file.content),
      content_base64: Buffer.from(file.content).toString('base64'),
    })),
  })
  await service.finalizeSnapshot({
    installationId,
    snapshotId: start.snapshotId,
    manifestSha256: manifest,
    expectedFileCount: FIXTURE.length,
    expectedByteCount: FIXTURE.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
    idempotencyKey: `idem-f-${suffix}`,
  })
  const job = await pool.query<{ job_id: string; installation_id: string }>(`
    SELECT job_id::text, installation_id::text FROM memory_jobs
    WHERE job_type = 'parse_code_snapshot' AND installation_id = $1
    ORDER BY created_at DESC LIMIT 1
  `, [installationId])
  return { snapshotId: start.snapshotId, jobId: job.rows[0]!.job_id }
}

function languageForEntry(path: string): string {
  if (path.endsWith('.tsx')) return 'tsx'
  if (path.endsWith('.ts') || path.endsWith('.mts')) return 'typescript'
  if (path.endsWith('.js')) return 'javascript'
  if (path.endsWith('.md')) return 'markdown'
  if (path.endsWith('.json')) return 'json'
  return 'text'
}

function capabilityForEntry(path: string): string {
  return /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(path) ? 'symbols_and_edges' : 'file_only'
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function runHandler(pool: pg.Pool, claim: { job_id: string }, installationId: string, overrides: { claimedBy?: string; claimEpoch?: number; metrics?: Phase4Metrics } = {}): Promise<void> {
  const build = createCodeGraphBuildService({ pool, metrics: overrides.metrics, mode: 'shadow' })
  // Simulate the worker claim that precedes dispatch.
  await pool.query(`
    UPDATE memory_jobs
    SET state = 'running', claimed_by = $2, claim_epoch = $3
    WHERE job_id = $1
  `, [claim.job_id, overrides.claimedBy ?? 'worker-test', overrides.claimEpoch ?? 1])
  const job = await pool.query<{ idempotency_key: string; payload: Record<string, unknown> }>(`
    SELECT idempotency_key, payload FROM memory_jobs WHERE job_id = $1
  `, [claim.job_id])
  const row = job.rows[0]
  await build.handleParseCodeSnapshot(
    {
      job_id: claim.job_id, installation_id: installationId,
      job_type: 'parse_code_snapshot' as const,
      idempotency_key: row?.idempotency_key ?? '',
      payload: (row?.payload as Record<string, unknown>) ?? {},
      attempts: 1, claim_epoch: overrides.claimEpoch ?? 1,
    },
    new AbortController().signal,
    { fence: { jobId: claim.job_id, claimedBy: overrides.claimedBy ?? 'worker-test', claimEpoch: overrides.claimEpoch ?? 1 } },
  )
}

describeWithDatabase('phase4 code graph build and activation', () => {
  let pool: pg.Pool
  let base: Ctx

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`)
    await applyMemorySchema(pool)
    const installation = await pool.query<{ id: string }>(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version,
         granted_scopes, subscriptions, enabled_services, event_filter)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1,
              '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
      RETURNING installation_id::text AS id
    `, [randomUUID()])
    const installationId = installation.rows[0]!.id
    const { snapshotId, jobId } = await ingestFixture(pool, installationId, 'build')
    const repository = await pool.query<{ id: string }>(`
      SELECT repository_id::text AS id FROM memory_source_snapshots WHERE snapshot_id = $1
    `, [snapshotId])
    base = { pool, installationId, repositoryId: repository.rows[0]!.id, snapshotId, jobId }
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
  })

  test('builds one validated candidate per snapshot and atomically activates the head', async () => {
    const metrics = createMemoryMetrics()
    await runHandler(base.pool, { job_id: base.jobId }, base.installationId, { metrics: metrics.phase4 })

    const versions = await base.pool.query(`
      SELECT graph_version_id::text, state, coverage, content_hash, parser_version, generation
      FROM memory_code_graph_versions WHERE snapshot_id = $1
    `, [base.snapshotId])
    expect(versions.rowCount).toBe(1)
    expect(versions.rows[0]).toMatchObject({
      state: 'active',
      parser_version: PARSER_VERSION,
    })
    expect(Number(versions.rows[0]!.generation)).toBe(1)
    expect(versions.rows[0]!.coverage).toBe('partial') // unsupported fixture files exist

    const head = await base.pool.query(`
      SELECT active_graph_version_id::text, revision FROM memory_code_graph_heads
      WHERE installation_id = $1 AND repository_id = $2
    `, [base.installationId, base.repositoryId])
    expect(head.rowCount).toBe(1)
    expect(Number(head.rows[0]!.revision)).toBe(1)

    const nodes = await base.pool.query(`
      SELECT COUNT(*)::int AS count FROM memory_code_nodes
      WHERE graph_version_id = $1
    `, [versions.rows[0]!.graph_version_id])
    expect(nodes.rows[0]!.count).toBeGreaterThan(10)

    const snapshot = await base.pool.query<{ state: string }>(`
      SELECT state FROM memory_source_snapshots WHERE snapshot_id = $1
    `, [base.snapshotId])
    expect(snapshot.rows[0]!.state).toBe('active')
    expect(await metrics.registry.metrics()).toContain(
      'pocketctl_memory_codegraph_runs_total{mode="shadow",result="succeeded",incremental="false"} 1',
    )
  })

  test('re-running the same job is idempotent: no duplicate candidate, head unchanged', async () => {
    const before = await base.pool.query<{ revision: string }>(`
      SELECT revision::text FROM memory_code_graph_heads
      WHERE installation_id = $1 AND repository_id = $2
    `, [base.installationId, base.repositoryId])
    await runHandler(base.pool, { job_id: base.jobId }, base.installationId)
    const versions = await base.pool.query(`
      SELECT COUNT(*)::int AS count FROM memory_code_graph_versions WHERE snapshot_id = $1
    `, [base.snapshotId])
    expect(versions.rows[0]!.count).toBe(1)
    const after = await base.pool.query<{ revision: string }>(`
      SELECT revision::text FROM memory_code_graph_heads
      WHERE installation_id = $1 AND repository_id = $2
    `, [base.installationId, base.repositoryId])
    expect(after.rows[0]!.revision).toBe(before.rows[0]!.revision)
  })

  test('a parser or validation failure retains the previous active graph', async () => {
    const firstHash = await base.pool.query<{ content_hash: string }>(`
      SELECT content_hash FROM memory_code_graph_versions WHERE snapshot_id = $1
    `, [base.snapshotId])

    // A second snapshot with a poisoned parse seam: the handler must fail
    // without touching the existing active head.
    const poisoned = await ingestFixture(base.pool, base.installationId, 'poison')
    const build = createCodeGraphBuildService({
      pool: base.pool,
      parse: () => {
        throw new Error('parser exploded')
      },
    })
    await base.pool.query(`
      UPDATE memory_jobs SET state = 'running', claimed_by = 'worker-test', claim_epoch = 1
      WHERE job_id = $1
    `, [poisoned.jobId])
    const poisonedJob = await base.pool.query<{ idempotency_key: string; payload: Record<string, unknown> }>(`
      SELECT idempotency_key, payload FROM memory_jobs WHERE job_id = $1
    `, [poisoned.jobId])
    await expect(build.handleParseCodeSnapshot(
      {
        job_id: poisoned.jobId, installation_id: base.installationId,
        job_type: 'parse_code_snapshot' as const,
        idempotency_key: poisonedJob.rows[0]!.idempotency_key,
        payload: poisonedJob.rows[0]!.payload as Record<string, unknown>,
        attempts: 1, claim_epoch: 1,
      },
      new AbortController().signal,
      { fence: { jobId: poisoned.jobId, claimedBy: 'worker-test', claimEpoch: 1 } },
    )).rejects.toThrow(/parser exploded/)

    const stillActive = await base.pool.query<{ content_hash: string }>(`
      SELECT content_hash FROM memory_code_graph_versions WHERE snapshot_id = $1
    `, [base.snapshotId])
    expect(stillActive.rows[0]!.content_hash).toBe(firstHash.rows[0]!.content_hash)
    const head = await base.pool.query<{ revision: string }>(`
      SELECT revision::text FROM memory_code_graph_heads
      WHERE installation_id = $1 AND repository_id = $2
    `, [base.installationId, base.repositoryId])
    expect(head.rows[0]!.revision).toBe('1')
    // The failed snapshot never produced a graph version.
    const poisonVersions = await base.pool.query(`
      SELECT COUNT(*)::int AS count FROM memory_code_graph_versions WHERE snapshot_id = $1
    `, [poisoned.snapshotId])
    expect(poisonVersions.rows[0]!.count).toBe(0)
  })

  test('an unfinalized snapshot cannot build: not_ready refuses without side effects', async () => {
    const service = createSourceIngestService(base.pool)
    const start = await service.startSnapshot({
      installationId: base.installationId,
      repository: { repository_key: 'github.com/fixture/unfinalized' },
      gitObjectFormat: 'sha1',
      commitSha: 'b'.repeat(40),
      manifestSha256: 'c'.repeat(64),
      expectedFileCount: 1,
      expectedByteCount: 3,
      idempotencyKey: 'idem-unfinalized',
    })
    const build = createCodeGraphBuildService({ pool: base.pool })
    await expect(build.handleParseCodeSnapshot(
      { job_id: randomUUID(), installation_id: base.installationId, job_type: 'parse_code_snapshot', idempotency_key: '', payload: { snapshot_id: start.snapshotId }, attempts: 1, claim_epoch: 1 },
      new AbortController().signal,
      { fence: { jobId: randomUUID(), claimedBy: 'worker-test', claimEpoch: 1 } },
    )).rejects.toThrow(/not_ready|job_fence_lost/)
    const versions = await base.pool.query(`
      SELECT COUNT(*)::int AS count FROM memory_code_graph_versions WHERE snapshot_id = $1
    `, [start.snapshotId])
    expect(versions.rows[0]!.count).toBe(0)
  })
})
