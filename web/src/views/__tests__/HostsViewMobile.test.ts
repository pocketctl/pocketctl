import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import HostsView from '../HostsView.vue'

const push = vi.fn()
const routeQuery = ref<Record<string, string>>({})
const isMobile = ref(true)
const handlers = new Map<string, (event: any) => void>()
const wrappers: ReturnType<typeof mount>[] = []

function mountView() {
  const wrapper = mount(HostsView)
  wrappers.push(wrapper)
  return wrapper
}

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ query: routeQuery.value }),
}))

vi.mock('../../composables/useResponsiveLayout', () => ({
  useResponsiveLayout: () => ({ isMobile }),
}))

vi.mock('../../composables/useWebSocket', () => ({
  useWebSocket: () => ({
    connect: vi.fn(),
    send: vi.fn(() => true),
    onEvent: (type: string, handler: (event: any) => void) => {
      handlers.set(type, handler)
      return () => handlers.delete(type)
    },
  }),
}))

vi.mock('../../composables/useAuth', () => ({
  useAuth: () => ({
    accessToken: ref('token'),
    apiGetAuth: vi.fn(),
  }),
}))

vi.mock('../../composables/useQuota', () => ({
  useQuota: () => ({
    boundHosts: ref({ used: 2, limit: 5, over_limit: false }),
  }),
}))

vi.mock('../../composables/useEnv', () => ({
  getRelayOrigin: () => '',
}))

const offline = {
  daemon_id: 'offline',
  hostname: 'offline-mac',
  daemon_online: false,
  active_sessions: 0,
  total_sessions: 4,
  agents: [{ type: 'codex', version: '0.144.1' }],
}
const online = {
  daemon_id: 'online',
  daemon_alias: '主力机',
  hostname: 'online-mac',
  daemon_online: true,
  active_sessions: 3,
  total_sessions: 12,
  agents: [{ type: 'codex', version: '0.144.1', latest: '0.145.0', manageable: true }],
}

describe('HostsView mobile iOS parity', () => {
  beforeEach(() => {
    handlers.clear()
    push.mockReset()
    routeQuery.value = {}
    isMobile.value = true
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ total: 18_000_000, today: 12_400_000, thisWeek: 16_000_000, thisMonth: 18_000_000 }),
    }))
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    vi.unstubAllGlobals()
  })

  test('shows the four-metric overview and sorts online hosts first', async () => {
    const wrapper = mountView()
    handlers.get('daemon_list')?.({ daemons: [offline, online] })
    handlers.get('session_list')?.({ sessions: [] })
    await flushPromises()

    expect(wrapper.findAll('.mobile-host-overview [data-metric]')).toHaveLength(4)
    expect(wrapper.get('[data-metric="online"]').text()).toContain('1')
    expect(wrapper.get('[data-metric="offline"]').text()).toContain('1')
    expect(wrapper.get('[data-metric="today-token"]').text()).toContain('12.4M')
    expect(wrapper.get('[data-metric="active-sessions"]').text()).toContain('3')
    expect(wrapper.findAll('.mobile-host-card')[0].text()).toContain('主力机')
    expect(wrapper.get('.mobile-hosts-heading').text()).toContain('2/5')
  })

  test('selects the host requested by the recovery navigation query', async () => {
    isMobile.value = false
    routeQuery.value = { daemon_id: 'offline' }
    const wrapper = mountView()
    handlers.get('daemon_list')?.({ daemons: [online, offline] })
    await flushPromises()

    expect(wrapper.get('.host-detail-panel').text()).toContain('offline-mac')
  })

  test('opens host-scoped token usage and a usable agent manager', async () => {
    const wrapper = mountView()
    handlers.get('daemon_list')?.({ daemons: [online] })
    await flushPromises()

    await wrapper.get('.mobile-host-card [data-action="token"]').trigger('click')
    expect(push).toHaveBeenCalledWith({ path: '/tokens', query: { daemon: 'online' } })

    await wrapper.get('.mobile-host-card [data-action="agent"]').trigger('click')
    expect(wrapper.get('.mobile-agent-manager').text()).toContain('Codex')
    expect(wrapper.get('.mobile-agent-manager').text()).toContain('0.145.0')
  })

  test('closes agent management before browser back leaves the host list', async () => {
    const wrapper = mountView()
    handlers.get('daemon_list')?.({ daemons: [online] })
    await flushPromises()
    await wrapper.get('.mobile-host-card [data-action="agent"]').trigger('click')

    window.dispatchEvent(new PopStateEvent('popstate'))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.mobile-agent-manager').exists()).toBe(false)
  })
})
