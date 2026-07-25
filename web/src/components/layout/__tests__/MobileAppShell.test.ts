import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { describe, expect, test, vi } from 'vitest'
import { ref } from 'vue'

const mobile = ref(true)
const loggedIn = ref(true)
const connected = ref(true)

vi.mock('../../../composables/useResponsiveLayout', () => ({
  useResponsiveLayout: () => ({ isMobile: mobile }),
}))
vi.mock('../../../composables/useEnv', () => ({
  isPwaMobileShellEnabled: () => true,
}))
vi.mock('../../../composables/useAuth', () => ({
  useAuth: () => ({
    isLoggedIn: loggedIn,
    user: ref({ display_name: 'Mobile User', plan: 'free' }),
  }),
}))
vi.mock('../../../composables/useWebSocket', () => ({
  useWebSocket: () => ({ connected, reconnecting: ref(false) }),
}))

function testRouter(path = '/sessions') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/sessions', component: { template: '<div>Sessions content</div>' } },
      { path: '/settings', component: { template: '<div>Settings content</div>' } },
      { path: '/session/:id', component: { template: '<div>Session content</div>' } },
    ],
  })
  router.push(path)
  return router
}

describe('mobile application shell', () => {
  test('replaces the desktop sidebar with accessible mobile navigation', async () => {
    const router = testRouter()
    await router.isReady()
    const App = (await import('../../../App.vue')).default
    const wrapper = mount(App, { global: { plugins: [router] } })

    expect(wrapper.find('.mobile-app-shell').exists()).toBe(true)
    expect(wrapper.find('.sidebar').exists()).toBe(false)
    expect(wrapper.get('a[href="/sessions"]').attributes('aria-label')).toBeTruthy()
    expect(wrapper.get('a[href="/settings"]').attributes('aria-label')).toBeTruthy()
    expect(wrapper.get('[role="status"]').text()).not.toBe('')
  })

  test('hides bottom navigation inside a session to maximize message space', async () => {
    const router = testRouter('/session/ses_1')
    await router.isReady()
    const App = (await import('../../../App.vue')).default
    const wrapper = mount(App, { global: { plugins: [router] } })

    expect(wrapper.find('.mobile-topbar-back').exists()).toBe(true)
    expect(wrapper.find('.mobile-bottom-nav').exists()).toBe(false)
  })

  test('keeps the existing desktop shell for wide viewports', async () => {
    mobile.value = false
    const router = testRouter()
    await router.isReady()
    const App = (await import('../../../App.vue')).default
    const wrapper = mount(App, { global: { plugins: [router] } })

    expect(wrapper.find('.sidebar').exists()).toBe(true)
    expect(wrapper.find('.mobile-app-shell').exists()).toBe(false)
    mobile.value = true
  })
})
