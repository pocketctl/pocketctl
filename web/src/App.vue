<template>
  <div
    class="app-layout"
    :class="{
      'sidebar-collapsed': sidebarCollapsed,
      'mobile-shell-active': showMobileShell,
      'mobile-session-route': showMobileShell && isSessionRoute,
    }"
  >
    <!-- Sidebar -->
    <nav class="sidebar" v-if="isLoggedIn && !showMobileShell">
      <router-link to="/" class="sidebar-logo">
        <img :src="sidebarLogoSrc" alt="pocketctl" />
        <span class="brand-name">pocketctl</span>
      </router-link>

      <div class="sidebar-nav">
        <div class="sidebar-section-label">{{ t('nav.overview') }}</div>

        <router-link to="/" class="sidebar-link" active-class="active" v-slot="{ isActive }">
          <span class="link-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></span>
          <span class="link-text">{{ t('dashboard.title') }}</span>
        </router-link>

        <router-link to="/session/default" class="sidebar-link" active-class="active" v-slot="{ isActive }">
          <span class="link-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg></span>
          <span class="link-text">{{ t('nav.sessions') }}</span>
          <span class="badge" v-if="sessionCount > 0">{{ sessionCount }}</span>
        </router-link>

        <router-link to="/tokens" class="sidebar-link" active-class="active">
          <span class="link-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg></span>
          <span class="link-text">{{ t('nav.tokens') }}</span>
        </router-link>

        <div class="sidebar-section-label">{{ t('nav.manage') }}</div>

        <router-link to="/hosts" class="sidebar-link" active-class="active" v-slot="{ isActive }">
          <span class="link-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="3"/><path d="M7 2v20M17 2v20M2 12h20"/></svg></span>
          <span class="link-text">{{ t('nav.hosts') }}</span>
        </router-link>

        <router-link to="/settings" class="sidebar-link" active-class="active" v-slot="{ isActive }">
          <span class="link-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg></span>
          <span class="link-text">{{ t('nav.settings') }}</span>
        </router-link>
      </div>

      <button class="sidebar-toggle-btn" @click="toggleSidebar" :title="sidebarCollapsed ? t('nav.expand') : t('nav.collapse')" :aria-label="sidebarCollapsed ? t('nav.expand') : t('nav.collapse')">
        <svg v-if="!sidebarCollapsed" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 19l-7-7 7-7"/><path d="M18 19l-7-7 7-7"/></svg>
        <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 5l7 7-7 7"/><path d="M6 5l7 7-7 7"/></svg>
      </button>
      <div class="sidebar-footer">
        <div class="sidebar-user" @click="$router.push('/settings')">
          <div class="user-avatar">{{ userInitial }}</div>
          <div class="user-info">
            <div class="user-name">{{ userDisplayName }}</div>
            <div class="user-plan" :class="{ pro: isPro }">{{ isPro ? t('user.pro_plan') : t('user.free_plan') }}</div>
          </div>
        </div>
      </div>
    </nav>

    <MobileAppShell
      v-if="showMobileShell"
      :title="pageTitle"
      :connected="connected"
      :reconnecting="reconnecting"
      :is-session="isSessionRoute"
      :show-bottom-nav="!isSessionRoute"
      :show-new-session="route.path === '/sessions'"
      :session-count="sessionCount"
      :plan="mobileCurrentPlan"
      @new-session="triggerNewSession++"
    />
    <PwaUpdateBanner />

    <!-- Main Content -->
    <main class="main-content" :class="{ 'no-sidebar': !isLoggedIn || showMobileShell }">
      <!-- Topbar (only when logged in) -->
      <header class="topbar" v-if="isLoggedIn && !showMobileShell">
        <div class="topbar-breadcrumb">
          <span class="current">{{ pageTitle }}</span>
        </div>
        <div class="topbar-actions">
          <button class="btn btn-secondary" v-if="showNewSessionBtn" @click="triggerNewSession++">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
            {{ t('session.new_session') }}
          </button>
          <TopbarGithubLink />
          <button class="theme-toggle" @click="toggleLocale" :title="locale === 'zh' ? 'English' : '中文'" style="font-size:12px;font-weight:600;min-width:28px;">{{ locale === 'zh' ? 'EN' : '中' }}</button>
          <button class="theme-toggle" @click="toggleTheme" :title="t('common.toggle_theme')">
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
import { ref, computed, provide } from 'vue'
import { useRoute } from 'vue-router'
import { useAuth } from './composables/useAuth'
import { useLocale } from './composables/useLocale'
import { useWebSocket } from './composables/useWebSocket'
import { useResponsiveLayout } from './composables/useResponsiveLayout'
import { isPwaMobileShellEnabled } from './composables/useEnv'
import MobileAppShell from './components/layout/MobileAppShell.vue'
import TopbarGithubLink from './components/TopbarGithubLink.vue'
import PwaUpdateBanner from './components/pwa/PwaUpdateBanner.vue'
import logoDark from './assets/logo-github-org.svg'
import logoLight from './assets/logo-github-org-light.svg'
import { useAgentPlanProgress } from './composables/useAgentPlanProgress'

