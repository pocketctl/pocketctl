<template>
  <div class="page-container">
    <div class="page-header">
      <h1 class="page-title">设置</h1>
    </div>

    <div class="settings-grid">
      <!-- Settings Nav -->
      <div class="settings-nav">
        <div class="settings-nav-item active" @click="scrollTo('profile')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          账户
        </div>
        <div class="settings-nav-item" @click="scrollTo('daemons')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="3"/><path d="M7 2v20"/></svg>
          主机
        </div>
        <div class="settings-nav-item" @click="scrollTo('appearance')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42"/></svg>
          外观
        </div>
        <div class="settings-nav-item" @click="scrollTo('notifications')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
          通知
        </div>
        <div class="settings-nav-item" @click="scrollTo('about')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
          关于
        </div>
      </div>

      <!-- Settings Content -->
      <div>
        <!-- Profile -->
        <div id="section-profile" class="settings-section">
          <div class="profile-card">
            <div class="profile-avatar">{{ userInitial }}</div>
            <div class="profile-info">
              <div class="profile-name">{{ userDisplayName }}</div>
              <div class="profile-email">{{ userMasked }}</div>
              <button class="profile-edit" @click="showEditProfile = true">编辑资料</button>
            </div>
          </div>
          <div class="settings-row">
            <div class="row-icon" style="background:var(--accent-muted);color:var(--accent);">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="18" r="1"/></svg>
            </div>
            <span class="row-label">手机号</span>
            <span class="row-value">{{ user?.phone ? maskPhone(user.phone) + ' ' : '' }}<span :class="user?.phone ? 'bound' : 'unbound'">{{ user?.phone ? '已绑定' : '未绑定' }}</span></span>
          </div>
          <div class="settings-row" @click="showBindEmail = true">
            <div class="row-icon" style="background:rgba(88,166,255,0.1);color:var(--accent);">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 4L12 13 2 4"/></svg>
            </div>
            <span class="row-label">邮箱</span>
            <span class="row-value">{{ userEmail }} <span class="chevron">›</span></span>
          </div>
        </div>

        <!-- Edit Profile Modal -->
        <EditProfileModal v-if="showEditProfile" @close="showEditProfile = false" @saved="onProfileSaved" />

        <!-- Bind Email Modal -->
        <BindEmailModal v-if="showBindEmail" @close="showBindEmail = false" @saved="onEmailSaved" />

        <!-- Upgrade -->
        <div class="upgrade-card">
          <div class="upgrade-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01L12 2z"/></svg>
          </div>
          <div class="upgrade-text">
            <div class="upgrade-title">升级专业版 ¥48/月</div>
            <div class="upgrade-desc">无限主机 · 推送通知 · 实时消息 · 优先支持</div>
          </div>
          <button class="btn btn-accent">升级</button>
        </div>

        <!-- Daemons -->
        <div id="section-daemons" class="settings-section">
          <div class="settings-section-title">我的主机</div>
          <div class="daemon-settings-row" v-for="d in daemons" :key="d.daemon_id">
            <span :class="['status-dot', d.daemon_online ? 'online' : 'offline']" style="width:7px;height:7px;"></span>
            <span class="daemon-name">{{ d.daemon_alias || d.hostname || d.daemon_id?.slice(0,8) }}</span>
            <span :class="['chip', d.daemon_online ? 'chip-online' : 'chip-offline']" style="font-size:11px;">{{ d.daemon_online ? '在线' : '离线' }}</span>
            <span class="chevron">›</span>
          </div>
          <div class="daemon-settings-row add-daemon" @click="showRegisterDaemon = true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
            注册新主机
          </div>
        </div>

        <RegisterDaemonDialog v-if="showRegisterDaemon" @close="showRegisterDaemon = false" />

        <!-- Appearance -->
        <div id="section-appearance" class="settings-section">
          <div class="settings-section-title">外观</div>
          <div class="theme-options">
            <div :class="['theme-option', { active: currentTheme === 'dark' }]" @click="setTheme('dark')">
              <div class="theme-preview dark-preview"></div>
              <div class="theme-label">深色</div>
              <div class="theme-desc">适合暗光环境</div>
            </div>
            <div :class="['theme-option', { active: currentTheme === 'light' }]" @click="setTheme('light')">
              <div class="theme-preview light-preview"></div>
              <div class="theme-label">浅色</div>
              <div class="theme-desc">清爽明亮</div>
            </div>
            <div :class="['theme-option', { active: currentTheme === 'system' }]" @click="setTheme('system')">
              <div class="theme-preview" style="background:linear-gradient(135deg, #0d1117 50%, #ffffff 50%);"></div>
              <div class="theme-label">跟随系统</div>
              <div class="theme-desc">自动切换</div>
            </div>
          </div>
        </div>

        <!-- Notifications -->
        <div id="section-notifications" class="settings-section">
          <div class="settings-section-title">通知偏好</div>
          <div class="settings-row">
            <span class="row-label">会话完成通知</span>
            <div :class="['toggle-switch', { on: notifyCompleted }]" @click="notifyCompleted = !notifyCompleted"></div>
          </div>
          <div class="settings-row">
            <span class="row-label">错误告警</span>
            <div :class="['toggle-switch', { on: notifyErrors }]" @click="notifyErrors = !notifyErrors"></div>
          </div>
          <div class="settings-row">
            <span class="row-label">主机上下线通知</span>
            <div :class="['toggle-switch', { on: notifyDaemon }]" @click="notifyDaemon = !notifyDaemon"></div>
          </div>
          <div class="settings-row">
            <span class="row-label">产品更新</span>
            <div :class="['toggle-switch', { on: notifyUpdates }]" @click="notifyUpdates = !notifyUpdates"></div>
          </div>
        </div>

        <!-- About -->
        <div id="section-about" class="settings-section">
          <div class="settings-section-title">其他</div>
          <div class="settings-row" @click="showAbout = true">
            <div class="row-icon" style="background:var(--accent-muted);color:var(--accent);">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
            </div>
            <span class="row-label">关于 pocketctl</span>
            <span class="row-value">v1.0.1 <span class="chevron">›</span></span>
          </div>
          <div class="settings-row" @click="showHelp = true">
            <div class="row-icon" style="background:var(--accent-muted);color:var(--accent);">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>
            </div>
            <span class="row-label">帮助与反馈</span>
            <span class="row-value"><span class="chevron">›</span></span>
          </div>
          <div class="settings-row" @click="showPrivacy = true">
            <div class="row-icon" style="background:var(--accent-muted);color:var(--accent);">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
            </div>
            <span class="row-label">隐私政策</span>
            <span class="row-value"><span class="chevron">›</span></span>
          </div>
          <div class="settings-row" @click="showAgreement = true">
            <div class="row-icon" style="background:var(--accent-muted);color:var(--accent);">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>
            </div>
            <span class="row-label">用户协议</span>
            <span class="row-value"><span class="chevron">›</span></span>
          </div>
        </div>

        <!-- Modals -->
        <AboutModal v-if="showAbout" @close="showAbout = false" />
        <HelpModal v-if="showHelp" @close="showHelp = false" />
        <PrivacyModal v-if="showPrivacy" @close="showPrivacy = false" />
        <AgreementModal v-if="showAgreement" @close="showAgreement = false" />

        <!-- Logout -->
        <div class="settings-section">
          <div class="settings-row danger" style="justify-content:center;">
            <span class="row-label" style="text-align:center;" @click="handleLogout" role="button">退出登录</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import { useWebSocket } from '../composables/useWebSocket'
