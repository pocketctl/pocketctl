import pg from 'pg'
import { readFileSync } from 'node:fs'
import { sign } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { gitExportFixture } from '../testing/phase6-export-fixture.js'
import { attestationFixture } from '../testing/phase6-attestation-fixture.js'
import { createGitExportService } from '../git-sync/export-service.js'
import { createSchemaCompatibilityFixture, type FixtureMigratedExport } from '../git-sync/schema-compat.js'
import { canonicalJsonString } from '../inbox/canonical-json.js'
import { rawFileHash, rawFilesDigest, verifyExportBase, restoreExportBundle } from '../git-sync/attestation.js'
import { decodeAsset } from '../git-sync/codec.js'
import type { RepositoryFile } from '../git-sync/types.js'

const expected = JSON.parse(readFileSync(new URL('../../eval/fixtures/phase6/schema-expectations.json', import.meta.url), 'utf8'))
const url = process.env.MEMORY_TEST_DATABASE_URL
const db = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

test('format rehearsal capability is unavailable in production', () => {
  vi.stubEnv('NODE_ENV', 'production')
  try { expect(() => createSchemaCompatibilityFixture({} as never)).toThrow('git_schema_fixture_only') }
  finally { vi.unstubAllEnvs() }
})

db('Phase 6 fixture format migration with current registered authority', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 8 })
    await assertMemoryTestDatabase(pool, url!)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await applyMemorySchema(pool)
  }, 60_000)
  beforeEach(async () => { await pool.query('TRUNCATE memory_installations CASCADE') })
  afterAll(async () => { await pool?.end() })
  async function setup() {
    const f = await gitExportFixture(pool), keys = attestationFixture().registry
    const exports = createGitExportService({ pool, keys, skill: { context: f.skill.context, cases: f.skill.cases } })
    const base = await exports.export(f.grant, { installationId: f.installationId, connectionId: f.connectionId,
      expectedGeneration: '1', baseCommit: 'a'.repeat(40), purpose: 'external_export', assets: f.keys })
    const root = { installationId: f.installationId, connectionId: f.connectionId, expectedGeneration: '1', exportId: base.exportId }
    const compat = createSchemaCompatibilityFixture({ exports, keys })
    const context = { installationId: f.installationId, repositoryId: f.repositoryId, connectionId: f.connectionId,
      generation: '1', exportId: base.exportId, baseCommit: 'a'.repeat(40), tombstoneGeneration: '1', purpose: 'external_export' as const, publishable: true }
    const convert = (targetSchema: string, source?: FixtureMigratedExport) => compat.convert({ grant: f.grant, root, targetSchema, source })
    const migrate = async (targetSchema: string, source?: FixtureMigratedExport) => {
      const result = await convert(targetSchema, source)
      if (!result.ok) throw new Error(JSON.stringify(result.report))
      return result
    }
    return { f, keys, base, context, root, compat, convert, migrate }
  }
  const metadata = (bundle: {files: RepositoryFile[]}, kind: string) => {
    const file = bundle.files.find(f => f.path.includes(`/${kind === 'wiki' ? 'wiki' : kind + 's'}/`) && f.path.endsWith('.yaml'))!
    return JSON.parse(Buffer.from(file.bytes).toString())
  }

  test('bijective four-kind migration preserves exact nested fields, page bytes and independent expected values', async () => {
    const s = await setup(), before = rawFilesDigest(s.base.files), signature = Buffer.from(s.base.attestation).toString('hex')
    const up = await s.migrate('memory-git.v2')
    expect(up.ok).toBe(true)
    expect(up.report).toMatchObject({ fromSchema: expected.fromSchema, toSchema: expected.toSchema, assetCount: 4, lossless: true, rejectionReason: null })
    expect(up.report.fromFieldCount).toBeGreaterThan(40)
    expect(up.report.toFieldCount).toBe(up.report.fromFieldCount)
    expect(metadata(up.bundle, 'rule')).toMatchObject({ document: expected.rule })
    expect(metadata(up.bundle, 'skill').document.document.schema_version).toBe('skill-candidate.v1')
    expect(metadata(up.bundle, 'wiki').document.pages[0].title).toBe(expected.wiki.title)
    expect(metadata(up.bundle, 'wiki').immutable.pages[0].sections[1].lockVersion).toBe(expected.wiki.lockVersion)
    expect(Buffer.from(up.bundle.files.find((f: RepositoryFile) => f.path.endsWith('.md'))!.bytes).toString()).toContain(expected.wiki.markdown)
    expect(up.bundle.context).toMatchObject({ purpose: 'local_preview', publishable: false })
    expect(up.bundle.context.exportId).not.toBe(s.base.exportId)
    const down = await s.migrate('memory-git.v1', up.bundle)
    expect(down.ok).toBe(true)
    expect(new Set([s.base.exportId, up.bundle.context.exportId, down.bundle.context.exportId]).size).toBe(3)
    for (const kind of expected.kinds) {
      const original = metadata(s.base, kind), restored = metadata(down.bundle, kind), v2 = metadata(up.bundle, kind)
      expect(restored).toEqual({ ...original, exportId: down.bundle.context.exportId })
      const { editable, ...rest } = original
      expect(v2).toEqual({ ...rest, schemaVersion: 'memory-git.v2', exportId: up.bundle.context.exportId, document: editable })
    }
    expect(up.report.fromHash).toMatch(/^[a-f0-9]{64}$/)
    expect(up.report.toHash).toMatch(/^[a-f0-9]{64}$/)
    expect(rawFilesDigest(s.base.files)).toBe(before)
    expect(Buffer.from(s.base.attestation).toString('hex')).toBe(signature)
    expect(verifyExportBase(s.base, s.context, s.keys)).toBe(true)
    expect((await pool.query('SELECT count(*)::int AS count FROM memory_git_snapshots')).rows[0].count).toBe(1)
    expect(JSON.stringify([up.report, down.report])).not.toMatch(/Synthetic statement|Keep CRLF|private|Evidence|document|credential/)
    console.log(JSON.stringify({ schemaMigration: up.report }))
  })

  test('runtime v1 decoder rejects v2, and runtime signature verifier rejects fixture attestation even after downgrade', async () => {
    const s = await setup(), up = await s.migrate('memory-git.v2'), down = await s.migrate('memory-git.v1', up.bundle)
    const claim = s.base.assets.find(a => a.asset.key.kind === 'claim')!
    expect(() => decodeAsset(up.bundle.files.filter((f: RepositoryFile) => f.path === claim.asset.path), claim)).toThrow()
    expect(() => restoreExportBundle(s.base.assets, down.bundle.attestation)).toThrow()
  })

  test.each(['top_level_unknown', 'nested_unknown', 'missing_field'])('rejects signed %s rather than stripping information during downgrade', async mutation => {
    const s = await setup(), up = await s.migrate('memory-git.v2'), source = up.bundle
    const file = source.files.find((f: RepositoryFile) => f.path.includes('/rules/'))!
    const raw = JSON.parse(Buffer.from(file.bytes).toString())
    if (mutation === 'top_level_unknown') raw.extra = 'SENSITIVE_UNKNOWN'
    else if (mutation === 'nested_unknown') raw.document.extra = 'SENSITIVE_UNKNOWN'
    else delete raw.document.structuredContent
    file.bytes = Buffer.from(JSON.stringify(raw))
    // Independently sign adversarial fixture bytes so lossless validation, not
    // merely the signature check, must reject the malformed document.
    const envelope = JSON.parse(Buffer.from(source.attestation).toString())
    envelope.descriptor.files = source.files.filter((f: RepositoryFile) => !f.path.includes('/attestations/')).map((f: RepositoryFile) => ({ path: f.path, mode: f.mode, hash: rawFileHash(f.bytes) }))
    envelope.descriptor.filesDigest = rawFilesDigest(source.files.filter((f: RepositoryFile) => !f.path.includes('/attestations/')))
    envelope.signature = sign(null, Buffer.from('pocketctl-memory-git-schema-fixture\0memory-git.v2\0' + canonicalJsonString(envelope.descriptor)), s.keys.signingKey().privateKey).toString('base64url')
    source.attestation = Buffer.from(JSON.stringify(envelope))
    source.files.find((f: RepositoryFile) => f.path.includes('/attestations/'))!.bytes = source.attestation
    const result = await s.convert('memory-git.v1', source)
    expect(result).toMatchObject({ ok: false, report: { lossless: false, rejectionReason: 'lossy_conversion', toHash: null } })
    expect(result.bundle).toBeUndefined()
    expect(JSON.stringify(result.report)).not.toMatch(/SENSITIVE_UNKNOWN|document|statement/)
  })

  test.each(['signature', 'schema_in_place', 'identity_in_place'])('rejects %s tampering without minting new proof', async mutation => {
    const s = await setup(), up = await s.migrate('memory-git.v2'), source = up.bundle
    if (mutation === 'schema_in_place') source.schemaVersion = 'memory-git.v1'
    else if (mutation === 'identity_in_place') source.context.exportId = s.base.exportId
    else {
      const envelope = JSON.parse(Buffer.from(source.attestation).toString())
      envelope.signature = 'A'.repeat(86)
      source.attestation = Buffer.from(JSON.stringify(envelope))
      source.files.find(f => f.path.includes('/attestations/'))!.bytes = source.attestation
    }
    expect(await s.convert('memory-git.v1', source)).toMatchObject({ ok: false, report: { rejectionReason: 'attestation_invalid', lossless: false } })
  })

  test('unknown schemas produce a bounded metadata report without reflecting supplied text', async () => {
    const s = await setup()
    expect(await s.convert('secret-unknown-schema')).toMatchObject({ ok: false, report: { toSchema: 'unknown', rejectionReason: 'unknown_schema' } })
    expect(JSON.stringify(await s.convert('secret-unknown-schema'))).not.toContain('secret-unknown-schema')
  })

  test.each(['tombstone', 'withdrawn', 'unregistered'])('valid offline fixture signature cannot bypass current %s base', async mutation => {
    const s = await setup(), up = await s.migrate('memory-git.v2')
    if (mutation === 'tombstone') await pool.query("INSERT INTO memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,'shared-governance','fixture',NOW())", [s.f.installationId])
    else if (mutation === 'withdrawn') await pool.query("UPDATE knowledge_claims SET state='revoked' WHERE claim_id=$1", [s.f.rule.claimId])
    else await pool.query('DELETE FROM memory_git_snapshots WHERE installation_id=$1 AND export_id=$2', [s.f.installationId, s.base.exportId])
    expect(verifyExportBase(s.base, s.context, s.keys)).toBe(true)
    expect(await s.convert('memory-git.v1', up.bundle)).toMatchObject({ ok: false, report: { rejectionReason: 'registered_base_unavailable', lossless: false } })
  })
})
