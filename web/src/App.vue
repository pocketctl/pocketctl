<template>
  <div
    class="app-layout"
    :class="{
      'reference-shell': isLoggedIn && !route.meta.standalone,
      'design-shell': isLoggedIn && !isSessionRoute && !route.meta.standalone,
      'standalone-route': !!route.meta.standalone,
      'sidebar-collapsed': sidebarCollapsed,
      'mobile-shell-active': showMobileShell,
      'mobile-session-route': showMobileShell && isSessionRoute,
      'mobile-team-session-route': showMobileShell && isTeamSessionRoute,
      'mobile-session-list-route': showMobileShell && isSessionListRoute,
      'mobile-team-workspace': showMobileShell && (route.path === '/teams' || route.path === '/memory'),
    }"
  >
    <button v-if="showMobileShell && route.name === 'team-sessions'" ref="mobileNavTrigger" class="team-mobile-menu" :aria-label="t('workspace.open_navigation')" :aria-expanded="mobileNavOpen" @click="openMobileNav"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button>
    <div v-if="showMobileShell && mobileNavOpen" class="mobile-nav-backdrop" @click="closeMobileNav"></div>
    <!-- Sidebar -->
    <nav ref="mobileNavPanel" class="sidebar design-sidebar" :class="{'mobile-open':showMobileShell && mobileNavOpen}" v-if="isLoggedIn && !route.meta.standalone && (!showMobileShell || mobileNavOpen)" :role="showMobileShell ? 'dialog' : undefined" :aria-modal="showMobileShell ? true : undefined" :aria-label="t('workspace.main_navigation')" @keydown.esc.stop.prevent="closeMobileNav" @keydown.tab="trapMobileNavFocus">
      <router-link to="/" class="sidebar-logo">
        <span class="logo-mark"><img :src="sidebarLogoSrc" alt="pocketctl" /></span>
        <span class="brand-name">pocketctl</span>
      </router-link>

      <button v-if="showMobileShell" class="mobile-nav-close" :aria-label="t('workspace.close_navigation')" @click="closeMobileNav">×</button>
      <button v-if="showMobileShell" class="drawer-new-session" @click="createFromDrawer"><WorkspaceIcon name="plus" />{{ t('new_session.title') }}</button>
      <div class="sidebar-nav">
        <template v-for="item in navigationItems" :key="item.id">
          <template v-if="showMobileShell && item.id === 'tokens'">
            <button class="recent-disclosure" :aria-expanded="recentOpen" aria-controls="recent-session-links" @click="recentOpen = !recentOpen"><span>{{ t('dashboard.recent_sessions') }}</span><small>{{ t(recentOpen ? 'workspace.collapse' : 'workspace.expand') }}</small></button>
            <div v-if="recentOpen" id="recent-session-links">
              <router-link v-for="session in recentSessions.slice(0, 3)" :key="session.session_id" :to="`/session/${session.session_id}`" class="drawer-recent-link"><i :class="['status-dot', { online: session.daemon_online }]" /><span>{{ session.title || session.session_id.slice(0, 8) }}</span></router-link>
              <p v-if="!recentSessions.length" class="drawer-recent-empty">{{ t('workspace.no_recent_sessions') }}</p>
            </div>
          </template>
          <div v-if="item.section" class="sidebar-section-label">{{ t(item.section) }}</div>
          <button v-if="item.id === 'connect'" class="sidebar-link" @click="registerFromDrawer"><span class="link-icon"><WorkspaceIcon name="plus" /></span><span class="link-text">{{ t(item.label) }}</span></button>
          <router-link v-else :to="item.to" class="sidebar-link" :class="{ active: navigationActive(item.id) }" :aria-current="navigationActive(item.id) ? 'page' : undefined" :title="t(item.label)">
            <span class="link-icon"><WorkspaceIcon :name="item.icon" /></span><span class="link-text">{{ t(item.label) }}</span>
            <span v-if="item.id === 'inbox' && attentionTotalCount" class="badge attention">{{ attentionTotalCount > 99 ? '99+' : attentionTotalCount }}</span>
            <span v-if="item.id === 'sessions' && !showMobileShell && sessionCount" class="badge">{{ sessionCount }}</span>
          </router-link>
        </template>
      </div>

      <div class="sidebar-bottom" :class="{ 'sidebar-footer':showMobileShell }">
        <button v-if="!showMobileShell" class="sidebar-toggle-btn" @click="toggleSidebar" :title="sidebarCollapsed ? t('nav.expand') : t('nav.collapse')" :aria-label="sidebarCollapsed ? t('nav.expand') : t('nav.collapse')" :aria-expanded="!sidebarCollapsed">
          <span class="fold-label">{{ t(sidebarCollapsed ? 'nav.expand' : 'nav.collapse') }}</span>
          <WorkspaceIcon :name="sidebarCollapsed?'expand':'collapse'" class="icon small" />
        </button>
        <div v-if="!showMobileShell" class="connection" role="status"><span class="dot" :class="{off:!connected}" /><span class="connection-copy">{{ t(connected ? 'replica.relay_connected' : reconnecting ? 'replica.relay_connecting' : 'replica.relay_disconnected') }}</span></div>
        <button class="sidebar-user" type="button" @click="$router.push('/settings')">
          <span class="user-avatar avatar">{{ userInitial }}</span>
          <span class="user-info grow"><strong class="user-name">{{ userDisplayName }}</strong><span class="user-plan">{{ showMobileShell ? t(isPro ? 'user.pro_plan' : 'user.free_plan') : t('replica.personal_account') + ' · ' + t('workspace.online_hosts_count',{count:sidebarOnlineHosts}) }}</span></span>
          <span v-if="!showMobileShell" class="badge blue account-plan">{{ isPro ? 'PRO' : 'FREE' }}</span>
        </button>
        <div v-if="showMobileShell" class="drawer-utilities">
          <button class="theme-toggle drawer-locale" @click="toggleLocale" :aria-label="locale === 'zh' ? 'English' : '中文'"><WorkspaceIcon name="globe" /><span>{{ locale === 'zh' ? '中' : 'EN' }}</span></button>
          <button class="theme-toggle" @click="toggleTheme" :title="t('common.toggle_theme')" :aria-label="t('common.toggle_theme')"><WorkspaceIcon :name="isDark ? 'sun' : 'moon'" /></button>
        </div>
      </div>
    </nav>

    <MobileAppShell
      v-if="showMobileShell && !route.meta.standalone"
      :title="mobileTopbarTitle"
      :subtitle="mobileModuleSubtitle"
      :module-action="mobileModuleAction"
      :connected="connected"
      :reconnecting="reconnecting"
      :is-session="isSessionRoute"
      :show-top-bar="!isSessionListRoute && !isTeamSessionRoute"
      :show-bottom-nav="false"
      :show-new-session="route.path === '/sessions'"
      :session-count="sessionCount"
      :attention-count="attentionTotalCount"
      :plan="mobileCurrentPlan"
      :session-host="sessionHeader.host"
      :session-host-id="sessionHeader.hostId"
      :session-status="sessionHeader.status"
      :session-status-label="sessionHeader.statusLabel"
      @new-session="triggerNewSession++"
      @open-nav="openMobileNav"
      @module-action="handleMobileModuleAction"
    />
    <PwaUpdateBanner />
    <RegisterDaemonDialog v-if="registerOpen" @close="registerOpen = false" />

    <!-- Main Content -->
    <main class="main-content" :class="{ 'no-sidebar': !isLoggedIn || showMobileShell || route.meta.standalone, 'session-detail-route': isSessionRoute && !showMobileShell }">
      <!-- Topbar (only when logged in) -->
      <header class="topbar" v-if="isLoggedIn && !showMobileShell && !isSessionRoute">
        <div class="topbar-breadcrumb breadcrumb">
          <span>{{ t('replica.workspace') }}</span><span>/</span><strong>{{ pageTitle }}</strong>
        </div>
        <div class="topbar-actions">
          <button class="btn btn-secondary" v-if="showNewSessionBtn" @click="triggerNewSession++">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
            {{ t('session.new_session') }}
          </button>
          <span class="topbar-status"><span class="dot" :class="{off:!connected}" />{{ t(connected?'workspace.all_normal':'replica.relay_connecting') }}</span>
          <RouterLink class="theme-toggle" to="/inbox" :aria-label="t('attention.title')"><WorkspaceIcon name="inbox" /></RouterLink>
          <TopbarGithubLink />
          <button class="theme-toggle" @click="toggleLocale" :title="locale === 'zh' ? 'English' : '中文'" ><WorkspaceIcon name="globe" /><span>{{ locale === 'zh' ? '中' : 'EN' }}</span></button>
          <button class="theme-toggle" @click="toggleTheme" :title="t('common.toggle_theme')">
            <svg v-if="!isDark" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
            <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
          </button>
          <button class="theme-toggle" @click="shellHelpOpen=true" :aria-label="t('settings.help_feedback')"><WorkspaceIcon name="help" /></button><RouterLink class="avatar topbar-avatar" to="/settings">{{ userInitial }}</RouterLink>
        </div>
      </header>
      <HelpModal v-if="shellHelpOpen" @close="shellHelpOpen=false" />
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
import WorkspaceIcon from './components/WorkspaceIcon.vue'
import HelpModal from './components/HelpModal.vue'
import RegisterDaemonDialog from './components/RegisterDaemonDialog.vue'
import TopbarGithubLink from './components/TopbarGithubLink.vue'
import PwaUpdateBanner from './components/pwa/PwaUpdateBanner.vue'
import logoDark from './assets/logo-github-org.svg'
import logoLight from './assets/logo-github-org-light.svg'
import { useAgentPlanProgress } from './composables/useAgentPlanProgress'
import { useSessionHeader } from './composables/useSessionHeader'
import { useUserPreferences } from './composables/useUserPreferences'
import { workspaceNotification } from './utils/workspaceNotifications'
import { useAttentionInbox } from './composables/useAttentionInbox'

