// web/src/utils/agentDisplay.ts
// Shared display helpers for agent types across Dashboard / Hosts / badges.
// Centralizes the raw → human-readable name, short abbreviation, icon class,
// so every surface renders observer agents consistently.

export const AGENT_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex CLI',
  'codex-desktop': 'Codex Desktop',
  zcode: 'ZCode',
}

export function agentDisplayName(raw: string): string {
  return AGENT_DISPLAY_NAMES[raw] || raw
}

export function agentReplyLabel(raw?: string): string {
  switch (raw?.trim().toLowerCase()) {
    case 'claude-code': return 'claude'
    case 'codex': return 'codex'
    case 'codex-desktop': return 'codex desktop'
    case 'opencode': return 'opencode'
    case 'zcode': return 'zcode'
    default: return 'assistant'
  }
}

export function agentShortLabel(raw: string): string {
  const n = raw.toLowerCase()
  if (n === 'codex-desktop') return 'CD'
  if (/codex/.test(n)) return 'Cx'
  if (/opencode/.test(n)) return 'OC'
  if (/zcode/.test(n)) return 'ZC'
  return 'CC'
}

export function agentIconClass(raw: string): string {
  const n = raw.toLowerCase()
  if (n === 'codex-desktop') return 'codex-desktop'
  if (/codex/.test(n)) return 'codex'
  if (/zcode/.test(n)) return 'zcode'
  return 'claude'
}
