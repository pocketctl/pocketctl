<template>
  <div class="page-container design-surface content settings-page">
    <p v-if="userPreferences.error.value" class="notice amber" role="alert">{{ t('common.error') }}: {{ userPreferences.error.value }}</p>
    <div v-if="!isMobile" class="settings-grid"><nav class="subnav" :aria-label="t('replica.settings_categories')"><button v-for="tab in settingsTabs" :key="tab.id" :class="{active:activeSetting===tab.id}" @click="activeSetting=tab.id"><WorkspaceIcon :name="tab.icon" class="icon small" />{{ t(tab.label) }}</button></nav><div class="settings-stage">
      <template v-if="activeSetting==='profile'">
        <section class="card"><header class="card-head"><h3>{{ t('replica.account_profile') }}</h3><button class="btn small" @click="showEditProfile=true">{{ t('settings.edit_profile') }}</button></header><div class="card-body row reference-profile"><span class="avatar">{{ userInitial }}</span><div><h2>{{ userDisplayName }}</h2><p class="sub">{{ userMasked }}</p></div><span class="grow" /><span class="badge blue">{{ user?.plan && user.plan!=='free'?'PRO':'FREE' }}</span></div><div class="setting-row"><WorkspaceIcon name="mail" class="icon" /><div class="grow"><strong>{{ t('login.email_label') }}</strong><p>{{ userEmail }}</p></div><button class="btn small" @click="showBindEmail=true">{{ t('replica.change_email') }}</button></div><div class="setting-row"><WorkspaceIcon name="shield" class="icon" /><div class="grow"><strong>{{ t('replica.account_plan') }}</strong><p>{{ t(user?.plan && user.plan!=='free'?'user.pro_plan':'user.free_plan') }}</p></div><button class="btn small" @click="openPlan($event)">{{ t('replica.manage_plan') }}</button></div></section>
        <section class="card settings-account-actions"><header class="card-head"><h3>{{ t('replica.account_actions') }}</h3></header><div class="setting-row"><div class="grow"><strong>{{ t('settings.logout') }}</strong><p>{{ t('replica.logout_copy') }}</p></div><button class="btn danger small" @click="handleLogout">{{ t('settings.logout') }}</button></div></section>
      </template>
      <template v-if="activeSetting==='appearance'"><section class="card"><header class="card-head"><h3>{{ t('settings.appearance') }}</h3><span class="sub">{{ t('replica.appearance_copy') }}</span></header><div class="theme-options"><button v-for="theme in themes" :key="theme.id" class="theme-option" :class="{active:currentTheme===theme.id}" @click="setTheme(theme.id)"><div class="theme-sample" :class="theme.id==='system'?'auto':theme.id"><span /><span /></div>{{ t(theme.label) }}</button></div></section><section class="card settings-account-actions"><header class="card-head"><h3>{{ t('replica.language') }}</h3></header><div class="setting-row"><WorkspaceIcon name="globe" class="icon" /><div class="grow"><strong>{{ t('replica.interface_language') }}</strong><p>{{ t('replica.language_copy') }}</p></div><ActionSelect><select :value="locale" :aria-label="t('replica.interface_language')" @change="setLocale(($event.target as HTMLSelectElement).value as 'zh'|'en')"><option value="zh">中文</option><option value="en">English</option></select></ActionSelect></div></section></template>
      <section v-if="activeSetting==='notifications'" class="card"><header class="card-head"><h3>{{ t('settings.notif_pref') }}</h3></header><div class="setting-row"><div class="grow"><button class="text-setting-label" @click="notificationsOpen=true"><strong>{{ t('replica.browser_notifications') }}</strong></button><p>{{ t('replica.browser_notifications_copy') }}</p></div><button class="switch" :class="{on:browserNotifications}" :aria-pressed="browserNotifications" :aria-label="t('replica.browser_notifications')" @click="toggleBrowserNotifications" /></div><div v-for="notice in noticePreferences.filter(notice=>!['errors','updates'].includes(notice.id))" :key="notice.id" class="setting-row"><div class="grow"><strong>{{ t(notice.label) }}</strong></div><button class="switch" :class="{on:notice.value}" :aria-pressed="notice.value" :aria-label="t(notice.label)" @click="setNotice(notice.id,!notice.value)" /></div><div class="card-body"><button class="btn" @click="sendTestNotification">{{ t('replica.send_test_notice') }}</button></div></section>
      <section v-if="activeSetting==='hosts'" class="card"><header class="card-head"><h3>{{ t('dashboard.my_hosts') }}</h3><button class="btn small" @click="showRegisterDaemon=true">{{ t('dashboard.register_host') }}</button></header><div v-for="daemon in daemons" :key="daemon.daemon_id" class="setting-row"><span class="dot" :class="{off:!daemon.daemon_online}" /><div class="grow"><strong>{{ daemon.daemon_alias || daemon.hostname || daemon.daemon_id.slice(0,8) }}</strong><p>{{ daemon.os }}</p></div><span class="badge" :class="daemon.daemon_online?'green':''">{{ t(daemon.daemon_online?'dashboard.online':'dashboard.offline') }}</span><button class="btn small" @click="router.push({path:'/hosts',query:{daemon_id:daemon.daemon_id}})">{{ t('dashboard.manage_all') }}</button><button v-if="daemon.daemon_online" class="btn danger small" :disabled="kickRateLimited" @click="startKickDaemon(daemon)">{{ t('settings.force_kick') }}</button></div></section>
      <section v-if="activeSetting==='install'" class="card"><header class="card-head"><h3>{{ t('pwa.section_title') }}</h3></header><div class="card-body"><InstallPwaCard /></div></section>
      <section v-if="activeSetting==='about'" class="card settings-about" data-testid="settings-about"><header class="card-head"><h3>{{ t('settings.about_pocketctl') }}</h3><span class="badge">v{{ APP_VERSION }}</span></header><div class="card-body"><div class="row about-brand"><span class="logo-mark"><img class="brand-dark" :src="logoDark" alt="" /><img class="brand-light" :src="logoLight" alt="" /></span><h2>PocketCtl</h2></div><p class="sub about-description">{{ t('replica.about_workspace_copy') }}</p></div><div v-for="link in appLinks.filter(link=>!['install','about'].includes(link.id))" :key="link.id" class="setting-row setting-link" @click="openAppLink(link.id)"><strong class="grow">{{ t(link.label) }}</strong><button type="button" class="icon-btn flat" :aria-label="t(link.label)" @click.stop="openAppLink(link.id)"><WorkspaceIcon name="chevron" class="icon small" /></button></div></section>
    </div></div>
    <div v-else class="ios-settings">
      <div class="ios-profile"><span class="avatar">{{ userInitial }}</span><strong>{{ userDisplayName }}</strong><button class="text-btn" @click="showEditProfile=true">{{ t('settings.edit_profile') }}</button></div>
      <RouterLink class="card ios-signature" to="/tokens"><div class="ios-heatmap" :aria-label="t('replica.usage_history')"><i v-for="cell in signatureCells" :key="cell.date" :class="'level-'+cell.level" :title="cell.date+' · '+cell.total" /></div><p>{{ t('replica.usage_history') }} · <strong>{{ formatTokenCount(signatureTotal) }}</strong> tokens</p></RouterLink>
      <h3 class="ios-section-label">{{ t('replica.account') }}</h3><section class="card"><button class="ios-settings-row" @click="showBindEmail=true"><WorkspaceIcon name="mail" class="icon" /><span class="grow">{{ t('login.email_label') }}</span><span class="value">{{ userEmail }}</span><WorkspaceIcon name="chevron" class="icon small" /></button><button class="ios-settings-row" @click="openPlan($event)"><WorkspaceIcon name="user" class="icon" /><span class="grow">{{ t('replica.account_plan') }}</span><span class="value">{{ user?.plan && user.plan!=='free'?'PRO':'FREE' }}</span><WorkspaceIcon name="chevron" class="icon small" /></button><button class="ios-settings-row" @click="router.push('/hosts')"><WorkspaceIcon name="hosts" class="icon" /><span class="grow">{{ t('dashboard.my_hosts') }}</span><span class="value">{{ daemons.length }} {{ t('hosts.host_unit') }}</span><WorkspaceIcon name="chevron" class="icon small" /></button></section>
      <h3 class="ios-section-label">{{ t('replica.preferences') }}</h3><section class="card"><div class="ios-settings-row"><WorkspaceIcon name="sun" class="icon" /><span class="grow">{{ t('settings.appearance') }}</span><div class="segments"><button v-for="theme in themes" :key="theme.id" :class="{active:currentTheme===theme.id}" @click="setTheme(theme.id)">{{ t(theme.id==='system'?'replica.auto':theme.label) }}</button></div></div><div class="ios-settings-row"><WorkspaceIcon name="inbox" class="icon" /><button class="grow text-setting-label" @click="notificationsOpen=true">{{ t('replica.browser_notifications') }}</button><button class="switch" :class="{on:browserNotifications}" :aria-label="t('replica.browser_notifications')" :aria-pressed="browserNotifications" @click="toggleBrowserNotifications" /></div><div v-for="notice in noticePreferences.filter(notice=>!['errors','updates'].includes(notice.id))" :key="notice.id" class="ios-settings-row"><WorkspaceIcon :name="notice.id==='completed'?'check':notice.id==='daemon'?'hosts':'inbox'" class="icon" /><span class="grow">{{ t(notice.label) }}</span><button class="switch" :class="{on:notice.value}" :aria-label="t(notice.label)" :aria-pressed="notice.value" @click="setNotice(notice.id,!notice.value)" /></div><button class="ios-settings-row" @click="sendTestNotification"><WorkspaceIcon name="inbox" class="icon" /><span class="grow">{{ t('replica.send_test_notice') }}</span><WorkspaceIcon name="chevron" class="icon small" /></button><div class="ios-settings-row"><WorkspaceIcon name="globe" class="icon" /><span class="grow">{{ t('replica.interface_language') }}</span><ActionSelect><select :value="locale" :aria-label="t('replica.interface_language')" @change="setLocale(($event.target as HTMLSelectElement).value as 'zh'|'en')"><option value="zh">中文</option><option value="en">English</option></select></ActionSelect></div></section>
      <h3 class="ios-section-label">{{ t('replica.application') }}</h3><section class="card"><button v-for="link in appLinks" :key="link.id" class="ios-settings-row" @click="openAppLink(link.id)"><WorkspaceIcon :name="link.icon" class="icon" /><span class="grow">{{ t(link.label) }}</span><WorkspaceIcon name="chevron" class="icon small" /></button></section><button class="btn danger" @click="handleLogout">{{ t('settings.logout') }}</button>
    </div>
    <p v-if="noticeMessage" class="notice" role="status">{{ noticeMessage }}</p>
    <ActionList v-if="notificationsOpen" :title="t('settings.notif_pref')" @close="notificationsOpen=false"><div v-for="notice in noticePreferences" :key="notice.id" class="notification-preference"><strong>{{ t(notice.label) }}</strong><button class="switch" :class="{on:notice.value}" :aria-pressed="notice.value" :aria-label="t(notice.label)" @click="setNotice(notice.id,!notice.value)" /></div></ActionList>
    <ActionList v-if="planOpen" :anchor="planAnchor" :title="t('replica.account_plan')" @close="planOpen=false"><p class="plan-copy">{{ t(user?.plan && user.plan!=='free'?'user.pro_plan':'user.free_plan') }}</p><p class="sub">{{ t('settings.upgrade_desc') }}</p></ActionList>
    <ActionList v-if="installOpen" :anchor="installAnchor" :title="t('pwa.section_title')" @close="installOpen=false"><InstallPwaCard /></ActionList>
    <AboutModal v-if="showAbout" workspace @close="showAbout=false" /><HelpModal v-if="showHelp" @close="showHelp=false" /><PrivacyModal v-if="showPrivacy" @close="showPrivacy=false" /><AgreementModal v-if="showAgreement" @close="showAgreement=false" /><EditProfileModal v-if="showEditProfile" @close="showEditProfile=false" @saved="onProfileSaved" /><BindEmailModal v-if="showBindEmail" @close="showBindEmail=false" @saved="onEmailSaved" /><RegisterDaemonDialog v-if="showRegisterDaemon" @close="showRegisterDaemon=false" />
          <div v-if="kickTarget" class="modal-overlay" @click.self="kickTarget = null">
            <div class="modal-card kick-modal">
              <div class="modal-title">⚠️ {{ t('settings.force_kick_confirm') }}</div>
              <p>{{ t('settings.force_kick_warning') }} <strong>{{ kickTarget.daemon_alias || kickTarget.hostname }}</strong></p>
              <p style="font-size:12px;color:var(--fg-tertiary);">{{ t('settings.force_kick_desc') }}</p>
              <div style="margin:12px 0;">
                <div class="form-label">{{ t('settings.email_code') }}</div>
                <div class="code-row">
                  <input type="text" class="input-field code-input" v-model="kickCode" :placeholder="t('login.code_placeholder')" maxlength="6" @input="(e: any) => kickCode = e.target.value.replace(/\D/g, '').slice(0, 6)" />
                  <button class="get-code-btn" @click="sendKickCode" :disabled="kickCountdown > 0">{{ kickCountdown > 0 ? kickCountdown + 's' : t('settings.send_code') }}</button>
                </div>
              </div>
              <p v-if="kickError" style="color:var(--error);font-size:12px;">{{ kickError }}</p>
              <div class="modal-actions">
                <button class="btn-secondary" @click="kickTarget = null; kickError = ''">{{ t('common.cancel') }}</button>
                <button class="btn-danger" @click="doKickDaemon" :disabled="kickCode.length !== 6">{{ t('settings.force_kick_confirm') }}</button>
              </div>
            </div>
          </div>
  </div>
