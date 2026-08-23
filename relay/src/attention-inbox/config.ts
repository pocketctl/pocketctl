import type { AttentionInboxConfig, AttentionInboxMode } from './types.js'

function parseMode(value: string | undefined, variable: string): AttentionInboxMode {
  const normalized = value?.trim().toLowerCase() || 'off'
  if (normalized === 'off' || normalized === 'observe' || normalized === 'on') {
    return normalized
  }
  throw new Error(`invalid ${variable} mode ${JSON.stringify(value)}`)
}

export function attentionInboxConfig(
  env: Record<string, string | undefined> = process.env,
): AttentionInboxConfig {
  const mode = parseMode(env.ATTENTION_INBOX_V1, 'ATTENTION_INBOX_V1')
  const recoveryMode = parseMode(
    env.ATTENTION_INBOX_RECOVERY_V2,
    'ATTENTION_INBOX_RECOVERY_V2',
  )
  if (mode === 'off' && recoveryMode !== 'off') {
    throw new Error('ATTENTION_INBOX_RECOVERY_V2 requires ATTENTION_INBOX_V1')
  }
  const projection = mode !== 'off'
  const remoteResponse = mode === 'on'
  return {
    schemaVersion: 1,
    mode,
    enabled: projection,
    remoteResponseEnabled: remoteResponse,
    providers: {
      codex: { projection, remoteResponse },
      opencode: { projection, remoteResponse },
      'claude-code': { projection: false, remoteResponse: false },
    },
    recovery: {
      mode: recoveryMode,
      projection: recoveryMode !== 'off',
      visible: recoveryMode === 'on',
    },
  }
}
