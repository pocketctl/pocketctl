import { describe, expect, test } from 'vitest'
import { ConnectionAdmission } from '../connection-admission.js'

describe('ConnectionAdmission', () => {
  test('rejects a connection storm above the global handshake limit', () => {
    const admission = new ConnectionAdmission({
      daemonGlobalMax: 2, clientGlobalMax: 4,
      daemonPerAddressMax: 2, clientPerAddressMax: 4,
      jitter: () => 750,
    })
    const first = admission.tryAcquire('daemon', '10.0.0.1')
    const second = admission.tryAcquire('daemon', '10.0.0.2')

    expect(first.admitted).toBe(true)
    expect(second.admitted).toBe(true)
    expect(admission.tryAcquire('daemon', '10.0.0.3')).toEqual({
      admitted: false, retryAfterMs: 750,
    })

    if (first.admitted) first.release()
    expect(admission.tryAcquire('daemon', '10.0.0.3').admitted).toBe(true)
  })

  test('enforces an independent per-address limit and releases idempotently', () => {
    const admission = new ConnectionAdmission({
      daemonGlobalMax: 4, clientGlobalMax: 4,
      daemonPerAddressMax: 1, clientPerAddressMax: 2,
      jitter: () => 500,
    })
    const first = admission.tryAcquire('daemon', '10.0.0.1')

    expect(admission.tryAcquire('daemon', '10.0.0.1')).toEqual({ admitted: false, retryAfterMs: 500 })
    if (first.admitted) {
      first.release()
      first.release()
    }
    expect(admission.tryAcquire('daemon', '10.0.0.1').admitted).toBe(true)
  })
})
