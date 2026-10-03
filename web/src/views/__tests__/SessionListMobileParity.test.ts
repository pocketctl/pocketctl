import { useLocale } from '../../composables/useLocale'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import SessionList from '../SessionList.vue'
import * as organization from '../../services/sessionOrganization'

enableAutoUnmount(afterEach)

let emitEvent: ((event: any) => void) | undefined
const push = vi.fn()
const renameSession = vi.fn().mockResolvedValue(null)
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
  useAuth: () => ({ accessToken: ref('token'), logout: vi.fn(), renameSession }),
}))

const sessions = [
  { session_id: 'alpha', title: 'Alpha Local Session', status: 'running', agent_type: 'codex', model: 'gpt-5.4', created_at: '2026-08-10T08:00:00Z', daemon_id: 'daemon-1', children: [] },
  { session_id: 'model', title: 'Model Match Session', status: 'idle', agent_type: 'claude-code', model: 'claude-sonnet-4', created_at: '2026-08-10T07:00:00Z', daemon_id: 'daemon-1', children: [] },
]

describe('SessionList latest iOS mobile parity', () => {
  afterEach(() => vi.restoreAllMocks())
  test('finishes archive loading from HTTP without waiting for a live WebSocket snapshot', async () => {
    routeQuery.value = { host: 'daemon-1', view: 'archived' }
    vi.spyOn(organization, 'listProjects').mockResolvedValue({ projects: [], ungrouped_count: 0, archived_count: 1, project_order_revision: 0, ungrouped_revision: 0, ungrouped_order_mode: 'activity' })
    vi.spyOn(organization, 'listOrganizedSessions').mockImplementation(async options => ({
      sessions: options?.view === 'archived' ? [
        { session_id: 'archived-http', title: 'Archived HTTP session', agent_type: 'codex', archived_at: '2026-10-02T00:00:00Z', daemon_id: 'daemon-1' },
        { session_id: 'active-http', title: 'Active HTTP session', agent_type: 'codex', daemon_id: 'daemon-1' },
      ] : [], has_more: false, next_cursor: null, revision: 0, order_mode: 'activity',
    }))
    const wrapper = mount(SessionList)
    expect(wrapper.find('[data-state="loading-sessions"]').exists()).toBe(true)
    await flushPromises()
    expect(wrapper.text()).toContain('Archived HTTP session')
    expect(wrapper.text()).not.toContain('Active HTTP session')
    expect(wrapper.find('[data-state="loading-sessions"]').exists()).toBe(false)
    wrapper.unmount()
  })
  test('an archived route never falls back to live unarchived sessions when organization APIs fail', async () => {
    routeQuery.value={host:'daemon-1',view:'archived'}
    const wrapper=mount(SessionList)
    emitEvent?.({type:'session_list',daemon_id:'daemon-1',sessions})
    await nextTick()
    expect(wrapper.text()).not.toContain('Alpha Local Session')
    expect(wrapper.text()).not.toContain('Model Match Session')
    expect(wrapper.find('.organization-back').exists()).toBe(true)
    wrapper.unmount()
  })
  beforeEach(() => {
    vi.spyOn(organization, 'listProjects').mockRejectedValue(new Error('Organization unavailable in fallback test'))
    vi.spyOn(organization, 'listOrganizedSessions').mockRejectedValue(new Error('Organization unavailable in fallback test'))
    useLocale().setLocale('zh')
    push.mockClear()
    emitEvent = undefined
    routeQuery.value = { host: 'daemon-1' }
  })

  test('renders host navigation, daemon status, fixed search and new-session controls', async () => {
    const wrapper = mount(SessionList)
    emitEvent?.({ type: 'daemon_list', daemons: [{ daemon_id: 'daemon-1', daemon_alias: 'Mac Studio', hostname: 'mac-studio.local', daemon_online: true }] })
    emitEvent?.({ type: 'session_list', daemon_id: 'daemon-1', sessions })
    await flushPromises()

    expect(wrapper.get('.mobile-session-nav-title').text()).toBe('会话列表')
    expect(wrapper.get('.mobile-session-host-caption').attributes('title')).toBe('Mac Studio')
    expect(wrapper.get('.mobile-daemon-status-copy').text()).toContain('在线 · 最后心跳 刚刚')
    expect(wrapper.get('[data-testid="session-list-search-toggle"]').attributes('aria-label')).toBe('搜索会话')
    expect(wrapper.get('[data-testid="session-list-new-session"]').attributes('aria-label')).toBe('新建会话')

    await wrapper.get('.mobile-session-back').trigger('click')
    expect(push).not.toHaveBeenCalled()
    expect(wrapper.get('.mobile-session-back').attributes('aria-label')).toBe('打开导航')
  })

  test('falls back to the full hostname when a host has no alias', async () => {
    const wrapper = mount(SessionList)
    const hostname = 'muwenbin-macbook-pro-with-a-very-long-local-hostname.local'
    emitEvent?.({ type: 'daemon_list', daemons: [{ daemon_id: 'daemon-1', hostname, daemon_online: true }] })
    await nextTick()

    const title = wrapper.get('.mobile-session-host-caption')
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

    expect(wrapper.find('.mobile-daemon-status-copy').exists()).toBe(false)
  })

  test('hides the host status line when opened without a host context', async () => {
    routeQuery.value = {}
    const wrapper = mount(SessionList)
    emitEvent?.({ type: 'daemon_list', daemons: [{ daemon_id: 'daemon-1', hostname: 'mac-studio', daemon_online: true }] })
    await nextTick()

    expect(wrapper.get('.mobile-session-nav-title').text()).toBe('会话列表')
    expect(wrapper.find('.mobile-daemon-status-copy').exists()).toBe(false)
  })

  test('Agent chips filter loaded cards and All restores the list', async () => {
    const wrapper = mount(SessionList)
    emitEvent?.({ type: 'session_list', daemon_id: 'daemon-1', sessions })
    await flushPromises()
    const chips = wrapper.findAll('.mobile-agent-chips button')
    await chips.find(chip => chip.text().includes('Codex'))!.trigger('click')
    expect(wrapper.findAll('.mobile-card-title').map(card => card.text())).toEqual(['Alpha Local Session'])
    await chips[0].trigger('click')
    expect(wrapper.findAll('.mobile-card-title')).toHaveLength(2)
    wrapper.unmount()
  })

  test('active filter excludes idle sessions without changing the loaded list', async () => {
    const wrapper = mount(SessionList)
    emitEvent?.({type:'session_list',daemon_id:'daemon-1',sessions})
    await flushPromises()
    await wrapper.get('.mobile-active-filter').trigger('click')
    expect(wrapper.findAll('.mobile-card-title').map(card => card.text())).toEqual(['Alpha Local Session'])
    await wrapper.get('.mobile-active-filter').trigger('click')
    expect(wrapper.findAll('.mobile-card-title')).toHaveLength(2)
    wrapper.unmount()
  })

  test('all-hosts view nests projects under their owning host and preselects that host when creating', async () => {
    routeQuery.value = {}
    vi.spyOn(organization, 'listProjects').mockResolvedValue({ projects: [{id:'p',name:'Shared project name',count:2,sort_position:0,order_mode:'activity',revision:1}], ungrouped_count:0,archived_count:0,project_order_revision:1,ungrouped_revision:1,ungrouped_order_mode:'activity' })
    vi.spyOn(organization, 'listOrganizedSessions').mockImplementation(async options => ({ sessions: options?.bucket === 'p' ? [
      {...sessions[0],project_id:'p',daemon_id:'daemon-1'}, {...sessions[1],project_id:'p',daemon_id:'daemon-2'},
    ] : [],has_more:false,next_cursor:null,revision:1,order_mode:'activity' }))
    const wrapper = mount(SessionList)
    emitEvent?.({type:'daemon_list',daemons:[{daemon_id:'daemon-1',hostname:'First host',daemon_online:true},{daemon_id:'daemon-2',hostname:'Second host',daemon_online:false}]})
    await flushPromises()
    expect(wrapper.findAll('.mobile-host-section strong').map(host => host.text())).toEqual(['First host','Second host'])
    expect(wrapper.findAll('.organization-fold')).toHaveLength(2)
    expect(wrapper.findAll('.mobile-host-section button')).toHaveLength(1)
    expect(wrapper.find('.mobile-host-note').text()).toContain('历史会话')
    await wrapper.findAll('.organization-action')[0].trigger('click')
    const menu = Array.from(document.querySelectorAll('.workspace-action-list .action-item')).find(item => item.textContent?.includes('新建会话')) as HTMLButtonElement
    menu.click()
    await nextTick()
    expect(wrapper.findComponent({name:'NewSessionDialog'}).props('preSelectedDaemonId')).toBe('daemon-1')
    wrapper.unmount()
  })

  test('searches every loaded session by title, model and agent and closes cleanly', async () => {
    const wrapper = mount(SessionList)
    emitEvent?.({ type: 'session_list', daemon_id: 'daemon-1', sessions })
    await flushPromises()

    await wrapper.get('[data-testid="session-list-search-toggle"]').trigger('click')
    const field = wrapper.get('[data-testid="session-list-search-field"]')
    await field.setValue('claude sonnet')

    expect(wrapper.get('.mobile-result-bar').text()).toContain('1 个会话')
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

    expect(wrapper.get('.mobile-filter-empty').text()).toContain('没有匹配的会话')
    await wrapper.get('.mobile-filter-empty button').trigger('click')
    expect(wrapper.findAll('.mobile-card-title')).toHaveLength(2)
    expect(wrapper.find('[data-testid="session-list-search-field"]').exists()).toBe(false)
  })
})