</template>
<script setup lang="ts">
import WorkspaceIcon from '../components/WorkspaceIcon.vue'
import logoDark from '../assets/logo-github-org.svg'
import logoLight from '../assets/logo-github-org-light.svg'
import { APP_VERSION } from '../utils/appInfo'
import ActionSelect from '../components/ActionSelect.vue'
import ActionList from '../components/ActionList.vue'
import { useResponsiveLayout } from '../composables/useResponsiveLayout'
import { formatTokenCount } from '../utils/tokenFormat'
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import { useWebSocket } from '../composables/useWebSocket'
import { useUserPreferences } from '../composables/useUserPreferences'
import { useLocale } from '../composables/useLocale'
import AboutModal from '../components/AboutModal.vue'
import HelpModal from '../components/HelpModal.vue'
import PrivacyModal from '../components/PrivacyModal.vue'
import AgreementModal from '../components/AgreementModal.vue'
import EditProfileModal from '../components/EditProfileModal.vue'
import BindEmailModal from '../components/BindEmailModal.vue'
import RegisterDaemonDialog from '../components/RegisterDaemonDialog.vue'
import InstallPwaCard from '../components/pwa/InstallPwaCard.vue'

const router = useRouter()
const { user, logout, sendEmailCode, forceKickDaemon, apiGetAuth } = useAuth()
const { connect, send, onEvent } = useWebSocket()
const { t,locale } = useLocale()
const userPreferences=useUserPreferences()
const setLocale=(locale:'zh'|'en')=>void userPreferences.save({locale})
onMounted(()=>void userPreferences.load())
const { isMobile } = useResponsiveLayout()

