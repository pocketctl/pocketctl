import { flushPromises, shallowMount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ref } from 'vue'
import PersonalSessionBrowser from '../PersonalSessionBrowser.vue'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (message: any) => void>(),
  send: vi.fn(() => true),
  listProjects: vi.fn(),
  listOrganizedSessions: vi.fn(),
}))
vi.mock('../../../composables/useAuth', () => ({
  useAuth: () => ({ user: ref({ id: 8801 }) }),
}))
vi.mock('../../../composables/useLocale', () => ({
  useLocale: () => ({ t: (key: string) => key, locale: ref('zh') }),
}))
vi.mock('../../../composables/useSessionBrowserFilters', async () => {
  const { reactive } = await import('vue')
  return { useSessionBrowserFilters: () => reactive({ host: '', agent: '', query: '', archived: false, searchOpen: false }) }
})
vi.mock('../../../composables/useWebSocket', () => ({
  useWebSocket: () => ({ connect: vi.fn(), send: mocks.send,
    onEvent: (name: string, handler: (message: any) => void) => {
      mocks.handlers.set(name, handler)
      return vi.fn()
    },
  }),
}))
vi.mock('../../../services/teamClient', () => ({ listTeams: vi.fn(async () => []) }))
vi.mock('../../../services/sessionOrganization', () => ({
  listProjects: mocks.listProjects, listOrganizedSessions: mocks.listOrganizedSessions,
}))

const sessions = [
  ...Array.from({ length: 34 }, (_, i) => ({ session_id: `mac-${i}`, title: `Mac ${i}`, daemon_id: 'mac', hostname: 'Mac', agent_type: 'claude-code', status: 'completed' })),
  { session_id: 'remote-1', title: 'Remote session', daemon_id: 'remote', hostname: 'Remote', daemon_online: false, agent_type: 'codex', status: 'completed' },
]
let wrapper: ReturnType<typeof shallowMount>
beforeEach(() => {
  mocks.handlers.clear()
  vi.clearAllMocks()
  mocks.listProjects.mockImplementation(async (host?: string) => ({ projects: [], ungrouped_count: host === 'remote' ? 1 : 34, archived_count: 0, project_order_revision: 0 }))
  mocks.listOrganizedSessions.mockImplementation(async ({ daemonId }: { daemonId?: string }) => ({
    sessions: sessions.filter(s => !daemonId || s.daemon_id === daemonId).slice(0, 30), next_cursor: null, revision: 0,
  }))
})
afterEach(() => wrapper?.unmount())
async function openPage(snapshot = sessions) {
  wrapper = shallowMount(PersonalSessionBrowser, {
    attachTo: document.body,
    global: { stubs: { RouterLink: { name: 'RouterLink', props: ['to'], template: '<a><slot /></a>' } } },
  })
  mocks.handlers.get('daemon_list')!({ daemons: [{ daemon_id: 'mac', hostname: 'Mac', daemon_online: true }] })
  mocks.handlers.get('session_list')!({ sessions: snapshot })
  await flushPromises()
}
async function selectHost(id: string) {
  await wrapper.get('.host-trigger').trigger('click')
  await wrapper.get(`[data-host-filter="${id}"]`).trigger('click')
  await flushPromises()
}

test('retains the personal host selector with one host and reports full counts beyond the first page', async () => {
  await openPage(sessions.filter(s => s.daemon_id === 'mac'))
  expect(wrapper.get('header small').text()).toContain('34')
  await wrapper.get('.host-trigger').trigger('click')
  expect(wrapper.get('[data-host-filter="mac"] .filter-count').text()).toBe('34')
  expect(wrapper.get('[data-host-filter=""] .filter-count').text()).toBe('34')
  expect(wrapper.get('[data-host-filter="mac"] .dot').classes()).toContain('online')
  await wrapper.get('[data-host-filter="mac"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('.host-trigger').text()).toContain('Mac')
  expect(mocks.listProjects).toHaveBeenLastCalledWith('mac')
  expect(mocks.listOrganizedSessions).toHaveBeenLastCalledWith(expect.objectContaining({ daemonId: 'mac' }))
  expect(wrapper.findComponent({ name: 'RouterLink' }).props('to')).toEqual({ path: '/session/mac-0', query: { host: 'mac' } })
})

test('keeps offline personal session hosts and all-host counts while filtering and resets unavailable agents', async () => {
  await openPage()
  await wrapper.get('.agent-filter-popover .filter-trigger').trigger('click')
  await wrapper.findAll('[role="menuitemradio"]').find(el => el.text().includes('Claude Code'))!.trigger('click')
  await selectHost('remote')
  expect(wrapper.get('header small').text()).toContain('1 个会话')
  expect(wrapper.get('.agent-filter-popover .filter-trigger').text()).toContain('session.agent_filter_all')
  expect(wrapper.get('nav').text()).toContain('Remote session')
  expect(wrapper.get('nav').text()).not.toContain('Mac 0')
  await wrapper.get('.host-trigger').trigger('click')
  expect(wrapper.get('[data-host-filter=""] .filter-count').text()).toBe('35')
  expect(wrapper.get('[data-host-filter="mac"] .filter-count').text()).toBe('34')
  expect(wrapper.get('[data-host-filter="remote"] .filter-count').text()).toBe('1')
  expect(wrapper.get('[data-host-filter="remote"] .dot').classes()).not.toContain('online')
  mocks.handlers.get('daemon_status')!({ daemon_id: 'remote', status: 'online' })
  await flushPromises()
  expect(wrapper.get('[data-host-filter="remote"] .dot').classes()).toContain('online')
  await wrapper.get('[data-host-filter=""]').trigger('click')
  await flushPromises()
  expect(mocks.listProjects).toHaveBeenLastCalledWith(undefined)
  expect(wrapper.get('header small').text()).toContain('35 个会话')
})

test('searches host names and IDs, resets search on reopen, focuses search, and closes with Escape or outside click', async () => {
  await openPage()
  await wrapper.get('.host-trigger').trigger('click')
  expect(document.activeElement).toBe(wrapper.get('.host-filter-search').element)
  await wrapper.get('.host-filter-search').setValue(' REMOTE ')
  expect(wrapper.findAll('[data-host-filter]')).toHaveLength(1)
  await wrapper.get('.host-filter-search').setValue('missing')
  expect(wrapper.findAll('[data-host-filter]')).toHaveLength(0)
  expect(wrapper.find('.host-filter-empty').exists()).toBe(true)
  await wrapper.get('.host-filter-search').trigger('keydown', { key: 'Escape' })
  expect(wrapper.find('.host-filter-menu').exists()).toBe(false)
  expect(document.activeElement).toBe(wrapper.get('.host-trigger').element)
  await wrapper.get('.host-trigger').trigger('click')
  expect(wrapper.get('.host-filter-search').element).toHaveProperty('value', '')
  expect(wrapper.findAll('[data-host-filter]')).toHaveLength(3)
  document.body.click()
  await flushPromises()
  expect(wrapper.find('.host-filter-menu').exists()).toBe(false)
})
