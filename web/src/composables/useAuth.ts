import { ref, computed } from 'vue'

export interface UserInfo {
  id: number
  email: string | null
  phone: string | null
  display_name: string | null
}

const user = ref<UserInfo | null>(null)
const accessToken = ref(localStorage.getItem('pocketctl_access_token') || '')
const refreshToken = ref(localStorage.getItem('pocketctl_refresh_token') || '')

// Restore user from localStorage
const savedUser = localStorage.getItem('pocketctl_user')
if (savedUser && accessToken.value) {
  try { user.value = JSON.parse(savedUser) } catch {}
}

function getRelayOrigin(): string {
  const relayWs = localStorage.getItem('pocketctl_relay_url') || (window as any).__RELAY_WS__ || ''
  try {
    const url = new URL(relayWs)
    // If relay URL is localhost, prefer relative paths (works behind nginx proxy)
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return ''
    return url.origin.replace(/^ws/, 'http')
  } catch {
    return ''
  }
}

async function apiRequest(path: string, body: any): Promise<{ ok: boolean; data: any }> {
  const origin = getRelayOrigin()
  // Use relative URL when no external relay configured (nginx proxies /api/ to relay)
  const url = origin ? `${origin}${path}` : path
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    return { ok: res.ok, data }
  } catch (e) {
    return { ok: false, data: { error: '网络请求失败' } }
  }
}

// --- Phone SMS Auth ---

async function sendSmsCode(phone: string): Promise<string | null> {
  const { ok, data } = await apiRequest('/api/auth/sms/send', { phone })
  if (!ok) return data.error || '发送失败'
  return null
}

async function loginViaPhone(phone: string, code: string): Promise<string | null> {
  const { ok, data } = await apiRequest('/api/auth/sms/verify', { phone, code })
  if (!ok) return data.error || '验证失败'
  saveTokens(data)
  return null
}

// --- Email Verification Code Auth ---

async function sendEmailCode(email: string): Promise<string | null> {
  const { ok, data } = await apiRequest('/api/auth/email/send', { email })
  if (!ok) return data.error || '发送失败'
  return null
}

async function loginViaEmail(email: string, code: string): Promise<string | null> {
  const { ok, data } = await apiRequest('/api/auth/email/verify', { email, code })
  if (!ok) return data.error || '验证失败'
  saveTokens(data)
  return null
}

// --- Legacy (deprecated) ---

async function login(email: string, password: string): Promise<string | null> {
  const { ok, data } = await apiRequest('/api/auth/login', { email, password })
  if (!ok) return data.error || '登录失败'
  saveTokens(data)
  return null
}

async function register(email: string, password: string, displayName?: string): Promise<string | null> {
  const { ok, data } = await apiRequest('/api/auth/register', { email, password, displayName })
  if (!ok) return data.error || '注册失败'
  saveTokens(data)
  return null
}

// --- Token Management ---

function saveTokens(data: any) {
  accessToken.value = data.access_token
  refreshToken.value = data.refresh_token
  user.value = data.user
  localStorage.setItem('pocketctl_access_token', data.access_token)
  localStorage.setItem('pocketctl_refresh_token', data.refresh_token)
  localStorage.setItem('pocketctl_user', JSON.stringify(data.user))
}

async function doRefreshToken(): Promise<boolean> {
  if (!refreshToken.value) return false
  const { ok, data } = await apiRequest('/api/auth/refresh', { refresh_token: refreshToken.value })
  if (!ok) {
    logout()
    return false
  }
  saveTokens(data)
  return true
}

function logout() {
  user.value = null
  accessToken.value = ''
  refreshToken.value = ''
  localStorage.removeItem('pocketctl_access_token')
  localStorage.removeItem('pocketctl_refresh_token')
  localStorage.removeItem('pocketctl_user')
}

const isLoggedIn = computed(() => !!accessToken.value && !!user.value)

export function useAuth() {
  return {
    user, accessToken, refreshToken, isLoggedIn,
    login, register,                        // legacy (deprecated)
    sendSmsCode, loginViaPhone,             // phone SMS
    sendEmailCode, loginViaEmail,           // email verification code
    doRefreshToken, logout,
  }
}
