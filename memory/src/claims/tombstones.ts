import {identityTombstoneDomainV2} from './identity.js'
import { createHmac } from 'crypto'
import type pg from 'pg'
import type { TombstoneHmacKey } from '../config.js'

type QueryClient = Pick<pg.Pool | pg.PoolClient, 'query'>

export function tombstoneIdentityHmac(normalizedKey: string, key: string): Buffer {
  return createHmac('sha256', key).update(normalizedKey, 'utf8').digest()
}

export async function insertKnowledgeTombstones(
  client: QueryClient,
  input: {
    installationId: string
    normalizedKeys: readonly string[]
    normalizedKeysV2?:readonly string[]
    reason: 'privacy_delete' | 'source_purge'
    keys: readonly TombstoneHmacKey[]
  },
): Promise<void> {
  if (input.keys.length === 0) throw new Error('tombstone_hmac_keys_required')
  for (const normalizedKey of new Set([...input.normalizedKeys,...(input.normalizedKeysV2??[]).map(identityTombstoneDomainV2)])) {
    for (const key of input.keys) {
      await client.query(`
        INSERT INTO knowledge_tombstones
          (installation_id, key_id, identity_hmac, reason)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT DO NOTHING
      `, [
        input.installationId,
        key.version,
        tombstoneIdentityHmac(normalizedKey, key.key),
        input.reason,
      ])
    }
  }
}

export async function findTombstonedNormalizedKeys(
  client: QueryClient,
  input: {
    installationId: string
    normalizedKeys: readonly string[]
    identityV2ByNormalizedKey?:Readonly<Record<string,readonly string[]>>
    keys: readonly TombstoneHmacKey[]
  },
): Promise<ReadonlySet<string>> {
  if (input.normalizedKeys.length === 0 || input.keys.length === 0) return new Set()
  const expected = new Map<string, Set<string>>()
  const digests: Buffer[] = []
  for (const normalizedKey of new Set(input.normalizedKeys)) {
    const identities=[normalizedKey,...(input.identityV2ByNormalizedKey?.[normalizedKey]??[]).map(identityTombstoneDomainV2)]
    for(const identity of identities)for(const key of input.keys){
      const digest=tombstoneIdentityHmac(identity,key.key),lookup=key.version+':'+digest.toString('hex')
      const aliases=expected.get(lookup)??new Set<string>();aliases.add(normalizedKey);expected.set(lookup,aliases);digests.push(digest)
    }
  }
  const rows = await client.query<{ key_id: string; identity_hmac: Buffer }>(`
    SELECT key_id, identity_hmac
    FROM knowledge_tombstones
    WHERE installation_id = $1
      AND key_id = ANY($2::text[])
      AND identity_hmac = ANY($3::bytea[])
  `, [input.installationId, input.keys.map(key => key.version), digests])
  const found = new Set<string>()
  for (const row of rows.rows) {
    for(const normalizedKey of expected.get(`${row.key_id}:${row.identity_hmac.toString('hex')}`)??[])found.add(normalizedKey)
  }
  return found
}

/** Refuse startup when rotation removed a key version still used by rows. */
export async function validateTombstoneKeyring(
  client: QueryClient,
  keys: readonly TombstoneHmacKey[],
): Promise<void> {
  const rows = await client.query<{ key_id: string }>(`
    SELECT DISTINCT key_id FROM knowledge_tombstones ORDER BY key_id
  `)
  const configured = new Set(keys.map(key => key.version))
  const missing = rows.rows.map(row => row.key_id).filter(keyId => !configured.has(keyId))
  if (missing.length > 0) throw new Error('tombstone_hmac_keyring_incomplete')
}
