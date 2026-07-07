import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

// --- localStorage mock（useAuth / useWebSocket 顶层都读 localStorage）---
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((k: string) => store[k] ?? null),
    setItem: vi.fn((k: string, v: string) => { store[k] = v }),
    removeItem: vi.fn((k: string) => { delete store[k] }),
    clear: vi.fn(() => { store = {} }),
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, configurable: true })

// --- useAuth mock（isTokenExpired 等其余导出保留真实实现）---
const { mockAccessToken, mockRefresh, mockLogout } = vi.hoisted(() => ({
  mockAccessToken: { value: '' },
  mockRefresh: vi.fn(),
  mockLogout: vi.fn(),
}))
vi.mock('../useAuth', async () => {
  const actual = await vi.importActual<any>('../useAuth')
  return { ...actual, useAuth: () => ({ accessToken: mockAccessToken, doRefreshToken: mockRefresh, logout: mockLogout }) }
})

// --- WebSocket mock：记录每次实例化的 url，暴露 onclose 供测试触发 ---
let capturedUrls: string[] = []
let lastWs: any
class FakeWS {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  url: string
  readyState = 0
  onopen: any
  onclose: any
  onmessage: any
  onerror: any
  constructor(url: string) {
    this.url = url
    capturedUrls.push(url)
    lastWs = this
  }
  close() {}
  send() {}
}

function makeToken(payload: object): string {
  return `${btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${btoa(JSON.stringify(payload))}.sig`
}

beforeEach(() => {
  localStorageMock.clear()
  mockAccessToken.value = ''
  mockRefresh.mockReset()
  mockLogout.mockReset()
  capturedUrls = []
  lastWs = null
  ;(globalThis as any).WebSocket = FakeWS
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ticket: `ticket-${capturedUrls.length + 1}`, expires_in: 60 }),
  }) as any)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useWebSocket — connect 前确保 token 新鲜', () => {
  test('access token 已过期时，connect 先刷新再用新 token 建连', async () => {
    const expired = makeToken({ exp: Math.floor(Date.now() / 1000) - 100 })
    const fresh = makeToken({ exp: Math.floor(Date.now() / 1000) + 3600 })
    mockAccessToken.value = expired
    localStorageMock.setItem('pocketctl_relay_url', 'wss://relay.test/ws')
    mockRefresh.mockImplementation(async () => {
      mockAccessToken.value = fresh
      return true
    })

    vi.resetModules()
    const { useWebSocket } = await import('../useWebSocket')
    await useWebSocket().connect()

    expect(mockRefresh).toHaveBeenCalledTimes(1)
    expect(capturedUrls).toHaveLength(1)
    expect(capturedUrls[0]).toContain('ticket=ticket-1')
    expect(capturedUrls[0]).not.toContain(encodeURIComponent(fresh))
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://relay.test/api/auth/ws-ticket',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: `Bearer ${fresh}` },
      }),
    )
  })

  test('access token 仍有效时，connect 不刷新，直接用当前 token', async () => {
    const fresh = makeToken({ exp: Math.floor(Date.now() / 1000) + 3600 })
    mockAccessToken.value = fresh
    localStorageMock.setItem('pocketctl_relay_url', 'wss://relay.test/ws')

    vi.resetModules()
    const { useWebSocket } = await import('../useWebSocket')
    await useWebSocket().connect()

    expect(mockRefresh).not.toHaveBeenCalled()
    expect(capturedUrls[0]).toContain('ticket=ticket-1')
    expect(capturedUrls[0]).not.toContain(encodeURIComponent(fresh))
  })
})

describe('useWebSocket — onclose 4001 刷新重连', () => {
  test('relay 返回 4001(invalid token) 时刷新 token 并用新 token 重连', async () => {
    const initial = makeToken({ exp: Math.floor(Date.now() / 1000) + 3600 })
    const fresh = makeToken({ exp: Math.floor(Date.now() / 1000) + 7200 })
    mockAccessToken.value = initial
    localStorageMock.setItem('pocketctl_relay_url', 'wss://relay.test/ws')
    mockRefresh.mockImplementation(async () => {
      mockAccessToken.value = fresh
      return true
    })

    vi.resetModules()
    const { useWebSocket } = await import('../useWebSocket')
    await useWebSocket().connect()
    expect(capturedUrls).toHaveLength(1)

    mockRefresh.mockClear()
    // 模拟 relay 因 token 无效关闭连接（close code 4001）
    lastWs.onclose({ code: 4001, reason: 'invalid token' })
    await new Promise((r) => setTimeout(r, 50)) // 等 refresh + 重连落地

    expect(mockRefresh).toHaveBeenCalledTimes(1)
    expect(capturedUrls.length).toBeGreaterThanOrEqual(2)
    expect(capturedUrls[capturedUrls.length - 1]).toContain('ticket=ticket-2')
    expect(capturedUrls[capturedUrls.length - 1]).not.toContain(encodeURIComponent(fresh))
  })

  test('refresh 失败时登出，不再重连', async () => {
    mockAccessToken.value = makeToken({ exp: Math.floor(Date.now() / 1000) + 3600 })
    localStorageMock.setItem('pocketctl_relay_url', 'wss://relay.test/ws')
    mockRefresh.mockResolvedValue(false)

    vi.resetModules()
    const { useWebSocket } = await import('../useWebSocket')
    await useWebSocket().connect()
    const firstCount = capturedUrls.length

    lastWs.onclose({ code: 4001, reason: 'invalid token' })
    await new Promise((r) => setTimeout(r, 50))

    expect(mockRefresh).toHaveBeenCalledTimes(1)
    expect(mockLogout).toHaveBeenCalledTimes(1)
    expect(capturedUrls.length).toBe(firstCount) // refresh 失败，不重连
  })
})
