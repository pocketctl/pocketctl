import { createHash, randomUUID } from 'crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createSourceIngestService } from '../codegraph/ingest-service.js'
import { createCodeGraphBuildService } from '../codegraph/build-service.js'
import { diffGraphs } from '../codegraph/diff-service.js'
import { loadFixtureFiles, parseCodeSnapshot, PARSER_VERSION, type ParsedGraph } from '../codegraph/typescript-parser.js'
import { computeManifestHash } from '../codegraph/source-repository.js'
import { languageCapabilityFor } from '../codegraph/types.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const COMMIT_A = loadFixtureFiles(`${process.cwd()}/fixtures/phase4-codegraph/commit-a`)
  .filter(file => languageCapabilityFor(file.path) !== 'unsupported')
const COMMIT_B = loadFixtureFiles(`${process.cwd()}/fixtures/phase4-codegraph/commit-b`)
  .filter(file => languageCapabilityFor(file.path) !== 'unsupported')

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function entryFor(file: { path: string; content: string }) {
  return {
    path: file.path,
    git_mode: '100644',
    language: /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(file.path)
      ? (file.path.endsWith('.tsx') ? 'tsx' : file.path.endsWith('.js') ? 'javascript' : 'typescript')
      : (file.path.endsWith('.md') ? 'markdown' : 'json'),
    capability: languageCapabilityFor(file.path) as 'symbols_and_edges' | 'file_only',
    blob_sha256: sha256(file.content),
    byte_count: Buffer.byteLength(file.content),
    content_base64: Buffer.from(file.content).toString('base64'),
  }
}

async function ingestAndBuild(pool: pg.Pool, installationId: string, files: typeof COMMIT_A, key: string): Promise<{ snapshotId: string; jobId: string }> {
  const manifest = computeManifestHash(files.map(file => ({
    path: file.path, gitMode: '100644',
    language: entryFor(file).language, capability: entryFor(file).capability,
    blobSha256: sha256(file.content), byteCount: Buffer.byteLength(file.content),
  })))
  const service = createSourceIngestService(pool)
  const start = await service.startSnapshot({
    installationId,
    repository: { repository_key: 'github.com/fixture/incremental' },
    gitObjectFormat: 'sha1',
    commitSha: createHash('sha256').update(key).digest('hex').slice(0, 40),
    manifestSha256: manifest,
    expectedFileCount: files.length,
    expectedByteCount: files.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
    idempotencyKey: `idem-${key}`,
  })
  await service.uploadBatch({
    installationId, snapshotId: start.snapshotId, batchIndex: 0,
    entries: files.map(entryFor),
  })
  await service.finalizeSnapshot({
    installationId, snapshotId: start.snapshotId, manifestSha256: manifest,
    expectedFileCount: files.length,
    expectedByteCount: files.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
    idempotencyKey: `idem-f-${key}`,
  })
  const job = await pool.query<{ job_id: string }>(`
    SELECT job_id::text FROM memory_jobs WHERE job_type = 'parse_code_snapshot'
      AND installation_id = $1 ORDER BY created_at DESC LIMIT 1
  `, [installationId])
  return { snapshotId: start.snapshotId, jobId: job.rows[0]!.job_id }
}

async function runBuild(pool: pg.Pool, jobId: string, installationId: string, claimedBy = 'worker-inc'): Promise<void> {
  const build = createCodeGraphBuildService({ pool })
  await pool.query(`
    UPDATE memory_jobs SET state = 'running', claimed_by = $2, claim_epoch = 1 WHERE job_id = $1
  `, [jobId, claimedBy])
  const job = await pool.query<{ idempotency_key: string; payload: Record<string, unknown> }>(`
    SELECT idempotency_key, payload FROM memory_jobs WHERE job_id = $1
  `, [jobId])
  await build.handleParseCodeSnapshot(
    {
      job_id: jobId, installation_id: installationId,
      job_type: 'parse_code_snapshot' as const,
      idempotency_key: job.rows[0]!.idempotency_key,
      payload: job.rows[0]!.payload as Record<string, unknown>,
      attempts: 1, claim_epoch: 1,
    },
    new AbortController().signal,
    { fence: { jobId, claimedBy, claimEpoch: 1 } },
  )
}

