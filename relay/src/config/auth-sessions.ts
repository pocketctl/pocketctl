/**
 * OAuth 2.0 Device Authorization Session Store
 *
 * In-memory store for device authorization sessions per RFC 8628.
 * Sessions expire after 600 seconds (10 minutes).
 * Periodic cleanup removes expired sessions every 60 seconds.
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
  expires_at: number; // Date.now() + 600_000
  last_poll_at: number;
}

const sessions = new Map<string, DeviceAuthSession>();
const userCodeIndex = new Map<string, string>(); // user_code → device_code

const DEVICE_CODE_TTL = 600_000; // 10 minutes
const CLEANUP_INTERVAL = 60_000; // 1 minute

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function generateCode(length: number): string {
  return randomBytes(length)
    .toString('base64url')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, length);
}

function generateUserCode(): string {
  // 8-char human-readable code: XXXX-XXXX (uppercase alphanumeric)
  const raw = generateCode(8).toUpperCase();
  return raw.slice(0, 4) + '-' + raw.slice(4, 8);
}

function generateDeviceCode(): string {
  return generateCode(40);
}

export function createSession(
  clientId: string,
  codeChallenge: string,
  machineId?: string
): { device_code: string; user_code: string; expires_in: number; interval: number } {
  const device_code = generateDeviceCode();
  const user_code = generateUserCode();
  const now = Date.now();

  const session: DeviceAuthSession = {
    device_code,
    user_code,
    client_id: clientId,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    machine_id: machineId,
    status: 'pending',
    created_at: now,
    expires_at: now + DEVICE_CODE_TTL,
    last_poll_at: 0,
  };

  sessions.set(device_code, session);
  userCodeIndex.set(user_code, device_code);

  startCleanup();

  return {
    device_code,
    user_code,
    expires_in: Math.floor(DEVICE_CODE_TTL / 1000), // 600
    interval: 5,
  };
}

export function getSessionByDeviceCode(deviceCode: string): DeviceAuthSession | undefined {
  const session = sessions.get(deviceCode);
  if (!session) return undefined;
  if (Date.now() > session.expires_at) {
    sessions.delete(deviceCode);
    if (session.user_code) userCodeIndex.delete(session.user_code);
    return undefined;
  }
  return session;
}

export function getSessionByUserCode(userCode: string): DeviceAuthSession | undefined {
  const deviceCode = userCodeIndex.get(userCode.toUpperCase());
  if (!deviceCode) return undefined;
  const session = sessions.get(deviceCode);
  if (!session) {
    userCodeIndex.delete(userCode);
    return undefined;
  }
  if (Date.now() > session.expires_at) {
    sessions.delete(deviceCode);
    userCodeIndex.delete(userCode);
    return undefined;
  }
  return session;
}

export function authorizeSession(userCode: string, userId: number): boolean {
  const session = getSessionByUserCode(userCode);
  if (!session) return false;
  session.status = 'authorized';
  session.user_id = userId;
  return true;
}

export function recordPoll(deviceCode: string): void {
  const session = sessions.get(deviceCode);
  if (session) session.last_poll_at = Date.now();
}

export function canPoll(deviceCode: string, interval: number): boolean {
  const session = sessions.get(deviceCode);
  if (!session) return true;
  // Return true if enough time has elapsed since last poll
  return Date.now() - session.last_poll_at >= interval * 1000;
}

export function deleteSession(deviceCode: string): void {
  const session = sessions.get(deviceCode);
  if (session) {
    userCodeIndex.delete(session.user_code);
    sessions.delete(deviceCode);
  }
}

function startCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [code, session] of sessions) {
      if (now > session.expires_at) {
        sessions.delete(code);
        userCodeIndex.delete(session.user_code);
      }
    }
    // Stop cleanup if no more sessions
    if (sessions.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, CLEANUP_INTERVAL);
  // Allow process to exit even with this timer
  if (cleanupTimer && 'unref' in cleanupTimer) {
    cleanupTimer.unref();
  }
}