const activeSetting=ref('profile')
const settingsTabs=[{id:'profile',label:'replica.account_profile',icon:'user'},{id:'appearance',label:'replica.appearance_language',icon:'sun'},{id:'notifications',label:'settings.notifications',icon:'inbox'},{id:'hosts',label:'replica.host_management',icon:'hosts'},{id:'install',label:'replica.install_app',icon:'laptop'},{id:'about',label:'settings.about',icon:'help'}]
const themes=[{id:'light',label:'settings.theme_light'},{id:'dark',label:'settings.theme_dark'},{id:'system',label:'settings.theme_auto'}]
async function handleLogout(){await logout();await router.replace('/login')}
const appLinks=[{id:'install',label:'replica.add_home_screen',icon:'laptop'},{id:'help',label:'replica.help_guide',icon:'help'},{id:'commands',label:'replica.command_reference',icon:'terminal'},{id:'privacy',label:'settings.privacy_policy',icon:'lock'},{id:'agreement',label:'settings.user_agreement',icon:'file'},{id:'about',label:'settings.about_pocketctl',icon:'help'}]
const noticePreferences=computed(()=>[{id:'completed',label:'settings.notif_session',value:notifyCompleted.value},{id:'daemon',label:'settings.notif_host',value:notifyDaemon.value},{id:'errors',label:'settings.notif_error',value:notifyErrors.value},{id:'updates',label:'settings.notif_product',value:notifyUpdates.value}])
function setNotice(id:string,value:boolean){void userPreferences.save({notifications:{[id]:value}})}
const notificationsOpen=ref(false)
const planOpen=ref(false),planAnchor=ref<HTMLElement|null>(null),installOpen=ref(false),installAnchor=ref<HTMLElement|null>(null),noticeMessage=ref('')
function openPlan(event:MouseEvent){planAnchor.value=event.currentTarget as HTMLElement;planOpen.value=true}
function openAppLink(id:string){if(id==='help'||id==='commands')showHelp.value=true;else if(id==='privacy')showPrivacy.value=true;else if(id==='agreement')showAgreement.value=true;else if(id==='about')showAbout.value=true;else if(id==='install'){installAnchor.value=document.activeElement as HTMLElement;installOpen.value=true}}
const browserNotifications=computed(()=>userPreferences.preferences.value.notifications.browser && typeof Notification!=='undefined' && Notification.permission==='granted')
async function toggleBrowserNotifications(){
  if(browserNotifications.value){await userPreferences.save({notifications:{browser:false}});return}
  if(typeof Notification==='undefined'){noticeMessage.value=t('replica.notifications_unavailable');return}
  try{if(await Notification.requestPermission()==='granted')await userPreferences.save({notifications:{browser:true}});else noticeMessage.value=t('replica.notifications_unavailable')}catch{noticeMessage.value=t('replica.notifications_unavailable')}
}
async function sendTestNotification(){if(!browserNotifications.value)await toggleBrowserNotifications();if(browserNotifications.value)new Notification('PocketCtl',{body:t('replica.test_notice')})}
const signatureTotal=ref(0),signatureSeries=ref<any[]>([])
const signatureCells=computed(()=>{const byDate=new Map(signatureSeries.value.map(day=>[String(day.date).slice(0,10),Number(day.input||0)+Number(day.output||0)])),max=Math.max(1,...byDate.values());return Array.from({length:140},(_,index)=>{const date=new Date();date.setUTCDate(date.getUTCDate()-139+index);const key=date.toISOString().slice(0,10),total=byDate.get(key)||0;return {date:key,total,level:total?Math.min(4,Math.max(1,Math.ceil(total/max*4))):0}})})
onMounted(async()=>{if(!apiGetAuth)return;const result=await apiGetAuth('/api/tokens/dashboard?daemon=all&days=150');if(result.ok){signatureSeries.value=result.data.dailySeries||[];signatureTotal.value=result.data.summary?.total||0}})
const daemons = ref<any[]>([])
const currentTheme = computed(()=>userPreferences.preferences.value.theme)
const notifyCompleted = computed(()=>userPreferences.preferences.value.notifications.completed)
const notifyErrors = computed(()=>userPreferences.preferences.value.notifications.errors)
const notifyDaemon = computed(()=>userPreferences.preferences.value.notifications.daemon)
const notifyUpdates = computed(()=>userPreferences.preferences.value.notifications.updates)
const showAbout = ref(false)
const showHelp = ref(false)
const showPrivacy = ref(false)
const showAgreement = ref(false)
const showEditProfile = ref(false)
const showBindEmail = ref(false)
const showRegisterDaemon = ref(false)

