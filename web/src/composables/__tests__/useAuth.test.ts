import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock localStorage BEFORE importing useAuth (it reads localStorage at module load)
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((k: string) => store[k] ?? null),
    setItem: vi.fn((k: string, v: string) => { store[k] = v }),
    removeItem: vi.fn((k: string) => { delete store[k] }),
    clear: vi.fn(() => { store = {} }),
  }
})()

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, configurable: true })
const initialNavigatorLanguage = globalThis.navigator.language

// Ensure window exists (happy-dom may not have it ready at dynamic import time)
if (!(globalThis as any).window) {
  ;(globalThis as any).window = { __RELAY_WS__: '' }
}

// Dynamic import after mock is in place
const { useAuth } = await import('../useAuth')
const authLocale = (await import('../useLocale')).useLocale().locale

async function useFreshAuthWithNavigator(language: string) {
  Object.defineProperty(globalThis.navigator, 'language', { value: language, configurable: true })
  localStorageMock.clear()
  vi.resetModules()
  return (await import('../useAuth')).useAuth()
}

function mockFetchResponse(ok: boolean, data: any) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok,
    status: ok ? 200 : 400,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as any)
}

beforeEach(() => {
  localStorageMock.clear()
  vi.resetAllMocks()
  const { user, accessToken, refreshToken } = useAuth()
  user.value = null
  accessToken.value = ''
  refreshToken.value = ''
  authLocale.value = 'zh'
})

afterEach(() => {
  Object.defineProperty(globalThis.navigator, 'language', { value: initialNavigatorLanguage, configurable: true })
  vi.restoreAllMocks()
})

describe('useAuth — Email Verification Code', () => {

  test('loginViaEmail uses navigator-detected Chinese UI locale when storage is missing', async () => {
    const { loginViaEmail } = await useFreshAuthWithNavigator('zh-CN')
    const fetchSpy = mockFetchResponse(false, { error: '验证码错误' })

    await loginViaEmail('a@b.com', '123456')

    expect(localStorageMock.getItem('pocketctl-locale')).toBeNull()
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/auth/email/verify',
      expect.objectContaining({
        body: JSON.stringify({ email: 'a@b.com', code: '123456', lang: 'zh' }),
      }),
    )
  })

  test('sendEmailCode uses navigator-detected English UI locale when storage is missing', async () => {
    const { sendEmailCode } = await useFreshAuthWithNavigator('en-US')
    const fetchSpy = mockFetchResponse(true, { ok: true })

    await sendEmailCode('a@b.com')

    expect(localStorageMock.getItem('pocketctl-locale')).toBeNull()
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/auth/email/send',
      expect.objectContaining({
        body: JSON.stringify({ email: 'a@b.com', lang: 'en' }),
      }),
    )
  })

  test('#39 sendEmailCode returns null (success) when API responds ok', async () => {
    const { sendEmailCode } = useAuth()
    const fetchSpy = mockFetchResponse(true, { ok: true })
    const err = await sendEmailCode('test@example.com')
    expect(err).toBeNull()
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/auth/email/send',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'test@example.com', lang: 'zh' }),
      }),
    )
  })

  test('#41 sendEmailCode returns error message when API fails', async () => {
    const { sendEmailCode } = useAuth()
    mockFetchResponse(false, { error: '邮箱格式不正确' })
    const err = await sendEmailCode('bad-email')
    expect(err).toBe('邮箱格式不正确')
  })

  test('#40 loginViaEmail saves tokens on success', async () => {
    const { loginViaEmail, accessToken, user } = useAuth()
    authLocale.value = 'en'
    const fetchSpy = mockFetchResponse(true, {
      access_token: 'jwt-123',
      refresh_token: 'refresh-456',
      user: { id: 1, email: 'a@b.com', phone: null, display_name: 'A' },
    })
    const err = await loginViaEmail('a@b.com', '123456')
    expect(err).toBeNull()
    expect(accessToken.value).toBe('jwt-123')
    expect(user.value?.email).toBe('a@b.com')
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/auth/email/verify',
      expect.objectContaining({
        body: JSON.stringify({ email: 'a@b.com', code: '123456', lang: 'en' }),
      }),
    )
    expect(localStorageMock.setItem).not.toHaveBeenCalledWith('pocketctl_access_token', 'jwt-123')
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('pocketctl_access_token')
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('pocketctl_refresh_token')
  })

  test('loginViaEmail uses the locale active when verification completes', async () => {
    const { sendEmailCode, loginViaEmail } = useAuth()
    const fetchSpy = mockFetchResponse(true, {
      access_token: 'jwt-123',
      refresh_token: 'refresh-456',
      user: { id: 1, email: 'a@b.com', phone: null, display_name: 'A' },
    })

    authLocale.value = 'zh'
    await sendEmailCode('a@b.com')
    authLocale.value = 'en'
    await loginViaEmail('a@b.com', '123456')

    expect(fetchSpy).toHaveBeenLastCalledWith(
      '/api/auth/email/verify',
      expect.objectContaining({
        body: JSON.stringify({ email: 'a@b.com', code: '123456', lang: 'en' }),
      }),
    )
  })

  test('#41 loginViaEmail returns error on wrong code', async () => {
    const { loginViaEmail } = useAuth()
    mockFetchResponse(false, { error: '验证码错误或已过期' })
    const err = await loginViaEmail('a@b.com', '000000')
    expect(err).toBe('验证码错误或已过期')
  })
})

