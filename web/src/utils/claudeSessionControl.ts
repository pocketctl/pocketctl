export interface ClaudeSessionControlInput {
  status: string
  source: string
  daemonOnline: boolean
  isSubagent: boolean
  isManagedSession?: boolean
  capabilities?: string[]
}

const resumableStatuses = new Set(['exited', 'completed', 'error', 'killed'])

// Claude terminal sessions use handoff semantics, not a shared runtime:
// only idle sessions or terminal states explicitly advertised as resumable
// accept input. Daemon-owned PTYs retain their existing writable behavior.
export function canSendClaudeSession(input: ClaudeSessionControlInput): boolean {
  if (input.isSubagent || !input.daemonOnline || input.status === 'disconnected') return false
  if (input.source === 'daemon' || input.isManagedSession) return true
  if (input.source !== 'terminal') return false
  if (input.status === 'idle') return true
  return resumableStatuses.has(input.status)
    && (input.capabilities || []).includes('resume_after_exit')
}
