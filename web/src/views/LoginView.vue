<template>
  <div class="login-theme-toggle">
    <button class="theme-toggle" @click="toggleTheme" title="切换主题">
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
        <div class="brand-tagline">远程掌控你的 AI 编程助手</div>
      </div>

      <div class="login-card">
        <div class="card-title">登录你的账户</div>

        <div v-if="errorMsg" class="error-banner">
          <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 4h1.5v5h-1.5V5zm.75 6.5a.75.75 0 110-1.5.75.75 0 010 1.5z"/></svg>
          <span>{{ errorMsg }}</span>
        </div>

        <!-- Tab switcher -->
        <div class="login-tabs">
          <button :class="['login-tab', { active: tab === 'email' }]" @click="switchTab('email')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 6l-10 7L2 6"/></svg>
            邮箱登录
          </button>
          <button :class="['login-tab', { active: tab === 'qr' }]" @click="switchTab('qr')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20v.01"/></svg>
            扫码登录
          </button>
        </div>

        <!-- Email login -->
        <div v-if="tab === 'email'" class="login-form">
          <div>
            <div class="form-label">邮箱地址</div>
            <div class="email-input-group">
              <input type="email" v-model="email" placeholder="请输入邮箱地址" />
            </div>
          </div>
          <div>
            <div class="form-label">验证码</div>
            <div class="code-row">
              <input type="text" class="input-field code-input" v-model="code" placeholder="6 位验证码" maxlength="6" @input="filterCode" />
              <button :class="['get-code-btn', { disabled: countdown > 0 }]" @click="sendCode" :disabled="countdown > 0 || !isValidEmail">{{ countdown > 0 ? countdown + 's 后重发' : '获取验证码' }}</button>
            </div>
          </div>
          <button class="login-btn" :disabled="loading || code.length !== 6" @click="doLogin">{{ loading ? '登录中...' : '登录' }}</button>
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
              <span class="qr-expired-text">二维码已过期</span>
              <span class="qr-refresh-btn" @click.stop="refreshQr" :class="{ refreshing: qrRefreshing }">
                <span v-if="qrRefreshing" class="qr-mini-spinner"></span>
                {{ qrRefreshing ? '刷新中…' : '请刷新' }}
              </span>
            </div>
          </div>
          <div class="qr-hint">请使用 <strong>pocketctl App</strong> 扫描上方二维码登录</div>
          <div class="qr-meta">
            <span class="qr-timer">二维码 {{ qrCountdownText }} 后失效</span>
          </div>
        </div>

        <div class="terms-text">登录即同意<a href="#" @click.prevent="showAgreement = true">《用户协议》</a>和<a href="#" @click.prevent="showPrivacy = true">《隐私政策》</a></div>
      </div>

      <div class="login-footer">登录即自动注册 · <a href="#" @click.prevent="showHelp = true">帮助中心</a></div>

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
import logoDark from '../assets/logo-github-org.svg'
import logoLight from '../assets/logo-github-org-light.svg'
import PrivacyModal from '../components/PrivacyModal.vue'
import AgreementModal from '../components/AgreementModal.vue'
import HelpModal from '../components/HelpModal.vue'

const router = useRouter()
const { sendEmailCode, loginViaEmail, createQrLogin, pollQrLogin } = useAuth()

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
function setTheme(t: string) {
  document.documentElement.setAttribute('data-theme', t)
  localStorage.setItem('pocketctl-theme', t)
  currentTheme.value = t
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

function switchTab(t: 'email' | 'qr') {
  if (tab.value === t) return
  tab.value = t
  errorMsg.value = ''
  if (t === 'qr') startQrLogin()
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
    case 'scanned': return '已扫描，请在 App 内确认'
    case 'confirmed': return '已确认，正在登录…'
    case 'expired': return '二维码已失效'
    default: return '等待 App 扫码'
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
    errorMsg.value = error || '生成二维码失败'
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
    } else {
      // network/other error string — keep polling, don't spam banner
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

<style>
.login-theme-toggle { position: fixed; top: 20px; right: 20px; z-index: 10; }
.login-page {
  min-height: 100vh; min-height: 100dvh;
  display: flex; align-items: center; justify-content: center;
  padding: 24px; position: relative; overflow: hidden;
}
.login-page::before {
  content: ''; position: absolute; width: 600px; height: 600px;
  border-radius: 50%; background: radial-gradient(circle, var(--accent-muted) 0%, transparent 70%);
  top: -200px; right: -150px; opacity: 0.5; pointer-events: none;
}
.login-page::after {
  content: ''; position: absolute; width: 400px; height: 400px;
  border-radius: 50%; background: radial-gradient(circle, var(--success-bg) 0%, transparent 70%);
  bottom: -100px; left: -100px; opacity: 0.6; pointer-events: none;
}
.login-container { width: 100%; max-width: 420px; position: relative; z-index: 1; }
.login-brand { display: flex; flex-direction: column; align-items: center; margin-bottom: 40px; }
.login-logo-wrapper { width: 64px; height: 64px; border-radius: 16px; overflow: hidden; margin-bottom: 16px; box-shadow: var(--shadow-md); }
.login-logo-wrapper img { width: 100%; height: 100%; object-fit: cover; }
.brand-name { font-family: var(--font-display); font-size: 28px; font-weight: 700; color: var(--accent); margin-bottom: 6px; }
.brand-tagline { font-size: 15px; color: var(--fg-secondary); text-align: center; }
.login-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-xl); padding: 32px; box-shadow: var(--shadow-lg); }
.card-title { font-family: var(--font-display); font-size: 22px; font-weight: 600; color: var(--fg); text-align: center; margin-bottom: 24px; }