import AboutModal from '../components/AboutModal.vue'
import HelpModal from '../components/HelpModal.vue'
import PrivacyModal from '../components/PrivacyModal.vue'
import AgreementModal from '../components/AgreementModal.vue'
import EditProfileModal from '../components/EditProfileModal.vue'
import BindEmailModal from '../components/BindEmailModal.vue'
import RegisterDaemonDialog from '../components/RegisterDaemonDialog.vue'

const router = useRouter()
const { user, logout } = useAuth()
const { connect, send, onEvent } = useWebSocket()

const daemons = ref<any[]>([])
const currentTheme = ref(localStorage.getItem('pocketctl-theme') || 'dark')
const notifyCompleted = ref(true)
const notifyErrors = ref(true)
const notifyDaemon = ref(true)
const notifyUpdates = ref(false)
const showAbout = ref(false)
const showHelp = ref(false)
const showPrivacy = ref(false)
const showAgreement = ref(false)
const showEditProfile = ref(false)
const showBindEmail = ref(false)
const showRegisterDaemon = ref(false)

const userInitial = computed(() => {
  const name = user.value?.display_name || user.value?.email || user.value?.phone || 'U'
  return name.charAt(0).toUpperCase()
})

const userDisplayName = computed(() => {
  return user.value?.display_name || '用户'
})

