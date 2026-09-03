import { createHash, sign, verify, type KeyObject } from 'node:crypto'
import { z } from 'zod'
import { canonicalJsonString } from '../inbox/canonical-json.js'
import { assetContentHash, encodeAsset } from './codec.js'
import { DigestSchema, RevisionSchema, GIT_SCHEMA_VERSION, ASSET_KINDS, type AssetSnapshot, type ExportBundle, type RepositoryFile } from './types.js'
import { KNOWLEDGE_ROOT, validateAssetPaths, validateRepositoryFiles } from './paths.js'
import { parseStrictJson } from './strict-json.js'

export const ExportContextSchema = z.object({ installationId: z.uuid(), repositoryId: z.uuid(), connectionId: z.uuid(),
  generation: RevisionSchema.refine(v => v !== '0'), exportId: z.uuid(), baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  tombstoneGeneration: RevisionSchema, purpose: z.enum(['local_preview','external_export']), publishable: z.boolean() }).strict()
export type ExportContext = z.infer<typeof ExportContextSchema>
/** Injected independent Git signing registry. Retired keys verify history; revoked keys never do.
 * Production key loading/rotation is a runtime composition concern, not a request input. */
export interface AttestationKeyRegistry {
  signingKey(): { keyId: string; privateKey: KeyObject }
  verificationKey(keyId: string): { publicKey: KeyObject; state: 'active' | 'retired' | 'revoked' } | null
}
const assetDescriptor = z.object({ kind: z.enum(ASSET_KINDS), id: z.uuid(), versionId: z.uuid(), revision: RevisionSchema,
  sourceDigest: DigestSchema, contentHash: DigestSchema, path: z.string().max(512) }).strict()
const descriptorSchema = z.object({ schemaVersion: z.literal(GIT_SCHEMA_VERSION), keyId: z.string().min(1).max(128),
  context: ExportContextSchema, assets: z.array(assetDescriptor).min(1).max(254),
  files: z.array(z.object({ path: z.string().max(512), mode: z.literal('100644'), hash: DigestSchema }).strict()).max(255),
  filesDigest: DigestSchema }).strict()
const envelopeSchema = z.object({ descriptor: descriptorSchema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict()
const order = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))
const sorted = (files: readonly RepositoryFile[]) => [...files].sort((a,b) => order(a.path,b.path))
export const rawFileHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export const exportJsonBytes = (value: unknown) => Buffer.from(JSON.stringify(JSON.parse(canonicalJsonString(value)), null, 2) + '\n')
function framed(...fields: Uint8Array[]): Buffer {
  return Buffer.concat(fields.flatMap(field => { const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(field.byteLength)); return [size, Buffer.from(field)] }))
}
/** Length-prefixed raw bytes, sorted by UTF-8 path bytes. No Markdown/JSON normalization. */
export function rawFilesDigest(files: readonly RepositoryFile[]): string {
  validateRepositoryFiles(files)
  return rawFileHash(framed(...sorted(files).map(file => framed(Buffer.from(file.path), Buffer.from(file.mode), file.bytes))))
}
function baseFiles(context: ExportContext, snapshots: AssetSnapshot[]) {
  if (snapshots.length === 0) throw new Error('git_attestation_empty')
  validateAssetPaths(snapshots.map(s => s.asset))
  const assets = [...snapshots].sort((a,b) => order(a.asset.path,b.asset.path))
  const descriptors = assets.map(({asset,contentHash,deleted}) => {
    if (deleted || asset.connectionId !== context.connectionId || asset.exportId !== context.exportId
      || asset.immutable.installationId !== context.installationId || asset.immutable.ownerScopeKind === 'personal'
      || contentHash !== assetContentHash(asset)) throw new Error('git_attestation_base_mismatch')
    return { kind: asset.key.kind, id: asset.key.id, versionId: asset.baseVersionId, revision: asset.baseRevision,
      sourceDigest: asset.sourceDigest, contentHash, path: asset.path }
  })
  const files = assets.flatMap(snapshot => encodeAsset(snapshot.asset))
  files.push({ path: `${KNOWLEDGE_ROOT}/manifest.yaml`, mode: '100644', bytes: exportJsonBytes({ schemaVersion: GIT_SCHEMA_VERSION, ...context, assets: descriptors }) })
  // Reserve one final file for the detached attestation before building a large descriptor.
  if (files.length + 1 > 256) throw new Error('too_many_files')
  validateRepositoryFiles(files)
  return { assets, descriptors, files: sorted(files) }
}
function describeBase(context: ExportContext, snapshots: AssetSnapshot[], keyId: string) {
  const base = baseFiles(context, snapshots)
  return { ...base, descriptor: descriptorSchema.parse({ schemaVersion: GIT_SCHEMA_VERSION, keyId, context,
    assets: base.descriptors, files: base.files.map(file => ({ path: file.path, mode: file.mode, hash: rawFileHash(file.bytes) })), filesDigest: rawFilesDigest(base.files) }) }
}
const signingBytes = (descriptor: unknown) => framed(Buffer.from('pocketctl-memory-git-attestation.v1'), Buffer.from(canonicalJsonString(descriptor)))

