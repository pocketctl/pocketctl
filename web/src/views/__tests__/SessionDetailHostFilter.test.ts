import { flushPromises, shallowMount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { reactive, ref } from 'vue'
import SessionDetail from '../SessionDetail.vue'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (message: any) => void>(),
  route: null as any,
  push: vi.fn(), replace: vi.fn(), send: vi.fn(() => true),
}))
vi.mock('vue-router', () => ({ useRoute: () => mocks.route, useRouter: () => ({ push: mocks.push, replace: mocks.replace }) }))
vi.mock('../../composables/useWebSocket', () => ({
  useWebSocket: () => ({
    connected: ref(true), reconnecting: ref(false), connect: vi.fn(), send: mocks.send,
    sendUserMessage: vi.fn(() => true),
    onEvent: (type: string, handler: (message: any) => void) => {
      if (typeof type === 'string') mocks.handlers.set(type, handler)
      return vi.fn()
    },
  }),
}))
vi.mock('../../composables/useLocale', () => ({ useLocale: () => ({ t: (key: string) => key, locale: ref('zh') }) }))
vi.mock('../../composables/useResponsiveLayout', () => ({ useResponsiveLayout: () => ({ isMobile: ref(false) }) }))
vi.mock('../../composables/useSessionRename', () => ({ useSessionRename: () => ({
  renamingId: ref(''), renameInput: ref(''), startRename: vi.fn(), commitRename: vi.fn(), cancelRename: vi.fn(),
}) }))

const sessions = [
  { session_id: 's1', daemon_id: 'h1', hostname: 'MacBook', daemon_online: true, title: 'Current session', agent_type: 'codex', status: 'completed' },
  { session_id: 's2', daemon_id: 'h2', hostname: 'Server', daemon_online: false, title: 'Remote session', agent_type: 'claude-code', status: 'completed' },
]
let wrapper: ReturnType<typeof shallowMount>
async function openPage(query: Record<string, string> = {}) {
  mocks.route = reactive({ params: { id: 's1' }, query })
  wrapper = shallowMount(SessionDetail, { attachTo: document.body })
  mocks.handlers.get('session_list')!({ sessions })
  mocks.handlers.get('daemon_list')!({ daemons: [
    { daemon_id: 'h1', hostname: 'MacBook', online: true },
    { daemon_id: 'h2', hostname: 'Server', online: false },
    { daemon_id: 'h3', hostname: 'Empty host', online: true },
  ] })
  await flushPromises()
}
async function chooseHost(id: string) {
  await wrapper.get('.host-filter-trigger').trigger('click')
  await wrapper.get(`[data-host-filter="${id}"]`).trigger('click')
}
beforeEach(() => { mocks.handlers.clear(); vi.clearAllMocks() })
afterEach(() => { wrapper?.unmount() })

describe('SessionDetail host filtering', () => {
  test('filters the list without changing the current host, connectivity, or replay', async () => {
    await openPage()
    expect(wrapper.findAll('.session-list-item')).toHaveLength(2)
    const replayCount = () => mocks.send.mock.calls.filter((args: any[]) => args[0]?.type === 'replay').length
    const initialReplayCount = replayCount()
    await chooseHost('h2')
    expect(wrapper.findAll('.session-list-item')).toHaveLength(1)
    expect(wrapper.get('.session-list').text()).toContain('Remote session')
    expect(wrapper.get('.session-toolbar-host').text()).toContain('MacBook')
    expect(wrapper.find('.banner-warning').exists()).toBe(false)
    expect(wrapper.get('.session-filter-notice').text()).toContain('session.host_filter_retained')
    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(replayCount()).toBe(initialReplayCount)
    await wrapper.get('.session-filter-notice button').trigger('click')
    expect(wrapper.get('.session-list').text()).toContain('Current session')
    expect(wrapper.find('.session-filter-notice').exists()).toBe(false)
  })

  test('keeps all hosts selected after updates and preserves all-host scope when opening another session', async () => {
    await openPage({ host: 'h1' })
    expect(wrapper.findAll('.session-list-item')).toHaveLength(1)
    await chooseHost('')
    mocks.handlers.get('session_list')!({ sessions: [...sessions] })
    mocks.route.params.id = 's2'
    await flushPromises()
    expect(wrapper.findAll('.session-list-item')).toHaveLength(2)
    expect(wrapper.get('.host-filter-trigger').text()).toContain('session.host_filter_all')
    expect(wrapper.get('.session-toolbar-host').text()).toContain('Server')
    expect(wrapper.find('.banner-warning').exists()).toBe(true)
  })

  test('combines agent scope, resets unavailable agents, and exposes hosts with no sessions', async () => {
    await openPage()
    await wrapper.get('.agent-filter-popover .agent-filter-trigger').trigger('click')
    await wrapper.get('[data-agent-filter="codex"]').trigger('click')
    expect(wrapper.findAll('.session-list-item')).toHaveLength(1)
    await chooseHost('h2')
    expect(wrapper.get('.session-list').text()).toContain('Remote session')
    expect(wrapper.get('.agent-filter-popover .agent-filter-trigger').text()).toContain('session.agent_filter_all')
    await chooseHost('h3')
    expect(wrapper.findAll('.session-list-item')).toHaveLength(0)
    expect(wrapper.get('.session-list .host-filter-empty').text()).toContain('session.host_filter_empty')
    await wrapper.get('.session-list .host-filter-empty button').trigger('click')
    expect(wrapper.findAll('.session-list-item')).toHaveLength(2)
  })

  test('searches names and IDs, closes with Escape/outside click, and keeps menus mutually exclusive', async () => {
    await openPage()
    await wrapper.get('.host-filter-trigger').trigger('click')
    expect(document.activeElement).toBe(wrapper.get('.host-filter-search').element)
    await wrapper.get('.host-filter-search').setValue('SERVER')
    expect(wrapper.findAll('[data-host-filter]')).toHaveLength(1)
    await wrapper.get('.host-filter-search').setValue('h3')
    expect(wrapper.get('[data-host-filter]').text()).toContain('Empty host')
    await wrapper.get('.host-filter-search').setValue('missing')
    expect(wrapper.findAll('[data-host-filter]')).toHaveLength(0)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.find('.host-filter-menu').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('.host-filter-trigger').element)
    await wrapper.get('.host-filter-trigger').trigger('click')
    await wrapper.get('.agent-filter-popover .agent-filter-trigger').trigger('click')
    expect(wrapper.find('.host-filter-menu').exists()).toBe(false)
    await wrapper.get('.host-filter-trigger').trigger('click')
    expect(wrapper.find('.agent-filter-popover .agent-filter-menu').exists()).toBe(false)
    document.body.click()
    await flushPromises()
    expect(wrapper.find('.host-filter-menu').exists()).toBe(false)
  })
})