describe('useAuth — QR Scan-Login', () => {

  test('#42-43 createQrLogin returns qr_payload on success', async () => {
    const { createQrLogin } = useAuth()
    mockFetchResponse(true, {
      qr_token: 'tok-abc',
      qr_payload: 'pocketctl://qr/tok-abc',
      expires_in: 120,
      interval: 2,
    })
    const { data, error } = await createQrLogin()
    expect(error).toBeNull()
    expect(data).not.toBeNull()
    expect(data!.qr_token).toBe('tok-abc')
    expect(data!.qr_payload).toContain('tok-abc')
    expect(data!.expires_in).toBe(120)
  })

  test('createQrLogin returns error when API fails', async () => {
    const { createQrLogin } = useAuth()
    mockFetchResponse(false, { error: '服务不可用' })
    const { data, error } = await createQrLogin()
    expect(data).toBeNull()
    expect(error).toBe('服务不可用')
  })

  test('#44 pollQrLogin returns pending status', async () => {
    const { pollQrLogin } = useAuth()
    mockFetchResponse(true, { status: 'pending' })
    const result = await pollQrLogin('tok-abc')
    expect(result).toBe('pending')
  })

  test('#44 pollQrLogin returns scanned status', async () => {
    const { pollQrLogin } = useAuth()
    mockFetchResponse(true, { status: 'scanned' })
    const result = await pollQrLogin('tok-abc')
    expect(result).toBe('scanned')
  })

  test('#47 pollQrLogin returns confirmed and saves tokens', async () => {
    const { pollQrLogin, accessToken } = useAuth()
    mockFetchResponse(true, {
      status: 'confirmed',
      access_token: 'jwt-from-qr',
      refresh_token: 'refresh-qr',
      user: { id: 2, email: 'qr@b.com', phone: null, display_name: 'QR' },
    })
    const result = await pollQrLogin('tok-abc')
    expect(result).toBe('confirmed')
    expect(accessToken.value).toBe('jwt-from-qr')
    expect(localStorageMock.setItem).not.toHaveBeenCalledWith('pocketctl_access_token', 'jwt-from-qr')
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('pocketctl_access_token')
  })

  test('#45 pollQrLogin returns expired status', async () => {
    const { pollQrLogin } = useAuth()
    mockFetchResponse(true, { status: 'expired' })
    const result = await pollQrLogin('tok-abc')
    expect(result).toBe('expired')
  })

  test('pollQrLogin returns error message on API failure', async () => {
    const { pollQrLogin } = useAuth()
    mockFetchResponse(false, { error: 'token not found' })
    const result = await pollQrLogin('tok-abc')
    expect(result).toBe('token not found')
  })
})

describe('useAuth — isLoggedIn', () => {
  test('isLoggedIn is false without tokens', async () => {
    // useAuth refs are module-level singletons — reset them to a logged-out state
    const { logout, isLoggedIn } = useAuth()
    mockFetchResponse(true, { success: true })
    await logout()
    expect(isLoggedIn.value).toBe(false)
  })
})

describe('useAuth — auth 请求 401 自动刷新重试', () => {
  function fakeResponse(ok: boolean, status: number, data: any) {
    return { ok, status, json: async () => data, text: async () => JSON.stringify(data) } as any
  }

  test('401 时刷新 token 并用新 token 重试一次成功', async () => {
    const { confirmDeviceAuth, accessToken, refreshToken } = useAuth()
    accessToken.value = 'old-expired'
    refreshToken.value = 'refresh-x'
    localStorageMock.setItem('pocketctl_access_token', 'old-expired')
    localStorageMock.setItem('pocketctl_refresh_token', 'refresh-x')

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      // 1) confirm 携带旧 token → 401
      .mockResolvedValueOnce(fakeResponse(false, 401, { error: 'invalid_token' }))
      // 2) refresh → 200，下发新 token
      .mockResolvedValueOnce(fakeResponse(true, 200, {
        access_token: 'new-token',
        refresh_token: 'refresh-2',
        user: { id: 5, email: 'a@b.com', phone: null, display_name: 'A' },
      }))
      // 3) confirm 用新 token 重试 → 200
      .mockResolvedValueOnce(fakeResponse(true, 200, { ok: true }))

    const err = await confirmDeviceAuth('UserCode123')

    expect(err).toBeNull()
    expect(accessToken.value).toBe('new-token')
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  test('refresh 失败时登出且不重试，返回错误', async () => {
    const { confirmDeviceAuth, accessToken, refreshToken } = useAuth()
    accessToken.value = 'old-expired'
    refreshToken.value = 'bad-refresh'
    localStorageMock.setItem('pocketctl_access_token', 'old-expired')
    localStorageMock.setItem('pocketctl_refresh_token', 'bad-refresh')

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fakeResponse(false, 401, { error: 'invalid_token' }))
      .mockResolvedValueOnce(fakeResponse(false, 401, { error: 'invalid_token' }))

    const err = await confirmDeviceAuth('UserCode123')

    expect(err).toBeTruthy()             // 返回错误信息
    expect(accessToken.value).toBe('')   // 已登出，清空 token
    expect(fetchSpy).toHaveBeenCalledTimes(2) // confirm + refresh，不重试
  })
})
