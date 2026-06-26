import { describe, test, expect } from 'vitest'
import type { CommandItem } from '../../composables/useWebSocket'

// Pure logic tests extracted from SessionDetail.vue

describe('exitReasonLabel', () => {
  const labels: Record<string, string> = {
    user_interrupt: '用户中断',
    normal_exit: '正常退出',
    process_crash: '异常退出',
    signal_kill: '被终止',
    unknown: '已退出',
  }

  function exitReasonLabel(reason: string): string {
    return labels[reason] || '已退出'
  }

  test('all known reasons mapped', () => {
    expect(exitReasonLabel('user_interrupt')).toBe('用户中断')
    expect(exitReasonLabel('normal_exit')).toBe('正常退出')
    expect(exitReasonLabel('process_crash')).toBe('异常退出')
    expect(exitReasonLabel('signal_kill')).toBe('被终止')
    expect(exitReasonLabel('unknown')).toBe('已退出')
  })

  test('unknown reason falls back', () => {
    expect(exitReasonLabel('something_else')).toBe('已退出')
  })
})

describe('statusLabel', () => {
  const labels: Record<string, string> = {
    running: 'Running', busy: 'Running', idle: 'Idle',
    waiting_approval: 'Waiting', exited: 'Exited', disconnected: 'Disconnected',
    completed: 'Completed', error: 'Error', killed: 'Killed',
  }

  test('all statuses have labels', () => {
    const statuses = ['running', 'busy', 'idle', 'waiting_approval', 'exited', 'disconnected', 'completed', 'error', 'killed']
    for (const s of statuses) {
      expect(labels[s]).toBeDefined()
    }
  })

  test('busy shows as Running', () => {
    expect(labels['busy']).toBe('Running')
  })
})

describe('terminalBadge computed', () => {
  function getTerminalBadge(effectiveStatus: string, isDaemonOnline: boolean) {
    if (effectiveStatus === 'exited' && isDaemonOnline) return { text: '可恢复', class: 'resumable' }
    if (effectiveStatus === 'completed') return { text: '只读', class: 'readonly' }
    if (effectiveStatus === 'error') return { text: '异常退出', class: 'errored' }
    if (effectiveStatus === 'killed') return { text: '已终止', class: 'killed-badge' }
    return null
  }

  test('exited + online → 可恢复', () => {
    expect(getTerminalBadge('exited', true)).toEqual({ text: '可恢复', class: 'resumable' })
  })

  test('exited + offline → null (shows disconnected)', () => {
    expect(getTerminalBadge('disconnected', false)).toBeNull()
  })

  test('completed → 只读', () => {
    expect(getTerminalBadge('completed', true)).toEqual({ text: '只读', class: 'readonly' })
  })

  test('error → 异常退出', () => {
    expect(getTerminalBadge('error', true)).toEqual({ text: '异常退出', class: 'errored' })
  })

  test('killed → 已终止', () => {
    expect(getTerminalBadge('killed', true)).toEqual({ text: '已终止', class: 'killed-badge' })
  })

  test('running → null', () => {
    expect(getTerminalBadge('running', true)).toBeNull()
  })

  test('idle → null', () => {
    expect(getTerminalBadge('idle', true)).toBeNull()
  })
})

describe('showInput computed', () => {
  function shouldShowInput(effectiveStatus: string, isDaemonOnline: boolean): boolean {
    return ['running', 'busy', 'idle', 'waiting_approval'].includes(effectiveStatus) ||
      (effectiveStatus === 'exited' && isDaemonOnline)
  }

  test('running → input visible', () => {
    expect(shouldShowInput('running', true)).toBe(true)
  })

  test('completed → input hidden', () => {
    expect(shouldShowInput('completed', true)).toBe(false)
  })

  test('exited + online → input visible (for resume)', () => {
    expect(shouldShowInput('exited', true)).toBe(true)
  })

  test('exited + offline → input hidden', () => {
    expect(shouldShowInput('exited', false)).toBe(false)
  })

  test('disconnected → input hidden', () => {
    expect(shouldShowInput('disconnected', false)).toBe(false)
  })

  test('idle → input visible', () => {
    expect(shouldShowInput('idle', true)).toBe(true)
  })

  test('waiting_approval → input visible', () => {
    expect(shouldShowInput('waiting_approval', true)).toBe(true)
  })
})

