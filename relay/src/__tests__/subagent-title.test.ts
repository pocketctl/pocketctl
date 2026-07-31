import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateSubagentTitle } from '../title.js'

describe('title.generateSubagentTitle', () => {
  const origKey = process.env.DEEPSEEK_API_KEY
  beforeEach(() => { process.env.DEEPSEEK_API_KEY = 'test-key' })
  afterEach(() => { process.env.DEEPSEEK_API_KEY = origKey })

  test('returns cleaned title from DeepSeek response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({ choices: [{ message: { content: '审查 · docker-compose.prod.yml' } }] }),
    } as any)
    const t = await generateSubagentTitle('Review docker-compose.prod.yml for security', 'security-review', 'zh')
    expect(t).toBe('审查 · docker-compose.')
    fetchMock.mockRestore()
  })

  test('passes agent_type into the system prompt', async () => {
    let capturedSystem = ''
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, opts: any) => {
      const sys = JSON.parse(opts.body).messages.find((m: any) => m.role === 'system').content
      capturedSystem = sys
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: '探索 · relay/src' } }] }) } as any
    })
    await generateSubagentTitle('find the relay API code', 'Explore', 'en')
    expect(capturedSystem).toContain('Explore')
    fetchMock.mockRestore()
  })

  test('enforces 20-char cap', async () => {
    const long = '这是一个非常非常非常非常非常非常非常非常长的子代理标题超过二十个字'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, headers: new Map(),
      json: async () => ({ choices: [{ message: { content: long } }] }),
    } as any)
    const t = await generateSubagentTitle('task', 'Explore')
    expect(t.length).toBeLessThanOrEqual(20)
    fetchMock.mockRestore()
  })

  test('returns empty string when DEEPSEEK_API_KEY unset', async () => {
    delete process.env.DEEPSEEK_API_KEY
    expect(await generateSubagentTitle('task', 'Explore')).toBe('')
  })
})
