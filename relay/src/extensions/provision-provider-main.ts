import { pathToFileURL } from 'node:url'
import { createPool, parseDBUrl } from '../db.js'
import { getExtensionProviderManifest } from './catalog.js'
import { createProviderCredential } from './provider-auth.js'

/**
 * Provision (or rotate) a first-party provider credential.
 *
 *   npm run extension:provision-provider -- --provider pocketctl-memory [--rotate-after 3600]
 *
 * The client secret is generated server-side with randomBytes(32) and never
 * accepted from the command line; stdout shows it exactly once.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const providerIndex = args.indexOf('--provider')
  const providerId = providerIndex !== -1 ? args[providerIndex + 1] : undefined
  if (!providerId || !getExtensionProviderManifest(providerId)) {
    throw new Error('--provider must name a catalog allowlist provider (pocketctl-memory)')
  }
  const rotateIndex = args.indexOf('--rotate-after')
  const rotateAfter = rotateIndex !== -1 ? Number(args[rotateIndex + 1]) : undefined
  if (rotateAfter !== undefined
    && (!Number.isSafeInteger(rotateAfter) || rotateAfter <= 0)) {
    throw new Error('--rotate-after must be a positive integer (seconds)')
  }

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const pool = createPool(parseDBUrl(databaseUrl), { name: 'extension-provision' })
  try {
    const credential = await createProviderCredential(pool, {
      providerId,
      rotatePreviousAfterSeconds: rotateAfter,
    })
    // Single display of the plaintext secret; only the digest is persisted.
    console.log(JSON.stringify({
      provider_id: providerId,
      client_id: credential.clientId,
      client_secret: credential.clientSecret,
      fingerprint: credential.fingerprint,
      note: 'store this secret now; it will not be shown again',
    }, null, 2))
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error('[extension-provision] failed', {
      errorName: error instanceof Error ? error.name : typeof error,
    })
    process.exitCode = 1
  })
}
