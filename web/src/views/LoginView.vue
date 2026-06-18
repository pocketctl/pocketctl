<template>
  <div class="login-theme-toggle">
    <button class="theme-toggle" @click="toggleTheme" :title="t('common.toggle_theme')">
      <svg v-if="isDark" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
      <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
    </button>
  </div>

  <div class="login-page">
    <div class="login-container">
      <div class="login-brand">
        <div class="login-logo-wrapper">
          <img :src="logoPath" alt="pocketctl" />
        </div>
        <div class="brand-name">pocketctl</div>
        <div class="brand-tagline">{{ t('login.tagline') }}</div>
      </div>

      <div class="login-card">
        <div class="card-title">{{ t('login.title') }}</div>

        <div v-if="errorMsg" class="error-banner">
          <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 4h1.5v5h-1.5V5zm.75 6.5a.75.75 0 110-1.5.75.75 0 010 1.5z"/></svg>
          <span>{{ errorMsg }}</span>
        </div>

        <!-- Tab switcher -->
        <div class="login-tabs">
          <button :class="['login-tab', { active: tab === 'email' }]" @click="switchTab('email')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 6l-10 7L2 6"/></svg>
            {{ t('login.email_tab') }}
          </button>
          <button :class="['login-tab', { active: tab === 'qr' }]" @click="switchTab('qr')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20v.01"/></svg>
            {{ t('login.qr_tab') }}
          </button>
        </div>

        <!-- Email login -->
        <div v-if="tab === 'email'" class="login-form">
          <div>
            <div class="form-label">{{ t('login.email_label') }}</div>
            <div class="email-input-group">
              <input type="email" v-model="email" :placeholder="t('login.email_placeholder')" />
            </div>
          </div>
          <div>
            <div class="form-label">{{ t('login.code_label') }}</div>
            <div class="code-row">
              <input type="text" class="input-field code-input" v-model="code" :placeholder="t('login.code_placeholder')" maxlength="6" @input="filterCode" />
              <button :class="['get-code-btn', { disabled: countdown > 0 }]" @click="sendCode" :disabled="countdown > 0 || !isValidEmail">{{ countdown > 0 ? t('login.resend_code', { count: countdown }) : t('login.get_code') }}</button>
            </div>
          </div>
          <button class="login-btn" :disabled="loading || code.length !== 6" @click="doLogin">{{ loading ? t('login.logging_in') : t('login.login_btn') }}</button>
        </div>

        <!-- QR login -->
        <div v-else class="qr-box">
          <div :class="['qr-status-bar', qrStatusClass]">
            <span class="qr-dot"></span>
            <span>{{ qrStatusText }}</span>
          </div>
          <div class="qr-frame">
            <canvas ref="qrCanvas" width="176" height="176"></canvas>
            <div class="qr-logo">
              <svg width="20" height="20" viewBox="0 0 512 512" fill="none">
                <path d="M208 200 L304 256 L208 312" stroke="#58a6ff" stroke-width="28" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
              </svg>
            </div>
            <div v-if="qrExpired" class="qr-refresh">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              <span class="qr-expired-text">{{ t('login.qr_expired') }}</span>
              <span class="qr-refresh-btn" @click.stop="refreshQr" :class="{ refreshing: qrRefreshing }">
                <span v-if="qrRefreshing" class="qr-mini-spinner"></span>
                {{ qrRefreshing ? t('login.qr_refreshing') : t('login.qr_refresh') }}
              </span>
            </div>
          </div>
          <div class="qr-hint" v-html="t('login.qr_hint')"></div>
          <div class="qr-meta">
            <span class="qr-timer">{{ t('login.qr_expires_in', { time: qrCountdownText }) }}</span>
          </div>
        </div>

        <div class="terms-text">{{ t('login.terms') }}<a href="#" @click.prevent="showAgreement = true">{{ t('login.agreement') }}</a>和<a href="#" @click.prevent="showPrivacy = true">{{ t('login.privacy') }}</a></div>
      </div>

      <div class="login-footer">{{ t('login.auto_register') }} · <a href="#" @click.prevent="showHelp = true">{{ t('login.help') }}</a></div>

      <PrivacyModal v-if="showPrivacy" @close="showPrivacy = false" />
      <AgreementModal v-if="showAgreement" @close="showAgreement = false" />
      <HelpModal v-if="showHelp" @close="showHelp = false" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onUnmounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import QRCode from 'qrcode'
import { useAuth } from '../composables/useAuth'
import { useLocale } from '../composables/useLocale'
import logoDark from '../assets/logo-github-org.svg'
import logoLight from '../assets/logo-github-org-light.svg'
import PrivacyModal from '../components/PrivacyModal.vue'
import AgreementModal from '../components/AgreementModal.vue'
import HelpModal from '../components/HelpModal.vue'

