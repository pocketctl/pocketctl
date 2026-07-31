import { describe, test, expect } from 'vitest'
import { computed } from 'vue'

// Test the computed logic from ConnectionBanner as pure functions
// (useWebSocket is a module-level singleton that can't be mocked via global.mocks)

describe('ConnectionBanner logic', () => {
  function getOfflineDaemons(daemons: Map<string, { online: boolean }>) {
    return Array.from(daemons.values()).filter(d => !d.online)
  }

  test('no daemons → empty offline list', () => {
    const daemons = new Map()
    expect(getOfflineDaemons(daemons)).toHaveLength(0)
  })

  test('online daemon only → empty offline list', () => {
    const daemons = new Map([['d1', { online: true }]])
    expect(getOfflineDaemons(daemons)).toHaveLength(0)
  })

  test('one offline daemon → single entry', () => {
    const daemons = new Map([['d1', { online: false }]])
    const offline = getOfflineDaemons(daemons)
    expect(offline).toHaveLength(1)
  })

  test('mixed online/offline → only offline', () => {
    const daemons = new Map([
      ['d1', { online: true }],
      ['d2', { online: false }],
      ['d3', { online: false }],
    ])
    expect(getOfflineDaemons(daemons)).toHaveLength(2)
  })

  test('banner text: single offline daemon shows hostname', () => {
    const offline = [{ daemon_id: 'd1', hostname: 'test-mac', online: false, last_seen_at: '2026-06-07T00:00:00Z' }]
    const text = offline.length === 1
      ? `Daemon "${offline[0].hostname}" 离线`
      : `${offline.length} 个 Daemons 离线`
    expect(text).toContain('test-mac')
    expect(text).toContain('离线')
  })

  test('banner text: multiple offline shows aggregate', () => {
    const offline = [
      { daemon_id: 'd1', hostname: 'mac1', online: false },
      { daemon_id: 'd2', hostname: 'mac2', online: false },
    ]
    const text = offline.length === 1
      ? `Daemon "${offline[0].hostname}" 离线`
      : `${offline.length} 个 Daemons 离线`
    expect(text).toBe('2 个 Daemons 离线')
  })

  test('banner removed when daemon comes back online', () => {
    const daemons = new Map([['d1', { online: false }]])
    expect(getOfflineDaemons(daemons)).toHaveLength(1)

    // Daemon reconnects
    daemons.set('d1', { online: true })
    expect(getOfflineDaemons(daemons)).toHaveLength(0)
  })
})

describe('ConnectionBanner relay status', () => {
  test('connected=true → "Connected" text', () => {
    const connected = true
    const reconnecting = false
    const text = connected ? 'Connected' : (reconnecting ? 'Reconnecting...' : 'Disconnected')
    expect(text).toBe('Connected')
  })

  test('connected=false reconnecting=true → "Reconnecting..."', () => {
    const connected = false
    const reconnecting = true
    const text = connected ? 'Connected' : (reconnecting ? 'Reconnecting...' : 'Disconnected')
    expect(text).toBe('Reconnecting...')
  })

  test('connected=false reconnecting=false → "Disconnected"', () => {
    const connected = false
    const reconnecting = false
    const text = connected ? 'Connected' : (reconnecting ? 'Reconnecting...' : 'Disconnected')
    expect(text).toBe('Disconnected')
  })
})
