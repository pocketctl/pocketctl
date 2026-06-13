import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import LoginView from './views/LoginView.vue'
import DeviceAuthView from './views/DeviceAuthView.vue'
import DashboardView from './views/DashboardView.vue'
import SessionDetail from './views/SessionDetail.vue'
import SettingsView from './views/SettingsView.vue'

const router = createRouter({
  history: createWebHistory('/app/'),
  routes: [
    { path: '/login', component: LoginView },
    { path: '/login/cli', component: DeviceAuthView },
    { path: '/', component: DashboardView, meta: { requiresAuth: true } },
    { path: '/session/:id', component: SessionDetail, props: true, meta: { requiresAuth: true } },
    { path: '/settings', component: SettingsView, meta: { requiresAuth: true } },
  ],
})

// Route guard: redirect to login if not authenticated
router.beforeEach((to) => {
  const token = localStorage.getItem('pocketctl_access_token')
  if (to.meta.requiresAuth && !token) {
    return '/login'
  }
  if (to.path === '/login' && token) {
    return '/'
  }
})

createApp(App).use(router).mount('#app')
