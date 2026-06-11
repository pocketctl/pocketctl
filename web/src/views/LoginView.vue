<template>
  <!-- Theme Toggle (fixed position) -->
  <div class="login-theme-toggle">
    <button class="theme-toggle" @click="toggleTheme" title="切换主题">
      <svg v-if="isDark" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
      <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
    </button>
  </div>

  <div class="login-page">
    <div class="login-container">
      <!-- Brand -->
      <div class="login-brand">
        <div class="login-logo-wrapper">
          <img :src="logoPath" alt="pocketctl" />
        </div>
        <div class="brand-name">pocketctl</div>
        <div class="brand-tagline">远程掌控你的 AI 编程助手</div>
      </div>

      <!-- Login Card -->
      <div class="login-card">
        <div class="card-title">登录你的账户</div>

        <!-- Error Banner -->
        <div v-if="errorMsg" class="error-banner">
          <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 4h1.5v5h-1.5V5zm.75 6.5a.75.75 0 110-1.5.75.75 0 010 1.5z"/></svg>
          <span>{{ errorMsg }}</span>
        </div>

        <!-- Login Tabs -->
        <div class="login-tabs">
          <button :class="['login-tab', { active: activeTab === 'phone' }]" @click="switchTab('phone')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="18" r="1"/></svg>
            手机号登录
          </button>
          <button :class="['login-tab', { active: activeTab === 'email' }]" @click="switchTab('email')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 4L12 13 2 4"/></svg>
            邮箱登录
          </button>
        </div>

        <!-- Phone Login Form -->
        <div v-show="activeTab === 'phone'" class="tab-content">
          <div>
            <div class="form-label">手机号</div>
            <div class="input-group">
              <div class="input-prefix">+86 <span class="chevron">▼</span></div>
              <input type="tel" v-model="phone" placeholder="请输入手机号" maxlength="11" @input="phone = phone.replace(/\D/g, '')" />
            </div>
          </div>
          <div>
            <div class="form-label">验证码</div>
            <div class="code-row">
              <input type="text" class="input-field code-input" v-model="phoneCode" placeholder="6 位验证码" maxlength="6" @input="filterCode($event, 'phoneCode')" />
              <button :class="['get-code-btn', { disabled: phoneCountdown > 0 }]" @click="sendSms" :disabled="phoneCountdown > 0 || !isValidPhone">{{ phoneCountdown > 0 ? phoneCountdown + 's 后重发' : '获取验证码' }}</button>
            </div>
          </div>
          <button class="login-btn" :disabled="loading || phoneCode.length !== 6" @click="doPhoneLogin">{{ loading ? '登录中...' : '登录' }}</button>
        </div>

        <!-- Email Login Form -->
        <div v-show="activeTab === 'email'" class="tab-content">
          <div>
            <div class="form-label">邮箱地址</div>
            <div class="email-input-group">
              <input type="text" v-model="emailLocal" placeholder="name" @input="emailLocal = emailLocal.replace(/@.*/, '')" />
              <div class="email-suffix">@gmail.com</div>
            </div>
          </div>
          <div>
            <div class="form-label">验证码</div>
            <div class="code-row">
              <input type="text" class="input-field code-input" v-model="emailCode" placeholder="6 位验证码" maxlength="6" @input="filterCode($event, 'emailCode')" />
              <button :class="['get-code-btn', { disabled: emailCountdown > 0 }]" @click="sendEmail" :disabled="emailCountdown > 0 || !isValidEmail">{{ emailCountdown > 0 ? emailCountdown + 's 后重发' : '获取验证码' }}</button>
            </div>
          </div>
          <button class="login-btn" :disabled="loading || emailCode.length !== 6" @click="doEmailLogin">{{ loading ? '登录中...' : '登录' }}</button>
        </div>

        <!-- Terms -->
        <div class="terms-text">登录即同意<a href="#">《用户协议》</a>和<a href="#">《隐私政策》</a></div>

        <!-- Social Login -->
        <div class="divider-text">其他登录方式</div>
        <div class="social-row">
          <button class="social-btn" title="Apple 登录">
            <svg viewBox="0 0 24 24" fill="var(--fg)"><path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>
          </button>
          <button class="social-btn" title="GitHub 登录">
            <svg viewBox="0 0 24 24" fill="var(--fg)"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
          </button>
          <button class="social-btn disabled" title="微信登录">
            <svg viewBox="0 0 24 24" fill="#07C160"><path d="M8.69 2C4.34 2 .75 5.06.75 8.8c0 2.14 1.12 4.06 2.88 5.34l-.72 2.16 2.52-1.26c.82.23 1.68.36 2.58.36.32 0 .64-.02.95-.06A6.5 6.5 0 018.5 13c0-3.87 3.58-7 8-7 .37 0 .73.02 1.08.07C16.43 3.94 12.89 2 8.69 2zm-2.8 4.2a.9.9 0 110 1.8.9.9 0 010-1.8zm5.4 0a.9.9 0 110 1.8.9.9 0 010-1.8zM16.5 7c-3.87 0-7 2.69-7 6s3.13 6 7 6c.74 0 1.45-.1 2.12-.3l2.08 1.04-.6-1.8A5.6 5.6 0 0023.25 13c0-3.31-3.13-6-7-6zm-2.2 3.6a.75.75 0 110 1.5.75.75 0 010-1.5zm4.4 0a.75.75 0 110 1.5.75.75 0 010-1.5z"/></svg>
            <span class="coming-soon">即将开通</span>
          </button>
        </div>
      </div>

      <!-- Footer -->
      <div class="login-footer">还没有账户？<a href="#">注册</a> · <a href="#">帮助中心</a></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import logoDark from '../assets/logo-github-org.svg'