const shellHelpOpen=ref(false)
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
const userPreferences=useUserPreferences()
watch(()=>user.value?.id,()=>{void userPreferences.load()},{immediate:true})
const refreshPreferences=()=>void userPreferences.load()
let disposeNotifications:(()=>void)|undefined
const notificationTimes=new Map<string,number>()
onMounted(()=>{
  window.addEventListener('focus',refreshPreferences)
  if(onEvent)disposeNotifications=onEvent((message:any)=>{
    const item=workspaceNotification(message,userPreferences.preferences.value.notifications,String(route.params.id||''))
    if(!item || typeof Notification==='undefined' || Notification.permission!=='granted')return
    const now=Date.now();if(now-(notificationTimes.get(item.key)||0)<30000)return
    notificationTimes.set(item.key,now);if(notificationTimes.size>200)notificationTimes.delete(notificationTimes.keys().next().value!)
    try{const notification=new Notification(t(item.titleKey),{body:item.body,tag:item.key});notification.onclick=()=>{window.focus();void router.push(item.path);notification.close()}}catch{}
  })
})
onBeforeUnmount(()=>{window.removeEventListener('focus',refreshPreferences);disposeNotifications?.()})
const { connected, reconnecting, onEvent, send, daemons: sidebarDaemons } = useWebSocket()
const sidebarOnlineHosts = computed(() => [...(sidebarDaemons?.value?.values() ?? [])].filter(host => host.online).length)
watch([connected, isLoggedIn], ([online, authenticated]) => {
  if (online && authenticated) send?.({ type: 'list_daemons' })
}, { immediate: true })
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
function toggleLocale() { const next=locale.value === 'zh' ? 'en' : 'zh';setLocale(next);if(isLoggedIn.value)void userPreferences.save({locale:next}) }