describe('showEndedMessage computed', () => {
  function shouldShowEndedMessage(effectiveStatus: string, isDaemonOnline: boolean): boolean {
    return ['completed', 'error', 'killed'].includes(effectiveStatus) ||
      (effectiveStatus === 'exited' && !isDaemonOnline)
  }

  test('completed → ended message', () => {
    expect(shouldShowEndedMessage('completed', true)).toBe(true)
  })

  test('error → ended message', () => {
    expect(shouldShowEndedMessage('error', true)).toBe(true)
  })

  test('killed → ended message', () => {
    expect(shouldShowEndedMessage('killed', true)).toBe(true)
  })

  test('exited + offline → ended message', () => {
    expect(shouldShowEndedMessage('exited', false)).toBe(true)
  })

  test('exited + online → no ended message', () => {
    expect(shouldShowEndedMessage('exited', true)).toBe(false)
  })

  test('running → no ended message', () => {
    expect(shouldShowEndedMessage('running', true)).toBe(false)
  })
})

describe('inputPlaceholder computed', () => {
  function getPlaceholder(status: string): string {
    if (status === 'exited') return '输入消息以恢复 Session...'
    return 'Send a message...'
  }

  test('exited shows resume placeholder', () => {
    expect(getPlaceholder('exited')).toBe('输入消息以恢复 Session...')
  })

  test('other statuses show normal placeholder', () => {
    expect(getPlaceholder('running')).toBe('Send a message...')
    expect(getPlaceholder('idle')).toBe('Send a message...')
  })
})

describe('timeline milestone building', () => {
  test('only adds milestones for non-disconnected status changes', () => {
    const milestones: { status: string; time: string }[] = []
    const events = [
      { status: 'running', last_activity_at: '2026-06-07T10:00:00Z' },
      { status: 'disconnected', last_activity_at: '2026-06-07T10:01:00Z' },
      { status: 'running', last_activity_at: '2026-06-07T10:02:00Z' },
      { status: 'idle', last_activity_at: '2026-06-07T10:03:00Z' },
    ]

    for (const evt of events) {
      if (evt.status !== 'disconnected' && evt.last_activity_at) {
        const last = milestones[milestones.length - 1]
        if (!last || last.status !== evt.status) {
          milestones.push({ status: evt.status, time: evt.last_activity_at })
        }
      }
    }

    // running → disconnected(skipped) → running(deduped, same as last) → idle
    // So: running, idle (the second running is deduplicated)
    expect(milestones.length).toBe(2)
    expect(milestones[0].status).toBe('running')
    expect(milestones[1].status).toBe('idle')
  })

  test('deduplicates consecutive same-status events', () => {
    const milestones: { status: string; time: string }[] = []
    const events = [
      { status: 'running', last_activity_at: '2026-06-07T10:00:00Z' },
      { status: 'running', last_activity_at: '2026-06-07T10:01:00Z' },
      { status: 'idle', last_activity_at: '2026-06-07T10:02:00Z' },
    ]

    for (const evt of events) {
      if (evt.status !== 'disconnected' && evt.last_activity_at) {
        const last = milestones[milestones.length - 1]
        if (!last || last.status !== evt.status) {
          milestones.push({ status: evt.status, time: evt.last_activity_at })
        }
      }
    }

    expect(milestones.length).toBe(2)
    expect(milestones[0].status).toBe('running')
    expect(milestones[1].status).toBe('idle')
  })
})

