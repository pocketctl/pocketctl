import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import SessionList from '../SessionList.vue'

const mockSessions = [
  {
    session_id: 'parent1',
    status: 'running',
    agent_type: 'claude-code',
    created_at: '2026-07-01T00:00:00Z',
    last_activity_at: '2026-07-01T01:00:00Z',
    title: 'Parent Session',
    source: 'daemon',
    daemon_id: 'd1',
    subagent_count: 2,
    totalTokens: 50000,
    children: [
      { agentId: 'child1', agentType: 'claude-code', title: 'Research task', tokenIn: 1000, tokenOut: 500 },
      {
        agentId: '019f4ad3-342e-7213-a51f-2758edf9ec6b',
        kind: 'codex_subagent',
        agentType: 'codex',
        title: 'Newton',
        status: 'completed',
        tokenIn: 0,
        tokenOut: 0,
      },
    ],
  },
  {
    session_id: 'subagent_alone',
    status: 'running',
    agent_type: 'claude-code',
    created_at: '2026-07-01T00:00:00Z',
    title: 'Subagent Session',
    source: 'daemon',
    daemon_id: 'd1',
    is_subagent: true,
    parent_session_id: 'some_parent',
    totalTokens: 2000,
  },
  {
    session_id: 'plain_session',
    status: 'idle',
    agent_type: 'claude-code',
    created_at: '2026-07-01T00:00:00Z',
    title: 'Plain Session',
    source: 'daemon',
    daemon_id: 'd1',
    totalTokens: 0,
  },
]

const mockPush = vi.fn()

vi.mock('../../composables/useWebSocket', () => ({
  useWebSocket: () => ({
    connect: vi.fn(),
    send: vi.fn(),
    effectiveStatus: () => 'online',
    onEvent: (cb: any) => {
      setTimeout(() => cb({ type: 'session_list', sessions: mockSessions }), 0)
      return () => {}
    },
  }),
}))
vi.mock('../../composables/useAuth', () => ({
  useAuth: () => ({ isLoggedIn: { value: true }, accessToken: { value: 'tk' }, logout: vi.fn() }),
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useRoute: () => ({ query: {} }),
}))

describe('SessionList.vue — subagent fold (P2)', () => {
  beforeEach(() => {
    mockPush.mockClear()
  })

  test('uses the semantic success background for child token usage', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/views/SessionList.vue'), 'utf8')

    expect(source).toMatch(/\.child-token\s*\{[^}]*background:\s*var\(--success-bg/m)
    expect(source).toMatch(/\.child-token\s*\{[^}]*color:\s*var\(--success/m)
  })

  test('filters out is_subagent sessions from top-level list', async () => {
    const w = mount(SessionList, {
      global: {
        stubs: ['router-link', 'AgentBadge', 'SessionActions', 'NewSessionDialog'],
      },
    })
    await flushPromises()
    await new Promise((r) => setTimeout(r, 10))

    // subagent_alone should NOT appear
    expect(w.text()).not.toContain('Subagent Session')
    // Parent and plain should appear
    expect(w.text()).toContain('Parent Session')
    expect(w.text()).toContain('Plain Session')
  })

  test('renders fold toggle (▸) on sessions with children', async () => {
    const w = mount(SessionList, {
      global: {
        stubs: ['router-link', 'AgentBadge', 'SessionActions', 'NewSessionDialog'],
      },
    })
    await flushPromises()
    await new Promise((r) => setTimeout(r, 10))

    // parent1 has children — should show ▸ (collapsed by default)
    expect(w.html()).toContain('▸')
    // plain_session has no children — should NOT show ▸
    const plainRow = w.findAll('.session-row').find(r => r.text().includes('Plain Session'))
    if (plainRow) {
      expect(plainRow.html()).not.toContain('▸')
    }
  })

  test('clicking fold toggle expands children, does not navigate', async () => {
    const w = mount(SessionList, {
      global: {
        stubs: ['router-link', 'AgentBadge', 'SessionActions', 'NewSessionDialog'],
      },
    })
    await flushPromises()
    await new Promise((r) => setTimeout(r, 10))

    // Children should NOT be visible initially
    expect(w.text()).not.toContain('Research task')

    // Click the fold toggle
    const toggle = w.find('.fold-toggle')
    expect(toggle.exists()).toBe(true)
    await toggle.trigger('click')

    // Now children should be visible
    expect(w.text()).toContain('Research task')
    expect(w.text()).toContain('↳')

    // Clicking fold toggle should NOT trigger navigation
    expect(mockPush).not.toHaveBeenCalled()
  })

  test('child rows show token pill when tokens > 0', async () => {
    const w = mount(SessionList, {
      global: {
        stubs: ['router-link', 'AgentBadge', 'SessionActions', 'NewSessionDialog'],
      },
    })
    await flushPromises()
    await new Promise((r) => setTimeout(r, 10))

    // Expand fold
    await w.find('.fold-toggle').trigger('click')

    // child1 has tokenIn=1000 + tokenOut=500 = 1500 → "2K" (fmtTk rounds 1500 to "1K"? no, 1500 >= 1000 → (1500/1000).toFixed(0) = "2")
    // Wait, fmtTk: 1500/1000 = 1.5, toFixed(0) = "2", so "2K"
    // Actually let me re-check: n >= 1e3 → (n/1e3).toFixed(0) = "2" → "2K"
    // Hmm, 1500/1000 = 1.5, toFixed(0) rounds to "2", so "2K"
    expect(w.html()).toMatch(/2K/)
  })

  test('child with no tokens does not show token pill', async () => {
    const w = mount(SessionList, {
      global: {
        stubs: ['router-link', 'AgentBadge', 'SessionActions', 'NewSessionDialog'],
      },
    })
    await flushPromises()
    await new Promise((r) => setTimeout(r, 10))

    await w.find('.fold-toggle').trigger('click')

    // child2 has tokenIn=0, tokenOut=0 — should show "codex" as title fallback but no token pill
    const childRows = w.findAll('.child-row')
    expect(childRows.length).toBe(2)
    // child2 should not have a .child-token element
    const child2 = childRows[1]
    expect(child2.find('.child-token').exists()).toBe(false)
  })

  test('Codex child routes through its existing root session', async () => {
    const w = mount(SessionList, {
      global: {
        stubs: ['router-link', 'AgentBadge', 'SessionActions', 'NewSessionDialog'],
      },
    })
    await flushPromises()
    await new Promise((r) => setTimeout(r, 10))

    await w.find('.fold-toggle').trigger('click')
    const codexChild = w.findAll('.child-row').find((row) => row.text().includes('Newton'))
    expect(codexChild).toBeDefined()
    await codexChild!.trigger('click')
    expect(mockPush).toHaveBeenCalledWith('/session/parent1?subagent=019f4ad3-342e-7213-a51f-2758edf9ec6b')
  })

  test('toggling fold twice collapses children', async () => {
    const w = mount(SessionList, {
      global: {
        stubs: ['router-link', 'AgentBadge', 'SessionActions', 'NewSessionDialog'],
      },
    })
    await flushPromises()
    await new Promise((r) => setTimeout(r, 10))

    const toggle = w.find('.fold-toggle')
    await toggle.trigger('click')
    expect(w.text()).toContain('Research task')

    await toggle.trigger('click')
    expect(w.text()).not.toContain('Research task')
  })
})
