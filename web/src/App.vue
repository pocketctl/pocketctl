<template>
  <div
    class="app-layout"
    :class="{
      'sidebar-collapsed': sidebarCollapsed,
      'mobile-shell-active': showMobileShell,
      'mobile-session-route': showMobileShell && isSessionRoute,
      'mobile-team-session-route': showMobileShell && isTeamSessionRoute,
      'mobile-session-list-route': showMobileShell && isSessionListRoute,
      'mobile-team-workspace': showMobileShell && (route.path === '/teams' || route.path === '/memory'),
    }"
  >
    <button v-if="showMobileShell && (route.name === 'team-sessions' || route.path === '/teams' || route.path === '/memory')" ref="mobileNavTrigger" class="team-mobile-menu" aria-label="打开导航" :aria-expanded="mobileNavOpen" @click="openMobileNav"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button>
    <div v-if="showMobileShell && mobileNavOpen" class="mobile-nav-backdrop" @click="closeMobileNav"></div>
    <!-- Sidebar -->
    <nav ref="mobileNavPanel" class="sidebar" :class="{'mobile-open':showMobileShell && mobileNavOpen}" v-if="isLoggedIn && (!showMobileShell || mobileNavOpen)" :role="showMobileShell ? 'dialog' : undefined" :aria-modal="showMobileShell ? true : undefined" aria-label="主导航" @keydown.esc.stop.prevent="closeMobileNav" @keydown.tab="trapMobileNavFocus">
      <router-link to="/" class="sidebar-logo">
        <img :src="sidebarLogoSrc" alt="pocketctl" />
        <span class="brand-name">pocketctl</span>
      </router-link>

      <button v-if="showMobileShell" class="mobile-nav-close" aria-label="关闭导航" @click="closeMobileNav">×</button>
      <div class="sidebar-nav">
        <div class="sidebar-section-label">{{ t('nav.overview') }}</div>

        <router-link to="/" class="sidebar-link" active-class="active" v-slot="{ isActive }">
          <span class="link-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg></span>
          <span class="link-text">{{ t('dashboard.title') }}</span>
        </router-link>

        <router-link :to="isSessionRoute ? route.fullPath : '/session/default'" class="sidebar-link" active-class="active" v-slot="{ isActive }">
          <span class="link-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg></span>
          <span class="link-text">{{ t('nav.sessions') }}</span>
          <span class="badge" v-if="sessionCount > 0">{{ sessionCount }}</span>
        </router-link>



        <router-link to="/inbox" class="sidebar-link" active-class="active">
          <span class="link-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg></span>
          <span class="link-text">{{ t('attention.title') }}</span>
          <span class="badge" v-if="attentionTotalCount > 0">{{ attentionTotalCount > 99 ? '99+' : attentionTotalCount }}</span>
        </router-link>

        <router-link to="/memory" class="sidebar-link" active-class="active">
          <span class="link-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/></svg></span>
          <span class="link-text">{{ t('nav.memory') }}</span>
        </router-link>

        <router-link to="/tokens" class="sidebar-link" active-class="active">
          <span class="link-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg></span>
          <span class="link-text">{{ t('nav.tokens') }}</span>
        </router-link>

        <div class="sidebar-section-label">{{ t('nav.manage') }}</div>

        <router-link v-if="teamAccess.enabled.value" to="/teams" class="sidebar-link" active-class="active">
          <span class="link-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>
          <span class="link-text">{{ t('team.title') }}</span>
        </router-link>

        <router-link to="/hosts" class="sidebar-link" active-class="active" v-slot="{ isActive }">
          <span class="link-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01M6 18h.01"/></svg></span>
          <span class="link-text">{{ t('nav.hosts') }}</span>
        </router-link>

        <router-link to="/settings" class="sidebar-link" active-class="active" v-slot="{ isActive }">
          <span class="link-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></span>
          <span class="link-text">{{ t('nav.settings') }}</span>
        </router-link>
      </div>

      <button v-if="!showMobileShell" class="sidebar-toggle-btn" @click="toggleSidebar" :title="sidebarCollapsed ? t('nav.expand') : t('nav.collapse')" :aria-label="sidebarCollapsed ? t('nav.expand') : t('nav.collapse')">
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
      :title="mobileTopbarTitle"
      :connected="connected"
      :reconnecting="reconnecting"
      :is-session="isSessionRoute"
      :show-top-bar="!isSessionListRoute && !isTeamSessionRoute && route.path !== '/teams' && route.path !== '/memory'"
      :show-bottom-nav="!isSessionRoute && !isSessionListRoute && route.path !== '/teams' && route.path !== '/memory'"
      :show-new-session="route.path === '/sessions'"
      :session-count="sessionCount"
      :attention-count="attentionTotalCount"
      :plan="mobileCurrentPlan"
      :session-host="sessionHeader.host"
      :session-host-id="sessionHeader.hostId"
      :session-status="sessionHeader.status"
      :session-status-label="sessionHeader.statusLabel"
      @new-session="triggerNewSession++"
    />
    <PwaUpdateBanner />

    <!-- Main Content -->
    <main class="main-content" :class="{ 'no-sidebar': !isLoggedIn || showMobileShell, 'session-detail-route': isSessionRoute && !showMobileShell }">
      <!-- Topbar (only when logged in) -->
      <header class="topbar" v-if="isLoggedIn && !showMobileShell && !isSessionRoute && route.path !== '/teams' && route.path !== '/memory'">
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
import { ref, computed, provide, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from './composables/useAuth'
import { useTeamAccess } from './composables/useTeamAccess'
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
import { useSessionHeader } from './composables/useSessionHeader'
import { useAttentionInbox } from './composables/useAttentionInbox'

const route = useRoute()
const { isLoggedIn, user, accessToken } = useAuth()
const teamAccess = useTeamAccess()
const router = useRouter()
watch(accessToken, () => { void teamAccess.refresh() }, { immediate: true })
watch(teamAccess.denied, denied => {
  if (denied && route.meta.requiresTeam) void router.replace('/sessions')
})
const refreshTeamAccess = () => { void teamAccess.refresh() }
let teamAccessTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  window.addEventListener('focus', refreshTeamAccess)
  teamAccessTimer = setInterval(refreshTeamAccess, 30_000)
})
onBeforeUnmount(() => {
  window.removeEventListener('focus', refreshTeamAccess)
  if (teamAccessTimer) clearInterval(teamAccessTimer)
})
const { t, locale, setLocale } = useLocale()
const { connected, reconnecting } = useWebSocket()
const { isMobile } = useResponsiveLayout()
const showMobileShell = computed(() => isLoggedIn.value && isPwaMobileShellEnabled() && isMobile.value)
const mobileNavOpen=ref(false),mobileNavPanel=ref<HTMLElement|null>(null),mobileNavTrigger=ref<HTMLButtonElement|null>(null)
async function openMobileNav(){mobileNavOpen.value=true;await nextTick();mobileNavPanel.value?.querySelector<HTMLElement>('a[href]')?.focus()}
function closeMobileNav(){mobileNavOpen.value=false;void nextTick(()=>mobileNavTrigger.value?.focus())}
function trapMobileNavFocus(event:KeyboardEvent){if(!showMobileShell.value || !mobileNavOpen.value)return;const nodes=Array.from(mobileNavPanel.value?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled)')??[]);if(event.shiftKey && document.activeElement===nodes[0]){event.preventDefault();nodes.at(-1)?.focus()}else if(!event.shiftKey && document.activeElement===nodes.at(-1)){event.preventDefault();nodes[0]?.focus()}}
watch([()=>route.fullPath,isMobile],()=>{mobileNavOpen.value=false})
const isTeamSessionRoute = computed(() => route.name === 'team-session')
const isSessionRoute = computed(() => route.path.startsWith('/session/') || (route.path === '/sessions' && !isMobile.value) || isTeamSessionRoute.value || route.name === 'team-sessions')
const isSessionListRoute = computed(() => route.path === '/sessions' || route.name === 'team-sessions')
const { planForSession } = useAgentPlanProgress()
const { sessionHeader } = useSessionHeader()
const attentionInbox = useAttentionInbox()
const attentionTotalCount = computed(() => attentionInbox.actionableCount({ type: 'global' }))
const mobileCurrentPlan = planForSession(computed(() =>
  route.path.startsWith('/session/') && !route.query.subagent ? String(route.params.id || '') : '',
))
function toggleLocale() { setLocale(locale.value === 'zh' ? 'en' : 'zh') }

const triggerNewSession = ref(0)
provide('triggerNewSession', triggerNewSession)

const currentTheme = ref(document.documentElement.getAttribute('data-theme') || 'dark')
const isDark = computed(() => currentTheme.value !== 'light')
const sidebarLogoSrc = computed(() => isDark.value ? logoDark : logoLight)
// Settings resolves the theme on the shared root without remounting App.
let themeObserver: MutationObserver | undefined
const syncResolvedTheme = () => {
  currentTheme.value = document.documentElement.getAttribute('data-theme') || 'dark'
}
onMounted(() => {
  syncResolvedTheme()
  themeObserver = new MutationObserver(syncResolvedTheme)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
})
onBeforeUnmount(() => themeObserver?.disconnect())
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
    '/inbox': t('attention.title'),
    '/memory': t('memory.title'),
    '/teams': t('team.title'),
  }
  if (route.path.startsWith('/session/')) return t('nav.session_detail')
  return titles[route.path] || t('nav.overview')
})

