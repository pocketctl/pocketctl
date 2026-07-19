import { shallowMount } from '@vue/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import SessionDetail from '../SessionDetail.vue'

const websocketMock = vi.hoisted(() => ({ handlers: new Map<string, (message: any) => void>(), send: vi.fn(() => true) }))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'thr_1' }, query: {} }),
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

  test('offline managed Codex stays read-only after a terminal status', async () => {
    const wrapper = mountSession()
    setTerminalSession({ control_mode: 'managed', daemon_online: false })
    await nextTick()

    expect(wrapper.find('.chat-input-container').exists()).toBe(false)
  })
})
