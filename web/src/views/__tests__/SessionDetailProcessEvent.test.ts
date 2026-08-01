import { shallowMount } from '@vue/test-utils'
import { describe, expect, test, vi } from 'vitest'
import { ref } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import SessionDetail from '../SessionDetail.vue'

const websocketMock = vi.hoisted(() => ({ handlers: new Map<string, (message: any) => void>() }))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'ses_1' }, query: {} }),
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
