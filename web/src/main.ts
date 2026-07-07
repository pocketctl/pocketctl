import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import LoginView from './views/LoginView.vue'
import DeviceAuthView from './views/DeviceAuthView.vue'
import DashboardView from './views/DashboardView.vue'
import HostsView from './views/HostsView.vue'
import SessionDetail from './views/SessionDetail.vue'
import TokenUsage from './views/TokenUsage.vue'
import SettingsView from './views/SettingsView.vue'
import { useAuth } from './composables/useAuth'

const router = createRouter({
  history: createWebHistory('/app/'),
  routes: [
    { path: '/login', component: LoginView },
    { path: '/login/cli', component: DeviceAuthView },
    { path: '/', component: DashboardView, meta: { requiresAuth: true } },
    { path: '/session/:id', component: SessionDetail, props: true, meta: { requiresAuth: true } },
    { path: '/tokens', component: TokenUsage, meta: { requiresAuth: true } },
    { path: '/settings', component: SettingsView, meta: { requiresAuth: true } },
    { path: '/hosts', component: HostsView, meta: { requiresAuth: true } },
  ],
})

// Route guard: access token is memory-only; restore it from the HttpOnly refresh cookie on reload.
router.beforeEach(async (to) => {
  const { accessToken, doRefreshToken } = useAuth()
  if (!accessToken.value) await doRefreshToken()
  if (to.meta.requiresAuth && !accessToken.value) {
    return '/login'
  }
  if (to.path === '/login' && accessToken.value) {
    return '/'
  }
})

createApp(App).use(router).mount('#app')