// Slash command autocompletion filtering logic (mirrors SessionDetail.vue filteredCommands)
describe('slash command filtering', () => {
  const pool: CommandItem[] = [
    { name: 'clear', source: 'builtin', kind: 'command', description: '' },
    { name: 'compact', source: 'builtin', kind: 'command', description: '' },
    { name: 'pocket-release', source: 'project', kind: 'skill', description: '' },
    { name: 'codex:rescue', source: 'plugin', kind: 'skill', namespace: 'codex', description: '' },
  ]

  function filterCommands(input: string, pool: CommandItem[]): CommandItem[] {
    if (!input.startsWith('/')) return []
    const prefix = input.slice(1).toLowerCase()
    if (prefix === '') return pool.slice(0, 50)
    return pool.filter(c => c.name.toLowerCase().startsWith(prefix)).slice(0, 50)
  }

  test('non-slash input returns nothing', () => {
    expect(filterCommands('hello', pool)).toEqual([])
    expect(filterCommands('', pool)).toEqual([])
  })

  test('bare slash returns all', () => {
    expect(filterCommands('/', pool).length).toBe(4)
  })

  test('prefix filters by name (matches full name including namespace)', () => {
    // 'codex:rescue' also starts with 'c', so /c matches it along with clear/compact
    expect(filterCommands('/c', pool).map(c => c.name)).toEqual(['clear', 'compact', 'codex:rescue'])
  })

  test('longer prefix narrows further', () => {
    expect(filterCommands('/comp', pool).map(c => c.name)).toEqual(['compact'])
  })

  test('matches namespaced plugin command', () => {
    expect(filterCommands('/codex', pool).map(c => c.name)).toEqual(['codex:rescue'])
  })

  test('prefix is case-insensitive', () => {
    expect(filterCommands('/CLEAR', pool).map(c => c.name)).toEqual(['clear'])
  })

  test('no match returns empty', () => {
    expect(filterCommands('/xyz', pool)).toEqual([])
  })
})

// cleanContent must strip <local-command-caveat> entirely (aligns with iOS
// sanitizeUserMessage). Mirrors SessionDetail.vue cleanContent caveat handling.
describe('cleanContent strips local-command-caveat', () => {
  function cleanContent(text: string): string {
    return text
      .replace(/<local-command-caveat>.*?<\/local-command-caveat>\s*/gs, '')
      .replace(/<[^>]+>/g, '')
      .trim()
  }

  test('removes caveat, keeps surrounding text', () => {
    const input = '<local-command-caveat>Caveat: DO NOT respond...</local-command-caveat>hello'
    expect(cleanContent(input)).toBe('hello')
  })

  test('caveat-only content becomes empty (no "Caveat:..." residue)', () => {
    const input = '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>'
    expect(cleanContent(input)).toBe('')
  })
})

// cleanContent for slash commands: Claude Code records commands as
// <command-name>/<command-message>/<command-args> tags. Only command-name
// (e.g. "/model") is shown — command-message is a redundant command identifier
// (e.g. "model"), so appending it produced "/model\nmodel". Mirrors the
// command-name branch of SessionDetail.vue cleanContent.
describe('cleanContent for slash commands', () => {
  function cleanContent(text: string): string {
    if (!text) return ''
    if (text.includes('<command-name>') || text.includes('<command-message>')) {
      const nameMatch = text.match(/<command-name>([\s\S]*?)<\/command-name>/)
      const msgMatch = text.match(/<command-message>([\s\S]*?)<\/command-message>/)
      const name = (nameMatch?.[1] ?? '').trim()
      const msg = (msgMatch?.[1] ?? '').trim()
      if (name || msg) return name || msg
    }
    return text.replace(/<[^>]+>/g, '').trim()
  }

  test('/model shows only "/model", not "/model\\nmodel"', () => {
    const input = '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>'
    expect(cleanContent(input)).toBe('/model')
  })

  test('/compact shows only "/compact"', () => {
    const input = '<command-name>/compact</command-name>\n<command-message>compact</command-message>'
    expect(cleanContent(input)).toBe('/compact')
  })

  test('falls back to command-message when command-name absent', () => {
    const input = '<command-message>clear</command-message>'
    expect(cleanContent(input)).toBe('clear')
  })
})

