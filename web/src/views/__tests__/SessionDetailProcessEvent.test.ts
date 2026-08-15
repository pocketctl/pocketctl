import { shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { reactive, ref } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import SessionDetail from '../SessionDetail.vue'
import { resetAgentPlanProgressForTests } from '../../composables/useAgentPlanProgress'
import PlanSidePanel from '../../components/plan/PlanSidePanel.vue'
import OpenCodePartCard from '../../components/messages/OpenCodePartCard.vue'
import FileChangeCard from '../../components/messages/FileChangeCard.vue'
import FileChangeBottomSheet from '../../components/messages/FileChangeBottomSheet.vue'

const websocketMock = vi.hoisted(() => ({ handlers: new Map<string, (message: any) => void>() }))
const routeMock = vi.hoisted(() => ({ current: null as any }))

vi.mock('vue-router', () => ({
  useRoute: () => routeMock.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('../../composables/useWebSocket', () => ({
  useWebSocket: () => ({
    connect: vi.fn(), send: vi.fn(() => true),
    onEvent: vi.fn((type: string, handler: (message: any) => void) => {
      websocketMock.handlers.set(type, handler)
      return () => websocketMock.handlers.delete(type)
    }),
  }),
}))

vi.mock('../../composables/useLocale', () => ({ useLocale: () => ({ t: (key: string) => key }) }))
vi.mock('../../composables/useSessionRename', () => ({
  useSessionRename: () => ({
    renamingId: ref(''), renameInput: ref(''), startRename: vi.fn(), commitRename: vi.fn(), cancelRename: vi.fn(),
  }),
}))

describe('SessionDetail processEvent integration', () => {
  beforeEach(() => {
    routeMock.current = reactive({ params: { id: 'ses_1' }, query: {} as Record<string, string> })
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
    const toolbarButton = wrapper.find('.file-change-toolbar-button')
    expect(toolbarButton.exists()).toBe(true)
    await toolbarButton.trigger('click')
    expect(wrapper.findComponent(FileChangeCard).exists()).toBe(true)
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

    await wrapper.get('.file-change-toolbar-button').trigger('click')
    expect(wrapper.find('.file-change-side-panel').exists()).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.file-change-side-panel').exists()).toBe(false)
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

    await wrapper.get('.file-change-toolbar-button').trigger('click')
    const panel = wrapper.get('.file-change-side-panel')
    expect(panel.attributes('role')).toBe('dialog')
    expect(panel.attributes('aria-modal')).toBe('true')
    expect(wrapper.get('.file-change-panel-backdrop').attributes('aria-label')).toBe('session.file_change_close')

    await wrapper.get('.file-change-panel-backdrop').trigger('click')
    expect(wrapper.find('.file-change-side-panel').exists()).toBe(false)
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

    await wrapper.get('.plan-toolbar-button').trigger('click')
    expect(wrapper.findComponent(PlanSidePanel).exists()).toBe(true)
    expect(wrapper.find('.file-change-side-panel').exists()).toBe(false)

    await wrapper.get('.file-change-toolbar-button').trigger('click')
    expect(wrapper.findComponent(PlanSidePanel).exists()).toBe(false)
    expect(wrapper.find('.file-change-side-panel').exists()).toBe(true)

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
    await wrapper.find('.file-change-toolbar-button').trigger('click')
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
    const button = wrapper.get('.plan-toolbar-button')
    expect(button.attributes('aria-expanded')).toBe('false')
    await button.trigger('click')
    expect(wrapper.findComponent(PlanSidePanel).exists()).toBe(true)
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
})
