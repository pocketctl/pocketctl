/** Bounded fixed-window limiter; new keys fail closed once the live-key cap is reached. */
export function createRateLimiter(limit: number, windowMs: number, maxKeys = 10_000) {
  const windows = new Map<string, { count: number; resetAt: number }>()
  return {
    check(key: string): { allowed: boolean } {
      const now = Date.now()
      const entry = windows.get(key)
      if (!entry || entry.resetAt <= now) {
        if (windows.size >= maxKeys) {
          for (const [candidate, value] of windows) {
            if (value.resetAt <= now) windows.delete(candidate)
          }
        }
        if (!entry && windows.size >= maxKeys) return { allowed: false }
        windows.set(key, { count: 1, resetAt: now + windowMs })
        return { allowed: true }
      }
      entry.count++
      return { allowed: entry.count <= limit }
    },
  }
}
