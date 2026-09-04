import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createWikiPublicationService } from '../wiki/publication-service.js'
import { createWikiManualService } from '../wiki/manual-service.js'
import { insertWikiCandidateFixture } from './helpers/phase4-wiki-fixture.js'
import { createMemoryMetrics } from '../metrics.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const describeWithDatabase = databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1'
  ? describe
  : describe.skip

describeWithDatabase('Phase 4 governed Wiki publication', () => {
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

  test('candidate remains invisible until one atomic head switch and concurrent CAS publishes once', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'atomic')
    const metrics = createMemoryMetrics()
    const publication = createWikiPublicationService(pool, { metrics: metrics.phase4 })
    expect((await pool.query(`SELECT 1 FROM memory_wiki_heads WHERE wiki_id = $1`, [fixture.wikiId])).rowCount).toBe(0)

    const attempts = await Promise.allSettled([0, 1].map(() => publication.publish({
      grant: fixture.grant,
      targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId,
      runId: fixture.runId,
      expectedGeneration: 1,
      expectedHeadRevision: 0,
    })))
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1)
    const head = await pool.query<{ revision: string }>(`
      SELECT revision::text FROM memory_wiki_heads WHERE wiki_id = $1
    `, [fixture.wikiId])
    expect(head.rows).toEqual([{ revision: '1' }])
    expect((await pool.query(`SELECT 1 FROM memory_wiki_source_bindings WHERE installation_id = $1`, [fixture.installationId])).rowCount).toBe(1)
    expect((await pool.query(`SELECT 1 FROM memory_wiki_audit_events WHERE action = 'publish' AND result = 'success'`, [])).rowCount).toBe(1)
    const metricText = await metrics.registry.metrics()
    expect(metricText).toContain('pocketctl_memory_wiki_publications_total{result="published"} 1')
    expect(metricText).toContain('pocketctl_memory_wiki_publications_total{result="conflict"} 1')
  })

  test('rechecks generation, authorization, tombstones, and exact source existence at commit time', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'fences')
    const publication = createWikiPublicationService(pool)
    const input = {
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, runId: fixture.runId,
      expectedGeneration: 1, expectedHeadRevision: 0,
    }
    await pool.query(`UPDATE memory_wikis SET generation = 2 WHERE wiki_id = $1`, [fixture.wikiId])
    await expect(publication.publish(input)).rejects.toThrow(/stale_generation/)
    await pool.query(`UPDATE memory_wikis SET generation = 1 WHERE wiki_id = $1`, [fixture.wikiId])
    await pool.query(`UPDATE memory_installations SET relay_status = 'revoked' WHERE installation_id = $1`, [fixture.installationId])
    await expect(publication.publish(input)).rejects.toThrow(/forbidden/)
    await pool.query(`UPDATE memory_installations SET relay_status = 'active' WHERE installation_id = $1`, [fixture.installationId])
    await pool.query(`
      INSERT INTO memory_repository_tombstones (installation_id, repository_id, reason_code)
      VALUES ($1, $2, 'test_delete')
    `, [fixture.installationId, fixture.repositoryId])
    await expect(publication.publish(input)).rejects.toThrow(/tombstoned/)
    await pool.query(`DELETE FROM memory_repository_tombstones WHERE installation_id = $1`, [fixture.installationId])
    await pool.query(`DELETE FROM memory_code_nodes WHERE node_id = $1`, [fixture.nodeId])
    await expect(publication.publish(input)).rejects.toThrow(/source_missing/)
    expect((await pool.query(`SELECT 1 FROM memory_wiki_heads WHERE wiki_id = $1`, [fixture.wikiId])).rowCount).toBe(0)
  })

  test('carries manual and locked overlays byte-for-byte and rejects generated key collisions', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'overlay')
    const manual = createWikiManualService(pool)
    await manual.edit({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, sectionKey: 'operator-notes', markdown: 'Exact manual bytes.\n',
      expectedLockVersion: 0, reasonCode: 'initial_note',
    })
    await manual.lock({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, sectionKey: 'operator-notes', expectedLockVersion: 1,
      reasonCode: 'approved_note',
    })
    const publication = createWikiPublicationService(pool)
    await publication.publish({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, runId: fixture.runId,
      expectedGeneration: 1, expectedHeadRevision: 0,
    })
    const overlay = await pool.query<{ markdown: string; authority: string }>(`
      SELECT s.markdown, s.authority FROM memory_wiki_sections s
      JOIN memory_wiki_heads h ON h.active_version_id = s.wiki_version_id
      WHERE h.wiki_id = $1 AND s.section_key = 'operator-notes'
    `, [fixture.wikiId])
    expect(overlay.rows).toEqual([{ markdown: 'Exact manual bytes.\n', authority: 'locked' }])

    const collision = await insertWikiCandidateFixture(pool, 'collision')
    await manual.edit({
      grant: collision.grant, targetInstallationId: collision.installationId,
      wikiId: collision.wikiId, sectionKey: 'generated-overview', markdown: 'manual collision',
      expectedLockVersion: 0,
    })
    await expect(publication.publish({
      grant: collision.grant, targetInstallationId: collision.installationId,
      wikiId: collision.wikiId, runId: collision.runId,
      expectedGeneration: 1, expectedHeadRevision: 0,
    })).rejects.toThrow(/section_key_collision/)
  })
})
