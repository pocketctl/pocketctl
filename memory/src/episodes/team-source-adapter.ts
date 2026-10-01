export const TEAM_SOURCE_KIND = 'team_collaboration_event'
export const TEAM_SOURCE_VERSION = 1 as const

export interface TeamSourceProvenance {
  source_kind: 'team_session'
  source_version: typeof TEAM_SOURCE_VERSION
  team_id: string
  team_session_id: string
  team_call_id: string
  team_event_ids: string[]
  team_event_seqs: number[]
  author_user_id?: number
  author_offer_id?: string
  context_version: number
  read_scope: {
    kind: 'team_session'
    team_id: string
    team_session_id: string
    team_memory_binding_id: string
    team_memory_binding_revision: number
    target_installation_id: string
    target_owner_scope_kind: 'personal' | 'team' | 'organization'
    target_owner_scope_id: string
    participant_user_id: number
    participant_revision: number
  }
}

export interface TeamSourceAdapterInput {
  source_kind: string
  source_id: string
  session_id: string | null
  turn_id: string | null
  event_type: string
  recorded_at: Date
  classification: Record<string, unknown>
  data: Record<string, unknown>
}

export interface AdaptedTeamSource {
  origin: 'team'
  originPosition: string
  canonicalEventKey: string
  sessionId: string
  turnId: string
  eventType: 'user_goal' | 'agent_text' | 'turn_status'
  occurredAt: Date
  classification: Record<string, unknown>
  payload: Record<string, unknown>
  provenance: TeamSourceProvenance
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 512) return null
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return items.length === value.length ? items : null
}

function integerList(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 512) return null
  const items = value.map(Number)
  return items.every(item => Number.isSafeInteger(item) && item > 0) ? items : null
}

export function adaptTeamSource(input: TeamSourceAdapterInput): AdaptedTeamSource | null {
  if (input.source_kind !== TEAM_SOURCE_KIND) return null
  const data = input.data ?? {}
  if (data.team_source_version !== TEAM_SOURCE_VERSION) {
    throw new Error('unsupported Team source version')
  }
  const teamId = nonEmpty(data.team_id)
  const teamSessionId = nonEmpty(data.team_session_id)
  const teamCallId = nonEmpty(data.team_call_id)
  const sourceRole = nonEmpty(data.source_role)
  const sourceSessionId = nonEmpty(input.session_id)
  const sourceTurnId = nonEmpty(data.turn_id) ?? nonEmpty(input.turn_id)
  const contextVersion = nonNegativeInteger(data.context_version)
  const eventIds = stringList(data.team_event_ids)
  const eventSeqs = integerList(data.team_event_seqs)
  const readScope = data.read_scope && typeof data.read_scope === 'object' && !Array.isArray(data.read_scope)
    ? data.read_scope as Record<string, unknown>
    : null
  if (!teamId || !teamSessionId || !teamCallId || !sourceSessionId || !sourceTurnId
    || contextVersion === null || !eventIds || !eventSeqs || eventIds.length !== eventSeqs.length
    || !readScope || readScope.kind !== 'team_session'
    || readScope.team_id !== teamId || readScope.team_session_id !== teamSessionId) {
    throw new Error('invalid Team source identity')
  }
  const bindingId = nonEmpty(readScope.team_memory_binding_id)
  const bindingRevision = positiveInteger(readScope.team_memory_binding_revision)
  const targetInstallationId = nonEmpty(readScope.target_installation_id)
  const targetOwnerScopeKind = nonEmpty(readScope.target_owner_scope_kind)
  const targetOwnerScopeId = nonEmpty(readScope.target_owner_scope_id)
  const participantUserId = positiveInteger(readScope.participant_user_id)
  const participantRevision = positiveInteger(readScope.participant_revision)
  if (!bindingId || !bindingRevision || !targetInstallationId || !targetOwnerScopeId
    || !participantUserId || !participantRevision
    || !['personal', 'team', 'organization'].includes(targetOwnerScopeKind ?? '')) {
    throw new Error('invalid Team source read scope')
  }
  const occurredAtValue = nonEmpty(data.occurred_at)
  const occurredAt = occurredAtValue ? new Date(occurredAtValue) : input.recorded_at
  if (!Number.isFinite(occurredAt.getTime())) throw new Error('invalid Team source timestamp')

  let eventType: AdaptedTeamSource['eventType']
  let payload: Record<string, unknown>
  if (sourceRole === 'goal') {
    const text = nonEmpty(data.text)
    const authorUserId = positiveInteger(data.author_user_id)
    if (!text || !authorUserId) throw new Error('invalid Team goal source')
    eventType = 'user_goal'
    payload = { text, author_user_id: authorUserId }
  } else if (sourceRole === 'reply') {
    const text = nonEmpty(data.text)
    const authorOfferId = nonEmpty(data.author_offer_id)
    if (!text || !authorOfferId) throw new Error('invalid Team reply source')
    eventType = 'agent_text'
    payload = { text, final: true, author_offer_id: authorOfferId }
  } else if (sourceRole === 'outcome') {
    const status = nonEmpty(data.status)
    if (!status || !['completed', 'failed', 'interrupted', 'abandoned'].includes(status)) {
      throw new Error('invalid Team outcome source')
    }
    eventType = 'turn_status'
    payload = { status, turn_status: status, turn_reason: 'team_agent_call_terminal' }
  } else {
    throw new Error('invalid Team source role')
  }

  const provenance: TeamSourceProvenance = {
    source_kind: 'team_session',
    source_version: TEAM_SOURCE_VERSION,
    team_id: teamId,
    team_session_id: teamSessionId,
    team_call_id: teamCallId,
    team_event_ids: eventIds,
    team_event_seqs: eventSeqs,
    ...(positiveInteger(data.author_user_id) ? { author_user_id: Number(data.author_user_id) } : {}),
    ...(nonEmpty(data.author_offer_id) ? { author_offer_id: String(data.author_offer_id) } : {}),
    context_version: contextVersion,
    read_scope: {
      kind: 'team_session',
      team_id: teamId,
      team_session_id: teamSessionId,
      team_memory_binding_id: bindingId,
      team_memory_binding_revision: bindingRevision,
      target_installation_id: targetInstallationId,
      target_owner_scope_kind: targetOwnerScopeKind as 'personal' | 'team' | 'organization',
      target_owner_scope_id: targetOwnerScopeId,
      participant_user_id: participantUserId,
      participant_revision: participantRevision,
    },
  }
  return {
    origin: 'team',
    originPosition: input.source_id,
    canonicalEventKey: `team:${teamId}:${teamSessionId}:${teamCallId}:${sourceRole}:v${TEAM_SOURCE_VERSION}`,
    sessionId: sourceSessionId,
    turnId: sourceTurnId,
    eventType,
    occurredAt,
    classification: {
      actor_scope: nonEmpty(data.actor_scope) ?? (sourceRole === 'reply' ? 'root' : sourceRole === 'goal' ? 'user' : 'system'),
      flow_scope: 'main',
      content_class: 'dialogue',
      classifier_version: 'team-source-v1',
    },
    payload: {
      ...payload,
      team_source: provenance,
      agent_type: 'team_collaboration',
    },
    provenance,
  }
}
