import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import LoginView from './views/LoginView.vue'
import SessionList from './views/SessionList.vue'
import SessionDetail from './views/SessionDetail.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView },
    { path: '/', component: SessionList, meta: { requiresAuth: true } },
    { path: '/session/:id', component: SessionDetail, props: true, meta: { requiresAuth: true } },
  ],
})

// 路由守卫：未登录时跳转登录页
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
