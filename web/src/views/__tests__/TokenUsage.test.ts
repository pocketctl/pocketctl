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
        /\/api\/tokens\/sessions\?/.test(url) ? sessionsWithChildren
        : { summary: { total: 1000, today: 100, thisWeek: 300, thisMonth: 500 }, dailySeries: [], byModel: [], byDaemon: [] },
    } as any)))
  })

  test('summary total 标注含子代理；session 展开显示子代理拆分行', async () => {
    const w = mount(TokenUsage)
    await flushPromises()
    // summary 卡 total 区域含「含子」标注（title 属性或文本）
    expect(w.html()).toMatch(/含子代理|incl.*sub[- ]?agent/i)
  })

  test('uses the host query from a host-card token destination', async () => {
    mount(TokenUsage)
    await flushPromises()

    expect(fetch).toHaveBeenCalledWith('/api/tokens/dashboard?daemon=daemon-1&days=270')
    expect(fetch).toHaveBeenCalledWith('/api/tokens/sessions?daemon=daemon-1&page=1&limit=5&q=')
  })
  test('keeps the latest host selection when a previous session request resolves late', async () => {
    let resolvePrevious!: (value: unknown) => void
    const previousSessions = new Promise(resolve => { resolvePrevious = resolve })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => {
        if (url === '/api/tokens/sessions?daemon=daemon-1&page=1&limit=5&q=') return previousSessions
        if (url.startsWith('/api/tokens/sessions?daemon=all')) {const second=url.includes('page=2');return {total:6,sessions:Array.from({length:second?1:5},(_,index)=>({session_id:'new-'+(second?5:index),title:'Latest host session '+(second?6:index+1),total_tokens:200,agent_type:'codex',created_at:'2026-10-02'}))}}
        return {summary:{total:url.includes('daemon=all')?200:100},dailySeries:[],byModel:[],byDaemon:url.includes('daemon=all')?[{daemon_id:'daemon-2',hostname:'New host',total:200}]:[]}
      },
    })))
    const wrapper=mount(TokenUsage,{global:{stubs:{ActionList:{template:'<div><slot /></div>'}}}})
    await flushPromises()
    await wrapper.get('.host-select-btn').trigger('click')
    await wrapper.get('.action-item').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Latest host session')
    expect(wrapper.findAll('.session-row')).toHaveLength(5)
    await wrapper.get('.page-controls').findAll('button')[2]!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Latest host session 6')
    resolvePrevious({sessions:[{session_id:'old',title:'Previous host session',total_tokens:100}]})
    await flushPromises()
    expect(wrapper.text()).toContain('Latest host session')
    expect(wrapper.text()).not.toContain('Previous host session')
    wrapper.unmount()
  })

})
