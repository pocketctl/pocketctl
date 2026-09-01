import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createWikiManualService } from '../wiki/manual-service.js'
import { insertWikiCandidateFixture } from './helpers/phase4-wiki-fixture.js'
import { createMemoryMetrics } from '../metrics.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const describeWithDatabase = databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1'
  ? describe
  : describe.skip

describeWithDatabase('Phase 4 manual and locked Wiki authority', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
  })
  afterAll(async () => pool?.end())
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`)
    await applyMemorySchema(pool)
  }, 120_000)

  test('edits immutably, locks/unlocks with CAS, and never overwrites locked bytes', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'manual-cas')
    const metrics = createMemoryMetrics()
    const service = createWikiManualService(pool, { metrics: metrics.phase4 })
    const edited = await service.edit({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, sectionKey: 'notes', markdown: 'v1',
      expectedLockVersion: 0, reasonCode: 'create',
    })
    expect(edited.lockVersion).toBe(1)
    await service.lock({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, sectionKey: 'notes', expectedLockVersion: 1,
    })
    await expect(service.edit({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, sectionKey: 'notes', markdown: 'overwrite',
      expectedLockVersion: 2,
    })).rejects.toThrow(/locked/)
    await expect(service.unlock({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, sectionKey: 'notes', expectedLockVersion: 1,
    })).rejects.toThrow(/revision_conflict/)
    await service.unlock({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, sectionKey: 'notes', expectedLockVersion: 2,
    })
    await service.edit({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, sectionKey: 'notes', markdown: 'v2',
      expectedLockVersion: 3,
    })
    const versions = await pool.query<{ markdown: string }>(`
      SELECT markdown FROM memory_wiki_manual_section_versions
      WHERE wiki_id = $1 ORDER BY created_at, manual_version_id
    `, [fixture.wikiId])
    expect(versions.rows.map(row => row.markdown)).toEqual(['v1', 'v2'])
    const metricText = await metrics.registry.metrics()
    expect(metricText).toContain('pocketctl_memory_wiki_manual_actions_total{action="edit",result="succeeded"} 2')
    expect(metricText).toContain('pocketctl_memory_wiki_manual_actions_total{action="edit",result="conflict"} 1')
    expect(metricText).toContain('pocketctl_memory_wiki_manual_actions_total{action="lock",result="succeeded"} 1')
    expect(metricText).toContain('pocketctl_memory_wiki_manual_actions_total{action="unlock",result="conflict"} 1')
    expect(metricText).toContain('pocketctl_memory_wiki_manual_actions_total{action="unlock",result="succeeded"} 1')
  })

  test('denies missing contribute permission and stale authorization, and audit stores hashes not content', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'manual-auth')
    const service = createWikiManualService(pool)
    const readOnly = structuredClone(fixture.grant)
    readOnly.scopeBindings[0]!.permissions = ['read']
    await expect(service.edit({
      grant: readOnly, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, sectionKey: 'notes', markdown: 'secret manual body',
      expectedLockVersion: 0,
    })).rejects.toThrow(/forbidden/)
    await pool.query(`UPDATE memory_installations SET local_status = 'purged' WHERE installation_id = $1`, [fixture.installationId])
    await expect(service.edit({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, sectionKey: 'notes', markdown: 'secret manual body',
      expectedLockVersion: 0,
    })).rejects.toThrow(/forbidden/)
    const audit = await pool.query(`SELECT * FROM memory_wiki_audit_events WHERE wiki_id = $1`, [fixture.wikiId])
    expect(JSON.stringify(audit.rows)).not.toContain('secret manual body')
  })
})