import logoLight from '../assets/logo-github-org-light.svg'

const router = useRouter()
const { sendSmsCode, loginViaPhone, sendEmailCode, loginViaEmail } = useAuth()

const activeTab = ref<'phone' | 'email'>('phone')
const phone = ref('')
const phoneCode = ref('')
const emailLocal = ref('')
const emailCode = ref('')
const errorMsg = ref('')
const loading = ref(false)
const phoneCountdown = ref(0)
const emailCountdown = ref(0)

let phoneTimer: ReturnType<typeof setInterval> | null = null
let emailTimer: ReturnType<typeof setInterval> | null = null

const isDark = computed(() => document.documentElement.getAttribute('data-theme') !== 'light')
const logoPath = computed(() => isDark.value ? logoDark : logoLight)
const isValidPhone = computed(() => { const d = phone.value.replace(/\D/g, ''); return d.length === 11 && d.startsWith('1') })
const isValidEmail = computed(() => emailLocal.value.trim().length > 0)
const fullEmail = computed(() => { const l = emailLocal.value.trim(); return l ? `${l}@gmail.com` : '' })

function getTheme(): string { return document.documentElement.getAttribute('data-theme') || 'dark' }
function setTheme(t: string) {
  document.documentElement.setAttribute('data-theme', t)
  localStorage.setItem('pocketctl-theme', t)
}
function toggleTheme() { setTheme(getTheme() === 'dark' ? 'light' : 'dark') }

function switchTab(tab: 'phone' | 'email') { activeTab.value = tab; errorMsg.value = '' }
function filterCode(e: Event, field: 'phoneCode' | 'emailCode') {
  const v = (e.target as HTMLInputElement).value.replace(/\D/g, '')
  if (field === 'phoneCode') phoneCode.value = v.slice(0, 6)
  else emailCode.value = v.slice(0, 6)
}

function startCountdown(which: 'phone' | 'email') {
  if (which === 'phone') {
    phoneCountdown.value = 60
    if (phoneTimer) clearInterval(phoneTimer)
    phoneTimer = setInterval(() => { phoneCountdown.value--; if (phoneCountdown.value <= 0 && phoneTimer) clearInterval(phoneTimer) }, 1000)
  } else {
    emailCountdown.value = 60
    if (emailTimer) clearInterval(emailTimer)
    emailTimer = setInterval(() => { emailCountdown.value--; if (emailCountdown.value <= 0 && emailTimer) clearInterval(emailTimer) }, 1000)
  }
}

