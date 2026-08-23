import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import SessionList from '../SessionList.vue'

let emitEvent: ((event: any) => void) | undefined
const push = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ query: { host: 'daemon-1' } }),
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
  })

  test('renders host navigation, daemon status, fixed search and new-session controls', async () => {
    const wrapper = mount(SessionList)
    emitEvent?.({ type: 'daemon_list', daemons: [{ daemon_id: 'daemon-1', alias: 'Mac Studio', online: true }] })
    emitEvent?.({ type: 'session_list', daemon_id: 'daemon-1', sessions })
    await flushPromises()

    expect(wrapper.get('.mobile-session-nav-title').text()).toBe('Mac Studio')
    expect(wrapper.get('.mobile-daemon-status').text()).toContain('在线 · 最后心跳 刚刚')
    expect(wrapper.get('[data-testid="session-list-search-toggle"]').attributes('aria-label')).toBe('搜索会话')
    expect(wrapper.get('[data-testid="session-list-new-session"]').attributes('aria-label')).toBe('新建会话')

    await wrapper.get('.mobile-session-back').trigger('click')
    expect(push).toHaveBeenCalledWith('/hosts')
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
