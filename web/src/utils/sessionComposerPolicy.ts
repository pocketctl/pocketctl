import { isManagedOpenCodeSession } from '../types/opencode-interactions'
import { canSendClaudeSession } from './claudeSessionControl'
import { isReadOnlyObserverAgent } from './observerSession'

export type ComposerAccess = 'pending' | 'readonly' | 'writable'

interface ComposerSession {
  agent_type?: string
  agent?: string
  source?: string
  control_mode?: string | null
  capabilities?: string[]
  status?: string
  statusEffective?: string
  is_subagent?: boolean
}

export function sessionComposerAccess(session?: ComposerSession): ComposerAccess {
  const agent = session?.agent_type || session?.agent || ''
  if (session?.is_subagent || isReadOnlyObserverAgent(agent) || session?.source === 'observer'
    || session?.control_mode === 'legacy_read_only' || (Array.isArray(session?.capabilities) && !session.capabilities.length)) return 'readonly'
  if (!agent || !session) return 'pending'
  const { capabilities, control_mode: mode, source } = session
  if (['codex', 'zcode-managed', 'opencode'].includes(agent)) {
    if (mode === undefined || !Array.isArray(capabilities)) return 'pending'
    const writable = agent === 'opencode' ? isManagedOpenCodeSession(agent, mode, capabilities)
      : mode === 'managed' && capabilities.includes('message_acceptance_receipt')
    return writable ? 'writable' : 'readonly'
  }
  const status = session.statusEffective || session.status || ''
  if (!source && mode !== 'managed') return 'pending'
  if (source !== 'daemon' && mode !== 'managed' && !status) return 'pending'
  if (agent === 'claude-code') {
    return canSendClaudeSession({ source: source || '', status, capabilities, daemonOnline: true,
      isSubagent: false, isManagedSession: mode === 'managed' }) ? 'writable' : 'readonly'
  }
  return source === 'daemon' || mode === 'managed' || !['exited', 'completed', 'error', 'killed'].includes(status)
    ? 'writable' : 'readonly'
}

// A one-shot presentation hint transfers the list selection into the detail's first render.
// Retain no capability list, token, draft or transport authorization.
let selection: { owner: number | undefined; session: string; access: ComposerAccess; agent: string; isSubagent: boolean } | undefined
export function rememberComposerSelection(owner: number | undefined, row: ComposerSession & { session_id: string; composer_hint?: ComposerAccess }) {
  selection = owner ? { owner, session: row.session_id, access: row.composer_hint ?? sessionComposerAccess(row),
    agent: row.agent_type || row.agent || '', isSubagent: row.is_subagent === true } : undefined
}
export function takeComposerSelection(owner: number | undefined, session: string) {
  const hint = selection
  selection = undefined
  return hint && hint.owner === owner && hint.session === session ? hint : undefined
}
