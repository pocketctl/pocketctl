export interface SubagentChild {
  agentId: string
  agentType: string
  title?: string | null
  status?: string
  tokenIn?: number
  tokenOut?: number
  tokenCache?: number
  tokenCacheCreate?: number
}

export type SessionControlMode = 'managed' | 'unmanaged_active' | 'legacy_read_only'

export interface Session {
  session_id: string
  daemon_id: string
  agent_type: string
  cwd?: string
  title?: string | null
  source?: string
  status: string
  subagent_count?: number
  pinned?: boolean
  model?: string
  parent_session_id?: string | null
  is_subagent?: boolean
  root_session_id?: string | null
  totalTokens?: number
  tokInput?: number
  tokOutput?: number
  tokCacheRead?: number
  tokCacheCreate?: number
  children?: SubagentChild[]
  daemon_online?: boolean
  hostname?: string
  daemon_alias?: string | null
  exit_reason?: string
  last_activity_at?: string
  created_at?: string
  control_mode?: SessionControlMode | null
  capabilities?: string[]
}
