import { shallowMount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { nextTick, reactive, ref } from 'vue'
import SessionDetail from '../SessionDetail.vue'

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
    connect: vi.fn(), send: websocketMock.send,
    sendUserMessage: vi.fn((payload: Record<string, unknown>) => websocketMock.send({ type: 'user_message', ...payload })),
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
beforeEach(() => {
  routeMock.current = reactive({ params: { id: 'thr_1' }, query: {} as Record<string, string> })
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  websocketMock.handlers.clear()
  websocketMock.send.mockClear()
  vi.unstubAllGlobals()
})

function mountSession() {
  const wrapper = shallowMount(SessionDetail)
  mounted.push(wrapper)
  websocketMock.handlers.get('replay_end')?.({ type: 'replay_end', session_id: 'thr_1', req_id: 1 })
  return wrapper
}

function useMobileViewport() {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: true,
    media: '(max-width: 768px)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })))
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
  test('replayed status without a source timestamp preserves the listed activity time', async () => {
    const wrapper = mountSession()
    websocketMock.handlers.get('session_list')?.({
      sessions: [session({
        status: 'idle',
        last_activity_at: '2026-08-01T02:03:04Z',
        updated_at: '2026-08-01T02:03:04Z',
      })],
    })
    await nextTick()
    const before = wrapper.get('.sl-meta').text()

    websocketMock.handlers.get('session_status')?.({
      type: 'session_status', session_id: 'thr_1', status: 'idle', resync: true,
    })
    await nextTick()

    expect(wrapper.get('.sl-meta').text()).toBe(before)
  })

  test('keeps the mobile composer compact and caps wrapped input at five lines', async () => {
    useMobileViewport()
    const wrapper = mountSession()
    setTerminalSession({
      control_mode: 'managed',
      capabilities: ['message_acceptance_receipt'],
    })
    await nextTick()

    const textarea = wrapper.get('.chat-textarea')
    expect(textarea.attributes('rows')).toBe('1')
    expect((textarea.element as HTMLTextAreaElement).style.height).toBe('50px')

    await textarea.trigger('focus')
    await nextTick()
    expect(wrapper.get('.chat-input-area').classes()).toContain('composer-focused')
    expect((textarea.element as HTMLTextAreaElement).style.height).toBe('46px')

    Object.defineProperty(textarea.element, 'scrollHeight', { configurable: true, value: 160 })
    await textarea.setValue('A wrapped mobile prompt that needs several visible lines before scrolling.')
    await nextTick()

    expect((textarea.element as HTMLTextAreaElement).style.height).toBe('112px')

    Object.defineProperty(textarea.element, 'scrollHeight', { configurable: true, value: 180 })
    await textarea.setValue('A still longer wrapped mobile prompt that must remain internally scrollable.')
    await nextTick()
    expect((textarea.element as HTMLTextAreaElement).style.height).toBe('112px')
  })

  test('collapses adjacent historical Codex replies that differ only by a memory citation', async () => {
    const wrapper = mountSession()
    const reply = 'Only the adapter and clients changed.'

    await nextTick()
    setTerminalSession({})
    await nextTick()

    websocketMock.handlers.get('agent_text')?.({ type: 'agent_text', session_id: 'thr_1', text: reply })
    websocketMock.handlers.get('agent_text')?.({
      type: 'agent_text', session_id: 'thr_1',
      text: `${reply}\n\n<oai-mem-citation>internal metadata</oai-mem-citation>`,
    })
    await nextTick()
    // Live agent text is frame-batched; let the pending batch flush before
    // asserting the collapsed rendering.
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
    await nextTick()

    expect(wrapper.findAll('message-agent-stub')).toHaveLength(1)
  })

  test('native Codex TUI session remains read-only even if a stale control mode says managed', async () => {
    const wrapper = mountSession()
    setTerminalSession({ control_mode: 'managed' })
    await nextTick()

    expect(wrapper.find('.chat-input-container').exists()).toBe(false)
  })

  test('labels an unmanaged Codex terminal session as locally controlled instead of ended', async () => {
    const wrapper = mountSession()
    websocketMock.handlers.get('session_list')?.({
      sessions: [session({ status: 'running', control_mode: null, capabilities: [] })],
    })
    websocketMock.handlers.get('session_status')?.({ session_id: 'thr_1', status: 'running' })
    await nextTick()

    const notice = wrapper.get('.unmanaged-readonly-notice')
    expect(notice.text()).toContain('session.unmanaged_readonly_title')
    expect(notice.text()).toContain('session.unmanaged_readonly_description')
    expect(wrapper.find('.ended-text').exists()).toBe(false)
    expect(wrapper.get('.chat-messages').attributes('style')).toContain('--composer-float-clearance: 96px')
  })

  test('managed Codex keeps composer available after a terminal status', async () => {
    const wrapper = mountSession()
    setTerminalSession({
      control_mode: 'managed',
      capabilities: ['message_acceptance_receipt'],
    })
    await nextTick()

    expect(wrapper.find('.chat-input-container').exists()).toBe(true)
  })

  test('uses the Codex CLI public name in the local status receipt', async () => {
    const wrapper = mountSession()
    setTerminalSession({
      control_mode: 'managed',
      capabilities: ['message_acceptance_receipt'],
      agent_version: '1.2.3',
    })
    await nextTick()

    await wrapper.find('.chat-textarea').setValue('/status')
    await wrapper.find('.send-btn').trigger('click')

    expect(wrapper.get('command-receipt-card-stub').attributes('message')).toContain('Codex CLI v1.2.3')
  })

  test('keeps the last message clear of a resized floating composer', async () => {
    let onResize: ResizeObserverCallback | undefined
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { onResize = callback }
      observe() {}
      unobserve() {}
      disconnect() {}
    })

    const wrapper = mountSession()
    setTerminalSession({
      control_mode: 'managed',
      capabilities: ['message_acceptance_receipt'],
    })
    await nextTick()

    expect(onResize).toBeTypeOf('function')
    onResize!([{ contentRect: { height: 220 } } as ResizeObserverEntry], {} as ResizeObserver)
    await nextTick()

    expect(wrapper.get('.chat-messages').attributes('style')).toContain('--composer-float-clearance: 236px')
  })

  test('shows the persisted session-list model before daemon metadata arrives', async () => {
    const wrapper = mountSession()
    setTerminalSession({
      control_mode: 'managed',
      capabilities: ['message_acceptance_receipt'],
      model: 'gpt-5.6',
    })
    await nextTick()

    expect(wrapper.get('.input-meta .model-pill').text()).toContain('gpt-5.6')
  })

  test('restores the persisted model immediately when switching sessions in place', async () => {
    const wrapper = mountSession()
    websocketMock.handlers.get('session_list')?.({
      sessions: [
        session({ model: 'gpt-5.5' }),
        session({ session_id: 'thr_2', model: 'gpt-5.6-sol', title: 'Second Codex' }),
      ],
    })
    await nextTick()
    expect(wrapper.get('.session-toolbar-host').text()).toContain('gpt-5.5')

    routeMock.current.params.id = 'thr_2'
    await nextTick()

    expect(wrapper.get('.session-toolbar-host').text()).toContain('gpt-5.6-sol')
  })

  test('uses a fresh request id for every session metadata refresh', async () => {
    mountSession()
    const metadataRequests = () => websocketMock.send.mock.calls
      .map(([payload]) => payload)
      .filter((payload: any) => payload.type === 'get_session_meta')

    const firstRequest = metadataRequests().at(-1)
    websocketMock.handlers.get('connection_restored')?.({ type: 'connection_restored' })
    const secondRequest = metadataRequests().at(-1)

    expect(firstRequest).toMatchObject({ session_id: 'thr_1', request_id: expect.any(String) })
    expect(secondRequest).toMatchObject({ session_id: 'thr_1', request_id: expect.any(String) })
    expect(secondRequest.request_id).not.toBe(firstRequest.request_id)
  })

  test('renders a model switch notice in the conversation before the next reply', async () => {
    const wrapper = mountSession()
    setTerminalSession({
      control_mode: 'managed',
      capabilities: ['message_acceptance_receipt'],
      model: 'gpt-5.5',
    })
    await nextTick()

    websocketMock.handlers.get('session_model_changed')?.({
      type: 'session_model_changed', session_id: 'thr_1', model: 'gpt-5.6', event_id: 'model-56',
    })
    await nextTick()

    expect(wrapper.get('.model-switch-notice').text()).toContain('gpt-5.6')
    expect(wrapper.get('.input-meta .model-pill').text()).toContain('gpt-5.6')
  })

  test('shows the response end time beside retry after a turn finishes', async () => {
    const wrapper = mountSession()
    setTerminalSession({
      control_mode: 'managed',
      capabilities: ['message_acceptance_receipt'],
    })
    await nextTick()

    websocketMock.handlers.get('user_text')?.({ type: 'user_text', session_id: 'thr_1', text: 'retry me' })
    websocketMock.handlers.get('agent_text')?.({ type: 'agent_text', session_id: 'thr_1', text: 'done' })
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
    websocketMock.handlers.get('session_status')?.({ type: 'session_status', session_id: 'thr_1', status: 'running' })
    websocketMock.handlers.get('session_status')?.({
      type: 'session_status', session_id: 'thr_1', status: 'completed', last_activity_at: '2026-08-27T08:30:00Z',
    })
    await nextTick()

    expect(wrapper.get('.status-ended-at').text()).toContain('session.ended_at')
  })

  test('unmanaged Codex stays read-only after a terminal status', async () => {
    const wrapper = mountSession()
    setTerminalSession({})
    await nextTick()

    expect(wrapper.find('.chat-input-container').exists()).toBe(false)
  })

  test('offline managed Codex keeps an editable draft composer after a terminal status', async () => {
    const wrapper = mountSession()
    setTerminalSession({
      control_mode: 'managed', daemon_online: false,
      capabilities: ['message_acceptance_receipt'],
    })
    await nextTick()

    expect(wrapper.find('.chat-input-container').exists()).toBe(true)
    expect(wrapper.find('.chat-textarea').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.send-btn').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.ended-text').exists()).toBe(false)
  })

  test('daemon_status offline disables a managed Codex send without ending the session', async () => {
    const wrapper = mountSession()
    setTerminalSession({
      control_mode: 'managed',
      capabilities: ['message_acceptance_receipt'],
    })
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
    setTerminalSession({
      control_mode: 'managed',
      capabilities: ['message_acceptance_receipt'],
    })
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

  test('removes an interrupt-pending optimistic bubble and restores its draft without resending', async () => {
    const wrapper = mountSession()
    setTerminalSession({ control_mode: 'managed', capabilities: ['message_acceptance_receipt'] })
    await nextTick()

    const msgId = await sendPrompt(wrapper, 'retry after interrupt')
    const sent = websocketMock.send.mock.calls.filter(([payload]) => payload.type === 'user_message')
    expect(sent.at(-1)?.[0]).toMatchObject({ input_mode: 'auto' })

    websocketMock.handlers.get('user_message_receipt')?.({
      type: 'user_message_receipt', session_id: 'thr_1', msg_id: msgId,
      status: 'rejected', reason: 'turn_interrupt_pending', retryable: true,
    })
    await nextTick()

    expect(wrapper.findAll('message-user-stub').find(node => node.attributes('content') === 'retry after interrupt')).toBeUndefined()
    expect((wrapper.find('.chat-textarea').element as HTMLTextAreaElement).value).toBe('retry after interrupt')
    expect(websocketMock.send.mock.calls.filter(([payload]) => payload.type === 'user_message')).toHaveLength(sent.length)
  })

  test('only handles rejected interrupt-pending receipts and never overwrites a newer draft', async () => {
    const wrapper = mountSession()
    setTerminalSession({ control_mode: 'managed', capabilities: ['message_acceptance_receipt'] })
    await nextTick()

    const msgId = await sendPrompt(wrapper, 'rejected prompt')
    await wrapper.find('.chat-textarea').setValue('newer draft')
    const receipt = websocketMock.handlers.get('user_message_receipt')!
    receipt({ type: 'user_message_receipt', session_id: 'thr_1', msg_id: msgId, status: 'accepted', reason: 'turn_interrupt_pending', retryable: true })
    await nextTick()
    expect(deliveryStatus(wrapper, 'rejected prompt')).toBe('accepted')
    expect((wrapper.find('.chat-textarea').element as HTMLTextAreaElement).value).toBe('newer draft')

    receipt({ type: 'user_message_receipt', session_id: 'thr_1', msg_id: msgId, status: 'rejected', reason: 'turn_interrupt_pending', retryable: true })
    await nextTick()
    expect(deliveryStatus(wrapper, 'rejected prompt')).toBeUndefined()
    expect((wrapper.find('.chat-textarea').element as HTMLTextAreaElement).value).toBe('newer draft')
    expect(wrapper.find('.interrupt-pending-retry').exists()).toBe(true)
    const sendsBeforeRetry = websocketMock.send.mock.calls.filter(([payload]) => payload.type === 'user_message').length
    await wrapper.find('.interrupt-pending-retry').trigger('click')
    expect((wrapper.find('.chat-textarea').element as HTMLTextAreaElement).value).toBe('newer draft')
    const sendsAfterRetry = websocketMock.send.mock.calls.filter(([payload]) => payload.type === 'user_message')
    expect(sendsAfterRetry).toHaveLength(sendsBeforeRetry + 1)
    expect(sendsAfterRetry.at(-1)?.[0]).toMatchObject({ content: 'rejected prompt', input_mode: 'auto' })
    expect(wrapper.find('.interrupt-pending-retry').exists()).toBe(false)
  })

  test('clears interrupt-pending retry state on session/focus reset and unmount', async () => {
    const wrapper = mountSession()
    setTerminalSession({ control_mode: 'managed', capabilities: ['message_acceptance_receipt'] })
    await nextTick()
    const reject = async (content: string) => {
      const msgId = await sendPrompt(wrapper, content)
      await wrapper.find('.chat-textarea').setValue('newer draft')
      websocketMock.handlers.get('user_message_receipt')?.({
        type: 'user_message_receipt', session_id: routeMock.current.params.id, msg_id: msgId,
        status: 'rejected', reason: 'turn_interrupt_pending', retryable: true,
      })
      await nextTick()
      expect(wrapper.find('.interrupt-pending-retry').exists()).toBe(true)
    }

    await reject('session-A prompt')
    routeMock.current.params.id = 'thr_2'
    await nextTick()
    expect(wrapper.find('.interrupt-pending-retry').exists()).toBe(false)
    wrapper.unmount()
    expect(websocketMock.handlers.has('user_message_receipt')).toBe(false)

    routeMock.current = reactive({ params: { id: 'thr_1' }, query: {} as Record<string, string> })
    const focusWrapper = mountSession()
    setTerminalSession({ control_mode: 'managed', capabilities: ['message_acceptance_receipt'] })
    await nextTick()
    const focusMsgId = await sendPrompt(focusWrapper, 'focused prompt')
    await focusWrapper.find('.chat-textarea').setValue('newer draft')
    websocketMock.handlers.get('user_message_receipt')?.({
      type: 'user_message_receipt', session_id: 'thr_1', msg_id: focusMsgId,
      status: 'rejected', reason: 'turn_interrupt_pending', retryable: true,
    })
    await nextTick()
    expect(focusWrapper.find('.interrupt-pending-retry').exists()).toBe(true)
    routeMock.current.query.subagent = 'sub-1'
    await nextTick()
    expect(focusWrapper.find('.interrupt-pending-retry').exists()).toBe(false)
    focusWrapper.unmount()
    expect(websocketMock.handlers.has('user_message_receipt')).toBe(false)
  })
})
