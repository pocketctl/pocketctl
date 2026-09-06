import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import MobileTopBar from '../MobileTopBar.vue'

const push = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
}))

vi.mock('../../composables/useLocale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}))

function mountBar(props: Partial<InstanceType<typeof MobileTopBar>['$props']> = {}) {
  return mount(MobileTopBar, {
    props: {
      title: 'Migration plan',
      connected: true,
      reconnecting: false,
      isSession: true,
      showNewSession: false,
      ...props,
    },
  })
}

describe('mobile top bar back navigation', () => {
  beforeEach(() => {
    push.mockClear()
  })

  test('returns to the host session list with the host query preserved', async () => {
    const wrapper = mountBar({ sessionHostId: 'daemon-1' })

    await wrapper.get('.mobile-topbar-back').trigger('click')

    expect(push).toHaveBeenCalledWith({ path: '/sessions', query: { host: 'daemon-1' } })
  })

  test('falls back to the plain session list when the host id is unknown', async () => {
    const wrapper = mountBar()

    await wrapper.get('.mobile-topbar-back').trigger('click')

    expect(push).toHaveBeenCalledWith('/sessions')
  })
})