// Turn timer resume logic — verifies replayed session_status events correctly
// recover resumeStartAt so the timer doesn't restart from zero on switch/refresh.
describe('turn timer resumeStartAt recovery', () => {
  function processStatusEvent(evt: any, sessionSwitching: boolean): { status: string; resumeStartAt: number | null } {
    const status = evt.status || evt.payload?.status
    let resumeStartAt: number | null = null
    if (sessionSwitching && (status === 'running' || status === 'busy' || status === 'waiting')) {
      const ts = evt.last_activity_at || evt.payload?.last_activity_at
      if (ts) resumeStartAt = new Date(ts).getTime()
    }
    return { status: status ?? '', resumeStartAt }
  }

  test('busy status with last_activity_at sets resumeStartAt', () => {
    const r = processStatusEvent({ status: 'busy', last_activity_at: '2026-06-24T06:43:06Z' }, true)
    expect(r.resumeStartAt).toBe(new Date('2026-06-24T06:43:06Z').getTime())
  })

  test('running status sets resumeStartAt', () => {
    const r = processStatusEvent({ status: 'running', last_activity_at: '2026-06-24T06:42:00Z' }, true)
    expect(r.resumeStartAt).toBe(new Date('2026-06-24T06:42:00Z').getTime())
  })

  test('idle status does NOT set resumeStartAt', () => {
    expect(processStatusEvent({ status: 'idle', last_activity_at: '2026-06-24T06:43:06Z' }, true).resumeStartAt).toBeNull()
  })

  test('completed status does NOT set resumeStartAt', () => {
    expect(processStatusEvent({ status: 'completed', last_activity_at: '2026-06-24T06:43:06Z' }, true).resumeStartAt).toBeNull()
  })

  test('sessionSwitching=false blocks resumeStartAt', () => {
    expect(processStatusEvent({ status: 'busy', last_activity_at: '2026-06-24T06:43:06Z' }, false).resumeStartAt).toBeNull()
  })

  test('missing last_activity_at blocks resumeStartAt', () => {
    expect(processStatusEvent({ status: 'busy' }, true).resumeStartAt).toBeNull()
  })

  test('ASC replay: last executing status wins', () => {
    const events = [
      { status: 'idle', last_activity_at: '2026-06-24T06:40:00Z' },
      { status: 'busy', last_activity_at: '2026-06-24T06:41:00Z' },
      { status: 'busy', last_activity_at: '2026-06-24T06:42:00Z' },
      { status: 'waiting', last_activity_at: '2026-06-24T06:43:00Z' },
    ]
    let lastResume: number | null = null
    for (const evt of events) {
      const r = processStatusEvent(evt, true)
      if (r.resumeStartAt !== null) lastResume = r.resumeStartAt
    }
    expect(lastResume).toBe(new Date('2026-06-24T06:43:00Z').getTime())
  })
})

// Tool-use approval flow (PreToolUse hook → approval_request → approval_response).
// Mirrors SessionDetail.vue processEvent('approval_request') + onApprovalRespond.
describe('tool-use approval flow', () => {
  function processApprovalRequest(evt: any): any | null {
    const type = evt.type
    if (type !== 'approval_request') return null
    const requestId = evt.request_id
    if (!requestId) return null
    const tool = evt.tool || ''
    const input = evt.input
    return {
      id: 'ap-1', type: 'approval_request', request_id: requestId,
      call_id: evt.call_id,
      tool, input,
      status: 'pending',
    }
  }

  test('approval_request event builds a pending card message', () => {
    const msg = processApprovalRequest({
      type: 'approval_request', request_id: 'req-1', call_id: 'call_x',
      tool: 'Bash', input: { command: 'rm -rf /tmp/x' },
    })
    expect(msg).not.toBeNull()
    expect(msg.type).toBe('approval_request')
    expect(msg.request_id).toBe('req-1')
    expect(msg.tool).toBe('Bash')
    expect(msg.status).toBe('pending')
  })

  test('approval_request without request_id is dropped', () => {
    expect(processApprovalRequest({ type: 'approval_request', tool: 'Bash' })).toBeNull()
  })

  test('non-approval_request types are ignored', () => {
    expect(processApprovalRequest({ type: 'tool_call', tool: 'Bash' })).toBeNull()
    expect(processApprovalRequest({ type: 'agent_text', text: 'hi' })).toBeNull()
  })

  test('onApprovalRespond builds the correct approval_response payload', () => {
    // Mirrors: send({ type:'approval_response', session_id, request_id, approved })
    const sent: any[] = []
    const send = (m: any) => sent.push(m)
    const sessionId = 's-123'
    function onApprovalRespond(msg: any, approved: boolean) {
      if (!msg.request_id) return
      send({ type: 'approval_response', session_id: sessionId, request_id: msg.request_id, approved })
    }

    onApprovalRespond({ request_id: 'req-1' }, true)
    onApprovalRespond({ request_id: 'req-2' }, false)

    expect(sent).toEqual([
      { type: 'approval_response', session_id: 's-123', request_id: 'req-1', approved: true },
      { type: 'approval_response', session_id: 's-123', request_id: 'req-2', approved: false },
    ])
  })

  test('onApprovalRespond skips messages without request_id', () => {
    const sent: any[] = []
    const send = (m: any) => sent.push(m)
    function onApprovalRespond(msg: any, approved: boolean) {
      if (!msg.request_id) return
      send({ type: 'approval_response', request_id: msg.request_id, approved })
    }
    onApprovalRespond({}, true)
    expect(sent).toEqual([])
  })
})