// Force-kick state
const kickTarget = ref<any>(null)
const kickCode = ref('')
const kickError = ref('')
const kickCountdown = ref(0)
const kickRateLimited = ref(false)
let kickTimer: ReturnType<typeof setInterval> | null = null

const userInitial = computed(() => {
  const name = user.value?.display_name || user.value?.email || user.value?.phone || 'U'
  return name.charAt(0).toUpperCase()
})

const userDisplayName = computed(() => {
  return user.value?.display_name || t('user.guest')
})

const userMasked = computed(() => {
  return user.value?.email || ''
})

const userEmail = computed(() => {
  const email = user.value?.email
  if (email && !email.startsWith('1')) return email
  return t('settings.not_bound')
})

function setTheme(theme: string) {void userPreferences.save({theme:theme as 'system'|'light'|'dark'})}


function onProfileSaved(name: string) {
  if (user.value) user.value.display_name = name
  showEditProfile.value = false
}

function onEmailSaved(email: string) {
  if (user.value) user.value.email = email
  showBindEmail.value = false
}

const settingsCleanups:Array<()=>void>=[]
onBeforeUnmount(()=>{settingsCleanups.forEach(cleanup=>cleanup());if(kickTimer)clearInterval(kickTimer)})
onMounted(() => {
  connect()
  send({ type: 'list_sessions' })
  send({ type: 'list_daemons' })
  settingsCleanups.push(onEvent('daemon_list',(message:any)=>{daemons.value=message.daemons||[]}))

  settingsCleanups.push(onEvent('daemon_status', (msg: any) => {
    const idx = daemons.value.findIndex((d: any) => d.daemon_id === msg.daemon_id)
    if (msg.status === 'online') {
      if (idx >= 0) { daemons.value[idx].daemon_online = true }
      else { daemons.value.push({ daemon_id: msg.daemon_id, hostname: msg.hostname, daemon_online: true, daemon_alias: msg.alias || null }) }
    } else if (msg.status === 'offline') {
      if (idx >= 0) daemons.value[idx].daemon_online = false
    }
  }))
})
// Force-kick functions
function startKickDaemon(d: any) {
  kickTarget.value = d
  kickCode.value = ''
  kickError.value = ''
}

async function sendKickCode() {
  if (!user.value?.email) {
    kickError.value = t('settings.bind_email_first')
    return
  }
  kickError.value = ''
  await sendEmailCode(user.value.email)
  kickCountdown.value = 60
  if (kickTimer) clearInterval(kickTimer)
  kickTimer = setInterval(() => {
    kickCountdown.value--
    if (kickCountdown.value <= 0 && kickTimer) clearInterval(kickTimer)
  }, 1000)
}

async function doKickDaemon() {
  if (!kickTarget.value) return
  kickError.value = ''
  const err = await forceKickDaemon(kickTarget.value.daemon_id, kickCode.value)
  if (err) {
    kickError.value = err
    return
  }
  const idx = daemons.value.findIndex((d: any) => d.daemon_id === kickTarget.value.daemon_id)
  if (idx >= 0) daemons.value[idx].daemon_online = false
  kickTarget.value = null
}

</script>
