// web/src/utils/zcodeObserver.ts
// Pure helpers for the ZCode read-only observer session fail-closed gate.
// Extracted so the security rule is unit-testable without mounting the full
// SessionDetail view, and so every caller applies the identical rule.
//
// Rule: a ZCode observer session is NEVER writable, regardless of status,
// source, control_mode, or capabilities — including forged managed/
// acceptance fields. This is the single source of truth; SessionDetail's
// canWriteWhenConnected calls zcodeCanWrite first and short-circuits on false.

export interface ZcodeObserverSessionInput {
  agentType: string
  /** any status (idle/running/completed/error/...) — never re-enables write */
  status?: string
  /** forged control_mode (e.g. 'managed') must NOT re-enable write */
  controlMode?: string
  /** forged capabilities (e.g. message_acceptance_receipt) must NOT re-enable */
  capabilities?: string[]
  /** daemon online/offline — never re-enables write */
  daemonOnline?: boolean
}

/** Returns true for a ZCode observer session (the only read-only-sync agent). */
export function isZcodeObserverSession(agentType: string): boolean {
  return agentType === 'zcode'
}

/**
 * Fail-closed writeability gate for ZCode observer sessions. Always returns
 * false for zcode; for any other agent returns true so the caller continues to
 * its normal writeability logic. The point is that NO combination of forged
 * fields can make a zcode session writable.
 */
export function zcodeCanWrite(input: ZcodeObserverSessionInput): boolean {
  if (isZcodeObserverSession(input.agentType)) {
    return false
  }
  return true
}