const userMasked = computed(() => {
  const phone = user.value?.phone
  if (phone) return phone.slice(0, 3) + '****' + phone.slice(-4)
  return user.value?.email || ''
})

const userEmail = computed(() => {
  const email = user.value?.email
  if (email && !email.startsWith('1')) return email
  return '未绑定'
})

function maskPhone(phone: string): string {
  return phone.slice(0, 3) + '****' + phone.slice(-4)
}

function setTheme(t: string) {
  if (t === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light')
  } else {
    document.documentElement.setAttribute('data-theme', t)
  }
  localStorage.setItem('pocketctl-theme', t)
  currentTheme.value = t
}

function scrollTo(id: string) {
  const el = document.getElementById('section-' + id)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  // Update active nav
  document.querySelectorAll('.settings-nav-item').forEach(n => n.classList.remove('active'))
  const navItems = document.querySelectorAll('.settings-nav-item')
  const navLabels = ['profile', 'daemons', 'appearance', 'notifications', 'about']
  const idx = navLabels.indexOf(id)
  if (idx >= 0 && navItems[idx]) navItems[idx].classList.add('active')
}

function handleLogout() {
  logout()
  router.push('/login')
}

function onProfileSaved(name: string) {
  if (user.value) user.value.display_name = name
  showEditProfile.value = false
}

function onEmailSaved(email: string) {
  if (user.value) user.value.email = email
  showBindEmail.value = false
}

onMounted(() => {
  connect()
  send({ type: 'list_sessions' })

  onEvent('daemon_status', (msg: any) => {
    const idx = daemons.value.findIndex((d: any) => d.daemon_id === msg.daemon_id)
    if (msg.status === 'online') {
      if (idx >= 0) { daemons.value[idx].daemon_online = true }
      else { daemons.value.push({ daemon_id: msg.daemon_id, hostname: msg.hostname, daemon_online: true, daemon_alias: msg.alias || null }) }
    } else if (msg.status === 'offline') {
      if (idx >= 0) daemons.value[idx].daemon_online = false
    }
  })
})
</script>

<style>
.settings-grid { display: grid; grid-template-columns: 240px 1fr; gap: 32px; }
.settings-nav { position: sticky; top: calc(var(--topbar-h) + 24px); align-self: start; }
.settings-nav-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: var(--radius-md); font-size: 14px; color: var(--fg-secondary); cursor: pointer; transition: background 0.15s, color 0.15s; margin-bottom: 2px; }
.settings-nav-item:hover { background: var(--surface-hover); color: var(--fg); }
.settings-nav-item.active { background: var(--sidebar-active); color: var(--accent); font-weight: 500; }
.settings-nav-item svg { width: 16px; height: 16px; flex-shrink: 0; }

.settings-section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; margin-bottom: 16px; transition: background var(--transition), border-color var(--transition); }
.settings-section-title { font-size: 16px; font-weight: 600; color: var(--fg); padding: 16px 20px; border-bottom: 1px solid var(--border); }
.settings-row { display: flex; align-items: center; padding: 14px 20px; gap: 12px; border-bottom: 1px solid var(--border); transition: background 0.1s; }
.settings-row:last-child { border-bottom: none; }
.settings-row:hover { background: var(--surface-hover); }
.settings-row .row-icon { width: 32px; height: 32px; border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0; }
.settings-row .row-label { flex: 1; font-size: 14px; color: var(--fg); }
.settings-row .row-value { font-size: 14px; color: var(--fg-secondary); display: flex; align-items: center; gap: 6px; }
.settings-row .row-value .bound { color: var(--success); }
.settings-row .row-value .unbound { color: var(--fg-tertiary); }
.settings-row .chevron { color: var(--fg-tertiary); font-size: 13px; }
.settings-row.danger .row-label { color: var(--error); font-weight: 500; }

