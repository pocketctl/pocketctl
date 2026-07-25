import { shallowMount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { describe, expect, test, vi } from 'vitest'
import SessionList from '../SessionList.vue'
import NewSessionDialog from '../../components/NewSessionDialog.vue'

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ query: {} }),
}))

vi.mock('../../composables/useWebSocket', () => ({
  useWebSocket: () => ({
    connect: vi.fn(),
    send: vi.fn(() => true),
    onEvent: vi.fn(() => () => undefined),
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

describe('SessionList mobile top bar actions', () => {
  test('opens the new-session dialog when the mobile shell + button is pressed', async () => {
    const trigger = ref(0)
    const wrapper = shallowMount(SessionList, {
      global: {
        provide: { triggerNewSession: trigger },
      },
    })

    expect(wrapper.findComponent(NewSessionDialog).exists()).toBe(false)
    trigger.value++
    await nextTick()

    expect(wrapper.findComponent(NewSessionDialog).exists()).toBe(true)
  })
})
