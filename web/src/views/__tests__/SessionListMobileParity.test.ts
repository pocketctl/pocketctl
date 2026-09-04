import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import SessionList from '../SessionList.vue'

let emitEvent: ((event: any) => void) | undefined
const push = vi.fn()
const routeQuery = ref<Record<string, string>>({})

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ query: routeQuery.value }),
}))

vi.mock('../../composables/useResponsiveLayout', () => ({
  useResponsiveLayout: () => ({ isMobile: ref(true) }),
}))

vi.mock('../../composables/useWebSocket', () => ({
  useWebSocket: () => ({
    connect: vi.fn(),
    send: vi.fn(() => true),
    onEvent: (callback: (event: any) => void) => {
      emitEvent = callback
      return () => undefined
    },
    effectiveStatus: ({ status }: { status: string }) => status,
    connected: ref(true),
  }),
}))

vi.mock('../../composables/useAuth', () => ({
  useAuth: () => ({ accessToken: ref('token'), logout: vi.fn() }),
}))

const sessions = [
  { session_id: 'alpha', title: 'Alpha Local Session', status: 'running', agent_type: 'codex', model: 'gpt-5.4', created_at: '2026-08-10T08:00:00Z', daemon_id: 'daemon-1', children: [] },
  { session_id: 'model', title: 'Model Match Session', status: 'idle', agent_type: 'claude-code', model: 'claude-sonnet-4', created_at: '2026-08-10T07:00:00Z', daemon_id: 'daemon-1', children: [] },
]

describe('SessionList latest iOS mobile parity', () => {
  beforeEach(() => {
    push.mockClear()
    emitEvent = undefined
    routeQuery.value = { host: 'daemon-1' }
  })

  test('renders host navigation, daemon status, fixed search and new-session controls', async () => {
    const wrapper = mount(SessionList)
    emitEvent?.({ type: 'daemon_list', daemons: [{ daemon_id: 'daemon-1', daemon_alias: 'Mac Studio', hostname: 'mac-studio.local', daemon_online: true }] })
    emitEvent?.({ type: 'session_list', daemon_id: 'daemon-1', sessions })
    await flushPromises()

    expect(wrapper.get('.mobile-session-nav-title').text()).toBe('Mac Studio')
    expect(wrapper.get('.mobile-session-nav-title').attributes('title')).toBe('Mac Studio')
    expect(wrapper.get('.mobile-session-nav .mobile-daemon-status').text()).toContain('在线 · 最后心跳 刚刚')
    expect(wrapper.get('[data-testid="session-list-search-toggle"]').attributes('aria-label')).toBe('搜索会话')
    expect(wrapper.get('[data-testid="session-list-new-session"]').attributes('aria-label')).toBe('新建会话')

    await wrapper.get('.mobile-session-back').trigger('click')
    expect(push).toHaveBeenCalledWith('/hosts')
  })

  test('falls back to the full hostname when a host has no alias', async () => {
    const wrapper = mount(SessionList)
    const hostname = 'muwenbin-macbook-pro-with-a-very-long-local-hostname.local'
    emitEvent?.({ type: 'daemon_list', daemons: [{ daemon_id: 'daemon-1', hostname, daemon_online: true }] })
    await nextTick()

    const title = wrapper.get('.mobile-session-nav-title')
    expect(title.text()).toBe(hostname)
    expect(title.attributes('title')).toBe(hostname)
  })

  test('keeps the selected host status in sync with daemon status events', async () => {
    const wrapper = mount(SessionList)
    emitEvent?.({ type: 'daemon_list', daemons: [{ daemon_id: 'daemon-1', alias: 'Mac Studio', daemon_online: false }] })
    await nextTick()

    expect(wrapper.get('.mobile-daemon-status-copy').text()).toBe('离线')

    emitEvent?.({ type: 'daemon_status', daemon_id: 'daemon-1', status: 'online', hostname: 'mac-studio' })
    await nextTick()

    expect(wrapper.get('.mobile-daemon-status-copy').text()).toContain('在线')
    expect(wrapper.get('.mobile-daemon-dot').classes()).toContain('online')
  })

  test('shows a connecting state instead of a false offline while daemon list is in flight', async () => {
    const wrapper = mount(SessionList)
    await nextTick()

    expect(wrapper.get('.mobile-daemon-status-copy').text()).toBe('连接中…')
    expect(wrapper.get('.mobile-daemon-dot').classes()).not.toContain('online')
  })

  test('inserts replayed discovery at its source activity time instead of promoting it', async () => {
    const wrapper = mount(SessionList)
    emitEvent?.({ type: 'session_list', daemon_id: 'daemon-1', sessions })
    emitEvent?.({
      type: 'session_discovered',
      session_id: 'historical-session',
      daemon_id: 'daemon-1',
      title: 'Historical Session',
      agent: 'codex',
      status: 'idle',
      resync: true,
      last_activity_at: '2026-08-01T08:00:00Z',
    })
    await nextTick()

    const text = wrapper.text()
    expect(text).toContain('Historical Session')
    expect(text.indexOf('Alpha Local Session')).toBeLessThan(text.indexOf('Historical Session'))
  })

  test('hides the host status line when the daemon list has no such host', async () => {
    const wrapper = mount(SessionList)
    emitEvent?.({ type: 'daemon_list', daemons: [{ daemon_id: 'daemon-other', hostname: 'other-host', daemon_online: true }] })
    await nextTick()

    expect(wrapper.find('.mobile-daemon-status').exists()).toBe(false)
  })

  test('hides the host status line when opened without a host context', async () => {
    routeQuery.value = {}
    const wrapper = mount(SessionList)
    emitEvent?.({ type: 'daemon_list', daemons: [{ daemon_id: 'daemon-1', hostname: 'mac-studio', daemon_online: true }] })
    await nextTick()

    expect(wrapper.get('.mobile-session-nav-title').text()).toBe('会话列表')
    expect(wrapper.find('.mobile-daemon-status').exists()).toBe(false)
  })

  test('searches every loaded session by title, model and agent and closes cleanly', async () => {
    const wrapper = mount(SessionList)
    emitEvent?.({ type: 'session_list', daemon_id: 'daemon-1', sessions })
    await flushPromises()

    await wrapper.get('[data-testid="session-list-search-toggle"]').trigger('click')
    const field = wrapper.get('[data-testid="session-list-search-field"]')
    await field.setValue('claude sonnet')

    expect(wrapper.get('.mobile-search-summary').text()).toContain('1 个结果 · 已加载 2 个会话')
    expect(wrapper.text()).toContain('Model Match Session')
    expect(wrapper.text()).not.toContain('Alpha Local Session')

    await wrapper.get('[data-testid="session-list-search-clear"]').trigger('click')
    expect(wrapper.text()).toContain('Alpha Local Session')
    await wrapper.get('[data-testid="session-list-search-toggle"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="session-list-search-field"]').exists()).toBe(false)
  })

  test('explains the local search scope for no results', async () => {
    const wrapper = mount(SessionList)
    emitEvent?.({ type: 'session_list', daemon_id: 'daemon-1', sessions })
    await flushPromises()

    await wrapper.get('[data-testid="session-list-search-toggle"]').trigger('click')
    await wrapper.get('[data-testid="session-list-search-field"]').setValue('no match')

    expect(wrapper.get('.mobile-search-empty').text()).toContain('在已加载的 2 个会话中未找到“no match”')
    expect(wrapper.get('.mobile-search-empty').text()).toContain('可搜索会话标题、模型或 Agent 类型')
  })
})
