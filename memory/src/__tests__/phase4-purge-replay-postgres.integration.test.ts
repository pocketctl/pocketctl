import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { createSourceIngestService } from '../codegraph/ingest-service.js'
import { createPurgeRepository } from '../purge/repository.js'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createWikiPublicationService } from '../wiki/publication-service.js'
import { insertWikiCandidateFixture } from './helpers/phase4-wiki-fixture.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const describeWithDatabase = databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1'
  ? describe
  : describe.skip

describeWithDatabase('Phase 4 purge and replay fences', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
  })
  afterAll(async () => pool?.end())
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`)
    await applyMemorySchema(pool)
  }, 120_000)

  test('repository purge commits a terminal fence, clears all derived content, and replay cannot resurrect', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'repo-purge')
    const ingest = createSourceIngestService(pool)
    const replayInput = {
      installationId: fixture.installationId,
      repository: { repository_key: 'fixture/repo-purge' },
      gitObjectFormat: 'sha1', commitSha: 'd'.repeat(40),
      manifestSha256: 'e'.repeat(64), expectedFileCount: 1,
      expectedByteCount: 1, idempotencyKey: 'before-purge',
    }
    await expect(ingest.startSnapshot(replayInput)).resolves.toMatchObject({ state: 'staging' })
    const purge = createPurgeRepository(pool, { hmacKey: 'phase4-purge-test-key' })
    await purge.purgeRepository({
      installationId: fixture.installationId,
      repositoryId: fixture.repositoryId,
      reasonCode: 'user_delete',
    })
    expect((await pool.query(`SELECT 1 FROM memory_repository_tombstones WHERE repository_id = $1`, [fixture.repositoryId])).rowCount).toBe(1)
    for (const table of [
      'memory_source_snapshots', 'memory_code_graph_versions', 'memory_code_graph_heads',
      'memory_wikis', 'memory_wiki_build_runs', 'memory_wiki_build_candidates',
      'memory_wiki_heads', 'memory_source_blobs',
    ]) {
      const left = await pool.query<{ count: number }>(`
        SELECT COUNT(*)::int AS count FROM ${table} WHERE installation_id = $1
      `, [fixture.installationId])
      expect(left.rows[0]!.count, table).toBe(0)
    }
    await expect(createWikiPublicationService(pool).publish({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, runId: fixture.runId,
      expectedGeneration: 1, expectedHeadRevision: 0,
    })).rejects.toThrow()
    await expect(createSourceIngestService(pool).startSnapshot({
      installationId: fixture.installationId,
      repository: { repository_key: 'fixture/repo-purge' },
      gitObjectFormat: 'sha1', commitSha: fixture.commitSha,
      manifestSha256: 'e'.repeat(64), expectedFileCount: 1,
      expectedByteCount: 1, idempotencyKey: 'replay',
    })).rejects.toThrow(/repository_tombstoned/)
    await expect(ingest.startSnapshot(replayInput)).rejects.toThrow(/repository_tombstoned/)
    await expect(purge.purgeRepository({
      installationId: fixture.installationId,
      repositoryId: fixture.repositoryId,
      reasonCode: 'replay',
    })).resolves.toEqual({ purged: false })
  })

  test('snapshot purge removes its active heads without falling back to an older version', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'snapshot-purge')
    await createWikiPublicationService(pool).publish({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, runId: fixture.runId,
      expectedGeneration: 1, expectedHeadRevision: 0,
    })
    const purge = createPurgeRepository(pool, { hmacKey: 'phase4-purge-test-key' })
    await purge.purgeSourceSnapshot({
      installationId: fixture.installationId,
      snapshotId: fixture.snapshotId,
      reasonCode: 'source_delete',
    })
    expect((await pool.query(`SELECT 1 FROM memory_source_snapshot_tombstones WHERE snapshot_id = $1`, [fixture.snapshotId])).rowCount).toBe(1)
    expect((await pool.query(`SELECT 1 FROM memory_code_graph_heads WHERE repository_id = $1`, [fixture.repositoryId])).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM memory_wiki_heads WHERE repository_id = $1`, [fixture.repositoryId])).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM memory_wikis WHERE wiki_id = $1`, [fixture.wikiId])).rowCount).toBe(1)
  })

  test('30-day cleanup removes only unpinned superseded snapshots and orphan blobs', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'retention')
    const oldSnapshot = randomUUID()
    const oldBlob = createHash('sha256').update('old-unpinned').digest('hex')
    const oldCommit = createHash('sha1').update('old-unpinned').digest('hex')
    await pool.query(`
      INSERT INTO memory_source_snapshots
        (snapshot_id, installation_id, repository_id, commit_sha, git_object_format,
         manifest_hash, state, generation, parser_matrix_version, file_count, byte_count,
         completed_at, created_at)
      VALUES ($1, $2, $3, $4, 'sha1', $5, 'superseded', 0, 'phase4-v1', 1, 4,
              NOW() - INTERVAL '31 days', NOW() - INTERVAL '31 days')
    `, [oldSnapshot, fixture.installationId, fixture.repositoryId, oldCommit, 'f'.repeat(64)])
    await pool.query(`
      INSERT INTO memory_source_blobs (installation_id, blob_hash, byte_count, utf8_content)
      VALUES ($1, $2, 4, 'old!')
    `, [fixture.installationId, oldBlob])
    await pool.query(`
      INSERT INTO memory_source_snapshot_entries
        (snapshot_id, installation_id, path, blob_hash, language, capability, byte_count, mode)
      VALUES ($1, $2, 'OLD.md', $3, 'markdown', 'file_only', 4, '100644')
    `, [oldSnapshot, fixture.installationId, oldBlob])
    await pool.query(`UPDATE memory_source_snapshots SET state = 'superseded', created_at = NOW() - INTERVAL '31 days' WHERE snapshot_id = $1`, [fixture.snapshotId])

    const purge = createPurgeRepository(pool, { hmacKey: 'phase4-purge-test-key' })
    await expect(purge.cleanupSupersededSnapshots({ limit: 10 })).resolves.toEqual({ snapshots: 1, blobs: 1 })
    expect((await pool.query(`SELECT 1 FROM memory_source_snapshots WHERE snapshot_id = $1`, [oldSnapshot])).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM memory_source_snapshots WHERE snapshot_id = $1`, [fixture.snapshotId])).rowCount).toBe(1)
  })
})
