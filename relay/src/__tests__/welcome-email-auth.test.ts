import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, test, vi } from 'vitest'

process.env.JWT_SECRET ||= 'welcome-email-auth-test-secret'

const getUserByEmail = vi.fn()
const createUserWithWelcomeEmail = vi.fn()

vi.mock('../db.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../db.js')>()),
  getUserByEmail,
  createUserWithWelcomeEmail,
}))

describe('findOrCreateEmailUser', () => {
  beforeEach(() => vi.clearAllMocks())

  test('returns an existing user without creating or enqueueing', async () => {
    const existing = { id: 1, email: 'person@example.com' }
    getUserByEmail.mockResolvedValue(existing)
    const { findOrCreateEmailUser } = await import('../email-user.js')

    await expect(findOrCreateEmailUser({} as any, 'person@example.com', 'Person', 'en')).resolves.toBe(existing)
    expect(createUserWithWelcomeEmail).not.toHaveBeenCalled()
  })

  test('creates a missing user with normalized email and locale', async () => {
    const created = { id: 2, email: 'person@example.com' }
    getUserByEmail.mockResolvedValue(null)
    createUserWithWelcomeEmail.mockResolvedValue(created)
    const { findOrCreateEmailUser } = await import('../email-user.js')

    await expect(findOrCreateEmailUser({} as any, ' Person@Example.COM ', 'Person', 'zh')).resolves.toBe(created)
    expect(createUserWithWelcomeEmail).toHaveBeenCalledWith({}, 'person@example.com', '', 'Person', 'zh')
  })

  test('reloads the winner after a unique-email creation race', async () => {
    const winner = { id: 3, email: 'person@example.com' }
    getUserByEmail.mockResolvedValueOnce(null).mockResolvedValueOnce(winner)
    createUserWithWelcomeEmail.mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }))
    const { findOrCreateEmailUser } = await import('../email-user.js')

    await expect(findOrCreateEmailUser({} as any, 'person@example.com', 'Person', 'en')).resolves.toBe(winner)
    expect(createUserWithWelcomeEmail).toHaveBeenCalledTimes(1)
  })

  test('propagates non-unique database errors', async () => {
    const error = Object.assign(new Error('database unavailable'), { code: '08006' })
    getUserByEmail.mockResolvedValue(null)
    createUserWithWelcomeEmail.mockRejectedValue(error)
    const { findOrCreateEmailUser } = await import('../email-user.js')

    await expect(findOrCreateEmailUser({} as any, 'person@example.com', 'Person', 'en')).rejects.toBe(error)
  })
})

describe('auth route integration', () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/server.ts', import.meta.url)), 'utf8')

  test('verification resolves locale and binds a supplied stable machine ID', () => {
    expect(source).toMatch(/const \{ email, code, lang: bodyLang, machine_id: requestedMachineId \} = req\.body as any/)
    expect(source).toContain("resolveLanguage(bodyLang, req.headers['accept-language'])")
    expect(source).toContain('findOrCreateEmailUser(pool, normalizedEmail, displayName, locale)')
    expect(source).toContain('const machineId = stableMachineId(requestedMachineId)')
    expect(source).toContain('signAccessToken(user.id, user.email, user.phone ?? undefined, machineId)')
    expect(source).toContain('signRefreshToken(user.id, machineId)')
  })

  test('Chinese device authorization page explicitly sends its displayed language', () => {
    expect(source).toContain('<html lang="zh-CN"')
    expect(source).toContain("api('/api/auth/email/send', { email, lang: 'zh' })")
    expect(source).toContain("api('/api/auth/email/verify', { email, code, lang: 'zh' })")
  })

  test('password registration cannot create an account for an unverified email', () => {
    const routeStart = source.indexOf("app.post('/api/auth/register'")
    const nextRoute = source.indexOf("app.post('/api/auth/login'", routeStart)
    expect(routeStart).toBeGreaterThan(-1)
    expect(nextRoute).toBeGreaterThan(routeStart)

    const registrationRoute = source.slice(routeStart, nextRoute)
    expect(registrationRoute).toContain('reply.code(410)')
    expect(registrationRoute).toContain('/api/auth/email/send')
    expect(registrationRoute).not.toContain('createUserWithWelcomeEmail')
  })

  test('legacy password login cannot retain access to a pre-hijacked email account', () => {
    const routeStart = source.indexOf("app.post('/api/auth/login'")
    const nextRoute = source.indexOf("app.post('/api/auth/refresh'", routeStart)
    expect(routeStart).toBeGreaterThan(-1)
    expect(nextRoute).toBeGreaterThan(routeStart)

    const loginRoute = source.slice(routeStart, nextRoute)
    expect(loginRoute).toContain('reply.code(410)')
    expect(loginRoute).toContain('/api/auth/email/send')
    expect(loginRoute).not.toContain('verifyPassword')
    expect(loginRoute).not.toContain('signAccessToken')
    expect(loginRoute).not.toContain('signRefreshToken')
  })

  test('worker starts after database initialization unless shutdown already began', () => {
    expect(source.indexOf('startRelayBackgroundWorkers({')).toBeGreaterThan(source.indexOf('.then(async () =>'))
    expect(source).toMatch(/if \(!shuttingDown\) \{\s*await startRelayBackgroundWorkers\(/)
  })

  test('shutdown awaits worker drain before closing the pool', () => {
    expect(source).toContain('await welcomeEmailWorker.stop()')
    expect(source).toContain('await closeRelayPools(pools)')
    expect(source.indexOf('await welcomeEmailWorker.stop()')).toBeLessThan(
      source.indexOf('await closeRelayPools(pools)'),
    )
  })
})
