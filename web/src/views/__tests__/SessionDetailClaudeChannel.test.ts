import { shallowMount } from '@vue/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ref } from 'vue'
import SessionDetail from '../SessionDetail.vue'

const websocketMock = vi.hoisted(() => ({ handlers: new Map<string, (message: any) => void>(), send: vi.fn(() => true) }))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'claude-session' }, query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
vi.mock('../../composables/useWebSocket', () => ({
  useWebSocket: () => ({
    connect: vi.fn(), send: websocketMock.send, connected: ref(true), reconnecting: ref(false),
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

afterEach(() => {
  websocketMock.handlers.clear()
  websocketMock.send.mockClear()
  vi.useRealTimers()
})

function mountSession() {
  const wrapper = shallowMount(SessionDetail)
  websocketMock.handlers.get('replay_end')?.({ type: 'replay_end', session_id: 'claude-session', req_id: 1 })
  return wrapper
}

describe('SessionDetail Claude Channel approval', () => {
  test('submitted result neutrally closes the card and a stale timer cannot reopen it', () => {
    vi.useFakeTimers()
    const wrapper = mountSession()
    const vm = wrapper.vm as any
    vm.processEvent({
      type: 'approval_request', session_id: 'claude-session', request_id: '6c991f98-4e11-43fb-8731-b83db675f75b',
      agent: 'claude-code', approval_kind: 'claude_channel', available_decisions: ['accept', 'decline'], tool: 'Bash',
    })
    const card = vm.messages.find((message: any) => message.request_id === '6c991f98-4e11-43fb-8731-b83db675f75b')
    vm.onApprovalRespond(card, 'once')
    expect(card.submitting).toBe(true)

    websocketMock.handlers.get('interaction_result')?.({
      type: 'interaction_result', session_id: 'claude-session', request_id: card.request_id,
      operation: 'approval_response', status: 'submitted', reason: 'claude_result_unconfirmed',
    })
    vi.advanceTimersByTime(20_000)

    expect(card).toMatchObject({
      status: 'resolved', submitting: false, resultUnknown: false,
      reason: 'claude_result_unconfirmed', action: 'submitted', error: '',
    })
    wrapper.unmount()
  })

  test.each(['result_unknown', 'channel_disconnected', 'daemon_restarted'])(
    '%s is a neutral non-actionable resolution',
    (reason) => {
      const wrapper = mountSession()
      const vm = wrapper.vm as any
      const requestId = `4dbf8650-e7bb-4c16-8f35-${reason}`
      vm.processEvent({
        type: 'approval_request', request_id: requestId, approval_kind: 'claude_channel',
        available_decisions: ['accept', 'decline'], tool: 'Edit',
      })
      vm.processEvent({ type: 'approval_resolved', request_id: requestId, reason })
      vm.processEvent({
        type: 'approval_request', request_id: requestId, approval_kind: 'claude_channel',
        available_decisions: ['accept', 'decline'], tool: 'Edit',
      })

      const card = vm.messages.find((message: any) => message.request_id === requestId)
      expect(card).toMatchObject({ status: 'resolved', reason })
      wrapper.unmount()
    },
  )
})
