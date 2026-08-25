import { describe, expect, test } from 'vitest'
import {
  EPISODE_COMPILER_VERSION,
  compileEpisode,
  summarizeEvents,
} from '../episodes/compiler.js'

function facts(overrides: Partial<Parameters<typeof compileEpisode>[0]> = {}) {
  return {
    installationId: '11111111-1111-1111-1111-111111111111',
    sessionId: 'ses-1',
    turnId: 'turn-1',
    outcome: 'completed' as const,
    reason: 'done',
    startedAt: new Date('2026-08-23T00:00:00Z'),
    terminalAt: new Date('2026-08-23T00:01:00Z'),
    eventCount: 12,
    artifactCounts: { file_change: 2, tool_call: 5, tool_result: 4, test_result: 1 },
    eventTypeCounts: { agent_text: 4, tool_call: 5, turn_status: 1 },
    classificationDistribution: { assistant_text: 4, tool_invocation: 5 },
    toolErrorCount: 1,
    retryCount: 2,
    correctionCount: 0,
    stabilizationMs: 30_000,
    ...overrides,
  }
}

describe('deterministic episode compilation', () => {
  test('maps every terminal outcome without calling a model', () => {
    for (const outcome of ['completed', 'interrupted', 'failed', 'abandoned'] as const) {
      const episode = compileEpisode(facts({ outcome }))
      expect(episode.outcome).toBe(outcome)
      expect(episode.state).toBe('ready')
      expect(episode.compiler_version).toBe(EPISODE_COMPILER_VERSION)
    }
  })

  test('stabilizes thirty seconds after the terminal event', () => {
    const episode = compileEpisode(facts())
    expect(episode.ready_at.getTime())
      .toBe(new Date('2026-08-23T00:01:00Z').getTime() + 30_000)
  })

  test('a late event delays readiness past its own stabilization window', () => {
    const lateEventAt = new Date('2026-08-23T00:02:30Z')
    const episode = compileEpisode(facts({ terminalAt: lateEventAt, eventCount: 13 }))
    expect(episode.ready_at.getTime()).toBe(lateEventAt.getTime() + 30_000)
  })

  test('the summary carries only deterministic statistics and references', () => {
    const episode = compileEpisode(facts())
    const serialized = JSON.stringify(episode.summary)
    expect(serialized).not.toContain('prompt')
    expect(serialized).not.toContain('diff')
    // No free-form body fields exist at all — only the frozen summary keys.
    expect(Object.keys(episode.summary).sort()).toEqual([
      'artifact_type_counts',
      'classification_distribution',
      'event_type_counts',
      'references',
      'terminal_reason',
    ])
    expect(episode.summary).toEqual({
      event_type_counts: { agent_text: 4, tool_call: 5, turn_status: 1 },
      artifact_type_counts: { file_change: 2, tool_call: 5, tool_result: 4, test_result: 1 },
      classification_distribution: { assistant_text: 4, tool_invocation: 5 },
      terminal_reason: 'done',
      references: {
        session_id: 'ses-1',
        turn_id: 'turn-1',
      },
    })
  })

  test('compilation is a pure function of its facts', () => {
    expect(compileEpisode(facts())).toEqual(compileEpisode(facts()))
  })

  test('event counting derives corrections, retries and tool errors', () => {
    const summary = summarizeEvents([
      { event_type: 'agent_text', classification: { content_class: 'user_correction' } },
      { event_type: 'turn_correction', classification: {} },
      { event_type: 'command_retry', classification: {} },
      { event_type: 'tool_result', classification: {}, data: { status: 'error' } },
      { event_type: 'tool_result', classification: {}, data: { status: 'ok' } },
      { event_type: 'tool_result', classification: {}, data: { status: 'failed' } },
    ])
    expect(summary.correctionCount).toBe(2)
    expect(summary.retryCount).toBe(1)
    expect(summary.toolErrorCount).toBe(2)
    expect(summary.eventTypeCounts).toEqual({
      agent_text: 1, turn_correction: 1, command_retry: 1, tool_result: 3,
    })
  })

  test('episodes without a terminal turn never compile', () => {
    // The projector only enqueues compile jobs for terminal turns; the
    // compiler itself refuses an outcome it does not know.
    expect(() => compileEpisode(facts({ outcome: 'running' as never })))
      .toThrow(/outcome/)
  })
})
