import { createPublicKey } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { buildExportBundle, verifyExportBase } from '../git-sync/attestation.js'
import { attestationFixture } from '../testing/phase6-attestation-fixture.js'
import { fixtureId } from '../testing/phase6-fixtures.js'
import { decodeAsset } from '../git-sync/codec.js'

describe('Phase 6 immutable export attestation', () => {
  test('emits deterministic complete bytes, separate control files and no private bodies or keys', () => {
    const f = attestationFixture(), bundle = buildExportBundle(f.context, f.assets, f.registry)
    expect(bundle.files.map(file => file.path)).toEqual([
      `.pocketctl/knowledge/attestations/${f.context.exportId}.json`,
      `.pocketctl/knowledge/claims/${f.assets[0]!.asset.key.id}.yaml`, '.pocketctl/knowledge/manifest.yaml',
    ])
    expect(bundle).toEqual(buildExportBundle(f.context, f.assets, f.registry))
    const wire = bundle.files.map(file => Buffer.from(file.bytes).toString()).join('\n')
    expect(wire).not.toMatch(/private excerpt|privatePath|private-branch|PRIVATE KEY|serverOnly/)
    expect(verifyExportBase(bundle, f.context, f.registry)).toBe(true)
  })
  test.each(['installationId','repositoryId','connectionId','exportId','generation','baseCommit','tombstoneGeneration','purpose','publishable'] as const)('rejects replay under changed %s context', field => {
    const f = attestationFixture(), bundle = buildExportBundle(f.context, f.assets, f.registry)
    const changed = { ...f.context, [field]: field.endsWith('Id') ? fixtureId(90) : field === 'baseCommit' ? 'b'.repeat(40)
      : field === 'purpose' ? 'external_export' : field === 'publishable' ? true : '2' }
    expect(() => verifyExportBase(bundle, changed as typeof f.context, f.registry)).toThrow(/git_attestation/)
  })
  test.each(['signature','keyId','schemaVersion','unknown','path','hash'] as const)('rejects tampered attestation %s', mutation => {
    const f = attestationFixture(), bundle = buildExportBundle(f.context, f.assets, f.registry)
    const raw = JSON.parse(Buffer.from(bundle.attestation).toString())
    if (mutation === 'signature') raw.signature = 'A'.repeat(86)
    else if (mutation === 'keyId') raw.descriptor.keyId = 'unknown'
    else if (mutation === 'schemaVersion') raw.descriptor.schemaVersion = 'memory-git.v999'
    else if (mutation === 'unknown') raw.descriptor.invented = true
    else if (mutation === 'path') raw.descriptor.files[0].path += 'x'
    else raw.descriptor.files[0].hash = '0'.repeat(64)
    bundle.attestation = Buffer.from(JSON.stringify(raw))
    expect(() => verifyExportBase(bundle, f.context, f.registry)).toThrow(/git_attestation/)
  })
  test('binds exact raw bytes, ordering-independent path set and baseline version/source', () => {
    const f = attestationFixture(), bundle = buildExportBundle(f.context, f.assets, f.registry)
    expect(verifyExportBase({ ...bundle, files: [...bundle.files].reverse() }, f.context, f.registry)).toBe(true)
    const changed = structuredClone(bundle)
    changed.files[1]!.bytes = Buffer.concat([changed.files[1]!.bytes, Buffer.from('\r\n')])
    expect(() => verifyExportBase(changed, f.context, f.registry)).toThrow(/git_attestation/)
    for (const field of ['baseVersionId','sourceDigest','baseRevision'] as const) {
      const altered = structuredClone(bundle)
      altered.assets[0]!.asset[field] = field === 'baseVersionId' ? fixtureId(99) : field === 'baseRevision' ? '99' : '0'.repeat(64)
      expect(() => verifyExportBase(altered, f.context, f.registry)).toThrow(/git_attestation/)
    }
  })
  test('normal rotation verifies history; unknown, wrong and revoked public keys fail', () => {
    const f = attestationFixture(), bundle = buildExportBundle(f.context, f.assets, f.registry)
    f.keys.get('test-1')!.state = 'retired'
    expect(verifyExportBase(bundle, f.context, f.registry)).toBe(true)
    f.keys.get('test-1')!.state = 'revoked'
    expect(() => verifyExportBase(bundle, f.context, f.registry)).toThrow(/git_attestation/)
    f.keys.set('test-1', { state: 'active', publicKey: createPublicKey(f.second) })
    expect(() => verifyExportBase(bundle, f.context, f.registry)).toThrow(/git_attestation/)
    f.keys.clear()
    expect(() => verifyExportBase(bundle, f.context, f.registry)).toThrow(/git_attestation/)
  })
  test('verifies original base independently of an unsigned human edit proposal', () => {
    const f = attestationFixture(), bundle = buildExportBundle(f.context, f.assets, f.registry)
    const raw = JSON.parse(Buffer.from(bundle.files[1]!.bytes).toString())
    raw.editable.statement = 'Human proposes a revision'
    const proposal = decodeAsset([{ ...bundle.files[1]!, bytes: Buffer.from(JSON.stringify(raw)) }], bundle.assets[0]!)
    expect(proposal.editable).toMatchObject({ statement: 'Human proposes a revision' })
    expect(verifyExportBase(bundle, f.context, f.registry)).toBe(true)
    expect(() => verifyExportBase({ ...bundle, assets: [{ ...bundle.assets[0]!, asset: proposal }] }, f.context, f.registry)).toThrow(/git_attestation/)
  })
  test('counts manifest and attestation against the 256-file bundle limit', () => {
    const f = attestationFixture()
    const assets = Array.from({ length: 255 }, (_, i) => { const snapshot = structuredClone(f.assets[0]!); snapshot.asset.key.id = fixtureId(i+100)
      snapshot.asset.path = `.pocketctl/knowledge/claims/${snapshot.asset.key.id}.yaml`; return snapshot })
    expect(() => buildExportBundle(f.context, assets, f.registry)).toThrow(/too_many_files/)
  })
})
