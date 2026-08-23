// web/src/utils/agentDisplay.ts
// Shared display helpers for agent types across Dashboard / Hosts / badges.
// Centralizes the raw → human-readable name, short abbreviation, icon class,
// and manageability/readonly rules so every surface renders a ZCode observer
// agent consistently (and never offers an upgrade on it).

export const AGENT_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
  zcode: 'ZCode',
}

export function agentDisplayName(raw: string): string {
  return AGENT_DISPLAY_NAMES[raw] || raw
}

export function agentShortLabel(raw: string): string {
  const n = raw.toLowerCase()
  if (/codex/.test(n)) return 'Cx'
  if (/opencode/.test(n)) return 'OC'
  if (/zcode/.test(n)) return 'ZC'
  return 'CC'
}

export function agentIconClass(raw: string): string {
  const n = raw.toLowerCase()
  if (/codex/.test(n)) return 'codex'
  if (/zcode/.test(n)) return 'zcode'
  return 'claude'
}

/** ZCode is a read-only observer; never manageable, never upgradable. */
export function isZcodeAgent(raw: string): boolean {
  return raw === 'zcode'
}
