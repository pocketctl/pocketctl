/**
 * Verification code store — shared between SMS and Email auth flows.
 *
 * In-memory Map with expiry. For multi-instance deployments,
 * replace with Redis (same interface).
 */

interface CodeEntry {
  code: string;
  expiresAt: number;
}

const codeStore = new Map<string, CodeEntry>();

/** Clean up expired entries periodically (every 60s) */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of codeStore) {
    if (now > entry.expiresAt) codeStore.delete(key);
  }
}, 60_000).unref();

/** Generate a 6-digit verification code */
export function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** Store a verification code with expiry */
export function storeCode(key: string, code: string, ttlMs: number = 5 * 60 * 1000): void {
  codeStore.set(key, { code, expiresAt: Date.now() + ttlMs });
}

/** Verify a code against the stored value. Returns true and deletes the code on success. */
export function verifyCode(key: string, code: string): boolean {
  const entry = codeStore.get(key);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    codeStore.delete(key);
    return false;
  }
  if (entry.code !== code) return false;
  codeStore.delete(key);
  return true;
}

/** Check if a code exists and is not expired (for rate limiting checks) */
export function hasPendingCode(key: string): boolean {
  const entry = codeStore.get(key);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    codeStore.delete(key);
    return false;
  }
  return true;
}
