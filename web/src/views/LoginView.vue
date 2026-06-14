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

        <div class="login-form">
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
import { ref, computed, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import logoDark from '../assets/logo-github-org.svg'
import logoLight from '../assets/logo-github-org-light.svg'
import PrivacyModal from '../components/PrivacyModal.vue'
import AgreementModal from '../components/AgreementModal.vue'
import HelpModal from '../components/HelpModal.vue'

const router = useRouter()
const { sendEmailCode, loginViaEmail } = useAuth()

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

onUnmounted(() => { if (timer) clearInterval(timer) })

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
.terms-text { font-size: 12px; color: var(--fg-tertiary); text-align: center; line-height: 1.6; margin-top: 8px; }
.terms-text a { color: var(--accent); text-decoration: none; }
.terms-text a:hover { text-decoration: underline; }
.error-banner { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: var(--radius-md); background: var(--error-bg); color: var(--error); font-size: 13px; margin-bottom: 16px; }
.error-banner svg { width: 16px; height: 16px; flex-shrink: 0; }
.login-footer { text-align: center; margin-top: 32px; font-size: 13px; color: var(--fg-tertiary); }
.login-footer a { color: var(--accent); text-decoration: none; }
@media (max-width: 480px) { .login-card { padding: 24px 20px; } .brand-name { font-size: 24px; } }
</style>
