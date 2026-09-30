import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { describe, expect, test, vi } from 'vitest'
import { computed, ref } from 'vue'
import type { createTeamAccessController } from '../../../composables/useTeamAccess'
import type { TeamCapabilities } from '../../../types/team'
import { resetAgentPlanProgressForTests, useAgentPlanProgress } from '../../../composables/useAgentPlanProgress'

const mobile = ref(true)
const loggedIn = ref(true)
const connected = ref(true)
const teamEnabled = ref(false)
const accessToken = ref('fixture-token')
let realTeamAccess: ReturnType<typeof createTeamAccessController> | undefined

vi.mock('../../../composables/useTeamAccess', async importOriginal => ({
  ...await importOriginal<typeof import('../../../composables/useTeamAccess')>(),
  useTeamAccess: () => realTeamAccess ?? ({ enabled: teamEnabled, denied: computed(() => !teamEnabled.value), refresh: async () => teamEnabled.value }),
}))

vi.mock('../../../composables/useResponsiveLayout', () => ({
  useResponsiveLayout: () => ({ isMobile: mobile }),
}))
vi.mock('../../../composables/useEnv', () => ({
  isPwaMobileShellEnabled: () => true,
}))
vi.mock('../../../composables/useAuth', () => ({
  useAuth: () => ({
    isLoggedIn: loggedIn,
    accessToken,
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
      { path: '/teams', meta: { requiresTeam: true }, component: { template: '<div>Team content</div>' } },
      ...['/inbox', '/hosts', '/memory'].map(path => ({ path, component: { template: '<div>Content</div>' } })),
      { path: '/sessions', component: { template: '<div>Sessions content</div>' } },
      { path: '/settings', component: { template: '<div>Settings content</div>' } },
      { path: '/session/:id', component: { template: '<div>Session content</div>' } },
    ],
  })
  router.push(path)
  return router
}

describe('mobile application shell', () => {
  test.each(['allowed', 'revoked', 'offline'] as const)('keeps the Team page during token renewal until qualification settles: %s', async outcome => {
    const { createTeamAccessController } = await import('../../../composables/useTeamAccess')
    const allowed: TeamCapabilities = { schema_version: 1, contract_version: 'team-collaboration.v1', collaboration: true, autorun: true, memory_bridge: false, writes_enabled: true }
    accessToken.value = 'original-token'
    let complete!: (value: TeamCapabilities) => void
    let fail!: (reason: Error) => void
    let deferred = false
    realTeamAccess = createTeamAccessController(accessToken, () => deferred
      ? new Promise((resolve, reject) => { complete = resolve; fail = reject })
      : Promise.resolve(allowed))
    await realTeamAccess.refresh()
    const router = testRouter('/teams')
    await router.isReady()
    const App = (await import('../../../App.vue')).default
    const wrapper = mount(App, { global: { plugins: [router] } })
    try {
      await flushPromises()
      deferred = true
      accessToken.value = 'renewed-token'
      await flushPromises()
      expect(realTeamAccess.enabled.value).toBe(false)
      expect(router.currentRoute.value.path).toBe('/teams')
      if (outcome === 'offline') fail(new Error('offline'))
      else complete({ ...allowed, collaboration: outcome === 'allowed', writes_enabled: outcome === 'allowed' })
      await flushPromises()
      expect(router.currentRoute.value.path).toBe(outcome === 'allowed' ? '/teams' : '/sessions')
    } finally { wrapper.unmount(); realTeamAccess = undefined; accessToken.value = 'fixture-token' }
  })
  test('only shows the Team entry to enabled accounts on mobile and desktop', async () => {
    const router = testRouter('/settings')
    await router.isReady()
    const App = (await import('../../../App.vue')).default
    const wrapper = mount(App, { global: { plugins: [router] } })
    try {
      teamEnabled.value = false; mobile.value = true
      await wrapper.vm.$nextTick()
      expect(wrapper.find('a[href="/teams"]').exists()).toBe(false)
      teamEnabled.value = true
      await wrapper.vm.$nextTick()
      expect(wrapper.find('[data-testid="mobile-nav-teams"]').exists()).toBe(true)
      mobile.value = false
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.sidebar a[href="/teams"]').exists()).toBe(true)
      teamEnabled.value = false
      await wrapper.vm.$nextTick()
      expect(wrapper.find('a[href="/teams"]').exists()).toBe(false)
    } finally { wrapper.unmount(); mobile.value = true; teamEnabled.value = false }
  })
  test('replaces the desktop sidebar with accessible mobile navigation', async () => {
    const router = testRouter('/settings')
    await router.isReady()
    const App = (await import('../../../App.vue')).default
    const wrapper = mount(App, { global: { plugins: [router] } })

    expect(wrapper.find('.mobile-app-shell').exists()).toBe(true)
    expect(wrapper.find('.sidebar').exists()).toBe(false)
    expect(wrapper.get('a[href="/sessions"]').attributes('aria-label')).toBeTruthy()
    expect(wrapper.get('a[href="/settings"]').attributes('aria-label')).toBeTruthy()
    expect(wrapper.get('[role="status"]').text()).not.toBe('')
  })

  test('mobile navigation carries the Memory entry alongside sessions and hosts', async () => {
    const router = testRouter('/settings')
    await router.isReady()
    const App = (await import('../../../App.vue')).default
    const wrapper = mount(App, { global: { plugins: [router] } })
    expect(wrapper.find('[data-testid="mobile-nav-memory"]').exists()).toBe(true)
    expect(wrapper.get('a[href="/memory"]').attributes('aria-label')).toBeTruthy()
  })

  test('lets the session list render its iOS-style navigation chrome', async () => {
    const router = testRouter()
    await router.isReady()
    const App = (await import('../../../App.vue')).default
    const wrapper = mount(App, { global: { plugins: [router] } })

    expect(wrapper.find('.mobile-topbar').exists()).toBe(false)
    expect(wrapper.find('.mobile-bottom-nav').exists()).toBe(false)
    expect(wrapper.find('.mobile-session-list-route').exists()).toBe(true)
  })

  test('hides bottom navigation inside a session to maximize message space', async () => {
    const router = testRouter('/session/ses_1')
    await router.isReady()
    const App = (await import('../../../App.vue')).default
    const wrapper = mount(App, { global: { plugins: [router] } })

    expect(wrapper.find('.mobile-topbar-back').exists()).toBe(true)
    expect(wrapper.find('.mobile-bottom-nav').exists()).toBe(false)
  })

  test('opens the shared plan from the session actions request and browser back closes it first', async () => {
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

    expect(wrapper.find('.mobile-plan-action').exists()).toBe(false)
    window.dispatchEvent(new CustomEvent('pocketctl:open-mobile-session-plan'))
    await wrapper.vm.$nextTick()

    expect(document.activeElement).not.toBe(input)
    expect(wrapper.get('.plan-bottom-sheet').classes()).not.toContain('expanded')

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

    expect(wrapper.find('.mobile-plan-action').exists()).toBe(false)
    await router.push('/session/ses_1?subagent=child-1')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.mobile-plan-action').exists()).toBe(false)
    window.dispatchEvent(new CustomEvent('pocketctl:open-mobile-session-plan'))
    await wrapper.vm.$nextTick()
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

  test('collapses the desktop sidebar on session routes and still allows manual expansion', async () => {
    mobile.value = false
    localStorage.removeItem('pocketctl_sidebar_collapsed')
    const router = testRouter('/session/ses_1')
    await router.isReady()
    const App = (await import('../../../App.vue')).default
    const wrapper = mount(App, { global: { plugins: [router] } })

    expect(wrapper.get('.app-layout').classes()).toContain('sidebar-collapsed')
    await wrapper.get('.sidebar-toggle-btn').trigger('click')
    expect(wrapper.get('.app-layout').classes()).not.toContain('sidebar-collapsed')

    wrapper.unmount()
    mobile.value = true
  })
})
