import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { applyMemorySchema } from '../schema.js'
import { withBaselineTestTarget, type BaselineTestTarget } from '../testing/phase6-baseline-target.js'
import { gitExportFixture } from '../testing/phase6-export-fixture.js'
import { gitImportFixture } from '../testing/phase6-import-fixture.js'

const url = process.env.MEMORY_TEST_DATABASE_URL
const db = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
db('actual baseline38 sources against additive schema46', () => {
  let pool: pg.Pool, temporary: string
  let validatedTarget: BaselineTestTarget
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  beforeAll(async () => {
    // Extraction owns only a fresh system temporary directory. Main checkout,
    // index, branch and current node_modules remain unchanged.
    temporary = mkdtempSync(join(tmpdir(), 'pocketctl-memory-baseline38-'))
    const archive = execFileSync('git', ['archive', '036f6d12', 'memory/src', 'memory/package.json', 'memory/tsconfig.json'], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
    execFileSync('tar', ['-xf', '-', '-C', temporary], { input: archive })
    symlinkSync(join(root, 'memory/node_modules'), join(temporary, 'memory/node_modules'), 'dir')
    pool = new pg.Pool({ connectionString: url, max: 8 })
    validatedTarget = await withBaselineTestTarget(pool, url!, undefined, async target => {
      await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
      await applyMemorySchema(pool)
      return target
    })
  }, 60_000)
  afterAll(async () => {
    await pool?.end()
    if (temporary) rmSync(temporary, { recursive: true, force: false })
  })
  test('old migrator, Wiki read/edit, Claim correction and bounded queue round-trip preserve independent Phase6 records', async () => {
    const files = ['schema.ts', 'wiki/read-service.ts', 'wiki/manual-service.ts', 'claims/repository.ts', 'jobs/repository.ts']
    for (const file of files) {
      const old = execFileSync('git', ['show', `036f6d12:memory/src/${file}`], { cwd: root, maxBuffer: 4 * 1024 * 1024 })
      expect(readFileSync(join(temporary, 'memory/src', file)).equals(old)).toBe(true)
    }
    const retained = await gitImportFixture(pool), { runId } = await retained.plan()
    const tableNames = ['memory_git_snapshots', 'memory_git_snapshot_assets', 'memory_git_import_proposals',
      'memory_git_run_receipts', 'memory_git_merge_receipts', 'memory_git_proposal_runs']
    async function fingerprint() {
      const result: Record<string, { count: number; hash: string }> = {}
      for (const table of tableNames) {
        const rows = (await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE installation_id=$1 ORDER BY to_jsonb(t)::text`, [retained.f.installationId])).rows
        result[table] = { count: rows.length, hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }
      }
      return result
    }
    const before = await fingerprint()
    expect(before.memory_git_proposal_runs.count).toBe(1)
    expect((await pool.query('SELECT run_id FROM memory_git_proposal_runs')).rows[0].run_id).toBe(runId)
    const f = await gitExportFixture(pool)
    const claimRevision = Number((await pool.query('SELECT revision FROM knowledge_claims WHERE claim_id=$1', [f.rule.claimId])).rows[0].revision)
    const output = execFileSync(join(root, 'memory/node_modules/.bin/tsx'), [join(root, 'memory/eval/fixtures/phase6/baseline38-probe.ts'),
      JSON.stringify({ installationId: f.installationId, repositoryId: f.repositoryId, wikiId: f.wiki.wikiId,
        grant: f.grant, claimId: f.rule.claimId, claimRevision, episodeId: f.skill.episodeId })],
    { cwd: root, env: { ...process.env, MEMORY_TEST_DATABASE_URL: url!, MEMORY_BASELINE38_DIR: temporary,
      MEMORY_BASELINE38_TARGET: JSON.stringify(validatedTarget) }, encoding: 'utf8', timeout: 45_000 })
    expect(JSON.parse(output)).toEqual({ baseline: '036f6d12', schemaBefore: 46, schemaAfter: 46, oldMigrator: 'pass',
      oldWikiRead: 'pass', oldWikiManualWrite: 'pass', oldClaimCorrectionWrite: 'pass', oldQueueEnqueueClaimComplete: 'pass', runtimeStarted: false, providerRequests: 0 })
    expect(await fingerprint()).toEqual(before)
    expect((await pool.query('SELECT count(*)::int n, max(version) v FROM memory_schema_migrations')).rows[0]).toEqual({ n: 46, v: 46 })
    // Exercise additive lifecycle triggers on a source that really has a Git
    // baseline. Derived bodies are invalidated; the metadata-only45 binding and
    // original immutable domain version must survive the old writer.
    const linked = retained.f
    const linkedRevision = Number((await pool.query('SELECT revision FROM knowledge_claims WHERE claim_id=$1', [linked.rule.claimId])).rows[0].revision)
    const linkedOutput = execFileSync(join(root, 'memory/node_modules/.bin/tsx'), [join(root, 'memory/eval/fixtures/phase6/baseline38-probe.ts'),
      JSON.stringify({ installationId: linked.installationId, repositoryId: linked.repositoryId, wikiId: linked.wiki.wikiId,
        grant: linked.grant, claimId: linked.rule.claimId, claimRevision: linkedRevision, episodeId: linked.skill.episodeId })],
    { cwd: root, env: { ...process.env, MEMORY_TEST_DATABASE_URL: url!, MEMORY_BASELINE38_DIR: temporary,
      MEMORY_BASELINE38_TARGET: JSON.stringify(validatedTarget) }, encoding: 'utf8', timeout: 45_000 })
    expect(JSON.parse(linkedOutput).oldClaimCorrectionWrite).toBe('pass')
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_snapshots WHERE installation_id=$1', [linked.installationId])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_proposal_runs WHERE installation_id=$1', [linked.installationId])).rows[0].n).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions WHERE installation_id=$1 AND version_id=$2', [linked.installationId, linked.rule.versionId])).rows[0].n).toBe(1)
    expect((await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1', [linked.connectionId])).rows[0].generation).not.toBe('1')
    console.log(output.trim())
  }, 60_000)
})