describe('iOS host grouping interactions', () => {
  const project = { id:'p',name:'Client',count:4,sort_position:0,order_mode:'activity' as const,revision:1 }
  const snapshot = { projects:[project],ungrouped_count:0,archived_count:0,project_order_revision:1,ungrouped_revision:1,ungrouped_order_mode:'activity' as const }
  const rows = [0,1,2,3].map(index => ({ ...sessions[0],session_id:`host-a-${index}`,title:`Task ${index}`,project_id:'p' }))
  beforeEach(() => {
    useLocale().setLocale('zh'); localStorage.clear(); routeQuery.value = {}; push.mockClear()
    vi.spyOn(organization,'listProjects').mockResolvedValue(snapshot)
    vi.spyOn(organization,'listOrganizedSessions').mockImplementation(async options => ({sessions: options.bucket === 'p' ? options.daemonId === 'daemon-2' ? [{...sessions[1],project_id:'p',daemon_id:'daemon-2'}] : rows : [],has_more:false,next_cursor:null,revision:1,order_mode:'activity'}))
  })
  afterEach(() => vi.restoreAllMocks())
  async function setup() {
    const wrapper = mount(SessionList)
    emitEvent?.({type:'daemon_list',daemons:[{daemon_id:'daemon-2',hostname:'Offline',daemon_online:false},{daemon_id:'daemon-1',daemon_alias:'Studio',hostname:'online',daemon_online:true}]})
    await flushPromises()
    return wrapper
  }
  test('sorts online hosts first, paginates each host and keeps collapse state independent', async () => {
    const wrapper = await setup()
    expect(wrapper.findAll('.mobile-host-section strong').map(node => node.text())).toEqual(['Studio','Offline'])
    expect(wrapper.findAll('.mobile-card-title')).toHaveLength(4)
    await wrapper.get('.mobile-host-more').trigger('click')
    expect(wrapper.findAll('.mobile-card-title')).toHaveLength(5)
    await wrapper.findAll('.organization-fold')[0].trigger('click')
    expect(wrapper.findAll('.mobile-card-title').map(node => node.text())).toEqual(['Model Match Session'])
    expect(wrapper.findAll('.organization-fold')[1].attributes('aria-expanded')).toBe('true')
    await wrapper.get('.mobile-active-filter').trigger('click')
    expect(wrapper.findAll('.mobile-card-title')).toHaveLength(4)
    expect(wrapper.findAll('.organization-fold')[0].attributes('aria-expanded')).toBe('true')
    await wrapper.findAll('.organization-fold')[0].trigger('click')
    expect(wrapper.findAll('.mobile-card-title')).toHaveLength(4)
  })
  test('search matches project and host names, expands matching projects and clears all filters', async () => {
    const wrapper = await setup()
    await wrapper.findAll('.organization-fold')[0].trigger('click')
    await wrapper.get('[data-testid="session-list-search-toggle"]').trigger('click')
    await wrapper.get('input[type=search]').setValue('Studio')
    expect(wrapper.findAll('.mobile-card-title')).toHaveLength(4)
    await wrapper.get('input[type=search]').setValue('Client')
    expect(wrapper.findAll('.mobile-card-title')).toHaveLength(5)
    await wrapper.get('input[type=search]').setValue('missing')
    await wrapper.get('.mobile-filter-empty button').trigger('click')
    expect(wrapper.find('input[type=search]').exists()).toBe(false)
    expect(wrapper.get('.mobile-active-filter').attributes('aria-pressed')).toBe('false')
  })
  test('host picker uses action rows, offers offline history and preserves route query', async () => {
    const wrapper = await setup()
    await wrapper.get('.mobile-host-picker-trigger').trigger('click')
    const buttons = document.querySelectorAll<HTMLButtonElement>('.mobile-host-picker-row')
    expect(buttons).toHaveLength(3)
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true')
    expect(buttons[2].textContent).toContain('离线 · 历史可查看')
    buttons[2].click(); await flushPromises()
    expect(push).toHaveBeenCalledWith({path:'/sessions',query:{host:'daemon-2'}})
  })
  test('session rename retains the editor on an API error and updates the list after saving', async () => {
    const wrapper = await setup()
    wrapper.findComponent({name:'MobileSessionCard'}).vm.$emit('long-press',rows[0])
    await nextTick()
    const rename = Array.from(document.querySelectorAll<HTMLButtonElement>('.workspace-action-list .action-item')).find(button => button.textContent?.includes('重命名会话'))!
    rename.click(); await nextTick()
    const input = document.querySelector<HTMLInputElement>('#mobile-session-rename input')!
    input.value = 'Renamed task'; input.dispatchEvent(new Event('input',{bubbles:true})); await nextTick()
    renameSession.mockResolvedValueOnce('Rename failed')
    document.querySelector('#mobile-session-rename')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))
    await flushPromises()
    expect(document.querySelector('#mobile-session-rename [role=alert]')?.textContent).toBe('Rename failed')
    renameSession.mockResolvedValueOnce(null)
    document.querySelector('#mobile-session-rename')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))
    await flushPromises()
    expect(renameSession).toHaveBeenLastCalledWith('host-a-0','Renamed task')
    expect(wrapper.findAll('.mobile-card-title').some(title => title.text() === 'Renamed task')).toBe(true)
  })
  test('cross-host dragging does not send a mutation', async () => {
    const move = vi.spyOn(organization,'moveSession').mockResolvedValue({project_id:null})
    const wrapper = await setup()
    const target = document.createElement('div'); target.dataset.daemonDrop = 'daemon-2'; target.dataset.projectDrop = 'ungrouped'
    wrapper.findComponent({name:'MobileSessionCard'}).vm.$emit('drop',target)
    await flushPromises()
    expect(move).not.toHaveBeenCalled()
    expect(wrapper.get('.mobile-toast').text()).toContain('同一主机')
  })
})
