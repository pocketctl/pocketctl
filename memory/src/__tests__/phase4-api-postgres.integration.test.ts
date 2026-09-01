import Fastify from 'fastify'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import type { GrantGuard, VerifiedMemoryGrant } from '../auth/grant-guard.js'
import { registerCodegraphRoutes } from '../api/codegraph-routes.js'
import { registerWikiRoutes } from '../api/wiki-routes.js'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createWikiPublicationService } from '../wiki/publication-service.js'
import { createWikiManualService } from '../wiki/manual-service.js'
import { createMemoryMetrics, updatePhase4Gauges } from '../metrics.js'
import { insertWikiCandidateFixture } from './helpers/phase4-wiki-fixture.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const describeWithDatabase = databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1'
  ? describe
  : describe.skip

function fakeGuard(grant: VerifiedMemoryGrant): GrantGuard {
  return {
    guard: async () => grant,
    guardMcp: async () => grant,
    guardV2: async () => {
      if ('version' in grant && grant.version === 'v2') return grant
      throw new Error('v2 required')
    },
    guardV2Disposition: async () => { throw new Error('not used') },
  }
}

describeWithDatabase('Phase 4 REST reads (PostgreSQL)', () => {
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

  test('returns bounded active graph, impact coverage, and active Wiki with exact citations', async () => {
    const metrics = createMemoryMetrics()
    const fixture = await insertWikiCandidateFixture(pool, 'api-read')
    await createWikiPublicationService(pool).publish({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, runId: fixture.runId,
      expectedGeneration: 1, expectedHeadRevision: 0,
    })
    await pool.query(`
      INSERT INTO memory_wiki_stale_marks
        (installation_id, wiki_id, section_key, reason, source_snapshot_id, graph_version_id)
      VALUES ($1, $2, 'generated-overview', 'source_file_changed', $3, $4)
    `, [fixture.installationId, fixture.wikiId, fixture.snapshotId, fixture.graphVersionId])
    const app = Fastify()
    const grant: VerifiedMemoryGrant = {
      installationId: fixture.installationId, services: ['memory.search'],
      configVersion: '1', callerType: 'web',
    }
    registerCodegraphRoutes(app, {
      pool, guard: fakeGuard(grant), codegraphMode: 'enabled', cursorSigningKey: 'phase4-cursor',
      phase4Metrics: metrics.phase4,
    })
    registerWikiRoutes(app, {
      pool, guard: fakeGuard(grant), wikiMode: 'enabled', cursorSigningKey: 'phase4-cursor',
    })

    const graph = await app.inject({
      method: 'GET', url: `/api/v1/memory/repositories/${fixture.repositoryId}/codegraph?limit=1`,
      headers: { authorization: 'Bearer test' },
    })
    expect(graph.statusCode, graph.body).toBe(200)
    expect(graph.json()).toMatchObject({
      repository_id: fixture.repositoryId,
      snapshot_id: fixture.snapshotId,
      commit_sha: fixture.commitSha,
      graph_version_id: fixture.graphVersionId,
      coverage: 'partial',
      nodes: [{ stable_key: 'file:src/index.ts' }],
    })
    const impact = await app.inject({
      method: 'POST', url: `/api/v1/memory/repositories/${fixture.repositoryId}/impact`,
      headers: { authorization: 'Bearer test' },
      payload: { entry_paths: ['README.md'] },
    })
    expect(impact.statusCode, impact.body).toBe(200)
    expect(impact.json()).toMatchObject({ coverage: 'unsupported', reasons: ['file_only_entry'] })

    const wiki = await app.inject({
      method: 'GET', url: `/api/v1/memory/repositories/${fixture.repositoryId}/wiki`,
      headers: { authorization: 'Bearer test' },
    })
    expect(wiki.statusCode, wiki.body).toBe(200)
    expect(wiki.json()).toMatchObject({
      repository_id: fixture.repositoryId,
      snapshot_id: fixture.snapshotId,
      commit_sha: fixture.commitSha,
      wiki_id: fixture.wikiId,
      generation: 1,
      pages: [{ sections: [{
        section_key: 'generated-overview', stale: true, locked: false, lock_version: 0,
        citations: [{ source_token: fixture.sourceToken, path: 'src/index.ts' }],
      }] }],
    })
    const foreign = await app.inject({
      method: 'GET', url: `/api/v1/memory/repositories/${crypto.randomUUID()}/wiki`,
      headers: { authorization: 'Bearer test' },
    })
    expect(foreign.statusCode).toBe(404)
    expect(foreign.json()).toMatchObject({ error: { code: 'not_found' } })
    await updatePhase4Gauges(pool, metrics.phase4)
    const metricText = await metrics.registry.metrics()
    expect(metricText).toContain('pocketctl_memory_codegraph_impact_total{result="unsupported"} 1')
    expect(metricText).toContain('pocketctl_memory_codegraph_nodes{kind="file"} 1')
    expect(metricText).toContain('pocketctl_memory_wiki_stale_sections{reason="source_file_changed"} 1')
    await app.close()
  })

  test('denies shared build scheduling without contribute permission instead of trusting request identity', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'api-permission')
    const readOnlyGrant = {
      version: 'v2' as const,
      installationId: fixture.installationId,
      primaryInstallationId: fixture.installationId,
      services: ['memory.manage'], configVersion: '1', callerType: 'web',
      scopeBindings: [{ ...fixture.grant.scopeBindings[0]!, permissions: ['read'] }],
    }
    const app = Fastify()
    registerWikiRoutes(app, {
      pool, guard: fakeGuard(readOnlyGrant), wikiMode: 'enabled', cursorSigningKey: 'phase4-cursor',
    })
    const response = await app.inject({
      method: 'POST', url: `/api/v1/memory/wikis/${fixture.wikiId}/builds`,
      headers: { authorization: 'Bearer test' }, payload: { expected_generation: 1 },
    })
    expect(response.statusCode).toBe(403)
    const bootstrap = await app.inject({
      method: 'POST', url: `/api/v1/memory/repositories/${fixture.repositoryId}/wiki/builds`,
      headers: { authorization: 'Bearer test' }, payload: { expected_generation: 1 },
    })
    expect(bootstrap.statusCode).toBe(403)
    await app.close()
  })

  test('persists content-free audit rows for every denied shared source and Wiki mutation', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'api-denial-audit')
    const manual = createWikiManualService(pool)
    await manual.edit({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, sectionKey: 'pilot-manual', markdown: 'approved baseline',
      expectedLockVersion: 0,
    })
    await manual.edit({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, sectionKey: 'pilot-locked', markdown: 'locked baseline',
      expectedLockVersion: 0,
    })
    await manual.lock({
      grant: fixture.grant, targetInstallationId: fixture.installationId,
      wikiId: fixture.wikiId, sectionKey: 'pilot-locked', expectedLockVersion: 1,
    })
    const actorScopeId = crypto.randomUUID()
    const membershipId = crypto.randomUUID()
    const readOnlyGrant = {
      version: 'v2' as const,
      installationId: fixture.installationId,
      primaryInstallationId: fixture.installationId,
      services: ['memory.manage', 'memory.codegraph.write'], configVersion: '1', callerType: 'web',
      scopeBindings: [{
        installation_id: fixture.installationId,
        owner_scope_kind: 'team' as const,
        owner_scope_id: actorScopeId,
        membership_id: membershipId,
        membership_revision: '7',
        authorization_epoch: '11',
        permissions: ['read'],
      }],
    }
    const app = Fastify()
    registerCodegraphRoutes(app, {
      pool, guard: fakeGuard(readOnlyGrant), codegraphMode: 'enabled',
      sharedScopesMode: 'enabled', cursorSigningKey: 'phase4-cursor',
    })
    registerWikiRoutes(app, {
      pool, guard: fakeGuard(readOnlyGrant), wikiMode: 'enabled',
      sharedScopesMode: 'enabled', cursorSigningKey: 'phase4-cursor',
    })
    const snapshotsBefore = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_source_snapshots WHERE installation_id = $1`,
      [fixture.installationId],
    )
    const requests = [
      app.inject({
        method: 'POST', url: '/api/v1/memory/code-snapshots',
        headers: { authorization: 'Bearer test', 'idempotency-key': 'audit-source-denied' },
        payload: {
          repository: { repository_key: 'audit-secret-source' },
          git_object_format: 'sha1', commit_sha: 'a'.repeat(40),
          manifest_sha256: 'b'.repeat(64), expected_file_count: 0,
          expected_byte_count: 0, parser_matrix_version: 'phase4-v1',
          idempotency_key: 'audit-source-denied',
        },
      }),
      app.inject({
        method: 'PUT',
        url: `/api/v1/memory/wikis/${fixture.wikiId}/manual-sections/pilot-manual`,
        headers: { authorization: 'Bearer test' },
        payload: { markdown: 'audit-secret-markdown', expected_lock_version: 1 },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/memory/wikis/${fixture.wikiId}/manual-sections/pilot-locked/unlock`,
        headers: { authorization: 'Bearer test' },
        payload: { expected_lock_version: 2 },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/memory/wikis/${fixture.wikiId}/candidates/${fixture.runId}/publish`,
        headers: { authorization: 'Bearer test' },
        payload: { expected_generation: 1, expected_head_revision: 0 },
      }),
    ]
    const responses = await Promise.all(requests)
    expect(responses.map(response => response.statusCode)).toEqual([403, 403, 403, 403])
    const audit = await pool.query<{
      action: string
      result: string
      actor_scope_kind: string
      actor_scope_id: string
      membership_id: string
      membership_revision: string
      authorization_epoch: string
    }>(`
      SELECT action, result, actor_scope_kind, actor_scope_id::text,
             membership_id::text, membership_revision::text, authorization_epoch::text
      FROM memory_phase4_authorization_audit_events
      WHERE installation_id = $1
      ORDER BY action
    `, [fixture.installationId])
    expect(audit.rows).toEqual([
      { action: 'manual_edit', result: 'unauthorized', actor_scope_kind: 'team', actor_scope_id: actorScopeId, membership_id: membershipId, membership_revision: '7', authorization_epoch: '11' },
      { action: 'publish', result: 'unauthorized', actor_scope_kind: 'team', actor_scope_id: actorScopeId, membership_id: membershipId, membership_revision: '7', authorization_epoch: '11' },
      { action: 'source_upload', result: 'unauthorized', actor_scope_kind: 'team', actor_scope_id: actorScopeId, membership_id: membershipId, membership_revision: '7', authorization_epoch: '11' },
      { action: 'unlock', result: 'unauthorized', actor_scope_kind: 'team', actor_scope_id: actorScopeId, membership_id: membershipId, membership_revision: '7', authorization_epoch: '11' },
    ])
    expect(JSON.stringify(audit.rows)).not.toContain('audit-secret-source')
    expect(JSON.stringify(audit.rows)).not.toContain('audit-secret-markdown')
    const snapshotsAfter = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_source_snapshots WHERE installation_id = $1`,
      [fixture.installationId],
    )
    expect(snapshotsAfter.rows).toEqual(snapshotsBefore.rows)
    expect((await pool.query(`SELECT 1 FROM memory_wiki_heads WHERE wiki_id = $1`, [fixture.wikiId])).rowCount).toBe(0)
    const manualRows = await pool.query<{ section_key: string; markdown: string; locked: boolean }>(`
      SELECT h.section_key, v.markdown, h.locked
      FROM memory_wiki_manual_section_heads h
      JOIN memory_wiki_manual_section_versions v
        ON v.installation_id = h.installation_id AND v.manual_version_id = h.current_version_id
      WHERE h.installation_id = $1 AND h.wiki_id = $2
      ORDER BY h.section_key
    `, [fixture.installationId, fixture.wikiId])
    expect(manualRows.rows).toEqual([
      { section_key: 'pilot-locked', markdown: 'locked baseline', locked: true },
      { section_key: 'pilot-manual', markdown: 'approved baseline', locked: false },
    ])
    await app.close()
  })

  test('bootstraps the first governed Wiki build from an active repository graph', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'api-first-build')
    await pool.query(`DELETE FROM memory_wikis WHERE installation_id = $1 AND wiki_id = $2`, [
      fixture.installationId, fixture.wikiId,
    ])
    const grant: VerifiedMemoryGrant = {
      installationId: fixture.installationId,
      services: ['memory.manage'], configVersion: '1', callerType: 'web',
    }
    const app = Fastify()
    registerWikiRoutes(app, {
      pool, guard: fakeGuard(grant), wikiMode: 'enabled', cursorSigningKey: 'phase4-cursor',
    })
    const response = await app.inject({
      method: 'POST', url: `/api/v1/memory/repositories/${fixture.repositoryId}/wiki/builds`,
      headers: { authorization: 'Bearer test' }, payload: { expected_generation: 0 },
    })
    expect(response.statusCode, response.body).toBe(202)
    expect(response.json()).toMatchObject({
      wiki_id: expect.any(String), run_id: expect.any(String), generation: 1,
    })
    const staleCas = await app.inject({
      method: 'POST', url: `/api/v1/memory/repositories/${fixture.repositoryId}/wiki/builds`,
      headers: { authorization: 'Bearer test' }, payload: { expected_generation: 0 },
    })
    expect(staleCas.statusCode).toBe(409)
    expect(staleCas.json()).toMatchObject({ error: { code: 'revision_conflict' } })
    const persisted = await pool.query(`
      SELECT w.repository_id::text, w.generation::text, r.state
      FROM memory_wikis w
      JOIN memory_wiki_build_runs r
        ON r.installation_id = w.installation_id AND r.wiki_id = w.wiki_id
      WHERE w.installation_id = $1 AND w.wiki_id = $2
    `, [fixture.installationId, response.json().wiki_id])
    expect(persisted.rows).toEqual([{
      repository_id: fixture.repositoryId, generation: '1', state: 'queued',
    }])
    await app.close()
  })

  test('shared Phase 4 mutations honor the shared-scope mode intersection', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'api-shared-mode')
    const sharedGrant = {
      version: 'v2' as const,
      installationId: fixture.installationId,
      primaryInstallationId: fixture.installationId,
      services: ['memory.manage', 'memory.codegraph.write'], configVersion: '1', callerType: 'web',
      scopeBindings: [{
        ...fixture.grant.scopeBindings[0]!, owner_scope_kind: 'team' as const,
        owner_scope_id: crypto.randomUUID(), membership_id: crypto.randomUUID(),
      }],
    }
    const app = Fastify()
    registerCodegraphRoutes(app, {
      pool, guard: fakeGuard(sharedGrant), codegraphMode: 'enabled',
      sharedScopesMode: 'off', cursorSigningKey: 'phase4-cursor',
    })
    registerWikiRoutes(app, {
      pool, guard: fakeGuard(sharedGrant), wikiMode: 'enabled',
      sharedScopesMode: 'off', cursorSigningKey: 'phase4-cursor',
    })
    const upload = await app.inject({
      method: 'POST', url: '/api/v1/memory/code-snapshots',
      headers: { authorization: 'Bearer test', 'idempotency-key': 'shared-off' },
      payload: {
        repository: { repository_key: 'github.com/example/shared-off' },
        git_object_format: 'sha1', commit_sha: 'a'.repeat(40),
        manifest_sha256: 'b'.repeat(64), expected_file_count: 1,
        expected_byte_count: 1, parser_matrix_version: 'phase4-v1',
        idempotency_key: 'shared-off',
      },
    })
    expect(upload.statusCode).toBe(503)
    expect(upload.json()).toMatchObject({ error: { code: 'feature_disabled' } })

    const build = await app.inject({
      method: 'POST', url: `/api/v1/memory/wikis/${fixture.wikiId}/builds`,
      headers: { authorization: 'Bearer test' }, payload: { expected_generation: 1 },
    })
    expect(build.statusCode).toBe(503)
    expect(build.json()).toMatchObject({ error: { code: 'feature_disabled' } })
    await app.close()
  })

  test('read-only shared members cannot fetch unpublished Wiki candidates', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'api-candidate-reader')
    const readOnlyGrant = {
      version: 'v2' as const,
      installationId: fixture.installationId,
      primaryInstallationId: fixture.installationId,
      services: ['memory.search'], configVersion: '1', callerType: 'web',
      scopeBindings: [{ ...fixture.grant.scopeBindings[0]!, permissions: ['read'] }],
    }
    const app = Fastify()
    registerCodegraphRoutes(app, {
      pool, guard: fakeGuard(readOnlyGrant), codegraphMode: 'enabled',
      sharedScopesMode: 'enabled', cursorSigningKey: 'phase4-cursor',
    })
    registerWikiRoutes(app, {
      pool, guard: fakeGuard(readOnlyGrant), wikiMode: 'enabled',
      sharedScopesMode: 'enabled', cursorSigningKey: 'phase4-cursor',
    })
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/memory/wikis/${fixture.wikiId}/candidates/${fixture.runId}`,
      headers: { authorization: 'Bearer test' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'forbidden' } })
    const abort = await app.inject({
      method: 'DELETE', url: `/api/v1/memory/code-snapshots/${crypto.randomUUID()}`,
      headers: { authorization: 'Bearer test' },
    })
    expect(abort.statusCode).toBe(403)
    expect(abort.json()).toMatchObject({ error: { code: 'forbidden' } })
    await app.close()
  })

  test('repository purge remains available in off mode and records purged snapshots', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'api-purge-metric')
    const metrics = createMemoryMetrics()
    const grant = {
      ...fixture.grant,
      installationId: fixture.installationId,
      services: ['memory.manage'],
      callerType: 'web' as const,
    }
    const app = Fastify()
    registerWikiRoutes(app, {
      pool, guard: fakeGuard(grant), wikiMode: 'off', sharedScopesMode: 'off',
      cursorSigningKey: 'phase4-cursor', phase4Metrics: metrics.phase4,
    })
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/memory/repositories/${fixture.repositoryId}/memory`,
      headers: { authorization: 'Bearer test' },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toEqual({ purged: true })
    expect(await metrics.registry.metrics()).toContain(
      'pocketctl_memory_code_snapshot_total{result="purged",source_kind="personal"} 1',
    )
    await app.close()
  })

  test('uses a signed Wiki build cursor scoped to the caller and Wiki', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'api-build-cursor')
    await pool.query(`
      UPDATE memory_wikis SET generation = 2 WHERE installation_id = $1 AND wiki_id = $2
    `, [fixture.installationId, fixture.wikiId])
    await pool.query(`
      INSERT INTO memory_wiki_build_runs
        (run_id, installation_id, wiki_id, generation, source_snapshot_id,
         graph_version_id, state, input_digest, completed_at)
      VALUES ($3, $1, $2, 2, $4, $5, 'failed', $6, NOW())
    `, [fixture.installationId, fixture.wikiId, crypto.randomUUID(), fixture.snapshotId,
      fixture.graphVersionId, 'd'.repeat(64)])
    const grant: VerifiedMemoryGrant = {
      installationId: fixture.installationId, services: ['memory.search'],
      configVersion: '1', callerType: 'web',
    }
    const app = Fastify()
    registerWikiRoutes(app, {
      pool, guard: fakeGuard(grant), wikiMode: 'enabled', cursorSigningKey: 'phase4-cursor',
    })
    const first = await app.inject({
      method: 'GET', url: `/api/v1/memory/wikis/${fixture.wikiId}/builds?limit=1`,
      headers: { authorization: 'Bearer test' },
    })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().builds).toHaveLength(1)
    expect(first.json().next_cursor).toEqual(expect.any(String))

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/memory/wikis/${fixture.wikiId}/builds?limit=1&cursor=${encodeURIComponent(first.json().next_cursor)}`,
      headers: { authorization: 'Bearer test' },
    })
    expect(second.statusCode, second.body).toBe(200)
    expect(second.json()).toMatchObject({ builds: [{ generation: '1' }], next_cursor: null })

    const tampered = await app.inject({
      method: 'GET',
      url: `/api/v1/memory/wikis/${fixture.wikiId}/builds?cursor=${encodeURIComponent(`${first.json().next_cursor}x`)}`,
      headers: { authorization: 'Bearer test' },
    })
    expect(tampered.statusCode).toBe(400)
    expect(tampered.json()).toMatchObject({ error: { code: 'invalid_request' } })
    await app.close()
  })
})
