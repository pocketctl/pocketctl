import { randomUUID, sign, verify } from 'node:crypto'
import { z } from 'zod'
import { canonicalJsonString } from '../inbox/canonical-json.js'
import type { V2GrantFacts } from '../governance/authorization.js'
import type { createGitExportService } from './export-service.js'
import { buildExportBundle, ExportContextSchema, exportJsonBytes, rawFileHash, rawFilesDigest,
  type AttestationKeyRegistry, type ExportContext } from './attestation.js'
import { KNOWLEDGE_ROOT, validateRepositoryFiles } from './paths.js'
import { parseStrictJson } from './strict-json.js'
import type { ExportBundle, RepositoryFile } from './types.js'

type FixtureSchema = 'memory-git.v1' | 'memory-git.v2'
type Rejection = 'unknown_schema' | 'attestation_invalid' | 'lossy_conversion' | 'registered_base_unavailable'
export interface SchemaMigrationReport {
  fromSchema: FixtureSchema | 'unknown'; toSchema: FixtureSchema | 'unknown'
  assetCount: number; fromFieldCount: number; toFieldCount: number
  fromHash: string | null; toHash: string | null; lossless: boolean; rejectionReason: Rejection | null
}
/** Rehearsal artifact, never a runtime ExportBundle. Even fixture v1 retains
 * its own signing domain and cannot become a registered production baseline. */
export interface FixtureMigratedExport {
  schemaVersion: FixtureSchema; rootExportId: string; parentExportId: string
  context: ExportContext; files: RepositoryFile[]; attestation: Uint8Array
}
type Result = { ok: true; bundle: FixtureMigratedExport; report: SchemaMigrationReport }
  | { ok: false; report: SchemaMigrationReport; bundle?: undefined }
