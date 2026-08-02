import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { describe, expect, test, vi } from 'vitest'
import { ref } from 'vue'
import { resetAgentPlanProgressForTests, useAgentPlanProgress } from '../../../composables/useAgentPlanProgress'

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

  test('opens the shared plan as a 65 percent sheet and browser back closes it first', async () => {
    resetAgentPlanProgressForTests()
    useAgentPlanProgress().acceptAgentPlan({
      type: 'agent_plan', session_id: 'ses_1', event_id: 'plan-1', revision: 1,
      plan: [{ step: 'Mobile UI', status: 'in_progress' }],
    })
    const router = testRouter('/session/ses_1')
    await router.isReady()
    const App = (await import('../../../App.vue')).default
    const wrapper = mount(App, { global: { plugins: [router] } })
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    const trigger = wrapper.get('.mobile-plan-action')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    await trigger.trigger('click')

    expect(document.activeElement).not.toBe(input)
    expect(wrapper.get('.plan-bottom-sheet').classes()).not.toContain('expanded')
    expect(trigger.attributes('aria-expanded')).toBe('true')

    window.dispatchEvent(new PopStateEvent('popstate'))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.plan-bottom-sheet').exists()).toBe(false)
    input.remove()
  })

  test('hides the parent plan while the mobile route focuses a sub-agent', async () => {
    resetAgentPlanProgressForTests()
    useAgentPlanProgress().acceptAgentPlan({
      type: 'agent_plan', session_id: 'ses_1', event_id: 'plan-parent', revision: 1,
      plan: [{ step: 'Parent work', status: 'in_progress' }],
    })
    const router = testRouter('/session/ses_1')
    await router.isReady()
    const App = (await import('../../../App.vue')).default
    const wrapper = mount(App, { global: { plugins: [router] } })

    expect(wrapper.find('.mobile-plan-action').exists()).toBe(true)
    await router.push('/session/ses_1?subagent=child-1')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.mobile-plan-action').exists()).toBe(false)
    expect(wrapper.find('.plan-bottom-sheet').exists()).toBe(false)
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