/* Tabs */
.login-tabs { display: flex; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 3px; margin-bottom: 24px; }
.login-tab { flex: 1; padding: 10px; border: none; border-radius: 6px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s; background: transparent; color: var(--fg-secondary); display: flex; align-items: center; justify-content: center; gap: 6px; }
.login-tab.active { background: var(--surface); color: var(--fg); box-shadow: var(--shadow-sm); }
.login-tab:hover:not(.active) { color: var(--fg); }
.login-tab svg { width: 16px; height: 16px; }

.login-form { display: flex; flex-direction: column; gap: 16px; }
.form-label { font-size: 13px; font-weight: 500; color: var(--fg-secondary); margin-bottom: 6px; }
.code-row { display: flex; gap: 8px; }
.code-row .input-field { flex: 1; }
.code-input { font-family: var(--font-mono) !important; letter-spacing: 4px; font-size: 18px !important; text-align: center; }
.get-code-btn { white-space: nowrap; padding: 10px 16px; background: none; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--accent); font-family: var(--font-body); font-size: 13px; cursor: pointer; transition: background 0.15s, border-color 0.15s; flex-shrink: 0; }
.get-code-btn:hover:not(:disabled) { background: var(--surface-hover); border-color: var(--border-light); }
.get-code-btn.disabled, .get-code-btn:disabled { color: var(--fg-tertiary); cursor: not-allowed; }
.email-input-group { display: flex; border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; background: var(--bg); transition: border-color 0.15s; }
.email-input-group:focus-within { border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--accent-muted); }
.email-input-group input { flex: 1; background: none; border: none; padding: 10px 14px; color: var(--fg); font-size: 14px; font-family: var(--font-body); outline: none; min-width: 0; }
.email-input-group input::placeholder { color: var(--fg-tertiary); }
.login-btn { width: 100%; padding: 14px; background: var(--primary-btn); color: #fff; border: none; border-radius: var(--radius-md); font-family: var(--font-display); font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.15s; margin-top: 4px; }
.login-btn:hover:not(:disabled) { background: var(--primary-btn-hover); }
.login-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* QR login */
.qr-box { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 4px 0; }
.qr-status-bar { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: var(--radius-full); font-size: 13px; font-weight: 500; background: var(--success-bg); color: var(--success); transition: background 0.2s, color 0.2s; }
.qr-status-bar .qr-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--success); animation: pulse-green 1.5s infinite; }
.qr-status-bar.scanned { background: var(--accent-muted); color: var(--accent); }
.qr-status-bar.scanned .qr-dot { background: var(--accent); animation: none; }
.qr-status-bar.confirmed { background: var(--accent-muted); color: var(--accent); }
.qr-status-bar.confirmed .qr-dot { background: var(--accent); animation: none; }
.qr-status-bar.expired { background: var(--error-bg); color: var(--error); }
.qr-status-bar.expired .qr-dot { background: var(--error); animation: none; }
@keyframes pulse-green { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.qr-frame { width: 200px; height: 200px; padding: 12px; background: #fff; border-radius: var(--radius-md); position: relative; display: flex; align-items: center; justify-content: center; }
.qr-frame canvas { display: block; }
.qr-logo { position: absolute; width: 40px; height: 40px; border-radius: 8px; background: #fff; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 0 4px #fff, 0 0 0 5px rgba(0,0,0,0.06); }
.qr-refresh { position: absolute; inset: 0; background: rgba(128,128,128,0.55); border-radius: var(--radius-md); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: #fff; font-size: 12px; cursor: pointer; backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }
.qr-refresh:hover { background: rgba(128,128,128,0.65); }
.qr-expired-text { font-size: 15px; font-weight: 600; color: #fff; }
.qr-refresh-btn { margin-top: 6px; padding: 6px 20px; background: var(--accent); color: #fff; border-radius: var(--radius-md); font-size: 13px; font-weight: 600; cursor: pointer; transition: background 0.15s; display: inline-flex; align-items: center; gap: 6px; }
.qr-refresh-btn:hover { background: var(--accent-hover); }
.qr-refresh-btn.refreshing { opacity: 0.7; cursor: not-allowed; }
.qr-mini-spinner { width: 12px; height: 12px; border: 2px solid rgba(255,255,255,0.35); border-top-color: #fff; border-radius: 50%; animation: qr-spin 0.7s linear infinite; display: inline-block; }
@keyframes qr-spin { to { transform: rotate(360deg); } }
.qr-hint { font-size: 13px; color: var(--fg-secondary); text-align: center; line-height: 1.5; }
.qr-hint strong { color: var(--accent); }
.qr-meta { display: flex; align-items: center; gap: 12px; }
.qr-timer { font-size: 12px; color: var(--fg-tertiary); font-family: var(--font-mono); }

.terms-text { font-size: 12px; color: var(--fg-tertiary); text-align: center; line-height: 1.6; margin-top: 8px; }
.terms-text a { color: var(--accent); text-decoration: none; }
.terms-text a:hover { text-decoration: underline; }
.error-banner { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: var(--radius-md); background: var(--error-bg); color: var(--error); font-size: 13px; margin-bottom: 16px; }
.error-banner svg { width: 16px; height: 16px; flex-shrink: 0; }
.login-footer { text-align: center; margin-top: 32px; font-size: 13px; color: var(--fg-tertiary); }
.login-footer a { color: var(--accent); text-decoration: none; }
@media (max-width: 480px) { .login-card { padding: 24px 20px; } .brand-name { font-size: 24px; } }
</style>
