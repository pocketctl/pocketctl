import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { describe, expect, test, vi } from 'vitest'
import { computed, ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import logoDark from '../../../assets/logo-github-org.svg'
import logoLight from '../../../assets/logo-github-org-light.svg'
import type { createTeamAccessController } from '../../../composables/useTeamAccess'
import type { TeamCapabilities } from '../../../types/team'
import { resetAgentPlanProgressForTests, useAgentPlanProgress } from '../../../composables/useAgentPlanProgress'

const mobile = ref(true)
const loggedIn = ref(true)
const connected = ref(true)
const sidebarDaemons = ref(new Map<string, { online: boolean }>())
const send = vi.fn()
const teamEnabled = ref(false)
const accessToken = ref('fixture-token')
let realTeamAccess: ReturnType<typeof createTeamAccessController> | undefined

vi.mock('../../../composables/useTeamAccess', async importOriginal => ({
  ...await importOriginal<typeof import('../../../composables/useTeamAccess')>(),
  useTeamAccess: () => realTeamAccess ?? ({ enabled: teamEnabled, capabilities: computed(()=>({writes_enabled:teamEnabled.value})),denied: computed(() => !teamEnabled.value), refresh: async () => teamEnabled.value }),
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
  useWebSocket: () => ({ connected, reconnecting: ref(false), daemons: sidebarDaemons, send }),
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
  test('loads sidebar host counts on connection and refreshes them after reconnecting on Settings', async () => {
    const previousMobile = mobile.value
    mobile.value = false
    connected.value = false
    sidebarDaemons.value = new Map()
    send.mockClear()
    const router = testRouter('/settings')
    await router.isReady()
    const App = (await import('../../../App.vue')).default
    const wrapper = mount(App, { global: { plugins: [router] } })
    try {
      expect(send).not.toHaveBeenCalledWith({ type: 'list_daemons' })
      connected.value = true
      await flushPromises()
      expect(send).toHaveBeenCalledWith({ type: 'list_daemons' })
      sidebarDaemons.value.set('online-host', { online: true })
      sidebarDaemons.value.set('offline-host', { online: false })
      await flushPromises()
      expect(wrapper.get('.sidebar-user .user-plan').text()).toContain(useLocale().t('workspace.online_hosts_count', { count: 1 }))
      connected.value = false
      await flushPromises()
      send.mockClear()
      connected.value = true
      await flushPromises()
      expect(send).toHaveBeenCalledWith({ type: 'list_daemons' })
      sidebarDaemons.value.set('online-host', { online: false })
      await flushPromises()
      expect(wrapper.get('.sidebar-user .user-plan').text()).toContain(useLocale().t('workspace.online_hosts_count', { count: 0 }))
    } finally {
      wrapper.unmount()
      mobile.value = previousMobile
      connected.value = true
      sidebarDaemons.value = new Map()
    }
  })
  test.each(['light', 'dark'])('keeps the sidebar logo in sync with %s theme across sessions, Memory and Team', async theme => {
    const previousTheme = document.documentElement.getAttribute('data-theme')
    const previousPreference = localStorage.getItem('pocketctl-theme')
    const previousMobile = mobile.value
    const previousTeamEnabled = teamEnabled.value
    mobile.value = false
    teamEnabled.value = true
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('pocketctl-theme', theme)
    const router = testRouter('/memory')
    await router.isReady()
    const App = (await import('../../../App.vue')).default
    const wrapper = mount(App, { global: { plugins: [router] } })
    const assertLogoOnAllModules = async (expectedTheme: string) => {
      for (const path of ['/sessions', '/memory', '/teams']) {
        await router.push(path)
        await flushPromises()
        await vi.waitFor(() => expect(wrapper.get('.sidebar-logo img').attributes('src')).toBe(
          expectedTheme === 'light' ? logoLight : logoDark,
        ))
      }
    }
    try {
      await assertLogoOnAllModules(theme)
      await router.push('/memory')
      await flushPromises()
      expect(wrapper.find('.memory-appearance-actions').exists()).toBe(false)
      await router.push('/settings')
      await flushPromises()
      await wrapper.get(`.topbar [title="${useLocale().t('common.toggle_theme')}"]`).trigger('click')
      await flushPromises()
      const nextTheme = theme === 'light' ? 'dark' : 'light'
      expect(document.documentElement.getAttribute('data-theme')).toBe(nextTheme)
      await assertLogoOnAllModules(nextTheme)
      // Settings and system theme updates change the shared root attribute.
      document.documentElement.setAttribute('data-theme', theme)
      await flushPromises()
      await assertLogoOnAllModules(theme)
    } finally {
      wrapper.unmount()
      mobile.value = previousMobile
      teamEnabled.value = previousTeamEnabled
      if (previousTheme === null) document.documentElement.removeAttribute('data-theme')
      else document.documentElement.setAttribute('data-theme', previousTheme)
      if (previousPreference === null) localStorage.removeItem('pocketctl-theme')
      else localStorage.setItem('pocketctl-theme', previousPreference)
    }
  })

  test.each(['/teams', '/memory'])('opens the prototype navigation on %s and closes it after selecting another module', async path => {
    mobile.value = true; teamEnabled.value = true
    const router = testRouter(path)
    await router.isReady()
    const App = (await import('../../../App.vue')).default
    const wrapper = mount(App, { attachTo: document.body, global: { plugins: [router] } })
    try {
      expect(wrapper.find('.mobile-topbar').exists()).toBe(true)
      expect(wrapper.find('.mobile-bottom-nav').exists()).toBe(false)
      await wrapper.get('.mobile-menu-trigger').trigger('click')
      await flushPromises()
      expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe(useLocale().t('workspace.main_navigation'))
      await wrapper.get('.sidebar a[href="/hosts"]').trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.path).toBe('/hosts')
      expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    } finally { wrapper.unmount(); teamEnabled.value = false }
  })
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
  test('keeps Team out of the mobile bottom nav and gates the desktop entry by account', async () => {
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
      expect(wrapper.find('[data-testid="mobile-nav-teams"]').exists()).toBe(false)
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
    await wrapper.get('.mobile-menu-trigger').trigger('click')
    await flushPromises()
    expect(wrapper.get('.sidebar a[href="/sessions?view=active"]').attributes('title')).toBeTruthy()
    expect(wrapper.get('.sidebar a[href="/settings"]').attributes('title')).toBeTruthy()
    expect(wrapper.get('[role="status"]').text()).not.toBe('')
  })

  test('mobile navigation uses the drawer and leaves the working area free of bottom tabs', async () => {
    const router = testRouter('/settings')
    await router.isReady()
    const App = (await import('../../../App.vue')).default
    const wrapper = mount(App, { global: { plugins: [router] } })
    try {
      expect(wrapper.find('.mobile-bottom-nav').exists()).toBe(false)
      expect(wrapper.find('.mobile-menu-trigger').exists()).toBe(true)
    } finally { wrapper.unmount() }
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
    const body = new DOMWrapper(document.body)
    expect(body.get('.plan-bottom-sheet').classes()).not.toContain('expanded')

    window.dispatchEvent(new PopStateEvent('popstate'))
    await wrapper.vm.$nextTick()
    expect(body.find('.plan-bottom-sheet').exists()).toBe(false)
    wrapper.unmount()
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

  test('preserves the desktop sidebar preference on session routes and allows manual toggling', async () => {
    mobile.value = false
    localStorage.removeItem('pocketctl_sidebar_collapsed')
    const router = testRouter('/session/ses_1')
    await router.isReady()
    const App = (await import('../../../App.vue')).default
    const wrapper = mount(App, { global: { plugins: [router] } })

    expect(wrapper.get('.app-layout').classes()).not.toContain('sidebar-collapsed')
    await wrapper.get('.sidebar-toggle-btn').trigger('click')
    expect(wrapper.get('.app-layout').classes()).toContain('sidebar-collapsed')

    wrapper.unmount()
    mobile.value = true
  })
})
