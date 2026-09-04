import { RelayRequestError } from './errors.js'
import type { RelayHttpClient } from './http-client.js'

const REFRESH_BEFORE_EXPIRY_MS = 30_000

export interface ProviderTokenClientOptions {
  relayUrl: string
  clientId: string
  clientSecret: string
  http: RelayHttpClient
}

interface CachedToken {
  token: string
  /** Epoch ms after which a fresh exchange is required. */
  refreshAfterMs: number
}

/**
 * Provider Extension Token cache. Tokens live in memory only — never the
 * database, never logs. A 401 from any call invalidates the cache once; the
 * next get() exchanges a new token via client credentials.
 */
export function createProviderTokenClient(options: ProviderTokenClientOptions) {
  let cached: CachedToken | null = null
  let exchanging: Promise<CachedToken> | null = null

  async function exchange(): Promise<CachedToken> {
    const body = await options.http.request('POST', '/api/extensions/v1/token', {
      operation: 'provider_token_exchange',
      body: {
        grant_type: 'client_credentials',
        client_id: options.clientId,
        client_secret: options.clientSecret,
      },
    }) as { access_token?: unknown; expires_in?: unknown } | null
    if (typeof body?.access_token !== 'string' || typeof body?.expires_in !== 'number') {
      throw new RelayRequestError({ operation: 'provider_token_exchange', code: 'provider_auth_failed' })
    }
    return {
      token: body.access_token,
      refreshAfterMs: Date.now() + body.expires_in * 1000 - REFRESH_BEFORE_EXPIRY_MS,
    }
  }

  return {
    async get(): Promise<string> {
      if (cached && Date.now() < cached.refreshAfterMs) return cached.token
      if (!exchanging) {
        exchanging = exchange()
          .then(result => {
            cached = result
            return result
          })
          .finally(() => {
            exchanging = null
          })
      }
      return (await exchanging).token
    },
    invalidate(): void {
      cached = null
    },
  }
}

export type ProviderTokenClient = ReturnType<typeof createProviderTokenClient>

/**
 * Run one provider-authenticated call. A single 401 clears the cached token
 * and retries exactly once with a fresh exchange; a second 401 fails closed
 * as provider_auth_failed (bounded auth-failure escalation).
 */
export async function withProviderAuthRetry(
  tokens: ProviderTokenClient,
  operation: string,
  run: (token: string) => Promise<unknown>,
): Promise<unknown> {
  try {
    return await run(await tokens.get())
  } catch (error) {
    if (error instanceof RelayRequestError && error.code === 'unauthorized') {
      tokens.invalidate()
      try {
        return await run(await tokens.get())
      } catch (retryError) {
        if (retryError instanceof RelayRequestError && retryError.code === 'unauthorized') {
          throw new RelayRequestError({ operation, code: 'provider_auth_failed' })
        }
        throw retryError
      }
    }
    throw error
  }
}