onUnmounted(() => { if (phoneTimer) clearInterval(phoneTimer); if (emailTimer) clearInterval(emailTimer) })

async function sendSms() {
  errorMsg.value = ''
  const err = await sendSmsCode(phone.value.replace(/\D/g, ''))
  if (err) { errorMsg.value = err; return }
  startCountdown('phone')
}

async function sendEmail() {
  errorMsg.value = ''
  const err = await sendEmailCode(fullEmail.value)
  if (err) { errorMsg.value = err; return }
  startCountdown('email')
}

async function doPhoneLogin() {
  errorMsg.value = ''; loading.value = true
  const err = await loginViaPhone(phone.value.replace(/\D/g, ''), phoneCode.value)
  if (err) { errorMsg.value = err; loading.value = false }
  else router.push('/')
}

async function doEmailLogin() {
  errorMsg.value = ''; loading.value = true
  const err = await loginViaEmail(fullEmail.value, emailCode.value)
  if (err) { errorMsg.value = err; loading.value = false }
  else router.push('/')
}
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

.login-tabs { display: flex; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 3px; margin-bottom: 24px; }
.login-tab { flex: 1; padding: 10px; border: none; border-radius: 6px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; background: transparent; color: var(--fg-secondary); display: flex; align-items: center; justify-content: center; gap: 6px; transition: all 0.2s; }
.login-tab.active { background: var(--surface); color: var(--fg); box-shadow: var(--shadow-sm); }
.login-tab:hover:not(.active) { color: var(--fg); }
.login-tab svg { width: 16px; height: 16px; }

.tab-content { display: flex; flex-direction: column; gap: 16px; }
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
.email-suffix { display: flex; align-items: center; padding: 0 14px; color: var(--fg-tertiary); font-size: 14px; background: var(--surface); border-left: 1px solid var(--border); white-space: nowrap; }

.login-btn { width: 100%; padding: 14px; background: var(--primary-btn); color: #fff; border: none; border-radius: var(--radius-md); font-family: var(--font-display); font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.15s; margin-top: 4px; }
.login-btn:hover:not(:disabled) { background: var(--primary-btn-hover); }
.login-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.terms-text { font-size: 12px; color: var(--fg-tertiary); text-align: center; line-height: 1.6; margin-top: 8px; }
.terms-text a { color: var(--accent); text-decoration: none; }
.terms-text a:hover { text-decoration: underline; }

.divider-text { display: flex; align-items: center; gap: 12px; color: var(--fg-tertiary); font-size: 13px; padding: 8px 0; }
.divider-text::before, .divider-text::after { content: ''; flex: 1; height: 1px; background: var(--border); }

.social-row { display: flex; gap: 12px; justify-content: center; }
.social-btn { width: 52px; height: 52px; border-radius: var(--radius-lg); border: 1px solid var(--border); background: var(--surface); display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background 0.15s, border-color 0.15s; position: relative; }
.social-btn:hover { background: var(--surface-hover); border-color: var(--border-light); }
.social-btn svg { width: 24px; height: 24px; }
.social-btn.disabled { opacity: 0.4; cursor: not-allowed; }
.social-btn .coming-soon { position: absolute; bottom: -18px; font-size: 10px; color: var(--fg-tertiary); white-space: nowrap; }

.error-banner { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: var(--radius-md); background: var(--error-bg); color: var(--error); font-size: 13px; margin-bottom: 16px; }
.error-banner svg { width: 16px; height: 16px; flex-shrink: 0; }

.login-footer { text-align: center; margin-top: 32px; font-size: 13px; color: var(--fg-tertiary); }
.login-footer a { color: var(--accent); text-decoration: none; }

@media (max-width: 480px) {
  .login-card { padding: 24px 20px; }
  .brand-name { font-size: 24px; }
}
</style>
