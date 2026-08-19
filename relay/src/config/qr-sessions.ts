/**
 * QR Scan-Login Session Store
 *
 * In-memory store for "scan QR to authorize web login" sessions.
 * Flow: web calls create() → shows QR containing qr_token →
 * iOS scans it and calls confirm(userId) → web polls
 * get() and sees status "confirmed", at which point the relay
 * issues JWTs and the session is consumed.
 *
 * M-2: factory with injectable config/clock and a HARD capacity cap —
 * creation GCs expired sessions first, never evicts live sessions, and
 * fails with an explicit capacity error (no occupancy counts in the
 * message) once the cap is reached. Consume/delete recovers capacity.
 *
 * NOTE: in-memory, single-instance only; multi-instance deploys move the
 * shared HTTP rate limiting to PostgreSQL (auth_rate_limits) which already
 * bounds per-IP creation before this store is ever hit.
 */

import { randomBytes } from 'crypto';

export type QrSessionStatus = 'pending' | 'scanned' | 'confirmed' | 'expired';

export interface QrSession {
  qr_token: string;
  status: QrSessionStatus;
  user_id?: number; // set when iOS confirms
  created_at: number; // Date.now()
  expires_at: number; // Date.now() + ttlMs
}

export interface QrSessionStoreConfig {
  /** Hard cap on concurrently stored sessions (default 5,000). */
  maxSessions: number;
  /** Session lifetime in ms (default 120,000 = 2 minutes). */
  ttlMs: number;
}

export const DEFAULT_QR_SESSION_STORE_CONFIG: QrSessionStoreConfig = {
  maxSessions: 5_000,
  ttlMs: 120_000,
};

/** Raised only when the store is at its hard capacity; message carries no counts. */
export class QrSessionStoreCapacityError extends Error {
  constructor() {
    super('QR login session store is at capacity, retry later')
    this.name = 'QrSessionStoreCapacityError'
  }
}

export function createQrSessionStore(
  config: Partial<QrSessionStoreConfig> = {},
  now: () => number = Date.now,
) {
  const resolved: QrSessionStoreConfig = { ...DEFAULT_QR_SESSION_STORE_CONFIG, ...config }
  const sessions = new Map<string, QrSession>() // qr_token → session

  function gc(): void {
    const t = now()
    for (const [token, session] of sessions) {
      if (t > session.expires_at) sessions.delete(token)
    }
  }

  function create(): { qr_token: string; expires_in: number } {
    gc()
    if (sessions.size >= resolved.maxSessions) {
      throw new QrSessionStoreCapacityError()
    }
    const t = now()
    let qr_token = ''
    for (let attempt = 0; attempt <= 5; attempt++) {
      const candidate = randomBytes(24)
        .toString('base64url')
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(0, 32)
      if (sessions.has(candidate)) continue
      qr_token = candidate
      break
    }
    if (!qr_token) throw new QrSessionStoreCapacityError()
    sessions.set(qr_token, {
      qr_token,
      status: 'pending',
      created_at: t,
      expires_at: t + resolved.ttlMs,
    })
    return {
      qr_token,
      expires_in: Math.floor(resolved.ttlMs / 1000),
    }
  }

  function get(qrToken: string): QrSession | undefined {
    const session = sessions.get(qrToken)
    if (!session) return undefined
    if (now() > session.expires_at) {
      sessions.delete(qrToken)
      return undefined
    }
    return session
  }

  /** Mark a session as scanned (iOS opened the camera result). Optional middle state. */
  function markScanned(qrToken: string): boolean {
    const session = sessions.get(qrToken)
    if (!session || now() > session.expires_at) {
      if (session) sessions.delete(qrToken)
      return false
    }
    if (session.status === 'pending') session.status = 'scanned'
    return true
  }

  /** iOS confirms the login: bind the authenticated user and mark confirmed. */
  function confirm(qrToken: string, userId: number): boolean {
    const session = sessions.get(qrToken)
    if (!session || now() > session.expires_at) {
      if (session) sessions.delete(qrToken)
      return false
    }
    session.status = 'confirmed'
    session.user_id = userId
    return true
  }

  /** Remove a consumed/expired session (called after tokens are issued). */
  function remove(qrToken: string): void {
    sessions.delete(qrToken)
  }

  return { create, get, markScanned, confirm, delete: remove, gc, size: () => sessions.size }
}

export type QrSessionStore = ReturnType<typeof createQrSessionStore>
