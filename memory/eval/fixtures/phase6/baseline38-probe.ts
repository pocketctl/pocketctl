/** Bounded old-source execution only. Never starts an API/worker/provider. */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import pg from 'pg'
import { withBaselineTestTarget } from '../../../src/testing/phase6-baseline-target.js'

const dir = process.env.MEMORY_BASELINE38_DIR, url = process.env.MEMORY_TEST_DATABASE_URL
assert.ok(dir && url && process.env.MEMORY_BASELINE38_TARGET)
const expectedTarget = JSON.parse(process.env.MEMORY_BASELINE38_TARGET)
assert.ok(expectedTarget && typeof expectedTarget === 'object')
const input = JSON.parse(process.argv[2])
const pool = new pg.Pool({ connectionString: url, max: 2, statement_timeout: 10_000, connectionTimeoutMillis: 5_000 })
async function runProbe() {
  const old = (path: string) => import(pathToFileURL(join(dir, 'memory/src', path)).href)
  const { applyMemorySchema } = await old('schema.ts')
  await applyMemorySchema(pool)
  assert.equal((await pool.query('SELECT max(version) v FROM memory_schema_migrations')).rows[0].v, 46)
  const { createWikiReadService } = await old('wiki/read-service.ts')
  const wiki = await createWikiReadService(pool).getActiveWiki({ installationId: input.installationId, repositoryId: input.repositoryId })
  assert.equal(wiki.pages[0].title, 'Complete overview')
  const { createWikiManualService } = await old('wiki/manual-service.ts')
  const manual = await createWikiManualService(pool).edit({ grant: input.grant, targetInstallationId: input.installationId,
    wikiId: input.wikiId, sectionKey: 'generated', expectedLockVersion: 0, markdown: 'Baseline 38 isolated manual edit', reasonCode: 'compatibility_fixture' })
  assert.equal(manual.lockVersion, 1)
  const { createClaimRepository } = await old('claims/repository.ts')
  const correction = await createClaimRepository(pool).correctClaim({ installationId: input.installationId,
    claimId: input.claimId, expectedRevision: input.claimRevision, statement: 'Baseline 38 isolated correction',
    evidence: [{ evidenceKind: 'episode', episodeId: input.episodeId, locator: {}, excerpt: 'Synthetic compatibility evidence', occurredAt: new Date('2026-09-03T00:00:00Z') }] })
  assert.equal(correction.ok, true, JSON.stringify(correction))
  const { createJobRepository } = await old('jobs/repository.ts')
  const jobs = createJobRepository(pool)
  await jobs.enqueueJob({ installationId: input.installationId, jobType: 'expire_claims', idempotencyKey: 'baseline38-probe', priority: 0,
    availableAt: new Date('2000-01-01T00:00:00Z'), payload: {} })
  const claimed = await jobs.claimJobs({ workerId: 'baseline38-fixture-no-worker', limit: 1, leaseMs: 30_000 })
  assert.equal(claimed.length, 1); assert.equal(claimed[0].idempotency_key, 'baseline38-probe')
  assert.equal(await jobs.completeJob({ jobId: claimed[0].job_id, claimedBy: 'baseline38-fixture-no-worker', claimEpoch: claimed[0].claim_epoch }), true)
  const rows = await pool.query('SELECT statement FROM knowledge_versions WHERE installation_id=$1 AND version_id=$2', [input.installationId, correction.versionId])
  assert.equal(rows.rows[0].statement, 'Baseline 38 isolated correction')
  assert.equal((await pool.query('SELECT count(*)::int n FROM memory_wiki_manual_section_versions WHERE manual_version_id=$1', [manual.manualVersionId])).rows[0].n, 1)
  console.log(JSON.stringify({ baseline: '036f6d12', schemaBefore: 46, schemaAfter: 46, oldMigrator: 'pass',
    oldWikiRead: 'pass', oldWikiManualWrite: 'pass', oldClaimCorrectionWrite: 'pass', oldQueueEnqueueClaimComplete: 'pass',
    runtimeStarted: false, providerRequests: 0 }))
}
try { await withBaselineTestTarget(pool, url, expectedTarget, runProbe) }
finally { await pool.end() }
