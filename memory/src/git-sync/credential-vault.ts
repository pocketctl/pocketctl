import { createCipheriv, createDecipheriv, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'
import type pg from 'pg'
import { createDatabaseAttestationRegistry, type DatabaseAttestationRegistry } from './key-registry.js'

/** Separate HKDF domains; the configured server secret never enters a database or DTO. */
export function createGitCredentialVault(secret: string) {
  if (Buffer.byteLength(secret) < 32) throw new Error('git_feature_disabled')
  const key = Buffer.from(hkdfSync('sha256', secret, 'pocketctl-memory', 'git-managed-credentials-v1', 32))
  return {
    seal(value: string, context: string): Buffer {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(Buffer.from(context))
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    open(bytes: Buffer, context: string): string {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
        decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(bytes.subarray(12, 28))
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
      } catch { throw new Error('git_credential_unavailable') }
    },
  }
}

export function createManagedGitKeys(pool: pg.Pool, secret: string): DatabaseAttestationRegistry & { ensureSigner(): Promise<void> } {
  const vault = createGitCredentialVault(secret)
  async function registry(db: Pick<pg.Pool,'query'>) {
    const row = (await db.query(`SELECT key_id,private_key_cipher FROM memory_git_managed_signer WHERE singleton=true`)).rows[0]
    return createDatabaseAttestationRegistry({pool, ...(row ? {signer:{keyId:row.key_id,privateKey:createPrivateKey(vault.open(row.private_key_cipher, 'git-signer-v1'))}} : {})})
  }
  return { kind:'database',
    async ensureSigner() {
      const keys = generateKeyPairSync('ed25519'), keyId = `managed-${randomBytes(12).toString('hex')}`
      const pem = keys.privateKey.export({format:'pem',type:'pkcs8'}).toString()
      await pool.query(`INSERT INTO memory_git_managed_signer(singleton,key_id,private_key_cipher) VALUES(true,$1,$2) ON CONFLICT DO NOTHING`, [keyId,vault.seal(pem,'git-signer-v1')])
      await (await registry(pool)).registerSigner()
    },
    async registerSigner() { await (await registry(pool)).registerSigner() },
    async transactionView(client) { return (await registry(client)).transactionView(client) },
    async transition(id,state) { return createDatabaseAttestationRegistry({pool}).transition(id,state) },
  }
}
