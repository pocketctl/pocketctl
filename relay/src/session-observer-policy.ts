export const OBSERVER_READ_ONLY_CODE = 'observer_read_only' as const

export const OBSERVER_AGENT_TYPES: ReadonlySet<string> = new Set([
  'codex-desktop',
  'zcode',
])

/** Agent identities explicitly audited to create daemon-owned runtimes. */
export const CREATE_CAPABLE_AGENT_TYPES: ReadonlySet<string> = new Set([
  'claude-code',
  'codex',
  'opencode',
])

/** Current daemon-native commands that can mutate an agent runtime. */
export const OBSERVER_NATIVE_DRIVE_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'user_message',
  'abort_create',
  'session_kill',
  'session_interrupt',
  'set_permission_config',
  'set_effort',
  'set_session_agent',
  'approval_response',
  'question_response',
  'question_reject',
  'mcp_elicitation_response',
  'interactive_response',
])

/** Explicit observer-safe session messages. Unknown additions fail closed. */
export const OBSERVER_READ_ONLY_SESSION_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'replay',
  'replay_subagent',
  'list_commands',
  'list_session_agents',
  'get_session_meta',
  'session_pin',
  'session_delete',
])

export function isObserverAgentType(agentType: unknown): boolean {
  return typeof agentType === 'string' && OBSERVER_AGENT_TYPES.has(agentType)
}

/** Exact protocol-boundary opt-in; future agents remain unsupported by default. */
export function isCreateCapableAgentType(agentType: unknown): boolean {
  return typeof agentType === 'string' && CREATE_CAPABLE_AGENT_TYPES.has(agentType)
}

export function isObserverSessionMessageAllowed(messageType: unknown): boolean {
  return typeof messageType === 'string'
    && OBSERVER_READ_ONLY_SESSION_MESSAGE_TYPES.has(messageType)
}
