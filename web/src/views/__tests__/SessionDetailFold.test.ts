import { describe, test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SubAgentFoldGroup from '../../components/messages/SubAgentFoldGroup.vue'

// Stubs for child components used inside the fold group
const globalStubs = {
  MessageUser: true,
  MessageAgent: true,
  ToolCallCard: true,
  DiffCard: true,
  MarkdownRenderer: true,
}

const baseMessages = [
  { id: 'u1', type: 'user_text', role: 'user', content: 'hello from user' },
  { id: 'a1', type: 'agent_text', role: 'agent', content: 'hello from agent', streaming: false },
  { id: 't1', type: 'tool_call', tool: 'Bash', call_id: 'tc1', input: 'ls', status: 'completed', expanded: false, outputExpanded: false },
]

describe('SubAgentFoldGroup', () => {
  test('renders a Codex child through the existing fold component', () => {
    const w = mount(SubAgentFoldGroup, {
      props: {
        agentId: '019f4ad3-342e-7213-a51f-2758edf9ec6b',
        title: 'Newton',
        desc: 'keyboard task',
        agentType: 'codex',
        tokenUsage: null,
        messages: baseMessages,
        parentTitle: 'Main Codex Session',
      },
      global: { stubs: globalStubs },
    })
    expect(w.text()).toContain('Main Codex Session')
    expect(w.text()).toContain('Newton')
    expect(w.html()).toContain('message-agent-stub')
  })

  test('renders breadcrumb with parentTitle and title', () => {
    const w = mount(SubAgentFoldGroup, {
      props: {
        agentId: 'agent-1',
        title: 'Research Task',
        desc: 'deep research',
        agentType: 'claude-code',
        tokenUsage: { tokenIn: 100, tokenOut: 200, tokenCache: 50, tokenCacheCreate: 30 },
        messages: baseMessages,
        parentTitle: 'Main Session',
      },
      global: { stubs: globalStubs },
    })
    expect(w.text()).toContain('Main Session')
    expect(w.text()).toContain('Research Task')
    // breadcrumb separator
    expect(w.html()).toContain('›')
  })

  test('renders desc when title is empty', () => {
    const w = mount(SubAgentFoldGroup, {
      props: {
        agentId: 'agent-1',
        title: '',
        desc: 'fallback description',
        agentType: 'claude-code',
        tokenUsage: null,
        messages: [],
        parentTitle: 'Parent',
      },
      global: { stubs: globalStubs },
    })
    expect(w.text()).toContain('fallback description')
    expect(w.text()).toContain('Parent')
  })

  test('renders token pill when tokenUsage is provided', () => {
    const w = mount(SubAgentFoldGroup, {
      props: {
        agentId: 'agent-1',
        title: 'Task',
        desc: 'desc',
        agentType: 'claude-code',
        tokenUsage: { tokenIn: 1000, tokenOut: 500, tokenCache: 250, tokenCacheCreate: 100 },
        messages: [],
        parentTitle: 'Parent',
      },
      global: { stubs: globalStubs },
    })
    expect(w.html()).toMatch(/1000/)
    expect(w.html()).toMatch(/500/)
  })

  test('does not render token pill when tokenUsage is null', () => {
    const w = mount(SubAgentFoldGroup, {
      props: {
        agentId: 'agent-1',
        title: 'Task',
        desc: 'desc',
        agentType: 'claude-code',
        tokenUsage: null,
        messages: [],
        parentTitle: 'Parent',
      },
      global: { stubs: globalStubs },
    })
    expect(w.html()).not.toContain('safg-tokens')
  })

  test('expanded by default shows messages', () => {
    const w = mount(SubAgentFoldGroup, {
      props: {
        agentId: 'agent-1',
        title: 'Task',
        desc: 'desc',
        agentType: 'claude-code',
        tokenUsage: null,
        messages: baseMessages,
        parentTitle: 'Parent',
      },
      global: { stubs: globalStubs },
    })
    // MessageUser, MessageAgent, ToolCallCard are stubbed — their tags should exist
    expect(w.html()).toContain('message-user-stub')
    expect(w.html()).toContain('message-agent-stub')
    expect(w.html()).toContain('tool-call-card-stub')
  })

  test('collapsed hides messages', async () => {
    const w = mount(SubAgentFoldGroup, {
      props: {
        agentId: 'agent-1',
        title: 'Task',
        desc: 'desc',
        agentType: 'claude-code',
        tokenUsage: null,
        messages: baseMessages,
        parentTitle: 'Parent',
      },
      global: { stubs: globalStubs },
    })
    // Should start expanded — messages visible
    expect(w.html()).toContain('message-user-stub')

    // Click to collapse
    await w.find('.safg-header').trigger('click')
    expect(w.find('.safg-body').exists()).toBe(false)
    // breadcrumb should still be visible
    expect(w.text()).toContain('Task')
  })

  test('chevron rotates on expand/collapse', async () => {
    const w = mount(SubAgentFoldGroup, {
      props: {
        agentId: 'agent-1',
        title: 'Task',
        desc: 'desc',
        agentType: '',
        tokenUsage: null,
        messages: [],
        parentTitle: 'P',
      },
      global: { stubs: globalStubs },
    })
    const chevron = w.find('.safg-chevron')
    expect(chevron.classes()).toContain('open') // expanded by default

    await w.find('.safg-header').trigger('click')
    expect(chevron.classes()).not.toContain('open')
  })
})

describe('SubAgentFoldGroup — isSubagent / canInput logic', () => {
  // Test the computed isSubagent logic that SessionDetail will use.
  // Since we can't easily mount SessionDetail (heavy WebSocket), we test
  // the pure logic directly.

  test('isSubagent computed returns true when session has is_subagent flag', () => {
    const allSessions = [
      { session_id: 'sid1', is_subagent: true },
      { session_id: 'sid2' },
    ]
    const sessionId = 'sid1'
    const isSubagent = !!(allSessions as any[]).find((s: any) => s.session_id === sessionId)?.is_subagent
    expect(isSubagent).toBe(true)
  })

  test('isSubagent computed returns false for normal session', () => {
    const allSessions = [
      { session_id: 'sid1' },
      { session_id: 'sid2' },
    ]
    const sessionId = 'sid1'
    const isSubagent = !!(allSessions as any[]).find((s: any) => s.session_id === sessionId)?.is_subagent
    expect(isSubagent).toBe(false)
  })

  test('canInput becomes false when isSubagent is true', () => {
    // Simulate the canInput logic:
    // canInput = !isDisconnected && (!isTerminal || isDaemonSession) && !isSubagent
    const isSubagent = true
    const isDisconnected = false
    const isTerminal = false
    const isDaemonSession = true
    const canInput = !isDisconnected && (!isTerminal || isDaemonSession) && !isSubagent
    expect(canInput).toBe(false)
  })

  test('canInput remains true when isSubagent is false', () => {
    const isSubagent = false
    const isDisconnected = false
    const isTerminal = false
    const isDaemonSession = true
    const canInput = !isDisconnected && (!isTerminal || isDaemonSession) && !isSubagent
    expect(canInput).toBe(true)
  })
})

describe('subagent_title_update handler logic', () => {
  // Unit-test the handler logic extracted from SessionDetail.vue onMounted.
  // The real handler mutates messages.value; here we replicate the logic.

  function makeMessages() {
    return [
      { id: 'sa1', type: 'subagent', tool: 'agent-1', input: 'research task', title: undefined as string | undefined, status: 'completed', expanded: true, outputExpanded: false },
      { id: 'u1', type: 'user_text', role: 'user', content: 'hello' },
      { id: 'sa2', type: 'subagent', tool: 'agent-2', input: 'code review', title: undefined as string | undefined, status: 'completed', expanded: true, outputExpanded: false },
    ] as any[]
  }

  function simulateTitleUpdate(messages: any[], sessionId: string, msg: { session_id: string; agent_id: string; title?: string }) {
    if (msg.session_id !== sessionId || !msg.agent_id) return
    const m = messages.find((x: any) => x.type === 'subagent' && x.tool === msg.agent_id)
    if (m && msg.title) m.title = msg.title
  }

  test('updates title on matching subagent placeholder', () => {
    const messages = makeMessages()
    simulateTitleUpdate(messages, 'sid-main', { session_id: 'sid-main', agent_id: 'agent-1', title: 'Deep Research' })
    expect(messages[0].title).toBe('Deep Research')
    // other subagent untouched
    expect(messages[2].title).toBeUndefined()
  })

  test('ignores event for different session', () => {
    const messages = makeMessages()
    simulateTitleUpdate(messages, 'sid-main', { session_id: 'sid-other', agent_id: 'agent-1', title: 'Deep Research' })
    expect(messages[0].title).toBeUndefined()
  })

  test('ignores event without title', () => {
    const messages = makeMessages()
    simulateTitleUpdate(messages, 'sid-main', { session_id: 'sid-main', agent_id: 'agent-1' })
    expect(messages[0].title).toBeUndefined()
  })

  test('session_list title sync updates placeholder messages', () => {
    const messages = makeMessages()
    const children = [
      { agentId: 'agent-1', title: 'Resolved Title A' },
      { agentId: 'agent-2', title: 'Resolved Title B' },
    ]
    for (const c of children) {
      const m = messages.find((x: any) => x.type === 'subagent' && x.tool === c.agentId)
      if (m && c.title) m.title = c.title
    }
    expect(messages[0].title).toBe('Resolved Title A')
    expect(messages[2].title).toBe('Resolved Title B')
  })
})