// PTY selection-menu flow (interactive_prompt → interactive_response).
// Mirrors SessionDetail.vue processEvent('interactive_prompt') + onChoiceRespond.
// The daemon scans the agent's PTY for a menu the TUI drew (e.g. a host
// PreToolUse hook's "Do you want to proceed? ❶Yes ❷No") and surfaces it as a
// numbered-choice card; the user's pick is written back to the PTY.
describe('interactive prompt flow', () => {
  function safeParseJSON(s: string): any {
    try { return JSON.parse(s) } catch { return null }
  }
  function processInteractivePrompt(evt: any): any | null {
    if (evt.type !== 'interactive_prompt') return null
    const requestId = evt.request_id
    if (!requestId) return null
    const rawInput = evt.input
    let promptText = ''
    let options: any[] = []
    if (rawInput) {
      const inp = typeof rawInput === 'string' ? safeParseJSON(rawInput) : rawInput
      promptText = inp?.prompt || ''
      if (Array.isArray(inp?.options)) options = inp.options
    }
    return {
      id: 'ip-1', type: 'interactive_prompt', request_id: requestId,
      prompt: promptText, options, status: 'pending', selectedChoice: '',
    }
  }

  test('interactive_prompt event builds a pending choice card', () => {
    const msg = processInteractivePrompt({
      type: 'interactive_prompt', request_id: 'req-x',
      input: { prompt: 'Do you want to proceed?', options: [{ index: '1', label: 'Yes' }, { index: '2', label: 'No' }] },
    })
    expect(msg).not.toBeNull()
    expect(msg.type).toBe('interactive_prompt')
    expect(msg.status).toBe('pending')
    expect(msg.prompt).toBe('Do you want to proceed?')
    expect(msg.options).toHaveLength(2)
    expect(msg.options[0]).toEqual({ index: '1', label: 'Yes' })
  })

  test('interactive_prompt with stringified input parses options', () => {
    const msg = processInteractivePrompt({
      type: 'interactive_prompt', request_id: 'req-y',
      input: '{"prompt":"proceed?","options":[{"index":"1","label":"A"},{"index":"2","label":"B"}]}',
    })
    expect(msg.prompt).toBe('proceed?')
    expect(msg.options[1].label).toBe('B')
  })

  test('interactive_prompt without request_id is dropped', () => {
    expect(processInteractivePrompt({ type: 'interactive_prompt', input: { prompt: 'x' } })).toBeNull()
  })

  test('non-interactive_prompt types are ignored', () => {
    expect(processInteractivePrompt({ type: 'agent_text', text: 'hi' })).toBeNull()
    expect(processInteractivePrompt({ type: 'approval_request', request_id: 'r' })).toBeNull()
  })

  test('onChoiceRespond builds the correct interactive_response payload', () => {
    const sent: any[] = []
    const send = (m: any) => sent.push(m)
    const sessionId = 's-123'
    function onChoiceRespond(msg: any, choice: string) {
      if (!msg.request_id) return
      send({ type: 'interactive_response', session_id: sessionId, request_id: msg.request_id, choice })
    }
    onChoiceRespond({ request_id: 'req-1' }, '1')
    onChoiceRespond({ request_id: 'req-2' }, '2')
    expect(sent).toEqual([
      { type: 'interactive_response', session_id: 's-123', request_id: 'req-1', choice: '1' },
      { type: 'interactive_response', session_id: 's-123', request_id: 'req-2', choice: '2' },
    ])
  })
})

