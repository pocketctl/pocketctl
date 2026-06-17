/**
 * QR Scan-Login Session Store
 *
 * In-memory store for "scan QR to authorize web login" sessions.
 * Flow: web calls createQrSession() → shows QR containing qr_token →
 * iOS scans it and calls confirmQrSession(userId) → web polls
 * getQrSession() and sees status "confirmed", at which point the relay
 * issues JWTs and the session is consumed.
 *
 * Sessions expire after QR_SESSION_TTL (120s) — scan-login is an
 * immediate interaction, shorter than the OAuth device flow.
 * Periodic cleanup removes expired sessions every 30s.
 *
 * NOTE: in-memory like auth-sessions.ts; single-instance only. If we go
 * multi-instance, migrate to Redis (same TODO as verification.ts).
 */

import { randomBytes } from 'crypto';

export type QrSessionStatus = 'pending' | 'scanned' | 'confirmed' | 'expired';

export interface QrSession {
  qr_token: string;
  status: QrSessionStatus;
  user_id?: number; // set when iOS confirms
  created_at: number; // Date.now()
  expires_at: number; // Date.now() + QR_SESSION_TTL
}

const sessions = new Map<string, QrSession>(); // qr_token → session

const QR_SESSION_TTL = 120_000; // 2 minutes
const CLEANUP_INTERVAL = 30_000; // 30 seconds

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function generateQrToken(): string {
  // 32-char URL-safe opaque token
  return randomBytes(24)
    .toString('base64url')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 32);
}

export function createQrSession(): {
  qr_token: string;
  expires_in: number;
} {
  const qr_token = generateQrToken();
  const now = Date.now();
  sessions.set(qr_token, {
    qr_token,
    status: 'pending',
    created_at: now,
    expires_at: now + QR_SESSION_TTL,
  });
  startCleanup();
  return {
    qr_token,
    expires_in: Math.floor(QR_SESSION_TTL / 1000), // 120
  };
}

export function getQrSession(qrToken: string): QrSession | undefined {
  const session = sessions.get(qrToken);
  if (!session) return undefined;
  if (Date.now() > session.expires_at) {
    sessions.delete(qrToken);
    return undefined;
  }
  return session;
}

/** Mark a session as scanned (iOS opened the camera result). Optional middle state. */
export function markScanned(qrToken: string): boolean {
  const session = sessions.get(qrToken);
  if (!session || Date.now() > session.expires_at) {
    if (session) sessions.delete(qrToken);
    return false;
  }
  if (session.status === 'pending') session.status = 'scanned';
  return true;
}

/** iOS confirms the login: bind the authenticated user and mark confirmed. */
export function confirmQrSession(qrToken: string, userId: number): boolean {
  const session = sessions.get(qrToken);
  if (!session || Date.now() > session.expires_at) {
    if (session) sessions.delete(qrToken);
    return false;
  }
  session.status = 'confirmed';
  session.user_id = userId;
  return true;
}

/** Remove a consumed/expired session (called after tokens are issued). */
export function deleteQrSession(qrToken: string): void {
  sessions.delete(qrToken);
}

function startCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (now > session.expires_at) sessions.delete(token);
    }
    if (sessions.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, CLEANUP_INTERVAL);
  if (cleanupTimer && 'unref' in cleanupTimer) {
    cleanupTimer.unref();
  }
}