.profile-card { display: flex; align-items: center; gap: 20px; padding: 24px 20px; border-bottom: 1px solid var(--border); }
.profile-avatar { width: 64px; height: 64px; border-radius: 50%; background: var(--surface-active); border: 2px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 600; color: var(--fg-secondary); flex-shrink: 0; }
.profile-info { flex: 1; }
.profile-info .profile-name { font-size: 18px; font-weight: 600; color: var(--fg); }
.profile-info .profile-email { font-size: 14px; color: var(--fg-secondary); margin-top: 2px; }
.profile-info .profile-edit { font-size: 13px; color: var(--accent); background: none; border: none; cursor: pointer; margin-top: 4px; padding: 0; }

.upgrade-card { background: var(--accent-subtle); border: 1px solid rgba(88,166,255,0.2); border-radius: var(--radius-lg); padding: 20px; display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
.upgrade-card .upgrade-icon { width: 40px; height: 40px; border-radius: var(--radius-md); background: var(--accent-muted); display: flex; align-items: center; justify-content: center; color: var(--accent); flex-shrink: 0; }
.upgrade-card .upgrade-text { flex: 1; }
.upgrade-card .upgrade-title { font-size: 15px; font-weight: 600; color: var(--accent); }
.upgrade-card .upgrade-desc { font-size: 13px; color: var(--fg-secondary); margin-top: 4px; }

.daemon-settings-row { display: flex; align-items: center; padding: 12px 20px; gap: 10px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.1s; }
.daemon-settings-row:last-child { border-bottom: none; }
.daemon-settings-row:hover { background: var(--surface-hover); }
.daemon-settings-row .daemon-name { flex: 1; font-size: 14px; color: var(--fg); }
.daemon-settings-row.add-daemon { color: var(--accent); font-size: 14px; justify-content: center; border-bottom: none; }

.theme-options { display: flex; gap: 12px; padding: 16px 20px; }
.theme-option { flex: 1; padding: 16px; border: 2px solid var(--border); border-radius: var(--radius-lg); cursor: pointer; text-align: center; transition: border-color 0.15s, background 0.15s; }
.theme-option:hover { border-color: var(--border-light); }
.theme-option.active { border-color: var(--accent); background: var(--accent-subtle); }
.theme-option .theme-preview { width: 48px; height: 48px; border-radius: var(--radius-md); margin: 0 auto 8px; border: 1px solid var(--border); }
.theme-preview.dark-preview { background: linear-gradient(135deg, #0d1117, #161b22); }
.theme-preview.light-preview { background: linear-gradient(135deg, #ffffff, #f6f8fa); }
.theme-option .theme-label { font-size: 13px; font-weight: 500; color: var(--fg); }
.theme-option .theme-desc { font-size: 11px; color: var(--fg-tertiary); margin-top: 2px; }

.toggle-switch { width: 44px; height: 24px; border-radius: 12px; background: var(--border); cursor: pointer; position: relative; transition: background 0.2s; flex-shrink: 0; }
.toggle-switch.on { background: var(--accent); }
.toggle-switch::after { content: ''; position: absolute; width: 18px; height: 18px; border-radius: 50%; background: #fff; top: 3px; left: 3px; transition: transform 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
.toggle-switch.on::after { transform: translateX(20px); }

@media (max-width: 768px) {
  .settings-grid { grid-template-columns: 1fr; }
  .settings-nav { position: static; display: flex; gap: 4px; overflow-x: auto; padding-bottom: 8px; }
  .settings-nav-item { white-space: nowrap; }
}
</style>