// Retry last prompt — mirrors SessionDetail.vue retryLastPrompt() +
// hasLastUserPrompt. A retry re-sends the last user_text verbatim by routing
// it through sendMessage (filling messageInput first), so the retried bubble is
// treated exactly like a fresh send.
describe('retry last prompt', () => {
  function hasLastUserPrompt(messages: any[]): boolean {
    return messages.some((m: any) => m.role === 'user' && m.content)
  }

  // Mirror of retryLastPrompt: sets messageInput to the last user message's
  // raw content, then invokes sendMessage (stubbed here to record the dispatch).
  function retryLastPrompt(messages: any[], canInput: boolean): { sent: string | null } {
    const result = { sent: null as string | null }
    if (!canInput) return result
    const send = (text: string) => { result.sent = text }
    let messageInput = ''
    // sendMessage body: trim, guard, then dispatch user_message with the content
    function sendMessage() {
      const text = messageInput.trim()
      if (!text) return
      send(text)
      messageInput = ''
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'user' && m.content) {
        messageInput = m.content
        sendMessage()
        return result
      }
    }
    return result
  }

  test('hasLastUserPrompt true when a user message with content exists', () => {
    const msgs = [
      { type: 'agent_text', role: 'agent', content: 'hello' },
      { type: 'user_text', role: 'user', content: 'hi' },
    ]
    expect(hasLastUserPrompt(msgs)).toBe(true)
  })

  test('hasLastUserPrompt false when no user message exists', () => {
    const msgs = [
      { type: 'agent_text', role: 'agent', content: 'hello' },
      { type: 'tool_call', role: 'agent' },
    ]
    expect(hasLastUserPrompt(msgs)).toBe(false)
  })

  test('hasLastUserPrompt false when user message is empty', () => {
    const msgs = [{ type: 'user_text', role: 'user', content: '' }]
    expect(hasLastUserPrompt(msgs)).toBe(false)
  })

  test('retry sends the most recent user message verbatim', () => {
    const msgs = [
      { type: 'user_text', role: 'user', content: 'first question' },
      { type: 'agent_text', role: 'agent', content: 'answer one' },
      { type: 'user_text', role: 'user', content: 'second question' },
      { type: 'agent_text', role: 'agent', content: 'answer two' },
    ]
    expect(retryLastPrompt(msgs, true).sent).toBe('second question')
  })

  test('retry uses raw content, not cleanContent', () => {
    const raw = '<command-name>/compact</command-name>body text'
    const msgs = [
      { type: 'user_text', role: 'user', content: raw },
      { type: 'agent_text', role: 'agent', content: 'done' },
    ]
    // Retry must preserve the original prompt exactly (user intent), including
    // any command tags — NOT the cleaned-up bubble text.
    expect(retryLastPrompt(msgs, true).sent).toBe(raw)
  })

  test('retry sends nothing when no user message exists', () => {
    const msgs = [{ type: 'agent_text', role: 'agent', content: 'hi' }]
    expect(retryLastPrompt(msgs, true).sent).toBeNull()
  })

  test('retry blocked when session cannot accept input (ended/disconnected)', () => {
    const msgs = [
      { type: 'user_text', role: 'user', content: 'hi' },
      { type: 'agent_text', role: 'agent', content: 'done' },
    ]
    expect(retryLastPrompt(msgs, false).sent).toBeNull()
  })
})