const triggerTeamCreate=ref(0)
provide('triggerTeamCreate',triggerTeamCreate)
const mobileModuleAction=computed(()=>route.path==='/hosts' && route.query.view!=='agents'?'register':route.path==='/teams' && teamAccess.capabilities.value?.writes_enabled?'team':route.path==='/inbox'?'refresh':undefined)
const mobileModuleSubtitle=computed(()=>t(route.path==='/settings'?'replica.personal_account':route.path==='/memory'?'replica.personal_knowledge':route.path==='/hosts'?'replica.personal_hosts':route.path==='/tokens'?'token.all_hosts':'replica.personal_workspace'))
function handleMobileModuleAction(){if(mobileModuleAction.value==='register')registerOpen.value=true;else if(mobileModuleAction.value==='team')triggerTeamCreate.value++;else if(mobileModuleAction.value==='refresh')void attentionInbox.refresh()}
const triggerNewSession = ref(0)
provide('triggerNewSession', triggerNewSession)
provide('openWorkspaceNavigation', openMobileNav)
const registerOpen = ref(false), recentOpen = ref(false), recentSessions = ref<any[]>([])
const navigationItems = computed(() => {
  const items = [
    { id: 'dashboard', to: '/', label: 'nav.overview', icon: 'dashboard', section: 'workspace.work_area' },
    { id: 'sessions', to: '/sessions', label: 'nav.sessions', icon: 'sessions' },
    { id: 'inbox', to: '/inbox', label: 'attention.title', icon: 'inbox' },
    { id: 'memory', to: '/memory', label: 'nav.memory', icon: 'memory' },
    { id: 'tokens', to: '/tokens', label: 'replica.token_usage', icon: 'tokens' },
    { id: 'teams', to: '/teams', label: 'team.title', icon: 'teams', section: 'nav.manage' },
    { id: 'hosts', to: '/hosts', label: 'nav.hosts', icon: 'hosts' },
    { id: 'settings', to: '/settings', label: 'nav.settings', icon: 'settings' },
  ].filter(item => item.id !== 'teams' || teamAccess.enabled.value)
  if (!showMobileShell.value) return items
  return [
    { id: 'sessions', to: '/sessions?view=active', label: 'mobile.host_sessions', icon: 'sessions' },
    { id: 'hosts', to: '/hosts', label: 'mobile.my_hosts', icon: 'hosts' },
    { id: 'inbox', to: '/inbox', label: 'attention.title', icon: 'inbox' },
    { id: 'agents', to: '/hosts?view=agents', label: 'mobile.host_agent_manage', icon: 'agent' },
    ...items.filter(item => ['memory', 'teams'].includes(item.id)).map(item => ({ ...item, section: undefined })),
    { id: 'tokens', to: '/tokens', label: 'mobile.host_token_usage', icon: 'tokens', section: 'nav.manage' },
    { id: 'archive', to: '/sessions?view=archived', label: 'workspace.archived', icon: 'archive' },
    { id: 'settings', to: '/settings', label: 'nav.settings', icon: 'settings' },
    { id: 'connect', to: '/hosts', label: 'workspace.connect_host', icon: 'plus' },
  ]
})
function navigationActive(id: string) {
  if (id === 'agents') return route.path === '/hosts' && route.query.view === 'agents'
  if (id === 'hosts') return route.path === '/hosts' && route.query.view !== 'agents'
  if (id === 'archive') return route.path === '/sessions' && route.query.view === 'archived'
  if (id === 'sessions') return isSessionRoute.value && (!showMobileShell.value || route.query.view !== 'archived')
  return route.path === ({dashboard:'/',inbox:'/inbox',memory:'/memory',tokens:'/tokens',teams:'/teams',settings:'/settings'} as Record<string,string>)[id]
}
async function createFromDrawer() { closeMobileNav(); await router.push('/sessions'); await nextTick(); triggerNewSession.value++ }
function registerFromDrawer() { closeMobileNav(); registerOpen.value = true }
let recentCleanup: (() => void) | undefined
onMounted(() => {
  if (onEvent) recentCleanup = onEvent('session_list', (message: any) => {
    recentSessions.value = (message.sessions || []).filter((item: any) => !item.archived_at && !item.isSubagent)
    sessionCount.value = recentSessions.value.length
  })
  if (isLoggedIn.value) send?.({ type: 'list_sessions' })
  window.addEventListener('pocketctl:open-navigation', openMobileNav)
})
onBeforeUnmount(() => { recentCleanup?.(); window.removeEventListener('pocketctl:open-navigation', openMobileNav) })

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
watch(() => route.fullPath, syncResolvedTheme)
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
    '/tokens': t('replica.token_usage'),
    '/inbox': t('attention.title'),
    '/memory': t('nav.memory'),
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