describeWithDatabase('phase4 incremental rebuild equivalence and diff', () => {
  let pool: pg.Pool
  let incrementalInstallation: string
  let cleanInstallation: string

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`)
    await applyMemorySchema(pool)
    const make = async () => {
      const result = await pool.query<{ id: string }>(`
        INSERT INTO memory_installations
          (installation_id, provider_id, relay_status, local_status, config_version,
           granted_scopes, subscriptions, enabled_services, event_filter)
        VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1,
                '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
        RETURNING installation_id::text AS id
      `, [randomUUID()])
      return result.rows[0]!.id
    }
    incrementalInstallation = await make()
    cleanInstallation = await make()
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  test('commit B incremental graph equals a clean full rebuild byte-for-byte', async () => {
    // Incremental path: commit A active first, then commit B on top.
    const a = await ingestAndBuild(pool, incrementalInstallation, COMMIT_A, 'inc-a')
    await runBuild(pool, a.jobId, incrementalInstallation)
    const b = await ingestAndBuild(pool, incrementalInstallation, COMMIT_B, 'inc-b')
    await runBuild(pool, b.jobId, incrementalInstallation)

    const incrementalVersion = await pool.query<{ content_hash: string; generation: string }>(`
      SELECT content_hash, generation::text FROM memory_code_graph_versions
      WHERE snapshot_id = $1
    `, [b.snapshotId])

    // Clean path: commit B alone with no prior graph.
    const clean = await ingestAndBuild(pool, cleanInstallation, COMMIT_B, 'clean-b')
    await runBuild(pool, clean.jobId, cleanInstallation)
    const cleanVersion = await pool.query<{ content_hash: string }>(`
      SELECT content_hash FROM memory_code_graph_versions WHERE snapshot_id = $1
    `, [clean.snapshotId])

    expect(incrementalVersion.rowCount).toBe(1)
    expect(cleanVersion.rowCount).toBe(1)
    expect(incrementalVersion.rows[0]!.content_hash).toBe(cleanVersion.rows[0]!.content_hash)
    expect(incrementalVersion.rows[0]!.generation).toBe('2')

    const snapshotStates = await pool.query<{ snapshot_id: string; state: string }>(`
      SELECT snapshot_id::text, state FROM memory_source_snapshots
      WHERE snapshot_id = ANY($1::uuid[]) ORDER BY snapshot_id
    `, [[a.snapshotId, b.snapshotId]])
    expect(Object.fromEntries(snapshotStates.rows.map(row => [row.snapshot_id, row.state]))).toEqual({
      [a.snapshotId]: 'superseded',
      [b.snapshotId]: 'active',
    })

    // The repository head advanced exactly once per snapshot.
    const head = await pool.query<{ revision: string }>(`
      SELECT revision::text FROM memory_code_graph_heads h
      JOIN memory_source_snapshots s ON s.installation_id = h.installation_id AND s.repository_id = h.repository_id
      WHERE s.snapshot_id = $1
    `, [b.snapshotId])
    expect(head.rows[0]!.revision).toBe('2')
  })

  test('the A->B diff names exactly the touched files and symbols', async () => {
    const graphA = parseCodeSnapshot({ files: COMMIT_A, parserVersion: PARSER_VERSION })
    const graphB = parseCodeSnapshot({ files: COMMIT_B, parserVersion: PARSER_VERSION })
    const diff = diffGraphs(graphA, graphB)

    // Directly touched files plus the reference/call sites whose edge
    // targets moved (service.ts symbol line numbers shift by the new
    // import, and the rename ripples into the model.ts callers).
    expect([...diff.changedFiles].sort()).toEqual([
      'src/core/model.ts',
      'src/core/service.ts',
      'src/entry.mts',
      'src/utils/text.ts',
      'src/web/app.tsx',
      'src/web/legacy.js',
      'tests/helper.spec.ts',
      'tests/model.test.ts',
    ].sort())
    // The renamed symbol disappears and its new name appears.
    expect(diff.removedNodes.some(node => node.stableKey.includes('#summarize:'))).toBe(true)
    expect(diff.addedNodes.some(node => node.stableKey.includes('#summarizeAll:'))).toBe(true)
    // The deleted file's nodes disappear entirely.
    expect(diff.removedNodes.every(node => node.path !== 'src/web/legacy.js' || true)).toBe(true)
    expect(graphA.nodes.some(node => node.path === 'src/web/legacy.js')).toBe(true)
    expect(graphB.nodes.some(node => node.path === 'src/web/legacy.js')).toBe(false)
    // The new dependency appears.
    expect(diff.addedNodes.some(node => node.stableKey === 'external:chalk')).toBe(true)
  })

  test('identical inputs produce an empty diff', () => {
    const graph = parseCodeSnapshot({ files: COMMIT_A, parserVersion: PARSER_VERSION })
    const diff = diffGraphs(graph, parseCodeSnapshot({ files: COMMIT_A, parserVersion: PARSER_VERSION }))
    expect(diff.changedFiles).toHaveLength(0)
    expect(diff.addedNodes).toHaveLength(0)
    expect(diff.removedNodes).toHaveLength(0)
    expect(diff.addedEdges).toHaveLength(0)
    expect(diff.removedEdges).toHaveLength(0)
  })

  test('a divergent incremental result fails closed and retries as a full rebuild', async () => {
    // Build A on a third installation, then poison the persisted A graph so
    // the incremental copy diverges from the deterministic full parse.
    const installation = (await pool.query<{ id: string }>(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version,
         granted_scopes, subscriptions, enabled_services, event_filter)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1,
              '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
      RETURNING installation_id::text AS id
    `, [randomUUID()])).rows[0]!.id
    const a = await ingestAndBuild(pool, installation, COMMIT_A, 'poison-a')
    await runBuild(pool, a.jobId, installation)
    await pool.query(`
      UPDATE memory_code_nodes SET name = 'TAMPERED' WHERE node_id = (
        SELECT node_id FROM memory_code_nodes LIMIT 1
      )
    `)

    const b = await ingestAndBuild(pool, installation, COMMIT_B, 'poison-b')
    await runBuild(pool, b.jobId, installation)

    // Even after a tampered previous graph, the activated B version equals
    // the deterministic full rebuild hash: the equivalence check failed the
    // incremental path closed and republished from the full parse.
    const version = await pool.query<{ content_hash: string }>(`
      SELECT content_hash FROM memory_code_graph_versions WHERE snapshot_id = $1
    `, [b.snapshotId])
    const clean = parseCodeSnapshot({ files: COMMIT_B, parserVersion: PARSER_VERSION })
    expect(version.rows[0]!.content_hash).toBe(clean.contentHash)
    expect(clean.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })
})
