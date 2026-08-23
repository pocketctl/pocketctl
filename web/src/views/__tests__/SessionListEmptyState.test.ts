import { flushPromises, shallowMount } from '@vue/test-utils'
import { ref } from 'vue'
import { describe, expect, test, vi } from 'vitest'
import SessionList from '../SessionList.vue'

let emitEvent: ((event: any) => void) | undefined

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ query: {} }),
}))

vi.mock('../../composables/useWebSocket', () => ({
  useWebSocket: () => ({
    connect: vi.fn(),
    send: vi.fn(() => true),
    onEvent: (callback: (event: any) => void) => {
      emitEvent = callback
      return () => undefined
    },
    effectiveStatus: ({ status }: { status: string }) => status,
  }),
}))

vi.mock('../../composables/useAuth', () => ({
  useAuth: () => ({
    isLoggedIn: ref(true),
    accessToken: ref('token'),
    logout: vi.fn(),
  }),
}))

describe('SessionList empty state', () => {
  test('waits for the session query before showing the daemon installation guide', async () => {
    const wrapper = shallowMount(SessionList)

    expect(wrapper.find('[data-state="loading-sessions"]').exists()).toBe(true)
    expect(wrapper.find('[data-state="daemon-install-guide"]').exists()).toBe(false)

    emitEvent?.({ type: 'session_list', sessions: [] })
    await flushPromises()

    expect(wrapper.find('[data-state="loading-sessions"]').exists()).toBe(false)
    expect(wrapper.find('[data-state="daemon-install-guide"]').exists()).toBe(true)
  })
})
