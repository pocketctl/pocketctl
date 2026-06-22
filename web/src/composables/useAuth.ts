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
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return ''
    return url.origin.replace(/^ws/, 'http')
  } catch {
    return ''
  }
}

async function apiRequest(path: string, body: any, auth?: boolean): Promise<{ ok: boolean; data: any }> {
  const origin = getRelayOrigin()
  const url = origin ? `${origin}${path}` : path
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth && accessToken.value) {
    headers['Authorization'] = `Bearer ${accessToken.value}`
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const data = await res.json()
    return { ok: res.ok, data }
  } catch (e) {
    return { ok: false, data: { error: '网络请求失败' } }
  }
}

/** GET variant for endpoints like QR status polling (no body, no auth). */
async function apiGet(path: string): Promise<{ ok: boolean; data: any }> {
  const origin = getRelayOrigin()
  const url = origin ? `${origin}${path}` : path
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } })
    const data = await res.json()
    return { ok: res.ok, data }
  } catch (e) {
    return { ok: false, data: { error: '网络请求失败' } }
  }
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

// --- Device Authorization ---

async function confirmDeviceAuth(userCode: string): Promise<string | null> {
  const { ok, data } = await apiRequest('/api/auth/device/confirm', { user_code: userCode }, true)
  if (!ok) return data.error_description || data.error || '授权失败'
  return null
}

// --- QR Scan-Login (web shows QR → iOS scans/confirms → web polls for token) ---

export interface QrCreateResult {
  qr_token: string
  qr_payload: string
  expires_in: number
  interval: number
}

export type QrStatus = 'pending' | 'scanned' | 'confirmed' | 'expired'

/** Web starts a QR login session. Returns the payload to render into the QR. */
async function createQrLogin(): Promise<{ data: QrCreateResult | null; error: string | null }> {
  const { ok, data } = await apiRequest('/api/auth/qr/create', {})
  if (!ok) return { data: null, error: data.error || '生成二维码失败' }
  return { data, error: null }
}

/**
 * Web polls the QR session status. On 'confirmed' the tokens are already saved
 * here (single call site) and the caller can redirect.
 * Returns: 'pending' | 'scanned' | 'confirmed' (tokens saved) | 'expired' | '<error msg>'
 */
async function pollQrLogin(qrToken: string): Promise<QrStatus | string> {
  const { ok, data } = await apiGet(`/api/auth/qr/status?qr_token=${encodeURIComponent(qrToken)}`)
  if (!ok) return data.error || '查询失败'
  if (data.status === 'confirmed') {
    saveTokens(data)
    return 'confirmed'
  }
  return data.status as QrStatus
}

// --- Force Kick Daemon ---

async function forceKickDaemon(daemonId: string, emailCode: string): Promise<string | null> {
  // First verify email code
  const verifyResult = await apiRequest('/api/auth/email/verify', { email: user.value?.email, code: emailCode }, true)
  if (!verifyResult.ok) return verifyResult.data.error || '验证码错误'

  // Then force kick
  const kickResult = await apiRequest(`/api/daemons/${daemonId}/forceKick`, {}, true)
  if (!kickResult.ok) return kickResult.data.error || '踢下线失败'
  return null
}

// --- Session Rename ---

async function renameSession(sessionId: string, title: string): Promise<string | null> {
  const origin = getRelayOrigin()
  const url = origin ? `${origin}/api/sessions/${sessionId}/title` : `/api/sessions/${sessionId}/title`
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken.value}` },
      body: JSON.stringify({ title }),
    })
    const data = await res.json()
    if (!res.ok) return data.error || '重命名失败'
    return null
  } catch {
    return '网络请求失败'
  }
}

// --- Legacy (deprecated) ---

async function login(email: string, password: string): Promise<string | null> {
  const { ok, data } = await apiRequest('/api/auth/login', { email, password })
  if (!ok) return data.error || '登录失败'
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
    login,                            // legacy (deprecated)
    sendEmailCode, loginViaEmail,     // email verification code
    confirmDeviceAuth,                // device authorization
    createQrLogin, pollQrLogin,       // QR scan-login (web side)
    forceKickDaemon,                  // force kick daemon
    renameSession,                    // session rename
    doRefreshToken, logout,
  }
}
