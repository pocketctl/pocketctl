import { shallowMount, mount } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, test, expect, vi } from 'vitest'
import { observerCanWrite, isReadOnlyObserverAgent } from '../../utils/observerSession'
import { buildResumeCommand } from '../../utils/resumeCommand'
import SessionDetail from '../SessionDetail.vue'
import SessionActions from '../../components/SessionActions.vue'
import ApprovalCard from '../../components/messages/ApprovalCard.vue'
import OpenCodeQuestionCard from '../../components/messages/OpenCodeQuestionCard.vue'
import InteractiveChoiceCard from '../../components/messages/InteractiveChoiceCard.vue'
import McpElicitationCard from '../../components/messages/McpElicitationCard.vue'
import ToolCallGroup from '../../components/messages/ToolCallGroup.vue'

const websocketMock = vi.hoisted(() => ({
  handlers: new Map<string, (message: any) => void>(),
  send: vi.fn((_payload: any) => true),
}))
const routeMock = vi.hoisted(() => ({ current: null as any }))

vi.mock('vue-router', () => ({
  useRoute: () => routeMock.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('../../composables/useWebSocket', () => ({
  useWebSocket: () => ({
    connect: vi.fn(),
    send: websocketMock.send,
    sendUserMessage: vi.fn((payload: Record<string, unknown>) => websocketMock.send({ type: 'user_message', ...payload })),
    connected: ref(true),
    reconnecting: ref(false),
    onEvent: vi.fn((type: string, handler: (message: any) => void) => {
      websocketMock.handlers.set(type, handler)
      return () => websocketMock.handlers.delete(type)
    }),
  }),
}))

vi.mock('../../composables/useLocale', () => ({ useLocale: () => ({ locale: ref('en'), t: (key: string) => key }) }))
vi.mock('../../composables/useSessionRename', () => ({
  useSessionRename: () => ({
    renamingId: ref(''), renameInput: ref(''), startRename: vi.fn(), commitRename: vi.fn(), cancelRename: vi.fn(),
  }),
}))
vi.mock('../../composables/useAuth', () => ({ useAuth: () => ({ accessToken: ref('token') }) }))
vi.mock('../../composables/useEnv', () => ({ getRelayOrigin: () => 'https://relay.example' }))

const mounted: Array<ReturnType<typeof shallowMount>> = []

beforeEach(() => {
  routeMock.current = reactive({ params: { id: 'desktop-1' }, query: {} as Record<string, string> })
  websocketMock.handlers.clear()
  websocketMock.send.mockClear()
})

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  vi.useRealTimers()
})

function observerSession(agentType: 'zcode' | 'codex-desktop' = 'codex-desktop') {
  return {
    session_id: 'desktop-1', daemon_id: 'daemon-1', title: 'Desktop observer',
    agent_type: agentType, source: 'daemon', status: 'completed', daemon_online: true,
    control_mode: 'managed', capabilities: ['message_acceptance_receipt', 'permission_actions', 'shared_runtime'],
    cwd: '/repo', totalTokens: 4200, pinned: false,
  }
}

async function mountObserver(agentType: 'zcode' | 'codex-desktop' = 'codex-desktop') {
  const wrapper = shallowMount(SessionDetail)
  mounted.push(wrapper)
  websocketMock.handlers.get('session_list')?.({ sessions: [observerSession(agentType)] })
  websocketMock.handlers.get('session_status')?.({ session_id: 'desktop-1', status: 'completed' })
  websocketMock.handlers.get('replay_end')?.({ session_id: 'desktop-1' })
  websocketMock.handlers.get('session_meta')?.({
    session_id: 'desktop-1', model: 'gpt-5.6', control_mode: 'managed',
    capabilities: ['message_acceptance_receipt', 'permission_actions', 'shared_runtime'],
    permission: { agent: 'codex', preset: 'full-access' }, permission_mutable: true,
    permission_mutable_modes: ['read-only', 'full-access'],
  })
  await nextTick()
  return wrapper
}

describe('read-only observer session fail-closed gate', () => {
  test('isReadOnlyObserverAgent recognizes only permanent observer agents', () => {
    expect(isReadOnlyObserverAgent('zcode')).toBe(true)
    expect(isReadOnlyObserverAgent('codex-desktop')).toBe(true)
    expect(isReadOnlyObserverAgent('claude-code')).toBe(false)
    expect(isReadOnlyObserverAgent('codex')).toBe(false)
    expect(isReadOnlyObserverAgent('opencode')).toBe(false)
    expect(isReadOnlyObserverAgent('')).toBe(false)
  })

  test('zcode is never writable in any status', () => {
    for (const status of ['idle', 'running', 'busy', 'completed', 'error', 'exited', 'waiting']) {
      expect(observerCanWrite({ agentType: 'zcode', status })).toBe(false)
    }
  })

  test('forged control_mode=managed does NOT re-enable write', () => {
    expect(observerCanWrite({ agentType: 'zcode', controlMode: 'managed' })).toBe(false)
  })

  test('forged capabilities including message_acceptance_receipt do NOT re-enable write', () => {
    expect(observerCanWrite({
      agentType: 'zcode',
      capabilities: ['message_acceptance_receipt', 'history_sync', 'shared_runtime'],
    })).toBe(false)
  })

  test('daemon online/offline never re-enables write', () => {
    expect(observerCanWrite({ agentType: 'zcode', daemonOnline: true })).toBe(false)
    expect(observerCanWrite({ agentType: 'zcode', daemonOnline: false })).toBe(false)
  })

  test('every forged field combined still cannot write', () => {
    expect(observerCanWrite({
      agentType: 'zcode', status: 'idle', controlMode: 'managed',
      capabilities: ['message_acceptance_receipt'], daemonOnline: true,
    })).toBe(false)
    expect(observerCanWrite({
      agentType: 'codex-desktop', status: 'idle', controlMode: 'managed',
      capabilities: ['message_acceptance_receipt'], daemonOnline: true,
    })).toBe(false)
  })

  test('non-observer agents pass through to normal writeability logic', () => {
    expect(observerCanWrite({ agentType: 'claude-code' })).toBe(true)
    expect(observerCanWrite({ agentType: 'codex' })).toBe(true)
    expect(observerCanWrite({ agentType: 'opencode' })).toBe(true)
  })

  test('resume command is suppressed for zcode (no claude fallback)', () => {
    expect(buildResumeCommand({ agent: 'zcode', session_id: 'zcode-wire1', cwd: '/x' })).toBeNull()
  })

  test('Codex Desktop hides every write control before forged managed capabilities are considered', async () => {
    const wrapper = await mountObserver()
    const vm = wrapper.vm as any

    vm.processEvent({ type: 'user_text', session_id: 'desktop-1', text: 'previous prompt' })
    vm.processEvent({ type: 'agent_text', session_id: 'desktop-1', text: 'previous answer' })
    vm.processEvent({
      type: 'approval_request', session_id: 'desktop-1', request_id: 'approval-1',
      available_decisions: ['once', 'reject'], status: 'pending',
    })
    vm.processEvent({
      type: 'question_request', session_id: 'desktop-1', request_id: 'question-1',
      questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }], status: 'pending',
    })
    vm.processEvent({
      type: 'interactive_prompt', session_id: 'desktop-1', request_id: 'choice-1',
      choices: ['yes', 'no'], status: 'pending',
    })
    vm.processEvent({
      type: 'mcp_elicitation_request', session_id: 'desktop-1', request_id: 'mcp-1',
      message: 'Authorize MCP?', elicitation_mode: 'url', url: 'https://example.invalid', status: 'pending',
    })
    await nextTick()

    expect(wrapper.find('.chat-input-container').exists()).toBe(false)
    expect(wrapper.find('.send-btn').exists()).toBe(false)
    expect(wrapper.find('.stop-btn').exists()).toBe(false)
    expect(wrapper.find('.perm-trigger').exists()).toBe(false)
    expect(wrapper.find('session-agent-picker-stub').exists()).toBe(false)
    expect(wrapper.findAll('.status-copy-btn').some(button => button.text().includes('common.retry'))).toBe(false)

    await wrapper.get('.toolbar-more-btn').trigger('click')
    expect(wrapper.find('[data-toolbar-action="resume"]').exists()).toBe(false)

    expect(wrapper.findComponent(ApprovalCard).props('disabled')).toBe(true)
    expect(wrapper.findComponent(OpenCodeQuestionCard).props('disabled')).toBe(true)
    expect(wrapper.findComponent(InteractiveChoiceCard).props('disabled')).toBe(true)
    expect(wrapper.findComponent(McpElicitationCard).props('disabled')).toBe(true)

    websocketMock.send.mockClear()
    vm.messageInput = 'forged send'
    vm.sendMessage()
    vm.retryLastPrompt()
    vm.interruptSession()
    vm.interruptSession()
    vm.requestPermission('full-access')
    vm.requestSessionAgents()
    vm.requestSessionAgentSwitch('forged-agent')
    wrapper.findComponent(ApprovalCard).vm.$emit('respond', { request_id: 'approval-1', status: 'pending' }, 'once')
    wrapper.findComponent(OpenCodeQuestionCard).vm.$emit('submit', { request_id: 'question-1', status: 'pending' }, [['Yes']])
    wrapper.findComponent(OpenCodeQuestionCard).vm.$emit('reject', { request_id: 'question-1', status: 'pending' })
    wrapper.findComponent(InteractiveChoiceCard).vm.$emit('respond', { request_id: 'choice-1', status: 'pending' }, 'yes')
    wrapper.findComponent(McpElicitationCard).vm.$emit('respond', { request_id: 'mcp-1', status: 'pending' }, 'accept')
    await nextTick()

    expect(websocketMock.send.mock.calls.map(([message]) => message.type)).not.toEqual(expect.arrayContaining([
      'user_message', 'session_interrupt', 'session_kill', 'set_permission_config',
      'approval_response', 'question_response', 'question_reject', 'interactive_response',
      'mcp_elicitation_response', 'list_session_agents', 'set_session_agent',
    ]))
  })

  test('Codex Desktop preserves history, tool, file-change and token rendering', async () => {
    const wrapper = await mountObserver()
    const vm = wrapper.vm as any

    expect(websocketMock.send.mock.calls.map(([message]) => message.type)).toContain('replay')
    vm.processEvent({ type: 'agent_text', session_id: 'desktop-1', text: 'historical answer', usage: { input_tokens: 1200, output_tokens: 300 } })
    vm.processEvent({ type: 'tool_call', session_id: 'desktop-1', call_id: 'read-1', tool: 'Read', input: { path: 'src/a.ts' } })
    vm.processEvent({
      type: 'agent_file_change', session_id: 'desktop-1', event_id: 'file-1', turn_id: 'turn-1', seq: 1,
      change_set_id: 'desktop:file', change_index: 0, change_total: 1, path: 'src/a.ts',
      change_kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new\n', additions: 1, deletions: 1, status: 'completed',
    })
    await nextTick()

    expect(wrapper.find('message-agent-stub').attributes('content')).toBe('historical answer')
    expect(wrapper.findComponent(ToolCallGroup).exists()).toBe(true)
    await wrapper.get('.toolbar-more-btn').trigger('click')
    expect(wrapper.get('[data-toolbar-action="edited-files"]').text()).toContain('1')
    expect(wrapper.findAll('.toolbar-overflow-metric').map(item => item.text())).toEqual(expect.arrayContaining(['gpt-5.6', '1K', '4K']))
  })

  test('Codex Desktop keeps Relay pin and delete actions available', async () => {
    vi.useFakeTimers()
    const session = observerSession()
    const wrapper = mount(SessionActions, { props: { session } })

    await wrapper.get('.ss-more-btn').trigger('click')
    const menuItems = wrapper.findAll('.ss-menu-item')
    expect(menuItems.some(item => item.text().includes('session.actions.resume'))).toBe(false)
    await menuItems.find(item => item.text().includes('session.actions.pin'))!.trigger('click')
    expect(websocketMock.send).toHaveBeenCalledWith({ type: 'session_pin', session_id: 'desktop-1', pinned: true })

    await wrapper.get('.ss-more-btn').trigger('click')
    await wrapper.get('.ss-menu-item.danger').trigger('click')
    await wrapper.get('.ss-confirm').trigger('click')
    await vi.advanceTimersByTimeAsync(5700)
    expect(websocketMock.send).toHaveBeenCalledWith({ type: 'session_delete', session_id: 'desktop-1' })
    wrapper.unmount()
  })
})
