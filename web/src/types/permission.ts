export type AgentType = 'claude-code' | 'codex' | 'opencode'
export type ClaudeMode = 'manual' | 'auto' | 'acceptEdits' | 'dontAsk' | 'plan' | 'bypassPermissions'
export type CodexPreset = 'request_approval' | 'agent_managed' | 'full_access' | 'custom'
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never'
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type ClaudePermission = { agent: 'claude-code'; mode: ClaudeMode }
export type CodexPermission = { agent: 'codex'; preset: CodexPreset; approval_policy?: ApprovalPolicy; sandbox_mode?: SandboxMode; dangerously_bypass?: boolean }
export type PermissionConfig = ClaudePermission | CodexPermission

export interface PermissionOption { value: string; titleKey: string; descriptionKey: string; icon: string; dangerous?: boolean; disabled?: boolean }

const claudeModes: ClaudeMode[] = ['manual', 'auto', 'acceptEdits', 'dontAsk', 'plan', 'bypassPermissions']
const codexPresets: CodexPreset[] = ['request_approval', 'agent_managed', 'full_access', 'custom']

export function defaultPermission(agent: AgentType): PermissionConfig | undefined {
  if (agent === 'claude-code') return { agent, mode: 'acceptEdits' }
  if (agent === 'codex') return { agent, preset: 'custom' }
}

export function expandCodexPreset(preset: CodexPreset): CodexPermission {
  if (preset === 'request_approval') return { agent: 'codex', preset, approval_policy: 'on-request', sandbox_mode: 'workspace-write' }
  if (preset === 'agent_managed') return { agent: 'codex', preset, approval_policy: 'untrusted', sandbox_mode: 'workspace-write' }
  if (preset === 'full_access') return { agent: 'codex', preset, dangerously_bypass: true }
  return { agent: 'codex', preset }
}

export function permissionOptions(agent: AgentType, creation = false, mutableModes: string[] = []): PermissionOption[] {
  if (agent === 'claude-code') {
    const modes = creation ? claudeModes : claudeModes.filter(mode => mutableModes.includes(mode))
    return modes.map(value => ({ value, titleKey: `session.permission.claude.${value}.title`, descriptionKey: `session.permission.claude.${value}.description`, icon: value === 'plan' ? 'list' : value === 'bypassPermissions' ? 'warning' : 'shield', dangerous: value === 'bypassPermissions' }))
  }
  if (agent === 'codex') return codexPresets.map(value => ({ value, titleKey: `session.permission.codex.${value}.title`, descriptionKey: `session.permission.codex.${value}.description`, icon: value === 'custom' ? 'gear' : value === 'full_access' ? 'warning' : 'shield', dangerous: value === 'full_access', disabled: value === 'request_approval' || value === 'agent_managed' }))
  return []
}

export function permissionTitleKey(permission?: PermissionConfig): string {
  if (!permission) return 'session.permission.unavailable'
  return permission.agent === 'claude-code' ? `session.permission.claude.${permission.mode}.title` : `session.permission.codex.${permission.preset}.title`
}

export function permissionIcon(permission?: PermissionConfig): string {
  if (!permission) return 'shield'
  if (permission.agent === 'codex' && permission.preset === 'custom') return 'gear'
  if ((permission.agent === 'codex' && (permission.preset === 'full_access' || permission.dangerously_bypass)) || (permission.agent === 'claude-code' && permission.mode === 'bypassPermissions')) return 'warning'
  return 'shield'
}
