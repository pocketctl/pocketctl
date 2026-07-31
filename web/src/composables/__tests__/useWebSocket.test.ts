import { describe, test, expect, beforeEach } from 'vitest'

// Test the logic from useWebSocket composable as pure functions
// (the composable uses module-level singletons that are hard to reset between tests)

describe('effectiveStatus logic', () => {
  function effectiveStatus(session: { status: string; daemon_id?: string }, daemons: Map<string, { online: boolean }>): string {
    if (session.daemon_id) {
      const daemon = daemons.get(session.daemon_id)
      if (daemon && !daemon.online) {
        return 'disconnected'
      }
    }
    return session.status
  }

  const daemons = new Map<string, { online: boolean }>()

  beforeEach(() => {
    daemons.clear()
  })

  test('returns real status when daemon is online', () => {
    daemons.set('daemon-1', { online: true })
    expect(effectiveStatus({ status: 'running', daemon_id: 'daemon-1' }, daemons)).toBe('running')
    expect(effectiveStatus({ status: 'idle', daemon_id: 'daemon-1' }, daemons)).toBe('idle')
    expect(effectiveStatus({ status: 'exited', daemon_id: 'daemon-1' }, daemons)).toBe('exited')
  })

  test('returns "disconnected" when daemon is offline', () => {
    daemons.set('daemon-1', { online: false })
    expect(effectiveStatus({ status: 'running', daemon_id: 'daemon-1' }, daemons)).toBe('disconnected')
    expect(effectiveStatus({ status: 'idle', daemon_id: 'daemon-1' }, daemons)).toBe('disconnected')
    expect(effectiveStatus({ status: 'exited', daemon_id: 'daemon-1' }, daemons)).toBe('disconnected')
  })

  test('returns real status when daemon_id is undefined', () => {
    expect(effectiveStatus({ status: 'running' }, daemons)).toBe('running')
    expect(effectiveStatus({ status: 'error' }, daemons)).toBe('error')
  })

  test('returns real status when daemon is unknown (not in map)', () => {
    expect(effectiveStatus({ status: 'running', daemon_id: 'unknown-daemon' }, daemons)).toBe('running')
  })

  test('multiple daemons: each tracked independently', () => {
    daemons.set('daemon-1', { online: true })
    daemons.set('daemon-2', { online: false })

    expect(effectiveStatus({ status: 'running', daemon_id: 'daemon-1' }, daemons)).toBe('running')
    expect(effectiveStatus({ status: 'running', daemon_id: 'daemon-2' }, daemons)).toBe('disconnected')
  })
})

describe('isDaemonOnline logic', () => {
  function isDaemonOnline(daemonId: string | undefined, daemons: Map<string, { online: boolean }>): boolean {
    if (!daemonId) return false
    const daemon = daemons.get(daemonId)
    return daemon?.online ?? false
  }

  const daemons = new Map<string, { online: boolean }>()

  test('returns true for online daemon', () => {
    daemons.set('daemon-1', { online: true })
    expect(isDaemonOnline('daemon-1', daemons)).toBe(true)
  })

  test('returns false for offline daemon', () => {
    daemons.set('daemon-1', { online: false })
    expect(isDaemonOnline('daemon-1', daemons)).toBe(false)
  })

  test('returns false for unknown daemon', () => {
    expect(isDaemonOnline('nonexistent', daemons)).toBe(false)
  })

  test('returns false for undefined daemon_id', () => {
    expect(isDaemonOnline(undefined, daemons)).toBe(false)
  })
})

describe('handleDaemonStatus logic', () => {
  test('daemon_status: online updates daemons map', () => {
    const daemons = new Map<string, any>()

    function handleDaemonStatus(data: any, daemons: Map<string, any>) {
      const id = data.daemon_id
      if (!id) return
      const existing = daemons.get(id)
      if (data.status === 'online') {
        daemons.set(id, {
          daemon_id: id,
          hostname: data.hostname || existing?.hostname || 'unknown',
          agents: data.agents || existing?.agents || [],
          online: true,
        })
      } else if (data.status === 'offline') {
        daemons.set(id, {
          daemon_id: id,
          hostname: data.hostname || existing?.hostname || 'unknown',
          agents: existing?.agents || [],
          online: false,
          last_seen_at: data.last_seen_at || new Date().toISOString(),
        })
      }
    }

    handleDaemonStatus({ type: 'daemon_status', daemon_id: 'd1', status: 'online', hostname: 'mac' }, daemons)
    expect(daemons.get('d1').online).toBe(true)
    expect(daemons.get('d1').hostname).toBe('mac')

    handleDaemonStatus({ type: 'daemon_status', daemon_id: 'd1', status: 'offline', hostname: 'mac', last_seen_at: '2026-06-07T00:00:00Z' }, daemons)
    expect(daemons.get('d1').online).toBe(false)
    expect(daemons.get('d1').last_seen_at).toBe('2026-06-07T00:00:00Z')
    // hostname should be preserved
    expect(daemons.get('d1').hostname).toBe('mac')

    handleDaemonStatus({ type: 'daemon_status', daemon_id: 'd1', status: 'online', hostname: 'mac', agents: ['claude-code'] }, daemons)
    expect(daemons.get('d1').online).toBe(true)
  })
})
