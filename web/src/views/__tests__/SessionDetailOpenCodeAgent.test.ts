import { describe, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SessionAgentPicker from '../../components/SessionAgentPicker.vue'
import {
  normalizeSessionAgents,
  resolveInteractionRequest,
  shouldShowSessionAgentPicker,
  sessionAgentSwitchDisabled,
  upsertInteractionRequest,
  type SessionAgentOption,
} from '../../types/opencode-interactions'
import { mergeLocalCommands } from '../../utils/commands'
import type { CommandItem } from '../../composables/useWebSocket'

const agents: SessionAgentOption[] = [
  { name: 'build', mode: 'primary', description: 'Build changes', color: '#4f8cff' },
  { name: 'plan', mode: 'primary', description: 'Plan work' },
]

describe('OpenCode dynamic commands', () => {
  test('retains OpenCode metadata and local commands win collisions', () => {
    const remote: CommandItem[] = [
      { name: 'status', source: 'command', kind: 'command', description: 'remote status', template: 'status $ARGUMENTS', hints: ['scope'], agent: 'build', model: 'gpt-5', subtask: true },
      { name: 'review', source: 'skill', kind: 'skill', description: 'Review changes', arg_hint: '<target>' },
    ]
    const merged = mergeLocalCommands(remote)
    expect(merged.filter(command => command.name === 'status')).toHaveLength(1)
    expect(merged.find(command => command.name === 'status')?.source).toBe('pocketctl')
    expect(merged.find(command => command.name === 'review')).toMatchObject({
      source: 'skill', description: 'Review changes', arg_hint: '<target>',
    })
    expect(remote[0]).toMatchObject({ template: 'status $ARGUMENTS', hints: ['scope'], subtask: true, agent: 'build', model: 'gpt-5' })
  })
})

describe('OpenCode Agent state', () => {
  test('filters subagent and hidden entries defensively', () => {
    expect(normalizeSessionAgents([
      ...agents,
      { name: 'research', mode: 'subagent' },
      { name: 'hidden', mode: 'primary', hidden: true },
    ])).toEqual(agents)
  })

  test('only appears for capable parent OpenCode details', () => {
    expect(shouldShowSessionAgentPicker('opencode', ['agent_switch'], false, false)).toBe(true)
    expect(shouldShowSessionAgentPicker('opencode', [], false, false)).toBe(false)
    expect(shouldShowSessionAgentPicker('claude-code', ['agent_switch'], false, false)).toBe(false)
    expect(shouldShowSessionAgentPicker('opencode', ['agent_switch'], true, false)).toBe(false)
    expect(shouldShowSessionAgentPicker('opencode', ['agent_switch'], false, true)).toBe(false)
  })

  test('disables switches while working, offline, or submitting', () => {
    expect(sessionAgentSwitchDisabled('idle', false, false)).toBe(false)
    expect(sessionAgentSwitchDisabled('busy', false, false)).toBe(true)
    expect(sessionAgentSwitchDisabled('waiting_question', false, false)).toBe(true)
    expect(sessionAgentSwitchDisabled('idle', true, false)).toBe(true)
    expect(sessionAgentSwitchDisabled('idle', false, true)).toBe(true)
  })
})

describe('OpenCode request-id interaction state', () => {
  test('duplicate asked events upsert one pending card without losing submit state', () => {
    const messages: any[] = []
    upsertInteractionRequest(messages, 'question_request', 'que_1', { id: 'first', questions: [{ question: 'old' }] })
    messages[0].submitting = true
    upsertInteractionRequest(messages, 'question_request', 'que_1', { id: 'duplicate', questions: [{ question: 'new' }] })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: 'first', submitting: true, questions: [{ question: 'new' }] })
  })

  test('remote resolution finalizes the matching request and stale asked cannot reopen it', () => {
    const messages: any[] = []
    upsertInteractionRequest(messages, 'approval_request', 'per_1', { id: 'approval', permissionName: 'bash' })
    expect(resolveInteractionRequest(messages, 'approval_request', 'per_1', { action: 'always' })).toBe(true)
    upsertInteractionRequest(messages, 'approval_request', 'per_1', { id: 'stale', permissionName: 'edit' })
    expect(messages[0]).toMatchObject({ status: 'resolved', action: 'always', permissionName: 'bash' })
  })

  test('remote question resolution preserves ordered multi and custom answers', () => {
    const messages: any[] = []
    upsertInteractionRequest(messages, 'question_request', 'que_1', { id: 'question', questions: [{ question: 'one' }, { question: 'many' }] })
    const answers = [['A'], ['B', 'custom']]
    expect(resolveInteractionRequest(messages, 'question_request', 'que_1', { answers, rejected: false })).toBe(true)
    expect(messages[0]).toMatchObject({ status: 'resolved', answers, rejected: false })
  })
})

describe('SessionAgentPicker', () => {
  test('renders current value and emits a requested switch without changing props', async () => {
    const wrapper = mount(SessionAgentPicker, {
      props: { agents, currentAgent: 'build', loading: false, error: '', disabled: false, submitting: false },
    })
    const select = wrapper.get('select')
    expect((select.element as HTMLSelectElement).value).toBe('build')
    await select.setValue('plan')
    expect(wrapper.emitted('select')?.[0]).toEqual(['plan'])
    expect(wrapper.props('currentAgent')).toBe('build')
  })

  test('shows loading and retryable error states', async () => {
    const retry = vi.fn()
    const loading = mount(SessionAgentPicker, {
      props: { agents: [], currentAgent: '', loading: true, error: '', disabled: false, submitting: false },
    })
    expect(loading.find('[data-testid="agent-loading"]').exists()).toBe(true)

    const failed = mount(SessionAgentPicker, {
      props: { agents: [], currentAgent: 'build', loading: false, error: 'failed', disabled: false, submitting: false },
      attrs: { onRetry: retry },
    })
    await failed.get('[data-testid="agent-retry"]').trigger('click')
    expect(retry).toHaveBeenCalledTimes(1)
  })

  test('disables selection while submitting', () => {
    const wrapper = mount(SessionAgentPicker, {
      props: { agents, currentAgent: 'build', loading: false, error: '', disabled: false, submitting: true },
    })
    expect(wrapper.get('select').attributes('disabled')).toBeDefined()
  })
})
