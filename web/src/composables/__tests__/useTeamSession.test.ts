import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const api = vi.hoisted(() => ({
  appendTeamMessage: vi.fn(), controlTeamRun: vi.fn(), createTeamRun: vi.fn(), getTeamCapabilities: vi.fn(),
  getTeamContext: vi.fn(), getTeamSession: vi.fn(), getTeamTask: vi.fn(), listTeamEvents: vi.fn(),
  listTeamRuns: vi.fn(), setTeamSessionAgentBinding: vi.fn(), supplementTeamRun: vi.fn(),
}))
const ws = vi.hoisted(() => ({ handlers: new Map<string, (message: any) => void>() }))

vi.mock('../../services/teamClient', () => api)
vi.mock('../useWebSocket', () => ({
  useWebSocket: () => ({
    connect: vi.fn(), connected: { value: true }, subscribeTeamSession: vi.fn(), unsubscribeTeamSession: vi.fn(),
    onEvent: (type: string, handler: (message: any) => void) => { ws.handlers.set(type, handler); return () => ws.handlers.delete(type) },
  }),
}))

import { useTeamSession } from '../useTeamSession'

function session(id: string) {
  return {
    id, team_id: 'ctm_1', creator_user_id: 7, task_id: null, title: id, state: 'active', revision: 1,
    latest_event_seq: 0, current_context_version: 1, participants: [], agent_bindings: [], created_at: '', updated_at: '',
  }
}

function run(id: string, sessionID: string, revision: number, state: 'running' | 'completed' = 'running') {
  return {
    id, team_session_id: sessionID, initiator_user_id: 7, coordinator_offer_id: 'offer-1', context_version: 1,
    state, stop_requested: false, budget: { max_calls: 12, max_concurrent_calls: 2, max_duration_seconds: 1800 },
    calls_used: revision, next_step: revision + 1, processed_call_step: revision - 1, revision,
    waiting_question: null, terminal_reason: state === 'completed' ? 'coordinator_completed' : null,
    started_at: '', deadline_at: '2099-01-01T00:00:00Z', finished_at: state === 'completed' ? '' : null,
    created_at: '', updated_at: '',
  }
}

describe('useTeamSession run recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ws.handlers.clear()
    api.getTeamCapabilities.mockResolvedValue({ schema_version: 1, contract_version: 'team-collaboration.v1', collaboration: true, autorun: true, memory_bridge: false, writes_enabled: true })
    api.getTeamContext.mockImplementation(async (sessionID: string, version?: number) => ({
      id: `ctx-${sessionID}-${version ?? 1}`, team_session_id: sessionID, version: version ?? 1, revision: 1,
      goal: `goal-${sessionID}`, consensus: [], open_questions: [], references: [], content_hash: '', created_by_user_id: 7, created_at: '',
    }))
    api.getTeamSession.mockImplementation(async (id: string) => session(id))
    api.listTeamEvents.mockResolvedValue({ events: [], next_cursor: null })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  test('reconciles WebSocket changes, polling completion, and session switches without stale overwrite', async () => {
    const teamID = ref('ctm_1')
    const sessionID = ref('css_1')
    const runs = new Map<string, any[]>([
      ['css_1', [run('crn_1', 'css_1', 1)]],
      ['css_2', [run('crn_2', 'css_2', 1)]],
    ])
    api.listTeamRuns.mockImplementation(async (id: string) => runs.get(id) ?? [])
    let state!: ReturnType<typeof useTeamSession>
    const Host = defineComponent({
      setup() { state = useTeamSession(teamID, sessionID); return () => h('div') },
    })
    const wrapper = mount(Host)
    await flushPromises()
    expect(state.latestRun.value?.id).toBe('crn_1')

    runs.set('css_1', [run('crn_1', 'css_1', 2)])
    ws.handlers.get('team_collaboration_event')?.({
      team_session_id: 'css_1', event: { id: 'e1', event_seq: 1, kind: 'run', content: 'changed' },
    })
    await flushPromises()
    expect(state.latestRun.value?.revision).toBe(2)

    sessionID.value = 'css_2'
    await flushPromises()
    expect(state.latestRun.value?.id).toBe('crn_2')

    runs.set('css_2', [run('crn_2', 'css_2', 2, 'completed')])
    await vi.advanceTimersByTimeAsync(1_500)
    await flushPromises()
    expect(state.latestRun.value?.state).toBe('completed')
    const callsAfterCompletion = api.listTeamRuns.mock.calls.length
    await vi.advanceTimersByTimeAsync(3_000)
    expect(api.listTeamRuns).toHaveBeenCalledTimes(callsAfterCompletion)

    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(api.listTeamRuns).toHaveBeenCalledTimes(callsAfterCompletion)
  })
})