watch(isLoggedIn, loggedIn => {
  if (loggedIn) void attentionInbox.start()
  else attentionInbox.stop()
}, { immediate: true })
onBeforeUnmount(() => attentionInbox.stop())

const mobileTopbarTitle = computed(() => isSessionRoute.value && sessionHeader.value.title
  ? sessionHeader.value.title
  : pageTitle.value)

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

function setSidebarCollapsed(collapsed: boolean) {
  sidebarCollapsed.value = collapsed
  localStorage.setItem('pocketctl_sidebar_collapsed', String(collapsed))
}

function toggleSidebar() { setSidebarCollapsed(!sidebarCollapsed.value) }


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
.main-content.session-detail-route { --topbar-h: 0px; }

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
.mobile-shell-active.mobile-team-session-route .main-content {
  padding-top: 0;
}
.mobile-shell-active.mobile-session-list-route .main-content,
.mobile-shell-active.mobile-team-workspace .main-content {
  padding-top: 0;
  padding-bottom: 0;
}
.team-mobile-menu { position:fixed; left:12px; top:16px; z-index:60; width:30px; height:30px; display:grid; place-items:center; padding:6px; border:1px solid var(--border); border-radius:5px; background:var(--surface); color:var(--fg); cursor:pointer; }.team-mobile-menu svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.7; }.mobile-nav-backdrop { position:fixed; inset:0; z-index:64; background:var(--overlay); }.mobile-nav-close { position:absolute; top:18px; right:10px; border:0; background:none; color:var(--fg); font-size:22px; cursor:pointer; }
@media(max-width:768px){.sidebar.mobile-open { display:flex; width:230px; position:fixed; inset:0 auto 0 0; z-index:65; box-shadow:var(--shadow-lg); }.sidebar.mobile-open .brand-name,.sidebar.mobile-open .sidebar-section-label,.sidebar.mobile-open .link-text,.sidebar.mobile-open .user-info { display:block; }.sidebar.mobile-open .sidebar-link,.sidebar.mobile-open .sidebar-logo,.sidebar.mobile-open .sidebar-user { justify-content:flex-start; }.sidebar.mobile-open .sidebar-logo { padding:16px 20px; }.sidebar.mobile-open .sidebar-link { padding:10px 14px; }.sidebar.mobile-open .sidebar-user { padding:20px 24px; }.sidebar.mobile-open .user-avatar { margin-right:10px; }}
</style>
