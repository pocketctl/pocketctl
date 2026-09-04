import { flushPromises, shallowMount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { reactive, ref } from 'vue'
import SessionDetail from '../SessionDetail.vue'

const websocketMock = vi.hoisted(() => ({
  handlers: new Map<string, (message: any) => void>(),
  operations: [] as string[],
  send: vi.fn((message: Record<string, unknown>) => {
    websocketMock.operations.push(`send:${String(message.type)}`)
    return true
  }),
}))
const routeMock = vi.hoisted(() => ({ current: null as any }))

vi.mock('vue-router', () => ({
  useRoute: () => routeMock.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('../../composables/useWebSocket', () => ({
  useWebSocket: () => ({
    connected: ref(true), reconnecting: ref(false),
    connect: vi.fn(), send: websocketMock.send, sendUserMessage: vi.fn(() => true),
    onEvent: vi.fn((typeOrHandler: string | ((message: any) => void), handler?: (message: any) => void) => {
      if (typeof typeOrHandler === 'string') {
        websocketMock.operations.push(`on:${typeOrHandler}`)
        websocketMock.handlers.set(typeOrHandler, handler!)
      }
      return vi.fn()
    }),
  }),
}))

vi.mock('../../composables/useLocale', () => ({
  useLocale: () => ({ t: (key: string) => key, locale: ref('zh') }),
}))
vi.mock('../../composables/useSessionRename', () => ({
  useSessionRename: () => ({
    renamingId: ref(''), renameInput: ref(''), startRename: vi.fn(), commitRename: vi.fn(), cancelRename: vi.fn(),
  }),
}))
vi.mock('../../composables/useResponsiveLayout', () => ({
  useResponsiveLayout: () => ({ isMobile: ref(true) }),
}))

describe('SessionDetail history loading', () => {
  beforeEach(() => {
    routeMock.current = reactive({ params: { id: 'session-http-lan' }, query: {} as Record<string, string> })
    websocketMock.handlers.clear()
    websocketMock.operations.length = 0
    websocketMock.send.mockClear()
    websocketMock.send.mockImplementation((message: Record<string, unknown>) => {
      websocketMock.operations.push(`send:${String(message.type)}`)
      return true
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  test('registers replay handlers and loads history without crypto on an HTTP LAN origin', async () => {
    vi.stubGlobal('crypto', undefined)

    const wrapper = shallowMount(SessionDetail)
    await flushPromises()

    const replayHandlerIndex = websocketMock.operations.indexOf('on:replay_batch')
    const replaySendIndex = websocketMock.operations.indexOf('send:replay')
    expect(replayHandlerIndex).toBeGreaterThanOrEqual(0)
    expect(replayHandlerIndex).toBeLessThan(replaySendIndex)

    websocketMock.handlers.get('session_list')?.({
      type: 'session_list',
      sessions: [{ session_id: 'session-http-lan', daemon_id: 'daemon-1', status: 'completed' }],
    })
    websocketMock.handlers.get('replay_batch')?.({
      type: 'replay_batch', session_id: 'session-http-lan', req_id: 1,
      events: [{ type: 'user_text', session_id: 'session-http-lan', text: 'LAN history loaded' }],
    })
    websocketMock.handlers.get('replay_end')?.({
      type: 'replay_end', session_id: 'session-http-lan', req_id: 1, has_more: false,
    })
    await wrapper.vm.$nextTick()

    expect((wrapper.vm as any).messages.map((message: any) => message.content)).toEqual(['LAN history loaded'])
    expect((wrapper.vm as any).isLoading).toBe(false)
    wrapper.unmount()
  })

  test('keeps replay usable when an auxiliary session request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    websocketMock.send.mockImplementation((message: Record<string, unknown>) => {
      websocketMock.operations.push(`send:${String(message.type)}`)
      if (message.type === 'get_session_meta') throw new Error('auxiliary unavailable')
      return true
    })

    const wrapper = shallowMount(SessionDetail)
    await flushPromises()

    websocketMock.handlers.get('replay_batch')?.({
      type: 'replay_batch', session_id: 'session-http-lan', req_id: 1,
      events: [{ type: 'user_text', session_id: 'session-http-lan', text: 'Replay survived' }],
    })
    websocketMock.handlers.get('replay_end')?.({
      type: 'replay_end', session_id: 'session-http-lan', req_id: 1, has_more: false,
    })
    await wrapper.vm.$nextTick()

    expect((wrapper.vm as any).messages.map((message: any) => message.content)).toEqual(['Replay survived'])
    expect((wrapper.vm as any).isLoading).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      '[session-history] auxiliary request failed',
      expect.objectContaining({ operation: 'get_session_meta' }),
    )
    wrapper.unmount()
  })

  test('shows an accessible loading animation instead of the empty-session state', async () => {
    const wrapper = shallowMount(SessionDetail)
    await wrapper.vm.$nextTick()

    const loading = wrapper.get('[data-testid="session-history-loading"]')
    expect(loading.attributes('role')).toBe('status')
    expect(loading.attributes('aria-live')).toBe('polite')
    expect(loading.text()).toContain('session.loading_history')
    expect(wrapper.find('.chat-welcome').exists()).toBe(false)
    expect(wrapper.find('.chat-empty-state').exists()).toBe(false)
    wrapper.unmount()
  })

  test('offers a retry when the initial replay stays slow', async () => {
    vi.useFakeTimers()
    const wrapper = shallowMount(SessionDetail)
    const initialReplayCount = websocketMock.send.mock.calls
      .filter(([message]) => message.type === 'replay').length

    await vi.advanceTimersByTimeAsync(8_000)
    await wrapper.vm.$nextTick()

    const loading = wrapper.get('[data-testid="session-history-loading"]')
    expect(loading.text()).toContain('session.loading_slow')
    await loading.get('[data-testid="session-history-retry"]').trigger('click')

    const replayCountAfterRetry = websocketMock.send.mock.calls
      .filter(([message]) => message.type === 'replay').length
    expect(replayCountAfterRetry).toBe(initialReplayCount + 1)
    expect(wrapper.get('[data-testid="session-history-loading"]').text()).not.toContain('session.loading_slow')
    wrapper.unmount()
  })
})
