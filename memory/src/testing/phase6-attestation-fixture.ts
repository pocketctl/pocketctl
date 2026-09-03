import { createPrivateKey, createPublicKey } from 'node:crypto'
import { phase6Snapshot, fixtureId } from './phase6-fixtures.js'
import { assetContentHash } from '../git-sync/codec.js'
import type { AttestationKeyRegistry, ExportContext } from '../git-sync/attestation.js'

/** Public, deterministic TEST ONLY key material. Never used by runtime composition. */
export function attestationFixture() {
  const privateKey = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' + '01'.repeat(32), 'hex'), format: 'der', type: 'pkcs8' })
  const publicKey = createPublicKey(privateKey)
  const second = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' + '02'.repeat(32), 'hex'), format: 'der', type: 'pkcs8' })
  const keys = new Map<string, { publicKey: typeof publicKey; state: 'active' | 'retired' | 'revoked' }>([['test-1', { publicKey, state: 'active' }]])
  const registry: AttestationKeyRegistry = { signingKey: () => ({ keyId: 'test-1', privateKey }), verificationKey: keyId => keys.get(keyId) ?? null }
  const asset = phase6Snapshot().asset
  const context: ExportContext = { installationId: asset.immutable.installationId, repositoryId: fixtureId(8),
    connectionId: asset.connectionId, generation: '1', exportId: asset.exportId, baseCommit: 'a'.repeat(40),
    tombstoneGeneration: '1', purpose: 'local_preview', publishable: false }
  return { registry, keys, second, context, assets: [{ asset, contentHash: assetContentHash(asset), deleted: false }] }
}
