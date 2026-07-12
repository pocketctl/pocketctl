export interface Entitlements {
  maxBoundDaemons: number | null
  maxConcurrentSessions: number | null
}

export type QuotaEnforcementMode = 'off' | 'observe' | 'enforce'

export function quotaEnforcementMode(): QuotaEnforcementMode {
  const value = process.env.QUOTA_ENFORCEMENT
  return value === 'observe' || value === 'enforce' ? value : 'off'
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
