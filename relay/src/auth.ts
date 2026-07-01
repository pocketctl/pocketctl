import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { isTokenRevoked } from './db.js';
import type { Pool } from 'pg';

const JWT_SECRET: string = process.env.JWT_SECRET ?? '';
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required');
  process.exit(1);
}
const ACCESS_TOKEN_TTL = '24h';
const REFRESH_TOKEN_TTL = '7d';

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
      jti,
      machine_id: machineId || 'unknown',
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

export async function signRefreshToken(userId: number): Promise<string> {
  const jti = generateJTI();
  return jwt.sign(
    {
      userId,
      type: 'refresh',
      jti,
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
    return {
      userId: decoded.userId,
      email: decoded.email,
      jti: decoded.jti || '',
      machine_id: decoded.machine_id || 'unknown',
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
      // DB error — allow token through rather than blocking all auth
      console.error('revocation check failed:', token.slice(0, 10) + '...');
    }
  }

  return payload;
}

export function verifyRefreshToken(token: string): { userId: number; jti: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded.type !== 'refresh') return null;
    return { userId: decoded.userId, jti: decoded.jti || '' };
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
