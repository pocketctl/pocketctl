export interface SessionAgentOption {
  name: string
  description?: string
  mode: string
  color?: string
  model?: string
  variant?: string
  hidden?: boolean
}

export function normalizeSessionAgents(input: unknown): SessionAgentOption[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  return input.filter((candidate): candidate is SessionAgentOption => {
    if (!candidate || typeof candidate !== 'object') return false
    const agent = candidate as SessionAgentOption
    if (typeof agent.name !== 'string' || !agent.name.trim() || seen.has(agent.name)) return false
    if (agent.hidden || !['primary', 'all'].includes(agent.mode)) return false
    seen.add(agent.name)
    return true
  })
}

export function shouldShowSessionAgentPicker(
  cliAgent: string,
  capabilities: string[],
  isSubagent: boolean,
  isFocusedSubagent: boolean,
): boolean {
  return cliAgent === 'opencode'
    && capabilities.includes('agent_switch')
    && !isSubagent
    && !isFocusedSubagent
}

export function sessionAgentSwitchDisabled(status: string, offline: boolean, submitting: boolean): boolean {
  return offline || submitting || ['running', 'busy', 'retry', 'waiting', 'waiting_approval', 'waiting_question'].includes(status)
}

export function upsertInteractionRequest(
  messages: any[],
  type: 'approval_request' | 'question_request',
  requestId: string,
  incoming: Record<string, unknown>,
): any {
  const existing = messages.find(message => message.type === type && message.request_id === requestId)
  if (existing) {
    // A delayed asked replay must never reopen a request already resolved on
    // another device. While pending, preserve local submission/error state.
    if (existing.status === 'pending') {
      const id = existing.id
      const submitting = existing.submitting
      const error = existing.error
      Object.assign(existing, incoming, { id, type, request_id: requestId, status: 'pending', submitting, error })
    }
    return existing
  }
  const created = { ...incoming, type, request_id: requestId, status: 'pending' }
  messages.push(created)
  return created
}

export function resolveInteractionRequest(
  messages: any[],
  type: 'approval_request' | 'question_request',
  requestId: string,
  resolution: Record<string, unknown>,
): boolean {
  const existing = messages.find(message => message.type === type && message.request_id === requestId)
  if (!existing) return false
  Object.assign(existing, resolution, { status: 'resolved', submitting: false, error: '' })
  return true
}
