export interface Entitlements {
  maxBoundDaemons: number | null
  maxConcurrentSessions: number | null
}

export type QuotaEnforcementMode = 'off' | 'observe' | 'enforce'

/**
 * M-4: quota enforcement is a startup-validated contract, not a silent
 * fallback. Invalid values fail in every environment (previously any illegal
 * value quietly became `off`). Production requires an explicit value; the
 * SaaS production profile accepts only `enforce` — `off`/`observe` would let
 * a misconfigured deploy bill nothing while users run unlimited sessions.
 */
export function resolveQuotaEnforcementMode(env: NodeJS.ProcessEnv = process.env): QuotaEnforcementMode {
  const raw = env.QUOTA_ENFORCEMENT
  const production = env.NODE_ENV === 'production'
  const mode = env.POCKETCTL_MODE?.trim() || 'saas'

  if (raw === undefined) {
    if (production) {
      throw new Error(
        'QUOTA_ENFORCEMENT is required in production: enforce (SaaS default) or an explicit off/observe for self-hosted',
      )
    }
    return 'off'
  }
  if (raw !== 'off' && raw !== 'observe' && raw !== 'enforce') {
    throw new Error(`invalid QUOTA_ENFORCEMENT: ${raw} (allowed: off | observe | enforce)`)
  }
  if (production && mode === 'saas' && raw !== 'enforce') {
    throw new Error('QUOTA_ENFORCEMENT must be enforce for production SaaS deployments')
  }
  return raw
}

export function quotaEnforcementMode(): QuotaEnforcementMode {
  return resolveQuotaEnforcementMode(process.env)
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function resolveEntitlements(
  plan: string,
  whitelist: boolean,
  mode = process.env.POCKETCTL_MODE || 'saas',
): Entitlements {
  if (mode === 'self-hosted' || whitelist || plan !== 'free') {
    return { maxBoundDaemons: null, maxConcurrentSessions: null }
  }

  return {
    maxBoundDaemons: positiveInt(process.env.FREE_MAX_BOUND_DAEMONS, 2),
    maxConcurrentSessions: positiveInt(process.env.FREE_MAX_CONCURRENT_SESSIONS, 2),
  }
}
