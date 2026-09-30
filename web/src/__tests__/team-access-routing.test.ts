import { ref } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ allowed: false, token: 'fixture', refresh: vi.fn() }))
vi.mock('../composables/useAuth', () => ({ useAuth: () => ({ accessToken: ref(state.token), doRefreshToken: async () => false }) }))
vi.mock('../composables/useTeamAccess', () => ({ useTeamAccess: () => ({ refresh: state.refresh }) }))
import { createPocketctlRouter } from '../router'

beforeEach(() => {
  state.token = 'fixture'; state.allowed = false
  state.refresh.mockReset().mockImplementation(async () => state.allowed)
  window.history.replaceState({}, '', '/app/sessions')
})

describe('Team route qualification', () => {
  test('denies all Team deep links, then allows them after the server grants access', async () => {
    const router = createPocketctlRouter()
    const paths = ['/teams', '/team/ctm_one/sessions', '/team/ctm_one/session/css_one']
    for (const path of paths) {
      await router.push(path)
      expect(router.currentRoute.value.path).toBe('/sessions')
    }
    state.allowed = true
    for (const path of paths) {
      await router.push(path)
      expect(router.currentRoute.value.path).toBe(path)
    }
    state.allowed = false
    await router.push('/teams')
    expect(router.currentRoute.value.path).toBe('/sessions')
  })

  test('leaves personal routes available and requires login before asking for Team access', async () => {
    const router = createPocketctlRouter()
    await router.push('/session/native-one')
    expect(router.currentRoute.value.path).toBe('/session/native-one')
    expect(state.refresh).not.toHaveBeenCalled()
    state.token = ''
    await router.push('/teams')
    expect(router.currentRoute.value.path).toBe('/login')
    expect(state.refresh).not.toHaveBeenCalled()
  })
})