const schema = (value: unknown): FixtureSchema | 'unknown' => value === 'memory-git.v1' || value === 'memory-git.v2' ? value : 'unknown'
const descriptorSchema = z.object({ fixtureFormat: z.literal('memory-git-schema-fixture.v1'),
  schemaVersion: z.enum(['memory-git.v1', 'memory-git.v2']), rootExportId: z.uuid(), parentExportId: z.uuid(),
  context: ExportContextSchema, keyId: z.string().min(1).max(128), filesDigest: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.object({ path: z.string().max(512), mode: z.literal('100644'), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(255),
}).strict()
const envelopeSchema = z.object({ descriptor: descriptorSchema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict()
function fixtureOnly() {
  if (process.env.NODE_ENV !== 'test') throw new Error('git_schema_fixture_only')
}
const signingBytes = (version: FixtureSchema, descriptor: unknown) =>
  Buffer.from(`pocketctl-memory-git-schema-fixture\0${version}\0${canonicalJsonString(descriptor)}`)
const attestationPath = (id: string) => `${KNOWLEDGE_ROOT}/attestations/${id}.json`
const contentFiles = (files: RepositoryFile[]) => files.filter(f => !f.path.startsWith(`${KNOWLEDGE_ROOT}/attestations/`))
function contextOf(base: ExportBundle): ExportContext {
  const { installationId, repositoryId, connectionId, generation, exportId, baseCommit, tombstoneGeneration, purpose, publishable } = base
  return ExportContextSchema.parse({ installationId, repositoryId, connectionId, generation, exportId, baseCommit, tombstoneGeneration, purpose, publishable })
}
function descriptor(bundle: Omit<FixtureMigratedExport, 'attestation'>, keyId: string) {
  const files = contentFiles(bundle.files)
  return descriptorSchema.parse({ fixtureFormat: 'memory-git-schema-fixture.v1', schemaVersion: bundle.schemaVersion,
    rootExportId: bundle.rootExportId, parentExportId: bundle.parentExportId, context: bundle.context, keyId,
    filesDigest: rawFilesDigest(files), files: files.map(f => ({ path: f.path, mode: f.mode, hash: rawFileHash(f.bytes) })) })
}
/** Count scalar leaves, treating an empty container as one field. Wiki body
 * files each count as one field; manifest/attestation are not domain fields. */
function fieldCount(files: RepositoryFile[]): number {
  function count(value: unknown): number {
    if (value !== null && typeof value === 'object') {
      const values = Object.values(value)
      return values.length ? values.reduce<number>((total, item) => total + count(item), 0) : 1
    }
    return 1
  }
  return files.filter(f => !f.path.endsWith('/manifest.yaml') && !f.path.includes('/attestations/'))
    .reduce((total, f) => total + (f.path.endsWith('.md') ? 1 : count(parseStrictJson(f.bytes))), 0)
}
function verifyFixture(source: FixtureMigratedExport, base: ExportBundle, keys: AttestationKeyRegistry): void {
  try {
    validateRepositoryFiles(source.files)
    const envelope = envelopeSchema.parse(parseStrictJson(source.attestation)), key = keys.verificationKey(envelope.descriptor.keyId)
    if (!key || key.state === 'revoked' || key.publicKey.asymmetricKeyType !== 'ed25519'
      || source.rootExportId !== base.exportId || source.context.exportId === base.exportId
      || source.context.exportId === source.parentExportId
      || canonicalJsonString(source.context) !== canonicalJsonString({ ...contextOf(base), exportId: source.context.exportId, purpose: 'local_preview', publishable: false })
      || canonicalJsonString(envelope.descriptor) !== canonicalJsonString(descriptor(source, envelope.descriptor.keyId))
      || !verify(null, signingBytes(source.schemaVersion, envelope.descriptor), key.publicKey, Buffer.from(envelope.signature, 'base64url'))) throw new Error()
    const controls = source.files.filter(f => f.path.startsWith(`${KNOWLEDGE_ROOT}/attestations/`))
    if (controls.length !== 1 || controls[0].path !== attestationPath(source.context.exportId)
      || !Buffer.from(controls[0].bytes).equals(Buffer.from(source.attestation))) throw new Error()
  } catch { throw new Error('attestation_invalid') }
}

/** This factory is deliberately unavailable outside test processes and is not
 * composed into API/worker/CLI. There is no offline migration entry point:
 * EVERY call executes under the real registered-base transaction, including
 * downgrade of an otherwise valid retained fixture signature after withdrawal.
 * It writes no domain rows or snapshots. Caller may persist ONLY the report. */
export function createSchemaCompatibilityFixture(deps: {
  exports: ReturnType<typeof createGitExportService>; keys: AttestationKeyRegistry
}) {
  fixtureOnly()
  function filesFor(base: ExportBundle, version: FixtureSchema, exportId: string): RepositoryFile[] {
    const context = { ...contextOf(base), exportId, purpose: 'local_preview' as const, publishable: false }
    // Reuse v1 encoder without widening its accepted schema. Temporary v1
    // signature is discarded; only the explicit fixture-domain proof escapes.
    const v1 = buildExportBundle(context, base.assets.map(s => ({ ...s, asset: { ...s.asset, exportId } })), deps.keys)
    return contentFiles(v1.files).map(file => {
      if (version === 'memory-git.v1' || !file.path.endsWith('.yaml')) return file
      const raw = parseStrictJson(file.bytes) as Record<string, unknown>
      if (file.path.endsWith('/manifest.yaml')) return { ...file, bytes: exportJsonBytes({ ...raw, schemaVersion: version }) }
      const { editable, ...rest } = raw
      return { ...file, bytes: exportJsonBytes({ ...rest, schemaVersion: version, document: editable }) }
    })
  }
  return {
    async convert(input: { grant: V2GrantFacts; root: { installationId: string; connectionId: string; expectedGeneration: string; exportId: string };
      targetSchema: unknown; source?: FixtureMigratedExport }): Promise<Result> {
      fixtureOnly()
      const fromSchema = input.source ? schema(input.source.schemaVersion) : 'memory-git.v1', toSchema = schema(input.targetSchema)
      const report: SchemaMigrationReport = { fromSchema, toSchema, assetCount: 0, fromFieldCount: 0, toFieldCount: 0,
        fromHash: null, toHash: null, lossless: false, rejectionReason: null }
      if (fromSchema === 'unknown' || toSchema === 'unknown') return { ok: false, report: { ...report, rejectionReason: 'unknown_schema' } }
      let entered = false
      try {
        return await deps.exports.withRegisteredBase(input.grant, input.root, async ({ base }) => {
          entered = true
          report.assetCount = base.assets.length
          const source = input.source
          if (source) verifyFixture(source, base, deps.keys)
          const before = source ? contentFiles(source.files) : contentFiles(base.files)
          report.fromHash = rawFilesDigest(before)
          report.fromFieldCount = fieldCount(before)
          if (source) {
            // Exact comparison to independently reconstructed registered B
            // rejects unknown/missing fields and every content change. Neither
            // a valid signature nor schema rename grants editing authority.
            const expected = filesFor(base, fromSchema, source.context.exportId)
            if (rawFilesDigest(expected) !== report.fromHash) throw new Error('lossy_conversion')
          }
          const exportId = randomUUID(), context = { ...contextOf(base), exportId,
            purpose: 'local_preview' as const, publishable: false }
          const files = filesFor(base, toSchema, exportId), signer = deps.keys.signingKey(), key = deps.keys.verificationKey(signer.keyId)
          if (!key || key.state !== 'active' || key.publicKey.asymmetricKeyType !== 'ed25519'
            || signer.privateKey.asymmetricKeyType !== 'ed25519') throw new Error('attestation_invalid')
          const next = { schemaVersion: toSchema, rootExportId: base.exportId, parentExportId: source?.context.exportId ?? base.exportId, context, files }
          const desc = descriptor(next, signer.keyId)
          const signature = sign(null, signingBytes(toSchema, desc), signer.privateKey).toString('base64url')
          const attestation = exportJsonBytes({ descriptor: desc, signature })
          report.toFieldCount = fieldCount(files)
          report.toHash = rawFilesDigest(files)
          if (report.toFieldCount !== report.fromFieldCount) throw new Error('lossy_conversion')
          const bundle: FixtureMigratedExport = { ...next, attestation,
            files: [...files, { path: attestationPath(exportId), mode: '100644' as const, bytes: attestation }].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))) }
          verifyFixture(bundle, base, deps.keys)
          return { ok: true as const, bundle, report: { ...report, lossless: true } }
        })
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        const rejectionReason: Rejection = entered && (code === 'attestation_invalid' || code === 'lossy_conversion') ? code : 'registered_base_unavailable'
        return { ok: false, report: { ...report, toHash: null, toFieldCount: 0, lossless: false, rejectionReason } }
      }
    },
  }
}
