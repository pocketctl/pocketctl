import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createWikiManualService } from '../wiki/manual-service.js'
import { createWikiPublicationService } from '../wiki/publication-service.js'
import { createWikiStaleService } from '../wiki/stale-service.js'
import { insertWikiCandidateFixture } from './helpers/phase4-wiki-fixture.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const describeWithDatabase = databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1'
  ? describe
  : describe.skip

describeWithDatabase('Phase 4 Wiki stale projection', () => {
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

  test('marks only generated sections bound to changed file/symbol keys', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'stale-diff')
    const manual = createWikiManualService(pool)
    await manual.edit({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, sectionKey: 'manual-notes', markdown: 'preserve me',
      expectedLockVersion: 0,
    })
    await createWikiPublicationService(pool).publish({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, runId: fixture.runId,
      expectedGeneration: 1, expectedHeadRevision: 0,
    })
    const activeVersion = (await pool.query<{ id: string }>(`
      SELECT active_version_id::text AS id FROM memory_wiki_heads WHERE wiki_id = $1
    `, [fixture.wikiId])).rows[0]!.id

    const unchangedNodeId = randomUUID()
    const unchangedToken = 'src_unchanged'
    const unchangedBlob = createHash('sha256').update('unchanged').digest('hex')
    await pool.query(`
      INSERT INTO memory_source_blobs (installation_id, blob_hash, byte_count, utf8_content)
      VALUES ($1, $2, 9, 'unchanged')
    `, [fixture.installationId, unchangedBlob])
    await pool.query(`
      INSERT INTO memory_source_snapshot_entries
        (snapshot_id, installation_id, path, blob_hash, language, capability, byte_count, mode)
      VALUES ($1, $2, 'README.md', $3, 'markdown', 'file_only', 9, '100644')
    `, [fixture.snapshotId, fixture.installationId, unchangedBlob])
    await pool.query(`
      INSERT INTO memory_code_nodes
        (graph_version_id, installation_id, node_id, kind, stable_key, path, name, metadata)
      VALUES ($1, $2, $3, 'file', 'file:README.md', 'README.md', 'README.md', '{}'::jsonb)
    `, [fixture.graphVersionId, fixture.installationId, unchangedNodeId])
    await pool.query(`
      INSERT INTO memory_wiki_build_sources
        (run_id, installation_id, source_token, ordinal, source_kind, stable_key,
         source_ref_id, source_snapshot_id, commit_sha, path, content_hash)
      VALUES ($1, $2, $3, 1, 'file', 'file:README.md', $4, $5, $6, 'README.md', $7)
    `, [fixture.runId, fixture.installationId, unchangedToken, unchangedNodeId,
      fixture.snapshotId, fixture.commitSha, unchangedBlob])
    const page = (await pool.query<{ page_id: string }>(`
      SELECT page_id::text FROM memory_wiki_pages WHERE wiki_version_id = $1 LIMIT 1
    `, [activeVersion])).rows[0]!.page_id
    const sectionId = randomUUID()
    await pool.query(`
      INSERT INTO memory_wiki_sections
        (wiki_version_id, installation_id, section_id, page_id, section_key,
         heading, markdown, authority, coverage, position)
      VALUES ($1, $2, $3, $4, 'unchanged-doc', 'Unchanged', 'still valid',
              'generated', 'partial', 10)
    `, [activeVersion, fixture.installationId, sectionId, page])
    await pool.query(`
      INSERT INTO memory_wiki_source_bindings
        (wiki_version_id, installation_id, section_id, binding_id, source_kind,
         source_token, source_snapshot_id, commit_sha)
      VALUES ($1, $2, $3, $4, 'file', $5, $6, $7)
    `, [activeVersion, fixture.installationId, sectionId, randomUUID(),
      unchangedToken, fixture.snapshotId, fixture.commitSha])

    const nextSnapshot = randomUUID()
    const nextGraph = randomUUID()
    const changedBlob = createHash('sha256').update('changed').digest('hex')
    const nextCommit = createHash('sha1').update('next-stale').digest('hex')
    await pool.query(`
      INSERT INTO memory_source_snapshots
        (snapshot_id, installation_id, repository_id, commit_sha, git_object_format,
         manifest_hash, state, generation, parser_matrix_version, file_count, byte_count, completed_at)
      VALUES ($1, $2, $3, $4, 'sha1', $5, 'ready', 2, 'phase4-v1', 2, 16, NOW())
    `, [nextSnapshot, fixture.installationId, fixture.repositoryId, nextCommit, 'd'.repeat(64)])
    await pool.query(`
      INSERT INTO memory_source_blobs (installation_id, blob_hash, byte_count, utf8_content)
      VALUES ($1, $2, 7, 'changed')
    `, [fixture.installationId, changedBlob])
    await pool.query(`
      INSERT INTO memory_source_snapshot_entries
        (snapshot_id, installation_id, path, blob_hash, language, capability, byte_count, mode)
      VALUES
        ($1, $2, 'src/index.ts', $3, 'typescript', 'symbols_and_edges', 7, '100644'),
        ($1, $2, 'README.md', $4, 'markdown', 'file_only', 9, '100644')
    `, [nextSnapshot, fixture.installationId, changedBlob, unchangedBlob])
    await pool.query(`
      INSERT INTO memory_code_graph_versions
        (graph_version_id, installation_id, repository_id, snapshot_id, generation,
         parser_version, state, coverage, content_hash)
      VALUES ($1, $2, $3, $4, 2, 'typescript-5.7-phase4-v1', 'candidate',
              'partial', $5)
    `, [nextGraph, fixture.installationId, fixture.repositoryId, nextSnapshot,
      createHash('sha256').update('next-graph').digest('hex')])
    await pool.query(`
      INSERT INTO memory_code_nodes
        (graph_version_id, installation_id, node_id, kind, stable_key, path, name, metadata)
      VALUES
        ($1, $2, $3, 'file', 'file:src/index.ts', 'src/index.ts', 'src/index.ts', '{}'::jsonb),
        ($1, $2, $4, 'file', 'file:README.md', 'README.md', 'README.md', '{}'::jsonb)
    `, [nextGraph, fixture.installationId, randomUUID(), randomUUID()])

    await createWikiStaleService(pool).markForGraphActivation({
      installationId: fixture.installationId,
      repositoryId: fixture.repositoryId,
      graphVersionId: nextGraph,
      snapshotId: nextSnapshot,
    })
    const marks = await pool.query<{ section_key: string; reason: string }>(`
      SELECT section_key, reason FROM memory_wiki_stale_marks WHERE wiki_id = $1 ORDER BY section_key
    `, [fixture.wikiId])
    expect(marks.rows).toEqual([{ section_key: 'generated-overview', reason: 'source_file_changed' }])
    const manualText = await pool.query<{ markdown: string }>(`
      SELECT markdown FROM memory_wiki_manual_section_versions WHERE wiki_id = $1
    `, [fixture.wikiId])
    expect(manualText.rows).toEqual([{ markdown: 'preserve me' }])

    await createWikiStaleService(pool).markForGraphActivation({
      installationId: fixture.installationId,
      repositoryId: fixture.repositoryId,
      graphVersionId: fixture.graphVersionId,
      snapshotId: fixture.snapshotId,
    })
    expect((await pool.query(
      `SELECT 1 FROM memory_wiki_stale_marks WHERE wiki_id = $1 AND cleared_at IS NULL`,
      [fixture.wikiId],
    )).rowCount).toBe(0)
  })

  test('a valid publication clears prior derived stale marks in the same transaction', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'stale-clear')
    await pool.query(`
      INSERT INTO memory_wiki_stale_marks
        (installation_id, wiki_id, section_key, reason, source_snapshot_id, graph_version_id)
      VALUES ($1, $2, 'generated-overview', 'graph_rebuilt', $3, $4)
    `, [fixture.installationId, fixture.wikiId, fixture.snapshotId, fixture.graphVersionId])
    await createWikiPublicationService(pool).publish({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, runId: fixture.runId,
      expectedGeneration: 1, expectedHeadRevision: 0,
    })
    expect((await pool.query(`SELECT 1 FROM memory_wiki_stale_marks WHERE wiki_id = $1`, [fixture.wikiId])).rowCount).toBe(0)
  })
})
