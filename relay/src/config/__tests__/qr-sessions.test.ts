import { describe, test, expect } from 'vitest'
import { createQrSessionStore, QrSessionStoreCapacityError } from '../qr-sessions.js'

describe('QR session store', () => {
  test('#59 createQrSession returns a valid token + 120s expiry', () => {
    const store = createQrSessionStore(undefined, () => 1_000)
    const result = store.create()
    expect(result.qr_token).toBeTruthy()
    expect(result.qr_token.length).toBeGreaterThanOrEqual(20)
    expect(result.expires_in).toBe(120)

    const session = store.get(result.qr_token)
    expect(session).toBeDefined()
    expect(session!.status).toBe('pending')
    expect(session!.user_id).toBeUndefined()
  })

  test('get returns undefined for unknown token', () => {
    const store = createQrSessionStore(undefined, () => 1_000)
    expect(store.get('nonexistent-token-12345678901234567')).toBeUndefined()
  })

  test('markScanned transitions pending → scanned and is idempotent', () => {
    const store = createQrSessionStore(undefined, () => 1_000)
    const { qr_token } = store.create()
    expect(store.markScanned(qr_token)).toBe(true)
    expect(store.markScanned(qr_token)).toBe(true)
    expect(store.get(qr_token)!.status).toBe('scanned')
  })

  test('confirm binds user and marks confirmed; deleted sessions reject re-confirm', () => {
    const store = createQrSessionStore(undefined, () => 1_000)
    const { qr_token } = store.create()
    expect(store.confirm(qr_token, 42)).toBe(true)
    expect(store.get(qr_token)!.user_id).toBe(42)
    store.delete(qr_token)
    expect(store.confirm(qr_token, 43)).toBe(false)
    expect(store.get(qr_token)).toBeUndefined()
  })

  test('#62 TTL: expired session is treated as nonexistent', () => {
    let now = 1_000
    const store = createQrSessionStore({ ttlMs: 100 }, () => now)
    const { qr_token } = store.create()
    now += 101
    expect(store.get(qr_token)).toBeUndefined()
    expect(store.markScanned(qr_token)).toBe(false)
    expect(store.confirm(qr_token, 1)).toBe(false)
  })

  test('confirm fails on unknown token; delete is safe on unknown tokens', () => {
    const store = createQrSessionStore(undefined, () => 1_000)
    expect(store.confirm('unknown-token-xxxxxxxxxxxxxxxxxx', 1)).toBe(false)
    expect(() => store.delete('no-such-token')).not.toThrow()
  })
})

describe('QR session store capacity (M-2)', () => {
  test('create fails with an explicit capacity error at the hard cap', () => {
    const store = createQrSessionStore({ maxSessions: 2 }, () => 1_000)
    store.create()
    store.create()
    expect(() => store.create()).toThrow(QrSessionStoreCapacityError)
    const message = (() => {
      try {
        store.create()
      } catch (error) {
        return (error as Error).message
      }
      return ''
    })()
    expect(message).not.toMatch(/\d{2,}/)
  })

  test('create GCs expired sessions first, so expired slots are reused', () => {
    let now = 1_000
    const store = createQrSessionStore({ maxSessions: 1, ttlMs: 120_000 }, () => now)
    store.create()
    now += 121_000
    expect(() => store.create()).not.toThrow()
    expect(store.size()).toBe(1)
  })

  test('deleting a consumed session recovers capacity', () => {
    const store = createQrSessionStore({ maxSessions: 1 }, () => 1_000)
    const { qr_token } = store.create()
    expect(() => store.create()).toThrow(QrSessionStoreCapacityError)
    store.delete(qr_token)
    expect(() => store.create()).not.toThrow()
  })
})
