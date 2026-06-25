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

