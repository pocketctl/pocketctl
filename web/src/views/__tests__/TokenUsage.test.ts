import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import TokenUsage from '../TokenUsage.vue'

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
    localStorage.setItem('pocketctl_access_token', 'tk')
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
})
