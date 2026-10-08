import { agentDisplayName } from './agentDisplay'

export function teamProviderLabel(provider: string): string {
  return provider === 'codex' ? 'Codex' : agentDisplayName(provider)
}
