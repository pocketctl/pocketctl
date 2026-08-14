import { describe, expect, test } from 'vitest'
import { appRoutes, resolveAuthenticatedLanding } from '../../router'
import { isPwaMobileShellEnabled } from '../../composables/useEnv'

describe('mobile routing', () => {
  test('registers an explicit authenticated sessions route', () => {
    const route = appRoutes.find(candidate => candidate.path === '/sessions')
    expect(route?.meta?.requiresAuth).toBe(true)
  })

  test('registers an authenticated Attention Inbox route without replacing existing mobile destinations', () => {
    const route = appRoutes.find(candidate => candidate.path === '/inbox')
    expect(route?.meta?.requiresAuth).toBe(true)
    expect(appRoutes.some(candidate => candidate.path === '/sessions')).toBe(true)
    expect(appRoutes.some(candidate => candidate.path === '/hosts')).toBe(true)
    expect(appRoutes.some(candidate => candidate.path === '/settings')).toBe(true)
  })

  test('sends only mobile users with the feature enabled from home to sessions', () => {
    expect(resolveAuthenticatedLanding('/', true, true)).toBe('/sessions')
    expect(resolveAuthenticatedLanding('/', true, false)).toBeNull()
    expect(resolveAuthenticatedLanding('/', false, true)).toBeNull()
    expect(resolveAuthenticatedLanding('/settings', true, true)).toBeNull()
  })

  test('enables the mobile shell unless explicitly disabled', () => {
    expect(isPwaMobileShellEnabled(undefined)).toBe(true)
    expect(isPwaMobileShellEnabled('true')).toBe(true)
    expect(isPwaMobileShellEnabled('false')).toBe(false)
  })
})
