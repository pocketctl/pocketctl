import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import TokenUsage from '../TokenUsage.vue'

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: { daemon: 'daemon-1' } }),
}))

vi.mock('../../composables/useAuth', () => ({
  useAuth: () => ({
    accessToken: { value: 'tk' },
    apiGetAuth: async (url: string) => {
      const response = await fetch(url)
      return { ok: response.ok, data: await response.json() }
    },
  }),
}))

const sessionsWithChildren = {
  total: 1000, today: 100, thisMonth: 500,
  sessions: [{
    session_id: 'p1', title: 'parent', total_tokens: 1000, tok_input: 400, tok_output: 300,
    tok_cache_read: 200, tok_cache_create: 100, model: 'm', agent_type: 'claude-code', status: 'running',
    created_at: '2026-07-01T00:00:00Z',
    children: [{ agentId: 'a1', agentType: 'Explore', title: '探索', tokenIn: 100, tokenOut: 200, tokenCache: 50, tokenCacheCreate: 30 }],
  }],
}

describe('TokenUsage.vue (P1a)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true, status: 200, json: async () =>
        /\/api\/tokens\/by-daemon\//.test(url) ? sessionsWithChildren
        : { summary: { total: 1000, today: 100, thisWeek: 300, thisMonth: 500 }, dailySeries: [], byModel: [], byDaemon: [] },
    } as any)))
  })

  test('summary total 标注含子代理；session 展开显示子代理拆分行', async () => {
    const w = mount(TokenUsage)
    await flushPromises()
    // summary 卡 total 区域含「含子」标注（title 属性或文本）
    expect(w.html()).toMatch(/含子代理|incl.*subagent/i)
  })

  test('uses the host query from a host-card token destination', async () => {
    mount(TokenUsage)
    await flushPromises()

    expect(fetch).toHaveBeenCalledWith('/api/tokens/dashboard?daemon=daemon-1&days=270')
    expect(fetch).toHaveBeenCalledWith('/api/tokens/by-daemon/daemon-1')
  })
})
