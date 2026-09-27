import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'

import type { TeamContextSnapshot, TeamMember, TeamRun, TeamSession, TeamTask } from '../../types/team'
import TeamRunPanel from './TeamRunPanel.vue'

const session: TeamSession = {
  id: 'css_1', team_id: 'ctm_1', creator_user_id: 7, task_id: 'ctk_1', title: 'Review', state: 'active', revision: 2,
  latest_event_seq: 5, current_context_version: 2, created_at: '', updated_at: '',
  participants: [
    { id: 'p1', user_id: 7, state: 'active', revision: 1 },
    { id: 'p2', user_id: 8, state: 'active', revision: 1 },
  ],
  agent_bindings: [
    { id: 'b1', offer_id: 'offer-codex', owner_user_id: 7, daemon_id: 'mac-1', provider: 'codex', state: 'active', revision: 1, native_session_id: 'native-1', availability: 'online' },
    { id: 'b2', offer_id: 'offer-claude', owner_user_id: 8, daemon_id: 'mac-2', provider: 'claude-code', state: 'active', revision: 1, native_session_id: 'native-2', availability: 'online' },
  ],
}
const members: TeamMember[] = [
  { id: 'm1', team_id: 'ctm_1', user_id: 7, display_label: 'Lin', state: 'active', revision: 1, joined_at: '', ended_at: null },
  { id: 'm2', team_id: 'ctm_1', user_id: 8, display_label: 'Chen', state: 'active', revision: 1, joined_at: '', ended_at: null },
]
const context: TeamContextSnapshot = {
  id: 'ctx_1', team_session_id: 'css_1', version: 2, revision: 2, goal: '给出可验证的发布建议',
  consensus: ['保留回滚路径'], open_questions: ['是否继续发布'], references: [], content_hash: 'hash', created_by_user_id: 7, created_at: '',
}
const task: TeamTask = {
  id: 'ctk_1', team_id: 'ctm_1', creator_user_id: 7, title: '发布评估', background: '', state: 'in_progress',
  previous_state: null, revision: 3, holder_user_ids: [7], session_ids: ['css_1'], created_at: '', updated_at: '', deleted_at: null,
}
const run: TeamRun = {
  id: 'crn_123456789', team_session_id: 'css_1', initiator_user_id: 7, coordinator_offer_id: 'offer-codex',
  context_version: 2, state: 'running', stop_requested: false,
  budget: { max_calls: 12, max_concurrent_calls: 2, max_duration_seconds: 1_800 }, calls_used: 3,
  next_step: 4, processed_call_step: 2, revision: 4, waiting_question: null, terminal_reason: null,
  started_at: '2026-09-26T00:00:00Z', deadline_at: '2026-09-26T00:30:00Z', finished_at: null,
  created_at: '2026-09-26T00:00:00Z', updated_at: '2026-09-26T00:05:00Z',
}

function render(overrides: Record<string, unknown> = {}) {
  return mount(TeamRunPanel, { props: {
    session, run, context, currentContext: context, task, members, currentUserId: 7,
    autorunEnabled: true, busy: false, error: '', ...overrides,
  } as any })
}

describe('TeamRunPanel', () => {
  test('shows the frozen objective, dynamic coordinator, participants, budgets, and independent task state', async () => {
    const wrapper = render()
    expect(wrapper.text()).toContain('Context v2')
    expect(wrapper.text()).toContain('给出可验证的发布建议')
    expect(wrapper.text()).toContain('Codex · mac-1')
    expect(wrapper.text()).toContain('Lin')
    expect(wrapper.text()).toContain('Chen')
    expect(wrapper.text()).toContain('3 / 12')
    expect(wrapper.text()).toContain('发布评估')
    expect(wrapper.text()).toContain('进行中')
    expect(wrapper.text()).toContain('自动协作不会替你完成任务')

    await wrapper.findAll('button').find(button => button.text() === '暂停')!.trigger('click')
    await wrapper.findAll('button').find(button => button.text() === '请求停止')!.trigger('click')
    expect(wrapper.emitted('control')).toEqual([['pause'], ['cancel']])
  })

  test('lets any participant answer once and suggest pause while only exposing their own Agent withdrawal', async () => {
    const wrapper = render({
      currentUserId: 8,
      run: { ...run, state: 'waiting_input', waiting_question: '目标环境是生产还是预发布？' },
    })
    expect(wrapper.text()).toContain('目标环境是生产还是预发布？')
    await wrapper.get('.input-request textarea').setValue('先在预发布验证。')
    const submit = wrapper.findAll('button').find(button => button.text() === '提交并恢复')!
    await submit.trigger('click')
    await submit.trigger('click')
    await wrapper.findAll('button').find(button => button.text() === '提出暂停建议')!.trigger('click')
    expect(wrapper.emitted('supplement')).toEqual([['先在预发布验证。']])
    expect(wrapper.emitted('suggest-pause')).toHaveLength(1)
    expect(wrapper.findAll('.owned-agent-row')).toHaveLength(1)
    expect(wrapper.find('.owned-agent-row').text()).toContain('Claude Code · mac-2')
    await wrapper.find('.owned-agent-row button').trigger('click')
    expect(wrapper.emitted('withdraw-agent')).toEqual([['offer-claude']])
  })

  test('explains uncertain recovery and never offers a misleading immediate resume', () => {
    const wrapper = render({ run: { ...run, state: 'blocked', terminal_reason: 'dispatch_uncertain' } })
    expect(wrapper.text()).toContain('为避免重复执行')
    expect(wrapper.text()).toContain('不能直接恢复或重复执行')
    const resume = wrapper.findAll('button').find(button => button.text() === '恢复')
    expect(resume?.attributes('disabled')).toBeDefined()
  })

  test('starts a new bounded run with a selected callable coordinator', async () => {
    const wrapper = render({ run: null })
    expect(wrapper.get('select').element.value).toBe('offer-codex')
    await wrapper.findAll('button').find(button => button.text() === '开始有界协作')!.trigger('click')
    expect(wrapper.emitted('start')).toEqual([['offer-codex']])
  })
})
