import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateSubagentTitle, generateTitle } from '../title.js'

// --- fetch 响应构造器 ---

const ok = (content: string) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: { get: () => null },
  json: async () => ({ choices: [{ message: { content } }] }),
})

const httpError = (status: number, statusText = '', retryAfter?: string) => ({
  ok: false,
  status,
  statusText,
  headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null) },
  json: async () => ({}),
})

describe('generateTitle - 失败语义与重试', () => {
  beforeEach(() => {
    delete process.env.MIMO_API_KEY
    process.env.DEEPSEEK_API_KEY = 'test-key'
  })
  afterEach(() => {
    delete process.env.MIMO_API_KEY
    vi.restoreAllMocks()
  })

  test('MIMO_API_KEY 已设 → 优先使用 mimo-v2.6-flash 并显式关闭思考', async () => {
    process.env.MIMO_API_KEY = 'mimo-test-key'
    global.fetch = vi.fn().mockResolvedValue(ok('MiMo 标题'))

    expect(await generateTitle('帮我写登录', '好的')).toBe('MiMo 标题')
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(global.fetch).mock.calls[0]!
    expect(String(url)).toBe('https://api.xiaomimimo.com/v1/chat/completions')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer mimo-test-key')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'mimo-v2.6-flash',
      thinking: { type: 'disabled' },
      stream: false,
    })
    expect(body).toHaveProperty('max_completion_tokens')
    expect(body).not.toHaveProperty('max_tokens')
  })

  test('MiMo 超时 → fallback 到现有 DeepSeek 路径', async () => {
    process.env.MIMO_API_KEY = 'mimo-test-key'
    global.fetch = vi.fn()
      .mockRejectedValueOnce(new DOMException('timed out', 'AbortError'))
      .mockResolvedValueOnce(ok('DeepSeek 回退'))

    expect(await generateTitle('u', 'a')).toBe('DeepSeek 回退')
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(String(vi.mocked(global.fetch).mock.calls[0]![0])).toContain('xiaomimimo.com')
    expect(String(vi.mocked(global.fetch).mock.calls[1]![0])).toContain('api.deepseek.com')
  })

  test('MiMo 非超时错误 → 不静默 fallback 到 DeepSeek', async () => {
    process.env.MIMO_API_KEY = 'mimo-test-key'
    global.fetch = vi.fn().mockResolvedValue(httpError(401, 'Unauthorized'))

    expect(await generateTitle('u', 'a')).toBe('')
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  test('subagent title 与 session title 使用相同的 MiMo 优先路由', async () => {
    process.env.MIMO_API_KEY = 'mimo-test-key'
    global.fetch = vi.fn().mockResolvedValue(ok('审查 · relay/src'))

    expect(await generateSubagentTitle('审查 relay', 'code-reviewer')).toBe('审查 · relay/src')
    expect(String(vi.mocked(global.fetch).mock.calls[0]![0])).toContain('xiaomimimo.com')
  })

  test('DEEPSEEK_API_KEY 未设 → 返回空串，不调 fetch', async () => {
    delete process.env.DEEPSEEK_API_KEY
    global.fetch = vi.fn()
    expect(await generateTitle('hi', 'hello')).toBe('')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('200 成功 → 返回 cleanTitle', async () => {
    global.fetch = vi.fn().mockResolvedValue(ok('实现登录页'))
    expect(await generateTitle('帮我写登录', '好的')).toBe('实现登录页')
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  test('200 但 content 为空 → 重试耗尽后返回空串', async () => {
    global.fetch = vi.fn().mockResolvedValue(ok('   '))
    expect(await generateTitle('u', 'a')).toBe('')
    expect(global.fetch).toHaveBeenCalledTimes(3) // 初次 + 2 重试
  })

  test('429 后 200 → 重试一次成功', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(httpError(429, 'Too Many Requests'))
      .mockResolvedValueOnce(ok('重试成功'))
    expect(await generateTitle('u', 'a')).toBe('重试成功')
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  test('持续 429（重试耗尽）→ 返回空串，共 3 次尝试', async () => {
    global.fetch = vi.fn().mockResolvedValue(httpError(429))
    expect(await generateTitle('u', 'a')).toBe('')
    expect(global.fetch).toHaveBeenCalledTimes(3)
  })

  test('401 不可重试 → 立即返回空串，只调 1 次', async () => {
    global.fetch = vi.fn().mockResolvedValue(httpError(401, 'Unauthorized'))
    expect(await generateTitle('u', 'a')).toBe('')
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  test('网络错误（fetch reject）→ 重试后成功', async () => {
    global.fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(ok('网络恢复'))
    expect(await generateTitle('u', 'a')).toBe('网络恢复')
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  test('成功路径不返回 fallback 截断串（失败才不写库的关键）', async () => {
    // 即使 user message 很长，成功时返回的是 DeepSeek 的 cleanTitle，不是截断
    global.fetch = vi.fn().mockResolvedValue(ok('短标题'))
    const title = await generateTitle('这是一条非常非常长的用户消息'.repeat(10), 'assistant')
    expect(title).toBe('短标题')
    expect(title.length).toBeLessThanOrEqual(15)
  })
})
