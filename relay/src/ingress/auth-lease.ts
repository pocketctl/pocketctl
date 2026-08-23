interface LeaseState {
  confirmedAt: number
  expiresAt: number
  refreshAt: number
}

export interface AuthLeaseOptions {
  leaseMs?: number
  refreshMs?: number
  now?: () => number
  jitter?: () => number
}

/**
 * Bounded local authority cache for a single daemon registration generation.
 * A lease never outlives its generation and a failed lookup only extends the
 * next retry schedule, never the authority expiry.
 */
export class AuthLeaseManager {
  private readonly states = new Map<string, LeaseState>()
  private readonly leaseMs: number
  private readonly refreshMs: number
  private readonly clock: () => number
  private readonly jitter: () => number

  constructor(options: AuthLeaseOptions = {}) {
    this.leaseMs = options.leaseMs ?? 30_000
    this.refreshMs = options.refreshMs ?? 10_000
    this.clock = options.now ?? Date.now
    this.jitter = options.jitter ?? (() => Math.floor(Math.random() * 1_000))
  }

  confirm(registrationId: string, now = this.clock()): void {
    this.states.set(registrationId, {
      confirmedAt: now,
      expiresAt: now + this.leaseMs,
      refreshAt: now + this.refreshMs + this.nextJitter(),
    })
  }

  shouldRefresh(registrationId: string, now = this.clock()): boolean {
    const state = this.states.get(registrationId)
    return Boolean(state && now >= state.refreshAt)
  }

  isUsable(registrationId: string, now = this.clock()): boolean {
    const state = this.states.get(registrationId)
    return Boolean(state && now < state.expiresAt)
  }

  onLookupUnavailable(registrationId: string, now = this.clock()): 'keep' | 'expire' {
    const state = this.states.get(registrationId)
    if (!state || now >= state.expiresAt) return 'expire'
    state.refreshAt = Math.min(state.expiresAt, now + this.refreshMs + this.nextJitter())
    return 'keep'
  }

  remove(registrationId: string): void {
    this.states.delete(registrationId)
  }

  private nextJitter(): number {
    return Math.max(0, this.jitter())
  }
}
