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

// Ensure window exists (happy-dom may not have it ready at dynamic import time)
if (!(globalThis as any).window) {
  ;(globalThis as any).window = { __RELAY_WS__: '' }
}

// Dynamic import after mock is in place
const { useAuth } = await import('../useAuth')

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
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useAuth — Email Verification Code', () => {

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
    mockFetchResponse(true, {
      access_token: 'jwt-123',
      refresh_token: 'refresh-456',
      user: { id: 1, email: 'a@b.com', phone: null, display_name: 'A' },
    })
    const err = await loginViaEmail('a@b.com', '123456')
    expect(err).toBeNull()
    expect(accessToken.value).toBe('jwt-123')
    expect(user.value?.email).toBe('a@b.com')
    expect(localStorageMock.setItem).toHaveBeenCalledWith('pocketctl_access_token', 'jwt-123')
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
    expect(localStorageMock.setItem).toHaveBeenCalledWith('pocketctl_access_token', 'jwt-from-qr')
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
  test('isLoggedIn is false without tokens', () => {
    // useAuth refs are module-level singletons — reset them to a logged-out state
    const { logout, isLoggedIn } = useAuth()
    logout()
    expect(isLoggedIn.value).toBe(false)
  })
})
