import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SessionList from '../SessionList.vue'

// --- fmtTk pure logic (mirrors SessionList.vue implementation) ---
function fmtTk(n: number) {
  n = +n || 0
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K'
  return '' + n
}

describe('fmtTk formatting', () => {
  test('formats thousands as K', () => {
    expect(fmtTk(12345)).toBe('12K')
  })
  test('formats millions as M', () => {
    expect(fmtTk(2500000)).toBe('2.5M')
  })
  test('returns raw number for small values', () => {
    expect(fmtTk(42)).toBe('42')
  })
  test('handles zero', () => {
    expect(fmtTk(0)).toBe('0')
  })
})

// --- Mount test for token pill rendering ---
vi.mock('../../composables/useWebSocket', () => ({
  useWebSocket: () => ({
    connect: vi.fn(),
    send: vi.fn(),
    effectiveStatus: () => 'online',
    onEvent: (cb: any) => {
      setTimeout(() => cb({
        type: 'session_list',
        sessions: [
          {
            session_id: 'p1',
            status: 'running',
            agent_type: 'claude-code',
            created_at: '2026-07-01T00:00:00Z',
            title: 'test session',
            source: 'daemon',
            daemon_id: 'd1',
            subagent_count: 2,
            totalTokens: 12345,
          },
        ],
      }), 0)
      return () => {}
    },
  }),
}))
vi.mock('../../composables/useAuth', () => ({
  useAuth: () => ({ isLoggedIn: true, logout: vi.fn() }),
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

describe('SessionList.vue — token pill (P1a)', () => {
  beforeEach(() => {
    localStorage.setItem('pocketctl_access_token', 'tk')
  })

  test('renders 🪙 token pill with formatted totalTokens (12K)', async () => {
    const w = mount(SessionList, {
      global: {
        stubs: ['router-link', 'AgentBadge', 'SessionActions', 'NewSessionDialog'],
      },
    })
    await flushPromises()
    await new Promise((r) => setTimeout(r, 10))

    // 12345 → "12K" via fmtTk
    expect(w.html()).toMatch(/12K/)
    // Pill should use 🪙 icon (distinct from 🤖 subagent badge)
    expect(w.html()).toMatch(/🪙/)
  })
})
