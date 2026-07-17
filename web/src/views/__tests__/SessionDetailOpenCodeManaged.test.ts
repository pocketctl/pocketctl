import { shallowMount } from '@vue/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import SessionDetail from '../SessionDetail.vue'
import ApprovalCard from '../../components/messages/ApprovalCard.vue'
import OpenCodeQuestionCard from '../../components/messages/OpenCodeQuestionCard.vue'

const websocketMock = vi.hoisted(() => ({ handlers: new Map<string, (message: any) => void>(), send: vi.fn(() => true) }))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'ses_1' }, query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('../../composables/useWebSocket', () => ({
	useWebSocket: () => ({
		connect: vi.fn(), send: websocketMock.send,
    onEvent: vi.fn((type: string, handler: (message: any) => void) => {
      websocketMock.handlers.set(type, handler)
      return () => websocketMock.handlers.delete(type)
    }),
  }),
}))

vi.mock('../../composables/useLocale', () => ({ useLocale: () => ({ t: (key: string) => key }) }))
vi.mock('../../composables/useSessionRename', () => ({
  useSessionRename: () => ({
    renamingId: ref(''), renameInput: ref(''), startRename: vi.fn(), commitRename: vi.fn(), cancelRename: vi.fn(),
  }),
}))

const mounted: Array<ReturnType<typeof shallowMount>> = []
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
	websocketMock.handlers.clear()
	websocketMock.send.mockClear()
})

function mountSession() {
  const wrapper = shallowMount(SessionDetail)
  mounted.push(wrapper)
  return wrapper
}

function session(overrides: Record<string, unknown>) {
  return {
    session_id: 'ses_1', daemon_id: 'd1', agent_type: 'opencode', source: 'terminal', status: 'idle',
    daemon_online: true, cwd: '/repo', title: 'OpenCode', capabilities: [], control_mode: 'legacy_read_only',
    ...overrides,
  }
}

describe('SessionDetail managed OpenCode terminal control', () => {
	test('WebSocket 恢复后重新请求当前会话权威快照', () => {
		mountSession()
		websocketMock.send.mockClear()
		const restored = websocketMock.handlers.get('connection_restored')
		expect(restored).toBeTypeOf('function')
		restored?.({ type: 'connection_restored' })

		expect(websocketMock.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'list_sessions' }))
		expect(websocketMock.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'list_daemons' }))
		expect(websocketMock.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'replay', session_id: 'ses_1' }))
	})

	test('legacy OpenCode is read-only and explains how to adopt the session', async () => {
    const wrapper = mountSession()
    websocketMock.handlers.get('session_list')?.({ sessions: [session({})] })
    await nextTick()

    expect(wrapper.text()).toContain('session.opencode_legacy_readonly')
    expect(wrapper.find('.chat-input-container').exists()).toBe(false)

    ;(wrapper.vm as any).processEvent({ type: 'approval_request', request_id: 'per_legacy', tool: 'bash' })
    await nextTick()
    expect(wrapper.findComponent(ApprovalCard).props('disabled')).toBe(true)
  })

  test('managed OpenCode keeps composer and structured interactions enabled', async () => {
    const wrapper = mountSession()
    const capabilities = ['shared_runtime', 'terminal_coapproval', 'permission_actions', 'questions']
    websocketMock.handlers.get('session_list')?.({ sessions: [session({ control_mode: 'managed', capabilities })] })
    websocketMock.handlers.get('session_meta')?.({ session_id: 'ses_1', control_mode: 'managed', capabilities })
    ;(wrapper.vm as any).processEvent({ type: 'approval_request', request_id: 'per_managed', tool: 'bash' })
    ;(wrapper.vm as any).processEvent({ type: 'question_request', request_id: 'que_managed', questions: [{ question: 'Continue?' }] })
    await nextTick()

    expect(wrapper.text()).not.toContain('session.opencode_legacy_readonly')
    expect(wrapper.find('.chat-input-container').exists()).toBe(true)
    expect(wrapper.findComponent(ApprovalCard).props()).toMatchObject({ disabled: false, supportsActions: true })
    expect(wrapper.findComponent(OpenCodeQuestionCard).props('disabled')).toBe(false)
  })

  test('resolved_elsewhere clears submission and replay cannot reopen the card', async () => {
    const wrapper = mountSession()
    const vm = wrapper.vm as any
    vm.processEvent({ type: 'approval_request', request_id: 'per_race', tool: 'bash' })
    const card = vm.messages.find((message: any) => message.request_id === 'per_race')
    card.submitting = true

    websocketMock.handlers.get('interaction_result')?.({
      type: 'interaction_result', session_id: 'ses_1', request_id: 'per_race',
      operation: 'approval_response', status: 'resolved_elsewhere', reason: 'resolved_elsewhere',
    })
    vm.processEvent({ type: 'approval_request', request_id: 'per_race', tool: 'bash' })

    expect(card).toMatchObject({ status: 'resolved', submitting: false, reason: 'resolved_elsewhere', error: '' })
  })

  test('another device resolution converges question state once', () => {
    const wrapper = mountSession()
    const vm = wrapper.vm as any
    vm.processEvent({ type: 'question_request', request_id: 'que_other', questions: [{ question: 'Continue?' }] })

    websocketMock.handlers.get('question_resolved')?.({
      type: 'question_resolved', session_id: 'ses_1', request_id: 'que_other', answers: [['Yes']], reason: 'resolved_elsewhere',
    })
    websocketMock.handlers.get('question_resolved')?.({
      type: 'question_resolved', session_id: 'ses_1', request_id: 'que_other', answers: [['Yes']], reason: 'resolved_elsewhere',
    })

    const cards = vm.messages.filter((message: any) => message.type === 'question_request' && message.request_id === 'que_other')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ status: 'resolved', submitting: false, answers: [['Yes']] })
  })
})
