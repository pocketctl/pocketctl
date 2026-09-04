/**
 * Fail-closed CORS/Host policy (plan §13). Origins and Hosts come from
 * operator configuration only; an empty allowlist rejects everything in
 * production and rejects cross-origin everywhere.
 */

export interface CorsHostPolicy {
  originAllowed(origin: string | undefined): boolean
  hostAllowed(host: string | undefined): boolean
}

export function createCorsHostPolicy(input: {
  allowedOrigins: readonly string[]
  allowedHosts: readonly string[]
  isProduction: boolean
}): CorsHostPolicy {
  const origins = new Set(input.allowedOrigins.map(origin => origin.replace(/\/+$/, '')))
  const hosts = new Set(input.allowedHosts.map(host => host.toLowerCase()))

  return {
    originAllowed(origin) {
      if (origin === undefined) return true // same-origin/no origin (server-side calls)
      return origins.has(origin.replace(/\/+$/, ''))
    },
    hostAllowed(host) {
      if (host === undefined) return !input.isProduction
      const normalized = host.toLowerCase()
      const bare = normalized.replace(/:\d+$/, '')
      return hosts.has(normalized) || hosts.has(bare)
    },
  }
}
