import { shallowMount } from '@vue/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import SessionDetail from '../SessionDetail.vue'

const websocketMock = vi.hoisted(() => ({
  handlers: new Map<string, (message: any) => void>(),
  send: vi.fn((_payload: any) => true),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'thr_1' }, query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('../../composables/useWebSocket', () => ({
  useWebSocket: () => ({
    connect: vi.fn(), send: websocketMock.send,
    connected: ref(true), reconnecting: ref(false),
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

const mounted: Array<ReturnType<typeof shallowMount>> = []
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  websocketMock.handlers.clear()
  websocketMock.send.mockClear()
})

function mountSession() {
  const wrapper = shallowMount(SessionDetail)
  mounted.push(wrapper)
  websocketMock.handlers.get('replay_end')?.({ type: 'replay_end', session_id: 'thr_1', req_id: 1 })
  return wrapper
}

function setTerminalSession(overrides: Record<string, unknown>) {
  websocketMock.handlers.get('session_list')?.({ sessions: [session(overrides)] })
  websocketMock.handlers.get('session_status')?.({ session_id: 'thr_1', status: 'completed' })
}

function session(overrides: Record<string, unknown>) {
  return {
    session_id: 'thr_1', daemon_id: 'd1', agent_type: 'codex', source: 'terminal', status: 'completed',
    daemon_online: true, cwd: '/repo', title: 'Codex',
    ...overrides,
  }
}

async function sendPrompt(wrapper: ReturnType<typeof shallowMount>, content: string) {
  await wrapper.find('.chat-textarea').setValue(content)
  await wrapper.find('.send-btn').trigger('click')
  const message = websocketMock.send.mock.calls
    .map(([payload]) => payload)
    .slice()
    .reverse()
    .find((payload: any) => payload.type === 'user_message' && payload.content === content)
  expect(message).toBeDefined()
  return message!.msg_id as string
}

function deliveryStatus(wrapper: ReturnType<typeof shallowMount>, content: string) {
  const message = wrapper.findAll('message-user-stub')
    .find((node) => node.attributes('content') === content)
  return message?.attributes('data-delivery-status')
}

describe('SessionDetail managed Codex terminal control', () => {
  test('managed Codex keeps composer available after a terminal status', async () => {
    const wrapper = mountSession()
    setTerminalSession({ control_mode: 'managed' })
    await nextTick()

    expect(wrapper.find('.chat-input-container').exists()).toBe(true)
  })

  test('unmanaged Codex stays read-only after a terminal status', async () => {
    const wrapper = mountSession()
    setTerminalSession({})
    await nextTick()

    expect(wrapper.find('.chat-input-container').exists()).toBe(false)
  })

  test('offline managed Codex keeps an editable draft composer after a terminal status', async () => {
    const wrapper = mountSession()
    setTerminalSession({ control_mode: 'managed', daemon_online: false })
    await nextTick()

    expect(wrapper.find('.chat-input-container').exists()).toBe(true)
    expect(wrapper.find('.chat-textarea').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.send-btn').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.ended-text').exists()).toBe(false)
  })

  test('daemon_status offline disables a managed Codex send without ending the session', async () => {
    const wrapper = mountSession()
    setTerminalSession({ control_mode: 'managed' })
    await nextTick()
    expect(wrapper.text()).toContain('dashboard.online')

    websocketMock.handlers.get('daemon_status')?.({ type: 'daemon_status', daemon_id: 'd1', status: 'offline' })
    await nextTick()

    expect(wrapper.text()).toContain('dashboard.offline')
    expect(wrapper.find('.chat-input-container').exists()).toBe(true)
    expect(wrapper.find('.send-btn').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.ended-text').exists()).toBe(false)
  })

  test('legacy disconnected status does not replace the managed Codex lifecycle', async () => {
    const wrapper = mountSession()
    setTerminalSession({ control_mode: 'managed' })
    websocketMock.handlers.get('session_status')?.({ session_id: 'thr_1', status: 'disconnected' })
    await nextTick()

    expect(wrapper.find('.chat-input-container').exists()).toBe(true)
    expect(wrapper.find('.send-btn').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.ended-text').exists()).toBe(false)
  })

  test('tracks managed Codex forwarded and accepted receipts independently by msg_id', async () => {
    const wrapper = mountSession()
    setTerminalSession({
      control_mode: 'managed',
      capabilities: ['message_acceptance_receipt'],
    })
    await nextTick()

    const first = await sendPrompt(wrapper, 'first prompt')
    const second = await sendPrompt(wrapper, 'second prompt')
    expect(deliveryStatus(wrapper, 'first prompt')).toBe('pending')
    expect(deliveryStatus(wrapper, 'second prompt')).toBe('pending')

    websocketMock.handlers.get('user_message_ack')?.({ type: 'user_message_ack', msg_id: first })
    await nextTick()
    expect(deliveryStatus(wrapper, 'first prompt')).toBe('forwarded')
    expect(deliveryStatus(wrapper, 'second prompt')).toBe('pending')

    websocketMock.handlers.get('user_message_receipt')?.({
      type: 'user_message_receipt',
      session_id: 'thr_1',
      msg_id: first,
      status: 'accepted',
    })
    await nextTick()
    expect(deliveryStatus(wrapper, 'first prompt')).toBe('accepted')
    expect(deliveryStatus(wrapper, 'second prompt')).toBe('pending')

    websocketMock.handlers.get('user_message_ack')?.({ type: 'user_message_ack', msg_id: second })
    await nextTick()
    expect(deliveryStatus(wrapper, 'second prompt')).toBe('forwarded')
  })

  test('keeps a rejected managed Codex prompt bubble without retrying it', async () => {
    const wrapper = mountSession()
    setTerminalSession({
      control_mode: 'managed',
      capabilities: ['message_acceptance_receipt'],
    })
    await nextTick()

    const msgId = await sendPrompt(wrapper, 'keep this prompt')
    const sendsBeforeReceipt = websocketMock.send.mock.calls
      .filter(([payload]) => payload.type === 'user_message').length

    websocketMock.handlers.get('user_message_receipt')?.({
      type: 'user_message_receipt',
      session_id: 'thr_1',
      msg_id: msgId,
      status: 'rejected',
      reason: 'Codex turn/start: disconnected',
      retryable: false,
    })
    await nextTick()

    expect(deliveryStatus(wrapper, 'keep this prompt')).toBe('failed')
    expect(wrapper.text()).toContain('session.send_failed')
    expect(websocketMock.send.mock.calls.filter(([payload]) => payload.type === 'user_message')).toHaveLength(sendsBeforeReceipt)
  })
})
