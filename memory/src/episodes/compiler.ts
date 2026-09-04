/**
 * Deterministic Work Episode compiler. No model calls, no body text, no
 * natural language: the summary is statistics and ID references only, so the
 * same source turn always compiles to the same episode.
 */
export const EPISODE_COMPILER_VERSION = 'memory-phase0-episodes-v1'

export type TerminalOutcome = 'completed' | 'interrupted' | 'failed' | 'abandoned'

const TERMINAL_OUTCOMES = new Set(['completed', 'interrupted', 'failed', 'abandoned'])

export interface CompiledEpisode {
  installation_id: string
  session_id: string
  turn_id: string
  state: 'ready'
  outcome: TerminalOutcome
  started_at: Date
  terminal_at: Date
  ready_at: Date
  event_count: number
  artifact_count: number
  correction_count: number
  retry_count: number
  tool_error_count: number
  summary: {
    event_type_counts: Record<string, number>
    artifact_type_counts: Record<string, number>
    classification_distribution: Record<string, number>
    terminal_reason: string | null
    references: { session_id: string; turn_id: string }
  }
  compiler_version: string
}

export interface EpisodeFacts {
  installationId: string
  sessionId: string
  turnId: string
  outcome: TerminalOutcome
  reason: string | null
  startedAt: Date
  terminalAt: Date
  eventCount: number
  artifactCounts: Record<string, number>
  eventTypeCounts: Record<string, number>
  classificationDistribution: Record<string, number>
  toolErrorCount: number
  retryCount: number
  correctionCount: number
  stabilizationMs: number
}

export function compileEpisode(facts: EpisodeFacts): CompiledEpisode {
  if (!TERMINAL_OUTCOMES.has(facts.outcome)) {
    throw new Error(`compileEpisode requires a terminal outcome, got ${String(facts.outcome)}`)
  }
  const artifactCount = Object.values(facts.artifactCounts)
    .reduce((total, count) => total + count, 0)
  return {
    installation_id: facts.installationId,
    session_id: facts.sessionId,
    turn_id: facts.turnId,
    state: 'ready',
    outcome: facts.outcome,
    started_at: facts.startedAt,
    terminal_at: facts.terminalAt,
    // Stabilization window: the episode is ready 30s (configurable) after
    // the LAST event — a late same-turn event pushes readiness out again.
    ready_at: new Date(facts.terminalAt.getTime() + facts.stabilizationMs),
    event_count: facts.eventCount,
    artifact_count: artifactCount,
    correction_count: facts.correctionCount,
    retry_count: facts.retryCount,
    tool_error_count: facts.toolErrorCount,
    summary: {
      event_type_counts: facts.eventTypeCounts,
      artifact_type_counts: facts.artifactCounts,
      classification_distribution: facts.classificationDistribution,
      terminal_reason: facts.reason,
      references: { session_id: facts.sessionId, turn_id: facts.turnId },
    },
    compiler_version: EPISODE_COMPILER_VERSION,
  }
}

export interface EventObservation {
  event_type: string
  classification: Record<string, unknown>
  data?: Record<string, unknown>
}

/** Deterministic counting over event observations (no body access). */
export function summarizeEvents(events: readonly EventObservation[]): {
  eventTypeCounts: Record<string, number>
  classificationDistribution: Record<string, number>
  correctionCount: number
  retryCount: number
  toolErrorCount: number
} {
  const eventTypeCounts: Record<string, number> = {}
  const classificationDistribution: Record<string, number> = {}
  let correctionCount = 0
  let retryCount = 0
  let toolErrorCount = 0
  for (const event of events) {
    eventTypeCounts[event.event_type] = (eventTypeCounts[event.event_type] ?? 0) + 1
    const contentClass = event.classification?.content_class
    if (typeof contentClass === 'string' && contentClass.length > 0) {
      classificationDistribution[contentClass] = (classificationDistribution[contentClass] ?? 0) + 1
    }
    if (event.event_type.includes('correction')
      || contentClass === 'user_correction'
      || event.data?.correction === true) {
      correctionCount++
    }
    if (event.event_type.includes('retry') || event.data?.retry === true) {
      retryCount++
    }
    if (event.event_type === 'tool_result') {
      const status = event.data?.status
      if (status === 'error' || status === 'failed') toolErrorCount++
    }
  }
  return {
    eventTypeCounts,
    classificationDistribution,
    correctionCount,
    retryCount,
    toolErrorCount,
  }
}
