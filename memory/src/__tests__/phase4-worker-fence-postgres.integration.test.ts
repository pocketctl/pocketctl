import { createHash, randomUUID } from 'crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createSourceIngestService } from '../codegraph/ingest-service.js'
import { createCodeGraphBuildService } from '../codegraph/build-service.js'
import { computeManifestHash } from '../codegraph/source-repository.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const ONE_FILE = [{ path: 'src/a.ts', content: 'export const a = 1;\n' }]
const BUFFER_BYTES = Buffer.byteLength(ONE_FILE[0]!.content)

describeWithDatabase('phase4 code graph build fences', () => {
  let pool: pg.Pool
  let installationId: string
  let snapshotId: string
  let jobId: string

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
    installationId = installation.rows[0]!.id

    const service = createSourceIngestService(pool)
    const manifest = computeManifestHash(ONE_FILE.map(file => ({
      path: file.path, gitMode: '100644', language: 'typescript',
      capability: 'symbols_and_edges', blobSha256: sha256(file.content),
      byteCount: Buffer.byteLength(file.content),
    })))
    const start = await service.startSnapshot({
      installationId,
      repository: { repository_key: 'github.com/fixture/fence' },
      gitObjectFormat: 'sha1',
      commitSha: 'd'.repeat(40),
      manifestSha256: manifest,
      expectedFileCount: 1,
      expectedByteCount: BUFFER_BYTES,
      idempotencyKey: 'idem-fence',
    })
    await service.uploadBatch({
      installationId, snapshotId: start.snapshotId, batchIndex: 0,
      entries: ONE_FILE.map(file => ({
        path: file.path, git_mode: '100644', language: 'typescript',
        capability: 'symbols_and_edges', blob_sha256: sha256(file.content),
        byte_count: Buffer.byteLength(file.content),
        content_base64: Buffer.from(file.content).toString('base64'),
      })),
    })
    await service.finalizeSnapshot({
      installationId, snapshotId: start.snapshotId, manifestSha256: manifest,
      expectedFileCount: 1, expectedByteCount: BUFFER_BYTES, idempotencyKey: 'idem-fence-f',
    })
    snapshotId = start.snapshotId
    const job = await pool.query<{ job_id: string }>(`
      SELECT job_id::text FROM memory_jobs WHERE job_type = 'parse_code_snapshot'
        AND installation_id = $1 ORDER BY created_at DESC LIMIT 1
    `, [installationId])
    jobId = job.rows[0]!.job_id
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  const run = async (overrides: { claimedBy?: string; claimEpoch?: number; jobId?: string; simulateClaim?: boolean } = {}) => {
    const simulateClaim = overrides.simulateClaim !== false
    const build = createCodeGraphBuildService({ pool })
    const effectiveJobId = overrides.jobId ?? jobId
    // Simulate the worker claim that precedes dispatch; the lost-lease case
    // stages its own ownership and skips this.
    if (simulateClaim) {
      await pool.query(`
        UPDATE memory_jobs SET state = 'running', claimed_by = $2, claim_epoch = $3
        WHERE job_id = $1
      `, [effectiveJobId, overrides.claimedBy ?? 'worker-fence', overrides.claimEpoch ?? 1])
    }
    const job = await pool.query<{ idempotency_key: string; payload: Record<string, unknown> }>(`
      SELECT idempotency_key, payload FROM memory_jobs WHERE job_id = $1
    `, [effectiveJobId])
    const row = job.rows[0]
    return build.handleParseCodeSnapshot(
      {
        job_id: effectiveJobId, installation_id: installationId,
        job_type: 'parse_code_snapshot' as const,
        idempotency_key: row?.idempotency_key ?? '',
        payload: (row?.payload as Record<string, unknown>) ?? {},
        attempts: 1, claim_epoch: overrides.claimEpoch ?? 1,
      },
      new AbortController().signal,
      { fence: { jobId: effectiveJobId, claimedBy: overrides.claimedBy ?? 'worker-fence', claimEpoch: overrides.claimEpoch ?? 1 } },
    )
  }

  test('a lost job lease refuses to activate', async () => {
    await pool.query(`
      UPDATE memory_jobs SET state = 'running', claimed_by = 'someone-else', claim_epoch = 7 WHERE job_id = $1
    `, [jobId])
    await expect(run({ claimedBy: 'worker-fence', claimEpoch: 1, simulateClaim: false })).rejects.toThrow(/fence/)
    const heads = await pool.query(`
      SELECT COUNT(*)::int AS count FROM memory_code_graph_heads WHERE installation_id = $1
    `, [installationId])
    expect(heads.rows[0]!.count).toBe(0)
    const versions = await pool.query(`
      SELECT COUNT(*)::int AS count FROM memory_code_graph_versions WHERE snapshot_id = $1
    `, [snapshotId])
    expect(versions.rows[0]!.count).toBe(0)
  })

  test('a repository tombstone refuses to build or activate', async () => {
    await pool.query(`
      UPDATE memory_jobs SET claimed_by = 'worker-fence', claim_epoch = 1 WHERE job_id = $1
    `, [jobId])
    const repository = await pool.query<{ id: string }>(`
      SELECT repository_id::text AS id FROM memory_source_snapshots WHERE snapshot_id = $1
    `, [snapshotId])
    await pool.query(`
      INSERT INTO memory_repository_tombstones (installation_id, repository_id, reason_code)
      VALUES ($1, $2, 'user_purge')
    `, [installationId, repository.rows[0]!.id])
    await expect(run()).rejects.toThrow(/tombstone/)
    await pool.query(`DELETE FROM memory_repository_tombstones WHERE installation_id = $1`, [installationId])
    const versions = await pool.query(`
      SELECT COUNT(*)::int AS count FROM memory_code_graph_versions WHERE snapshot_id = $1
    `, [snapshotId])
    expect(versions.rows[0]!.count).toBe(0)
  })

  test('a snapshot tombstone refuses to build', async () => {
    await pool.query(`
      INSERT INTO memory_source_snapshot_tombstones
        (installation_id, snapshot_id, repository_id, commit_sha, reason_code)
      SELECT installation_id, snapshot_id, repository_id, commit_sha, 'snapshot_deleted'
      FROM memory_source_snapshots WHERE snapshot_id = $1
    `, [snapshotId])
    await expect(run()).rejects.toThrow(/tombstone/)
    await pool.query(`DELETE FROM memory_source_snapshot_tombstones WHERE snapshot_id = $1`, [snapshotId])
    const versions = await pool.query(`
      SELECT COUNT(*)::int AS count FROM memory_code_graph_versions WHERE snapshot_id = $1
    `, [snapshotId])
    expect(versions.rows[0]!.count).toBe(0)
  })

  test('an old generation replay cannot regress the head', async () => {
    // First activation succeeds.
    await run()
    const head = await pool.query<{ revision: string }>(`
      SELECT revision::text FROM memory_code_graph_heads h
      JOIN memory_source_snapshots s ON s.installation_id = h.installation_id AND s.repository_id = h.repository_id
      WHERE s.snapshot_id = $1
    `, [snapshotId])
    expect(head.rows[0]!.revision).toBe('1')

    // Simulate a late replay: the job no longer exists but a stale caller
    // invokes with an unknown job id; activation for an already-active
    // generation stays a no-op.
    await expect(run({ jobId: randomUUID(), simulateClaim: false })).rejects.toThrow(/fence/)
    const after = await pool.query<{ revision: string }>(`
      SELECT revision::text FROM memory_code_graph_heads h
      JOIN memory_source_snapshots s ON s.installation_id = h.installation_id AND s.repository_id = h.repository_id
      WHERE s.snapshot_id = $1
    `, [snapshotId])
    expect(after.rows[0]!.revision).toBe('1')
  })
})

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
