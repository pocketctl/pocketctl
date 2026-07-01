// Per-IP connection rate limiting + authentication-failure escalation.
//
// Three layers, checked together on every WS upgrade:
//   1. Burst  — short window (default 10s / 5 conns): stops second-scale
//      reconnect storms and naive DoS before token validation even runs.
//   2. Window — longer window (default 60s / 30 conns): caps sustained rate.
//   3. Auth-fail ban — repeated invalid_token/auth_required from an IP earns
//      an escalating ban (30s → 2m → 10m → 30m cap). This is what actually
//      stops a revoked-token zombie: it necessarily fails auth every reconnect,
//      so it climbs the ladder and goes quiet regardless of client version
//      (no daemon upgrade needed). A successful auth clears the IP's fail count
//      so a user who fat-fingers a token once isn't punished forever.
//
// All logic is pure w.r.t. an injectable clock (default Date.now) so the
// escalation ladder and bans are unit-testable without real time.

export interface RateLimitConfig {
  /** Short burst window in ms (catches second-scale storms). */
  burstWindowMs: number;
  /** Max new connections allowed within one burst window. */
  burstMax: number;
  /** Long window in ms (caps sustained rate). */
  windowMs: number;
  /** Max new connections allowed within one long window. */
  windowMax: number;
  /** Consecutive auth failures before banning starts (≤ this-1 is tolerated). */
  authFailThreshold: number;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  burstWindowMs: 10_000,
  burstMax: 5,
  windowMs: 60_000,
  windowMax: 30,
  authFailThreshold: 3,
};

interface WindowEntry {
  count: number;
  resetAt: number;
}

interface AuthFailEntry {
  fails: number;
  bannedUntil: number;
  lastFailAt: number;
}

export interface CheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Escalating ban duration (seconds) for the Nth CONSECUTIVE auth failure.
 * Below the threshold → 0 (tolerate a couple of fat-fingers). At/above it the
 * ban grows on a ladder: 30s, 2m, 10m, capped at 30m. Pure for unit testing.
 */
export function authFailBanDuration(fails: number, config: RateLimitConfig): number {
  if (fails < config.authFailThreshold) return 0;
  const ladderSeconds = [30, 120, 600, 1800]; // 30s, 2m, 10m, 30m
  const idx = Math.min(fails - config.authFailThreshold, ladderSeconds.length - 1);
  return ladderSeconds[idx];
}

export class ConnectionRateLimiter {
  private readonly burst = new Map<string, WindowEntry>();
  private readonly window = new Map<string, WindowEntry>();
  private readonly authFails = new Map<string, AuthFailEntry>();
  private readonly now: () => number;

  constructor(
    private readonly config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
    now?: () => number,
  ) {
    this.now = now ?? Date.now;
  }

  /** Pre-auth gate: any active auth-fail ban, then burst + window budgets. */
  check(ip: string): CheckResult {
    const t = this.now();

    const af = this.authFails.get(ip);
    if (af && t < af.bannedUntil) {
      return { allowed: false, reason: 'authentication failure ban' };
    }

    // Burst window (short).
    let b = this.burst.get(ip);
    if (!b || t > b.resetAt) b = { count: 0, resetAt: t + this.config.burstWindowMs };
    b.count++;
    this.burst.set(ip, b);
    if (b.count > this.config.burstMax) {
      return { allowed: false, reason: 'burst rate limit exceeded' };
    }

    // Long window (sustained rate).
    let w = this.window.get(ip);
    if (!w || t > w.resetAt) w = { count: 0, resetAt: t + this.config.windowMs };
    w.count++;
    this.window.set(ip, w);
    if (w.count > this.config.windowMax) {
      return { allowed: false, reason: 'rate limit exceeded' };
    }

    return { allowed: true };
  }

  /**
   * Record an auth failure (invalid_token / auth_required). Returns the ban
   * duration in seconds just imposed (0 = still below threshold, not banned).
   * Failure counts persist across a ban window so a repeat offender climbs the
   * ladder instead of resetting every ban expiry.
   */
  recordAuthFailure(ip: string): number {
    const t = this.now();
    let af = this.authFails.get(ip);
    if (!af) af = { fails: 0, bannedUntil: 0, lastFailAt: t };
    af.fails++;
    af.lastFailAt = t;
    const dur = authFailBanDuration(af.fails, this.config);
    if (dur > 0) af.bannedUntil = t + dur * 1000;
    this.authFails.set(ip, af);
    return dur;
  }

  /** Successful auth clears the IP's failure history (forgive past fat-fingers). */
  clearAuthFailure(ip: string): void {
    this.authFails.delete(ip);
  }

  /**
   * Opportunistic GC — call occasionally from a hot path. Drops expired
   * burst/window buckets and auth-fail entries that have been inactive for a
   * full day (so a long-dead zombie is eventually forgiven and the map can't
   * grow unbounded).
   */
  gc(): void {
    const t = this.now();
    for (const [k, v] of this.burst) if (t > v.resetAt) this.burst.delete(k);
    for (const [k, v] of this.window) if (t > v.resetAt) this.window.delete(k);
    const staleAuthMs = 86_400_000; // 24h
    for (const [k, v] of this.authFails) {
      if (t > v.bannedUntil && t > v.lastFailAt + staleAuthMs) this.authFails.delete(k);
    }
  }
}
