import { shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { reactive, ref } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import SessionDetail from '../SessionDetail.vue'
import { resetAgentPlanProgressForTests } from '../../composables/useAgentPlanProgress'
import PlanSidePanel from '../../components/plan/PlanSidePanel.vue'
import MessageAgent from '../../components/messages/MessageAgent.vue'
import OpenCodePartCard from '../../components/messages/OpenCodePartCard.vue'
import FileChangeCard from '../../components/messages/FileChangeCard.vue'
import FileChangeBottomSheet from '../../components/messages/FileChangeBottomSheet.vue'
import ToolCallGroup from '../../components/messages/ToolCallGroup.vue'

const websocketMock = vi.hoisted(() => ({ handlers: new Map<string, (message: any) => void>(), allHandlers: new Set<(message: any) => void>() }))
const routeMock = vi.hoisted(() => ({ current: null as any }))
const responsiveMock = vi.hoisted(() => ({ isMobile: { __v_isRef: true, value: false } }))

vi.mock('vue-router', () => ({
  useRoute: () => routeMock.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('../../composables/useWebSocket', () => ({
  useWebSocket: () => ({
    connect: vi.fn(), send: vi.fn(() => true), sendUserMessage: vi.fn(() => true),
    onEvent: vi.fn((typeOrHandler: string | ((message: any) => void), handler?: (message: any) => void) => {
      if (typeof typeOrHandler === 'function') {
        websocketMock.allHandlers.add(typeOrHandler)
        return () => websocketMock.allHandlers.delete(typeOrHandler)
      }
      websocketMock.handlers.set(typeOrHandler, handler!)
      return () => websocketMock.handlers.delete(typeOrHandler)
    }),
  }),
}))

vi.mock('../../composables/useLocale', () => ({ useLocale: () => ({ t: (key: string) => key, locale: ref('en') }) }))
vi.mock('../../composables/useSessionRename', () => ({
  useSessionRename: () => ({
    renamingId: ref(''), renameInput: ref(''), startRename: vi.fn(), commitRename: vi.fn(), cancelRename: vi.fn(),
  }),
}))
vi.mock('../../composables/useResponsiveLayout', () => ({ useResponsiveLayout: () => responsiveMock }))

async function openToolbarOverflow(wrapper: ReturnType<typeof shallowMount>) {
  if (!wrapper.find('.toolbar-overflow-menu').exists()) {
    await wrapper.get('.toolbar-more-btn').trigger('click')
  }
}

describe('SessionDetail processEvent integration', () => {
  beforeEach(() => {
    routeMock.current = reactive({ params: { id: 'ses_1' }, query: {} as Record<string, string> })
    responsiveMock.isMobile.value = false
  })

  test('filters the current host session rail with the scheme A agent popover', async () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.allSessions = [
      { session_id: 'ses_1', daemon_id: 'daemon-1', title: 'Codex one', agent_type: 'codex', status: 'running' },
      { session_id: 'ses_desktop', daemon_id: 'daemon-1', title: 'Desktop observer', agent_type: 'codex-desktop', status: 'completed' },
      { session_id: 'ses_zcode', daemon_id: 'daemon-1', title: 'ZCode observer', agent_type: 'zcode', status: 'completed' },
      { session_id: 'ses_oc', daemon_id: 'daemon-1', title: 'OpenCode one', agent_type: 'opencode', status: 'idle' },
      { session_id: 'ses_2', daemon_id: 'daemon-1', title: 'Claude one', agent_type: 'claude-code', status: 'idle' },
      { session_id: 'ses_3', daemon_id: 'daemon-1', title: 'Codex two', agent_type: 'codex', status: 'exited' },
      { session_id: 'ses_4', daemon_id: 'daemon-2', title: 'OpenCode other host', agent_type: 'opencode', status: 'idle' },
    ]
    vm.selectedHostId = 'daemon-1'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.host-tabs').exists()).toBe(false)
    expect(wrapper.findAll('.session-list-item')).toHaveLength(6)

    const trigger = wrapper.get('.agent-filter-trigger')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    await trigger.trigger('click')

    const options = wrapper.findAll('.agent-filter-option')
    expect(options.map(option => option.attributes('data-agent-filter'))).toEqual([
      'all', 'codex', 'codex-desktop', 'zcode', 'opencode', 'claude-code',
    ])
    expect(options.map(option => option.get('.agent-filter-count').text())).toEqual(['6', '2', '1', '1', '1', '1'])

    await wrapper.get('[data-agent-filter="codex"]').trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(wrapper.findAll('.session-list-item')).toHaveLength(2)
    expect(wrapper.find('.session-list').text()).toContain('Codex one')
    expect(wrapper.find('.session-list').text()).not.toContain('Claude one')
    wrapper.unmount()
  })

  test('keeps plan and edited files actions inside the toolbar overflow menu', async () => {
    resetAgentPlanProgressForTests()
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.allSessions = [{ session_id: 'ses_1', daemon_id: 'daemon-1', status: 'running' }]
    vm.processEvent({
      type: 'agent_plan', session_id: 'ses_1', event_id: 'plan-menu', revision: 1,
      plan: [{ step: 'Polish workspace', status: 'in_progress' }],
    })
    vm.processEvent({
      type: 'agent_file_change', session_id: 'ses_1', turn_id: 'turn-menu', seq: 1,
      event_id: 'file-menu', change_set_id: 'managed:menu', change_index: 0, change_total: 1,
      path: 'workspace.vue', change_kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new\n',
      additions: 1, deletions: 1, status: 'completed',
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.plan-toolbar-button').exists()).toBe(false)
    expect(wrapper.find('.file-change-toolbar-button').exists()).toBe(false)

    await wrapper.get('.toolbar-more-btn').trigger('click')
    expect(wrapper.get('.toolbar-overflow-menu').attributes('role')).toBe('menu')
    expect(wrapper.get('.plan-toolbar-button').text()).toContain('1')
    expect(wrapper.get('.file-change-toolbar-button').text()).toContain('1')

    await wrapper.get('.plan-toolbar-button').trigger('click')
    expect(wrapper.find('.toolbar-overflow-menu').exists()).toBe(false)
    expect(wrapper.findComponent(PlanSidePanel).exists()).toBe(true)
    wrapper.unmount()
  })

  test('exposes every desktop overflow action from the mobile session header', async () => {
    responsiveMock.isMobile.value = true
    resetAgentPlanProgressForTests()
    localStorage.setItem('pocketctl_plan_panel_open', 'true')
    const wrapper = shallowMount(SessionDetail)
    localStorage.removeItem('pocketctl_plan_panel_open')
    const vm = wrapper.vm as any
    vm.allSessions = [{
      session_id: 'ses_1', daemon_id: 'daemon-1', agent_type: 'codex', status: 'running',
      cwd: '/workspace', totalTokens: 1200,
    }]
    vm.processEvent({
      type: 'agent_plan', session_id: 'ses_1', event_id: 'plan-mobile-menu', revision: 1,
      plan: [{ step: 'Mobile actions', status: 'in_progress' }],
    })
    vm.processEvent({
      type: 'agent_file_change', session_id: 'ses_1', turn_id: 'turn-mobile-menu', seq: 1,
      event_id: 'file-mobile-menu', change_set_id: 'managed:mobile-menu', change_index: 0, change_total: 1,
      path: 'mobile.vue', change_kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new\n',
      additions: 1, deletions: 1, status: 'completed',
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent(PlanSidePanel).exists()).toBe(false)
    const mobileOverflow = wrapper.get('.mobile-session-toolbar-overflow')
    await mobileOverflow.get('.toolbar-more-btn').trigger('click')

    expect(mobileOverflow.get('.toolbar-overflow-menu').attributes('role')).toBe('menu')
    expect(mobileOverflow.findAll('[data-toolbar-action]').map(item => item.attributes('data-toolbar-action'))).toEqual([
      'plan', 'edited-files', 'copy-id', 'resume',
    ])

    let planRequests = 0
    const onPlanRequest = () => { planRequests += 1 }
    window.addEventListener('pocketctl:open-mobile-session-plan', onPlanRequest)
    await mobileOverflow.get('[data-toolbar-action="plan"]').trigger('click')
    expect(planRequests).toBe(1)
    expect(wrapper.find('.toolbar-overflow-menu').exists()).toBe(false)
    window.removeEventListener('pocketctl:open-mobile-session-plan', onPlanRequest)

    await mobileOverflow.get('.toolbar-more-btn').trigger('click')
    await mobileOverflow.get('[data-toolbar-action="edited-files"]').trigger('click')
    expect(wrapper.get('.file-change-side-panel').attributes('aria-modal')).toBe('true')
    wrapper.unmount()
  })

  test('matches the toolbar overflow information hierarchy from the approved design', async () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.allSessions = [{
      session_id: 'ses_1', daemon_id: 'daemon-1', agent_type: 'codex', status: 'running', totalTokens: 42800,
    }]
    vm.currentModel = 'gpt-5.4'
    vm.currentEffort = 'high'
    await wrapper.vm.$nextTick()

    await openToolbarOverflow(wrapper)

    expect(wrapper.findAll('.toolbar-overflow-metric').map(item => item.text())).toEqual([
      'gpt-5.4',
      'session.effort.high',
      '43K',
    ])
    const items = wrapper.findAll('.toolbar-overflow-item')
    expect(items.at(-1)?.find('code').text()).toBe('resume')
    wrapper.unmount()
  })

  test('keeps an open toolbar menu in a stacking layer above the message surface', async () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.allSessions = [{ session_id: 'ses_1', daemon_id: 'daemon-1', status: 'running' }]
    await wrapper.vm.$nextTick()

    await wrapper.get('.toolbar-more-btn').trigger('click')

    const toolbar = wrapper.get('.chat-toolbar').element as HTMLElement
    const messages = wrapper.get('.chat-messages').element as HTMLElement
    expect(toolbar.style.position).toBe('relative')
    expect(Number(toolbar.style.zIndex)).toBeGreaterThan(Number(messages.style.zIndex) || 0)
    wrapper.unmount()
  })

  test('groups consecutive ordinary tool calls without crossing a diff card boundary', async () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.allSessions = [{ session_id: 'ses_1', daemon_id: 'daemon-1', status: 'running' }]

    vm.processEvent({ type: 'tool_call', call_id: 'read-1', tool: 'Read', input: { path: 'a.ts' }, turn_id: 'turn-1', flow_scope: 'auxiliary' })
    vm.processEvent({ type: 'tool_call', call_id: 'bash-1', tool: 'Bash', input: { command: 'npm test' }, turn_id: 'turn-1', flow_scope: 'auxiliary' })
    vm.processEvent({ type: 'tool_call', call_id: 'edit-1', tool: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, turn_id: 'turn-1', flow_scope: 'auxiliary' })
    vm.processEvent({ type: 'tool_call', call_id: 'read-2', tool: 'Read', input: { path: 'b.ts' }, turn_id: 'turn-1', flow_scope: 'auxiliary' })
    await wrapper.vm.$nextTick()

    const groups = wrapper.findAllComponents(ToolCallGroup)
    expect(groups).toHaveLength(2)
    expect(groups[0].props('messages').map((message: any) => message.call_id)).toEqual(['read-1', 'bash-1'])
    expect(groups[1].props('messages').map((message: any) => message.call_id)).toEqual(['read-2'])
    expect(wrapper.find('diff-card-stub').exists()).toBe(true)
    wrapper.unmount()
  })

  test('bottom-aligns short unmanaged session content above the read-only notice', async () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.allSessions = [{
      session_id: 'ses_1', daemon_id: 'daemon-1', agent_type: 'zcode',
      status: 'completed', source: 'terminal',
    }]
    vm.status = 'completed'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.chat-input-container').exists()).toBe(false)
    expect(wrapper.find('.messages-bottom-spacer').exists()).toBe(true)
    expect(wrapper.find('.unmanaged-readonly-notice').exists()).toBe(true)
    expect(wrapper.get('.chat-messages').attributes('style')).toContain('--composer-float-clearance: 96px')
    wrapper.unmount()
  })

  test('isolates Edited files reduction from legacy tool results and OpenCode parts', async () => {
    const contract = JSON.parse(readFileSync(resolve(process.cwd(), '../testdata/contracts/agent_file_change_turn.json'), 'utf8')) as {
      events: Array<Record<string, any>>
    }
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.allSessions = [{ session_id: 'ses_1', daemon_id: 'daemon-1', status: 'running' }]

    for (const event of contract.events) vm.processEvent(event)
    websocketMock.handlers.get('replay_batch')?.({
      type: 'replay_batch', session_id: 'ses_1', events: [contract.events[0]],
    })
    vm.processEvent({
      ...contract.events[0], event_id: 'codex:file:three', change_set_id: 'native:call_2',
      seq: 102, change_index: 0, change_total: 1, additions: 1, deletions: 0,
      diff: '@@ -2,0 +3 @@\n+later\n',
    })
    vm.processEvent({ type: 'tool_result', call_id: 'missing-result', output: 'legacy result' })
    vm.processEvent({
      type: 'agent_patch', message_id: 'oc-message', part_id: 'oc-patch',
      files: ['legacy-opencode.txt'], hash: 'hash-1',
    })
    await wrapper.vm.$nextTick()

    const cards = vm.messages.filter((item: any) => item.type === 'agent_file_change')
    expect(cards).toHaveLength(1)
    expect(cards[0].fileChange).toMatchObject({ additions: 4, deletions: 1 })
    expect(cards[0].fileChange.files.map((file: any) => file.path)).toEqual(['a.txt', 'b.txt'])
    expect(cards[0].fileChange.files[0].edits).toHaveLength(2)

    expect(vm.messages.some((item: any) => item.call_id === 'missing-result')).toBe(false)
    vm.processEvent({ type: 'tool_call', call_id: 'missing-result', tool: 'Read', input: { path: 'old.txt' } })
    expect(vm.messages.find((item: any) => item.call_id === 'missing-result')).toMatchObject({
      output: 'legacy result', status: 'completed',
    })
    expect(vm.messages.filter((item: any) => item.type === 'agent_file_change')).toHaveLength(1)
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent(OpenCodePartCard).exists()).toBe(true)
  })

  test('moves live Edited files from the chat timeline into the toolbar panel', async () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.allSessions = [{ session_id: 'ses_1', daemon_id: 'daemon-1', status: 'running' }]

    const handler = websocketMock.handlers.get('agent_file_change')
    expect(handler).toBeTypeOf('function')
    handler!({
      type: 'agent_file_change', session_id: 'ses_1', turn_id: 'turn-live', seq: 11,
      event_id: 'file-live', change_set_id: 'managed:call-live', change_index: 0, change_total: 1,
      path: 'live.txt', change_kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new\n',
      additions: 1, deletions: 1, status: 'completed',
    })
    await wrapper.vm.$nextTick()

    expect(vm.messages.filter((item: any) => item.type === 'agent_file_change')).toHaveLength(1)
    expect(wrapper.findComponent(FileChangeCard).exists()).toBe(false)
    expect(wrapper.find('.turn-unknown-event').exists()).toBe(false)
    await openToolbarOverflow(wrapper)
    const toolbarButton = wrapper.find('.file-change-toolbar-button')
    expect(toolbarButton.exists()).toBe(true)
    await toolbarButton.trigger('click')
    expect(wrapper.findComponent(FileChangeCard).exists()).toBe(true)
  })

  test('keeps agent file changes on the mobile card path instead of unknown fallback text', async () => {
    responsiveMock.isMobile.value = true
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.allSessions = [{ session_id: 'ses_1', daemon_id: 'daemon-1', status: 'running' }]
    vm.processEvent({
      type: 'agent_file_change', session_id: 'ses_1', turn_id: 'turn-mobile', seq: 15,
      event_id: 'file-mobile', change_set_id: 'managed:call-mobile', change_index: 0, change_total: 1,
      path: 'mobile.txt', change_kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new\n',
      additions: 1, deletions: 1, status: 'completed', flow_scope: 'auxiliary', content_class: 'execution',
    })
    await wrapper.vm.$nextTick()

    expect((wrapper.vm as any).$?.setupState.isMobile).toBe(true)
    expect(vm.renderMessages).toHaveLength(1)
    expect(vm.turnRows[0].auxiliary).toHaveLength(1)
    expect(wrapper.findComponent(FileChangeCard).exists()).toBe(true)
    expect(wrapper.find('.turn-unknown-event').exists()).toBe(false)
  })

  test('closes the desktop Edited files panel with Escape', async () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.allSessions = [{ session_id: 'ses_1', daemon_id: 'daemon-1', status: 'running' }]
    vm.processEvent({
      type: 'agent_file_change', session_id: 'ses_1', turn_id: 'turn-escape', seq: 12,
      event_id: 'file-escape', change_set_id: 'managed:call-escape', change_index: 0, change_total: 1,
      path: 'escape.txt', change_kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new\n',
      additions: 1, deletions: 1, status: 'completed',
    })
    await wrapper.vm.$nextTick()

    await openToolbarOverflow(wrapper)
    await wrapper.get('.file-change-toolbar-button').trigger('click')
    expect(wrapper.find('.file-change-side-panel').exists()).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.file-change-side-panel').exists()).toBe(false)
    await openToolbarOverflow(wrapper)
    expect(wrapper.get('.file-change-toolbar-button').attributes('aria-expanded')).toBe('false')
    wrapper.unmount()
  })

  test('opens Edited files as a modal review workspace and closes from its backdrop', async () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.allSessions = [{ session_id: 'ses_1', daemon_id: 'daemon-1', status: 'running' }]
    vm.processEvent({
      type: 'agent_file_change', session_id: 'ses_1', turn_id: 'turn-workspace', seq: 14,
      event_id: 'file-workspace', change_set_id: 'managed:call-workspace', change_index: 0, change_total: 1,
      path: 'workspace.txt', change_kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new\n',
      additions: 1, deletions: 1, status: 'completed',
    })
    await wrapper.vm.$nextTick()

    await openToolbarOverflow(wrapper)
    await wrapper.get('.file-change-toolbar-button').trigger('click')
    const panel = wrapper.get('.file-change-side-panel')
    expect(panel.attributes('role')).toBe('dialog')
    expect(panel.attributes('aria-modal')).toBe('true')
    expect(wrapper.get('.file-change-panel-backdrop').attributes('aria-label')).toBe('session.file_change_close')

    await wrapper.get('.file-change-panel-backdrop').trigger('click')
    expect(wrapper.find('.file-change-side-panel').exists()).toBe(false)
    await openToolbarOverflow(wrapper)
    expect(wrapper.get('.file-change-toolbar-button').attributes('aria-expanded')).toBe('false')
    wrapper.unmount()
  })

  test('uses one side-panel slot for Task list and Edited files', async () => {
    resetAgentPlanProgressForTests()
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.allSessions = [{ session_id: 'ses_1', daemon_id: 'daemon-1', status: 'running' }]
    vm.processEvent({
      type: 'agent_plan', session_id: 'ses_1', event_id: 'plan-side-slot', revision: 1,
      plan: [{ step: 'Share the side-panel slot', status: 'in_progress' }],
    })
    vm.processEvent({
      type: 'agent_file_change', session_id: 'ses_1', turn_id: 'turn-side-slot', seq: 13,
      event_id: 'file-side-slot', change_set_id: 'managed:call-side-slot', change_index: 0, change_total: 1,
      path: 'slot.txt', change_kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new\n',
      additions: 1, deletions: 1, status: 'completed',
    })
    await wrapper.vm.$nextTick()

    await openToolbarOverflow(wrapper)
    await wrapper.get('.plan-toolbar-button').trigger('click')
    expect(wrapper.findComponent(PlanSidePanel).exists()).toBe(true)
    expect(wrapper.find('.file-change-side-panel').exists()).toBe(false)

    await openToolbarOverflow(wrapper)
    await wrapper.get('.file-change-toolbar-button').trigger('click')
    expect(wrapper.findComponent(PlanSidePanel).exists()).toBe(false)
    expect(wrapper.find('.file-change-side-panel').exists()).toBe(true)

    await openToolbarOverflow(wrapper)
    await wrapper.get('.plan-toolbar-button').trigger('click')
    expect(wrapper.findComponent(PlanSidePanel).exists()).toBe(true)
    expect(wrapper.find('.file-change-side-panel').exists()).toBe(false)
    wrapper.unmount()
  })

  test('dismisses an open file-change sheet and drops its opener on session switch', async () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.allSessions = [{ session_id: 'ses_1', daemon_id: 'daemon-1', status: 'running' }]
    vm.processEvent({
      type: 'agent_file_change', session_id: 'ses_1', turn_id: 'turn-1', seq: 1,
      event_id: 'file-1', change_set_id: 'set-1', change_index: 0, change_total: 1,
      path: 'old-session.txt', change_kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new\n',
      additions: 1, deletions: 1, status: 'completed',
    })
    await wrapper.vm.$nextTick()
    const opener = document.createElement('button')
    document.body.append(opener)
    await openToolbarOverflow(wrapper)
    await wrapper.get('.file-change-toolbar-button').trigger('click')
    wrapper.findComponent(FileChangeCard).vm.$emit('open-mobile', opener)
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent(FileChangeBottomSheet).exists()).toBe(true)
    expect(vm.fileChangeOpener).toBe(opener)

    routeMock.current.params.id = 'ses_2'
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent(FileChangeBottomSheet).exists()).toBe(false)
    expect(vm.mobileFileChange).toBeNull()
    expect(vm.fileChangeOpener).toBeNull()
    wrapper.unmount()
    opener.remove()
  })

  test('reduces live and replayed agent plans outside the chat timeline', () => {
    resetAgentPlanProgressForTests()
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any

    vm.processEvent({
      type: 'agent_plan', session_id: 'ses_1', event_id: 'plan-2', previous_event_id: 'plan-1', revision: 2,
      plan: [{ step: 'Build Web panel', status: 'in_progress' }],
    })
    vm.processEvent({
      type: 'agent_plan', session_id: 'ses_1', event_id: 'plan-1', revision: 1,
      plan: [{ step: 'Old state', status: 'pending' }],
    })

    expect(vm.messages).toEqual([])
    expect(vm.currentPlan).toMatchObject({ eventId: 'plan-2', revision: 2 })
    expect(vm.currentPlan.items[0]).toEqual({ step: 'Build Web panel', status: 'in_progress' })
  })

  test('opens and closes the desktop plan panel from the session toolbar', async () => {
    resetAgentPlanProgressForTests()
    localStorage.removeItem('pocketctl_plan_panel_open')
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.allSessions = [{ session_id: 'ses_1', daemon_id: 'daemon-1', status: 'running' }]

    vm.processEvent({
      type: 'agent_plan', session_id: 'ses_1', event_id: 'plan-1', revision: 1,
      plan: [{ step: 'Show the panel', status: 'in_progress' }],
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent(PlanSidePanel).exists()).toBe(false)
    await openToolbarOverflow(wrapper)
    let button = wrapper.get('.plan-toolbar-button')
    expect(button.attributes('aria-expanded')).toBe('false')
    await button.trigger('click')
    expect(wrapper.findComponent(PlanSidePanel).exists()).toBe(true)
    await openToolbarOverflow(wrapper)
    button = wrapper.get('.plan-toolbar-button')
    expect(button.attributes('aria-expanded')).toBe('true')

    wrapper.findComponent(PlanSidePanel).vm.$emit('close')
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent(PlanSidePanel).exists()).toBe(false)
  })

  test('keeps backward replay batches in relay chronological order', () => {
    const wrapper = shallowMount(SessionDetail)
    const handler = websocketMock.handlers.get('replay_batch')!

    handler({
      type: 'replay_batch', session_id: 'ses_1', direction: 'backward',
      events: [
        { type: 'user_text', text: 'older' },
        { type: 'user_text', text: 'newer' },
      ],
    })

    expect((wrapper.vm as any).messages.map((message: any) => message.content)).toEqual(['older', 'newer'])
  })

  test('admits a historical session ID linked inside one correlated replay batch', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    const replay = websocketMock.handlers.get('replay_batch')!

    replay({
      type: 'replay_batch', session_id: 'ses_1', events: [
        { type: 'agent_text', session_id: 'historical-1', event_id: 'historical-before', text: 'before id change' },
        { type: 'session_id_changed', session_id: 'ses_1', old_session_id: 'historical-1', event_id: 'historical-link' },
        { type: 'agent_text', session_id: 'ses_1', event_id: 'historical-after', text: 'after id change' },
      ],
    })

    expect(vm.messages.map((message: any) => message.content)).toEqual(['before id change', 'after id change'])
    expect(vm.messages.some((message: any) => message.type === 'session_id_changed')).toBe(false)
  })

  test('reconsiders a deferred historical event when a later progressive replay batch links it', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    const replay = websocketMock.handlers.get('replay_batch')!

    replay({
      type: 'replay_batch', session_id: 'ses_1', events: [
        { type: 'agent_text', session_id: 'historical-progressive', event_id: 'progressive-before', text: 'progressive before' },
      ],
    })
    expect(vm.messages).toEqual([])

    replay({
      type: 'replay_batch', session_id: 'ses_1', events: [
        { type: 'session_id_changed', session_id: 'ses_1', old_session_id: 'historical-progressive', event_id: 'progressive-link' },
        { type: 'agent_text', session_id: 'ses_1', event_id: 'progressive-after', text: 'progressive after' },
      ],
    })

    expect(vm.messages.map((message: any) => message.content)).toEqual(['progressive before', 'progressive after'])
    expect(vm.messages.filter((message: any) => message.content === 'progressive before')).toHaveLength(1)
  })

  test('prepends a historical alias from a complete backward replay page in source order', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    const replay = websocketMock.handlers.get('replay_batch')!
    const replayEnd = websocketMock.handlers.get('replay_end')!
    vm.processEvent({ type: 'agent_text', session_id: 'ses_1', event_id: 'already-loaded', text: 'already loaded' })
    vm.isLoadingBackward = true

    replay({
      type: 'replay_batch', session_id: 'ses_1', direction: 'backward', events: [
        { type: 'agent_text', session_id: 'historical-page', event_id: 'page-before', text: 'page before' },
        { type: 'session_id_changed', session_id: 'ses_1', old_session_id: 'historical-page', event_id: 'page-link' },
        { type: 'agent_text', session_id: 'ses_1', event_id: 'page-after', text: 'page after' },
      ],
    })
    expect(vm.messages.map((message: any) => message.content)).toEqual(['already loaded'])

    replayEnd({ type: 'replay_end', session_id: 'ses_1', direction: 'backward' })

    expect(vm.messages.map((message: any) => message.content)).toEqual(['page before', 'page after', 'already loaded'])
  })

  test('retains historical session aliases across replay page boundaries', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    const replay = websocketMock.handlers.get('replay_batch')!
    const replayEnd = websocketMock.handlers.get('replay_end')!

    replay({
      type: 'replay_batch', session_id: 'ses_1', events: [
        { type: 'session_id_changed', session_id: 'ses_1', old_session_id: 'historical-previous-page', event_id: 'page-one-link' },
        { type: 'agent_text', session_id: 'ses_1', event_id: 'page-one-current', text: 'current page' },
      ],
    })
    replayEnd({ type: 'replay_end', session_id: 'ses_1', has_more: true })

    vm.isLoadingBackward = true
    replay({
      type: 'replay_batch', session_id: 'ses_1', direction: 'backward', events: [
        { type: 'agent_text', session_id: 'historical-previous-page', event_id: 'page-two-old', text: 'older page' },
      ],
    })
    replayEnd({ type: 'replay_end', session_id: 'ses_1', direction: 'backward', has_more: false })

    expect(vm.messages.map((message: any) => message.content)).toEqual(['older page', 'current page'])
  })

  test('computes transitive replay aliases while rejecting an unrelated foreign ID', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    const replay = websocketMock.handlers.get('replay_batch')!
    const replayEnd = websocketMock.handlers.get('replay_end')!

    replay({
      type: 'replay_batch', session_id: 'ses_1', events: [
        { type: 'agent_text', session_id: 'historical-old-1', event_id: 'transitive-before', text: 'transitive before' },
        { type: 'session_id_changed', session_id: 'historical-old-2', old_session_id: 'historical-old-1', event_id: 'transitive-link-1' },
        { type: 'session_id_changed', session_id: 'ses_1', old_session_id: 'historical-old-2', event_id: 'transitive-link-2' },
        { type: 'agent_text', session_id: 'unrelated-foreign', event_id: 'foreign-replay', text: 'foreign replay' },
        { type: 'agent_text', session_id: 'ses_1', event_id: 'transitive-after', text: 'transitive after' },
      ],
    })
    replayEnd({ type: 'replay_end', session_id: 'ses_1' })

    expect(vm.messages.map((message: any) => message.content)).toEqual(['transitive before', 'transitive after'])
    expect(vm.messages.some((message: any) => message.content === 'foreign replay')).toBe(false)
  })

  test('keeps live delivery strict after replay establishes a historical alias', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    websocketMock.handlers.get('replay_batch')?.({
      type: 'replay_batch', session_id: 'ses_1', events: [
        { type: 'user_text', session_id: 'historical-live-check', event_id: 'trusted-replay', text: 'trusted replay' },
        { type: 'session_id_changed', session_id: 'ses_1', old_session_id: 'historical-live-check', event_id: 'trusted-link' },
      ],
    })

    websocketMock.handlers.get('user_text')?.({ type: 'user_text', session_id: 'historical-live-check', event_id: 'historical-live', text: 'historical live' })
    websocketMock.handlers.get('user_text')?.({ type: 'user_text', session_id: 'foreign-live', event_id: 'foreign-live', text: 'foreign live' })
    websocketMock.handlers.get('user_text')?.({ type: 'user_text', session_id: 'ses_1', event_id: 'current-live', text: 'current live' })

    expect(vm.messages.map((message: any) => message.content)).toEqual(['trusted replay', 'current live'])
  })

  test('resets replay alias trust when the session load key changes', async () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    const replay = websocketMock.handlers.get('replay_batch')!
    const replayEnd = websocketMock.handlers.get('replay_end')!
    replay({
      type: 'replay_batch', session_id: 'ses_1', events: [
        { type: 'user_text', session_id: 'historical-reset', event_id: 'reset-trusted', text: 'session one history' },
        { type: 'session_id_changed', session_id: 'ses_1', old_session_id: 'historical-reset', event_id: 'reset-link' },
      ],
    })
    expect(vm.messages.map((message: any) => message.content)).toEqual(['session one history'])

    routeMock.current.params.id = 'ses_2'
    await wrapper.vm.$nextTick()
    replay({
      type: 'replay_batch', session_id: 'ses_2', events: [
        { type: 'user_text', session_id: 'historical-reset', event_id: 'leaked-alias', text: 'must not leak' },
        { type: 'user_text', session_id: 'ses_2', event_id: 'session-two', text: 'session two history' },
      ],
    })
    replayEnd({ type: 'replay_end', session_id: 'ses_2' })

    expect(vm.messages.map((message: any) => message.content)).toEqual(['session two history'])
  })

  test('keeps unknown events as metadata-bearing rows with their stable event identity', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.processEvent({ type: 'future_signal', event_id: 'future-1', turn_id: 'turn-future', flow_scope: 'unclassified', content_class: 'unknown' })

    expect(vm.messages).toContainEqual(expect.objectContaining({
      id: 'unknown:future-1', type: 'future_signal', turn_id: 'turn-future', flow_scope: 'unclassified', content_class: 'unknown',
    }))
  })

  test('renders agent text only through MessageAgent without the unknown-event fallback', async () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.allSessions = [{ session_id: 'ses_1', daemon_id: 'daemon-1', status: 'running' }]

    vm.processEvent({ type: 'agent_text', session_id: 'ses_1', text: 'single assistant message' })
    await wrapper.vm.$nextTick()

    expect(wrapper.getComponent(MessageAgent).props('content')).toBe('single assistant message')
    expect(wrapper.find('.turn-unknown-event').exists()).toBe(false)
  })

  test('deduplicates seq-only unknown replay copies without merging a distinct reused sequence', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    const live = { type: 'future_seq_signal', session_id: 'ses_1', seq: 41, text: 'first generation' }
    const replayCopy = { type: 'future_seq_signal', session_id: 'ses_1', payload: { seq: '41', text: 'first generation' } }
    const restarted = { type: 'future_seq_signal', session_id: 'ses_1', seq: 41, text: 'second generation' }

    vm.processEvent(live)
    vm.processEvent(replayCopy)
    vm.processEvent(restarted)

    expect(vm.messages.filter((message: any) => message.type === 'future_seq_signal')).toHaveLength(2)
    expect(vm.messages.map((message: any) => message.content)).toEqual(['first generation', 'second generation'])
  })

  test('renders session-filtered live lifecycle and unknown events exactly once', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    websocketMock.handlers.get('turn_status')?.({ type: 'turn_status', session_id: 'ses_1', event_id: 'live-turn', turn_id: 'turn-live', turn_status: 'interrupted' })
    const duplicateUnknown = { type: 'future_live', session_id: 'ses_1', event_id: 'live-unknown', turn_id: 'turn-live' }
    for (const handler of websocketMock.allHandlers) handler(duplicateUnknown)
    for (const handler of websocketMock.allHandlers) handler(duplicateUnknown)
    for (const handler of websocketMock.allHandlers) handler({ type: 'future_live', session_id: 'other-session', event_id: 'other-unknown', turn_id: 'turn-other', flow_scope: 'unclassified', content_class: 'unknown' })

    expect(vm.messages.filter((message: any) => message.type === 'turn_status')).toHaveLength(1)
    expect(vm.messages.filter((message: any) => message.id === 'unknown:live-unknown')).toHaveLength(1)
    expect(vm.messages.some((message: any) => message.id === 'unknown:other-unknown')).toBe(false)
  })

  test('keeps a lifecycle-only Turn header free of phantom auxiliary controls', async () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.allSessions = [{ session_id: 'ses_1', daemon_id: 'daemon-1', status: 'running' }]
    vm.processEvent({ type: 'turn_status', session_id: 'ses_1', event_id: 'terminal-only', turn_id: 'turn-terminal', turn_status: 'completed' })
    await wrapper.vm.$nextTick()

    expect(vm.turnRows[0]).toMatchObject({ turnId: 'turn-terminal', status: 'completed', auxiliary: [] })
    expect(wrapper.find('.turn-group-header').exists()).toBe(true)
    expect(wrapper.find('.turn-group-aux-toggle').exists()).toBe(false)
    expect(wrapper.find('.turn-unknown-event').exists()).toBe(false)
  })

  test('preserves metadata on authoritative user echoes and early agent-text paths', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.messages.push({ id: 'optimistic', type: 'user_text', role: 'user', content: 'prompt', __msg_id: 'm1' })
    vm.processEvent({ type: 'user_text', text: 'prompt', turn_id: 'turn-user', flow_scope: 'main' })
    vm.processEvent({ type: 'agent_text', text: 'answer', stream_id: 'stream-early', chunk_seq: 0, byte_offset: 0, streaming: true, turn_id: 'turn-stream' })
    vm.processEvent({ type: 'agent_text', text: '', stream_id: 'stream-early', chunk_seq: 1, byte_offset: 6, final: true, turn_id: 'turn-stream-final', content_class: 'dialogue' })
    vm.processEvent({ type: 'agent_text', text: 'duplicate', turn_id: 'turn-first' })
    vm.processEvent({ type: 'agent_text', text: 'duplicate', turn_id: 'turn-duplicate', flow_scope: 'main' })

    expect(vm.messages.find((message: any) => message.id === 'optimistic')).toMatchObject({ turn_id: 'turn-user', flow_scope: 'main' })
    expect(vm.messages.find((message: any) => message.streamId === 'stream-early')).toMatchObject({ turn_id: 'turn-stream-final', content_class: 'dialogue', streaming: false })
    expect(vm.messages.filter((message: any) => message.content === 'duplicate')).toHaveLength(1)
    expect(vm.messages.find((message: any) => message.content === 'duplicate')).toMatchObject({ turn_id: 'turn-duplicate', flow_scope: 'main' })
  })

  test('applies buffered resolution metadata when each request arrives later', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.processEvent({ type: 'approval_resolved', request_id: 'later-approval', action: 'once', turn_id: 'turn-approval-resolution' })
    vm.processEvent({ type: 'question_resolved', request_id: 'later-question', answers: ['yes'], turn_id: 'turn-question-resolution' })
    vm.processEvent({ type: 'mcp_elicitation_resolved', request_id: 'later-mcp', action: 'accept', turn_id: 'turn-mcp-resolution' })
    vm.processEvent({ type: 'approval_request', request_id: 'later-approval', tool: 'bash', agent_id: 'sub-1', turn_id: 'turn-approval-request' })
    vm.processEvent({ type: 'question_request', request_id: 'later-question', questions: [{ question: 'Continue?' }], agent_id: 'sub-1', turn_id: 'turn-question-request' })
    vm.processEvent({ type: 'mcp_elicitation_request', request_id: 'later-mcp', agent_id: 'sub-1', turn_id: 'turn-mcp-request' })

    const child = vm.subagentMessages['sub-1']
    expect(child.find((message: any) => message.request_id === 'later-approval')).toMatchObject({ status: 'resolved', turn_id: 'turn-approval-resolution' })
    expect(child.find((message: any) => message.request_id === 'later-question')).toMatchObject({ status: 'resolved', turn_id: 'turn-question-resolution' })
    expect(child.find((message: any) => message.request_id === 'later-mcp')).toMatchObject({ status: 'resolved', turn_id: 'turn-mcp-resolution' })
  })

  test('merges tool-result metadata for direct and deferred results', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.processEvent({ type: 'tool_call', call_id: 'direct', tool: 'Read', input: {} })
    vm.processEvent({ type: 'tool_result', call_id: 'direct', output: 'ok', turn_id: 'turn-direct', flow_scope: 'auxiliary', content_class: 'execution' })
    vm.processEvent({ type: 'tool_result', call_id: 'deferred', output: 'later', turn_id: 'turn-deferred', flow_scope: 'auxiliary', content_class: 'execution' })
    vm.processEvent({ type: 'tool_call', call_id: 'deferred', tool: 'Read', input: {} })
    vm.processEvent({ type: 'tool_call', call_id: 'metadata-only', tool: 'Read', input: {} })
    vm.processEvent({ type: 'tool_result', call_id: 'metadata-only', turn_id: 'turn-metadata-only', flow_scope: 'auxiliary', content_class: 'execution' })

    expect(vm.messages.find((message: any) => message.call_id === 'direct')).toMatchObject({ turn_id: 'turn-direct', output: 'ok' })
    expect(vm.messages.find((message: any) => message.call_id === 'deferred')).toMatchObject({ turn_id: 'turn-deferred', output: 'later' })
    expect(vm.messages.find((message: any) => message.call_id === 'metadata-only')).toMatchObject({ turn_id: 'turn-metadata-only', content_class: 'execution' })
  })

  test('merges late revision metadata after its deferred predecessor arrives', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.processEvent({ type: 'agent_text', text: 'one', snapshot: 'one', part_id: 'part-late', revision: 1, event_id: 'part-a', turn_id: 'turn-a' })
    vm.processEvent({ type: 'agent_text', text: 'three', snapshot: 'one two three', part_id: 'part-late', revision: 3, event_id: 'part-c', previous_event_id: 'part-b', turn_id: 'turn-c' })
    vm.processEvent({ type: 'agent_text', text: 'two', snapshot: 'one two', part_id: 'part-late', revision: 2, event_id: 'part-b', previous_event_id: 'part-a', turn_id: 'turn-b' })

    expect(vm.messages.find((message: any) => message.partId === 'part-late')).toMatchObject({ content: 'one two three', turn_id: 'turn-c' })
  })

  test('copies resolution metadata to the visible canonical request when routed target differs', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.processEvent({ type: 'approval_request', request_id: 'cross-target', tool: 'bash', turn_id: 'turn-request' })
    vm.processEvent({ type: 'approval_resolved', request_id: 'cross-target', agent_id: 'sub-1', action: 'once', turn_id: 'turn-resolution', flow_scope: 'main' })

    expect(vm.messages.find((message: any) => message.request_id === 'cross-target')).toMatchObject({ status: 'resolved', turn_id: 'turn-resolution', flow_scope: 'main' })
  })

  test('preserves question and MCP resolution metadata across routed canonical rows', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.processEvent({ type: 'question_request', request_id: 'question-cross', questions: [{ question: 'Continue?' }], turn_id: 'turn-question' })
    vm.processEvent({ type: 'mcp_elicitation_request', request_id: 'mcp-cross', turn_id: 'turn-mcp' })
    vm.processEvent({ type: 'question_resolved', request_id: 'question-cross', agent_id: 'sub-1', answers: ['yes'], turn_id: 'turn-question-resolved' })
    vm.processEvent({ type: 'mcp_elicitation_resolved', request_id: 'mcp-cross', agent_id: 'sub-1', action: 'accept', turn_id: 'turn-mcp-resolved' })

    expect(vm.messages.find((message: any) => message.request_id === 'question-cross')).toMatchObject({ status: 'resolved', turn_id: 'turn-question-resolved' })
    expect(vm.messages.find((message: any) => message.request_id === 'mcp-cross')).toMatchObject({ status: 'resolved', turn_id: 'turn-mcp-resolved' })
  })

  test('attaches file-change metadata to the exact changed card when multiple same-turn cards exist', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    const card = (id: string, eventId: string, changeSetId: string, path: string) => ({
      id, type: 'agent_file_change', role: 'agent', fileChange: {
        turnId: 'turn-files', additions: 1, deletions: 0, selectedPath: path,
        files: [{ path, kind: 'update', additions: 1, deletions: 0, edits: [{ id: eventId, eventId, changeSetId, changeIndex: 0, sequence: 1, diff: '+x', additions: 1, deletions: 0, integrity: 'complete' }] }],
      },
    })
    vm.messages.push(card('card-a', 'file-a', 'set-a', 'a.txt'), card('card-b', 'file-b', 'set-b', 'b.txt'))
    vm.processEvent({ type: 'agent_file_change', session_id: 'ses_1', turn_id: 'turn-files', event_id: 'file-b', change_set_id: 'set-b', change_index: 0, change_total: 1, path: 'b.txt', change_kind: 'update', diff: '+x', additions: 1, deletions: 0, status: 'completed', flow_scope: 'auxiliary', content_class: 'execution' })

    const [first, second] = vm.messages
    expect(first.turn_id).toBeUndefined()
    expect(first.content_class).toBeUndefined()
    expect(second).toMatchObject({ turn_id: 'turn-files', content_class: 'execution' })
  })

  test('routes root and focused-subagent same/new Turn metadata without crossing buckets', async () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.processEvent({ type: 'user_text', text: 'root prompt', turn_id: 'turn-root', flow_scope: 'main' })
    vm.processEvent({ type: 'agent_text', text: 'root reply', turn_id: 'turn-root', flow_scope: 'main' })
    vm.processEvent({ type: 'agent_text', text: 'child same turn', agent_id: 'sub-1', turn_id: 'turn-root', flow_scope: 'main' })
    vm.processEvent({ type: 'agent_text', text: 'child next turn', agent_id: 'sub-1', turn_id: 'turn-child-next', flow_scope: 'main' })

    expect(vm.turnRows).toHaveLength(1)
    expect(vm.turnRows[0].messages.map((message: any) => message.content)).toEqual(['root prompt', 'root reply'])
    expect(vm.subagentMessages['sub-1'].map((message: any) => message.turn_id)).toEqual(['turn-root', 'turn-child-next'])

    routeMock.current.query.subagent = 'sub-1'
    await wrapper.vm.$nextTick()
    vm.processEvent({ type: 'agent_text', text: 'focused child', agent_id: 'sub-1', turn_id: 'turn-focused', flow_scope: 'main' })
    expect(vm.subagentMessages['sub-1'][0]).toMatchObject({ content: 'focused child', turn_id: 'turn-focused' })
    expect(vm.messages).toEqual([])
  })

  test('aggregates one turn across replay pages without reordering its addendum', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    const replay = websocketMock.handlers.get('replay_batch')!
    replay({ type: 'replay_batch', session_id: 'ses_1', events: [
      { type: 'user_text', text: 'prompt', turn_id: 'turn-page', flow_scope: 'main' },
      { type: 'user_text', text: 'addendum', turn_id: 'turn-page', flow_scope: 'main' },
    ] })
    replay({ type: 'replay_batch', session_id: 'ses_1', events: [
      { type: 'agent_text', text: 'reply', turn_id: 'turn-page', flow_scope: 'main' },
    ] })

    expect(vm.turnRows).toHaveLength(1)
    expect(vm.turnRows[0].messages.map((message: any) => message.content)).toEqual(['prompt', 'addendum', 'reply'])
  })

  test('preserves turn metadata across parts, interaction, file cards, and lifecycle without changing session status', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    const metadata = {
      turn_id: 'turn-meta', source_turn_id: 'source-meta', turn_origin: 'request', turn_confidence: 'derived',
      actor_scope: 'root', flow_scope: 'main', content_class: 'dialogue', classifier_version: 'v1',
    }
    vm.processEvent({ type: 'agent_text', text: 'reply', part_id: 'part-meta', revision: 1, ...metadata })
    vm.processEvent({ type: 'approval_request', request_id: 'approval-meta', tool: 'bash', ...metadata })
    vm.processEvent({
      ...metadata, type: 'agent_file_change', session_id: 'ses_1', event_id: 'file-meta', change_set_id: 'set-meta',
      change_index: 0, change_total: 1, path: 'meta.txt', change_kind: 'update', diff: '+meta', additions: 1, deletions: 0,
      flow_scope: 'auxiliary', content_class: 'execution',
    })
    vm.processEvent({ ...metadata, type: 'turn_status', turn_status: 'interrupted' })

    expect(vm.status).toBe('running')
    expect(vm.messages.find((message: any) => message.partId === 'part-meta')).toMatchObject(metadata)
    expect(vm.messages.find((message: any) => message.request_id === 'approval-meta')).toMatchObject(metadata)
    expect(vm.messages.find((message: any) => message.type === 'agent_file_change')).toMatchObject({ turn_id: 'turn-meta', content_class: 'execution' })
    expect(vm.turnRows[0]).toMatchObject({ turnId: 'turn-meta', interrupted: true })
  })

  test('marks an unresolved replayed tool unknown after idle replay completion', () => {
    const wrapper = shallowMount(SessionDetail)
    const batch = websocketMock.handlers.get('replay_batch')!
    const end = websocketMock.handlers.get('replay_end')!
    const vm = wrapper.vm as any

    batch({
      type: 'replay_batch', session_id: 'ses_1',
      events: [{ type: 'tool_call', call_id: 'missing-result', tool: 'wait', input: '{}' }],
    })
    vm.processEvent({ type: 'session_status', status: 'idle' })
    end({ type: 'replay_end', session_id: 'ses_1' })

    expect(vm.messages.find((message: any) => message.call_id === 'missing-result')).toMatchObject({
      status: 'unknown',
    })

    vm.processEvent({ type: 'tool_result', call_id: 'missing-result', output: 'received later' })

    expect(vm.messages.find((message: any) => message.call_id === 'missing-result')).toMatchObject({
      status: 'completed', output: 'received later',
    })
  })

  test.each(['codex', 'claude-code'])(
    'keeps a stale-running %s session running at replay end while work is unresolved',
    (agentType) => {
      const wrapper = shallowMount(SessionDetail)
      const vm = wrapper.vm as any
      const batch = websocketMock.handlers.get('replay_batch')!
      const end = websocketMock.handlers.get('replay_end')!

      websocketMock.handlers.get('session_list')?.({
        type: 'session_list',
        sessions: [{
          session_id: 'ses_1', daemon_id: 'daemon-1', agent_type: agentType, status: 'running',
          created_at: '2000-01-01T00:00:00.000Z', last_activity_at: '2000-01-01T00:00:00.000Z',
          children: [{ agentId: 'child-running', status: 'running' }],
        }],
      })
      batch({
        type: 'replay_batch', session_id: 'ses_1', events: [
          { type: 'tool_call', session_id: 'ses_1', call_id: 'still-running', tool: 'wait', input: '{}' },
          {
            type: 'turn_status', session_id: 'ses_1', agent_id: 'child-running',
            turn_id: 'turn-child-running', turn_status: 'running',
          },
        ],
      })

      end({ type: 'replay_end', session_id: 'ses_1' })

      expect(vm.status).toBe('running')
      expect(vm.messages.find((message: any) => message.call_id === 'still-running')).toMatchObject({ status: 'running' })
      expect(vm.subagentMessages['child-running']).toContainEqual(expect.objectContaining({
        type: 'turn_status', turn_id: 'turn-child-running', turn_status: 'running',
      }))
      wrapper.unmount()
    },
  )

  test('consumes the shared OpenCode release contract with request and Part deduplication', () => {
    const contract = JSON.parse(readFileSync(resolve(process.cwd(), '../internal/e2e/testdata/opencode_release_gate.json'), 'utf8')) as {
      session_id: string
      cases: Array<{ id: string; payload: Record<string, any>; web_type: string; status: string; dedup_key: string }>
    }
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any

    const ensureRequest = (payload: Record<string, any>) => {
      const requestId = payload.request_id
      if (payload.type === 'approval_resolved' && !vm.messages.some((message: any) => message.type === 'approval_request' && message.request_id === requestId)) {
        vm.processEvent({ type: 'approval_request', request_id: requestId, tool: 'bash' })
      }
      if (payload.type === 'question_resolved' && !vm.messages.some((message: any) => message.type === 'question_request' && message.request_id === requestId)) {
        vm.processEvent({ type: 'question_request', request_id: requestId, questions: [{ question: 'seed?' }] })
      }
    }

    for (const item of contract.cases) {
      const payload: Record<string, any> = { ...item.payload, session_id: contract.session_id, event_id: `opencode:release:${item.id}` }
      if (payload.type === 'session_agent_changed') {
        websocketMock.handlers.get('session_agent_changed')?.({ ...payload, session_id: 'ses_1' })
        expect(vm.currentOpenCodeAgent, item.id).toBe(item.status)
        expect(item.dedup_key, item.id).toBe(`agent:${payload.current_agent}`)
        continue
      }
      if (payload.type === 'replay_batch') {
        const replay = { ...payload, session_id: 'ses_1' }
        websocketMock.handlers.get('replay_batch')?.(replay)
        websocketMock.handlers.get('replay_batch')?.(replay)
        const replayPart = payload.events[0]
        expect(vm.messages.filter((message: any) => message.partId === replayPart.part_id), item.id).toHaveLength(1)
        expect(item.web_type, item.id).toBe(replayPart.type)
        expect(item.dedup_key, item.id).toBe(`part:${replayPart.part_id}`)
        continue
      }
      ensureRequest(payload)
      if (item.id === 'OC-306') {
        vm.processEvent({ type: 'approval_request', request_id: payload.related_request_id, permission_name: 'edit' })
      }
      vm.processEvent(payload)

      if (payload.type === 'approval_request' || payload.type === 'question_request') {
        vm.processEvent(payload)
        const matches = vm.messages.filter((message: any) => message.type === payload.type && message.request_id === payload.request_id)
        expect(matches, item.id).toHaveLength(1)
        expect(matches[0], item.id).toMatchObject({ type: item.web_type, status: item.status })
        expect(item.dedup_key, item.id).toBe(`request:${payload.request_id}`)
        if (item.id === 'OC-306') {
          const concurrent = vm.messages.filter((message: any) => message.type === 'approval_request' && [payload.request_id, payload.related_request_id].includes(message.request_id))
          expect(concurrent, item.id).toHaveLength(2)
          expect(concurrent.every((message: any) => message.status === 'pending'), item.id).toBe(true)
        }
      } else if (payload.type === 'approval_resolved') {
        expect(vm.messages.find((message: any) => message.type === item.web_type && message.request_id === payload.request_id), item.id).toMatchObject({ status: item.status, action: payload.action })
        expect(item.dedup_key, item.id).toBe(`request:${payload.request_id}`)
      } else if (payload.type === 'question_resolved') {
        expect(vm.messages.find((message: any) => message.type === item.web_type && message.request_id === payload.request_id), item.id).toMatchObject({ status: item.status, rejected: !!payload.rejected })
        expect(item.dedup_key, item.id).toBe(`request:${payload.request_id}`)
      } else if (payload.part_id) {
        vm.processEvent(payload)
        const matches = vm.messages.filter((message: any) => (message.partId || message.part_id) === payload.part_id)
        expect(matches, item.id).toHaveLength(1)
        expect(matches[0].type, item.id).toBe(item.web_type)
        expect(item.dedup_key, item.id).toBe(`part:${payload.part_id}`)
      } else if (payload.type === 'command_receipt') {
        expect(vm.messages.find((message: any) => message.type === item.web_type && message.command === payload.command), item.id).toMatchObject({ receiptStatus: item.status })
        expect(item.dedup_key, item.id).toBe(`command:${payload.command}`)
      } else if (payload.type === 'session_status') {
        expect(vm.status, item.id).toBe(item.status)
        expect(item.dedup_key, item.id).toBe(`status:${contract.session_id}:${payload.status}`)
      }
    }
  })

  test('passes causal snapshots for text/reasoning and upserts a mutated tool call', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any

    vm.processEvent({ type: 'agent_text', text: 'B', snapshot: 'B', part_id: 'text', revision: 9, event_id: 'text-B' })
    vm.processEvent({ type: 'agent_text', text: 'C', snapshot: 'BC', part_id: 'text', revision: 1, event_id: 'text-C', previous_event_id: 'text-B' })
    vm.processEvent({ type: 'agent_reasoning', text: 'x', snapshot: 'x', part_id: 'reason', revision: 8, event_id: 'reason-x' })
    vm.processEvent({ type: 'agent_reasoning', text: 'y', snapshot: 'xy', part_id: 'reason', revision: 1, event_id: 'reason-y', previous_event_id: 'reason-x' })

    vm.processEvent({ type: 'tool_call', call_id: 'call_1', tool: 'Read', input: { path: 'a' } })
    vm.processEvent({ type: 'tool_call', call_id: 'call_1', tool: 'Read', input: { path: 'b' } })
    vm.processEvent({ type: 'tool_result', call_id: 'call_1', output: 'done' })

    expect(vm.messages.find((message: any) => message.partId === 'text')).toMatchObject({ content: 'BC', eventId: 'text-C' })
    expect(vm.messages.find((message: any) => message.partId === 'reason')).toMatchObject({ content: 'xy', eventId: 'reason-y' })
    const tools = vm.messages.filter((message: any) => message.type === 'tool_call' && message.call_id === 'call_1')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ input: { path: 'b' }, output: 'done', status: 'completed' })
  })

  test('assembles duplicate and out-of-order tool output chunks before final completion', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any

    vm.processEvent({ type: 'tool_call', call_id: 'call_stream', tool: 'Bash', input: { cmd: 'printf ABC' } })
    vm.processEvent({
      type: 'tool_result', call_id: 'call_stream', stream_id: 'stream-1',
      chunk_seq: 0, byte_offset: 0, streaming: true, final: false, output: 'A',
    })

    let tool = vm.messages.find((message: any) => message.call_id === 'call_stream')
    expect(tool).toMatchObject({ output: 'A', status: 'running' })

    vm.processEvent({
      type: 'tool_result', call_id: 'call_stream', stream_id: 'stream-1',
      chunk_seq: 2, byte_offset: 2, streaming: true, final: true,
      total_bytes: 3, output: 'C',
    })
    vm.processEvent({
      type: 'tool_result', call_id: 'call_stream', stream_id: 'stream-1',
      chunk_seq: 0, byte_offset: 0, streaming: true, final: false, output: 'A',
    })

    tool = vm.messages.find((message: any) => message.call_id === 'call_stream')
    expect(tool).toMatchObject({ output: 'A', status: 'running' })

    vm.processEvent({
      type: 'tool_result', call_id: 'call_stream', stream_id: 'stream-1',
      chunk_seq: 1, byte_offset: 1, streaming: true, final: false, output: 'B',
    })

    tool = vm.messages.find((message: any) => message.call_id === 'call_stream')
    expect(tool).toMatchObject({ output: 'ABC', status: 'completed' })

    vm.processEvent({
      type: 'tool_result', call_id: 'call_stream', stream_id: 'stream-1',
      chunk_seq: 2, byte_offset: 2, streaming: true, final: true,
      total_bytes: 3, output: 'C',
    })
    expect(tool).toMatchObject({ output: 'ABC', status: 'completed' })
  })

  test('appends only contiguous agent text chunks and completes after a buffered final chunk', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any

    vm.processEvent({
      type: 'agent_text', stream_id: 'text-stream', chunk_seq: 0,
      byte_offset: 0, streaming: true, final: false, text: 'A',
    })
    vm.processEvent({
      type: 'agent_text', stream_id: 'text-stream', chunk_seq: 2,
      byte_offset: 2, streaming: true, final: true, total_bytes: 3, text: 'C',
    })
    vm.processEvent({
      type: 'agent_text', stream_id: 'text-stream', chunk_seq: 0,
      byte_offset: 0, streaming: true, final: false, text: 'A',
    })
    vm.processEvent({
      type: 'agent_text', stream_id: 'text-stream', chunk_seq: 1,
      byte_offset: 1, streaming: true, final: false, text: 'B',
    })

    const textMessages = vm.messages.filter((message: any) => message.type === 'agent_text')
    expect(textMessages).toHaveLength(1)
    expect(textMessages[0]).toMatchObject({ content: 'ABC', streaming: false })
  })

  test('keeps one agent text message when another event is interleaved between chunks', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any

    vm.processEvent({
      type: 'agent_text', stream_id: 'interleaved-text', chunk_seq: 0,
      byte_offset: 0, streaming: true, final: false, text: 'A',
    })
    vm.processEvent({
      type: 'tool_call', call_id: 'interleaved-tool', tool: 'Bash',
      input: { cmd: 'true' },
    })
    vm.processEvent({
      type: 'agent_text', stream_id: 'interleaved-text', chunk_seq: 1,
      byte_offset: 1, streaming: true, final: true, total_bytes: 2, text: 'B',
    })

    const textMessages = vm.messages.filter((message: any) => message.type === 'agent_text')
    expect(textMessages).toHaveLength(1)
    expect(textMessages[0]).toMatchObject({ content: 'AB', streaming: false })
  })

  test('completes agent text from an empty final marker without duplicating content', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any

    vm.processEvent({
      type: 'agent_text', stream_id: 'text-final-marker', chunk_seq: 0,
      byte_offset: 0, streaming: true, final: false, text: 'answer',
    })
    vm.processEvent({
      type: 'agent_text', stream_id: 'text-final-marker', chunk_seq: 1,
      byte_offset: 6, streaming: true, final: true, total_bytes: 6, text: '',
    })

    const textMessages = vm.messages.filter((message: any) => message.type === 'agent_text')
    expect(textMessages).toHaveLength(1)
    expect(textMessages[0]).toMatchObject({ content: 'answer', streaming: false })
  })

  test('assembles reasoning chunks into one message without rendering buffered gaps', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any

    for (const event of [
      { chunk_seq: 0, byte_offset: 0, final: false, text: 'A' },
      { chunk_seq: 2, byte_offset: 2, final: true, text: 'C' },
      { chunk_seq: 0, byte_offset: 0, final: false, text: 'A' },
      { chunk_seq: 1, byte_offset: 1, final: false, text: 'B' },
    ]) {
      vm.processEvent({
        type: 'agent_reasoning', stream_id: 'reason-stream', streaming: true,
        total_bytes: event.final ? 3 : undefined,
        ...event,
      })
    }

    const reasoning = vm.messages.filter((message: any) => message.type === 'agent_reasoning')
    expect(reasoning).toHaveLength(1)
    expect(reasoning[0]).toMatchObject({ content: 'ABC', streaming: false })
  })

  test('durable assistant error is identical for live and replay paths', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    const event = { type: 'error', session_id: 'ses_1', message_id: 'm1', event_id: 'opencode:error:m1:abcdef0123456789', error: 'Provider authentication failed' }

    vm.processEvent(event)
    vm.processEvent({ type: 'replay_batch', session_id: 'ses_1', events: [event] })

    const errors = vm.messages.filter((message: any) => message.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ content: event.error, eventKey: event.event_id })
  })

  test('preserves Codex approval decisions and redacted user-input metadata', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.processEvent({
      type: 'approval_request', request_id: 'codex:1:a', approval_kind: 'commandExecution',
      available_decisions: ['accept', 'cancel'], command: 'rm a', cwd: '/repo', description: 'needs write',
    })
    expect(vm.messages.find((message: any) => message.request_id === 'codex:1:a')).toMatchObject({
      status: 'pending', approvalKind: 'commandExecution', availableDecisions: ['accept', 'cancel'], inputDesc: 'rm a', cwd: '/repo',
    })

    vm.processEvent({
      type: 'question_request', request_id: 'codex:1:q', auto_resolution_ms: 60000,
      questions: [{ id: 'token', question: 'Token?', custom: true, secret: true }],
    })
    vm.processEvent({ type: 'question_resolved', request_id: 'codex:1:q', redacted: true })
    expect(vm.messages.find((message: any) => message.request_id === 'codex:1:q')).toMatchObject({
      status: 'resolved', autoResolutionMs: 60000, redacted: true, answers: [],
    })
  })

  test('projects MCP elicitation requests and redacted resolutions', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm: any = wrapper.vm
    vm.processEvent({
      type: 'mcp_elicitation_request', request_id: 'mcp_1', mcp_server: 'github',
      elicitation_mode: 'form', message: 'Configure',
      elicitation_schema: { type: 'object', properties: { repo: { type: 'string' } } },
    })
    expect(vm.messages.find((message: any) => message.request_id === 'mcp_1')).toMatchObject({
      type: 'mcp_elicitation_request', status: 'pending', mcpServer: 'github', elicitationMode: 'form', message: 'Configure',
    })
    vm.processEvent({ type: 'mcp_elicitation_resolved', request_id: 'mcp_1', action: 'accept', redacted: true })
    expect(vm.messages.find((message: any) => message.request_id === 'mcp_1')).toMatchObject({ status: 'resolved', action: 'accept', redacted: true })
  })

  test.each(['live', 'replay'] as const)(
    'routes %s interaction_result to the canonical root/child owner before or after every request kind',
    async (delivery) => {
      const wrapper = shallowMount(SessionDetail)
      const vm = wrapper.vm as any
      const replay = websocketMock.handlers.get('replay_batch')!
      const deliver = (event: Record<string, any>) => {
        if (delivery === 'replay') replay({ type: 'replay_batch', session_id: 'ses_1', events: [event] })
        else websocketMock.handlers.get(event.type)?.(event)
      }
      const kinds = [
        { type: 'approval_request', operation: 'approval_response', fields: { tool: 'Read' } },
        { type: 'question_request', operation: 'question_response', fields: { questions: [{ question: 'Continue?' }] } },
        { type: 'mcp_elicitation_request', operation: 'mcp_elicitation_response', fields: { elicitation_mode: 'form' } },
      ]

      for (const owner of ['root', 'child'] as const) {
        for (const order of ['request-first', 'terminal-first'] as const) {
          for (const kind of kinds) {
            const requestId = `${delivery}-${owner}-${order}-${kind.type}`
            const request = {
              type: kind.type, session_id: 'ses_1', request_id: requestId,
              ...(owner === 'child' ? { agent_id: 'owner-child' } : {}), ...kind.fields,
            }
            const terminal = {
              type: 'interaction_result', session_id: 'ses_1', request_id: requestId,
              agent_id: owner === 'root' ? 'foreign-emitter' : 'different-child-emitter',
              operation: kind.operation, status: 'resolved_elsewhere', turn_id: `terminal-${requestId}`,
            }
            for (const event of order === 'request-first' ? [request, terminal] : [terminal, request]) deliver(event)
          }
        }
      }
      await wrapper.vm.$nextTick()

      const root = vm.messages as any[]
      const children = Object.values(vm.subagentMessages as Record<string, any[]>).flat() as any[]
      const all = [...root, ...children]
      for (const owner of ['root', 'child'] as const) {
        for (const order of ['request-first', 'terminal-first'] as const) {
          for (const kind of kinds) {
            const requestId = `${delivery}-${owner}-${order}-${kind.type}`
            const cards = all.filter(message => message.request_id === requestId)
            expect(cards, requestId).toHaveLength(1)
            expect(cards[0]).toMatchObject({ type: kind.type, status: 'resolved', turn_id: `terminal-${requestId}` })
            expect(root.some(message => message.request_id === requestId)).toBe(owner === 'root')
            expect(children.some(message => message.request_id === requestId)).toBe(owner === 'child')
          }
        }
      }
      expect(all.some(message => message.type === 'interaction_result')).toBe(false)
      wrapper.unmount()
    },
  )

  test.each(['live', 'replay'] as const)(
    'migrates a resolved child request to a later canonical root owner for %s delivery',
    async (delivery) => {
      const wrapper = shallowMount(SessionDetail)
      const vm = wrapper.vm as any
      const deliver = (event: Record<string, any>) => {
        if (delivery === 'replay') websocketMock.handlers.get('replay_batch')?.({ type: 'replay_batch', session_id: 'ses_1', events: [event] })
        else websocketMock.handlers.get(event.type)?.(event)
      }
      const requestId = `owner-migration-${delivery}`
      deliver({ type: 'question_request', session_id: 'ses_1', agent_id: 'child-owner', request_id: requestId, questions: [{ question: 'child?' }] })
      deliver({ type: 'interaction_result', session_id: 'ses_1', request_id: requestId, operation: 'question_response', status: 'resolved_elsewhere', turn_id: 'terminal-owner' })
      deliver({ type: 'question_request', session_id: 'ses_1', request_id: requestId, questions: [{ question: 'root canonical?' }] })
      await wrapper.vm.$nextTick()

      expect(vm.messages.filter((message: any) => message.request_id === requestId)).toHaveLength(1)
      expect(vm.messages.find((message: any) => message.request_id === requestId)).toMatchObject({ status: 'resolved', turn_id: 'terminal-owner' })
      expect(Object.values(vm.subagentMessages as Record<string, any[]>).flat().some((message: any) => message.request_id === requestId)).toBe(false)
      wrapper.unmount()
    },
  )

  test.each(['live', 'replay'] as const)(
    'merges %s presentation metadata before duplicate reducer early returns without replacing canonical payloads',
    async (delivery) => {
      const wrapper = shallowMount(SessionDetail)
      const vm = wrapper.vm as any
      const deliver = (event: Record<string, any>) => {
        if (delivery === 'replay') websocketMock.handlers.get('replay_batch')?.({ type: 'replay_batch', session_id: 'ses_1', events: [event] })
        else websocketMock.handlers.get(event.type)?.({ session_id: 'ses_1', ...event })
      }

      deliver({ type: 'agent_reasoning', text: 'canonical reasoning', turn_id: 'reason-old' })
      deliver({ type: 'agent_reasoning', text: 'canonical reasoning', turn_id: 'reason-late', content_class: 'execution' })
      deliver({ type: 'agent_retry', part_id: 'retry-meta', attempt: 1, error: 'canonical retry', turn_id: 'retry-old' })
      deliver({ type: 'agent_retry', part_id: 'retry-meta', attempt: 9, error: 'must not replace', turn_id: 'retry-late', actor_scope: 'root' })
      deliver({ type: 'agent_compaction', part_id: 'compact-meta', auto: false, overflow: false, turn_id: 'compact-old' })
      deliver({ type: 'agent_compaction', part_id: 'compact-meta', auto: true, overflow: true, turn_id: 'compact-late', classifier_version: 'v2' })
      deliver({ type: 'interactive_prompt', request_id: 'prompt-meta', input: { prompt: 'canonical prompt', options: [{ index: '1', label: 'yes' }] }, turn_id: 'prompt-old' })
      deliver({ type: 'interactive_prompt', request_id: 'prompt-meta', input: { prompt: 'must not replace', options: [] }, turn_id: 'prompt-late', flow_scope: 'main' })
      deliver({ type: 'error', event_id: 'error-meta', error: 'canonical error', turn_id: 'error-old' })
      deliver({ type: 'error', event_id: 'error-meta', error: 'must not replace', turn_id: 'error-late', content_class: 'dialogue' })

      await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)))
      await wrapper.vm.$nextTick()
      expect(vm.messages.filter((message: any) => message.type === 'agent_reasoning')).toHaveLength(1)
      expect(vm.messages.find((message: any) => message.type === 'agent_reasoning')).toMatchObject({ content: 'canonical reasoning', turn_id: 'reason-late', content_class: 'execution' })
      expect(vm.messages.find((message: any) => message.partId === 'retry-meta')).toMatchObject({ attempt: 1, error: 'canonical retry', turn_id: 'retry-late', actor_scope: 'root' })
      expect(vm.messages.find((message: any) => message.partId === 'compact-meta')).toMatchObject({ auto: false, overflow: false, turn_id: 'compact-late', classifier_version: 'v2' })
      expect(vm.messages.find((message: any) => message.request_id === 'prompt-meta')).toMatchObject({ prompt: 'canonical prompt', options: [{ index: '1', label: 'yes' }], turn_id: 'prompt-late', flow_scope: 'main' })
      expect(vm.messages.filter((message: any) => message.eventKey === 'error-meta')).toHaveLength(1)
      expect(vm.messages.find((message: any) => message.eventKey === 'error-meta')).toMatchObject({ content: 'canonical error', turn_id: 'error-late', content_class: 'dialogue' })
      wrapper.unmount()
    },
  )

  test('keeps known controls out of the timeline while retaining genuinely unknown live and replay events', () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    const known = { type: 'session_discovered', session_id: 'ses_1', event_id: 'known-control' }
    for (const handler of websocketMock.allHandlers) handler(known)
    websocketMock.handlers.get('replay_batch')?.({ type: 'replay_batch', session_id: 'ses_1', events: [known] })

    const unknown = { type: 'future_control_like_event', session_id: 'ses_1', event_id: 'genuine-unknown', text: 'keep me' }
    for (const handler of websocketMock.allHandlers) handler(unknown)
    websocketMock.handlers.get('replay_batch')?.({ type: 'replay_batch', session_id: 'ses_1', events: [unknown] })
    websocketMock.handlers.get('replay_batch')?.({
      type: 'replay_batch', session_id: 'ses_1',
      events: [{ type: 'future_control_like_event', session_id: 'foreign-session', event_id: 'foreign-replay-unknown', text: 'drop me' }],
    })

    expect(vm.messages.some((message: any) => message.type === 'session_discovered')).toBe(false)
    expect(vm.messages.filter((message: any) => message.id === 'unknown:genuine-unknown')).toHaveLength(1)
    expect(vm.messages.some((message: any) => message.id === 'unknown:foreign-replay-unknown')).toBe(false)
  })

  test('renders repeated contiguous Turn segments in chronology with stable context-scoped collapse identity', async () => {
    const wrapper = shallowMount(SessionDetail)
    const vm = wrapper.vm as any
    vm.allSessions = [{ session_id: 'ses_1', daemon_id: 'daemon-1', status: 'running' }]
    vm.processEvent({ type: 'agent_text', text: 'first A', turn_id: 'A', flow_scope: 'main' })
    vm.processEvent({ type: 'agent_text', text: 'legacy separator' })
    vm.processEvent({ type: 'future_aux', event_id: 'aux-a', text: 'second A auxiliary', turn_id: 'A', flow_scope: 'auxiliary' })
    await wrapper.vm.$nextTick()

    const turnRows = () => (vm.turnRows as any[]).filter(row => row.kind === 'turn')
    expect(turnRows().map(row => row.messages.map((message: any) => message.content))).toEqual([['first A'], ['second A auxiliary']])
    const initialIDs = turnRows().map(row => row.id)
    expect(new Set(initialIDs).size).toBe(2)
    let headers = wrapper.findAll('.turn-group-header')
    expect(headers.map(header => header.attributes('data-turn-segment-id'))).toEqual(initialIDs)
    expect(vm.renderMessages.map((message: any) => message.content)).toEqual([
      'first A', 'legacy separator', 'second A auxiliary',
    ])

    vm.messages.unshift({ id: 'older-a', type: 'agent_text', role: 'agent', content: 'older A', turn_id: 'A', flow_scope: 'main' })
    vm.processEvent({ type: 'agent_text', text: 'second separator' })
    vm.processEvent({ type: 'agent_text', text: 'third A', turn_id: 'A', flow_scope: 'main' })
    await wrapper.vm.$nextTick()
    expect(turnRows().slice(0, 2).map(row => row.id)).toEqual(initialIDs)
    expect(new Set(turnRows().map(row => row.id)).size).toBe(3)

    headers = wrapper.findAll('.turn-group-header')
    const secondToggle = headers[1].find('.turn-group-aux-toggle')
    expect(secondToggle.attributes('aria-expanded')).toBe('true')
    await secondToggle.trigger('click')
    expect(headers[1].find('.turn-group-aux-toggle').attributes('aria-expanded')).toBe('false')
    expect(wrapper.text()).not.toContain('second A auxiliary')

    routeMock.current.params.id = 'ses_2'
    await wrapper.vm.$nextTick()
    vm.allSessions = [{ session_id: 'ses_2', daemon_id: 'daemon-1', status: 'running' }]
    vm.processEvent({ type: 'future_aux', event_id: 'aux-new-context', text: 'new context auxiliary', turn_id: 'A', flow_scope: 'auxiliary' })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.turn-group-aux-toggle').attributes('aria-expanded')).toBe('true')
    wrapper.unmount()
  })

  describe('SessionDetail live content batching', () => {
    function nextFrame(): Promise<void> {
      return new Promise(resolve => requestAnimationFrame(() => resolve()))
    }

    function countScrollWrites(el: HTMLElement): () => number {
      let writes = 0
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
      Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        get: descriptor?.get ?? (() => 0),
        set: () => { writes += 1 },
      })
      return () => writes
    }

    function chunkEvents(count: number): Array<Record<string, any>> {
      const texts = Array.from({ length: count }, (_, index) => `c${index} `)
      const totalBytes = texts.join('').length
      let offset = 0
      return texts.map((text, index) => {
        const event = {
          type: 'agent_text', session_id: 'ses_1', stream_id: 'burst-stream',
          chunk_seq: index, byte_offset: offset, streaming: true,
          final: index === count - 1, total_bytes: totalBytes, text,
        }
        offset += text.length
        return event
      })
    }

    test('coalesces one hundred live agent chunks into one ordered flush and one scroll', async () => {
      const baseline = shallowMount(SessionDetail)
      const baselineVm = baseline.vm as any
      for (const event of chunkEvents(100)) baselineVm.processEvent(event)
      await baseline.vm.$nextTick()
      const baselineText = (baselineVm.messages as any[])
        .filter((message: any) => message.type === 'agent_text')[0]
      expect(baselineText).toMatchObject({ streaming: false })
      baseline.unmount()

      const wrapper = shallowMount(SessionDetail)
      const vm = wrapper.vm as any
      vm.allSessions = [{ session_id: 'ses_1', daemon_id: 'daemon-1', status: 'running' }]
      await wrapper.vm.$nextTick()
      const scrollWrites = countScrollWrites(vm.messagesEl as HTMLElement)
      const handler = websocketMock.handlers.get('agent_text')!
      for (const event of chunkEvents(100)) handler(event)

      // Nothing commits before the frame fires: the whole burst lands in one
      // ordered flush instead of one hundred reactive commits.
      expect((vm.messages as any[]).filter((message: any) => message.type === 'agent_text')).toHaveLength(0)

      await nextFrame()
      await wrapper.vm.$nextTick()

      const liveTexts = (vm.messages as any[]).filter((message: any) => message.type === 'agent_text')
      expect(liveTexts).toHaveLength(1)
      expect(liveTexts[0].content).toBe(baselineText.content)
      expect(liveTexts[0].streaming).toBe(false)
      expect(scrollWrites()).toBe(1)
      wrapper.unmount()
    })

    test('control events flush earlier content and keep wire order', () => {
      const wrapper = shallowMount(SessionDetail)
      const vm = wrapper.vm as any
      const handler = (type: string) => websocketMock.handlers.get(type)!

      handler('agent_text')({
        type: 'agent_text', session_id: 'ses_1', stream_id: 'boundary-stream',
        chunk_seq: 0, byte_offset: 0, streaming: true, final: false, text: 'A',
      })
      handler('tool_call')({ type: 'tool_call', session_id: 'ses_1', call_id: 'call-1', tool: 'Bash', input: {} })
      handler('agent_text')({
        type: 'agent_text', session_id: 'ses_1', stream_id: 'boundary-stream',
        chunk_seq: 1, byte_offset: 1, streaming: true, final: false, text: 'B',
      })
      handler('approval_request')({ type: 'approval_request', session_id: 'ses_1', request_id: 'req-1', tool: 'Bash' })

      expect((vm.messages as any[]).map((message: any) => message.type))
        .toEqual(['agent_text', 'tool_call', 'approval_request'])
      const texts = (vm.messages as any[]).filter((message: any) => message.type === 'agent_text')
      expect(texts).toHaveLength(1)
      expect(texts[0].content).toBe('AB')
      // The approval card is live without waiting for the next frame.
      expect(vm.messages.find((message: any) => message.type === 'approval_request')).toMatchObject({
        status: 'pending', request_id: 'req-1',
      })
      wrapper.unmount()
    })

    test('switching sessions drops the previous session pending batch', async () => {
      const wrapper = shallowMount(SessionDetail)
      const vm = wrapper.vm as any
      const handler = websocketMock.handlers.get('agent_text')!
      handler({
        type: 'agent_text', session_id: 'ses_1', stream_id: 'isolation-stream',
        chunk_seq: 0, byte_offset: 0, streaming: true, final: false, text: 'old-session-content',
      })

      routeMock.current.params.id = 'ses_2'
      await wrapper.vm.$nextTick()
      await nextFrame()
      await wrapper.vm.$nextTick()

      expect((vm.messages as any[]).some((message: any) => message.type === 'agent_text')).toBe(false)

      handler({
        type: 'agent_text', session_id: 'ses_2', stream_id: 'isolation-stream-2',
        chunk_seq: 0, byte_offset: 0, streaming: true, final: false, text: 'new-session-content',
      })
      await nextFrame()
      await wrapper.vm.$nextTick()
      const texts = (vm.messages as any[]).filter((message: any) => message.type === 'agent_text')
      expect(texts).toHaveLength(1)
      expect(texts[0].content).toBe('new-session-content')
      wrapper.unmount()
    })

    test('keeps the reading position while the user is away from the bottom', async () => {
      const wrapper = shallowMount(SessionDetail)
      const vm = wrapper.vm as any
      vm.allSessions = [{ session_id: 'ses_1', daemon_id: 'daemon-1', status: 'running' }]
      await wrapper.vm.$nextTick()
      vm.autoScroll = false
      await wrapper.vm.$nextTick()
      const scrollWrites = countScrollWrites(vm.messagesEl as HTMLElement)
      const handler = websocketMock.handlers.get('agent_text')!
      for (const event of chunkEvents(100)) handler(event)
      await nextFrame()
      await wrapper.vm.$nextTick()

      const texts = (vm.messages as any[]).filter((message: any) => message.type === 'agent_text')
      const expectedLength = chunkEvents(100).map(event => event.text).join('').length
      expect(texts).toHaveLength(1)
      expect(texts[0].content).toHaveLength(expectedLength)
      expect(vm.autoScroll).toBe(false)
      expect(scrollWrites()).toBe(0)
      expect(wrapper.find('.scroll-to-bottom').exists()).toBe(true)

      await wrapper.find('.scroll-to-bottom').trigger('click')
      expect(scrollWrites()).toBe(1)
      expect(vm.autoScroll).toBe(true)
      wrapper.unmount()
    })
  })
})