const mobileTopbarTitle = computed(() => route.path === '/hosts' ? t(route.query.view === 'agents' ? 'mobile.host_agent_manage' : 'mobile.my_hosts') : isSessionRoute.value && sessionHeader.value.title
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
  const next=saved === 'light' ? 'dark' : 'light';setTheme(next);if(isLoggedIn.value)void userPreferences.save({theme:next})
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
/* The Grid sidebar column owns the offset in both expanded and collapsed states. */

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
.mobile-shell-active.mobile-session-list-route .main-content {
  padding-top: 0;
  padding-bottom: 0;
}
.mobile-shell-active.mobile-team-workspace .main-content { padding-bottom:0; }
.team-mobile-menu { position:fixed; left:12px; top:16px; z-index:60; width:30px; height:30px; display:grid; place-items:center; padding:6px; border:1px solid var(--border); border-radius:5px; background:var(--surface); color:var(--fg); cursor:pointer; }.team-mobile-menu svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.7; }.mobile-nav-backdrop { position:fixed; inset:0; z-index:64; background:var(--overlay); }.mobile-nav-close { position:absolute; top:18px; right:10px; border:0; background:none; color:var(--fg); font-size:22px; cursor:pointer; }
@media(max-width:768px){.sidebar.mobile-open { display:flex; width:230px; position:fixed; inset:0 auto 0 0; z-index:65; box-shadow:var(--shadow-lg); }.sidebar.mobile-open .brand-name,.sidebar.mobile-open .sidebar-section-label,.sidebar.mobile-open .link-text,.sidebar.mobile-open .user-info { display:block; }.sidebar.mobile-open .sidebar-link,.sidebar.mobile-open .sidebar-logo,.sidebar.mobile-open .sidebar-user { justify-content:flex-start; }.sidebar.mobile-open .sidebar-logo { padding:16px 20px; }.sidebar.mobile-open .sidebar-link { padding:10px 14px; }.sidebar.mobile-open .sidebar-user { padding:20px 24px; }.sidebar.mobile-open .user-avatar { margin-right:10px; }}
</style>
