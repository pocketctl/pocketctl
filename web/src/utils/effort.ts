export function normalizeEffort(value: string): string {
  return value.trim().toLowerCase()
}

export function shouldShowEffort(agent: string, value: string): boolean {
  return (agent === 'claude-code' || agent === 'codex') && normalizeEffort(value) !== ''
}