const route = useRoute()
const { isLoggedIn, user } = useAuth()
const { t, locale, setLocale } = useLocale()
const { connected, reconnecting } = useWebSocket()
const { isMobile } = useResponsiveLayout()
const showMobileShell = computed(() => isLoggedIn.value && isPwaMobileShellEnabled() && isMobile.value)
const isSessionRoute = computed(() => route.path.startsWith('/session/'))
const { planForSession } = useAgentPlanProgress()
const mobileCurrentPlan = planForSession(computed(() =>
  isSessionRoute.value && !route.query.subagent ? String(route.params.id || '') : '',
))
function toggleLocale() { setLocale(locale.value === 'zh' ? 'en' : 'zh') }

const triggerNewSession = ref(0)
provide('triggerNewSession', triggerNewSession)

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
  return user.value?.display_name || user.value?.email || t('user.guest')
})

// 付费用户:plan 非 free 即视为专业版(与后端 listProUserIds 判定一致)
const isPro = computed(() => {
  const plan = user.value?.plan
  return !!plan && plan !== 'free'
})

const pageTitle = computed(() => {
  const titles: Record<string, string> = {
    '/': t('nav.overview'),
    '/sessions': t('nav.sessions'),
    '/settings': t('nav.settings'),
    '/hosts': t('nav.hosts'),
    '/tokens': t('nav.tokens'),
  }
  if (route.path.startsWith('/session/')) return t('nav.session_detail')
  return titles[route.path] || t('nav.overview')
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
.sidebar-collapsed .sidebar .sidebar-toggle-btn { justify-content: center; padding: 8px; }
.sidebar-collapsed .main-content { margin-left: 72px; }

/* Sidebar toggle button — 双箭头折叠/展开（对齐设计稿） */
.sidebar-toggle-btn {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  width: 100%;
  padding: 8px 20px;
  border: none;
  border-top: 1px solid var(--sidebar-border);
  background: transparent;
  color: var(--fg-tertiary);
  cursor: pointer;
  font-family: var(--font-body);
  transition: background 0.15s, color 0.15s, padding 0.2s ease;
}
.sidebar-toggle-btn:hover {
  color: var(--fg);
  background: var(--surface-hover);
}
.main-content { transition: margin-left 0.2s ease; }

:root {
  --mobile-topbar-h: calc(56px + env(safe-area-inset-top));
  --mobile-bottom-nav-h: calc(60px + env(safe-area-inset-bottom));
}

.mobile-shell-active {
  min-height: 100dvh;
}
.mobile-shell-active .main-content {
  width: 100%;
  min-height: 100dvh;
  margin-left: 0;
  padding-top: var(--mobile-topbar-h);
  padding-bottom: var(--mobile-bottom-nav-h);
}
.mobile-shell-active.mobile-session-route .main-content {
  padding-bottom: 0;
}
</style>
