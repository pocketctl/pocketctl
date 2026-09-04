import { createHash, randomUUID } from 'crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createSourceIngestService } from '../codegraph/ingest-service.js'
import { createMemoryMetrics } from '../metrics.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const COMMIT = 'a'.repeat(40)
const OTHER_COMMIT = 'e'.repeat(40)

function manifestFor(entries: Array<{ path: string; sha: string; bytes: number; mode?: string; language?: string; capability?: string }>): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const hash = createHash('sha256')
  for (const entry of sorted) {
    hash.update(`${entry.path}\t${entry.mode ?? '100644'}\t${entry.language ?? 'typescript'}\t${entry.capability ?? 'symbols_and_edges'}\t${entry.sha}\t${entry.bytes}\n`)
  }
  return hash.digest('hex')
}

function contentEntry(path: string, content: string, overrides: Record<string, unknown> = {}) {
  return {
    path,
    git_mode: '100644',
    language: 'typescript',
    capability: 'symbols_and_edges',
    blob_sha256: createHash('sha256').update(content).digest('hex'),
    byte_count: Buffer.byteLength(content),
    content_base64: Buffer.from(content).toString('base64'),
    ...overrides,
  }
}

describeWithDatabase('phase4 source snapshot ingestion', () => {
  let pool: pg.Pool
  let installationA: string
  let installationB: string

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`)
    await applyMemorySchema(pool)
    const makeInstallation = async () => {
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
    installationA = await makeInstallation()
    installationB = await makeInstallation()
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  test('start/batch/finalize are idempotent and enqueue exactly one parse job', async () => {
    const metrics = createMemoryMetrics()
    const service = createSourceIngestService(pool, { metrics: metrics.phase4 })
    const content = 'export const a = 1;\n'
    const entry = contentEntry('src/a.ts', content)
    const manifest = manifestFor([{ path: 'src/a.ts', sha: entry.blob_sha256, bytes: entry.byte_count }])

    const start = await service.startSnapshot({
      installationId: installationA,
      repository: { repository_key: 'github.com/example/repo', canonical_remote: 'https://github.com/example/repo.git' },
      gitObjectFormat: 'sha1',
      commitSha: COMMIT,
      manifestSha256: manifest,
      expectedFileCount: 1,
      expectedByteCount: entry.byte_count,
      idempotencyKey: 'idem-start-1',
    })
    expect(start.snapshotId).toBeTruthy()
    expect(start.repositoryId).toBeTruthy()

    // Re-running start with the same manifest replays the same snapshot.
    const replay = await service.startSnapshot({
      installationId: installationA,
      repository: { repository_key: 'github.com/example/repo' },
      gitObjectFormat: 'sha1',
      commitSha: COMMIT,
      manifestSha256: manifest,
      expectedFileCount: 1,
      expectedByteCount: entry.byte_count,
      idempotencyKey: 'idem-start-1',
    })
    expect(replay.snapshotId).toBe(start.snapshotId)
    expect(replay.repositoryId).toBe(start.repositoryId)

    // No parse job exists before a complete finalization.
    const jobsBefore = await pool.query(
      `SELECT 1 FROM memory_jobs WHERE job_type = 'parse_code_snapshot' AND installation_id = $1`,
      [installationA],
    )
    expect(jobsBefore.rowCount).toBe(0)

    await expect(service.uploadBatch({
      installationId: installationA, snapshotId: start.snapshotId,
      batchIndex: 0, entries: [entry],
    })).resolves.toMatchObject({ accepted: 1 })

    // Repeating an identical file under a different batch identity is a
    // storage no-op and must not double-count accepted source bytes.
    await expect(service.uploadBatch({
      installationId: installationA, snapshotId: start.snapshotId,
      batchIndex: 1, entries: [entry],
    })).resolves.toMatchObject({ accepted: 1 })

    // A byte-identical batch retry is accepted as a no-op.
    await expect(service.uploadBatch({
      installationId: installationA, snapshotId: start.snapshotId,
      batchIndex: 0, entries: [entry],
    })).resolves.toMatchObject({ accepted: 1 })

    const finalize = await service.finalizeSnapshot({
      installationId: installationA, snapshotId: start.snapshotId,
      manifestSha256: manifest, expectedFileCount: 1,
      expectedByteCount: entry.byte_count, idempotencyKey: 'idem-finalize-1',
    })
    expect(finalize.state).toBe('ready')

    // Finalize replay stays a bounded no-op.
    const finalizeReplay = await service.finalizeSnapshot({
      installationId: installationA, snapshotId: start.snapshotId,
      manifestSha256: manifest, expectedFileCount: 1,
      expectedByteCount: entry.byte_count, idempotencyKey: 'idem-finalize-1',
    })
    expect(finalizeReplay.state).toBe('ready')
    const finalizeNewKey = await service.finalizeSnapshot({
      installationId: installationA, snapshotId: start.snapshotId,
      manifestSha256: manifest, expectedFileCount: 1,
      expectedByteCount: entry.byte_count, idempotencyKey: 'idem-finalize-2',
    })
    expect(finalizeNewKey.state).toBe('ready')

    const jobs = await pool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM memory_jobs
       WHERE job_type = 'parse_code_snapshot' AND installation_id = $1`,
      [installationA],
    )
    expect(jobs.rowCount).toBe(1)
    expect(jobs.rows[0]!.idempotency_key).toBe(`parse_code_snapshot:${start.snapshotId}:0`)

    await expect(service.finalizeSnapshot({
      installationId: installationA, snapshotId: start.snapshotId,
      manifestSha256: '0'.repeat(64), expectedFileCount: 1,
      expectedByteCount: entry.byte_count, idempotencyKey: 'idem-finalize-1',
    })).rejects.toThrow(/idempotency_conflict/)

    // After ready, further batch uploads are refused.
    await expect(service.uploadBatch({
      installationId: installationA, snapshotId: start.snapshotId,
      batchIndex: 2, entries: [contentEntry('src/b.ts', 'export const b = 2;\n')],
    })).rejects.toThrow(/state_conflict/)

    const metricText = await metrics.registry.metrics()
    expect(metricText).toContain('pocketctl_memory_code_snapshot_total{result="accepted",source_kind="personal"} 1')
    expect(metricText).toContain(`pocketctl_memory_code_snapshot_bytes{language_class="typescript"} ${entry.byte_count}`)
  })

  test('rejects same start or batch idempotency identity with different content', async () => {
    const service = createSourceIngestService(pool)
    const first = contentEntry('src/idempotent-a.ts', 'export const a = 1')
    const second = contentEntry('src/idempotent-b.ts', 'export const b = 2')
    const manifest = manifestFor([
      { path: first.path, sha: first.blob_sha256, bytes: first.byte_count },
      { path: second.path, sha: second.blob_sha256, bytes: second.byte_count },
    ])
    const start = await service.startSnapshot({
      installationId: installationA,
      repository: { repository_key: 'github.com/example/idempotency' },
      gitObjectFormat: 'sha1', commitSha: 'd'.repeat(40),
      manifestSha256: manifest, expectedFileCount: 2,
      expectedByteCount: first.byte_count + second.byte_count,
      idempotencyKey: 'idem-start-conflict',
    })
    await expect(service.startSnapshot({
      installationId: installationA,
      repository: { repository_key: 'github.com/example/idempotency' },
      gitObjectFormat: 'sha1', commitSha: 'c'.repeat(40),
      manifestSha256: 'b'.repeat(64), expectedFileCount: 1,
      expectedByteCount: 1, idempotencyKey: 'idem-start-conflict',
    })).rejects.toThrow(/idempotency_conflict/)

    await expect(service.uploadBatch({
      installationId: installationA, snapshotId: start.snapshotId,
      batchIndex: 0, entries: [first],
    })).resolves.toMatchObject({ accepted: 1 })
    await expect(service.uploadBatch({
      installationId: installationA, snapshotId: start.snapshotId,
      batchIndex: 0, entries: [second],
    })).rejects.toThrow(/integrity_mismatch/)
  })

  test('content hash mismatch and duplicate path are integrity failures', async () => {
    const service = createSourceIngestService(pool)
    const manifest = 'f'.repeat(64)
    const start = await service.startSnapshot({
      installationId: installationA,
      repository: { repository_key: 'github.com/example/repo' },
      gitObjectFormat: 'sha1',
      commitSha: OTHER_COMMIT,
      manifestSha256: manifest,
      expectedFileCount: 1,
      expectedByteCount: 19,
      idempotencyKey: 'idem-mismatch',
    })
    const lying = contentEntry('src/lie.ts', 'real content')
    lying.blob_sha256 = '0'.repeat(64) // claims a different hash
    await expect(service.uploadBatch({
      installationId: installationA, snapshotId: start.snapshotId,
      batchIndex: 0, entries: [lying],
    })).rejects.toThrow(/integrity_mismatch/)

    // Duplicate path inside one batch is an invalid request.
    const a = contentEntry('src/dup.ts', 'a')
    const a2 = contentEntry('src/dup.ts', 'b')
    await expect(service.uploadBatch({
      installationId: installationA, snapshotId: start.snapshotId,
      batchIndex: 0, entries: [a, a2],
    })).rejects.toThrow(/invalid_request/)

    // A cross-batch duplicate with different bytes conflicts.
    await expect(service.uploadBatch({
      installationId: installationA, snapshotId: start.snapshotId,
      batchIndex: 0, entries: [contentEntry('src/x.ts', 'first')],
    })).resolves.toBeTruthy()
    await expect(service.uploadBatch({
      installationId: installationA, snapshotId: start.snapshotId,
      batchIndex: 1, entries: [contentEntry('src/x.ts', 'second')],
    })).rejects.toThrow(/integrity_mismatch/)
  })

  test('wrong capability and language claims are rejected', async () => {
    const service = createSourceIngestService(pool)
    const start = await service.startSnapshot({
      installationId: installationA,
      repository: { repository_key: 'github.com/example/repo' },
      gitObjectFormat: 'sha1',
      commitSha: '1'.repeat(40),
      manifestSha256: '2'.repeat(64),
      expectedFileCount: 1,
      expectedByteCount: 3,
      idempotencyKey: 'idem-capability',
    })
    // A .ts path must not claim file_only.
    await expect(service.uploadBatch({
      installationId: installationA, snapshotId: start.snapshotId,
      batchIndex: 0, entries: [contentEntry('src/wrong.ts', 'abc', { capability: 'file_only' })],
    })).rejects.toThrow(/invalid_request/)
    // A .md path must not claim symbols_and_edges.
    await expect(service.uploadBatch({
      installationId: installationA, snapshotId: start.snapshotId,
      batchIndex: 0, entries: [contentEntry('doc.md', 'abc', { capability: 'symbols_and_edges', language: 'typescript' })],
    })).rejects.toThrow(/invalid_request/)
  })

  test('finalize verifies counts, bytes, and the manifest hash', async () => {
    const service = createSourceIngestService(pool)
    const entry = contentEntry('src/f.ts', 'finalize me')
    const manifest = manifestFor([{ path: 'src/f.ts', sha: entry.blob_sha256, bytes: entry.byte_count }])
    const start = await service.startSnapshot({
      installationId: installationA,
      repository: { repository_key: 'github.com/example/repo' },
      gitObjectFormat: 'sha1',
      commitSha: '3'.repeat(40),
      manifestSha256: manifest,
      expectedFileCount: 2, // lies: one more file than uploaded
      expectedByteCount: entry.byte_count,
      idempotencyKey: 'idem-missing',
    })
    await service.uploadBatch({
      installationId: installationA, snapshotId: start.snapshotId,
      batchIndex: 0, entries: [entry],
    })
    await expect(service.finalizeSnapshot({
      installationId: installationA, snapshotId: start.snapshotId,
      manifestSha256: manifest, expectedFileCount: 2,
      expectedByteCount: entry.byte_count, idempotencyKey: 'idem-missing-f',
    })).rejects.toThrow(/manifest_mismatch/)

    // Fix the declared count, but lie about the manifest hash itself.
    await expect(service.finalizeSnapshot({
      installationId: installationA, snapshotId: start.snapshotId,
      manifestSha256: '4'.repeat(64), expectedFileCount: 1,
      expectedByteCount: entry.byte_count, idempotencyKey: 'idem-missing-f',
    })).rejects.toThrow(/manifest_mismatch/)

    // The correct declaration finalizes.
    await expect(service.finalizeSnapshot({
      installationId: installationA, snapshotId: start.snapshotId,
      manifestSha256: manifest, expectedFileCount: 1,
      expectedByteCount: entry.byte_count, idempotencyKey: 'idem-missing-f',
    })).resolves.toMatchObject({ state: 'ready' })
  })

  test('aggregate caps and per-file bounds are enforced at start and upload', async () => {
    const service = createSourceIngestService(pool)
    await expect(service.startSnapshot({
      installationId: installationA,
      repository: { repository_key: 'github.com/example/repo' },
      gitObjectFormat: 'sha1',
      commitSha: '5'.repeat(40),
      manifestSha256: '6'.repeat(64),
      expectedFileCount: 5001,
      expectedByteCount: 10,
      idempotencyKey: 'idem-caps-1',
    })).rejects.toThrow(/invalid_request/)

    await expect(service.startSnapshot({
      installationId: installationA,
      repository: { repository_key: 'github.com/example/repo' },
      gitObjectFormat: 'sha1',
      commitSha: '5'.repeat(40),
      manifestSha256: '6'.repeat(64),
      expectedFileCount: 1,
      expectedByteCount: (64 << 20) + 1,
      idempotencyKey: 'idem-caps-2',
    })).rejects.toThrow(/invalid_request/)

    const bounded = await service.startSnapshot({
      installationId: installationA,
      repository: { repository_key: 'github.com/example/repo' },
      gitObjectFormat: 'sha1',
      commitSha: '5'.repeat(40),
      manifestSha256: '6'.repeat(64),
      expectedFileCount: 1,
      expectedByteCount: 10,
      idempotencyKey: 'idem-caps-3',
    })
    const huge = 'x'.repeat(256 * 1024 + 1)
    await expect(service.uploadBatch({
      installationId: installationA, snapshotId: bounded.snapshotId,
      batchIndex: 0, entries: [contentEntry('src/huge.ts', huge)],
    })).rejects.toThrow(/invalid_request/)
  })

  test('blobs are installation-scoped: another tenant re-uploads independently', async () => {
    const service = createSourceIngestService(pool)
    const content = 'shared bytes'
    const entry = contentEntry('src/shared.ts', content)
    const manifest = manifestFor([{ path: 'src/shared.ts', sha: entry.blob_sha256, bytes: entry.byte_count }])

    for (const installationId of [installationA, installationB]) {
      const start = await service.startSnapshot({
        installationId,
        repository: { repository_key: 'github.com/example/repo' },
        gitObjectFormat: 'sha1',
        commitSha: '7'.repeat(40),
        manifestSha256: manifest,
        expectedFileCount: 1,
        expectedByteCount: entry.byte_count,
        idempotencyKey: `idem-${installationId}`,
      })
      await service.uploadBatch({
        installationId, snapshotId: start.snapshotId, batchIndex: 0, entries: [entry],
      })
      await expect(service.finalizeSnapshot({
        installationId, snapshotId: start.snapshotId,
        manifestSha256: manifest, expectedFileCount: 1,
        expectedByteCount: entry.byte_count, idempotencyKey: `idem-f-${installationId}`,
      })).resolves.toMatchObject({ state: 'ready' })
    }
    // Two independent blob rows: no global content table exists.
    const blobs = await pool.query(
      `SELECT installation_id::text FROM memory_source_blobs WHERE blob_hash = $1`,
      [entry.blob_sha256],
    )
    expect(blobs.rowCount).toBe(2)

    // Installation B cannot touch installation A's snapshot.
    const foreign = await pool.query<{ snapshot_id: string }>(`
      SELECT snapshot_id::text FROM memory_source_snapshots WHERE installation_id = $1 LIMIT 1
    `, [installationA])
    await expect(service.uploadBatch({
      installationId: installationB, snapshotId: foreign.rows[0]!.snapshot_id,
      batchIndex: 0, entries: [entry],
    })).rejects.toThrow(/not_found/)
    await expect(service.finalizeSnapshot({
      installationId: installationB, snapshotId: foreign.rows[0]!.snapshot_id,
      manifestSha256: manifest, expectedFileCount: 1,
      expectedByteCount: entry.byte_count, idempotencyKey: 'idem-foreign',
    })).rejects.toThrow(/not_found/)
  })

  test('abort removes a staging snapshot and its entries', async () => {
    const service = createSourceIngestService(pool)
    const entry = contentEntry('src/abort.ts', 'bye')
    const startInput = {
      installationId: installationA,
      repository: { repository_key: 'github.com/example/repo' },
      gitObjectFormat: 'sha1',
      commitSha: '8'.repeat(40),
      manifestSha256: '9'.repeat(64),
      expectedFileCount: 1,
      expectedByteCount: entry.byte_count,
      idempotencyKey: 'idem-abort',
    }
    const start = await service.startSnapshot(startInput)
    await service.uploadBatch({
      installationId: installationA, snapshotId: start.snapshotId,
      batchIndex: 0, entries: [entry],
    })
    await expect(service.abortSnapshot({ installationId: installationA, snapshotId: start.snapshotId }))
      .resolves.toBeTruthy()
    const entries = await pool.query(
      `SELECT 1 FROM memory_source_snapshot_entries WHERE snapshot_id = $1`,
      [start.snapshotId],
    )
    expect(entries.rowCount).toBe(0)
    const snapshot = await pool.query<{ state: string }>(
      `SELECT state FROM memory_source_snapshots WHERE snapshot_id = $1`,
      [start.snapshotId],
    )
    expect(snapshot.rows[0]!.state).toBe('failed')
    await expect(service.startSnapshot(startInput)).rejects.toThrow(/state_conflict/)
    // Aborting a foreign installation's snapshot reads as not found.
    await expect(service.abortSnapshot({ installationId: installationB, snapshotId: start.snapshotId }))
      .rejects.toThrow(/not_found/)
  })
})
