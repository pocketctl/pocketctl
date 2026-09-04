// Permanent read-only observer agents mirror local session state into PocketCtl
// but never accept remote control. Keep this agent-level gate independent of
// source, status, control_mode, connectivity, and advertised capabilities.

export interface ObserverSessionInput {
  agentType: string
  status?: string
  controlMode?: string
  capabilities?: string[]
  daemonOnline?: boolean
}

const READ_ONLY_OBSERVER_AGENTS = new Set(['zcode', 'codex-desktop'])

export function isReadOnlyObserverAgent(agentType: string): boolean {
  return READ_ONLY_OBSERVER_AGENTS.has(agentType)
}

/** Observer agents fail closed; other agents continue to their normal gates. */
export function observerCanWrite(input: ObserverSessionInput): boolean {
  return !isReadOnlyObserverAgent(input.agentType)
}
