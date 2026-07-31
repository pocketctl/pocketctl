import { describe, test, expect, vi, beforeEach } from 'vitest'
import {
  createQrSession,
  getQrSession,
  markScanned,
  confirmQrSession,
  deleteQrSession,
} from '../qr-sessions.js'

describe('QR Session Store', () => {

  test('#59 createQrSession returns a valid token + 120s expiry', () => {
    const result = createQrSession()
    expect(result.qr_token).toBeTruthy()
    expect(result.qr_token.length).toBeGreaterThanOrEqual(20) // base64url filtered, ~29 chars
    expect(result.expires_in).toBe(120)

    const session = getQrSession(result.qr_token)
    expect(session).toBeDefined()
    expect(session!.status).toBe('pending')
    expect(session!.user_id).toBeUndefined()
  })

  test('getQrSession returns undefined for unknown token', () => {
    expect(getQrSession('nonexistent-token-12345678901234567')).toBeUndefined()
  })

  test('markScanned transitions pending → scanned', () => {
    const { qr_token } = createQrSession()
    expect(markScanned(qr_token)).toBe(true)
    expect(getQrSession(qr_token)!.status).toBe('scanned')
  })

  test('markScanned is idempotent (scanned stays scanned)', () => {
    const { qr_token } = createQrSession()
    markScanned(qr_token)
    markScanned(qr_token)
    expect(getQrSession(qr_token)!.status).toBe('scanned')
  })

  test('confirmQrSession binds user and marks confirmed', () => {
    const { qr_token } = createQrSession()
    expect(confirmQrSession(qr_token, 42)).toBe(true)
    const session = getQrSession(qr_token)
    expect(session!.status).toBe('confirmed')
    expect(session!.user_id).toBe(42)
  })

  test('#63 single-consumption: confirm on deleted session returns false', () => {
    const { qr_token } = createQrSession()
    confirmQrSession(qr_token, 1)
    deleteQrSession(qr_token)
    // Second confirm after consumption fails
    expect(confirmQrSession(qr_token, 2)).toBe(false)
    expect(getQrSession(qr_token)).toBeUndefined()
  })

  test('#62 TTL: expired session is treated as nonexistent', () => {
    const { qr_token } = createQrSession()
    const session = getQrSession(qr_token)!
    // Manually expire it
    session.expires_at = Date.now() - 1000
    expect(getQrSession(qr_token)).toBeUndefined()
    // Operations on expired token also fail
    expect(markScanned(qr_token)).toBe(false)
    expect(confirmQrSession(qr_token, 1)).toBe(false)
  })

  test('confirmQrSession fails on unknown token', () => {
    expect(confirmQrSession('unknown-token-xxxxxxxxxxxxxxxxxx', 1)).toBe(false)
  })

  test('deleteQrSession is safe for unknown tokens', () => {
    expect(() => deleteQrSession('no-such-token')).not.toThrow()
  })
})
