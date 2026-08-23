import { expect, test } from 'vitest'
import { ConnectionAdmission } from '../connection-admission.js'
import { RegistrationDeadline } from '../registration-deadline.js'

function fakeTimers() {
  const callbacks: (() => void)[] = []
  return {
    timers: { setTimeout: (cb: () => void) => { callbacks.push(cb); return cb }, clearTimeout: () => {} },
    fireAll: () => callbacks.splice(0).forEach((cb) => cb()),
  }
}

test('releases all 64 daemon handshakes when unregistered registration deadlines expire', () => {
  const admission = new ConnectionAdmission({ daemonGlobalMax: 64, clientGlobalMax: 128, daemonPerAddressMax: 64, clientPerAddressMax: 32, jitter: () => 750 })
  const clock = fakeTimers()
  const deadlines = Array.from({ length: 64 }, (_, i) => {
    const result = admission.tryAcquire('daemon', `10.0.0.${i}`)
    expect(result.admitted).toBe(true)
    return new RegistrationDeadline(10_000, clock.timers, () => { if (result.admitted) result.release() })
  })
  expect(admission.tryAcquire('daemon', '10.0.1.1').admitted).toBe(false)
  clock.fireAll()
  expect(admission.tryAcquire('daemon', '10.0.1.1').admitted).toBe(true)
  expect(deadlines[0].complete()).toBe(false)
})

test('late registration cannot complete after its deadline has won', () => {
  const clock = fakeTimers()
  const deadline = new RegistrationDeadline(10_000, clock.timers, () => {})
  clock.fireAll()
  expect(deadline.complete()).toBe(false)
})

test('socket-close completion is idempotent and cancels its pending deadline', () => {
  const clock = fakeTimers()
  let expired = 0
  const deadline = new RegistrationDeadline(10_000, clock.timers, () => { expired++ })
  expect(deadline.complete()).toBe(true)
  expect(deadline.complete()).toBe(false)
  clock.fireAll()
  expect(expired).toBe(0)
})
