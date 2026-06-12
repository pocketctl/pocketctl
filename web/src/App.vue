<template>
  <div class="app-layout" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <!-- Sidebar -->
    <nav class="sidebar" v-if="isLoggedIn">
      <router-link to="/" class="sidebar-logo">
        <img :src="sidebarLogoSrc" alt="pocketctl" />
        <span class="brand-name">pocketctl</span>
      </router-link>

      <div class="sidebar-nav">
        <div class="sidebar-section-label">概览</div>

        <router-link to="/" class="sidebar-link" active-class="active" v-slot="{ isActive }">
          <span class="link-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></span>
          <span class="link-text">仪表盘</span>
        </router-link>

        <router-link to="/session/default" class="sidebar-link" active-class="active" v-slot="{ isActive }">
          <span class="link-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg></span>
          <span class="link-text">会话</span>
          <span class="badge" v-if="sessionCount > 0">{{ sessionCount }}</span>
        </router-link>

        <div class="sidebar-section-label">管理</div>

        <router-link to="/settings" class="sidebar-link" active-class="active" v-slot="{ isActive }">
          <span class="link-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg></span>
          <span class="link-text">设置</span>
        </router-link>
      </div>

      <div class="sidebar-footer">
        <div class="sidebar-user" @click="$router.push('/settings')">
          <div class="user-avatar">{{ userInitial }}</div>
          <div class="user-info">
            <div class="user-name">{{ userDisplayName }}</div>
            <div class="user-plan">免费版</div>
          </div>
        </div>
        <button class="sidebar-toggle" @click="toggleSidebar" :title="sidebarCollapsed ? '展开侧栏' : '收起侧栏'">
          <svg :class="{ rotated: sidebarCollapsed }" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
      </div>
    </nav>

    <!-- Main Content -->
    <main class="main-content" :class="{ 'no-sidebar': !isLoggedIn }">
      <!-- Topbar (only when logged in) -->
      <header class="topbar" v-if="isLoggedIn">
        <div class="topbar-breadcrumb">
          <span class="current">{{ pageTitle }}</span>
        </div>
        <div class="topbar-actions">
          <button class="btn btn-secondary" v-if="showNewSessionBtn" @click="emit('new-session')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
            新建会话
          </button>
          <button class="theme-toggle" @click="toggleTheme" :title="isDark ? '切换浅色' : '切换深色'">
            <svg v-if="isDark" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
            <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
          </button>
        </div>
      </header>

      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useAuth } from './composables/useAuth'
import logoDark from './assets/logo-github-org.svg'
import logoLight from './assets/logo-github-org-light.svg'

const route = useRoute()
const { isLoggedIn, user } = useAuth()

const emit = defineEmits(['new-session'])

const currentTheme = ref(document.documentElement.getAttribute('data-theme') || 'dark')
const isDark = computed(() => currentTheme.value !== 'light')
const sidebarLogoSrc = computed(() => isDark.value ? logoDark : logoLight)
const sessionCount = ref(0)
const sidebarCollapsed = ref(localStorage.getItem('pocketctl_sidebar_collapsed') === 'true')

const userInitial = computed(() => {
  const name = user.value?.display_name || user.value?.email || user.value?.phone || 'U'
  return name.charAt(0).toUpperCase()
})

const userDisplayName = computed(() => {
  const phone = user.value?.phone
  if (phone) return phone.slice(0, 3) + '****' + phone.slice(-4)
  return user.value?.display_name || user.value?.email || '用户'
})

const pageTitle = computed(() => {
  const titles: Record<string, string> = {
    '/': '概览',
    '/settings': '设置',
  }
  if (route.path.startsWith('/session/')) return '会话详情'
  return titles[route.path] || '概览'
})

const showNewSessionBtn = computed(() => {
  return route.path === '/' || route.path === ''
})

function setTheme(t: string) {
  if (t === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light')
  } else {
    document.documentElement.setAttribute('data-theme', t)
  }
  localStorage.setItem('pocketctl-theme', t)
  currentTheme.value = document.documentElement.getAttribute('data-theme') || 'dark'
}

function toggleTheme() {
  const saved = localStorage.getItem('pocketctl-theme') || 'dark'
  setTheme(saved === 'light' ? 'dark' : 'light')
}

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  localStorage.setItem('pocketctl_sidebar_collapsed', String(sidebarCollapsed.value))
}

// Watch system theme changes when in "system" mode
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const saved = localStorage.getItem('pocketctl-theme')
    if (saved === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light')
      currentTheme.value = prefersDark ? 'dark' : 'light'
    }
  })
}

// Expose session count for sidebar badge
if (typeof window !== 'undefined') {
  (window as any).__updateSessionCount = (n: number) => { sessionCount.value = n }
}
</script>

<style>
/* Override main-content when no sidebar (login page) */
.main-content.no-sidebar {
  margin-left: 0 !important;
}

/* Login page specific: hide sidebar even if logged in (shouldn't happen but guard) */
.no-sidebar ~ .sidebar { display: none; }

/* Sidebar collapsed state */
.sidebar-collapsed .sidebar { width: 72px; }
.sidebar-collapsed .sidebar .brand-name,
.sidebar-collapsed .sidebar .sidebar-section-label,
.sidebar-collapsed .sidebar .link-text,
.sidebar-collapsed .sidebar .badge,
.sidebar-collapsed .sidebar .user-info { display: none; }
.sidebar-collapsed .sidebar .sidebar-logo { justify-content: center; padding: 16px 8px; }
.sidebar-collapsed .sidebar .sidebar-link { justify-content: center; padding: 10px; }
.sidebar-collapsed .sidebar .sidebar-user { justify-content: center; padding: 12px 8px; }
.sidebar-collapsed .sidebar .sidebar-user .user-avatar { margin: 0; }
.sidebar-collapsed .sidebar .sidebar-toggle { justify-content: center; }
.sidebar-collapsed .sidebar .sidebar-toggle svg { transform: rotate(180deg); }
.sidebar-collapsed .main-content { margin-left: 72px; }

/* Sidebar toggle button */
.sidebar-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 10px;
  background: none;
  border: none;
  border-top: 1px solid var(--sidebar-border);
  color: var(--fg-tertiary);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.sidebar-toggle:hover {
  color: var(--fg);
  background: var(--surface-hover);
}
.sidebar-toggle svg {
  transition: transform 0.2s ease;
}
</style>
