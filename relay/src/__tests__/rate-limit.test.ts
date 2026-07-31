import { describe, it, expect } from 'vitest';
import { ConnectionRateLimiter, authFailBanDuration, DEFAULT_RATE_LIMIT_CONFIG } from '../rate-limit.js';

const cfg = {
  burstWindowMs: 10_000,
  burstMax: 5,
  windowMs: 60_000,
  windowMax: 30,
  authFailThreshold: 3,
};

describe('authFailBanDuration', () => {
  it('tolerates failures below the threshold', () => {
    expect(authFailBanDuration(0, cfg)).toBe(0);
    expect(authFailBanDuration(2, cfg)).toBe(0);
  });
  it('escalates on the ladder and caps at 30m', () => {
    expect(authFailBanDuration(3, cfg)).toBe(30);
    expect(authFailBanDuration(4, cfg)).toBe(120);
    expect(authFailBanDuration(5, cfg)).toBe(600);
    expect(authFailBanDuration(6, cfg)).toBe(1800);
    expect(authFailBanDuration(100, cfg)).toBe(1800); // cap
  });
});

describe('ConnectionRateLimiter', () => {
  const make = () => {
    let t = 1_000_000;
    const now = () => t;
    const limiter = new ConnectionRateLimiter(cfg, now);
    const advance = (ms: number) => { t += ms; };
    return { limiter, advance };
  };

  it('blocks the (burstMax+1)th connection in a burst', () => {
    const { limiter } = make();
    for (let i = 0; i < 5; i++) expect(limiter.check('1.2.3.4').allowed).toBe(true);
    const r = limiter.check('1.2.3.4');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/burst/);
  });

  it('resets the burst budget after the burst window', () => {
    const { limiter, advance } = make();
    for (let i = 0; i < 5; i++) limiter.check('1.2.3.4');
    advance(10_001);
    expect(limiter.check('1.2.3.4').allowed).toBe(true);
  });

  it('blocks sustained traffic over the long window (independent of burst)', () => {
    let t = 1_000_000;
    const limiter = new ConnectionRateLimiter(
      { burstWindowMs: 10_000, burstMax: 1000, windowMs: 60_000, windowMax: 3, authFailThreshold: 3 },
      () => t,
    );
    const advance = (ms: number) => { t += ms; };
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false); // 4th > windowMax 3
    advance(60_001);
    expect(limiter.check('a').allowed).toBe(true); // window reset
  });

  it('bans an IP only after the threshold of consecutive auth failures', () => {
    const { limiter } = make();
    expect(limiter.recordAuthFailure('1.2.3.4')).toBe(0); // fail 1
    expect(limiter.recordAuthFailure('1.2.3.4')).toBe(0); // fail 2
    expect(limiter.recordAuthFailure('1.2.3.4')).toBe(30); // fail 3 → 30s ban
    const r = limiter.check('1.2.3.4');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/ban/);
  });

  it('persists the failure count across ban expiry so offenders escalate', () => {
    const { limiter, advance } = make();
    for (let i = 0; i < 3; i++) limiter.recordAuthFailure('z'); // → 30s ban
    expect(limiter.recordAuthFailure('z')).toBe(120); // 4th fail → 2m
    advance(200_000); // past 2m
    expect(limiter.recordAuthFailure('z')).toBe(600); // 5th fail → 10m, not reset
  });

  it('clears the failure history on a successful auth', () => {
    const { limiter } = make();
    for (let i = 0; i < 3; i++) limiter.recordAuthFailure('x');
    expect(limiter.check('x').allowed).toBe(false); // banned
    limiter.clearAuthFailure('x');
    expect(limiter.check('x').allowed).toBe(true); // forgiven
    expect(limiter.recordAuthFailure('x')).toBe(0); // counter reset to fail 1
  });

  it('gc forgets a stale offender after 24h of inactivity', () => {
    let t = 1_000_000;
    const limiter = new ConnectionRateLimiter(cfg, () => t);
    limiter.recordAuthFailure('old'); // fail 1
    t += 86_400_001; // 24h+
    limiter.gc();
    // entry dropped → next failures start fresh (no immediate ban)
    expect(limiter.recordAuthFailure('old')).toBe(0); // fail 1
    expect(limiter.recordAuthFailure('old')).toBe(0); // fail 2
  });
});
