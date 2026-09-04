import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { upsertProviderDefinitions } from '../extensions/catalog.js'
import {
  authenticateProviderCredentials,
  createProviderCredential,
  secretFingerprint,
  signProviderExtensionToken,
  verifyProviderExtensionToken,
} from '../extensions/provider-auth.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('extension provider credentials (PostgreSQL)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing PostgreSQL integration test against non-test database')
    }
    await initDB(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
    await upsertProviderDefinitions(pool)
  })

  test('provisions a credential that authenticates and stores only the digest', async () => {
    const credential = await createProviderCredential(pool, {
      providerId: 'pocketctl-memory',
      clientId: 'client-main',
    })
    expect(credential.clientSecret.length).toBeGreaterThanOrEqual(32)
    expect(credential.fingerprint).toBe(secretFingerprint(credential.clientSecret))

    const stored = await pool.query<{ secret_digest: string; status: string }>(
      `SELECT secret_digest, status FROM extension_provider_credentials WHERE client_id = 'client-main'`,
    )
    expect(stored.rows[0].secret_digest).toMatch(/^\$2[aby]\$/)
    expect(stored.rows[0].secret_digest).not.toContain(credential.clientSecret)
    expect(stored.rows[0].status).toBe('active')

    const authenticated = await authenticateProviderCredentials(pool, {
      providerId: 'pocketctl-memory',
      clientId: 'client-main',
      clientSecret: credential.clientSecret,
    })
    expect(authenticated?.providerId).toBe('pocketctl-memory')

    expect(await authenticateProviderCredentials(pool, {
      providerId: 'pocketctl-memory',
      clientId: 'client-main',
      clientSecret: 'wrong-secret',
    })).toBeNull()
  })

  test('re-provisioning without rotation keeps the previous credential usable', async () => {
    const first = await createProviderCredential(pool, {
      providerId: 'pocketctl-memory', clientId: 'client-a',
    })
    await createProviderCredential(pool, {
      providerId: 'pocketctl-memory', clientId: 'client-b',
    })
    const stillValid = await authenticateProviderCredentials(pool, {
      providerId: 'pocketctl-memory', clientId: 'client-a',
      clientSecret: first.clientSecret,
    })
    expect(stillValid).not.toBeNull()
  })

  test('rotation overlap expires the old credential after the grace window', async () => {
    const first = await createProviderCredential(pool, {
      providerId: 'pocketctl-memory', clientId: 'client-old',
    })
    await createProviderCredential(pool, {
      providerId: 'pocketctl-memory', clientId: 'client-new',
      rotatePreviousAfterSeconds: 1,
    })
    // Inside the overlap both credentials authenticate.
    expect(await authenticateProviderCredentials(pool, {
      providerId: 'pocketctl-memory', clientId: 'client-old',
      clientSecret: first.clientSecret,
    })).not.toBeNull()

    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(await authenticateProviderCredentials(pool, {
      providerId: 'pocketctl-memory', clientId: 'client-old',
      clientSecret: first.clientSecret,
    })).toBeNull()
  })

  test('a disabled provider fails authentication closed', async () => {
    const credential = await createProviderCredential(pool, {
      providerId: 'pocketctl-memory', clientId: 'client-c',
    })
    await pool.query(`UPDATE extension_providers SET status = 'disabled' WHERE provider_id = 'pocketctl-memory'`)
    expect(await authenticateProviderCredentials(pool, {
      providerId: 'pocketctl-memory', clientId: 'client-c',
      clientSecret: credential.clientSecret,
    })).toBeNull()
  })

  test('round-trips a signed provider token against the database identity', async () => {
    const credential = await createProviderCredential(pool, {
      providerId: 'pocketctl-memory', clientId: 'client-token',
    })
    const token = signProviderExtensionToken({
      providerId: 'pocketctl-memory',
      credentialId: credential.credentialId,
      secret: 'integration-provider-secret-0123456789',
      issuer: 'https://relay.example.test',
    })
    const payload = verifyProviderExtensionToken(token, {
      secret: 'integration-provider-secret-0123456789',
      issuer: 'https://relay.example.test',
    })
    expect(payload).not.toBeNull()
    expect(payload!.credentialId).toBe(credential.credentialId)
  })
})