const router = useRouter()
const { sendEmailCode, loginViaEmail, createQrLogin, pollQrLogin } = useAuth()
const { t } = useLocale()

// ---- shared ----
const email = ref('')
const code = ref('')
const errorMsg = ref('')
const loading = ref(false)
const countdown = ref(0)
const showPrivacy = ref(false)
const showAgreement = ref(false)
const showHelp = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

const currentTheme = ref(document.documentElement.getAttribute('data-theme') || 'dark')
const isDark = computed(() => currentTheme.value !== 'light')
const logoPath = computed(() => isDark.value ? logoDark : logoLight)
const isValidEmail = computed(() => email.value.trim().includes('@'))

function getTheme(): string { return document.documentElement.getAttribute('data-theme') || 'dark' }
function setTheme(theme: string) {
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem('pocketctl-theme', theme)
  currentTheme.value = theme
}
function toggleTheme() { setTheme(getTheme() === 'dark' ? 'light' : 'dark') }

function filterCode(e: Event) {
  code.value = (e.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6)
}

function startCountdown() {
  countdown.value = 60
  if (timer) clearInterval(timer)
  timer = setInterval(() => { countdown.value--; if (countdown.value <= 0 && timer) clearInterval(timer) }, 1000)
}

async function sendCode() {
  errorMsg.value = ''
  const err = await sendEmailCode(email.value.trim())
  if (err) { errorMsg.value = err; return }
  startCountdown()
}

async function doLogin() {
  errorMsg.value = ''; loading.value = true
  const err = await loginViaEmail(email.value.trim(), code.value)
  if (err) { errorMsg.value = err; loading.value = false }
  else router.push('/')
}

// ---- tab switch ----
const tab = ref<'email' | 'qr'>('email')

function switchTab(newTab: 'email' | 'qr') {
  if (tab.value === newTab) return
  tab.value = newTab
  errorMsg.value = ''
  if (newTab === 'qr') startQrLogin()
  else stopQrLogin()
}

// ---- QR login ----
const qrCanvas = ref<HTMLCanvasElement | null>(null)
const qrStatus = ref<'pending' | 'scanned' | 'confirmed' | 'expired'>('pending')
const qrExpired = ref(false)
const qrRefreshing = ref(false)
const qrCountdown = ref(0)
let qrToken = ''
let pollTimer: ReturnType<typeof setInterval> | null = null
let countdownTimer: ReturnType<typeof setInterval> | null = null

const qrStatusClass = computed(() => qrStatus.value)
const qrStatusText = computed(() => {
  switch (qrStatus.value) {
    case 'scanned': return t('login.qr_scanned')
    case 'confirmed': return t('login.qr_confirmed')
    case 'expired': return t('login.qr_expired_status')
    default: return t('login.qr_waiting')
  }
})
const qrCountdownText = computed(() => {
  const m = Math.floor(qrCountdown.value / 60)
  const s = qrCountdown.value % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
})

async function startQrLogin() {
  stopQrLogin()
  qrStatus.value = 'pending'
  qrExpired.value = false
  errorMsg.value = ''

  const { data, error } = await createQrLogin()
  if (error || !data) {
    errorMsg.value = error || t('login.generate_qr_failed')
    return
  }
  qrToken = data.qr_token
  qrCountdown.value = data.expires_in

  // Render QR
  await nextTick()
  if (qrCanvas.value) {
    try {
      await QRCode.toCanvas(qrCanvas.value, data.qr_payload, {
        width: 176,
        margin: 1,
        color: { dark: isDark.value ? '#0d1117' : '#1f2328', light: '#ffffff' },
      })
    } catch { /* ignore render error */ }
  }

  // Expiry countdown
  countdownTimer = setInterval(() => {
    qrCountdown.value--
    if (qrCountdown.value <= 0) {
      qrStatus.value = 'expired'
      qrExpired.value = true
      stopPolling()
    }
  }, 1000)

  // Poll status
  pollTimer = setInterval(async () => {
    if (!qrToken) return
    const result = await pollQrLogin(qrToken)
    if (result === 'confirmed') {
      stopQrLogin()
      qrStatus.value = 'confirmed'
      router.push('/')
    } else if (result === 'expired') {
      qrStatus.value = 'expired'
      qrExpired.value = true
      stopPolling()
    } else if (result === 'scanned' || result === 'pending') {
      qrStatus.value = result
    }
  }, 2000)
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

function stopQrLogin() {
  stopPolling()
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null }
  qrToken = ''
}

async function refreshQr() {
  if (qrRefreshing.value) return
  qrRefreshing.value = true
  await startQrLogin()
  qrRefreshing.value = false
}

onUnmounted(() => {
  if (timer) clearInterval(timer)
  stopQrLogin()
})
</script>
