import type { TeamAgentAvailability, TeamProvider } from './types.js'

export interface InstalledAgentEvidence {
  type?: unknown
  manageable?: unknown
  capabilities?: unknown
}

export interface DaemonAgentEvidence {
  daemon_id: string
  hostname: string | null
  status: string
  agents: unknown
  collaboration_capabilities?: unknown
  team_id?: string | null
}

export interface TeamAgentCandidate {
  daemon_id: string
  hostname: string | null
  provider: TeamProvider
  installed: boolean
  online: boolean
  managed_callable: boolean
  dispatch_supported: boolean
  availability: TeamAgentAvailability
  occupied_team_id: string | null
}

function agentRecords(value: unknown): InstalledAgentEvidence[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (typeof item === 'string') return [{ type: item, manageable: true }]
    if (item && typeof item === 'object') return [item as InstalledAgentEvidence]
    return []
  })
}

export function installedAgent(
  agents: unknown,
  provider: TeamProvider,
): InstalledAgentEvidence | null {
  return agentRecords(agents).find(agent => agent.type === provider) ?? null
}

export function candidateForProvider(
  daemon: DaemonAgentEvidence,
  provider: TeamProvider,
  requestedTeamId: string,
): TeamAgentCandidate {
  const installed = installedAgent(daemon.agents, provider)
  const online = daemon.status === 'online'
  const occupiedTeamId = daemon.team_id ?? null
  const occupied = Boolean(occupiedTeamId && occupiedTeamId !== requestedTeamId)
  const manageable = installed?.manageable !== false
  const dispatchSupported = Array.isArray(daemon.collaboration_capabilities)
    && daemon.collaboration_capabilities.includes('team_collaboration_dispatch_v1')
    && daemon.collaboration_capabilities.includes('team_collaboration_context_v1')
  const managedCallable = Boolean(installed && online && manageable && dispatchSupported && !occupied)
  const availability: TeamAgentAvailability = occupied
    ? 'occupied'
    : !installed
      ? 'unsupported'
      : !online
        ? 'offline'
        : !manageable
          ? 'unmanaged'
          : !dispatchSupported
            ? 'unsupported'
            : 'online'
  return {
    daemon_id: daemon.daemon_id,
    hostname: daemon.hostname,
    provider,
    installed: Boolean(installed),
    online,
    managed_callable: managedCallable,
    dispatch_supported: dispatchSupported,
    availability,
    occupied_team_id: occupiedTeamId,
  }
}

export function offeredProviders(agents: unknown): TeamProvider[] {
  const providers: TeamProvider[] = []
  for (const provider of ['codex', 'claude-code'] as const) {
    if (installedAgent(agents, provider)) providers.push(provider)
  }
  return providers
}
