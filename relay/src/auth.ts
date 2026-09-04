import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { isTokenRevoked, userExists } from './db.js';
import type { Pool } from 'pg';

const JWT_SECRET: string = process.env.JWT_SECRET ?? '';
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required');
  process.exit(1);
}
const ACCESS_TOKEN_TTL = '24h';
const REFRESH_TOKEN_TTL = '7d';
const SESSION_SHARE_TOKEN_TTL = '15m';
const STABLE_MACHINE_ID = /^(?:machine-[a-f0-9]{32}|daemon-[a-f0-9]{8})$/;
// Security cutover: tokens issued before verified-email-only authentication
// did not carry this claim and may belong to a pre-hijacked mailbox account.
// Reject them globally so deploying this release forces one clean re-login.
const AUTH_TOKEN_SCHEMA = 1;

/** Return a Relay-safe persistent installation identity, if supplied. */
export function stableMachineId(machineId: unknown): string | undefined {
  return typeof machineId === 'string' && STABLE_MACHINE_ID.test(machineId)
    ? machineId
    : undefined;
}

/**
 * Preserve an identity already bound to a refresh token. Only legacy refresh
 * tokens without that claim may be bound from the requesting CLI's machine ID.
 */
export function resolveRefreshMachineId(tokenMachineId: unknown, requestedMachineId: unknown): string | undefined {
  return stableMachineId(tokenMachineId) ?? stableMachineId(requestedMachineId);
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

function generateJTI(): string {
  return randomBytes(16).toString('base64url');
}

export async function signAccessToken(
  userId: number,
  email: string,
  phone?: string,
  machineId?: string
): Promise<string> {
  const jti = generateJTI();
  return jwt.sign(
    {
      userId,
      email,
      phone: phone || undefined,
      type: 'access',
      auth_schema: AUTH_TOKEN_SCHEMA,
      jti,
      machine_id: stableMachineId(machineId) || 'unknown',
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

export async function signRefreshToken(userId: number, machineId?: string): Promise<string> {
  const jti = generateJTI();
  return jwt.sign(
    {
      userId,
      type: 'refresh',
      auth_schema: AUTH_TOKEN_SCHEMA,
      jti,
      machine_id: stableMachineId(machineId),
    },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_TTL }
  );
}

export function verifyAccessToken(
  token: string,
  pool?: Pool
): { userId: number; email: string; jti: string; machine_id: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded.type !== 'access') return null;
    if (decoded.auth_schema !== AUTH_TOKEN_SCHEMA) return null;
    return {
      userId: decoded.userId,
      email: decoded.email,
      jti: decoded.jti || '',
      machine_id: stableMachineId(decoded.machine_id) || 'unknown',
    };
  } catch {
    return null;
  }
}

/** Verify access token with revocation check (requires db pool). */
export async function verifyAccessTokenWithRevocation(
  token: string,
  pool: Pool
): Promise<{ userId: number; email: string; jti: string; machine_id: string } | null> {
  const payload = verifyAccessToken(token);
  if (!payload) return null;

  // Check revocation
  if (payload.jti) {
    try {
      const revoked = await isTokenRevoked(pool, payload.jti);
      if (revoked) return null;
    } catch {
      console.error('revocation check failed:', `user=${payload.userId} jti=${payload.jti.slice(0, 8)}`);
      return null;
    }
  }

  try {
    if (!await userExists(pool, payload.userId)) return null;
  } catch {
    // Account existence is an authorization boundary. Fail closed so a
    // deleted account cannot regain access during a database fault.
    console.error('user existence check failed:', `user=${payload.userId}`);
    return null;
  }

  return payload;
}

export function verifyRefreshToken(token: string): { userId: number; jti: string; machine_id?: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded.type !== 'refresh') return null;
    if (decoded.auth_schema !== AUTH_TOKEN_SCHEMA) return null;
    return { userId: decoded.userId, jti: decoded.jti || '', machine_id: stableMachineId(decoded.machine_id) };
  } catch {
    return null;
  }
}

export interface RevocableTokenClaims {
  type: 'access' | 'refresh';
  userId: number;
  jti: string;
  exp: number;
}

/**
 * M-5: verify a token presented for revocation. Signature first (algorithms
 * pinned to HS256; alg=none and wrong keys fail), then structure: exact
 * access|refresh type, positive-integer userId, bounded base64url jti, finite
 * iat/exp. Expiry is deliberately ignored so a just-expired token can still be
 * revoked, but an unsigned or malformed one never is. This is the ONLY path
 * allowed to decide whether a revocation is written — decodeToken and manual
 * payload splitting must not be used for authorization.
 */
export function verifyTokenForRevocation(token: string): RevocableTokenClaims | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], ignoreExpiration: true }) as any;
    if (!decoded || typeof decoded === 'string') return null;
    if (decoded.type !== 'access' && decoded.type !== 'refresh') return null;
    if (!Number.isSafeInteger(decoded.userId) || decoded.userId <= 0) return null;
    if (typeof decoded.jti !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(decoded.jti)) return null;
    if (typeof decoded.iat !== 'number' || !Number.isFinite(decoded.iat)) return null;
    if (typeof decoded.exp !== 'number' || !Number.isFinite(decoded.exp) || decoded.exp <= 0) return null;
    return { type: decoded.type, userId: decoded.userId, jti: decoded.jti, exp: decoded.exp };
  } catch {
    return null;
  }
}

export function signSessionShareToken(userId: number, sessionId: string): string {
  return jwt.sign(
    {
      type: 'session_share',
      userId,
      sessionId,
    },
    JWT_SECRET,
    { expiresIn: SESSION_SHARE_TOKEN_TTL }
  );
}

export function verifySessionShareToken(
  token: string
): { userId: number; sessionId: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded || typeof decoded === 'string') return null;
    const allowedClaims = new Set(['type', 'userId', 'sessionId', 'iat', 'exp']);
    if (Object.keys(decoded).some((key) => !allowedClaims.has(key))) return null;
    if (decoded.type !== 'session_share') return null;
    if (!Number.isSafeInteger(decoded.userId) || (decoded.userId as number) <= 0) return null;
    if (typeof decoded.sessionId !== 'string' || decoded.sessionId.length === 0) return null;
    if (typeof decoded.iat !== 'number' || typeof decoded.exp !== 'number') return null;
    return { userId: decoded.userId as number, sessionId: decoded.sessionId };
  } catch {
    return null;
  }
}

/** Extract JWT payload without verifying signature (for preview/inspection). */
export function decodeToken(token: string): { userId?: number; jti?: string; type?: string; machine_id?: string } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}
