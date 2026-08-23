import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import DashboardView from './views/DashboardView.vue'
import DeviceAuthView from './views/DeviceAuthView.vue'
import HostsView from './views/HostsView.vue'
import LoginView from './views/LoginView.vue'
import SessionDetail from './views/SessionDetail.vue'
import SessionList from './views/SessionList.vue'
import SettingsView from './views/SettingsView.vue'
import TokenUsage from './views/TokenUsage.vue'
import AttentionInboxView from './views/AttentionInboxView.vue'
import { useAuth } from './composables/useAuth'
import { isPwaMobileShellEnabled } from './composables/useEnv'
import { isMobileViewport } from './composables/useResponsiveLayout'

export const appRoutes: RouteRecordRaw[] = [
  { path: '/login', component: LoginView },
  { path: '/login/cli', component: DeviceAuthView },
  { path: '/', component: DashboardView, meta: { requiresAuth: true } },
  { path: '/sessions', component: SessionList, meta: { requiresAuth: true } },
  { path: '/session/:id', component: SessionDetail, props: true, meta: { requiresAuth: true } },
  { path: '/tokens', component: TokenUsage, meta: { requiresAuth: true } },
  { path: '/settings', component: SettingsView, meta: { requiresAuth: true } },
  { path: '/hosts', component: HostsView, meta: { requiresAuth: true } },
  { path: '/inbox', component: AttentionInboxView, meta: { requiresAuth: true } },
]

export function resolveAuthenticatedLanding(
  path: string,
  mobileShellEnabled = isPwaMobileShellEnabled(),
  mobile = isMobileViewport(),
): string | null {
  return path === '/' && mobileShellEnabled && mobile ? '/sessions' : null
}

export function createPocketctlRouter() {
  const router = createRouter({
    history: createWebHistory('/app/'),
    routes: appRoutes,
  })

  router.beforeEach(async (to) => {
    const { accessToken, doRefreshToken } = useAuth()
    if (!accessToken.value) await doRefreshToken()
    if (to.meta.requiresAuth && !accessToken.value) return '/login'
    if (to.path === '/login' && accessToken.value) {
      return resolveAuthenticatedLanding('/') || '/'
    }
    if (accessToken.value) {
      const landing = resolveAuthenticatedLanding(to.path)
      if (landing) return landing
    }
    return true
  })

  return router
}