export function buildExportBundle(input: ExportContext, snapshots: AssetSnapshot[], keys: AttestationKeyRegistry): ExportBundle {
  const context = ExportContextSchema.parse(input), signer = keys.signingKey(), registered = keys.verificationKey(signer.keyId)
  if (signer.privateKey.asymmetricKeyType !== 'ed25519' || !registered || registered.state !== 'active'
    || registered.publicKey.asymmetricKeyType !== 'ed25519') throw new Error('git_attestation_key_invalid')
  const { assets, files, descriptor } = describeBase(context, snapshots, signer.keyId)
  const signature = sign(null, signingBytes(descriptor), signer.privateKey).toString('base64url')
  if (!verify(null, signingBytes(descriptor), registered.publicKey, Buffer.from(signature,'base64url'))) throw new Error('git_attestation_key_invalid')
  const attestation = exportJsonBytes({ descriptor, signature })
  files.push({ path: `${KNOWLEDGE_ROOT}/attestations/${context.exportId}.json`, mode: '100644', bytes: attestation })
  validateRepositoryFiles(files)
  return { ...context, assets, files: sorted(files), attestation }
}

/** Verify only a registered immutable DB snapshot reconstructed as a bundle.
 * Git edited files must be parsed separately as untrusted proposals, never passed here as a new base.
 * The envelope excludes itself from file hashes (there is no recursive self-hash). */
export function verifyExportBase(bundle: ExportBundle, expected: ExportContext, keys: AttestationKeyRegistry): true {
  try {
    const context = ExportContextSchema.parse(expected)
    const envelope = envelopeSchema.parse(parseStrictJson(bundle.attestation))
    const key = keys.verificationKey(envelope.descriptor.keyId)
    if (!key || key.state === 'revoked' || key.publicKey.asymmetricKeyType !== 'ed25519') throw new Error('key')
    if (canonicalJsonString(context) !== canonicalJsonString(envelope.descriptor.context)
      || Object.keys(context).some(field => bundle[field as keyof ExportContext] !== context[field as keyof ExportContext])) throw new Error('context')
    if (!verify(null, signingBytes(envelope.descriptor), key.publicKey, Buffer.from(envelope.signature,'base64url'))) throw new Error('signature')
    const base = describeBase(context, bundle.assets, envelope.descriptor.keyId)
    if (canonicalJsonString(base.descriptor) !== canonicalJsonString(envelope.descriptor)) throw new Error('base')
    const expectedFiles = [...base.files, { path: `${KNOWLEDGE_ROOT}/attestations/${context.exportId}.json`, mode: '100644' as const, bytes: bundle.attestation }]
    if (rawFilesDigest(bundle.files) !== rawFilesDigest(expectedFiles)) throw new Error('files')
    return true
  } catch { throw new Error('git_attestation_invalid') }
}

/** Deterministically reconstitute immutable stored bytes without accessing a private key. */
export function restoreExportBundle(snapshots: AssetSnapshot[], attestation: Uint8Array): ExportBundle {
  const { descriptor } = envelopeSchema.parse(parseStrictJson(attestation)), context = descriptor.context
  const base = baseFiles(context, snapshots)
  const files = [...base.files, { path: `${KNOWLEDGE_ROOT}/attestations/${context.exportId}.json`, mode: '100644' as const, bytes: attestation }]
  validateRepositoryFiles(files)
  return { ...context, assets: base.assets, files: sorted(files), attestation }
}
