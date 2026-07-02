import { describe, test, expect, vi } from 'vitest'

// useAuth 模块顶层即读 localStorage，必须在 import 之前 mock（同 useAuth.test.ts 的处理）。
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

const { isTokenExpired } = await import('../useAuth')

// JWT payload 段是 base64url 编码的 JSON。短 JSON 不含 +/ 字符，btoa 产出的
// 标准 base64 与 base64url 等价，足够构造测试用 token。
function makeToken(payload: object): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = btoa(JSON.stringify(payload))
  return `${header}.${body}.sig`
}

// 固定“当前时间”，避免测试依赖系统时钟（与 rate-limit.ts 的可注入时钟同思路）。
const NOW = 1_700_000_000

describe('isTokenExpired', () => {
  test('未过期 token 返回 false', () => {
    const token = makeToken({ exp: NOW + 3600 })
    expect(isTokenExpired(token, 30, NOW)).toBe(false)
  })

  test('已过期 token 返回 true', () => {
    const token = makeToken({ exp: NOW - 3600 })
    expect(isTokenExpired(token, 30, NOW)).toBe(true)
  })

  test('在 skew 窗口内（即将过期）返回 true，提前触发刷新', () => {
    // exp 距 now 仅 10 秒，skew=30 → 视为已过期
    const token = makeToken({ exp: NOW + 10 })
    expect(isTokenExpired(token, 30, NOW)).toBe(true)
  })

  test('刚超出 skew 的 token 返回 false（仍有缓冲）', () => {
    const token = makeToken({ exp: NOW + 60 })
    expect(isTokenExpired(token, 30, NOW)).toBe(false)
  })

  test('无效 token 返回 true（保守触发刷新）', () => {
    expect(isTokenExpired('garbage', 30, NOW)).toBe(true)
  })

  test('空 token 返回 true', () => {
    expect(isTokenExpired('', 30, NOW)).toBe(true)
  })

  test('payload 无 exp 字段返回 true（保守）', () => {
    const token = makeToken({ sub: 'user-1' })
    expect(isTokenExpired(token, 30, NOW)).toBe(true)
  })
})
