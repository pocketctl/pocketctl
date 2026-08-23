/**
 * OAuth 2.0 Device Authorization Session Store (RFC 8628)
 *
 * M-2: the store is a factory with injectable config/clock/randomness and a
 * HARD capacity cap. Capacity is the last line of defense behind the shared
 * HTTP rate limiting — even if every rate-limit bucket failed open, an
 * attacker cannot grow this Map past maxSessions. Creation GCs expired
 * sessions first, keeps the user-code index consistent with the session map
 * (no orphan index entries), retries random-code collisions a bounded number
 * of times, and never evicts a still-valid session to make room.
 *
 * Polling follows RFC 8628 §3.5: every poll is recorded; a poll that arrives
 * faster than the current interval receives slow_down and increases that
 * device code's minimum interval by slowDownIncrementSeconds.
 */

import { randomBytes } from 'crypto';

export interface DeviceAuthSession {
  device_code: string;
  user_code: string;
  client_id: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  machine_id?: string;
  status: 'pending' | 'authorized';
  user_id?: number;
  created_at: number; // Date.now()
  expires_at: number; // Date.now() + ttl
  last_poll_at: number;
  interval_seconds: number;
}

export interface DeviceAuthStoreConfig {
  /** Hard cap on concurrently stored sessions (default 10,000). */
  maxSessions: number;
  /** Session lifetime in ms (default 600,000 = 10 minutes). */
  ttlMs: number;
  /** RFC 8628 initial polling interval in seconds (default 5). */
  baseIntervalSeconds: number;
  /** RFC 8628 slow_down increment in seconds (default 5). */
  slowDownIncrementSeconds: number;
  /** Bounded retries when random code generation collides (default 5). */
  maxCreateRetries: number;
}

export const DEFAULT_DEVICE_AUTH_STORE_CONFIG: DeviceAuthStoreConfig = {
  maxSessions: 10_000,
  ttlMs: 600_000,
  baseIntervalSeconds: 5,
  slowDownIncrementSeconds: 5,
  maxCreateRetries: 5,
};

/** Raised only when the store is at its hard capacity; message carries no counts. */
export class DeviceAuthStoreCapacityError extends Error {
  constructor() {
    super('device authorization session store is at capacity, retry later')
    this.name = 'DeviceAuthStoreCapacityError'
  }
}

export type PollDecision =
  | { action: 'poll'; intervalSeconds: number }
  | { action: 'slow_down'; intervalSeconds: number }

export type RandomSource = (length: number) => Buffer

export function createDeviceAuthSessionStore(
  config: Partial<DeviceAuthStoreConfig> = {},
  now: () => number = Date.now,
  randomSource: RandomSource = randomBytes,
) {
  const resolved: DeviceAuthStoreConfig = {
    ...DEFAULT_DEVICE_AUTH_STORE_CONFIG,
    ...config,
  }
  const sessions = new Map<string, DeviceAuthSession>()
  const userCodeIndex = new Map<string, string>() // user_code → device_code

  function generateCode(length: number): string {
    return randomSource(length)
      .toString('base64url')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, length)
  }

  function generateUserCode(): string {
    const raw = generateCode(8).toUpperCase()
    return raw.slice(0, 4) + '-' + raw.slice(4, 8)
  }

  function gc(): void {
    const t = now()
    for (const [code, session] of sessions) {
      if (t > session.expires_at) {
        sessions.delete(code)
        userCodeIndex.delete(session.user_code)
      }
    }
  }

  function create(
    clientId: string,
    codeChallenge: string,
    machineId?: string,
  ): { device_code: string; user_code: string; expires_in: number; interval: number } {
    gc()
    if (sessions.size >= resolved.maxSessions) {
      throw new DeviceAuthStoreCapacityError()
    }
    const t = now()
    let device_code = ''
    let user_code = ''
    for (let attempt = 0; attempt <= resolved.maxCreateRetries; attempt++) {
      const candidateDevice = generateCode(40)
      const candidateUser = generateUserCode()
      // Never overwrite an existing (still-valid) record on collision.
      if (sessions.has(candidateDevice) || userCodeIndex.has(candidateUser)) continue
      device_code = candidateDevice
      user_code = candidateUser
      break
    }
    if (!device_code || !user_code) {
      // Astronomically unlikely; treat as capacity pressure rather than loop.
      throw new DeviceAuthStoreCapacityError()
    }

    const session: DeviceAuthSession = {
      device_code,
      user_code,
      client_id: clientId,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      machine_id: machineId,
      status: 'pending',
      created_at: t,
      expires_at: t + resolved.ttlMs,
      last_poll_at: 0,
      interval_seconds: resolved.baseIntervalSeconds,
    }
    sessions.set(device_code, session)
    userCodeIndex.set(user_code, device_code)

    return {
      device_code,
      user_code,
      expires_in: Math.floor(resolved.ttlMs / 1000),
      interval: resolved.baseIntervalSeconds,
    }
  }

  function getByDeviceCode(deviceCode: string): DeviceAuthSession | undefined {
    const session = sessions.get(deviceCode)
    if (!session) return undefined
    if (now() > session.expires_at) {
      sessions.delete(deviceCode)
      userCodeIndex.delete(session.user_code)
      return undefined
    }
    return session
  }

  function getByUserCode(userCode: string): DeviceAuthSession | undefined {
    const deviceCode = userCodeIndex.get(userCode.toUpperCase())
    if (!deviceCode) return undefined
    const session = sessions.get(deviceCode)
    if (!session) {
      userCodeIndex.delete(userCode.toUpperCase())
      return undefined
    }
    if (now() > session.expires_at) {
      sessions.delete(deviceCode)
      userCodeIndex.delete(session.user_code)
      return undefined
    }
    return session
  }

  function authorize(userCode: string, userId: number): boolean {
    const session = getByUserCode(userCode)
    if (!session) return false
    session.status = 'authorized'
    session.user_id = userId
    return true
  }

  /**
   * RFC 8628 §3.5: record this poll and decide its outcome. A poll faster
   * than the code's current interval returns slow_down and permanently
   * increases that code's minimum interval. Unknown/expired codes create no
   * state, so hammering dead codes cannot grow the store.
   */
  function registerPoll(deviceCode: string): PollDecision {
    const session = sessions.get(deviceCode)
    if (!session) return { action: 'poll', intervalSeconds: resolved.baseIntervalSeconds }
    if (now() > session.expires_at) {
      sessions.delete(deviceCode)
      userCodeIndex.delete(session.user_code)
      return { action: 'poll', intervalSeconds: resolved.baseIntervalSeconds }
    }
    const elapsed = now() - session.last_poll_at
    if (session.last_poll_at > 0 && elapsed < session.interval_seconds * 1000) {
      session.interval_seconds += resolved.slowDownIncrementSeconds
      return { action: 'slow_down', intervalSeconds: session.interval_seconds }
    }
    session.last_poll_at = now()
    return { action: 'poll', intervalSeconds: session.interval_seconds }
  }

  function deleteSession(deviceCode: string): void {
    const session = sessions.get(deviceCode)
    if (session) {
      userCodeIndex.delete(session.user_code)
      sessions.delete(deviceCode)
    }
  }

  return {
    create,
    getByDeviceCode,
    getByUserCode,
    authorize,
    registerPoll,
    deleteSession,
    gc,
    size: () => sessions.size,
    userCodeIndexSize: () => userCodeIndex.size,
  }
}

export type DeviceAuthSessionStore = ReturnType<typeof createDeviceAuthSessionStore>
